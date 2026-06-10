import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns, issues } from "@paperclipai/db";
import { fetchAllQuotaWindows } from "./quota-windows.js";
import { logActivity } from "./activity-log.js";
import { emitInferenceHook } from "./inference-hooks.js";

/**
 * Run Governor — usage-aware scheduling against the real provider quota.
 *
 * Converts live provider quota-window utilization (e.g. the Anthropic 5h
 * subscription window) into a run allowance tier, so the scheduler
 * self-regulates against the same constraint the subscription enforces:
 *
 *   open          utilization <  conservePct  : all work runs
 *   conserve      < criticalPct               : only critical/high priority
 *   critical_only < frozenPct                 : only critical priority
 *   frozen        >= frozenPct                : no system-triggered runs
 *
 * Manual wakes (triggerDetail === "manual") always bypass the tier gate so a
 * human can always run something. Deferred work stays QUEUED, never cancelled.
 *
 * Also provides:
 *  - DEFER-UNTIL gate: issues whose description carries a
 *    `DEFER-UNTIL: <ISO timestamp>` line are not claimable by system wakes
 *    before that time (cadence enforcement without schema changes).
 *  - Failure circuit breaker: 3 consecutive same-errorCode failures within
 *    45 minutes trips the breaker for system wakes; 6 auto-pauses the agent.
 *
 * Fail-open by design: if the quota signal is unavailable, the tier is "open"
 * (with reason recorded) — a quota outage must not brick the scheduler.
 */

export type GovernorTier = "open" | "conserve" | "critical_only" | "frozen";

export type GovernorStatus = {
  enabled: boolean;
  tier: GovernorTier;
  utilizationPct: number | null;
  windowLabel: string | null;
  resetsAt: string | null;
  thresholds: { conservePct: number; criticalPct: number; frozenPct: number };
  signalOk: boolean;
  signalError: string | null;
  fetchedAt: string;
};

export type GovernorVerdict =
  | { action: "allow"; tier: GovernorTier }
  | { action: "defer"; tier: GovernorTier; reason: string }
  | { action: "cancel"; tier: GovernorTier; reason: string };

function envInt(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(raw) && raw > 0 && raw <= 100 ? raw : fallback;
}

function thresholds() {
  return {
    conservePct: envInt("WAVEX_GOVERNOR_CONSERVE_PCT", 50),
    criticalPct: envInt("WAVEX_GOVERNOR_CRITICAL_PCT", 75),
    frozenPct: envInt("WAVEX_GOVERNOR_FROZEN_PCT", 90),
  };
}

function governorEnabled(): boolean {
  return process.env.WAVEX_GOVERNOR_DISABLED !== "1" && process.env.WAVEX_GOVERNOR_DISABLED !== "true";
}

const QUOTA_CACHE_TTL_MS = 60_000;
let cachedStatus: GovernorStatus | null = null;
let cachedAtMs = 0;
let inflight: Promise<GovernorStatus> | null = null;

function tierForUtilization(pct: number | null): GovernorTier {
  if (pct == null) return "open";
  const t = thresholds();
  if (pct >= t.frozenPct) return "frozen";
  if (pct >= t.criticalPct) return "critical_only";
  if (pct >= t.conservePct) return "conserve";
  return "open";
}

