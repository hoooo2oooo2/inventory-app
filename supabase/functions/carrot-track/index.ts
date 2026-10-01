// 당근 판매 배송 추적 — 스마트택배(Sweet Tracker) 조회 API로 송장번호 상태를 받아
// work_calendar 의 별도 키 'logi_carrot_track' 에만 기록한다. (주문 목록 'logi_carrot_orders' 는 읽기만 함)
//
// 호출: ① pg_cron 이 하루 3번(한국시간 9·13·16시) ② 앱의 [지금 조회] 버튼(body: {ids:[주문id]|null, force:true})
// 필요한 Secret: SWEETTRACKER_KEY  (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 는 자동 제공)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const CJ = '04';                         // 스마트택배 택배사 코드: CJ대한통운
const KEY_ORDERS = 'logi_carrot_orders';
const KEY_TRACK = 'logi_carrot_track';
const MAX_AGE_DAYS = 45;                 // 등록 후 45일 지난 미완료 건은 더 이상 조회하지 않음(호출량 보호)

// 스마트택배 level: 1 배송준비중, 2 집화완료, 3 배송중, 4 지점도착, 5 배송출발, 6 배송완료
function mapLevel(level: number): 'wait' | 'pickup' | 'transit' | 'done' {
  if (level >= 6) return 'done';
  if (level >= 3) return 'transit';
  if (level === 2) return 'pickup';
  return 'wait';
}
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

async function readKey(sb: any, kind: string) {
  const { data, error } = await sb.from('work_calendar').select('data').eq('person', '__app__').eq('kind', kind).maybeSingle();
  if (error) throw new Error(`${kind} 읽기 실패: ${error.message}`);
  return data ? data.data : null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const apiKey = Deno.env.get('SWEETTRACKER_KEY');
    if (!apiKey) return json({ error: 'SWEETTRACKER_KEY 미설정' }, 500);
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const body = await req.json().catch(() => ({}));
    const ids: string[] | null = Array.isArray(body?.ids) ? body.ids : null;
    const force = !!body?.force;

    const orders = await readKey(sb, KEY_ORDERS);
    const track0 = await readKey(sb, KEY_TRACK);
    const track: Record<string, any> = track0 && typeof track0 === 'object' && !Array.isArray(track0) ? track0 : {};
    if (!Array.isArray(orders)) return json({ checked: 0, errors: 0, note: '주문 목록 없음' });

    const cutoff = new Date(Date.now() - MAX_AGE_DAYS * 86400000).toISOString().slice(0, 10);
    const now = Date.now();
    const minGapMs = force ? 30 * 1000 : 5 * 60 * 1000;   // 연타/중복 호출 방지
    const targets = orders.filter((o: any) => {
      if (!o?.trackNo || o.visitSale) return false;
      if (ids && !ids.includes(o.id)) return false;
      if ((o.createdAt || '') < cutoff) return false;
      const t = track[o.id];
      if (t && t.no === o.trackNo) {
        if (t.status === 'done') return false;                                   // 배송완료는 재조회 안 함
        if (t.checkedAt && now - Date.parse(t.checkedAt) < minGapMs) return false;
      }
      return true;
    });

    const updates: Record<string, any> = {};
    let errors = 0;
    for (const o of targets) {
      const nowIso = new Date().toISOString();
      const prev = track[o.id] && track[o.id].no === o.trackNo ? track[o.id] : null;
      try {
        const url = `https://info.sweettracker.co.kr/api/v1/trackingInfo?t_key=${encodeURIComponent(apiKey)}&t_code=${CJ}&t_invoice=${encodeURIComponent(o.trackNo)}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
        const j = await res.json();
        if (j && j.status === false) {
          // 등록 직후엔 '조회 결과 없음'이 정상 — 이전 상태는 유지하고 사유만 남김
          errors++;
          updates[o.id] = { no: o.trackNo, status: prev?.status || 'wait', checkedAt: nowIso, err: String(j.msg || j.code || '조회 실패').slice(0, 120),
            where: prev?.where, kind: prev?.kind, doneAt: prev?.doneAt };
        } else {
          const status = mapLevel(Number(j.level) || 0);
          const last = j.lastDetail || (Array.isArray(j.trackingDetails) ? j.trackingDetails[j.trackingDetails.length - 1] : null) || {};
          const lastIso = last.time ? new Date(Number(last.time)).toISOString() : undefined;
          updates[o.id] = { no: o.trackNo, status, level: Number(j.level) || 0, checkedAt: nowIso,
            where: last.where || '', kind: last.kind || '', lastAt: lastIso,
            doneAt: status === 'done' ? (prev?.doneAt || lastIso || nowIso) : undefined };
        }
      } catch (e) {
        errors++;
        updates[o.id] = { no: o.trackNo, status: prev?.status || 'wait', checkedAt: nowIso, err: `호출 오류: ${String((e as Error).message).slice(0, 100)}`,
          where: prev?.where, kind: prev?.kind, doneAt: prev?.doneAt };
      }
      await new Promise((r) => setTimeout(r, 250));   // API 예의상 간격
    }

    if (Object.keys(updates).length) {
      // 쓰기 직전에 최신본을 다시 읽어 우리가 조회한 id만 덮어쓴다(수동 조회와 크론이 겹쳐도 서로의 결과를 지우지 않게)
      const fresh0 = await readKey(sb, KEY_TRACK);
      const fresh: Record<string, any> = fresh0 && typeof fresh0 === 'object' && !Array.isArray(fresh0) ? fresh0 : {};
      const liveIds = new Set(orders.map((o: any) => o.id));
      for (const k of Object.keys(fresh)) if (!liveIds.has(k)) delete fresh[k];   // 삭제된 주문의 상태는 정리
      Object.assign(fresh, updates);
      const { error } = await sb.from('work_calendar').upsert(
        { person: '__app__', kind: KEY_TRACK, data: fresh, updated_at: new Date().toISOString() },
        { onConflict: 'person,kind' });
      if (error) throw new Error(`${KEY_TRACK} 저장 실패: ${error.message}`);
    }
    return json({ checked: targets.length, errors, skipped: orders.filter((o: any) => o?.trackNo).length - targets.length });
  } catch (e) {
    return json({ error: String((e as Error).message) }, 500);
  }
});
