// 당근 판매 배송 추적 + 송장 단건 조회 — 스마트택배(Sweet Tracker) 조회 API
//   ① pg_cron 이 하루 3번(한국시간 9·13·16시): 당근 주문(logi_carrot_orders)의 송장번호 상태를 받아 logi_carrot_track 에만 기록
//   ② 앱의 [지금 조회] 버튼(body: {ids:[주문id]|null, force:true})
//   ③ 앱 우측하단 🚚 송장조회 팝업(body: {mode:'lookup', invoice, code?}) — 로그인 사용자만, 택배사 자동판별, 주문 데이터에는 쓰기 없음
//   ④ body: {mode:'usage'} — 이번 이용기간 사용량 조회(API 호출 없음)
// 무료 이용권(프리): 이용기간 내 조회 100건(택배사+운송장 조합 기준). 사용량은 'sweettracker_usage' 키에 자체 집계한다.
// 필요한 Secret: SWEETTRACKER_KEY  (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 는 자동 제공)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const CJ = '04';                         // 기본 택배사 코드: CJ대한통운 (주문에 carrier 가 있으면 그 코드를 사용)
const KEY_ORDERS = 'logi_carrot_orders';
const KEY_TRACK = 'logi_carrot_track';
const KEY_USAGE = 'sweettracker_usage';
const MAX_AGE_DAYS = 45;                 // 등록 후 45일 지난 미완료 건은 더 이상 조회하지 않음(호출량 보호)
const LIMIT = 100;                       // 프리 이용권 제공량

// 스마트택배 level: 1 배송준비중, 2 집화완료, 3 배송중, 4 지점도착, 5 배송출발, 6 배송완료
function mapLevel(level: number): 'wait' | 'pickup' | 'transit' | 'done' {
  if (level >= 6) return 'done';
  if (level >= 3) return 'transit';
  if (level === 2) return 'pickup';
  return 'wait';
}
const LEVEL_LABEL: Record<number, string> = { 1: '배송준비중', 2: '집화완료(수거)', 3: '배송중', 4: '지점도착', 5: '배송출발(배달중)', 6: '배송완료' };
const FALLBACK_CARRIERS: string[][] = [['04', 'CJ대한통운'], ['08', '롯데택배'], ['05', '한진택배'], ['06', '로젠택배'], ['01', '우체국택배']];

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

