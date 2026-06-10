import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "@paperclipai/db";
import { logActivity } from "./activity-log.js";

/**
 * Inference Hook Manager (v1) — the "surface of inference" for internal
 * events. Instead of errors, blockers and completions dying in logs, they
 * become hook events that can wake a designated FIXER agent to optimize and
 * repair in-flight. This is the Pool B differentiator: the platform itself
 * routes its own failures into inference.
 *
 * v1 scope (deliberately small, storm-proof):
 *  - Event types: run_failed, breaker_paused, connector_failed, run_completed.
 *  - Config: ~/.paperclip/instances/<instance>/inference-hooks.json, hot-read
 *    (no restart needed). Shape:
 *      {
 *        "enabled": true,
 *        "fixerAgentId": "<agent uuid to wake>",
 *        "maxWakesPerHour": 6,
 *        "match": { "run_failed": true, "breaker_paused": true,
 *                    "connector_failed": true, "run_completed": false },
 *        "ignoreErrorCodes": ["claude_transient_upstream"]
 *      }
 *  - Safety: per-signature dedup (30 min), global hourly wake cap, and the
 *    fixer is woken via the normal wakeup path so the run governor still
 *    gates it. No fixer configured -> events are activity-logged only.
 *
 * v2 (scoped, not built): persistent hook_events table, per-hook playbooks,
 *  completion-driven optimization loops, Pool B billing meters per hook fire.
 */

export type InferenceHookEvent = {
  type: "run_failed" | "breaker_paused" | "connector_failed" | "run_completed";
  companyId: string;
  agentId?: string | null;
  runId?: string | null;
  errorCode?: string | null;
  detail?: string | null;
};

type HookConfig = {
  enabled: boolean;
  fixerAgentId: string | null;
  maxWakesPerHour: number;
  match: Record<string, boolean>;
  ignoreErrorCodes: string[];
};

const DEFAULT_CONFIG: HookConfig = {
  enabled: true,
  fixerAgentId: null,
  maxWakesPerHour: 6,
  match: { run_failed: true, breaker_paused: true, connector_failed: true, run_completed: false },
  ignoreErrorCodes: ["claude_transient_upstream"],
};

function instanceDir(): string {
  return process.env.PAPERCLIP_INSTANCE_DIR ?? join(process.env.HOME ?? "", ".paperclip", "instances", "default");
}

let cachedConfig: { value: HookConfig; readAt: number } | null = null;
function readConfig(): HookConfig {
  const now = Date.now();
  if (cachedConfig && now - cachedConfig.readAt < 15_000) return cachedConfig.value;
  let value = DEFAULT_CONFIG;
  try {
    const p = join(instanceDir(), "inference-hooks.json");
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<HookConfig>;
      value = {
        enabled: raw.enabled ?? DEFAULT_CONFIG.enabled,
        fixerAgentId: raw.fixerAgentId ?? null,
        maxWakesPerHour: raw.maxWakesPerHour ?? DEFAULT_CONFIG.maxWakesPerHour,
        match: { ...DEFAULT_CONFIG.match, ...(raw.match ?? {}) },
        ignoreErrorCodes: raw.ignoreErrorCodes ?? DEFAULT_CONFIG.ignoreErrorCodes,
      };
    }
  } catch {
    /* malformed config -> defaults; never break the host path */
  }
  cachedConfig = { value, readAt: now };
  return value;
}

const DEDUP_WINDOW_MS = 30 * 60_000;
const recentSignatures = new Map<string, number>();
const wakeTimestamps: number[] = [];

function dedup(signature: string): boolean {
  const now = Date.now();
  for (const [sig, at] of recentSignatures) {
    if (now - at > DEDUP_WINDOW_MS) recentSignatures.delete(sig);
  }
  if (recentSignatures.has(signature)) return true;
  recentSignatures.set(signature, now);
  return false;
}

function underWakeCap(max: number): boolean {
  const cutoff = Date.now() - 3_600_000;
  while (wakeTimestamps.length > 0 && wakeTimestamps[0]! < cutoff) wakeTimestamps.shift();
  return wakeTimestamps.length < max;
}

export type WakeFixerFn = (input: {
  agentId: string;
  reason: string;
}) => Promise<void>;

let wakeFixer: WakeFixerFn | null = null;
/** The heartbeat service registers its wakeup entrypoint here at boot so the
 *  hook manager never imports it (avoids a service cycle). */
export function registerInferenceHookWaker(fn: WakeFixerFn): void {
  wakeFixer = fn;
}

/** Fire-and-forget: never throws, never blocks the host code path. */
export function emitInferenceHook(db: Db, event: InferenceHookEvent): void {
  void (async () => {
    try {
      const cfg = readConfig();
      if (!cfg.enabled) return;
      if (!cfg.match[event.type]) return;
      if (event.errorCode && cfg.ignoreErrorCodes.includes(event.errorCode)) return;
      // Never react to the fixer's own runs — that's a feedback loop.
      if (cfg.fixerAgentId && event.agentId === cfg.fixerAgentId) return;

      const signature = `${event.type}|${event.companyId}|${event.agentId ?? ""}|${event.errorCode ?? ""}`;
      if (dedup(signature)) return;

      await logActivity(db, {
        companyId: event.companyId,
        actorType: "system",
        actorId: "system",
        agentId: event.agentId ?? null,
        runId: event.runId ?? null,
        action: `inference_hook.${event.type}`,
        entityType: "inference_hook",
        entityId: event.runId ?? event.agentId ?? event.companyId,
        details: { errorCode: event.errorCode ?? null, detail: (event.detail ?? "").slice(0, 500) },
      });

      if (!cfg.fixerAgentId || !wakeFixer) return;
      if (!underWakeCap(cfg.maxWakesPerHour)) return;
      wakeTimestamps.push(Date.now());
      await wakeFixer({
        agentId: cfg.fixerAgentId,
        reason:
          `[inference-hook] ${event.type} in company ${event.companyId}` +
          (event.agentId ? ` agent ${event.agentId}` : "") +
          (event.errorCode ? ` errorCode=${event.errorCode}` : "") +
          (event.detail ? ` — ${event.detail.slice(0, 300)}` : "") +
          ". Diagnose the cause, apply the smallest safe fix, and post your findings on the related issue. Do not retry the failed action blindly.",
      });
    } catch {
      /* hooks must never take down the host path */
    }
  })();
}
