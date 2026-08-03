# Onward Desk

Onward-travel and hotel reservations for visa applicants, run by Adamens Travels (Accra, Ghana).
Customers pay for a **real, verifiable reservation** they can show a consulate or a gate agent.

Stack: Supabase (Postgres + edge functions) · Paystack · Resend · static HTML front end.

---

## Invariants

These are not style preferences. Breaking any of them turns a legitimate travel
service into document fraud, or loses money. Do not relax them to make a test pass.

1. **A booking reference only ever comes from an airline or hotel system.**
   Nothing in this codebase may generate, mock, or placeholder a PNR into
   `orders.booking_reference`. If you need fixture data for tests, use a
   separate schema — never the real column.

2. **Only `paystack-webhook` may set `status = 'paid'`.**
   The browser returning from checkout proves nothing; that URL can be typed
   by hand. The webhook verifies the HMAC signature, re-checks with Paystack's
   API, and confirms the amount matches what we asked for.

3. **Prices come from the `products` table, never from the request body.**
   `create-checkout` looks up `price_minor` server-side. If you ever find
   yourself reading an amount off the client, stop.

4. **Money is stored in minor units as integers.** Pesewas and cents. No floats.

5. **Staff have SELECT only.** There is deliberately no UPDATE policy on
   `orders`. All writes go through `deliver-reservation`, which validates the
   reference format, requires an https verification link, and rejects holds
   that have already expired. Don't add an UPDATE policy for convenience.

6. **`security_invoker = on` on every view over `orders`.** Without it a view
   runs as its owner and bypasses RLS entirely.

7. **The queue is oldest-first.** Never sort fulfilment by order value.

---

## Layout

```
supabase/migrations/    schema, staff access, expiry sweeper
supabase/functions/
  create-checkout/      validates input, prices it, opens Paystack
  paystack-webhook/     confirms payment. The only writer of 'paid'.
  deliver-reservation/  staff action: claim / deliver / fail
public/
  index.html            booking form
  status.html           customer order tracking
  desk.html             staff fulfilment desk (magic-link auth)
```

## Order lifecycle

```
pending_payment ──webhook──> paid ──claim──> issuing ──deliver──> delivered
                               │                 │                    │
                               └───── fail ──────┘              sweeper ↓
                                       ↓                          expired
                                    failed → (manual refund in Paystack)
```

## Deploying

```bash
supabase db push
supabase functions deploy create-checkout     --no-verify-jwt
supabase functions deploy paystack-webhook    --no-verify-jwt
supabase functions deploy deliver-reservation                 # JWT required
```

The first two take unauthenticated callers (a customer, and Paystack's servers).
`deliver-reservation` must keep JWT verification — it checks the caller is in `staff`.

## Secrets

`PAYSTACK_SECRET_KEY` `RESEND_API_KEY` `SITE_URL`
(`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.)

The service role key bypasses RLS. It belongs in edge functions only — never in
anything under `public/`.

---

## Outstanding

- [ ] Fill in the Supabase project URL and anon key in `public/status.html` and `public/desk.html`
- [ ] Wire `public/index.html`'s pay button to `create-checkout` (currently a local mock)
- [ ] Rate-limit `get_order_status` — needs reference + email, but nothing throttles attempts
- [ ] Handle the `refund.processed` webhook path end-to-end
- [ ] Replace placeholder prices in migration 1 with real numbers once suppliers quote
- [ ] Decide GHS-only vs GHS + USD at launch

## Known constraints

- **Stripe is unavailable to Ghana-registered merchants.** This is why the
  integration is Paystack. Don't "upgrade" it to Stripe without first moving
  the business to a US or UK entity.
- Paystack settles local payments T+1; international card payments take longer.
- Refunds are intentionally manual. Don't automate them on a young account.
