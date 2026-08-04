<p align="center">
  <img src="public/horizon-mark.png" width="96" alt="Horizon logo">
</p>

<h1 align="center">Horizon — Ticketing &amp; Reservations</h1>

<p align="center">
  Verifiable onward-travel and hotel reservations for visa applicants.<br>
  A dummy ticket the embassy can <em>actually check</em>.
</p>

---

## What this is

Horizon sells **real, verifiable flight and hotel reservations** — proof of
onward travel a visa applicant can show a consulate or a gate agent. The booking
reference comes from an airline or hotel system and returns the traveller's name
when checked. It is deliberately **not** a fake PDF that only looks like a
booking.

> ⚠️ **Status: working prototype, not yet live.** The code is production-shaped
> but still needs a Supabase project, a Paystack account, a domain, and a full
> test-payment run before it can take real money. See **[GOLIVE.md](GOLIVE.md)**.

## Features

- 🎫 **Booking flow** — flight, hotel, or both; worldwide airport search
  (city / country / IATA); multi-traveller (up to 9); live ticket-stub preview.
- 💳 **Payments via Paystack** — Mobile Money (MTN / Vodafone / AirtelTigo) or
  card, in GH₵ or USD. Prices are always priced server-side.
- 📩 **Delivery by email, WhatsApp, or both** — the customer chooses.
- 🔎 **Order tracking** — rate-limited status lookup by reference + email.
- 🧑‍💼 **Staff fulfilment desk** — magic-link auth, oldest-first queue,
  claim / deliver / can't-issue.
- 💬 **Chatbot** — self-contained FAQ assistant with human escalation.
- 🔍 **SEO** — title/meta, Open Graph, JSON-LD (TravelAgency, Service, FAQPage),
  FAQ + visa-type content, `robots.txt`, `sitemap.xml`.

## Tech stack

| Layer | Tech |
|-------|------|
| Front end | Static HTML/CSS/JS (no build step) |
| Backend | Supabase — Postgres + Deno edge functions |
| Payments | Paystack |
| Email | Resend |
| WhatsApp | Meta WhatsApp Cloud API (optional) |

## Project structure

```
public/                     static front end
  index.html                booking page + chatbot
  status.html               customer order tracking
  desk.html                 staff fulfilment desk
  horizon-mark.png          logo
  robots.txt · sitemap.xml  SEO
supabase/
  functions/
    create-checkout/        validates input, prices it, opens Paystack
    paystack-webhook/        confirms payment — the only writer of 'paid'
    deliver-reservation/    staff action: claim / deliver / fail
  migrations/               schema, staff access, expiry sweeper,
                            passengers, rate limit, delivery method
GOLIVE.md                   ordered go-live runbook
CLAUDE.md                   architecture + the invariants that must hold
```

## Run the front end locally

No build step — just open `public/index.html` in a browser, or serve the folder:

```bash
cd public
python -m http.server 8000
# then visit http://localhost:8000
```

Until Supabase keys are set in the HTML, the pay button runs a local **demo**
(no real charge).

## Deploy

Follow **[GOLIVE.md](GOLIVE.md)** — it walks through creating the Supabase
project, running the migrations, deploying the three functions, setting secrets,
hosting the front end, registering the Paystack webhook, a full test-card run,
and Google indexing.

## Ground rules (see [CLAUDE.md](CLAUDE.md))

These aren't style preferences — breaking them turns a legitimate service into
document fraud, or loses money:

1. A booking reference only ever comes from an airline or hotel system — never
   mocked or generated.
2. Only the Paystack webhook may mark an order `paid`.
3. Prices come from the `products` table, never the request body.
4. Money is stored in minor units as integers.
5. Staff have SELECT only; all writes go through `deliver-reservation`.

---

<p align="center"><sub>Adamens Travels / Horizon · Accra, Ghana</sub></p>
