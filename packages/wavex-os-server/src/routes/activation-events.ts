/** Product activation event emission.
 *
 *  POST /api/activation-events/emit
 *    Records a product funnel event to wavex_os.product_activation_events.
 *    For test_run_completed: checks for an existing user_signed_up within the
 *    prior 24h and, if found, also writes a user_activated event (idempotent
 *    via the unique index on company_id + user_id where event_type = 'user_activated').
 *
 *  Always best-effort: DB unavailability returns { ok: true, persisted: false }
 *  so callers (smoke script, activate route) never block on this side-effect. */

import { z } from "zod";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

// ─── mixpanel emit ─────────────────────────────────────────────────────────

async function emitMixpanelActivation(
  userId: string,
  companyId: string,
  ttvHours: number,
  cohortWeek: string,
): Promise<void> {
  const token = process.env.MIXPANEL_PROJECT_TOKEN;
  if (!token) return;
  const event = {
    event: "User Activated",
    properties: {
      token,
      distinct_id: userId,
      company_id: companyId,
      ttv_hours: ttvHours,
      cohort_week: cohortWeek,
      within_48h: ttvHours <= 48,
    },
  };
  const data = encodeURIComponent(Buffer.from(JSON.stringify(event)).toString("base64"));
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5_000);
  try {
    await fetch(`https://api.mixpanel.com/track?data=${data}`, {
      method: "GET",
      signal: ctrl.signal,
    });
  } catch {
    // best-effort; never block the activation path
  } finally {
    clearTimeout(t);
  }
}

// ─── schema ────────────────────────────────────────────────────────────────

const emitSchema = z.object({
  company_id: z.string().min(1),
  /** For CLI installs company_id and user_id are the same value. */
  user_id: z.string().min(1),
  event_type: z.enum([
    "user_signed_up",
    "repo_connected",
    "test_run_started",
    "test_run_completed",
    "user_activated",
  ]),
  /** ISO-8601 timestamp; defaults to now() on the server when omitted. */
  occurred_at: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).optional().default({}),
});

type EmitInput = z.infer<typeof emitSchema>;

// ─── DB helpers ────────────────────────────────────────────────────────────

function supabaseHeaders(key: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Prefer: "return=representation",
    apikey: key,
    Authorization: `Bearer ${key}`,
  };
}

interface EventRow {
  company_id: string;
  user_id: string;
  event_type: string;
  occurred_at: string;
  payload: Record<string, unknown>;
}

async function writeEvent(url: string, key: string, row: EventRow): Promise<{ id: string } | null> {
  const res = await fetch(`${url}/rest/v1/wavex_os.product_activation_events`, {
    method: "POST",
    headers: supabaseHeaders(key),
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    // 409 on user_activated is expected (unique index) — not an error.
    if (res.status !== 409) {
      console.error(`[activation-events] DB write failed (${row.event_type}): ${res.status} ${detail}`);
    }
    return null;
  }
  const [record] = (await res.json().catch(() => [])) as Array<{ id: string }>;
  return record ?? null;
}

/** Returns the signup event row if the user signed up within the last `windowHours`. */
async function findRecentSignup(
  url: string,
  key: string,
  company_id: string,
  user_id: string,
  windowHours: number,
): Promise<{ occurred_at: string } | null> {
  const cutoff = new Date(Date.now() - windowHours * 3_600_000).toISOString();
  const qs = new URLSearchParams({
    company_id: `eq.${company_id}`,
    user_id: `eq.${user_id}`,
    event_type: "eq.user_signed_up",
    occurred_at: `gte.${cutoff}`,
    order: "occurred_at.asc",
    limit: "1",
  });
  const res = await fetch(`${url}/rest/v1/wavex_os.product_activation_events?${qs}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!res.ok) return null;
  const rows = (await res.json().catch(() => [])) as Array<{ occurred_at: string }>;
  return rows[0] ?? null;
}

// ─── route ─────────────────────────────────────────────────────────────────

export function registerActivationEventsRoute(app: FastifyInstance): void {
  app.post("/api/activation-events/emit", async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = emitSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ ok: false, error: "validation failed", issues: parsed.error.issues });
    }
    const data = parsed.data as EmitInput;

    const supaUrl = process.env.SUPABASE_URL;
    const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supaUrl || !supaKey) {
      console.warn("[activation-events] Supabase not configured — event not persisted");
      return { ok: true, persisted: false, event_type: data.event_type };
    }

    const occurred_at = data.occurred_at ?? new Date().toISOString();
    const row: EventRow = {
      company_id: data.company_id,
      user_id: data.user_id,
      event_type: data.event_type,
      occurred_at,
      payload: data.payload as Record<string, unknown>,
    };

    const record = await writeEvent(supaUrl, supaKey, row);

    // When a test run completes, check if the user signed up within 24h and
    // derive a user_activated event if so (idempotent via unique index).
    let activatedRecord: { id: string } | null = null;
    if (data.event_type === "test_run_completed") {
      // 48h window aligns with TTV target of <= 48h (WAVAAAAAAAA-29)
      const signup = await findRecentSignup(supaUrl, supaKey, data.company_id, data.user_id, 48);
      if (signup) {
        const signedUpAt = new Date(signup.occurred_at).getTime();
        const ranAt = new Date(occurred_at).getTime();
        const hoursSinceSignup = Math.round((ranAt - signedUpAt) / 3_600_000 * 10) / 10;
        const cohortWeek = new Date(signup.occurred_at).toISOString().slice(0, 10);
        activatedRecord = await writeEvent(supaUrl, supaKey, {
          company_id: data.company_id,
          user_id: data.user_id,
          event_type: "user_activated",
          occurred_at,
          payload: {
            hours_since_signup: hoursSinceSignup,
            trigger_run_id: (data.payload as Record<string, unknown>).run_id ?? occurred_at,
          },
        });
        if (activatedRecord) {
          console.log(`[activation-events] user_activated: company=${data.company_id} hours=${hoursSinceSignup}`);
          await emitMixpanelActivation(data.user_id, data.company_id, hoursSinceSignup, cohortWeek);
        }
      }
    }

    return {
      ok: true,
      event_type: data.event_type,
      occurred_at,
      persisted: record !== null,
      event_id: record?.id ?? null,
      activated: activatedRecord !== null,
    };
  });
}
