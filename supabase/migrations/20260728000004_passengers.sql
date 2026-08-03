-- ============================================================
--  Multiple travellers per order.
--  The lead traveller stays in orders.given_names / family_name so the
--  desk queue, receipts and status lookup keep working unchanged. The full
--  list lives in `passengers`; each traveller gets their own reservation.
-- ============================================================

alter table orders
  add column if not exists passenger_count integer not null default 1
    check (passenger_count between 1 and 9),
  add column if not exists passengers jsonb;
