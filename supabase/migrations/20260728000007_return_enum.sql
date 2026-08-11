-- ============================================================
--  Add the "return" product (Dummy Return Ticket).
--  Enum values must be added in their own migration — Postgres won't let
--  a newly added value be used in the same transaction it was created in.
-- ============================================================

alter type product_code add value if not exists 'return';
