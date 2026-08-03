// supabase/functions/paystack-webhook/index.ts
//
// Paystack calls this when money moves. It is the only thing allowed to
// mark an order paid — never trust the browser returning from checkout.
//
// Deploy:  supabase functions deploy paystack-webhook --no-verify-jwt
// Then add the URL under Paystack Dashboard → Settings → API Keys & Webhooks.
//
// Secrets: PAYSTACK_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SECRET = Deno.env.get("PAYSTACK_SECRET_KEY")!;

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// --- HMAC SHA-512, the signature scheme Paystack uses ---
async function sign(raw: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// constant time — a plain === leaks timing information
function equal(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });

  // must read the raw body — re-serialised JSON will not match the signature
  const raw = await req.text();
  const given = req.headers.get("x-paystack-signature") ?? "";

  if (!equal(await sign(raw), given)) {
    console.warn("rejected: bad signature");
    return new Response("invalid signature", { status: 401 });
  }

  const evt = JSON.parse(raw);

  // Acknowledge fast. Paystack retries on anything slow or non-200,
  // and a duplicate delivery must not double-process.
  queueMicrotask(() => handle(evt).catch((e) => console.error("handler failed", e)));
  return new Response("ok", { status: 200 });
});

async function handle(evt: { event: string; data: Record<string, any> }) {
  if (evt.event === "charge.success") {
    const ref = evt.data?.reference;
    if (!ref) return;

    // Re-verify against Paystack directly. The webhook body tells us what
    // happened; this confirms it, and gives us the real fee.
    const res = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(ref)}`, {
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    const v = await res.json();
    if (!v.status || v.data?.status !== "success") {
      console.warn("verify disagreed with webhook", ref);
      return;
    }

    const { data: order } = await db
      .from("orders")
      .select("id,status,amount_charged_minor,currency,reference,email,given_names,family_name,lookup_token")
      .eq("reference", ref)
      .single();

    if (!order) return console.warn("no such order", ref);

    // idempotency — a retry lands here and stops
    if (order.status !== "pending_payment") return;

    // did they actually pay what we asked for?
    if (v.data.amount !== order.amount_charged_minor || v.data.currency !== order.currency) {
      await db.from("orders").update({ status: "failed" }).eq("id", order.id);
      await db.from("order_events").insert({
        order_id: order.id,
        event: "amount_mismatch",
        actor: "paystack",
        detail: { expected: order.amount_charged_minor, received: v.data.amount },
      });
      return;
    }

    await db.from("orders").update({
      status: "paid",
      paid_at: new Date(v.data.paid_at ?? Date.now()).toISOString(),
      paystack_reference: v.data.reference,
      paystack_channel: v.data.channel,
      processor_fee_minor: v.data.fees ?? 0,
    }).eq("id", order.id);

    await db.from("order_events").insert({
      order_id: order.id,
      event: "payment_confirmed",
      actor: "paystack",
      detail: { channel: v.data.channel, fees: v.data.fees },
    });

    await receipt(order);
  }

  if (evt.event === "refund.processed") {
    // Paystack carries the original order reference in transaction_reference here.
    const ref = evt.data?.transaction_reference ?? evt.data?.reference;
    if (!ref) return;

    const { data: o } = await db
      .from("orders")
      .select("id,status,email,reference,given_names,currency,lookup_token")
      .eq("reference", ref)
      .maybeSingle();

    if (!o) return console.warn("refund: no such order", ref);
    if (o.status === "refunded") return; // idempotent — Paystack retries

    await db.from("orders").update({ status: "refunded" }).eq("id", o.id);
    await db.from("order_events").insert({
      order_id: o.id,
      event: "refunded",
      actor: "paystack",
      detail: { amount_minor: evt.data?.amount ?? null, currency: evt.data?.currency ?? o.currency },
    });

    await refundEmail(o, evt.data?.amount ?? null);
  }
}

// --- confirmation email ---
// Deliberately does not promise a booking reference it doesn't have yet.
async function receipt(order: Record<string, any>) {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return;

  const site = Deno.env.get("SITE_URL") ?? "";
  const status = `${site}/status.html?ref=${order.reference}&t=${order.lookup_token}`;

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: "Adamens Onward Desk <desk@adamenstravels.com>",
      to: [order.email],
      subject: `Order ${order.reference} received`,
      text:
`Hello ${order.given_names},

We have your payment for order ${order.reference}.

Your reservation is being created now. As soon as the airline returns a
booking reference we'll email it to you, usually within two hours.

Track it here: ${status}

When the reference arrives, check it on the airline's own "manage booking"
page before you submit anything to a consulate. If it doesn't come up there,
reply to this email and we'll refund you in full.

Adamens Travels, Accra`,
    }),
  });
}

// --- refund confirmation email ---
async function refundEmail(order: Record<string, any>, amountMinor: number | null) {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return;

  const amt = amountMinor != null
    ? `${order.currency === "USD" ? "$" : "GH₵"}${(amountMinor / 100).toFixed(2)} `
    : "";

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: "Adamens Onward Desk <desk@adamenstravels.com>",
      to: [order.email],
      subject: `Order ${order.reference} refunded`,
      text:
`Hello ${order.given_names},

We've refunded ${amt}for order ${order.reference} in full.

Depending on your bank or mobile money provider it can take a few working
days to show up. You don't need to do anything.

If you still need proof of onward travel, you're welcome to order again.

Adamens Travels, Accra`,
    }),
  });
}
