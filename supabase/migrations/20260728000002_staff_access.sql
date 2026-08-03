-- ============================================================
--  Onward Desk — staff access
--  Run after 01-schema.sql
-- ============================================================

-- ---------- who works here ----------
create table staff (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  email      text not null,
  role       text not null default 'agent' check (role in ('agent','admin')),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

alter table staff enable row level security;

create or replace function is_staff() returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from staff
    where user_id = auth.uid() and active
  );
$$;

create policy staff_see_self on staff
  for select to authenticated using (user_id = auth.uid());

-- ---------- staff may read orders. That's all. ----------
-- No UPDATE policy on purpose. Every state change goes through the
-- deliver-reservation edge function, which validates the booking
-- reference before it will write one. A broad UPDATE policy would let
-- a tired agent type anything into the PNR field at 11pm.
create policy staff_read_orders on orders
  for select to authenticated using (is_staff());

create policy staff_read_events on order_events
  for select to authenticated using (is_staff());

-- The queue view must run as the caller, not as its owner,
-- or it quietly bypasses every policy above.
alter view fulfilment_queue set (security_invoker = on);

-- ---------- add yourself ----------
-- Sign in once through the desk to create the auth user, then:
--
--   insert into staff (user_id, email, role)
--   select id, email, 'admin' from auth.users where email = 'you@adamenstravels.com';
