-- ============================================================
--  Delivery channel for the booking reference.
--  The receipt always goes by email; this is how the reference itself
--  is delivered once issued.
-- ============================================================

alter table orders
  add column if not exists delivery_method text not null default 'email'
    check (delivery_method in ('email', 'whatsapp', 'both'));
