/** Professional re-engagement metrics + manual trigger (WAVAAAAA-63).
 *
 *  GET  /api/expansion/reengagement/metrics
 *    Returns the current re-activation funnel: nudges_sent (real sends),
 *    nudges_dry_run, reactivated (booking_confirmed within 48h of a real
 *    send), and reactivation_rate. Used by the CRO / EXPANSION dashboard
 *    to grade against the >=20% success metric named in the issue.
 *
 *  POST /api/expansion/reengagement/run
 *    Board-only manual trigger that fires runProfessionalReengagementJob
 *    once outside the hourly tick. Useful for end-to-end smoke and for
 *    flipping out of dry-run when CRO / EXPANSION signs off on copy. */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { assertBoard, AuthError } from "@wavex-os/auth-shim";
import { runProfessionalReengagementJob } from "../jobs/professional-reengagement.js";

interface MetricsRow {
  nudges_sent: number;
  nudges_dry_run: number;
  reactivated: number;
  reactivation_rate: number;
  mean_post_nudge_booking_value: number | null;
  total_post_nudge_gmv: number | null;
  pro_aov_baseline_90d: number | null;
  aov_delta_pct: number | null;
}

async function fetchMetrics(windowHours: number): Promise<MetricsRow | null> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const res = await fetch(
    `${url}/rest/v1/rpc/wavex_os_professional_reengagement_metrics`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ p_window_hours: windowHours }),
    },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error(`[reengagement] metrics RPC failed: ${res.status} ${detail}`);
    return null;
  }
  const rows = (await res.json().catch(() => [])) as MetricsRow[];
  return rows[0] ?? null;
}

function authReq(req: FastifyRequest) {
  return { method: req.method, headers: req.headers as Record<string, string> };
}

export function registerReengagementRoutes(app: FastifyInstance): void {
  app.get(
    "/api/expansion/reengagement/metrics",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const windowParam = (req.query as { window_hours?: string } | undefined)?.window_hours;
      const windowHours = windowParam ? Number.parseInt(windowParam, 10) : 48;
      if (!Number.isFinite(windowHours) || windowHours <= 0) {
        return reply.status(400).send({ ok: false, error: "window_hours must be a positive integer" });
      }
      const row = await fetchMetrics(windowHours);
      if (!row) {
        return reply
          .status(503)
          .send({ ok: false, error: "metrics unavailable (Supabase not configured or RPC failed)" });
      }
      return {
        ok: true,
        window_hours: windowHours,
        nudges_sent: row.nudges_sent,
        nudges_dry_run: row.nudges_dry_run,
        reactivated: row.reactivated,
        reactivation_rate: row.reactivation_rate,
        target_rate: 0.20,
        mean_post_nudge_booking_value: row.mean_post_nudge_booking_value,
        total_post_nudge_gmv: row.total_post_nudge_gmv,
        pro_aov_baseline_90d: row.pro_aov_baseline_90d,
        aov_delta_pct: row.aov_delta_pct,
      };
    },
  );

  app.post(
    "/api/expansion/reengagement/run",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ar = authReq(req);
      try {
        assertBoard(ar);
      } catch (e) {
        if (e instanceof AuthError) return reply.status(e.statusCode).send({ error: e.message });
        throw e;
      }
      try {
        const result = await runProfessionalReengagementJob();
        return { ok: true, ...result };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return reply.status(500).send({ ok: false, error: msg });
      }
    },
  );
}
