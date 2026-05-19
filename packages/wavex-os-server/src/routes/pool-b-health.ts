/** Pool B Health + Install Funnel routes.
 *
 *  Five endpoints that the Mission Control "Pool B Health" widget hits
 *  to surface auto-sync observability — chip-health, Mac uptime, and the
 *  pairing/install funnel. See packages/wavex-os-server/src/mission-control/
 *  pool-b-health.ts for the underlying queries.
 *
 *  Auth: board-only. These reveal cost data and active customer activity
 *  per device — operator-tier visibility, never customer-tier.
 *
 *  `?fresh=1` on any endpoint bypasses the 30s cache (handy when QA'ing
 *  a live Mac that just came online). */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { assertBoard, AuthError } from "@wavex-os/auth-shim";
import {
  recentPoolBInferences,
  devicesWithLastInference,
  pendingPairings,
  dailyPoolBSpend,
  installFunnelSummary,
  operatorQuotaStatus,
} from "../mission-control/pool-b-health.js";

function authReq(req: FastifyRequest) {
  return { method: req.method, headers: req.headers as Record<string, string> };
}

function isFresh(req: FastifyRequest): boolean {
  return (req.query as { fresh?: string } | undefined)?.fresh === "1";
}

export function registerPoolBHealthRoutes(app: FastifyInstance): void {
  // Last N Pool B inferences (default 20). Drives the "what's the Mac
  // currently serving?" table at the top of the widget.
  app.get("/api/pool-b-health/recent", async (req, reply) => {
    const ar = authReq(req);
    try { assertBoard(ar); } catch (e) {
      if (e instanceof AuthError) return reply.status(e.statusCode).send({ error: e.message });
      throw e;
    }
    const limitRaw = (req.query as { limit?: string } | undefined)?.limit;
    const limit = Math.min(Math.max(parseInt(limitRaw ?? "20", 10) || 20, 1), 200);
    const rows = await recentPoolBInferences(limit, isFresh(req));
    return { ok: true, rows };
  });

  // Devices + last_inference_at. The "is the Mac online?" answer:
  // is_online = last_inference within 5 minutes.
  app.get("/api/pool-b-health/devices", async (req, reply) => {
    const ar = authReq(req);
    try { assertBoard(ar); } catch (e) {
      if (e instanceof AuthError) return reply.status(e.statusCode).send({ error: e.message });
      throw e;
    }
    const rows = await devicesWithLastInference(isFresh(req));
    return { ok: true, rows };
  });

  // Pairings not yet expired. Surfaces customers in the middle of
  // `wavex-os login`, useful when QAing the install path.
  app.get("/api/pool-b-health/pairings", async (req, reply) => {
    const ar = authReq(req);
    try { assertBoard(ar); } catch (e) {
      if (e instanceof AuthError) return reply.status(e.statusCode).send({ error: e.message });
      throw e;
    }
    const rows = await pendingPairings(isFresh(req));
    return { ok: true, rows };
  });

  // Daily Pool B spend grouped by subscription, last 14 days by default.
  app.get("/api/pool-b-health/spend", async (req, reply) => {
    const ar = authReq(req);
    try { assertBoard(ar); } catch (e) {
      if (e instanceof AuthError) return reply.status(e.statusCode).send({ error: e.message });
      throw e;
    }
    const daysRaw = (req.query as { days?: string } | undefined)?.days;
    const days = Math.min(Math.max(parseInt(daysRaw ?? "14", 10) || 14, 1), 90);
    const rows = await dailyPoolBSpend(days, isFresh(req));
    return { ok: true, rows };
  });

  // Install/pairing funnel summary — the "are users following the
  // right path?" headline numbers. One blob, all 24h-windowed.
  app.get("/api/pool-b-health/funnel", async (req, reply) => {
    const ar = authReq(req);
    try { assertBoard(ar); } catch (e) {
      if (e instanceof AuthError) return reply.status(e.statusCode).send({ error: e.message });
      throw e;
    }
    const summary = await installFunnelSummary(isFresh(req));
    return { ok: true, summary };
  });

  // Operator-side Pool B usage roll-up — feeds the life bar at the top
  // of the Pool B Health widget. Tokens + cost over 24h / 7d / 30d
  // windows. Drives the "am I about to blow my Claude Max quota?"
  // glance check the operator does before triggering big customer flows.
  app.get("/api/pool-b-health/operator-quota", async (req, reply) => {
    const ar = authReq(req);
    try { assertBoard(ar); } catch (e) {
      if (e instanceof AuthError) return reply.status(e.statusCode).send({ error: e.message });
      throw e;
    }
    const status = await operatorQuotaStatus(isFresh(req));
    return { ok: true, status };
  });
}
