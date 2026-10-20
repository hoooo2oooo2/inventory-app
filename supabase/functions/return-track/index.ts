// 반품관리 > 수거접수 반송장 자동조회 — 스마트택배(Sweet Tracker) 조회 API
//   ① pg_cron 이 하루 2번(한국시간 10시·15시): 미완료 수거접수 건(work_calendar kind 'rt_*')의 반송장 상태를 받아 'rtk_track' 에만 기록
//   ② 앱의 [지금 조회] / 반송장 저장 직후 1회 조회 (body: {ids:[접수id], force:true})
// 수거접수 레코드는 읽기만 한다(앱이 저장하는 데이터는 이 함수가 절대 수정하지 않음).
//
// 상태(status): order 수거지시(집화 전) / moving 수거중(집화~배송중) / done 완료(회수 도착) / cancel 수거취소(택배사가 취소로 표시한 경우 · 앱에서 수동 지정도 가능) / fail 수거안됨(재수거 필요)
//   · done · cancel · fail 은 다시는 조회하지 않는다(사용량 보호).
//   · 반송장 등록 후 3일(72시간)이 지나도 집화되지 않으면(order 상태 또는 조회 결과 없음) fail 로 확정하고 조회를 멈춘다.
//     새 반송장번호를 넣으면(재수거) 등록시각이 새로 잡혀 다시 조회가 시작된다.
// 무료 이용권(프리): 이용기간 내 조회 100건(택배사+운송장 조합 기준). 당근 배송추적(carrot-track)과 같은 'sweettracker_usage' 집계를 함께 쓴다.
// 필요한 Secret: SWEETTRACKER_KEY (carrot-track 과 같은 값 — Secret 은 프로젝트 공용이라 이미 등록돼 있으면 추가 작업 없음)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const CJ = '04';
const KEY_TRACK = 'rtk_track';
const KEY_USAGE = 'sweettracker_usage';
const LIMIT = 100;
const FAIL_MS = 72 * 3600 * 1000;       // 반송장 등록 후 3일
const MAX_AGE_DAYS = 45;                 // 등록 후 45일 지난 미확정 건은 조회하지 않음
const KEEP_DAYS = 120;                   // 상태 기록 보관 기간

// 스마트택배 level: 1 배송준비중, 2 집화완료, 3 배송중, 4 지점도착, 5 배송출발, 6 배송완료
function mapLevel(level: number): 'order' | 'moving' | 'done' {
  if (level >= 6) return 'done';
  if (level >= 2) return 'moving';
  return 'order';
}

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

async function readKey(sb: any, kind: string) {
  const { data, error } = await sb.from('work_calendar').select('data').eq('person', '__app__').eq('kind', kind).maybeSingle();
  if (error) throw new Error(kind + ' 읽기 실패: ' + error.message);
  return data ? data.data : null;
}
async function writeKey(sb: any, kind: string, value: unknown) {
  const { error } = await sb.from('work_calendar').upsert(
    { person: '__app__', kind, data: value, updated_at: new Date().toISOString() }, { onConflict: 'person,kind' });
  if (error) throw new Error(kind + ' 저장 실패: ' + error.message);
}

// ── 사용량 집계 (carrot-track 과 같은 문서 'sweettracker_usage') ──
function ymd(d: Date) { return d.toISOString().slice(0, 10); }
function defaultUsage() {
  return { periodStart: '2026-10-01', periodEnd: '2026-11-01', limit: LIMIT, base: 4, legacy: ['1234567890123', '268944515910'], pairs: {} };
}
function normalizeUsage(u: any) {
  const d = u && typeof u === 'object' && !Array.isArray(u) ? u : defaultUsage();
  while (d.periodEnd && ymd(new Date()) >= d.periodEnd) {
    const next = new Date(d.periodEnd + 'T00:00:00Z'); next.setUTCMonth(next.getUTCMonth() + 1);
    d.periodStart = d.periodEnd; d.periodEnd = ymd(next); d.base = 0; d.legacy = []; d.pairs = {};
  }
  if (!d.pairs) d.pairs = {};
  return d;
}
function usageSummary(d: any) {
  const legacy = new Set(d.legacy || []);
  const n = Object.keys(d.pairs || {}).filter((k) => !legacy.has(k.split('|')[1])).length;
  const used = (Number(d.base) || 0) + n;
  return { used, limit: d.limit || LIMIT, remaining: Math.max(0, (d.limit || LIMIT) - used), periodStart: d.periodStart, periodEnd: d.periodEnd };
}
async function loadUsage(sb: any) { return normalizeUsage(await readKey(sb, KEY_USAGE)); }
async function recordPairs(sb: any, pairs: string[]) {
  if (!pairs.length) return;
  const fresh = normalizeUsage(await readKey(sb, KEY_USAGE));
  const nowIso = new Date().toISOString();
  for (const p of pairs) if (!fresh.pairs[p]) fresh.pairs[p] = nowIso;
  await writeKey(sb, KEY_USAGE, fresh);
}

