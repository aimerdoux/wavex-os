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
  logMissionControlActivity,
  queryMissionControlEvents,
  type QueryMissionControlEventsInput,
} from "../mission-control/activity-log.js";
import { subscribeMissionControlEvents } from "../mission-control/activity-bus.js";
import { getScopeTreeCached } from "../mission-control/scope-tree-cache.js";
import {
  deliverableFolder,
  getDeliverable,
  queryDeliverables,
  writeDeliverable,
  verifyDeliverable,
  type QueryDeliverablesInput,
  type WriteDeliverableInput,
} from "../mission-control/deliverables.js";
import {
  announceDueImpacts,
  declareKpiImpact,
  getScoreboard,
  getScoreboardWithHistory,
  listDueKpiImpacts,
  queryKpiImpacts,
  recordKpiMeasurement,
  type DeclareKpiImpactInput,
} from "../mission-control/kpi-impacts.js";
import { sampleAllKpis } from "../mission-control/kpi-sampler.js";
import { sampleInboundQuality } from "../mission-control/inbound-quality-sampler.js";
import {
  buildImpactGraph,
  buildImpactSummary,
} from "../mission-control/impact-graph.js";
import {
  appendAssignmentLink,
  currentOwnerOf,
  listOpenAssignmentsForNode,
  queryAssignmentChain,
  type AppendLinkInput,
  type AssignmentLinkKind,
} from "../mission-control/assignment-chain.js";
import { buildAccountabilityGraph } from "../mission-control/graph.js";
import { generateWeeklyReport } from "../mission-control/report-generator.js";
import { computeHealthOrb } from "../mission-control/health-orb.js";
import { buildHeadline, invalidateHeadlineCache } from "../mission-control/headline.js";
import { buildDecisionQueue } from "../mission-control/decision-queue.js";
import { buildKpiReceipts } from "../mission-control/receipts.js";
import { askMissionControl } from "../mission-control/chat-nav.js";
import { getTabCounts } from "../mission-control/tab-counts.js";
import { buildAccountabilityMap } from "../mission-control/accountability-map.js";
import {
  addOriginationRule,
  evaluateChiefTriggers,
  getChiefConfig,
  listOriginationRules,
  setRuleEnabled,
  upsertChiefConfig,
  type UpsertChiefConfigInput,
} from "../mission-control/chief-of-staff.js";
import {
  buildWeeklyExport,
  exportToCsv,
  getCapacity,
  getCostDashboard,
} from "../mission-control/polish.js";
import {
  getCostPerKpi,
  getCapacityHeatmap,
  getBurnRateForecast,
} from "../mission-control/cost-attribution.js";
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

