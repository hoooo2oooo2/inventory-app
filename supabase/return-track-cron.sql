-- 수거접수 반송장 자동조회 스케줄 — Supabase 대시보드 > SQL Editor 에서 1회 실행
-- 한국시간 10:00 / 15:00  =  UTC 01:00 / 06:00  (하루 2번)
-- (Edge Function 'return-track' 을 먼저 배포한 뒤 실행. SWEETTRACKER_KEY Secret 은 carrot-track 과 공용)
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'return-track-2x-daily',
  '0 1,6 * * *',
  $$
  select net.http_post(
    url     := 'https://ywbekolvslixidpugepr.supabase.co/functions/v1/return-track',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || '<<여기에 anon key 붙여넣기 (index.html 상단 SUPABASE_KEY 값)>>'
    ),
    body    := '{}'::jsonb
  );
  $$
);

-- 확인:  select * from cron.job;
-- 중지:  select cron.unschedule('return-track-2x-daily');
