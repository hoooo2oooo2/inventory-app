// 직원 비밀번호 초기화(임시 비밀번호 발급) — 마스터 전용
//   앱 마이페이지(마스터) → 직원 행의 [비번 초기화] 버튼이 호출한다. body: { user_id: '<Supabase User UID>' }
//   · 호출자의 로그인 토큰을 검증하고, app_profiles.is_master = true 인 마스터만 허용한다.
//   · 대상은 앱에 등록된(app_profiles) 일반 직원만. 마스터 계정은 여기서 바꿀 수 없다(마이페이지 '내 비밀번호 변경' 사용).
//   · 임시 비밀번호는 서버에서 무작위로 만들어 Supabase Auth에 설정하고, 응답으로 호출한 마스터에게만 한 번 돌려준다.
//     어디에도 저장·기록하지 않는다(로그 포함).
// 필요한 Secret: 없음 (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 는 자동 제공)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

// 암호학적 난수로 0..n-1 한 개 (편향 없는 거절 샘플링)
function rnd(n: number): number {
  const lim = Math.floor(0x100000000 / n) * n;
  const a = new Uint32Array(1);
  do { crypto.getRandomValues(a); } while (a[0] >= lim);
  return a[0] % n;
}
// 헷갈리는 글자(0 O 1 l I)를 뺀 영문 대·소문자 + 숫자, 각각 최소 1개 포함 — 전달·입력하기 쉽게
function tempPassword(len = 10): string {
  const LOWER = 'abcdefghjkmnpqrstuvwxyz', UPPER = 'ABCDEFGHJKMNPQRSTUVWXYZ', DIGIT = '23456789';
  const all = LOWER + UPPER + DIGIT;
  const chars = [LOWER[rnd(LOWER.length)], UPPER[rnd(UPPER.length)], DIGIT[rnd(DIGIT.length)]];
  while (chars.length < len) chars.push(all[rnd(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) { const j = rnd(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join('');
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST 요청만 허용됩니다.' }, 405);

  const url = Deno.env.get('SUPABASE_URL'), key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) return json({ error: '서버 설정 오류입니다.' }, 500);
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  // 1) 호출자 로그인 확인
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: '로그인이 필요합니다.' }, 401);
  const { data: ures } = await sb.auth.getUser(token);
  const caller = ures && ures.user;
  if (!caller) return json({ error: '로그인이 필요합니다.' }, 401);

  // 2) 호출자가 마스터인지 확인
  const { data: me, error: meErr } = await sb.from('app_profiles').select('is_master').eq('user_id', caller.id).maybeSingle();
  if (meErr) return json({ error: '권한을 확인하지 못했습니다.' }, 500);
  if (!me || me.is_master !== true) return json({ error: '마스터 계정만 사용할 수 있습니다.' }, 403);

  // 3) 대상 확인 — 앱에 등록된 일반 직원만
  let body: any = {};
  try { body = await req.json(); } catch { body = {}; }
  const uid = String(body && body.user_id || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uid)) return json({ error: '대상 직원 정보가 올바르지 않습니다.' }, 400);
  const { data: target, error: tErr } = await sb.from('app_profiles').select('user_id,username,name,is_master').eq('user_id', uid).maybeSingle();
  if (tErr) return json({ error: '대상 직원을 확인하지 못했습니다.' }, 500);
  if (!target) return json({ error: '앱에 등록된 직원이 아닙니다.' }, 404);
  if (target.is_master === true) return json({ error: '마스터 계정은 여기서 초기화할 수 없어요. 마이페이지의 “내 비밀번호 변경”을 사용하세요.' }, 400);

  // 4) 임시 비밀번호 설정 (비밀번호 값은 로그·저장 없이 응답으로만 전달)
  const pw = tempPassword(10);
  const { error: upErr } = await sb.auth.admin.updateUserById(uid, { password: pw });
  if (upErr) return json({ error: '비밀번호를 바꾸지 못했습니다. 잠시 뒤 다시 시도하세요.' }, 500);

  return json({ ok: true, username: target.username, name: target.name || '', temp_password: pw });
});
