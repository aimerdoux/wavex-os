/** Wizard telemetry event logging + metrics.
 *
 *  POST /api/wizard-events
 *    Writes a row to public.wizard_events. Accepts all 5 event types.
 *    Fire-and-forget from the browser; always returns { ok: true }.
 *
 *  GET /api/wizard-metrics
 *    Returns ttv_hours (median + p75), activation funnel counts, and
 *    weekly cohort table. Used by WizardMetricsPanel in MissionControl. */

import { z } from "zod";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

const bodySchema = z.object({
  userId: z.string().min(1),
  eventType: z.enum([
    "wizard_start",
    "wizard_step_complete",
    "wizard_abandon",
    "wizard_complete",
    "first_test_result",
  ]),
  step:     z.number().int().min(1).max(3).optional(),
  lastStep: z.number().int().optional(),
  resultId: z.string().optional(),
  status:   z.string().optional(),
  ts:       z.string().datetime().optional(),
});

type WizardEventBody = z.infer<typeof bodySchema>;

// ─── Supabase helpers ─────────────────────────────────────────────────────────

function supabaseConfig(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return { url, key };
}

async function writeWizardEvent(row: {
  user_id: string;
  event_type: string;
  step?: number;
  last_step?: number;
  result_id?: string;
  status?: string;
  created_at?: string;
}): Promise<{ id: string } | null> {
  const cfg = supabaseConfig();
  if (!cfg) {
    console.warn("[wizard-events] Supabase not configured — event not persisted");
    return null;
  }
  const res = await fetch(`${cfg.url}/rest/v1/wizard_events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Prefer": "return=representation",
      apikey: cfg.key,
      Authorization: `Bearer ${cfg.key}`,
    },
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error(`[wizard-events] DB write failed: ${res.status} ${detail}`);
    return null;
  }
  const records = (await res.json().catch(() => [])) as Array<{ id: string }>;
  return records[0] ?? null;
}

async function queryWizardMetrics(cfg: { url: string; key: string }): Promise<{
  ttv_hours: { median: number | null; p75: number | null };
  funnel: { start: number; step1: number; step2: number; step3: number; first_result: number };
  cohorts: Array<{ week: string; starts: number; completes: number; rate: number }>;
}> {
  const headers = { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` };

  // Fetch all wizard events — compute metrics in-process since PostgREST
  // doesn't expose percentile aggregates without an RPC function.
  const eventsRes = await fetch(
    `${cfg.url}/rest/v1/wizard_events?select=user_id,event_type,step,created_at&order=created_at.asc`,
    { headers },
  );
  if (!eventsRes.ok) {
    throw new Error(`Supabase wizard_events fetch failed: ${eventsRes.status}`);
  }
  const events = (await eventsRes.json()) as Array<{
    user_id: string; event_type: string; step: number | null; created_at: string;
  }>;

  // ── funnel counts ──────────────────────────────────────────────────────────
  const countByType = (type: string) =>
    new Set(events.filter((e) => e.event_type === type).map((e) => e.user_id)).size;
  const countStep = (s: number) =>
    new Set(
      events
        .filter((e) => e.event_type === "wizard_step_complete" && e.step === s)
        .map((e) => e.user_id),
    ).size;

  const funnel = {
    start:        countByType("wizard_start"),
    step1:        countStep(1),
    step2:        countStep(2),
    step3:        countStep(3),
    first_result: countByType("first_test_result"),
  };

  // ── ttv_hours ──────────────────────────────────────────────────────────────
  const startByUser: Record<string, number> = {};
  const resultByUser: Record<string, number> = {};
  for (const e of events) {
    const ts = new Date(e.created_at).getTime();
    if (e.event_type === "wizard_start" && !(e.user_id in startByUser)) {
      startByUser[e.user_id] = ts;
    }
    if (e.event_type === "first_test_result" && !(e.user_id in resultByUser)) {
      resultByUser[e.user_id] = ts;
    }
  }
  const ttvList: number[] = [];
  for (const [uid, startTs] of Object.entries(startByUser)) {
    if (resultByUser[uid]) {
      ttvList.push((resultByUser[uid] - startTs) / 3_600_000);
    }
  }
  ttvList.sort((a, b) => a - b);
  const percentile = (arr: number[], p: number): number | null => {
    if (arr.length === 0) return null;
    const idx = Math.ceil(p * arr.length) - 1;
    return Math.round(arr[Math.max(0, idx)] * 10) / 10;
  };

  // ── weekly cohorts ─────────────────────────────────────────────────────────
  const weekKey = (ts: string): string => {
    const d = new Date(ts);
    // ISO week Monday anchor
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() - d.getUTCDay() + (d.getUTCDay() === 0 ? -6 : 1));
    return d.toISOString().slice(0, 10);
  };
  const cohortStarts: Record<string, Set<string>> = {};
  const cohortCompletes: Record<string, Set<string>> = {};
  for (const e of events) {
    if (e.event_type === "wizard_start") {
      const wk = weekKey(e.created_at);
      (cohortStarts[wk] ??= new Set()).add(e.user_id);
    }
    if (e.event_type === "wizard_complete") {
      const wk = weekKey(e.created_at);
      (cohortCompletes[wk] ??= new Set()).add(e.user_id);
    }
  }
  const allWeeks = Array.from(
    new Set([...Object.keys(cohortStarts), ...Object.keys(cohortCompletes)]),
  ).sort().reverse().slice(0, 12);
  const cohorts = allWeeks.map((wk) => {
    const starts = cohortStarts[wk]?.size ?? 0;
    const completes = cohortCompletes[wk]?.size ?? 0;
    return {
      week: wk,
      starts,
      completes,
      rate: starts > 0 ? Math.round((completes / starts) * 1000) / 10 : 0,
    };
  });

  return {
    ttv_hours: { median: percentile(ttvList, 0.5), p75: percentile(ttvList, 0.75) },
    funnel,
    cohorts,
  };
}

// ─── routes ───────────────────────────────────────────────────────────────────

export function registerWizardEventsRoute(app: FastifyInstance): void {
  app.post("/api/wizard-events", async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ ok: false, error: "validation failed", issues: parsed.error.issues });
    }
    const { userId, eventType, step, lastStep, resultId, status, ts } = parsed.data as WizardEventBody;

    const record = await writeWizardEvent({
      user_id:    userId,
      event_type: eventType,
      step,
      last_step:  lastStep,
      result_id:  resultId,
      status,
      ...(ts ? { created_at: ts } : {}),
    });

    return reply.send({ ok: true, event_id: record?.id ?? null, persisted: record !== null });
  });

  app.get("/api/wizard-metrics", async (_req: FastifyRequest, reply: FastifyReply) => {
    const cfg = supabaseConfig();
    if (!cfg) {
      return reply.status(503).send({ ok: false, error: "Supabase not configured" });
    }
    try {
      const metrics = await queryWizardMetrics(cfg);
      return reply.send({ ok: true, ...metrics });
    } catch (e) {
      console.error("[wizard-events] metrics query failed:", e instanceof Error ? e.message : String(e));
      return reply.status(502).send({ ok: false, error: "metrics query failed" });
    }
  });
}
