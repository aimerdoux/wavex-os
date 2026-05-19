#!/usr/bin/env node
/**
 * WaveX OS — mock Paperclip core.
 *
 * In-memory, single-process stand-in for the real Paperclip server. Speaks just
 * enough of the Paperclip API for the onboarding wizard's step 9 (spawn) and
 * step 10 (handoff) to feel real before Phase D wires the actual subtree.
 *
 * Endpoints:
 *   GET  /api/health
 *   POST /api/spawn        body: { agents: SpawnAgent[] }   → { runId }
 *   GET  /api/spawn/:runId/events  (SSE)
 *   GET  /api/agents
 *   GET  /api/runs/:runId
 */

// Auto-load .env from repo root (Node 20.6+ built-in, no dotenv dep).
// Lets operators set COMPOSIO_API_KEY + WAVEX_COMPOSIO_DISABLED=0 in
// `<repo>/.env` and have it picked up across mock-core + every package
// that calls process.env. Silently no-ops if the file is missing.
try {
  const envPath = new URL("../../../.env", import.meta.url);
  // @ts-expect-error — `loadEnvFile` lands in Node 20.6, available in 25
  process.loadEnvFile?.(envPath);
} catch {
  /* .env not present — fine, env vars stay shell-only */
}

import Fastify from "fastify";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const PORT = Number(process.env.WAVEX_MOCK_CORE_PORT ?? 3101);
const HOST = process.env.WAVEX_MOCK_CORE_HOST ?? "127.0.0.1";
const STATE_DIR = process.env.WAVEX_OS_STATE_DIR ?? join(homedir(), ".wavex-os");
const COMPANY_NAME = process.env.WAVEX_OS_COMPANY_NAME ?? "default";
const COMPANY_DIR = join(STATE_DIR, "instances", COMPANY_NAME);

if (!existsSync(COMPANY_DIR)) mkdirSync(COMPANY_DIR, { recursive: true });

interface SpawnAgent {
  slot: string;
  templateId: string;
  reportsToSlot?: string;
  ownedKpiIds?: string[];
}

interface AgentRecord extends SpawnAgent {
  agentId: string;
  status: "pending" | "spawning" | "ready" | "failed";
  spawnedAt?: string;
}

interface SpawnEvent {
  ts: number;
  level: "info" | "ok" | "warn" | "error";
  message: string;
  agentId?: string;
}

interface SpawnRun {
  runId: string;
  startedAt: number;
  finishedAt?: number;
  status: "running" | "succeeded" | "failed";
  events: SpawnEvent[];
  /** SSE subscribers — a callback invoked when a new event lands. */
  subscribers: Set<(ev: SpawnEvent | { type: "done"; status: SpawnRun["status"] }) => void>;
}

const agents: AgentRecord[] = loadAgents();
const runs = new Map<string, SpawnRun>();

function loadAgents(): AgentRecord[] {
  const path = join(COMPANY_DIR, "agents.json");
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
}

function persistAgents(): void {
  writeFileSync(join(COMPANY_DIR, "agents.json"), JSON.stringify(agents, null, 2));
}

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function emit(run: SpawnRun, ev: SpawnEvent): void {
  run.events.push(ev);
  for (const fn of run.subscribers) fn(ev);
}