// ── 사용량 집계 ──────────────────────────────────────────────
// 문서: {periodStart, periodEnd, limit, base, legacy:[이미 base 에 반영된 운송장], pairs:{'택배사코드|운송장': 최초조회시각}}
// 공식 '나의 이용권'(2026-10-01 확인): 프리 100건, 사용량 4, 기간 2026-10-01~2026-11-01 → base 4 로 시작
function ymd(d: Date) { return d.toISOString().slice(0, 10); }
function defaultUsage() {
  return { periodStart: '2026-10-01', periodEnd: '2026-11-01', limit: LIMIT, base: 4, legacy: ['1234567890123', '268944515910'], pairs: {} };
}
function normalizeUsage(u: any) {
  const d = u && typeof u === 'object' && !Array.isArray(u) ? u : defaultUsage();
  // 이용기간이 지났으면 다음 기간으로 이월(무료 이용권 재발급 가정 — 공식 화면과 다르면 앱에서 확인)
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
// 호출한 (택배사|운송장) 조합을 기록 — 쓰기 직전 최신본을 다시 읽어 병합(크론·수동 조회가 겹쳐도 안전)
async function recordPairs(sb: any, pairs: string[]) {
  if (!pairs.length) return;
  const fresh = normalizeUsage(await readKey(sb, KEY_USAGE));
  const nowIso = new Date().toISOString();
  for (const p of pairs) if (!fresh.pairs[p]) fresh.pairs[p] = nowIso;
  await writeKey(sb, KEY_USAGE, fresh);
}

// ── 송장번호 단건 조회 (mode:'lookup') ───────────────────────────
async function requireLogin(sb: any, req: Request) {
  // 수령인 이름·주소가 나올 수 있으므로 로그인한 사용자만 허용 (공개 anon 키만으로는 거부)
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const { data: ures } = await sb.auth.getUser(token);
  return !!(ures && ures.user);
}
// 택배사 후보를 우리가 쓰는 택배사 우선 + 자리수로 정렬 — 틀린 택배사 조회도 사용량이 차감되므로 낭비를 줄인다
function orderCandidates(invoice: string, cands: { code: string; name?: string }[]) {
  const pref = invoice.length === 13 ? ['01', '04', '08', '05', '06']
    : invoice.length === 11 ? ['06', '04', '08', '05', '01']
    : ['04', '08', '05', '06', '01'];
  const rank = (c: string) => { const i = pref.indexOf(c); return i < 0 ? 99 : i; };
  return cands.slice().sort((a, b) => rank(a.code) - rank(b.code));
}

async function lookupInvoice(sb: any, apiKey: string, req: Request, body: any) {
  if (!(await requireLogin(sb, req))) return json({ error: '로그인이 필요합니다.' }, 401);
  const invoice = String(body?.invoice || '').replace(/[^0-9]/g, '');
  if (invoice.length < 9 || invoice.length > 15) return json({ error: '송장번호는 숫자 9~15자리로 입력하세요.' }, 400);

  const usage0 = await loadUsage(sb);
  if (usageSummary(usage0).remaining <= 0) return json({ ok: false, error: '이번 이용기간 무료 조회 한도(100건)를 모두 사용했습니다.', usage: usageSummary(usage0) });

  const called: string[] = [];
  let cands: { code: string; name?: string }[] = [];
  if (body?.code) {
    cands = [{ code: String(body.code) }];
  } else {
    try {
      const rres = await fetch('https://info.sweettracker.co.kr/api/v1/recommend?t_key=' + encodeURIComponent(apiKey) + '&t_invoice=' + invoice, { signal: AbortSignal.timeout(10000) });
      const rj = await rres.json();
      const arr = rj.Recommend || rj.recommend || [];
      cands = arr.map((x: any) => ({ code: String(x.Code ?? x.code ?? ''), name: x.Name ?? x.name })).filter((x: any) => x.code);
    } catch (_e) { /* 추천 API 실패 시 아래 기본 후보로 대체 */ }
    if (!cands.length) cands = FALLBACK_CARRIERS.map(([code, name]) => ({ code, name }));
    cands = orderCandidates(invoice, cands).slice(0, 4);
  }

  const tried: string[] = [];
  let result: any = null;
  for (const c of cands) {
    try {
      const url = 'https://info.sweettracker.co.kr/api/v1/trackingInfo?t_key=' + encodeURIComponent(apiKey) + '&t_code=' + encodeURIComponent(c.code) + '&t_invoice=' + invoice;
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      const j = await res.json();
      called.push(c.code + '|' + invoice);   // 응답을 받은 호출은 모두 사용량으로 집계(공식 화면에서 오조회도 차감됨을 확인)
      const hasData = j && j.status !== false && ((Array.isArray(j.trackingDetails) && j.trackingDetails.length) || Number(j.level) > 0);
      if (!hasData) { tried.push((c.name || c.code) + (j && j.msg ? '(' + String(j.msg).slice(0, 40) + ')' : '')); continue; }
      const details = (Array.isArray(j.trackingDetails) ? j.trackingDetails : []).map((d: any) => ({
        time: d.time ? new Date(Number(d.time)).toISOString() : null, timeString: d.timeString || '', where: d.where || '', kind: d.kind || '',
        level: Number(d.level) || 0, manName: d.manName || '', telno: d.telno || '', telno2: d.telno2 || '',
      }));
      const last = details.length ? details[details.length - 1] : null;
      let driver: any = null;   // 배달 담당 기사: 가장 최근에 기사 이름이 찍힌 이력
      for (let i = details.length - 1; i >= 0; i--) {
        if (details[i].manName) { driver = { name: details[i].manName, tel: details[i].telno || details[i].telno2 || '', where: details[i].where, time: details[i].timeString }; break; }
      }
      const level = Number(j.level) || 0;
      result = {
        ok: true, code: c.code, carrier: c.name || (FALLBACK_CARRIERS.find((f) => f[0] === c.code) || [])[1] || c.code,
        invoice, level, status: LEVEL_LABEL[level] || '', complete: !!j.complete,
        sender: j.senderName || '', receiver: j.receiverName || j.recipient || '', receiverAddr: j.receiverAddr || '', item: j.itemName || '', estimate: j.estimate || '',
        where: last ? last.where : '', lastKind: last ? last.kind : '', lastTime: last ? last.timeString : '', lastTel: last ? (last.telno || last.telno2) : '',
        driver, details,
      };
      break;
    } catch (_e) {
      tried.push((c.name || c.code) + '(호출 오류)');
    }
  }
  await recordPairs(sb, called);
  const usage = usageSummary(await loadUsage(sb));
  if (result) return json({ ...result, usage });
  return json({ ok: false, error: '조회 결과가 없습니다. 송장번호를 확인하거나, 택배사를 직접 선택해 보세요.', tried, usage });
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
    if (body?.mode === 'usage') {
      if (!(await requireLogin(sb, req))) return json({ error: '로그인이 필요합니다.' }, 401);
      return json({ usage: usageSummary(await loadUsage(sb)) });
    }
    if (body?.mode === 'lookup') return await lookupInvoice(sb, apiKey, req, body);

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
      if (t && t.no === o.trackNo && (t.code || CJ) === (o.carrier || CJ)) {
        if (t.status === 'done') return false;                                   // 배송완료는 다시는 조회하지 않음(사용량 보호)
        if (t.checkedAt && now - Date.parse(t.checkedAt) < minGapMs) return false;
      }
      return true;
    });

    // 무료 한도 보호: 남은 건수가 없으면 새 (택배사|운송장) 조합은 조회하지 않음. 이미 집계된 조합은 추가 차감이 없으므로 허용
    const usage0 = await loadUsage(sb);
    let remaining = usageSummary(usage0).remaining;
    const updates: Record<string, any> = {};
    const called: string[] = [];
    let errors = 0, blocked = 0;
    for (const o of targets) {
      const code = o.carrier || CJ;
      const pairKey = code + '|' + o.trackNo;
      const isNew = !usage0.pairs[pairKey] && !(usage0.legacy || []).includes(o.trackNo);
      if (isNew && remaining <= 0) { blocked++; continue; }
      const nowIso = new Date().toISOString();
      const prev = track[o.id] && track[o.id].no === o.trackNo && (track[o.id].code || CJ) === (o.carrier || CJ) ? track[o.id] : null;
      try {
        const url = 'https://info.sweettracker.co.kr/api/v1/trackingInfo?t_key=' + encodeURIComponent(apiKey) + '&t_code=' + encodeURIComponent(code) + '&t_invoice=' + encodeURIComponent(o.trackNo);
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
        const j = await res.json();
        called.push(pairKey);
        if (isNew) remaining--;
        if (j && j.status === false) {
          // 등록 직후엔 '조회 결과 없음'이 정상 — 이전 상태는 유지하고 사유만 남김
          errors++;
          updates[o.id] = { no: o.trackNo, code, status: prev?.status || 'wait', checkedAt: nowIso, err: String(j.msg || j.code || '조회 실패').slice(0, 120),
            where: prev?.where, kind: prev?.kind, doneAt: prev?.doneAt };
        } else {
          const status = mapLevel(Number(j.level) || 0);
          const last = j.lastDetail || (Array.isArray(j.trackingDetails) ? j.trackingDetails[j.trackingDetails.length - 1] : null) || {};
          const lastIso = last.time ? new Date(Number(last.time)).toISOString() : undefined;
          updates[o.id] = { no: o.trackNo, code, status, level: Number(j.level) || 0, checkedAt: nowIso,
            where: last.where || '', kind: last.kind || '', lastAt: lastIso,
            doneAt: status === 'done' ? (prev?.doneAt || lastIso || nowIso) : undefined };
        }
      } catch (e) {
        errors++;
        updates[o.id] = { no: o.trackNo, code, status: prev?.status || 'wait', checkedAt: nowIso, err: '호출 오류: ' + String((e as Error).message).slice(0, 100),
          where: prev?.where, kind: prev?.kind, doneAt: prev?.doneAt };
      }
      await new Promise((r) => setTimeout(r, 250));   // API 예의상 간격
    }

    await recordPairs(sb, called);
    if (Object.keys(updates).length) {
      // 쓰기 직전에 최신본을 다시 읽어 우리가 조회한 id만 덮어쓴다(수동 조회와 크론이 겹쳐도 서로의 결과를 지우지 않게)
      const fresh0 = await readKey(sb, KEY_TRACK);
      const fresh: Record<string, any> = fresh0 && typeof fresh0 === 'object' && !Array.isArray(fresh0) ? fresh0 : {};
      const liveIds = new Set(orders.map((o: any) => o.id));
      for (const k of Object.keys(fresh)) if (!liveIds.has(k)) delete fresh[k];   // 삭제된 주문의 상태는 정리
      Object.assign(fresh, updates);
      await writeKey(sb, KEY_TRACK, fresh);
    }
    return json({ checked: called.length, errors, blocked, skipped: orders.filter((o: any) => o?.trackNo).length - targets.length,
      usage: usageSummary(await loadUsage(sb)) });
  } catch (e) {
    return json({ error: String((e as Error).message) }, 500);
  }
});
