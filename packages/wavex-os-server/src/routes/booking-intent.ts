/** POST /api/booking/intent — create a booking_intent row via service_role RPC (WAV-70)
 *
 *  Body: { experience_id, experience_name, experience_price_cents, currency?, booking_time? }
 *  Optional: user_id read from X-Wavex-User-Id header (anonymous booking allowed)
 *  Returns: { booking_intent_id }
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

interface BookingIntentBody {
  experience_id: string;
  experience_name: string;
  experience_price_cents: number;
  currency?: string;
  booking_time?: string;
}

function supabaseConfig(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return { url, key };
}

export function registerBookingIntentRoute(app: FastifyInstance): void {
  app.post(
    "/api/booking/intent",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const cfg = supabaseConfig();
      if (!cfg) {
        return reply.code(503).send({ error: "supabase_not_configured" });
      }

      const body = req.body as BookingIntentBody;
      const { experience_id, experience_name, experience_price_cents, currency, booking_time } =
        body ?? {};

      if (!experience_id || !experience_name || !experience_price_cents) {
        return reply
          .code(400)
          .send({ error: "missing_fields", required: ["experience_id", "experience_name", "experience_price_cents"] });
      }

      const user_id = (req.headers["x-wavex-user-id"] as string | undefined) ?? null;

      const rpcBody: Record<string, unknown> = {
        p_telegram_user_id: "",
        p_experience_id: experience_id,
        p_experience_name: experience_name,
        p_experience_price_cents: experience_price_cents,
        p_currency: currency ?? "usd",
        p_booking_time: booking_time ?? null,
        p_user_id: user_id,
      };

      const res = await fetch(`${cfg.url}/rest/v1/rpc/wavex_os_create_booking_intent`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: cfg.key,
          Authorization: `Bearer ${cfg.key}`,
        },
        body: JSON.stringify(rpcBody),
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        console.error(`[booking-intent] RPC failed: ${res.status} ${detail}`);
        return reply.code(502).send({ error: "booking_intent_rpc_failed", status: res.status });
      }

      const data = (await res.json()) as { id?: string } | null;
      const booking_intent_id = data?.id;
      if (!booking_intent_id) {
        return reply.code(502).send({ error: "booking_intent_no_id" });
      }

      return reply.send({ booking_intent_id });
    },
  );
}
