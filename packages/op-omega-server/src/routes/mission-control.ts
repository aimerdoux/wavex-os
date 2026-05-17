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
import {
  deliverableFolder,
  getDeliverable,
  queryDeliverables,
  type QueryDeliverablesInput,
} from "../mission-control/deliverables.js";
import {
  announceDueImpacts,
  declareKpiImpact,
  getScoreboard,
  listDueKpiImpacts,
  queryKpiImpacts,
  recordKpiMeasurement,
  type DeclareKpiImpactInput,
} from "../mission-control/kpi-impacts.js";
import {
  appendAssignmentLink,
  currentOwnerOf,
  listOpenAssignmentsForNode,
  queryAssignmentChain,
  type AppendLinkInput,
  type AssignmentLinkKind,
} from "../mission-control/assignment-chain.js";
import { buildAccountabilityGraph } from "../mission-control/graph.js";
import {
  addOriginationRule,
  evaluateChiefTriggers,
  getChiefConfig,
  listOriginationRules,
  setRuleEnabled,
  upsertChiefConfig,
  type UpsertChiefConfigInput,
} from "../mission-control/chief-of-staff.js";
import type {
  ChiefOriginationRule,
} from "@wavex-os/shared/types/mission-control";
import type {
  DeliverableKind,
  DeliverableStatus,
  PaperclipMode,
} from "@wavex-os/shared/types/mission-control";

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

  // ── GET /api/mission-control/:companyId/deliverables ──────────────────
  app.get(
    "/api/mission-control/:companyId/deliverables",
    async (req, reply) => {
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
      const input: QueryDeliverablesInput = {
        companyId,
        kind: typeof q.kind === "string" ? (q.kind as DeliverableKind) : undefined,
        taskRefId:
          typeof q.taskRefId === "string" ? q.taskRefId : undefined,
        status:
          typeof q.status === "string"
            ? (q.status as DeliverableStatus)
            : undefined,
        producedByNodeId:
          typeof q.producedByNodeId === "string"
            ? q.producedByNodeId
            : undefined,
        limit:
          typeof q.limit === "string"
            ? Number.parseInt(q.limit, 10)
            : undefined,
      };
      try {
        const items = await queryDeliverables(input);
        return { ok: true, deliverables: items };
      } catch (e) {
        return reply.status(503).send({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },
  );

  // ── GET /api/mission-control/deliverable/:id ──────────────────────────
  app.get("/api/mission-control/deliverable/:id", async (req, reply) => {
    const ar = authReq(req);
    try {
      assertBoard(ar);
    } catch (e) {
      if (e instanceof AuthError)
        return reply.status(e.statusCode).send({ error: e.message });
      throw e;
    }
    const { id } = req.params as { id: string };
    await ensureBootstrap();
    try {
      const d = await getDeliverable(id);
      if (!d) {
        return reply.status(404).send({ ok: false, error: "not found" });
      }
      assertCompanyAccess(ar, d.instanceId);
      return { ok: true, deliverable: d };
    } catch (e) {
      if (e instanceof AuthError)
        return reply.status(e.statusCode).send({ error: e.message });
      return reply.status(503).send({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });

  // ── KPI impacts ───────────────────────────────────────────────────────
  app.post(
    "/api/mission-control/:companyId/kpi-impacts",
    async (req, reply) => {
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
      const body = req.body as Partial<DeclareKpiImpactInput> | null;
      if (
        !body ||
        typeof body.kpiId !== "string" ||
        typeof body.taskRefId !== "string" ||
        typeof body.taskRefType !== "string" ||
        typeof body.scopeNodeId !== "string" ||
        typeof body.estimatedDelta !== "number" ||
        typeof body.unit !== "string" ||
        typeof body.timeHorizon !== "string" ||
        typeof body.confidence !== "number" ||
        typeof body.rationale !== "string" ||
        typeof body.direction !== "string"
      ) {
        return reply.status(400).send({
          ok: false,
          error: "missing required fields",
        });
      }
      try {
        const impact = await declareKpiImpact({
          ...body,
          companyId,
        } as DeclareKpiImpactInput);
        return { ok: true, impact };
      } catch (e) {
        return reply.status(503).send({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },
  );

  app.get(
    "/api/mission-control/:companyId/kpi-impacts",
    async (req, reply) => {
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
      const items = await queryKpiImpacts({
        companyId,
        kpiId: typeof q.kpiId === "string" ? q.kpiId : undefined,
        taskRefId:
          typeof q.taskRefId === "string" ? q.taskRefId : undefined,
        scopeNodeId:
          typeof q.scopeNodeId === "string" ? q.scopeNodeId : undefined,
        unmeasuredOnly: q.unmeasuredOnly === "1" || q.unmeasuredOnly === "true",
      });
      return { ok: true, impacts: items };
    },
  );

  app.post(
    "/api/mission-control/kpi-impacts/:id/measure",
    async (req, reply) => {
      const ar = authReq(req);
      try {
        assertBoard(ar);
      } catch (e) {
        if (e instanceof AuthError)
          return reply.status(e.statusCode).send({ error: e.message });
        throw e;
      }
      const { id } = req.params as { id: string };
      await ensureBootstrap();
      const body = req.body as
        | { actualDelta?: number; recordedByNodeId?: string; modeContext?: PaperclipMode }
        | null;
      if (!body || typeof body.actualDelta !== "number") {
        return reply.status(400).send({
          ok: false,
          error: "actualDelta is required",
        });
      }
      try {
        const result = await recordKpiMeasurement({
          impactId: id,
          actualDelta: body.actualDelta,
          modeContext: body.modeContext ?? "solo_founder",
          recordedByNodeId: body.recordedByNodeId ?? "system",
        });
        if (!result) {
          return reply.status(404).send({ ok: false, error: "impact not found" });
        }
        return { ok: true, ...result };
      } catch (e) {
        return reply.status(503).send({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },
  );

  app.get("/api/mission-control/:companyId/scoreboard", async (req, reply) => {
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
    try {
      const [scoreboard, due] = await Promise.all([
        getScoreboard(companyId),
        listDueKpiImpacts(companyId),
      ]);
      return { ok: true, scoreboard, due };
    } catch (e) {
      return reply.status(503).send({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });

  // POST /api/mission-control/:companyId/measure-due — emits an MC event
  // for every impact that's due-but-not-measured. The scheduler can call
  // this on its tick; operators can fire it by hand to populate the
  // Stream with "measurement due" notices.
  app.post(
    "/api/mission-control/:companyId/measure-due",
    async (req, reply) => {
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
      const body = req.body as { modeContext?: PaperclipMode } | null;
      const announced = await announceDueImpacts(
        companyId,
        body?.modeContext ?? "solo_founder",
      );
      return { ok: true, announced };
    },
  );

  // ── Assignment chain (Phase 4) ────────────────────────────────────────
  app.post(
    "/api/mission-control/:companyId/tasks/:taskRefId/assignments",
    async (req, reply) => {
      const ar = authReq(req);
      try {
        assertBoard(ar);
      } catch (e) {
        if (e instanceof AuthError)
          return reply.status(e.statusCode).send({ error: e.message });
        throw e;
      }
      const { companyId, taskRefId } = req.params as {
        companyId: string;
        taskRefId: string;
      };
      assertCompanyAccess(ar, companyId);
      await ensureBootstrap();
      const body = req.body as Partial<AppendLinkInput> | null;
      if (
        !body ||
        typeof body.kind !== "string" ||
        typeof body.taskRefType !== "string"
      ) {
        return reply
          .status(400)
          .send({ ok: false, error: "kind + taskRefType required" });
      }
      try {
        const row = await appendAssignmentLink({
          companyId,
          instanceId: body.instanceId ?? companyId,
          modeContext: body.modeContext ?? "solo_founder",
          taskRefType: body.taskRefType as AppendLinkInput["taskRefType"],
          taskRefId,
          kind: body.kind as AssignmentLinkKind,
          fromNodeId: body.fromNodeId,
          toNodeId: body.toNodeId,
          reason: body.reason,
          taskRef: body.taskRef,
        });
        return { ok: true, link: row };
      } catch (e) {
        return reply.status(503).send({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },
  );

  app.get(
    "/api/mission-control/:companyId/tasks/:taskRefId/chain",
    async (req, reply) => {
      const ar = authReq(req);
      try {
        assertBoard(ar);
      } catch (e) {
        if (e instanceof AuthError)
          return reply.status(e.statusCode).send({ error: e.message });
        throw e;
      }
      const { companyId, taskRefId } = req.params as {
        companyId: string;
        taskRefId: string;
      };
      assertCompanyAccess(ar, companyId);
      await ensureBootstrap();
      try {
        const [chain, owner] = await Promise.all([
          queryAssignmentChain(taskRefId),
          currentOwnerOf(taskRefId),
        ]);
        return { ok: true, chain, currentOwner: owner };
      } catch (e) {
        return reply.status(503).send({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },
  );

  app.get(
    "/api/mission-control/:companyId/node/:nodeId/open-assignments",
    async (req, reply) => {
      const ar = authReq(req);
      try {
        assertBoard(ar);
      } catch (e) {
        if (e instanceof AuthError)
          return reply.status(e.statusCode).send({ error: e.message });
        throw e;
      }
      const { companyId, nodeId } = req.params as {
        companyId: string;
        nodeId: string;
      };
      assertCompanyAccess(ar, companyId);
      await ensureBootstrap();
      try {
        const open = await listOpenAssignmentsForNode(nodeId);
        return { ok: true, open };
      } catch (e) {
        return reply.status(503).send({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },
  );

  // ── Chief of Staff (Phase 6) ──────────────────────────────────────────
  app.get("/api/mission-control/:companyId/chief", async (req, reply) => {
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
    try {
      const cfg = await getChiefConfig(companyId);
      return { ok: true, config: cfg };
    } catch (e) {
      return reply.status(503).send({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });

  app.put("/api/mission-control/:companyId/chief", async (req, reply) => {
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
    const body = req.body as Partial<UpsertChiefConfigInput> | null;
    if (!body || typeof body.mode !== "string") {
      return reply.status(400).send({ ok: false, error: "mode is required" });
    }
    try {
      const cfg = await upsertChiefConfig({
        ...body,
        instanceId: companyId,
      } as UpsertChiefConfigInput);
      return { ok: true, config: cfg };
    } catch (e) {
      return reply.status(503).send({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });

  app.post(
    "/api/mission-control/:companyId/chief/rules",
    async (req, reply) => {
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
      const body = req.body as Partial<ChiefOriginationRule> | null;
      if (
        !body ||
        typeof body.name !== "string" ||
        typeof body.triggerKind !== "string"
      ) {
        return reply.status(400).send({
          ok: false,
          error: "name + triggerKind required",
        });
      }
      try {
        const rule = await addOriginationRule({
          instanceId: companyId,
          name: body.name,
          description: body.description ?? "",
          triggerKind: body.triggerKind as ChiefOriginationRule["triggerKind"],
          triggerConfig: body.triggerConfig ?? {},
          taskTemplate: body.taskTemplate ?? {
            title: body.name,
            description: body.description ?? "",
            assigneeStrategy: "least_loaded_in_scope",
          },
          enabled: body.enabled ?? true,
        });
        return { ok: true, rule };
      } catch (e) {
        return reply.status(503).send({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },
  );

  app.get(
    "/api/mission-control/:companyId/chief/rules",
    async (req, reply) => {
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
      const rules = await listOriginationRules(companyId);
      return { ok: true, rules };
    },
  );

  app.patch(
    "/api/mission-control/chief/rules/:ruleId/enabled",
    async (req, reply) => {
      const ar = authReq(req);
      try {
        assertBoard(ar);
      } catch (e) {
        if (e instanceof AuthError)
          return reply.status(e.statusCode).send({ error: e.message });
        throw e;
      }
      const { ruleId } = req.params as { ruleId: string };
      await ensureBootstrap();
      const body = req.body as { enabled?: boolean } | null;
      if (!body || typeof body.enabled !== "boolean") {
        return reply
          .status(400)
          .send({ ok: false, error: "enabled boolean required" });
      }
      const updated = await setRuleEnabled(ruleId, body.enabled);
      if (!updated) {
        return reply.status(404).send({ ok: false, error: "rule not found" });
      }
      return { ok: true };
    },
  );

  app.post(
    "/api/mission-control/:companyId/chief/evaluate",
    async (req, reply) => {
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
      const body = req.body as { modeContext?: string; actorNodeId?: string } | null;
      const result = await evaluateChiefTriggers({
        instanceId: companyId,
        modeContext:
          (body?.modeContext as
            | "avatar"
            | "solo_founder"
            | "hybrid"
            | undefined) ?? "solo_founder",
        actorNodeId: body?.actorNodeId,
      });
      return { ok: true, result };
    },
  );

  // ── Accountability graph (Phase 5) ────────────────────────────────────
  app.get("/api/mission-control/:companyId/graph", async (req, reply) => {
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
    const since = parseDate(q.since);
    const until = parseDate(q.until);
    const kpiId = typeof q.kpiId === "string" ? q.kpiId : undefined;
    try {
      const graph = await buildAccountabilityGraph({
        companyId,
        since,
        until,
        kpiId,
      });
      if (!graph) {
        return reply
          .status(404)
          .send({ ok: false, error: "no scope tree for instance" });
      }
      return { ok: true, graph };
    } catch (e) {
      return reply.status(503).send({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });

  // ── GET /api/mission-control/deliverable/:id/folder ───────────────────
  //   Returns the on-disk folder containing the artifact so the UI can
  //   surface a "Reveal in Finder" link. The route itself doesn't open
  //   the folder (that needs a client-side native bridge); it just
  //   returns the absolute path.
  app.get(
    "/api/mission-control/deliverable/:id/folder",
    async (req, reply) => {
      const ar = authReq(req);
      try {
        assertBoard(ar);
      } catch (e) {
        if (e instanceof AuthError)
          return reply.status(e.statusCode).send({ error: e.message });
        throw e;
      }
      const { id } = req.params as { id: string };
      await ensureBootstrap();
      try {
        const f = await deliverableFolder(id);
        if (!f) {
          return reply.status(404).send({ ok: false, error: "not found" });
        }
        return { ok: true, ...f };
      } catch (e) {
        return reply.status(503).send({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },
  );
}
