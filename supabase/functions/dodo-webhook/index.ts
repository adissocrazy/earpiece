// Dodo Payments → Earpiece Pro. Verifies the Standard Webhooks signature, then keeps
// public.subscriptions in step with the subscription's life: active/renewed → Pro until the next
// billing date (plus a short grace for late renewals), cancelled/past due → Pro until the paid
// period ends, on hold/expired/failed → Free. Older events delivered late are ignored.
// Lifetime is a one-time payment: payment.succeeded for it → Pro with no end date (and any running
// subscription is set to cancel at its next billing date, so it isn't charged again); a refund or
// lost dispute of that payment → Free. Subscription events never change a lifetime account.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { Webhook } from "npm:standardwebhooks@1.0.0";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const GRACE_MS = 2 * 24 * 3600_000; // a renewal webhook that arrives a little late doesn't cut access
// Earpiece Pro products, live and test (ids aren't secret; DODO_PRODUCT_MONTH / _YEAR add to them).
const env = (name: string) => (Deno.env.get(name) || "").trim().replace(/^["']|["']$/g, "");
const PRO_PRODUCTS = [
  "pdt_0Nox7nghhsoBXPYpVE3cy", "pdt_0Nox7nhuXf5QMA425MfjH", // live
  "pdt_0NowseZLebYL9xfZ7e6RC", "pdt_0NowsebJJIuoHy8MRWTIt", // test
  env("DODO_PRODUCT_MONTH"), env("DODO_PRODUCT_YEAR"),
].filter(Boolean);
const LIFETIME_PRODUCTS = ["pdt_0NpZ2e9UXUDouyVlIDrP4", env("DODO_PRODUCT_LIFETIME")].filter(Boolean);
const DODO = env("DODO_ENV").toLowerCase() === "live" ? "https://live.dodopayments.com" : "https://test.dodopayments.com";
const API_KEY = env("DODO_API_KEY").replace(/^Bearer\s+/i, "");

async function dodo(method: string, path: string, body?: unknown) {
  const res = await fetch(`${DODO}${path}`, {
    method,
    signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`dodo ${method} ${path} HTTP ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}

// Where an event's plan goes: the account (user id from the checkout metadata, else the account with
// the customer's email), or, for someone who bought on the website and hasn't signed in yet, a row
// in pending_subscriptions under that email, which their first sign-in claims.
type Who = { table: "subscriptions"; key: "user_id"; id: string } | { table: "pending_subscriptions"; key: "email"; id: string };
async function whoFor(d: Record<string, any>): Promise<Who | null> {
  const email = String(d.customer?.email || "").trim().toLowerCase();
  let uid: string | null = d.metadata?.user_id || null;
  if (!uid && email) uid = (await admin.rpc("user_id_by_email", { p_email: email })).data || null;
  if (uid) return { table: "subscriptions", key: "user_id", id: uid };
  return email ? { table: "pending_subscriptions", key: "email", id: email } : null;
}

const read = async (who: Who, cols: string) => (await admin.from(who.table).select(cols).eq(who.key, who.id).maybeSingle()).data as Record<string, any> | null;

async function save(who: Who, row: Record<string, unknown>) {
  const { error } = await admin.from(who.table).upsert({ [who.key]: who.id, ...row, updated_at: new Date().toISOString() });
  if (error) console.error("dodo-webhook upsert", who.table, error.message);
  return error ? new Response("db error", { status: 500 }) : ok(); // Dodo retries a 500
}

async function onLifetimePayment(event: { timestamp: string; data: Record<string, any> }) {
  const pay = event.data;
  // The webhook payload usually carries the cart; if not, ask Dodo for the payment.
  const cart: { product_id: string }[] = pay.product_cart ?? (await dodo("GET", `/payments/${pay.payment_id}`)).product_cart ?? [];
  if (!cart.some((i) => LIFETIME_PRODUCTS.includes(i.product_id))) return ok(); // a subscription payment, or another brand
  const who = await whoFor(pay);
  if (!who) {
    console.error("dodo-webhook: no user or email for lifetime payment", pay.payment_id);
    return ok();
  }
  const cur = await read(who, "status, provider_subscription_id, lifetime");
  const res = await save(who, {
    plan: "pro",
    status: "active",
    current_period_end: null,
    lifetime: true,
    lifetime_payment_id: pay.payment_id,
    provider: "dodo",
    provider_customer_id: pay.customer?.customer_id || null,
    event_at: event.timestamp,
  });
  // A monthly or yearly plan still running would bill again: stop it at its next billing date.
  if (res.ok && !cur?.lifetime && cur?.provider_subscription_id && ["active", "trialing", "past_due"].includes(cur.status)) {
    try {
      await dodo("PATCH", `/subscriptions/${cur.provider_subscription_id}`, { cancel_at_next_billing_date: true });
    } catch (e) {
      console.error("dodo-webhook: couldn't cancel the old subscription", cur.provider_subscription_id, String(e));
    }
  }
  return res;
}

// A refund or lost dispute of the lifetime payment ends it. Partial refunds (a goodwill credit) don't.
async function onLifetimeReversal(event: { type: string; timestamp: string; data: Record<string, any> }) {
  const d = event.data;
  if (event.type === "refund.succeeded" && d.is_partial === true) return ok();
  if (!d.payment_id) return ok();
  for (const [table, key] of [["subscriptions", "user_id"], ["pending_subscriptions", "email"]] as const) {
    const { data } = await admin.from(table).select(key).eq("lifetime_payment_id", d.payment_id).eq("lifetime", true).maybeSingle();
    const id = (data as Record<string, string> | null)?.[key];
    if (id) return save({ table, key, id } as Who, { plan: "free", status: "canceled", current_period_end: event.timestamp, lifetime: false, event_at: event.timestamp });
  }
  return ok(); // not a lifetime payment
}

const ok = () => new Response(JSON.stringify({ received: true }), { headers: { "Content-Type": "application/json" } });
const plus = (iso: string | null | undefined, ms: number) => (iso ? new Date(Date.parse(iso) + ms).toISOString() : null);

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  const raw = await req.text();
  let event: { type: string; timestamp: string; data: Record<string, any> };
  try {
    event = new Webhook(env("DODO_WEBHOOK_SECRET")).verify(raw, {
      "webhook-id": req.headers.get("webhook-id") || "",
      "webhook-signature": req.headers.get("webhook-signature") || "",
      "webhook-timestamp": req.headers.get("webhook-timestamp") || "",
    }) as typeof event;
  } catch {
    return new Response("bad signature", { status: 401 });
  }
  if (event.type === "payment.succeeded") return onLifetimePayment(event);
  if (event.type === "refund.succeeded" || event.type === "dispute.lost") return onLifetimeReversal(event);
  if (!event.type?.startsWith("subscription.")) return ok();
  const s = event.data;
  // The Dodo business also sells other brands' products and their events arrive here too:
  // only the Earpiece Pro products may change an Earpiece account.
  if (!PRO_PRODUCTS.includes(s.product_id)) return ok();

  const who = await whoFor(s);
  if (!who) {
    console.error("dodo-webhook: no user or email for", s.subscription_id);
    return ok(); // nothing to retry: Dodo would keep redelivering an event we can't place
  }

  const cur = await read(who, "event_at, lifetime");
  if (cur?.lifetime) return ok(); // Pro for life: an old plan's events don't change it
  if (cur?.event_at && Date.parse(cur.event_at) > Date.parse(event.timestamp)) return ok();

  const t = event.type;
  let row: Record<string, unknown>;
  if (["subscription.active", "subscription.renewed", "subscription.plan_changed", "subscription.unpaused", "subscription.updated"].includes(t) && s.status === "active") {
    row = { plan: "pro", status: "active", current_period_end: plus(s.next_billing_date, GRACE_MS) };
  } else if (t === "subscription.past_due") {
    row = { plan: "pro", status: "past_due", current_period_end: s.past_due_ends_at || plus(s.next_billing_date, GRACE_MS) };
  } else if (t === "subscription.cancelled") {
    row = { plan: "pro", status: "canceled", current_period_end: s.next_billing_date || s.cancelled_at || event.timestamp };
  } else if (["subscription.on_hold", "subscription.paused", "subscription.expired", "subscription.failed"].includes(t)) {
    row = { plan: "free", status: "canceled", current_period_end: event.timestamp };
  } else {
    return ok(); // e.g. update_payment_method, or an update that isn't an activation
  }

  return save(who, {
    ...row,
    provider: "dodo",
    provider_customer_id: s.customer?.customer_id || null,
    provider_subscription_id: s.subscription_id || null,
    event_at: event.timestamp,
  });
});
