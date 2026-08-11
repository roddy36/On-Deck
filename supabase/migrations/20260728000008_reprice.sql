-- ============================================================
--  Reconcile prices with the published pricing, and add the return product.
--  Prices are in minor units (pesewas / cents), per traveller.
--    Flight (visa)     GH₵350 / $29
--    Hotel             GH₵340 / $28
--    Flight + hotel    GH₵540 / $45
--    Return flight     GH₵300 / $25
-- ============================================================

update products set price_minor = 35000, updated_at = now() where code = 'flight' and currency = 'GHS';
update products set price_minor = 2900,  updated_at = now() where code = 'flight' and currency = 'USD';
update products set price_minor = 34000, updated_at = now() where code = 'hotel'  and currency = 'GHS';
update products set price_minor = 2800,  updated_at = now() where code = 'hotel'  and currency = 'USD';
update products set price_minor = 54000, updated_at = now() where code = 'both'   and currency = 'GHS';
update products set price_minor = 4500,  updated_at = now() where code = 'both'   and currency = 'USD';

insert into products (code, currency, label, price_minor) values
  ('return','GHS','Return flight reservation', 30000),
  ('return','USD','Return flight reservation',  2500)
on conflict (code, currency) do update
  set price_minor = excluded.price_minor, label = excluded.label, updated_at = now();