// 미완료(완료여부=false) + 반송장번호가 있는 수거접수 건 읽기 (읽기 전용)
async function loadOpenReturns(sb: any) {
  const all: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('work_calendar').select('kind,data').eq('person', '__app__')
      .like('kind', 'rt\\_%').eq('data->>done', 'false').neq('data->>trackNo', '').order('kind').range(from, from + 999);
    if (error) throw new Error('수거접수 읽기 실패: ' + error.message);
    (data || []).forEach((r: any) => { if (r.data && r.data.id && r.data.trackNo) all.push(r.data); });
    if (!data || data.length < 1000) break;
  }
  return all;
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

    const recs = await loadOpenReturns(sb);
    const track0 = await readKey(sb, KEY_TRACK);
    const track: Record<string, any> = track0 && typeof track0 === 'object' && !Array.isArray(track0) ? track0 : {};

    const cutoff = new Date(Date.now() - MAX_AGE_DAYS * 86400000).toISOString().slice(0, 10);
    const now = Date.now();
    const minGapMs = force ? 30 * 1000 : 5 * 60 * 1000;   // 연타/중복 호출 방지
    const targets = recs.filter((r: any) => {
      if (r.cancel) return false;                                 // 앱에서 수거취소로 지정한 건
      if (ids && !ids.includes(r.id)) return false;
      if ((r.trackNoAt || r.createdAt || '').slice(0, 10) < cutoff) return false;
      const t = track[r.id];
      if (t && t.no === r.trackNo && (t.code || CJ) === (r.carrier || CJ)) {
        if (t.status === 'done' || t.status === 'cancel' || t.status === 'fail') return false;   // 확정된 건은 다시 조회하지 않음
        if (t.checkedAt && now - Date.parse(t.checkedAt) < minGapMs) return false;
      }
      return true;
    });

    // 무료 한도 보호: 남은 건수가 없으면 새 (택배사|운송장) 조합은 조회하지 않음
    const usage0 = await loadUsage(sb);
    let remaining = usageSummary(usage0).remaining;
    const updates: Record<string, any> = {};
    const called: string[] = [];
    let errors = 0, blocked = 0;
    for (const r of targets) {
      const code = r.carrier || CJ;
      const pairKey = code + '|' + r.trackNo;
      const isNew = !usage0.pairs[pairKey] && !(usage0.legacy || []).includes(r.trackNo);
      if (isNew && remaining <= 0) { blocked++; continue; }
      const nowIso = new Date().toISOString();
      const regAt = Date.parse(r.trackNoAt || r.createdAt || '');
      const expired = !isNaN(regAt) && now - regAt > FAIL_MS;   // 반송장 등록 후 3일 경과
      const prev = track[r.id] && track[r.id].no === r.trackNo && (track[r.id].code || CJ) === (r.carrier || CJ) ? track[r.id] : null;
      try {
        const url = 'https://info.sweettracker.co.kr/api/v1/trackingInfo?t_key=' + encodeURIComponent(apiKey) + '&t_code=' + encodeURIComponent(code) + '&t_invoice=' + encodeURIComponent(r.trackNo);
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
        const j = await res.json();
        called.push(pairKey);
        if (isNew) remaining--;
        if (j && j.status === false) {
          // 등록 직후엔 '조회 결과 없음'이 정상 — 3일이 지나도 결과가 없으면 수거안됨으로 확정
          errors++;
          updates[r.id] = { no: r.trackNo, code, status: expired ? 'fail' : (prev?.status || 'order'), checkedAt: nowIso,
            err: String(j.msg || j.code || '조회 실패').slice(0, 120), where: prev?.where, kind: prev?.kind, failAt: expired ? nowIso : undefined };
        } else {
          let status: string = mapLevel(Number(j.level) || 0);
          const last = j.lastDetail || (Array.isArray(j.trackingDetails) ? j.trackingDetails[j.trackingDetails.length - 1] : null) || {};
          const lastIso = last.time ? new Date(Number(last.time)).toISOString() : undefined;
          if (/취소/.test(String(last.kind || ''))) status = 'cancel';                // 택배사 이력에 '취소'가 찍힌 경우
          else if (status === 'order' && expired) status = 'fail';                    // 3일이 지나도 집화 안 됨
          updates[r.id] = { no: r.trackNo, code, status, level: Number(j.level) || 0, checkedAt: nowIso,
            where: last.where || '', kind: last.kind || '', lastAt: lastIso,
            doneAt: status === 'done' ? (prev?.doneAt || lastIso || nowIso) : undefined,
            failAt: status === 'fail' ? (prev?.failAt || nowIso) : undefined };
        }
      } catch (e) {
        errors++;
        updates[r.id] = { no: r.trackNo, code, status: prev?.status || 'order', checkedAt: nowIso, err: '호출 오류: ' + String((e as Error).message).slice(0, 100),
          where: prev?.where, kind: prev?.kind };
      }
      await new Promise((rs) => setTimeout(rs, 250));   // API 예의상 간격
    }

    await recordPairs(sb, called);
    if (Object.keys(updates).length) {
      // 쓰기 직전 최신본을 다시 읽어 우리가 조회한 id만 덮어쓴다(수동 조회와 크론이 겹쳐도 서로의 결과를 지우지 않게)
      const fresh0 = await readKey(sb, KEY_TRACK);
      const fresh: Record<string, any> = fresh0 && typeof fresh0 === 'object' && !Array.isArray(fresh0) ? fresh0 : {};
      const keepFrom = new Date(Date.now() - KEEP_DAYS * 86400000).toISOString();
      for (const k of Object.keys(fresh)) if (!fresh[k]?.checkedAt || fresh[k].checkedAt < keepFrom) delete fresh[k];   // 오래된 기록 정리
      Object.assign(fresh, updates);
      await writeKey(sb, KEY_TRACK, fresh);
    }
    return json({ checked: called.length, errors, blocked, skipped: recs.length - targets.length, usage: usageSummary(await loadUsage(sb)) });
  } catch (e) {
    return json({ error: String((e as Error).message) }, 500);
  }
});
