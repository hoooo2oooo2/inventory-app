-- 당근 배송 자동조회 스케줄 — Supabase 대시보드 > SQL Editor 에서 1회 실행
-- 한국시간 09:00 / 13:00 / 16:00  =  UTC 00:00 / 04:00 / 07:00
-- (Edge Function 'carrot-track' 을 먼저 배포하고 SWEETTRACKER_KEY Secret 을 등록한 뒤 실행)
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'carrot-track-3x-daily',
  '0 0,4,7 * * *',
  $$
  select net.http_post(
    url     := 'https://ywbekolvslixidpugepr.supabase.co/functions/v1/carrot-track',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || '<<여기에 anon key 붙여넣기 (index.html 상단 SUPABASE_KEY 값)>>'
    ),
    body    := '{}'::jsonb
  );
  $$
);

-- 확인:  select * from cron.job;
-- 중지:  select cron.unschedule('carrot-track-3x-daily');