async function computeStatus(): Promise<GovernorStatus> {
  const base: Omit<GovernorStatus, "tier" | "utilizationPct" | "windowLabel" | "resetsAt" | "signalOk" | "signalError"> = {
    enabled: governorEnabled(),
    thresholds: thresholds(),
    fetchedAt: new Date().toISOString(),
  };
  try {
    const results = await fetchAllQuotaWindows();
    // Use the most-constrained window of the PRIMARY provider (anthropic — the
    // provider the agent fleet runs on). Only fall back to other providers'
    // windows when anthropic reports none, so e.g. an exhausted OpenAI weekly
    // window can never freeze Claude work.
    type WorstWindow = { pct: number; label: string; resetsAt: string | null };
    let anyOk = false;
    let firstError: string | null = null;
    const scan = (providers: typeof results): WorstWindow | null => {
      let acc: WorstWindow | null = null;
      for (const provider of providers) {
        if (!provider.ok) continue;
        for (const w of provider.windows) {
          if (w.usedPercent == null) continue;
          if (!acc || w.usedPercent > acc.pct) {
            acc = { pct: w.usedPercent, label: `${provider.provider} ${w.label}`, resetsAt: w.resetsAt ?? null };
          }
        }
      }
      return acc;
    };
    for (const provider of results) {
      if (!provider.ok) firstError = firstError ?? provider.error ?? "quota fetch failed";
      else anyOk = true;
    }
    const worst = scan(results.filter((r) => r.provider === "anthropic")) ?? scan(results);
    return {
      ...base,
      tier: tierForUtilization(worst?.pct ?? null),
      utilizationPct: worst?.pct ?? null,
      windowLabel: worst?.label ?? null,
      resetsAt: worst?.resetsAt ?? null,
      signalOk: anyOk,
      signalError: anyOk ? null : firstError,
    };
  } catch (error) {
    return {
      ...base,
      tier: "open",
      utilizationPct: null,
      windowLabel: null,
      resetsAt: null,
      signalOk: false,
      signalError: String(error),
    };
  }
}

