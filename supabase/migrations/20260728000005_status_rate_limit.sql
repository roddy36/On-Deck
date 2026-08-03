-- ============================================================
--  Rate-limit the public status lookup.
--  reference + email already gate access, but nothing stopped a script
--  hammering guesses. Record every attempt and refuse once a single IP or a
--  single reference is being probed too fast.
-- ============================================================

create table if not exists status_lookup_attempts (
  id         bigserial primary key,
  ip         text,
  reference  text,
  matched    boolean not null,
  created_at timestamptz not null default now()
);
create index if not exists status_lookup_ip_idx  on status_lookup_attempts (ip, created_at);
create index if not exists status_lookup_ref_idx on status_lookup_attempts (reference, created_at);

-- Deny-all, like every other table. The security-definer function below runs
-- as the owner and bypasses this; nobody else can read the attempt log.
alter table status_lookup_attempts enable row level security;

create or replace function public.get_order_status(p_reference text, p_email text)
returns table (
  reference text,
  status order_status,
  product product_code,
  origin_iata char(3),
  destination_iata char(3),
  depart_date date,
  hotel_city text,
  booking_reference text,
  verify_url text,
  hold_expires_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ip       text;
  v_ref      text := upper(trim(p_reference));
  v_ip_hits  integer;
  v_ref_miss integer;
  v_found    integer;
begin
  -- best-effort client IP from the PostgREST-forwarded request headers
  begin
    v_ip := split_part(
      coalesce(current_setting('request.headers', true)::json ->> 'x-forwarded-for', ''),
      ',', 1);
  exception when others then
    v_ip := null;
  end;
  v_ip := nullif(trim(v_ip), '');

  -- keep the log small
  delete from status_lookup_attempts where created_at < now() - interval '1 day';

  -- per-IP ceiling: 12 lookups a minute
  if v_ip is not null then
    select count(*) into v_ip_hits from status_lookup_attempts
      where ip = v_ip and created_at > now() - interval '1 minute';
    if v_ip_hits >= 12 then
      raise exception 'rate_limited'
        using errcode = 'P0001', hint = 'Too many attempts. Wait a minute and try again.';
    end if;
  end if;

  -- per-reference ceiling: 6 misses in 10 minutes stops email-guessing on one order
  select count(*) into v_ref_miss from status_lookup_attempts
    where reference = v_ref and not matched
      and created_at > now() - interval '10 minutes';
  if v_ref_miss >= 6 then
    raise exception 'rate_limited'
      using errcode = 'P0001', hint = 'Too many attempts on this order. Wait a few minutes.';
  end if;

  return query
    select o.reference, o.status, o.product, o.origin_iata, o.destination_iata,
           o.depart_date, o.hotel_city, o.booking_reference, o.verify_url, o.hold_expires_at
    from orders o
    where o.reference = v_ref
      and lower(o.email) = lower(trim(p_email))
    limit 1;

  get diagnostics v_found = row_count;

  insert into status_lookup_attempts (ip, reference, matched)
  values (v_ip, v_ref, v_found > 0);
end;
$$;

grant execute on function public.get_order_status(text, text) to anon, authenticated;
