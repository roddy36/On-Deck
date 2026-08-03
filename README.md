# Onward Desk

Verifiable onward-travel and hotel reservations for visa applicants.
Adamens Travels, Accra.

See `CLAUDE.md` for architecture and the invariants that must hold.

## Setup

1. Create a Supabase project, then `supabase link --project-ref <ref>`
2. `supabase db push`
3. `supabase secrets set PAYSTACK_SECRET_KEY=... RESEND_API_KEY=... SITE_URL=...`
4. Deploy the three functions (see CLAUDE.md — flags differ per function)
5. Register the webhook URL in the Paystack dashboard under
   Settings → API Keys & Webhooks
6. Sign in once at `/desk.html`, then add yourself to staff:

   ```sql
   insert into staff (user_id, email, role)
   select id, email, 'admin' from auth.users where email = 'you@adamenstravels.com';
   ```

7. Fill the project URL and anon key into `public/status.html` and `public/desk.html`

## Before taking real money

- [ ] Paystack business activated (needs Adamens registration documents)
- [ ] Full test-card run: pay → webhook → queue → deliver → email → status page
- [ ] Confirm the expiry sweeper is scheduled: `select * from cron.job;`
- [ ] Real prices in migration 1, not the placeholders
- [ ] Check Ghana Tourism Authority licensing covers this line of business
