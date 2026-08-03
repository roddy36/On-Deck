-- ============================================================
--  Expiry sweeper
--
--  A delivered order whose hold has lapsed still reads "ready" on the
--  customer's status page. That is the failure that gets someone turned
--  away at a check-in desk, so it can't depend on anyone remembering.
-- ============================================================

create extension if not exists pg_cron;

create or replace function sweep_expired_holds() returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  swept integer;
begin
  with lapsed as (
    update orders
       set status = 'expired'
     where status = 'delivered'
       and hold_expires_at is not null
       and hold_expires_at < now()
    returning id
  )
  insert into order_events (order_id, event, actor)
  select id, 'hold_expired', 'sweeper' from lapsed;

  get diagnostics swept = row_count;
  return swept;
end;
$$;

revoke execute on function sweep_expired_holds() from public, anon, authenticated;

-- hourly, on the hour
select cron.schedule(
  'sweep-expired-holds',
  '0 * * * *',
  $$ select sweep_expired_holds(); $$
);

-- Check it's running:
--   select * from cron.job;
--   select * from cron.job_run_details order by start_time desc limit 10;
--
-- Unschedule with:
--   select cron.unschedule('sweep-expired-holds');