async function postInboundQualityBoardAlert(
  alerts: Array<{ channel: string; unknownShare: number }>,
  windowEnd: string,
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN ?? process.env.WAVEX_OPS_TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID ?? process.env.WAVEX_OPS_TELEGRAM_CHAT_ID;
  if (!token || !chat) {
    console.warn("[inbound-quality] Telegram credentials not set — board alert skipped");
    return;
  }
  const lines = alerts.map(
    (a) =>
      `[inbound-quality] channel=${a.channel} unknown_share=${(a.unknownShare * 100).toFixed(1)}% week_ending=${windowEnd}`,
  );
  const text = lines.join("\n");
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10_000);
    const res = await fetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`[inbound-quality] Telegram alert failed: ${res.status} ${detail}`);
    }
  } catch (e) {
    console.error(
      `[inbound-quality] Telegram alert error: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
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

  // ── GET /api/mission-control/:companyId/health-orb ────────────────────
  // Frontier F1 — one-glance status. Pure aggregation, no LLM.
  app.get("/api/mission-control/:companyId/health-orb", async (req, reply) => {
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
      const orb = await computeHealthOrb(companyId);
      return { ok: true, ...orb };
    } catch (e) {
      return reply.status(503).send({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });

  // ── GET /api/mission-control/:companyId/headline ──────────────────────
  // Frontier F1 — LLM-rendered living headline. Cached 5min per company.
  // Pass ?refresh=1 to force regeneration.
  app.get("/api/mission-control/:companyId/headline", async (req, reply) => {
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
    if (q.refresh === "1" || q.refresh === "true") {
      invalidateHeadlineCache(companyId);
    }
    try {
      const orb = await computeHealthOrb(companyId).catch(() => null);
      const headline = await buildHeadline(companyId, orb);
      return { ok: true, ...headline };
    } catch (e) {
      return reply.status(503).send({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });

  // ── GET /api/mission-control/:companyId/decision-queue ────────────────
  // Frontier F2 — ranked, actionable decision items for the operator.
  app.get("/api/mission-control/:companyId/decision-queue", async (req, reply) => {
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
      const result = await buildDecisionQueue(companyId);
      return { ok: true, ...result };
    } catch (e) {
      return reply.status(503).send({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });

  // ── GET /api/mission-control/:companyId/kpi/:kpiId/receipts ────────────
  // Frontier F3 — causal chain for a KPI (who moved it + how + cost).
  app.get(
    "/api/mission-control/:companyId/kpi/:kpiId/receipts",
    async (req, reply) => {
      const ar = authReq(req);
      try {
        assertBoard(ar);
      } catch (e) {
        if (e instanceof AuthError)
          return reply.status(e.statusCode).send({ error: e.message });
        throw e;
      }
      const { companyId, kpiId } = req.params as {
        companyId: string;
        kpiId: string;
      };
      assertCompanyAccess(ar, companyId);
      await ensureBootstrap();
      try {
        const receipts = await buildKpiReceipts(companyId, kpiId);
        return { ok: true, ...receipts };
      } catch (e) {
        return reply.status(503).send({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },
  );

  // ── GET /api/mission-control/:companyId/accountability-map ────────────
  // Frontier F6 — operator-readable "who owns what" card grid.
  app.get(
    "/api/mission-control/:companyId/accountability-map",
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
      try {
        const map = await buildAccountabilityMap(companyId);
        return { ok: true, ...map };
      } catch (e) {
        return reply.status(503).send({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },
  );

  // ── GET /api/mission-control/:companyId/tab-counts ────────────────────
  // Frontier F5 — badge counts for the subnav. Cheap aggregator.
  app.get("/api/mission-control/:companyId/tab-counts", async (req, reply) => {
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
      const counts = await getTabCounts(companyId);
      return { ok: true, ...counts };
    } catch (e) {
      return reply.status(503).send({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });

  // ── POST /api/mission-control/:companyId/ask ──────────────────────────
  // Frontier F4 — natural-language nav. Returns a structured card payload.
  app.post("/api/mission-control/:companyId/ask", async (req, reply) => {
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
    const body = (req.body ?? {}) as { question?: unknown };
    const question = typeof body.question === "string" ? body.question : "";
    if (!question.trim()) {
      return reply.status(400).send({ ok: false, error: "question is required" });
    }
    try {
      const result = await askMissionControl(companyId, question);
      return { ok: true, ...result };
    } catch (e) {
      return reply.status(503).send({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
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

  // ── POST /api/mission-control/deliverable ─────────────────────────────
  // Producer write-path: an agent run records its output as a git-committed,
  // verifiable artifact. Body must carry the task linkage + the artifact
  // (payload). writeDeliverable() commits it to the company's deliverables
  // repo and returns the row + commit_sha.
  app.post("/api/mission-control/deliverable", async (req, reply) => {
    const ar = authReq(req);
    try {
      assertBoard(ar);
    } catch (e) {
      if (e instanceof AuthError)
        return reply.status(e.statusCode).send({ error: e.message });
      throw e;
    }
    const body = (req.body ?? {}) as Partial<WriteDeliverableInput>;
    const missing = (["instanceId", "taskRefId", "producedByNodeId", "kind", "title"] as const).filter(
      (k) => !body[k],
    );
    if (missing.length) {
      return reply.status(400).send({ ok: false, error: `missing required fields: ${missing.join(", ")}` });
    }
    assertCompanyAccess(ar, body.instanceId as string);
    await ensureBootstrap();
    try {
      const deliverable = await writeDeliverable({
        companyId: body.companyId ?? (body.instanceId as string),
        instanceId: body.instanceId as string,
        modeContext: body.modeContext ?? "solo_founder",
        taskRefType: body.taskRefType ?? "issue",
        taskRefId: body.taskRefId as string,
        producedByNodeId: body.producedByNodeId as string,
        kind: body.kind as WriteDeliverableInput["kind"],
        title: body.title as string,
        description: body.description,
        previewText: body.previewText,
        mimeType: body.mimeType,
        payload: body.payload,
        templateUsed: body.templateUsed,
        promptUsedRef: body.promptUsedRef,
        expectedKpiImpactId: body.expectedKpiImpactId,
        filename: body.filename,
        taskRef: body.taskRef,
        plainLanguageSentence: body.plainLanguageSentence,
      });
      return { ok: true, deliverable, commit_sha: deliverable.commitSha ?? null };
    } catch (e) {
      if (e instanceof AuthError)
        return reply.status(e.statusCode).send({ error: e.message });
      return reply.status(503).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  // ── POST /api/mission-control/deliverable/:id/verify ──────────────────
  // Confirms the recorded commit resolves in the deliverables repo AND the
  // on-disk artifact still hashes to contentHash. Flips status verified /
  // failed. This is what turns "the fleet ran" into "the output is real".
  app.post("/api/mission-control/deliverable/:id/verify", async (req, reply) => {
    const ar = authReq(req);
    try {
      assertBoard(ar);
    } catch (e) {
      if (e instanceof AuthError)
        return reply.status(e.statusCode).send({ error: e.message });
      throw e;
    }
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { reviewerNodeId?: string };
    await ensureBootstrap();
    try {
      const existing = await getDeliverable(id);
      if (!existing) {
        return reply.status(404).send({ ok: false, error: "not found" });
      }
      assertCompanyAccess(ar, existing.instanceId);
      const result = await verifyDeliverable(id, body.reviewerNodeId);
      if (!result) {
        return reply.status(404).send({ ok: false, error: "not found" });
      }
      return {
        ok: result.ok,
        status: result.status,
        reason: result.reason ?? null,
        deliverable: result.deliverable,
      };
    } catch (e) {
      if (e instanceof AuthError)
        return reply.status(e.statusCode).send({ error: e.message });
      return reply.status(503).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
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

  // Phase 3 — Causal impact graph: per-KPI task chain
  app.get(
    "/api/mission-control/:companyId/kpi/:kpiId/impact-graph",
    async (req, reply) => {
      const ar = authReq(req);
      try {
        assertBoard(ar);
      } catch (e) {
        if (e instanceof AuthError)
          return reply.status(e.statusCode).send({ error: e.message });
        throw e;
      }
      const { companyId, kpiId } = req.params as {
        companyId: string;
        kpiId: string;
      };
      assertCompanyAccess(ar, companyId);
      await ensureBootstrap();
      try {
        const graph = await buildImpactGraph(companyId, kpiId);
        return { ok: true, ...graph };
      } catch (e) {
        return reply.status(503).send({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },
  );

  // Phase 3 — Causal impact summary: top KPIs + orphan work + calibration
  app.get(
    "/api/mission-control/:companyId/impact-summary",
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
      try {
        const summary = await buildImpactSummary(companyId);
        return { ok: true, ...summary };
      } catch (e) {
        return reply.status(503).send({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },
  );

  // Phase 2 v2 — rich scoreboard with history/status/freshness.
  app.get(
    "/api/mission-control/:companyId/scoreboard-rich",
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
      try {
        const rich = await getScoreboardWithHistory(companyId);
        return { ok: true, scoreboard: rich };
      } catch (e) {
        return reply.status(503).send({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },
  );

  // Phase 2 — sampler tick. Writes one kpi_snapshots row per KPI.
  app.post(
    "/api/mission-control/:companyId/sample-kpis",
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
      try {
        const result = await sampleAllKpis(companyId);
        return { ok: true, ...result };
      } catch (e) {
        return reply.status(503).send({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },
  );

  // WAVAAAAA-245 — inbound-quality scoreboard tick.
  // Writes per-source inbound-quality rows + per-channel unknown-share rows,
  // then forwards any unknown_share > 10% channel to the Telegram board.
  app.post(
    "/api/mission-control/:companyId/sample-inbound-quality",
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
      try {
        const result = await sampleInboundQuality(companyId);
        if (result.unknownShareAlerts.length > 0) {
          await postInboundQualityBoardAlert(result.unknownShareAlerts, result.windowEnd);
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

  // ── Phase 7 polish: cost / capacity / weekly export ───────────────────
  app.get("/api/mission-control/:companyId/cost", async (req, reply) => {
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
    const cost = await getCostDashboard(companyId, {
      since: parseDate(q.since),
      until: parseDate(q.until),
    });
    return { ok: true, ...cost };
  });

  app.get("/api/mission-control/:companyId/capacity", async (req, reply) => {
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
    const capacity = await getCapacity(companyId, {
      since: parseDate(q.since),
      until: parseDate(q.until),
    });
    return { ok: true, ...capacity };
  });

  app.get(
    "/api/mission-control/:companyId/weekly-export",
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
      const weekly = await buildWeeklyExport(companyId, {
        since: parseDate(q.since),
        until: parseDate(q.until),
      });
      if (q.format === "csv") {
        reply.header("Content-Type", "text/csv");
        return exportToCsv(weekly);
      }
      return { ok: true, ...weekly };
    },
  );

  // ── Phase 7 v2: Cost attribution (per-KPI $ + heatmap + burn rate) ────
  app.get(
    "/api/mission-control/:companyId/cost-per-kpi",
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
      const rows = await getCostPerKpi(companyId, {
        since: parseDate(q.since),
        until: parseDate(q.until),
      });
      return { ok: true, rows };
    },
  );

  app.get(
    "/api/mission-control/:companyId/capacity-heatmap",
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
      const days =
        typeof q.days === "string" ? Number.parseInt(q.days, 10) : 7;
      const grid = await getCapacityHeatmap(companyId, {
        days: Number.isFinite(days) && days > 0 ? days : 7,
      });
      return { ok: true, ...grid };
    },
  );

  app.get(
    "/api/mission-control/:companyId/burn-rate",
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
      const days =
        typeof q.days === "string" ? Number.parseInt(q.days, 10) : 30;
      const budget =
        typeof q.dailyBudgetUSD === "string"
          ? Number(q.dailyBudgetUSD)
          : undefined;
      const burn = await getBurnRateForecast(companyId, {
        days: Number.isFinite(days) && days > 0 ? days : 30,
        dailyBudgetUSD:
          typeof budget === "number" && Number.isFinite(budget)
            ? budget
            : undefined,
      });
      return { ok: true, ...burn };
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

  // ── GET /api/mission-control/deliverable/:id/content ──────────────────
  //   Streams the raw artifact bytes back to the UI with the correct
  //   Content-Type. The inspector uses this URL directly in <img>,
  //   <video>, <iframe>, or fetches it for markdown/JSON preview.
  app.get(
    "/api/mission-control/deliverable/:id/content",
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
      const d = await getDeliverable(id);
      if (!d || !d.diskPath) {
        return reply.status(404).send({ ok: false, error: "not found" });
      }
      assertCompanyAccess(ar, d.instanceId);
      try {
        const { createReadStream, statSync } = await import("node:fs");
        const stat = statSync(d.diskPath);
        reply.header("Content-Type", d.mimeType || "application/octet-stream");
        reply.header("Content-Length", String(stat.size));
        reply.header(
          "Content-Disposition",
          `inline; filename="${encodeURIComponent(d.title)}"`,
        );
        return reply.send(createReadStream(d.diskPath));
      } catch (e) {
        return reply.status(503).send({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },
  );

  // ── POST /api/mission-control/deliverable/:id/reveal ──────────────────
  //   Cross-platform OS reveal: spawn `open` (macOS), `xdg-open` (Linux),
  //   or `explorer` (Windows) against the artifact's parent folder. The
  //   server returns immediately; the OS handles the rest. UI shows
  //   no confirmation chrome — the user sees Finder/Explorer pop up.
  app.post(
    "/api/mission-control/deliverable/:id/reveal",
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
      const f = await deliverableFolder(id);
      if (!f) {
        return reply.status(404).send({ ok: false, error: "not found" });
      }
      try {
        const { execFile } = await import("node:child_process");
        const platform = process.platform;
        // macOS `open -R <file>` opens Finder selecting the file. Linux
        // `xdg-open <folder>` opens the folder. Windows `explorer
        // /select,<file>` opens Explorer with the file selected.
        const [cmd, args] =
          platform === "darwin"
            ? ["open", ["-R", f.diskPath]]
            : platform === "win32"
              ? ["explorer", [`/select,${f.diskPath}`]]
              : ["xdg-open", [f.folder]];
        execFile(cmd as string, args as string[], (err) => {
          if (err) console.warn("[reveal]", cmd, "failed:", err.message);
        });
        return { ok: true, opened: f.folder };
      } catch (e) {
        return reply.status(503).send({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },
  );

  // ── POST /api/mission-control/deliverable/:id/review ──────────────────
  //   Approve / reject a deliverable. Updates status + emits the
  //   corresponding `deliverable_approved` / `deliverable_revised` event.
  app.post(
    "/api/mission-control/deliverable/:id/review",
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
      const body = (req.body ?? {}) as {
        decision?: "approve" | "reject";
        notes?: string;
        reviewedByNodeId?: string;
      };
      if (body.decision !== "approve" && body.decision !== "reject") {
        return reply.status(400).send({
          ok: false,
          error: "decision must be 'approve' or 'reject'",
        });
      }
      await ensureBootstrap();
      const d = await getDeliverable(id);
      if (!d) {
        return reply.status(404).send({ ok: false, error: "not found" });
      }
      assertCompanyAccess(ar, d.instanceId);
      const { getDb, deliverables: deliverablesTable } = await import("@wavex-os/db");
      const { eq } = await import("drizzle-orm");
      const db = await getDb();
      const nextStatus = body.decision === "approve" ? "approved" : "in_review";
      await db
        .update(deliverablesTable)
        .set({
          status: nextStatus,
          reviewedAt: new Date(),
          reviewedByNodeId: body.reviewedByNodeId ?? "user:operator",
          reviewNotes: body.notes ?? null,
        })
        .where(eq(deliverablesTable.id, id));
      try {
        await logMissionControlActivity({
          companyId: d.instanceId,
          instanceId: d.instanceId,
          modeContext: "solo_founder",
          actorNodeId: body.reviewedByNodeId ?? "user:operator",
          action: `mc.deliverable.${body.decision}`,
          kind:
            body.decision === "approve"
              ? "deliverable_approved"
              : "deliverable_revised",
          subjectRef: { kind: "deliverable", id, title: d.title },
          deliverableRef: {
            id,
            title: d.title,
            kind: d.kind,
          },
          severity: body.decision === "approve" ? "info" : "notable",
          taskRef: { id: d.taskRef.id, title: d.taskRef.title, status: d.taskRef.status },
        });
      } catch {
        /* logging failure is non-fatal */
      }
      return { ok: true, status: nextStatus };
    },
  );

  // ── POST /api/mission-control/:companyId/reports/weekly ───────────────
  //   Generates a markdown weekly accountability report and writes it to
  //   ~/.wavex-os/instances/<companyId>/reports/weekly-<yyyy-mm-dd>.md.
  //   Returns the absolute path + full markdown so the UI can preview
  //   inline without a second fetch.
  app.post(
    "/api/mission-control/:companyId/reports/weekly",
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
      try {
        const result = await generateWeeklyReport(companyId);
        return result;
      } catch (e) {
        return reply.status(503).send({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },
  );

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
