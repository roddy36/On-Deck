// supabase/functions/deliver-reservation/index.ts
//
// The only path by which a booking reference enters the database.
// Deploy WITH jwt verification (the default):
//   supabase functions deploy deliver-reservation
//
// Secrets: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
//          RESEND_API_KEY, SITE_URL

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": Deno.env.get("SITE_URL") ?? "*",
  "Access-Control-Allow-Headers": "content-type, authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "content-type": "application/json" } });

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  // --- who is asking ---
  const authHeader = req.headers.get("Authorization") ?? "";
  const asUser = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );

  const { data: { user } } = await asUser.auth.getUser();
  if (!user) return json({ error: "Sign in first." }, 401);

  const { data: member } = await admin
    .from("staff").select("email,active").eq("user_id", user.id).single();
  if (!member?.active) return json({ error: "This account isn't on the desk." }, 403);

  const body = await req.json().catch(() => ({}));
  const action = String(body.action ?? "");
  const reference = String(body.reference ?? "").trim().toUpperCase();
  if (!reference) return json({ error: "Which order?" }, 400);

  const { data: order } = await admin
    .from("orders")
    .select("id,status,email,whatsapp,delivery_method,given_names,reference,lookup_token,product")
    .eq("reference", reference).single();

  if (!order) return json({ error: "No order with that reference." }, 404);

  // ---------- claim ----------
  if (action === "claim") {
    if (order.status !== "paid") return json({ error: `Order is ${order.status}, not waiting.` }, 409);
    await admin.from("orders")
      .update({ status: "issuing", fulfilled_by: member.email })
      .eq("id", order.id).eq("status", "paid");   // loses the race safely
    await admin.from("order_events")
      .insert({ order_id: order.id, event: "claimed", actor: member.email });
    return json({ ok: true });
  }

  // ---------- deliver ----------
  if (action === "deliver") {
    if (!["paid", "issuing"].includes(order.status)) {
      return json({ error: `Order is ${order.status}. Nothing to deliver.` }, 409);
    }

    const pnr = String(body.booking_reference ?? "").trim().toUpperCase();
    const airline = String(body.airline_iata ?? "").trim().toUpperCase();
    const verifyUrl = String(body.verify_url ?? "").trim();
    const expires = String(body.hold_expires_at ?? "");
    const source = String(body.source ?? "");
    const costMinor = Number.parseInt(String(body.supplier_cost_minor ?? "0"), 10);

    // The checks that matter. A reference nobody can verify is worse
    // than no reference, because the customer will rely on it.
    if (!/^[A-Z0-9]{5,8}$/.test(pnr)) {
      return json({ error: "A booking reference is 5–8 letters and digits. Check what the airline returned." }, 400);
    }
    if (!/^https:\/\//.test(verifyUrl)) {
      return json({ error: "Add the https link where this reference can be checked." }, 400);
    }
    if (!expires || Number.isNaN(Date.parse(expires))) {
      return json({ error: "When does the hold lapse?" }, 400);
    }
    if (Date.parse(expires) <= Date.now()) {
      return json({ error: "That hold has already expired. Don't send it." }, 400);
    }
    if (!["duffel_hold", "supplier_api", "supplier_manual", "free_cancel_rate"].includes(source)) {
      return json({ error: "Pick where this came from." }, 400);
    }
    if (!Number.isFinite(costMinor) || costMinor < 0) {
      return json({ error: "Enter what it cost, even if that's zero." }, 400);
    }

    const { error: upErr } = await admin.from("orders").update({
      status: "delivered",
      booking_reference: pnr,
      airline_iata: airline || null,
      verify_url: verifyUrl,
      hold_expires_at: new Date(expires).toISOString(),
      source,
      supplier_cost_minor: costMinor,
      issued_at: new Date().toISOString(),
      delivered_at: new Date().toISOString(),
      fulfilled_by: member.email,
    }).eq("id", order.id);

    if (upErr) return json({ error: "Couldn't save that." }, 500);

    await admin.from("order_events").insert({
      order_id: order.id, event: "delivered", actor: member.email,
      detail: { booking_reference: pnr, source, cost_minor: costMinor },
    });

    const dm = order.delivery_method ?? "email";
    if (dm === "email" || dm === "both") await sendReference(order, pnr, verifyUrl, expires);
    if (dm === "whatsapp" || dm === "both") await sendWhatsAppReference(order, pnr, verifyUrl, expires);
    return json({ ok: true });
  }

  // ---------- couldn't issue ----------
  if (action === "fail") {
    const reason = String(body.reason ?? "").trim().slice(0, 500);
    if (reason.length < 5) return json({ error: "Say what went wrong — the customer gets told." }, 400);

    await admin.from("orders")
      .update({ status: "failed", internal_notes: reason, fulfilled_by: member.email })
      .eq("id", order.id);
    await admin.from("order_events")
      .insert({ order_id: order.id, event: "failed", actor: member.email, detail: { reason } });

    return json({ ok: true, reminder: "Refund this in the Paystack dashboard now." });
  }

  return json({ error: "Unknown action." }, 400);
});

async function sendReference(
  order: Record<string, any>, pnr: string, verifyUrl: string, expires: string,
) {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return;

  const when = new Date(expires).toUTCString();

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: "Horizon Ticketing & Reservations <desk@yourdomain.com>",
      to: [order.email],
      subject: `${order.reference} — your booking reference is ${pnr}`,
      text:
`Hello ${order.given_names},

Your reservation is confirmed.

  Booking reference:  ${pnr}
  Held until:         ${when}

Check it yourself before you use it:
${verifyUrl}

Enter the reference there and confirm your name comes up. If it doesn't,
reply to this email straight away and we'll refund you in full — do not
submit it to a consulate.

Two things worth repeating:

  - This reservation is not a paid ticket. You cannot fly on it.
  - It lapses at the time above, by design. Time your visa appointment
    or check-in accordingly, and tell us if your date moves.

Horizon — Ticketing & Reservations`,
    }),
  });
}

// --- WhatsApp delivery via the Meta WhatsApp Cloud API ---
// Secrets: WHATSAPP_TOKEN (permanent access token), WHATSAPP_PHONE_ID (sender phone-number ID).
// NOTE: business-initiated messages outside a 24-hour customer window require a
// pre-approved message template. For production, register a template and send it
// here instead of free text; the free text below works when the customer has
// messaged you within the last 24 hours.
async function sendWhatsAppReference(
  order: Record<string, any>, pnr: string, verifyUrl: string, expires: string,
) {
  const token = Deno.env.get("WHATSAPP_TOKEN");
  const phoneId = Deno.env.get("WHATSAPP_PHONE_ID");
  const to = String(order.whatsapp ?? "").replace(/\D/g, "");
  if (!token || !phoneId || to.length < 8) return;

  const when = new Date(expires).toUTCString();
  const text =
`Hello ${order.given_names}, your Horizon reservation ${order.reference} is confirmed.

Booking reference: ${pnr}
Held until: ${when}

Verify it before you use it: ${verifyUrl}

This is a real reservation, not a paid ticket — you can't fly on it, and it lapses at the time above. If your name doesn't come up when you check, reply here and we'll refund you in full.`;

  await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });
}
