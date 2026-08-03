-- ============================================================
--  Onward Desk — database schema (Supabase / Postgres)
--  Run once in the Supabase SQL editor.
-- ============================================================

create extension if not exists pgcrypto;

-- ---------- enums ----------
create type order_status as enum (
  'pending_payment',  -- created, customer sent to Paystack
  'paid',             -- money confirmed, sitting in your fulfilment queue
  'issuing',          -- you or the API are creating the reservation
  'delivered',        -- reference sent to customer
  'failed',           -- couldn't issue — must refund
  'refunded',
  'expired'           -- hold lapsed (informational)
);

create type product_code      as enum ('flight','hotel','both');
create type fulfilment_source as enum ('duffel_hold','supplier_api','supplier_manual','free_cancel_rate');

-- ---------- pricing: server-side source of truth ----------
-- Never let the browser tell you the price. It will lie.
create table products (
  code        product_code not null,
  currency    char(3)      not null,
  label       text         not null,
  price_minor integer      not null check (price_minor > 0),  -- pesewas / cents
  active      boolean      not null default true,
  updated_at  timestamptz  not null default now(),
  primary key (code, currency)
);

insert into products (code, currency, label, price_minor) values
  ('flight','GHS','Flight reservation',            29000),
  ('hotel', 'GHS','Hotel reservation',             33000),
  ('both',  'GHS','Flight + hotel reservation',    52000),
  ('flight','USD','Flight reservation',             2500),
  ('hotel', 'USD','Hotel reservation',              2800),
  ('both',  'USD','Flight + hotel reservation',     4500);

-- ---------- human-readable order references ----------
create sequence order_ref_seq start 2472;

create or replace function next_order_reference() returns text
language sql volatile as $$
  select 'AD-' || lpad(nextval('order_ref_seq')::text, 5, '0');
$$;

-- ---------- orders ----------
create table orders (
  id            uuid primary key default gen_random_uuid(),
  reference     text unique not null default next_order_reference(),
  lookup_token  uuid not null default gen_random_uuid(),  -- goes in the status link
  status        order_status not null default 'pending_payment',
  product       product_code not null,

  -- customer
  email         text not null check (position('@' in email) > 1),
  whatsapp      text,
  given_names   text not null,
  family_name   text not null,

  -- flight leg
  origin_iata      char(3) check (origin_iata      ~ '^[A-Z]{3}$'),
  destination_iata char(3) check (destination_iata ~ '^[A-Z]{3}$'),
  depart_date      date,
  return_date      date,

  -- hotel leg
  hotel_city    text,
  check_in      date,
  check_out     date,

  -- money, always in minor units
  currency              char(3) not null,
  amount_charged_minor  integer not null check (amount_charged_minor > 0),
  processor_fee_minor   integer not null default 0,
  supplier_cost_minor   integer not null default 0,
  margin_minor integer generated always as
    (amount_charged_minor - processor_fee_minor - supplier_cost_minor) stored,

  -- paystack
  paystack_reference text unique,
  paystack_channel   text,          -- card / mobile_money / bank_transfer
  paid_at            timestamptz,

  -- fulfilment
  source             fulfilment_source,
  booking_reference  text,          -- the PNR. NULL until an airline gives us one.
  airline_iata       char(2),
  verify_url         text,
  hold_expires_at    timestamptz,
  issued_at          timestamptz,
  delivered_at       timestamptz,
  fulfilled_by       text,
  internal_notes     text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- a flight order must have a route; a hotel order must have a city
  constraint route_present check (
    product = 'hotel' or (origin_iata is not null and destination_iata is not null and depart_date is not null)
  ),
  constraint stay_present check (
    product = 'flight' or (hotel_city is not null and check_in is not null and check_out is not null)
  ),
  constraint dates_sane check (
    (return_date is null or return_date >= depart_date) and
    (check_out   is null or check_out   >  check_in)
  ),
  -- you can only mark something delivered if a real reference exists
  constraint delivered_needs_reference check (
    status <> 'delivered' or booking_reference is not null
  )
);

create index orders_status_idx  on orders (status, created_at desc);
create index orders_email_idx   on orders (lower(email));
create index orders_created_idx on orders (created_at desc);

-- ---------- audit trail ----------
create table order_events (
  id         bigserial primary key,
  order_id   uuid not null references orders(id) on delete cascade,
  event      text not null,
  detail     jsonb,
  actor      text,
  created_at timestamptz not null default now()
);
create index order_events_order_idx on order_events (order_id, created_at);

-- ---------- updated_at ----------
create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

create trigger orders_touch before update on orders
for each row execute function touch_updated_at();

-- ============================================================
--  Row level security
--  Deny-all is deliberate. No policies means anon and authenticated
--  get nothing. Only the service_role key (edge functions, server
--  side only) can read or write. Never ship the service key to a browser.
-- ============================================================
alter table orders       enable row level security;
alter table order_events enable row level security;
alter table products     enable row level security;

-- prices are the one thing the public may read
create policy products_public_read on products
  for select to anon, authenticated using (active);

-- ---------- customer status lookup ----------
-- Requires reference AND matching email, so sequential references
-- (AD-02471, AD-02472...) can't be walked to read other people's orders.
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
language sql
security definer
set search_path = public
as $$
  select o.reference, o.status, o.product, o.origin_iata, o.destination_iata,
         o.depart_date, o.hotel_city, o.booking_reference, o.verify_url, o.hold_expires_at
  from orders o
  where o.reference = upper(trim(p_reference))
    and lower(o.email) = lower(trim(p_email))
  limit 1;
$$;

grant execute on function public.get_order_status(text, text) to anon, authenticated;

-- ---------- the desk queue ----------
create view fulfilment_queue as
select reference, status, product, family_name || '/' || given_names as passenger,
       coalesce(origin_iata || ' → ' || destination_iata, hotel_city) as item,
       depart_date, check_in,
       currency,
       amount_charged_minor / 100.0 as charged,
       supplier_cost_minor  / 100.0 as cost,
       margin_minor         / 100.0 as margin,
       paid_at, hold_expires_at, source, fulfilled_by
from orders
where status in ('paid','issuing')
order by paid_at asc;   -- oldest first. Nobody waiting should be overtaken.
