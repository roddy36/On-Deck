# Onward Desk — Go-Live Runbook

Ordered steps to take this from prototype to taking real money. Do them in
order; each phase assumes the previous one worked. Nothing here is reversible
carelessly — read Phase 8 (test run) before you announce anything.

Legend: `<…>` = replace with your real value.

---

## Phase 0 — Accounts & tools (one-time)

You need, with the business's real identity:

- [ ] **Supabase** account + a new project → note the **project ref** (the
      `abcdefgh` in `abcdefgh.supabase.co`) and, from Project Settings → API,
      the **Project URL**, **anon key**, and **service_role key**.
- [ ] **Paystack** account, **business activated** (needs Adamens'
      registration documents — this is a lead time, start it first).
      From Settings → API Keys & Webhooks, note **Secret Key** and **Public Key**.
- [ ] **Resend** account + verified sending domain for `adamenstravels.com`,
      and an **API key**.
- [ ] A **host** for the static `public/` site (Netlify, Vercel, or Cloudflare
      Pages all work). Note the final origin, e.g. `https://onward.adamenstravels.com`.
- [ ] **Supabase CLI** installed locally. This machine has neither Node nor the
      CLI, so install one of:

```bash
scoop install supabase
```

```bash
npm install -g supabase
```

Then authenticate:

```bash
supabase login
```

---

## Phase 1 — Database

From inside `onward-desk/`:

```bash
supabase link --project-ref <PROJECT_REF>
```

```bash
supabase db push
```

`db push` runs all five migrations in order:

1. `…01_schema.sql` — tables, products, RLS, status function
2. `…02_staff_access.sql` — staff table + policies
3. `…03_expiry_sweeper.sql` — the hold-expiry job
4. `…04_passengers.sql` — multi-traveller columns
5. `…05_status_rate_limit.sql` — throttled status lookup
6. `…06_delivery_method.sql` — email / WhatsApp / both delivery column
7. `…07_return_enum.sql` — adds the `return` product to the enum (must be its
   own migration — Postgres won't use a new enum value in the transaction that
   created it)
8. `…08_reprice.sql` — sets live prices and inserts the return product rows

Confirm it worked (Supabase → SQL editor):

```sql
select code, currency, price_minor from products order by code, currency;
select * from cron.job;   -- the expiry sweeper should be listed
```

---

## Phase 2 — Confirm / adjust prices

Migration `…08_reprice.sql` already sets live prices (minor units — pesewas /
cents, per traveller):

| Product | GHS | USD |
|---------|-----|-----|
| flight (visa)   | 35000 (GH₵350) | 2900 ($29) |
| hotel           | 34000 (GH₵340) | 2800 ($28) |
| both            | 54000 (GH₵540) | 4500 ($45) |
| return          | 30000 (GH₵300) | 2500 ($25) |

You only need this phase if you want **different** numbers. To change one:

```sql
update products set price_minor = <PESEWAS>, updated_at = now()
  where code = 'flight' and currency = 'GHS';
-- repeat per code / currency as needed
```

If you change any price, mirror the same numbers in the browser so the displayed
price matches the charge. In **`public/index.html`**, edit:

```js
var DBPRICES = { GHS:{flight:35000,hotel:34000,both:54000,'return':30000}, USD:{flight:2900,hotel:2800,both:4500,'return':2500} };
```

…and the pricing-card figures and the FAQ/chatbot price lines in the same file.

(The server always re-prices from the DB — the browser copy is display only — but
they must agree, or customers see one number and get charged another.)

---

## Phase 3 — Deploy the edge functions

The flags differ per function and **matter**:

```bash
supabase functions deploy create-checkout --no-verify-jwt
```

```bash
supabase functions deploy paystack-webhook --no-verify-jwt
```

```bash
supabase functions deploy deliver-reservation
```

- The first two take unauthenticated callers (a customer, and Paystack's
  servers), so JWT verification is off.
- `deliver-reservation` **keeps** JWT verification — it checks the caller is in
  `staff`. Do not add `--no-verify-jwt` to it.

---