async function spawnOne(run: SpawnRun, slot: SpawnAgent, idx: number, total: number): Promise<void> {
  emit(run, { ts: Date.now(), level: "info", message: `[${idx + 1}/${total}] preparing ${slot.slot} (${slot.templateId})` });
  await sleep(220 + Math.random() * 200);

  // Simulated spawn steps
  emit(run, { ts: Date.now(), level: "info", message: `  - reading template skill at packages/agent-templates/${slot.templateId}/SKILL.md` });
  await sleep(140);

  emit(run, { ts: Date.now(), level: "info", message: `  - registering KPIs: ${(slot.ownedKpiIds ?? []).join(", ") || "(none)"}` });
  await sleep(160);

  emit(run, { ts: Date.now(), level: "info", message: `  - allocating heartbeat schedule (no timer until first wake)` });
  await sleep(140);

  const agentId = newId("ag");
  const record: AgentRecord = {
    ...slot,
    agentId,
    status: "ready",
    spawnedAt: new Date().toISOString(),
  };
  agents.push(record);
  persistAgents();

  emit(run, { ts: Date.now(), level: "ok", message: `  ✓ spawned ${slot.slot} → ${agentId}`, agentId });
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

const app = Fastify({ logger: false });

// CORS allowlist for cross-origin reads from the Paperclip Dashboard UI.
// Mission Control on 5173 is same-origin (vite proxies /api to 3101), so it
// doesn't need this — but the Paperclip Dashboard (core/ui) calls wavex
// directly for the KPI panel + Kernel chat dock + manifest reads. In dev the
// Dashboard is served by the Paperclip core server itself at :3100 (not a
// standalone vite dev server), so 3100 must be allowlisted or the browser
// blocks the cross-origin fetch and the Kernel chat silently fails to
// respond. 5174 is kept for setups that run core/ui as its own vite server.
// The allowlist is explicit (no wildcard); add real origins here when deploying.
const CORS_ALLOWED_ORIGINS = new Set(
  (process.env.WAVEX_CORS_ORIGINS
    ?? "http://localhost:3100,http://127.0.0.1:3100,http://localhost:5174,http://127.0.0.1:5174")
    .split(",").map((s) => s.trim()).filter(Boolean),
);
app.addHook("onRequest", async (req, reply) => {
  const origin = req.headers.origin;
  if (typeof origin === "string" && CORS_ALLOWED_ORIGINS.has(origin)) {
    reply.header("access-control-allow-origin", origin);
    reply.header("vary", "Origin");
    reply.header("access-control-allow-credentials", "true");
    reply.header("access-control-allow-headers", "content-type, authorization");
    reply.header("access-control-allow-methods", "GET, POST, PATCH, DELETE, OPTIONS");
    if (req.method === "OPTIONS") {
      reply.code(204).send();
    }
  }
});

// Wire op-omega onboarding routes (vendored plugin via @wavex-os/op-omega-server).
// Importing dynamically would defer the plugin SDK build dependency; using
// top-level await keeps the side-effect ordering deterministic at startup.
const { registerOpOmegaRoutes } = await import("@wavex-os/op-omega-server");
registerOpOmegaRoutes(app);

// --- routes ---------------------------------------------------------------

app.get("/api/health", async () => ({
  ok: true,
  service: "wavex-os-mock-core",
  version: "0.1.0",
  agents: agents.length,
  runs: runs.size,
  companyDir: COMPANY_DIR,
}));

/** Status projection — manifest enum to FleetGraph enum. Manifest uses
 *  active/standby/parked/disabled; FleetGraph renders pending/spawning/ready/failed.
 *  Map: active→ready, standby→pending, parked→pending, disabled→failed.
 *  Pre-existing legacy values pass through unchanged. */
function projectAgentStatus(s: string): "pending" | "spawning" | "ready" | "failed" {
  if (s === "active" || s === "ready") return "ready";
  if (s === "standby" || s === "parked" || s === "pending") return "pending";
  if (s === "disabled" || s === "failed") return "failed";
  if (s === "spawning") return "spawning";
  return "ready";
}

interface DbAgentRow {
  id: string;
  slot: string;
  templateId: string | null;
  reportsToSlot: string | null;
  ownedKpiIds: string[] | null;
  status: string;
  spawnedAt: Date;
}

app.get<{ Querystring: { companyId?: string } }>("/api/agents", async (req) => {
  const companyId = req.query.companyId?.trim();
  if (companyId) {
    try {
      const { getDb, agents: agentsTable } = await import("@wavex-os/db");
      const { eq, asc } = await import("drizzle-orm");
      const db = await getDb();
      const rows = await db.select({
        id: agentsTable.id,
        slot: agentsTable.slot,
        templateId: agentsTable.templateId,
        reportsToSlot: agentsTable.reportsToSlot,
        ownedKpiIds: agentsTable.ownedKpiIds,
        status: agentsTable.status,
        spawnedAt: agentsTable.spawnedAt,
      })
        .from(agentsTable)
        .where(eq(agentsTable.companyId, companyId))
        .orderBy(asc(agentsTable.tier), asc(agentsTable.slot));
      if (rows.length > 0) {
        const projected = (rows as DbAgentRow[]).map((r) => ({
          agentId: r.id,
          slot: r.slot,
          templateId: r.templateId ?? r.slot,
          reportsToSlot: r.reportsToSlot ?? undefined,
          ownedKpiIds: r.ownedKpiIds ?? [],
          status: projectAgentStatus(r.status),
          spawnedAt: r.spawnedAt.toISOString(),
        }));
        return { agents: projected };
      }
    } catch (err) {
      // DB unavailable / not migrated — fall through to legacy filesystem list
      // eslint-disable-next-line no-console
      console.warn("[wavex-mock-core] /api/agents DB read failed, falling back to filesystem:", (err as Error).message);
    }
  }
  return { agents };
});

// --- Claude Max OAuth probe ----------------------------------------------
// Invokes scripts/wrappers/claude-anthropic-direct.sh probe and returns its
// JSON. The wrapper is bash and reads from the system keychain — the
// credential never reaches this Node process. We only see {ok, source, plan}.
const WRAPPER_PATH = process.env.WAVEX_CLAUDE_WRAPPER ?? resolve(
  process.cwd(),
  "../../scripts/wrappers/claude-anthropic-direct.sh",
);

app.get("/api/probe/claude-max", async (_req, reply) => {
  if (!existsSync(WRAPPER_PATH)) {
    reply.code(500);
    return {
      ok: false,
      error: `wrapper script not found at ${WRAPPER_PATH}. Set WAVEX_CLAUDE_WRAPPER env var to its path.`,
    };
  }

  try {
    const { stdout } = await execFileP(WRAPPER_PATH, ["probe"], {
      timeout: 5000,
      env: { ...process.env },
    });
    const json = JSON.parse(stdout);
    return json;
  } catch (err) {
    // The wrapper exits 2 when no creds are found; still parse its stdout
    const e = err as { stdout?: string; code?: number; message?: string };
    if (e.stdout) {
      try {
        return JSON.parse(e.stdout);
      } catch {
        // fall through
      }
    }
    reply.code(500);
    return {
      ok: false,
      error: e.message ?? "wrapper invocation failed",
    };
  }
});

app.get<{ Params: { runId: string } }>("/api/runs/:runId", async (req, reply) => {
  const run = runs.get(req.params.runId);
  if (!run) {
    reply.code(404);
    return { error: "not found" };
  }
  return {
    runId: run.runId,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    events: run.events,
  };
});

app.post<{ Body: { agents: SpawnAgent[] } }>("/api/spawn", async (req, reply) => {
  const body = req.body;
  if (!body || !Array.isArray(body.agents) || body.agents.length === 0) {
    reply.code(400);
    return { error: "expected { agents: SpawnAgent[] } with at least one agent" };
  }

  const runId = newId("run");
  const run: SpawnRun = {
    runId,
    startedAt: Date.now(),
    status: "running",
    events: [],
    subscribers: new Set(),
  };
  runs.set(runId, run);

  // kick off async spawn — don't await
  (async () => {
    emit(run, { ts: Date.now(), level: "info", message: `wavex-os mock-core spawn started for ${body.agents.length} agents` });
    try {
      for (let i = 0; i < body.agents.length; i++) {
        await spawnOne(run, body.agents[i]!, i, body.agents.length);
      }
      run.status = "succeeded";
      run.finishedAt = Date.now();
      emit(run, { ts: Date.now(), level: "ok", message: `All ${body.agents.length} agents ready. Total time ${(run.finishedAt - run.startedAt) / 1000}s.` });
    } catch (err) {
      run.status = "failed";
      run.finishedAt = Date.now();
      emit(run, { ts: Date.now(), level: "error", message: `spawn failed: ${(err as Error).message}` });
    }
    for (const fn of run.subscribers) fn({ type: "done", status: run.status });
  })();

  return { runId };
});

app.get<{ Params: { runId: string } }>("/api/spawn/:runId/events", async (req, reply) => {
  const run = runs.get(req.params.runId);
  if (!run) {
    reply.code(404);
    return { error: "not found" };
  }

  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  // Replay any events that already happened
  for (const ev of run.events) {
    reply.raw.write(`event: progress\ndata: ${JSON.stringify(ev)}\n\n`);
  }
  if (run.status !== "running") {
    reply.raw.write(`event: done\ndata: ${JSON.stringify({ status: run.status })}\n\n`);
    reply.raw.end();
    return reply;
  }

  // Subscribe to live events
  const handler = (ev: SpawnEvent | { type: "done"; status: SpawnRun["status"] }) => {
    if ("type" in ev && ev.type === "done") {
      reply.raw.write(`event: done\ndata: ${JSON.stringify({ status: ev.status })}\n\n`);
      reply.raw.end();
    } else {
      reply.raw.write(`event: progress\ndata: ${JSON.stringify(ev)}\n\n`);
    }
  };
  run.subscribers.add(handler);

  req.raw.on("close", () => {
    run.subscribers.delete(handler);
  });

  return reply;
});

// --- boot -----------------------------------------------------------------

app.listen({ host: HOST, port: PORT }).then(() => {
  // eslint-disable-next-line no-console
  console.log(`[wavex-mock-core] listening on http://${HOST}:${PORT}`);
  console.log(`[wavex-mock-core] state dir: ${COMPANY_DIR}`);
}).catch((err) => {
  // eslint-disable-next-line no-console
  console.error(`[wavex-mock-core] failed to start:`, err);
  process.exit(1);
});
