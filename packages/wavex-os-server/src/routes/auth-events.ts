/** Auth event logging with UTM attribution + Resend audience sync.
 *
 *  POST /api/auth-events
 *    Writes a row to wavex_os.auth_events and, when utm_campaign is present
 *    and event_type is signup_confirmed, adds the user as a contact in the
 *    configured Resend audience (RESEND_API_KEY + RESEND_AUDIENCE_ID).
 *
 *  Idempotency: the DB unique index on (user_id, utm_campaign) where
 *  event_type = 'signup_confirmed' silently absorbs duplicate submissions.
 *
 *  Auth: no hard gate — this endpoint is called from the browser immediately
 *  after Supabase issues a session; the data is attribution metrics only. */

import { z } from "zod";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

const bodySchema = z.object({
  userId: z.string().min(1),
  email: z.string().email().optional(),
  eventType: z.string().min(1).default("signup_confirmed"),
  utmCampaign: z.string().optional(),
  utmSource: z.string().optional(),
  ref: z.string().optional(),
});

type AuthEventBody = z.infer<typeof bodySchema>;

// ─── Supabase write ────────────────────────────────────────────────────────
// Uses wavex_os_record_auth_event RPC (public schema SECURITY DEFINER) because
// the wavex_os schema is intentionally not exposed via PostgREST.

async function writeAuthEvent(row: {
  user_id: string;
  email?: string;
  event_type: string;
  utm_campaign?: string;
  utm_source?: string;
  ref?: string;
  resend_fired: boolean;
}): Promise<{ id: string } | null> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.warn("[auth-events] Supabase not configured — event not persisted");
    return null;
  }
  const res = await fetch(`${url}/rest/v1/rpc/wavex_os_record_auth_event`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      p_user_id:      row.user_id,
      p_email:        row.email ?? null,
      p_event_type:   row.event_type,
      p_utm_campaign: row.utm_campaign ?? null,
      p_utm_source:   row.utm_source ?? null,
      p_ref:          row.ref ?? null,
      p_resend_fired: row.resend_fired,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error(`[auth-events] DB write failed: ${res.status} ${detail}`);
    return null;
  }
  const id = (await res.json().catch(() => null)) as string | null;
  return id ? { id } : null;
}

// ─── Resend attribution ────────────────────────────────────────────────────

async function addResendContact(params: {
  email: string;
  utmCampaign: string;
}): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  const audienceId = process.env.RESEND_AUDIENCE_ID;
  if (!apiKey || !audienceId) {
    console.warn("[auth-events] RESEND_API_KEY or RESEND_AUDIENCE_ID not set — Resend sync skipped");
    return false;
  }

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10_000);
    const res = await fetch(`https://api.resend.com/audiences/${encodeURIComponent(audienceId)}/contacts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        email: params.email,
        unsubscribed: false,
        data: { utm_campaign: params.utmCampaign },
      }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`[auth-events] Resend contact sync failed: ${res.status} ${detail}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error(`[auth-events] Resend contact sync error: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

// ─── route ─────────────────────────────────────────────────────────────────

export function registerAuthEventsRoute(app: FastifyInstance): void {
  app.post("/api/auth-events", async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ ok: false, error: "validation failed", issues: parsed.error.issues });
    }
    const { userId, email, eventType, utmCampaign, utmSource, ref } = parsed.data as AuthEventBody;

    // Fire Resend contact sync for signup_confirmed + utm_campaign (best-effort).
    let resendFired = false;
    if (eventType === "signup_confirmed" && utmCampaign && email) {
      resendFired = await addResendContact({ email, utmCampaign });
    }

    const record = await writeAuthEvent({
      user_id: userId,
      email,
      event_type: eventType,
      utm_campaign: utmCampaign,
      utm_source: utmSource,
      ref,
      resend_fired: resendFired,
    });

    return reply.send({
      ok: true,
      event_id: record?.id ?? null,
      resend_fired: resendFired,
      persisted: record !== null,
    });
  });

  /** Measurement: count signup_confirmed events for a given utm_campaign in the
   *  last 7 days. Used to verify the smoke-test-guide-may2026 campaign gate. */
  app.get<{ Querystring: { utm_campaign?: string } }>(
    "/api/auth-events/count",
    async (req: FastifyRequest<{ Querystring: { utm_campaign?: string } }>, reply: FastifyReply) => {
      const campaign = req.query.utm_campaign;
      if (!campaign) {
        return reply.status(400).send({ ok: false, error: "utm_campaign query param required" });
      }

      const url = process.env.SUPABASE_URL;
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!url || !key) {
        return reply.status(503).send({ ok: false, error: "Supabase not configured" });
      }

      const res = await fetch(`${url}/rest/v1/rpc/wavex_os_count_campaign_signups`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: key,
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({ p_utm_campaign: campaign }),
      });
      if (!res.ok) {
        return reply.status(502).send({ ok: false, error: `Supabase ${res.status}` });
      }
      const distinct = (await res.json().catch(() => 0)) as number;
      return reply.send({ ok: true, utm_campaign: campaign, new_auth_users: distinct });
    },
  );
}