## Phase 4 — Secrets

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` are injected
automatically. Set the other three:

```bash
supabase secrets set PAYSTACK_SECRET_KEY=<sk_...> RESEND_API_KEY=<re_...> SITE_URL=<https://onward.adamenstravels.com>
```

`SITE_URL` must be the **exact origin** where the front end is hosted (Phase 5) —
it's used for both the payment callback and the function's CORS header. A
mismatch will silently break checkout in the browser.

---

## Phase 5 — Host the front end

Deploy the `public/` folder to your host. One thing to get right:

- [ ] The origin must equal `SITE_URL` from Phase 4, character for character
      (no trailing slash, right scheme).

The payment callback points at `/status.html` directly, so no rewrite rules are
needed — it works on any plain static host.

---

## Phase 6 — Wire the front end to Supabase

Fill your Project URL + anon key into **three** files:

**`public/index.html`** — near the top of the main `<script>`:

```js
var CONFIG = { url:'https://<PROJECT_REF>.supabase.co', anon:'<ANON_KEY>' };
```

**`public/status.html`**:

```js
const sb = createClient("https://<PROJECT_REF>.supabase.co", "<ANON_KEY>");
```

**`public/desk.html`**:

```js
const URL_ = "https://<PROJECT_REF>.supabase.co";
const ANON = "<ANON_KEY>";
```

The anon key is safe in the browser — RLS denies it everything except the
rate-limited `get_order_status` function. **Never** put the service_role key in
any file under `public/`. Redeploy the site after editing.

---

## Phase 7 — Register the Paystack webhook

Paystack → Settings → API Keys & Webhooks → Webhook URL:

```
https://<PROJECT_REF>.supabase.co/functions/v1/paystack-webhook
```

This is the only thing allowed to mark an order `paid`. Until it's registered,
payments will succeed at Paystack but orders will stay `pending_payment`.

---

## Phase 8 — Add yourself to the desk

Sign in once at `/desk.html` (it emails a magic link). That creates the auth
user but you won't see the queue yet — you must be in `staff`:

```sql
insert into staff (user_id, email, role)
select id, email, 'admin' from auth.users
where email = 'you@adamenstravels.com';
```

Reload `/desk.html`; the queue should appear.

---

## Phase 9 — Full test-card run (do NOT skip)

Use Paystack **test** keys for this. One order, all the way through:

1. On the site, book a flight reservation to a real route, your own email.
2. Pay with a Paystack test card: **4084 0840 8408 4081**, any future expiry,
   CVV **408**, PIN **0000**, OTP **123456**.
3. Check the webhook fired: order moves `pending_payment → paid`
   (Supabase → Table editor → orders), and a receipt email arrives.
4. On `/desk.html`: **Claim**, then **Deliver** with a throwaway reference and a
   real verify URL. Confirm the customer gets the delivery email.
5. On `/status`, look the order up with reference + email — it should show
   `delivered` and the reference.
6. Test a **failure**: mark another order "Can't issue" → status `failed`, then
   refund it in the Paystack dashboard → confirm the webhook flips it to
   `refunded` and the refund email sends.
7. Test the **rate limit**: hit `/status` with a wrong email ~7 times fast →
   you should get the "too many attempts" message.

Only once all seven pass, swap test keys for live keys (re-run Phase 4 with the
`sk_live_…` key) and redeploy.

---

## Phase 10 — Before you announce

- [ ] Paystack business fully activated (live keys work).
- [ ] Real prices in `products` **and** `index.html` agree.
- [ ] Expiry sweeper scheduled (`select * from cron.job;`).
- [ ] Ghana Tourism Authority licensing confirmed to cover this service.
- [ ] Self-host the hero/route images and the airport list instead of hotlinking
      CDNs (works today, but not production-grade).
- [ ] A supplier/Duffel path for actually **issuing** the PNRs — the one step
      that is still manual and is the real bottleneck, not the code.

---

## Phase 11 — Domain + Google indexing (so it gets found)

The site ships with full on-page SEO (title, meta, FAQ + visa sections, JSON-LD
structured data, sitemap, robots). Two things still need doing: point everything
at your real domain, then tell Google the site exists.

### 11a. Swap in your real domain

Everywhere the code says `your-horizon-domain.com`, replace it with your live
domain. It appears in:

- `public/index.html` — `<link rel="canonical">`, the `og:url` / `og:image` /
  `twitter:image` tags, and the `url`/`logo` in the JSON-LD blocks
- `public/robots.txt` — the `Sitemap:` line
- `public/sitemap.xml` — the `<loc>` URL

Find them all quickly:

```bash
grep -rn "your-horizon-domain.com" public/
```

Also fill in, while you're at it:

- Chatbot contact — top of the chat `<script>` in `index.html`: `WA` (WhatsApp
  number, digits only) and `EMAIL`.
- Email `from:` address — `desk@yourdomain.com` in the three edge functions
  (`create-checkout` isn't one; it's in `paystack-webhook` and
  `deliver-reservation`). Use an address on a domain you've verified in Resend.

### 11b. Google Search Console

1. Go to **search.google.com/search-console** and add your site as a
   **Domain** property (or URL-prefix if you can't edit DNS).
2. **Verify ownership** — the DNS TXT record method is easiest if you control the
   domain; otherwise upload the HTML verification file to `public/`.
3. **Submit your sitemap**: Search Console → *Sitemaps* → enter `sitemap.xml` →
   Submit. (Full URL: `https://your-domain/sitemap.xml`.)
4. **Request indexing** for the homepage: paste your URL into the *URL Inspection*
   bar at the top → *Request indexing*. This nudges Google to crawl within days
   instead of weeks.
5. Confirm the structured data is picked up: run your live URL through the
   **Rich Results Test** (search.google.com/test/rich-results) — it should report
   a valid **FAQ** result.

### 11c. Bing (optional, quick win)

Add the site at **bing.com/webmasters** and submit the same `sitemap.xml`. Bing
also feeds DuckDuckGo, and you can often *import* the property straight from
Search Console in one click.

### 11d. What actually moves ranking (be realistic)

On-page SEO makes you **eligible**; it doesn't guarantee page one for a
competitive term like "dummy ticket". The levers that decide position over the
following weeks and months are mostly **off-page**:

- [ ] A **Google Business Profile** for the agency (Accra) — helps local + brand searches.
- [ ] **Backlinks**: get listed in Ghana travel/visa directories, forums, and any
      partners' sites. Quality links are the single biggest ranking factor you
      don't already have.
- [ ] **Fresh content**: the FAQ and visa sections are a start; a few honest
      articles ("dummy ticket vs real reservation", "proof of onward travel for a
      Schengen visa") build topical authority.
- [ ] **Speed**: once you self-host the images (Phase 10), check
      **pagespeed.web.dev** and keep the mobile score healthy.
- [ ] Don't buy links or spin keyword-stuffed pages — Google penalises it, and it
      can get the whole domain deindexed. Everything shipped here is white-hat;
      keep it that way.

---

### Rollback

If something goes wrong after launch, the safe stop is to take the booking
page down (or point the pay button back to demo by restoring the `YOUR-PROJECT`
placeholder in `index.html`). Orders already `paid` stay safe in the DB and can
be delivered by hand from the desk.