export async function getGovernorStatus(forceRefresh = false): Promise<GovernorStatus> {
  const now = Date.now();
  if (!forceRefresh && cachedStatus && now - cachedAtMs < QUOTA_CACHE_TTL_MS) return cachedStatus;
  if (!inflight) {
    inflight = computeStatus()
      .then((status) => {
        cachedStatus = status;
        cachedAtMs = Date.now();
        return status;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

const DEFER_UNTIL_RE = /DEFER-UNTIL:\s*([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+(?:Z|[+-][0-9]{2}:?[0-9]{2})?)/i;

export function readDeferUntil(description: string | null | undefined): Date | null {
  if (!description) return null;
  const m = DEFER_UNTIL_RE.exec(description);
  if (!m) return null;
  const at = new Date(m[1]!);
  return Number.isNaN(at.getTime()) ? null : at;
}

const BREAKER_WINDOW_MS = 45 * 60_000;
const BREAKER_TRIP_AT = 3;
const BREAKER_PAUSE_AT = 6;

export type BreakerState = {
  tripped: boolean;
  shouldPause: boolean;
  consecutiveSameError: number;
  errorCode: string | null;
};

export async function checkFailureBreaker(db: Db, agentId: string): Promise<BreakerState> {
  const recent = await db
    .select({
      status: heartbeatRuns.status,
      errorCode: heartbeatRuns.errorCode,
      finishedAt: heartbeatRuns.finishedAt,
    })
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.agentId, agentId), inArray(heartbeatRuns.status, ["failed", "succeeded", "timed_out"])))
    .orderBy(desc(heartbeatRuns.finishedAt))
    .limit(BREAKER_PAUSE_AT);

  const cutoff = Date.now() - BREAKER_WINDOW_MS;
  let streakCode: string | null = null;
  let streak = 0;
  for (const run of recent) {
    const finished = run.finishedAt ? new Date(run.finishedAt).getTime() : 0;
    if (finished < cutoff) break;
    if (run.status !== "failed") break;
    const code = run.errorCode ?? "unknown_error";
    if (streakCode == null) streakCode = code;
    if (code !== streakCode) break;
    streak += 1;
  }

  return {
    tripped: streak >= BREAKER_TRIP_AT,
    shouldPause: streak >= BREAKER_PAUSE_AT,
    consecutiveSameError: streak,
    errorCode: streakCode,
  };
}

const PRIORITY_ALLOWED_BY_TIER: Record<GovernorTier, ReadonlySet<string> | null> = {
  open: null, // null = everything allowed
  conserve: new Set(["critical", "high", "urgent"]),
  critical_only: new Set(["critical", "urgent"]),
  frozen: new Set<string>(),
};

/**
 * Evaluate whether a queued run may be claimed right now.
 * `triggerDetail === "manual"` bypasses tier + defer gates (humans always can run),
 * but NOT the breaker pause (a paused agent stays paused).
 */
export async function evaluateRunClaim(
  db: Db,
  run: { id: string; agentId: string; companyId: string; triggerDetail: string | null },
  issueId: string | null,
): Promise<GovernorVerdict> {
  const manual = run.triggerDetail === "manual";
  const status = await getGovernorStatus();

  if (!status.enabled) return { action: "allow", tier: status.tier };

  // 1. Circuit breaker on repeated identical failures (system wakes only).
  if (!manual) {
    const breaker = await checkFailureBreaker(db, run.agentId);
    if (breaker.shouldPause) {
      await db
        .update(agents)
        .set({ status: "paused", pauseReason: "system" })
        .where(and(eq(agents.id, run.agentId), eq(agents.status, "active")));
      await logActivity(db, {
        companyId: run.companyId,
        actorType: "system",
        actorId: "system",
        agentId: run.agentId,
        runId: run.id,
        action: "agent.breaker_paused",
        entityType: "agent",
        entityId: run.agentId,
        details: { errorCode: breaker.errorCode, consecutiveFailures: breaker.consecutiveSameError },
      });
      emitInferenceHook(db, {
        type: "breaker_paused",
        companyId: run.companyId,
        agentId: run.agentId,
        runId: run.id,
        errorCode: breaker.errorCode,
        detail: `${breaker.consecutiveSameError} consecutive identical failures; agent auto-paused`,
      });
      return {
        action: "cancel",
        tier: status.tier,
        reason: `Circuit breaker: ${breaker.consecutiveSameError} consecutive '${breaker.errorCode}' failures — agent auto-paused; fix the cause and resume manually.`,
      };
    }
    if (breaker.tripped) {
      return {
        action: "cancel",
        tier: status.tier,
        reason: `Circuit breaker: ${breaker.consecutiveSameError} consecutive '${breaker.errorCode}' failures in the last 45m — skipping system wake (manual wake bypasses).`,
      };
    }
  }

  // 2. Cadence: DEFER-UNTIL marker on the issue description (system wakes only).
  let issuePriority: string | null = null;
  if (issueId) {
    const issue = await db
      .select({ priority: issues.priority, description: issues.description })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    if (issue) {
      issuePriority = issue.priority;
      if (!manual) {
        const deferUntil = readDeferUntil(issue.description);
        if (deferUntil && deferUntil.getTime() > Date.now()) {
          return {
            action: "defer",
            tier: status.tier,
            reason: `Issue is cadence-deferred until ${deferUntil.toISOString()}.`,
          };
        }
      }
    }
  }

  // 3. Quota tier gate (system wakes only; manual always passes).
  if (manual) return { action: "allow", tier: status.tier };
  const allowedPriorities = PRIORITY_ALLOWED_BY_TIER[status.tier];
  if (allowedPriorities == null) return { action: "allow", tier: status.tier };
  if (status.tier === "frozen") {
    return {
      action: "defer",
      tier: status.tier,
      reason: `Quota window ${status.windowLabel ?? ""} at ${status.utilizationPct ?? "?"}% — frozen for system runs until reset${status.resetsAt ? ` (${status.resetsAt})` : ""}.`,
    };
  }
  if (issuePriority && allowedPriorities.has(issuePriority)) {
    return { action: "allow", tier: status.tier };
  }
  return {
    action: "defer",
    tier: status.tier,
    reason: `Quota window ${status.windowLabel ?? ""} at ${status.utilizationPct ?? "?"}% (tier ${status.tier}) — only ${[...allowedPriorities].join("/")} priority work runs now; '${issuePriority ?? "unprioritized"}' stays queued.`,
  };
}
