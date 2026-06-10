/**
 * POST /functions/v1/create-booking-checkout-session
 *
 * Body: { booking_intent_id: string, success_url: string, cancel_url: string }
 * Auth: Supabase JWT in Authorization header (user must own the intent or be service_role).
 *
 * Returns: { url: string } — Stripe Checkout session URL.
 *
 * Flow:
 *   1. Verify JWT and resolve user_id.
 *   2. Load the booking_intent row (verify it belongs to the caller).
 *   3. Create a Stripe Checkout session (mode: payment, one-time).
 *   4. Call wavex_os_set_booking_intent_pending_payment() to freeze the
 *      30-min auto-cancel clock.
 *   5. Return the Stripe URL.
 *
 * Deploy:
 *   supabase functions deploy create-booking-checkout-session
 *
 * Env vars:
 *   STRIPE_SECRET_KEY_TEST_ENV  — preferred (test mode); falls back to STRIPE_SECRET_KEY
 *   SUPABASE_URL                — auto-injected
 *   SUPABASE_SERVICE_ROLE_KEY   — auto-injected
 *   SUPABASE_ANON_KEY           — auto-injected
 */
// @ts-expect-error — Deno-style import resolved at runtime
import Stripe from "https://esm.sh/stripe@17.5.0?target=denonext";
// @ts-expect-error — Deno-style import
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.46.1";

const stripeKey =
  Deno.env.get("STRIPE_SECRET_KEY_TEST_ENV") ?? Deno.env.get("STRIPE_SECRET_KEY")!;
const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

const stripe = new Stripe(stripeKey, {
  apiVersion: "2025-09-30.clover" as Stripe.StripeConfig["apiVersion"],
  httpClient: Stripe.createFetchHttpClient(),
});

const sb = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
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
  const email = userData.user.email ?? undefined;

  let body: { booking_intent_id?: string; success_url?: string; cancel_url?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const { booking_intent_id, success_url, cancel_url } = body;
  if (!booking_intent_id || !success_url || !cancel_url) {
    return json({ error: "missing_fields" }, 400);
  }

  // For wallet-auth users, user.email is a proxy address (@wallet.wavex.app).
  // real_email in user_metadata is the actual billing address — use it for Stripe
  // customer lookup so wallet sessions all resolve to the same customer record.
  const realEmail =
    (userData.user.user_metadata?.real_email as string | undefined) ?? email;

  // Load the booking intent via RPC (wavex_os schema is not in PostgREST exposed list;
  // all wavex_os table access goes through public-schema security-definer RPCs).
  const { data: intent, error: intentErr } = await sb.rpc("wavex_os_get_booking_intent", {
    p_intent_id: booking_intent_id,
  });

  if (intentErr || !intent) return json({ error: "intent_not_found" }, 404);

  // Ownership check. Linked intents: user_id must match. Anon intents: caller's
  // verified auth email must match the email stored at intent creation (WAV-52).
  if (intent.user_id) {
    if (intent.user_id !== userId) return json({ error: "forbidden" }, 403);
  } else if (intent.user_email) {
    if (!email || intent.user_email !== email.toLowerCase()) return json({ error: "forbidden" }, 403);
  }
  if (intent.status === "confirmed") return json({ error: "already_confirmed" }, 409);
  if (intent.status === "cancelled") return json({ error: "intent_cancelled" }, 410);

  // If already in pending_payment with an existing session, reuse it.
  if (intent.status === "pending_payment" && intent.stripe_checkout_session_id) {
    const existing = await stripe.checkout.sessions.retrieve(intent.stripe_checkout_session_id);
    if (existing.status === "open" && existing.url) {
      return json({ url: existing.url });
    }
    // Session expired or completed — fall through to create a fresh one.
  }

  // Look up or create Stripe customer keyed by supabase_user_id (most reliable),
  // falling back to realEmail. Using the metadata search avoids creating duplicate
  // customers for wallet-auth users who have a proxy auth email.
  const searchResult = await stripe.customers.search({
    query: `metadata['supabase_user_id']:'${userId}'`,
    limit: 1,
  });
  let customerId = searchResult.data[0]?.id;
  if (!customerId) {
    const customers = await stripe.customers.list({ email: realEmail ?? undefined, limit: 1 });
    customerId = customers.data[0]?.id;
  }
  if (!customerId) {
    const newCustomer = await stripe.customers.create({
      email: realEmail ?? undefined,
      metadata: { supabase_user_id: userId },
    });
    customerId = newCustomer.id;
  }

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "payment",
    line_items: [
      {
        price_data: {
          currency: intent.currency ?? "usd",
          unit_amount: intent.experience_price_cents,
          product_data: {
            name: intent.experience_name ?? "Experience Booking",
          },
        },
        quantity: 1,
      },
    ],
    metadata: {
      booking_intent_id,
      supabase_user_id: userId,
      experience_id: intent.experience_id ?? "",
      experience_price_cents: String(intent.experience_price_cents ?? ""),
      intent_created_at: intent.created_at ?? "",
    },
    client_reference_id: userId,
    success_url: success_url + (success_url.includes("?") ? "&" : "?") + "session_id={CHECKOUT_SESSION_ID}",
    cancel_url,
  });

  // Freeze the 30-min auto-cancel clock: pending → pending_payment.
  const { data: rpcData, error: rpcErr } = await sb.rpc(
    "wavex_os_set_booking_intent_pending_payment",
    {
      p_intent_id: booking_intent_id,
      p_stripe_checkout_session_id: session.id,
    },
  );
  if (rpcErr) {
    console.error("wavex_os_set_booking_intent_pending_payment failed", rpcErr);
    // Non-fatal: Stripe session is created; caller can still redirect.
    // Log but don't block the response.
  }
  const rpcResult = rpcData as { ok?: boolean; reason?: string } | null;
  if (rpcResult && !rpcResult.ok) {
    console.warn("booking intent status transition failed", rpcResult.reason);
  }

  const mpToken = Deno.env.get("MIXPANEL_PROJECT_TOKEN");
  if (mpToken) {
    await fetch("https://api.mixpanel.com/track", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/plain" },
      body: JSON.stringify([{
        event: "Payment Started",
        properties: {
          token: mpToken,
          distinct_id: userId,
          intent_id: booking_intent_id,
          experience_id: intent.experience_id ?? null,
          price_cents: intent.experience_price_cents ?? null,
          stripe_session_id: session.id,
          time: Math.floor(Date.now() / 1000),
        },
      }]),
    }).catch((err: unknown) => console.error("mixpanel track Payment Started failed", err));
  }

  return json({ url: session.url });
});
