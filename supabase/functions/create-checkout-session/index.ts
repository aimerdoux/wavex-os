/**
 * POST /functions/v1/create-checkout-session
 *
 * Body: { priceId: string, tier: "founder"|"growth"|"custom", successUrl: string, cancelUrl: string }
 * Auth: Supabase JWT in Authorization header.
 *
 * Returns: { url: string } — Stripe Checkout session URL to redirect the user to.
 *
 * Validates that the authenticated user does not already have an active or
 * trialing subscription. If they do, returns 409 with a Customer Portal URL
 * instead.
 */
// @ts-expect-error — Deno-style import resolved at runtime
import Stripe from "https://esm.sh/stripe@17.5.0?target=denonext";
// @ts-expect-error — Deno-style import
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.46.1";

// Read the TEST-env-prefixed key first to keep wavex-os checkout flows isolated
// from wavexcard's live billing. STRIPE_SECRET_KEY in this project resolves to
// wavexcard's prod key — using it here would create real-money charges instead
// of test-mode flows.
const stripeKey = Deno.env.get("STRIPE_SECRET_KEY_TEST_ENV") ?? Deno.env.get("STRIPE_SECRET_KEY")!;
const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

const stripe = new Stripe(stripeKey, {
  apiVersion: "2025-09-30.clover" as Stripe.StripeConfig["apiVersion"],
  httpClient: Stripe.createFetchHttpClient(),
});

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "unauthorized" }, 401);

  // Verify the JWT by hitting auth.getUser as the caller.
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user) return json({ error: "unauthorized" }, 401);
  const userId = userData.user.id;
  const email = userData.user.email;

  let body: { priceId?: string; tier?: string; successUrl?: string; cancelUrl?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const { priceId, tier, successUrl, cancelUrl } = body;
  if (!priceId || !tier || !successUrl || !cancelUrl) {
    return json({ error: "missing_fields" }, 400);
  }
  if (!["founder", "growth", "custom"].includes(tier)) {
    return json({ error: "invalid_tier" }, 400);
  }

  // Block double-subscribing.
  const sb = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: existing } = await sb
    .schema("wavex_os")
    .from("subscriptions")
    .select("stripe_customer_id, status")
    .eq("user_id", userId)
    .in("status", ["trialing", "active", "past_due"])
    .maybeSingle();

  if (existing) {
    // Issue a Customer Portal link instead.
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: (existing as { stripe_customer_id: string }).stripe_customer_id,
      return_url: successUrl,
    });
    return json({ url: portalSession.url, existing: true }, 409);
  }

  // For wallet-auth users, user.email is a proxy address (@wallet.wavex.app).
  // real_email in user_metadata is the actual billing address.
  const realEmail =
    (userData.user.user_metadata?.real_email as string | undefined) ?? email ?? undefined;

  // Look up or create Stripe customer keyed by supabase_user_id (most reliable).
  // Falls back to realEmail so wallet-auth users always resolve to the same customer.
  const searchResult = await stripe.customers.search({
    query: `metadata['supabase_user_id']:'${userId}'`,
    limit: 1,
  });
  let customerId = searchResult.data[0]?.id;
  if (!customerId) {
    const customers = await stripe.customers.list({ email: realEmail, limit: 1 });
    customerId = customers.data[0]?.id;
  }
  if (!customerId) {
    const created = await stripe.customers.create({
      email: realEmail,
      metadata: { supabase_user_id: userId },
    });
    customerId = created.id;
  }

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: userId,
    metadata: { user_id: userId, tier },
    subscription_data: {
      trial_period_days: 14,
      metadata: { supabase_user_id: userId, tier },
    },
    allow_promotion_codes: true,
  });

  return json({ url: session.url });
});
