// supabase/functions/create-checkout/index.ts
//
// Creates a pending order and hands back a Paystack payment URL.
// Deploy:  supabase functions deploy create-checkout --no-verify-jwt
//
// Secrets required:
//   PAYSTACK_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SITE_URL

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": Deno.env.get("SITE_URL") ?? "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const IATA = /^[A-Z]{3}$/;
const clean = (v: unknown, max = 120) =>
  typeof v === "string" ? v.trim().slice(0, max) : "";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Send valid JSON." }, 400);
  }

  const product = clean(body.product) as "flight" | "hotel" | "both";
  const currency = (clean(body.currency) || "GHS").toUpperCase();
  const channel = (clean(body.channel) || "").toLowerCase(); // '', 'card' or 'mobile_money'
  const delivery = (clean(body.delivery_method) || "email").toLowerCase();

  if (!["flight", "hotel", "both"].includes(product)) {
    return json({ error: "Choose a flight, hotel, or combined reservation." }, 400);
  }
  if (!["GHS", "USD"].includes(currency)) {
    return json({ error: "Unsupported currency." }, 400);
  }
  if (channel && !["card", "mobile_money"].includes(channel)) {
    return json({ error: "Unsupported payment method." }, 400);
  }
  if (channel === "mobile_money" && currency !== "GHS") {
    return json({ error: "Mobile Money is only available in Ghana cedis (GHS)." }, 400);
  }
  if (!["email", "whatsapp", "both"].includes(delivery)) {
    return json({ error: "Choose email, WhatsApp, or both for delivery." }, 400);
  }

  // travellers — one reservation each. Accept an array; fall back to the
  // single-name fields so older callers keep working.
  const rawPax = Array.isArray(body.passengers) ? body.passengers : null;
  const passengers = (rawPax ?? [{ given: body.given_names, family: body.family_name }])
    .map((p) => ({
      given: clean((p as Record<string, unknown>)?.given ?? (p as Record<string, unknown>)?.given_names, 80),
      family: clean((p as Record<string, unknown>)?.family ?? (p as Record<string, unknown>)?.family_name, 80),
    }))
    .filter((p) => p.given || p.family);

  if (passengers.length < 1 || passengers.length > 9) {
    return json({ error: "Add between 1 and 9 travellers." }, 400);
  }
  if (passengers.some((p) => !p.given || !p.family)) {
    return json({ error: "Enter each traveller's given and family names exactly as printed on the passport." }, 400);
  }

  const order = {
    product,
    currency,
    email: clean(body.email).toLowerCase(),
    whatsapp: clean(body.whatsapp, 32) || null,
    delivery_method: delivery,
    given_names: passengers[0].given,   // lead traveller stays in these columns
    family_name: passengers[0].family,
    passenger_count: passengers.length,
    passengers,
    origin_iata: clean(body.origin_iata, 3).toUpperCase() || null,
    destination_iata: clean(body.destination_iata, 3).toUpperCase() || null,
    depart_date: clean(body.depart_date, 10) || null,
    return_date: clean(body.return_date, 10) || null,
    hotel_city: clean(body.hotel_city, 120) || null,
    check_in: clean(body.check_in, 10) || null,
    check_out: clean(body.check_out, 10) || null,
  };

  // --- validate ---
  if (!order.email.includes("@")) {
    return json({ error: "Enter the email address where we should send the reservation." }, 400);
  }
  if (delivery !== "email" && (order.whatsapp ?? "").replace(/\D/g, "").length < 8) {
    return json({ error: "Add a WhatsApp number (with country code) to receive the reservation there." }, 400);
  }
  if (product !== "hotel") {
    if (!IATA.test(order.origin_iata ?? "") || !IATA.test(order.destination_iata ?? "")) {
      return json({ error: "Use three-letter airport codes, like ACC and LIS." }, 400);
    }
    if (!order.depart_date) return json({ error: "Pick a departure date." }, 400);
    if (new Date(order.depart_date) < new Date(Date.now() - 864e5)) {
      return json({ error: "The departure date has already passed." }, 400);
    }
    if (order.return_date && order.return_date < order.depart_date) {
      return json({ error: "The return date can't be before the departure date." }, 400);
    }
  }
  if (product !== "flight") {
    if (!order.hotel_city || !order.check_in || !order.check_out) {
      return json({ error: "Enter the city and both stay dates." }, 400);
    }
    if (order.check_out <= order.check_in) {
      return json({ error: "Check-out has to be after check-in." }, 400);
    }
  }

  // --- price comes from the database, never from the caller ---
  const { data: price, error: priceErr } = await db
    .from("products")
    .select("price_minor,label")
    .eq("code", product)
    .eq("currency", currency)
    .eq("active", true)
    .single();

  if (priceErr || !price) {
    return json({ error: "That option isn't available right now." }, 409);
  }

  // --- one price per traveller, computed server-side ---
  const amount = price.price_minor * order.passenger_count;

  // --- create the pending order ---
  const { data: created, error: insErr } = await db
    .from("orders")
    .insert({ ...order, amount_charged_minor: amount })
    .select("id,reference,lookup_token")
    .single();

  if (insErr) {
    console.error("insert failed", insErr);
    return json({ error: "We couldn't start that order. Try again." }, 500);
  }

  // --- hand off to Paystack ---
  const site = Deno.env.get("SITE_URL") ?? "";
  const psRes = await fetch("https://api.paystack.co/transaction/initialize", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${Deno.env.get("PAYSTACK_SECRET_KEY")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      email: order.email,
      amount,
      currency,
      reference: created.reference,
      // restrict Paystack's UI to the method the customer chose (mobile money / card)
      ...(channel ? { channels: [channel] } : {}),
      callback_url: `${site}/status.html?ref=${created.reference}&t=${created.lookup_token}`,
      metadata: {
        order_id: created.id,
        product,
        passenger_count: order.passenger_count,
        custom_fields: [{
          display_name: "Reservation",
          variable_name: "reservation",
          value: `${price.label} × ${order.passenger_count}`,
        }],
      },
    }),
  });

  const ps = await psRes.json();
  if (!psRes.ok || !ps.status) {
    console.error("paystack init failed", ps);
    await db.from("orders").update({ status: "failed" }).eq("id", created.id);
    return json({ error: "Payment couldn't be started. Nothing has been charged." }, 502);
  }

  await db.from("order_events").insert({
    order_id: created.id,
    event: "checkout_started",
    actor: "system",
    detail: { currency, amount_minor: amount, passenger_count: order.passenger_count, channel: channel || "any" },
  });

  return json({
    reference: created.reference,
    lookup_token: created.lookup_token,
    payment_url: ps.data.authorization_url,
  });
});
