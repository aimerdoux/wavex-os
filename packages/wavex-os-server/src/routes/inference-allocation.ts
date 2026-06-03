/** Inference allocation — how the operator's Claude Max 5-hour window is
 *  split between the agent swarm and Pool A onboarding inference.
 *
 *  `swarm_pct` = the share the autonomous fleet may consume; the remainder
 *  (`100 - swarm_pct`) is reserved for Pool A so a busy fleet can never
 *  starve the onboarding wizard a new customer is sitting in front of.
 *
 *  Stored at ~/.wavex-os/state/inference-allocation.json. Read by:
 *    - paperclip-handoff.ts  → scales agent heartbeat intervalSec
 *    - inference-server (Pool A) → soft signal for its share
 *
 *  Surfaced + adjustable in two places (per operator request 2026-05-14):
 *    - onboarding Pillar 2 (sets the default before the fleet exists)
 *    - Mission Control (live-adjustable once the fleet is running)
 *
 *  GET  /api/inference-allocation  → { swarm_pct, pool_a_pct, updated_at }
 *  PUT  /api/inference-allocation  body { swarm_pct: 0..100 }
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { assertBoard, AuthError } from "@wavex-os/auth-shim";
import { getWavexDataRoot } from "../state-bridge.js";

function authReq(req: FastifyRequest) {
  return { method: req.method, headers: req.headers as Record<string, string> };
}

const DEFAULT_SWARM_PCT = 70;

export interface InferenceAllocation {
  swarm_pct: number;
  pool_a_pct: number;
  updated_at: string;
}

function allocationPath(): string {
  return join(getWavexDataRoot(), "state", "inference-allocation.json");
}

/** Read the current allocation, or the default if nothing's been set yet.
 *  Exported so paperclip-handoff + others can read it without an HTTP hop. */
export async function readInferenceAllocation(): Promise<InferenceAllocation> {
  try {
    const raw = await readFile(allocationPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<InferenceAllocation>;
    const swarm = clampPct(parsed.swarm_pct ?? DEFAULT_SWARM_PCT);
    return {
      swarm_pct: swarm,
      pool_a_pct: 100 - swarm,
      updated_at: parsed.updated_at ?? new Date(0).toISOString(),
    };
  } catch {
    return {
      swarm_pct: DEFAULT_SWARM_PCT,
      pool_a_pct: 100 - DEFAULT_SWARM_PCT,
      updated_at: new Date(0).toISOString(),
    };
  }
}

function clampPct(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : DEFAULT_SWARM_PCT;
  return Math.max(0, Math.min(100, Math.round(v)));
}

export function registerInferenceAllocationRoute(app: FastifyInstance): void {
  app.get("/api/inference-allocation", async (_req, reply) => {
    return reply.send(await readInferenceAllocation());
  });

  app.put("/api/inference-allocation", async (req, reply) => {
    // Board-only: changing the swarm/Pool-A split is an operator setting. An
    // unauthenticated PUT with swarm_pct=100 would zero out Pool A and starve
    // the onboarding wizard a new customer is sitting in front of. In dev mode
    // the gate is a no-op (synthetic local board actor), so Mission Control +
    // onboarding Pillar 2 keep working; in production it requires a board actor.
    try {
      assertBoard(authReq(req));
    } catch (e) {
      if (e instanceof AuthError) return reply.status(e.statusCode).send({ ok: false, error: e.message });
      throw e;
    }
    const body = (req.body ?? {}) as { swarm_pct?: unknown };
    if (body.swarm_pct === undefined) {
      return reply.status(400).send({ ok: false, error: "swarm_pct is required" });
    }
    const swarm = clampPct(body.swarm_pct);
    const next: InferenceAllocation = {
      swarm_pct: swarm,
      pool_a_pct: 100 - swarm,
      updated_at: new Date().toISOString(),
    };
    try {
      const path = allocationPath();
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(next, null, 2) + "\n");
      return reply.send({ ok: true, ...next });
    } catch (e) {
      return reply.status(500).send({
        ok: false,
        error: "write_failed",
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  });
}
