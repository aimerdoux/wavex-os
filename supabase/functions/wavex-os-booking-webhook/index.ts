/**
 * Stripe webhook → booking_intents + public.bookings
 *
 * Handles Stripe events for one-time experience booking payments:
 *   - checkout.session.completed      → confirm intent, create bookings row,
 *                                        emit booking_confirmed Telegram event
 *   - checkout.session.expired        → revert pending_payment → pending so
 *                                        the intent becomes auto-cancel-eligible
 *
 * This handler only acts on sessions that have metadata.booking_intent_id set.
 * Sessions without that key (e.g. subscription checkouts) are silently ignored.
 *
 * Deploy:
 *   supabase functions deploy wavex-os-booking-webhook --no-verify-jwt
 *
 * Env vars:
 *   STRIPE_SECRET_KEY_TEST_ENV         — preferred; falls back to STRIPE_SECRET_KEY
 *   WAVEX_OS_BOOKING_WEBHOOK_SECRET    — Stripe signing secret for THIS endpoint
 *   SUPABASE_URL                       — auto-injected
 *   SUPABASE_SERVICE_ROLE_KEY          — auto-injected
 *
 * Stripe dashboard configuration:
 *   Endpoint URL: https://<project>.supabase.co/functions/v1/wavex-os-booking-webhook
 *   Events: checkout.session.completed, checkout.session.expired
 */
// @ts-expect-error — Deno-style import resolved at runtime
import Stripe from "https://esm.sh/stripe@17.5.0?target=denonext";
// @ts-expect-error — Deno-style import
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.46.1";

const stripeKey =
  Deno.env.get("STRIPE_SECRET_KEY_TEST_ENV") ?? Deno.env.get("STRIPE_SECRET_KEY")!;
const webhookSecret = Deno.env.get("WAVEX_OS_BOOKING_WEBHOOK_SECRET")!;
const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const stripe = new Stripe(stripeKey, {
  apiVersion: "2025-09-30.clover" as Stripe.StripeConfig["apiVersion"],
  httpClient: Stripe.createFetchHttpClient(),
});
const cryptoProvider = Stripe.createSubtleCryptoProvider();

const sb = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function handleCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
  const bookingIntentId = session.metadata?.booking_intent_id;
  if (!bookingIntentId) return; // Not a booking session — skip.

  const paymentIntentId =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : session.payment_intent?.id ?? null;

  // Atomically confirm the intent and create the public.bookings row.
  const { data: confirmData, error: confirmErr } = await sb.rpc(
    "wavex_os_confirm_booking_intent",
    {
      p_intent_id: bookingIntentId,
      p_stripe_checkout_session_id: session.id,
      p_stripe_payment_intent_id: paymentIntentId,
    },
  );
  if (confirmErr) {
    console.error("wavex_os_confirm_booking_intent failed", confirmErr);
    throw confirmErr;
  }

  const result = confirmData as { ok?: boolean; reason?: string; booking_id?: string; idempotent?: boolean } | null;
  if (!result?.ok) {
    console.error("confirm_booking_intent returned not-ok", result);
    return;
  }
  if (result.idempotent) {
    console.info(`booking_intent ${bookingIntentId} already confirmed (idempotent replay)`);
    return;
  }

  // Emit booking_confirmed Telegram event.
  const userId = session.client_reference_id ?? session.metadata?.supabase_user_id ?? null;
  if (userId && result.booking_id) {
    const { error: tgErr } = await sb.rpc("wavex_os_emit_booking_confirmed_for_user", {
      p_booking_id: result.booking_id,
      p_user_id: userId,
    });
    if (tgErr) {
      // Non-fatal: booking is confirmed; telegram notification failure should not
      // roll back the payment acknowledgment.
      console.error(
        `emit booking_confirmed failed booking=${result.booking_id}`,
        tgErr,
      );
    }
  }

  console.info(
    `booking confirmed: intent=${bookingIntentId} booking=${result.booking_id} session=${session.id}`,
  );
}

async function handleCheckoutExpired(session: Stripe.Checkout.Session): Promise<void> {
  const bookingIntentId = session.metadata?.booking_intent_id;
  if (!bookingIntentId) return;

  // Revert to pending so the 30-min auto-cancel clock can fire.
  const { error } = await sb
    .schema("wavex_os")
    .from("booking_intents")
    .update({ status: "pending", updated_at: new Date().toISOString() })
    .eq("id", bookingIntentId)
    .eq("status", "pending_payment"); // Only revert if still in the redirect state.

  if (error) {
    console.error(`revert pending_payment failed intent=${bookingIntentId}`, error);
  } else {
    console.info(`checkout expired → reverted to pending intent=${bookingIntentId}`);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  const sig = req.headers.get("stripe-signature");
  if (!sig) return new Response("Missing signature", { status: 400 });

  const body = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, sig, webhookSecret, undefined, cryptoProvider);
  } catch (err) {
    console.error("signature verification failed", err);
    return new Response(`Webhook Error: ${(err as Error).message}`, { status: 400 });
  }

  // Idempotency guard reusing the existing stripe_webhook_events table.
  const { data: idemData, error: idemErr } = await sb.rpc("wavex_os_record_webhook_event", {
    p_id: event.id,
    p_type: event.type,
    p_api_version: event.api_version,
    p_payload: event as unknown as Record<string, unknown>,
  });
  if (idemErr) {
    console.error("idempotency insert failed", idemErr);
    return new Response("Internal error", { status: 500 });
  }
  const isDup = Array.isArray(idemData) ? idemData[0]?.is_duplicate : idemData?.is_duplicate;
  if (isDup) {
    return new Response(JSON.stringify({ ok: true, duplicate: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
        break;
      case "checkout.session.expired":
        await handleCheckoutExpired(event.data.object as Stripe.Checkout.Session);
        break;
      default:
        // Unhandled event type — idempotency row recorded, ack to Stripe.
        break;
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    await sb.rpc("wavex_os_mark_webhook_event_error", {
      p_id: event.id,
      p_error: (err as Error).message,
    });
    console.error("event handler failed", err);
    return new Response("Handler error", { status: 500 });
  }
});
