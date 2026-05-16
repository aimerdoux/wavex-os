/** Mission Control HTTP API — activity query + live SSE stream + scope tree.
 *
 *  Auth: assertBoard for the operator-level GET; assertCompanyAccess on
 *  every per-company endpoint (matches the existing observability routes).
 *
 *  Live stream: Server-Sent Events. SSE is the lightest-weight option that
 *  works inside the plugin worker's `ctx.http.fetch` model (no extra deps,
 *  no Fastify websocket plugin) and the spec explicitly accepts "SSE or
 *  WebSocket". Clients connect to `GET /api/mission-control/:companyId/stream`
 *  and receive `event: mc-event\ndata: <ActivityEvent JSON>\n\n` frames as
 *  the wavex-side runners log new events via `logMissionControlActivity()`. */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { assertBoard, assertCompanyAccess, AuthError } from "@wavex-os/auth-shim";
import { runMigrations } from "@wavex-os/db";
import type { ActivityEventKind } from "@wavex-os/shared/types/mission-control";
import {
  queryMissionControlEvents,
  type QueryMissionControlEventsInput,
} from "../mission-control/activity-log.js";
import { subscribeMissionControlEvents } from "../mission-control/activity-bus.js";
import { getScopeTreeCached } from "../mission-control/scope-tree-cache.js";

let bootstrapped = false;
async function ensureBootstrap(): Promise<void> {
  if (bootstrapped) return;
  await runMigrations();
  bootstrapped = true;
}

function authReq(req: FastifyRequest) {
  return { method: req.method, headers: req.headers as Record<string, string> };
}

const ALL_KINDS: ReadonlySet<ActivityEventKind> = new Set<ActivityEventKind>([
  "task_originated",
  "task_assigned",
  "task_accepted",
  "task_delegated",
  "task_awaiting_review",
  "task_approved",
  "task_rejected",
  "task_completed",
  "task_failed",
  "task_cancelled",
  "deliverable_produced",
  "deliverable_revised",
  "deliverable_approved",
  "deliverable_published",
  "node_paused",
  "node_resumed",
  "node_corrected",
  "node_flagged",
  "node_promoted",
  "node_added",
  "node_archived",
  "kpi_measurement_taken",
  "kpi_target_hit",
  "kpi_target_missed",
  "kpi_variance_detected",
  "kpi_trend_alert",
  "chief_pattern_detected",
  "chief_origination_blocked",
  "chief_rebalance_recommended",
  "cost_threshold_crossed",
  "integrity_warning_shown",
  "integrity_warning_overridden",
  "mode_changed",
  "workspace_member_added",
  "department_added",
]);

function parseKinds(raw: unknown): ActivityEventKind[] | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  const parsed = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is ActivityEventKind =>
      ALL_KINDS.has(s as ActivityEventKind),
    );
  return parsed.length > 0 ? parsed : undefined;
}

function parseDate(raw: unknown): Date | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function registerMissionControlRoutes(app: FastifyInstance): void {
  // ── GET /api/mission-control/:companyId/activity ──────────────────────
  app.get("/api/mission-control/:companyId/activity", async (req, reply) => {
    const ar = authReq(req);
    try {
      assertBoard(ar);
    } catch (e) {
      if (e instanceof AuthError)
        return reply.status(e.statusCode).send({ error: e.message });
      throw e;
    }
    const { companyId } = req.params as { companyId: string };
    assertCompanyAccess(ar, companyId);
    await ensureBootstrap();
    const q = req.query as Record<string, unknown>;
    const input: QueryMissionControlEventsInput = {
      companyId,
      since: parseDate(q.since),
      until: parseDate(q.until),
      kinds: parseKinds(q.kinds),
      kpiId: typeof q.kpiId === "string" ? q.kpiId : undefined,
      taskRefId: typeof q.taskRefId === "string" ? q.taskRefId : undefined,
      scopeNodeId:
        typeof q.scopeNodeId === "string" ? q.scopeNodeId : undefined,
      limit: typeof q.limit === "string" ? Number.parseInt(q.limit, 10) : undefined,
      order: q.order === "asc" ? "asc" : "desc",
    };
    try {
      const events = await queryMissionControlEvents(input);
      return { ok: true, events };
    } catch (e) {
      return reply.status(503).send({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        hint: "If this is a fresh install, run pnpm db:up to apply migrations.",
      });
    }
  });

  // ── GET /api/mission-control/:companyId/scope-tree ────────────────────
  app.get("/api/mission-control/:companyId/scope-tree", async (req, reply) => {
    const ar = authReq(req);
    try {
      assertBoard(ar);
    } catch (e) {
      if (e instanceof AuthError)
        return reply.status(e.statusCode).send({ error: e.message });
      throw e;
    }
    const { companyId } = req.params as { companyId: string };
    assertCompanyAccess(ar, companyId);
    try {
      const tree = await getScopeTreeCached(companyId);
      if (!tree) {
        return reply.status(404).send({
          ok: false,
          error: "no scope tree resolved for instance",
          companyId,
        });
      }
      return { ok: true, tree };
    } catch (e) {
      return reply.status(503).send({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });

  // ── GET /api/mission-control/:companyId/stream ─ SSE ──────────────────
  app.get("/api/mission-control/:companyId/stream", (req, reply) => {
    const ar = authReq(req);
    try {
      assertBoard(ar);
    } catch (e) {
      if (e instanceof AuthError)
        return reply.status(e.statusCode).send({ error: e.message });
      throw e;
    }
    const { companyId } = req.params as { companyId: string };
    assertCompanyAccess(ar, companyId);

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Tell intermediaries (curl/nginx) not to buffer.
      "X-Accel-Buffering": "no",
    });
    // Send a comment line immediately so the connection opens without
    // waiting for the first event (Chrome closes pending SSE otherwise).
    reply.raw.write(`: connected ${new Date().toISOString()}\n\n`);

    const unsubscribe = subscribeMissionControlEvents((event) => {
      if (event.instanceId !== companyId) return;
      try {
        reply.raw.write(`event: mc-event\ndata: ${JSON.stringify(event)}\n\n`);
      } catch {
        // Stream errored — clean up; the close handler below will fire too.
        unsubscribe();
      }
    });

    // Periodic keepalive so proxies don't drop idle connections after ~60s.
    const keepalive = setInterval(() => {
      try {
        reply.raw.write(`: keepalive\n\n`);
      } catch {
        clearInterval(keepalive);
      }
    }, 15_000);

    req.raw.on("close", () => {
      clearInterval(keepalive);
      unsubscribe();
    });
  });
}
