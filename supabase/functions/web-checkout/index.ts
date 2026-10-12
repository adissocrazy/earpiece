// Earpiece Pro checkout from earpiece.dev/pricing, no account needed: { plan: "month" | "year" |
// "lifetime" } returns a Dodo Payments checkout URL. Monthly starts with a 3-day trial (card taken up
// front). Dodo collects the email; dodo-webhook attaches the plan to the account with that email, or
// keeps it until that email first signs in to the app. Deployed with verify_jwt off: it's public.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const env = (name: string) => (Deno.env.get(name) || "").trim().replace(/^["']|["']$/g, "");
const DODO = env("DODO_ENV").toLowerCase() === "live" ? "https://live.dodopayments.com" : "https://test.dodopayments.com";
const API_KEY = env("DODO_API_KEY").replace(/^Bearer\s+/i, "");
// Same products as billing/index.ts.
const LIVE = DODO.includes("live.");
const PRODUCTS: Record<string, string> = {
  month: env("DODO_PRODUCT_MONTH") || (LIVE ? "pdt_0Nox7nghhsoBXPYpVE3cy" : "pdt_0NowseZLebYL9xfZ7e6RC"),
  year: env("DODO_PRODUCT_YEAR") || (LIVE ? "pdt_0Nox7nhuXf5QMA425MfjH" : "pdt_0NowsebJJIuoHy8MRWTIt"),
  lifetime: env("DODO_PRODUCT_LIFETIME") || (LIVE ? "pdt_0NpZ2e9UXUDouyVlIDrP4" : ""),
};
const TRIAL_DAYS = 3;
const RETURN_URL = "https://earpiece.dev/pricing?pro=thanks";
const ORIGINS = new Set(["https://earpiece.dev", "https://www.earpiece.dev"]);
const allowed = (o: string) => ORIGINS.has(o) || /^http:\/\/localhost:\d+$/.test(o);

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin") || "";
  const cors: Record<string, string> = allowed(origin)
    ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type", Vary: "Origin" }
    : {};
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
  if (req.method === "OPTIONS") return new Response(null, { status: allowed(origin) ? 204 : 403, headers: cors });
  if (req.method !== "POST") return json(405, { error: "POST only" });
  if (!allowed(origin)) return json(403, { error: "checkout starts on earpiece.dev" });

  const { plan } = (await req.json().catch(() => ({}))) as { plan?: string };
  const product_id = Object.hasOwn(PRODUCTS, String(plan)) ? PRODUCTS[String(plan)] : "";
  if (!product_id) return json(400, { error: "plan must be month, year or lifetime" });

  try {
    const res = await fetch(`${DODO}/checkouts`, {
      method: "POST",
      signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        product_cart: [{ product_id, quantity: 1 }],
        metadata: { app: "earpiece", source: "web", plan: String(plan) },
        return_url: RETURN_URL,
        customization: { theme: "dark" },
        feature_flags: { allow_discount_code: true },
        ...(plan === "month" ? { subscription_data: { trial_period_days: TRIAL_DAYS } } : {}),
      }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.checkout_url) throw new Error(`dodo /checkouts HTTP ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
    return json(200, { url: j.checkout_url });
  } catch (e) {
    console.error(String(e));
    return json(502, { error: "Checkout is unavailable right now. Try again in a minute." });
  }
});
