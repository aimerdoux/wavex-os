/** Mission Control — Status Orb computer (Frontier F1).
 *
 *  One-glance company health, reduced to a single color + reasons list.
 *  Pure computation over already-built MC services (no LLM). Cheap enough
 *  to call on every page load — no caching required.
 *
 *  Four states, in escalation order:
 *    action   — at least one KPI off-track, or runway < 90d, or a
 *               deliverable has been in_review > 72h
 *    watching — any KPI at-risk, or stale measurements, or runway < 180d,
 *               or > 3 orphan tasks
 *    active   — no problems detected AND there is recent (<5min) activity
 *    calm     — no problems detected AND no recent activity
 *
 *  The orb chooses the *worst* color across all signals so the operator
 *  always sees the most-urgent state.
 */

import { type Db, getDb, missionControlEvents } from "@wavex-os/db";
import { and, desc, eq, gte } from "drizzle-orm";
import { getScoreboardWithHistory } from "./kpi-impacts.js";
import { buildImpactSummary } from "./impact-graph.js";
import { getBurnRateForecast } from "./cost-attribution.js";
import { queryDeliverables } from "./deliverables.js";

export type OrbStatus = "calm" | "watching" | "action" | "active";

export interface OrbReason {
  /** Short, scannable label e.g. "Revenue off-track". */
  label: string;
  /** Long sentence the operator can read. */
  detail: string;
  /** Color this reason contributes — caller may render per-reason chips. */
  severity: "info" | "warn" | "critical";
  /** Optional deep-link path that resolves the issue. */
  link?: string;
}

export interface OrbResult {
  status: OrbStatus;
  reasons: OrbReason[];
  generatedAt: string;
  /** How fresh the underlying signals are (max of all signals' lastSeen). */
  signalAgeMs: number;
}

const ACTIVITY_WINDOW_MS = 5 * 60 * 1000;
const REVIEW_OVERDUE_MS = 72 * 60 * 60 * 1000;
const RUNWAY_ACTION_DAYS = 90;
const RUNWAY_WATCH_DAYS = 180;
const ORPHAN_WATCH_THRESHOLD = 3;

export async function computeHealthOrb(
  companyId: string,
  db?: Db,
): Promise<OrbResult> {
  const resolved = db ?? (await getDb());
  const now = Date.now();
  const reasons: OrbReason[] = [];
  let worst: OrbStatus = "calm";
  const bump = (next: OrbStatus): void => {
    const rank: Record<OrbStatus, number> = { calm: 0, active: 1, watching: 2, action: 3 };
    if (rank[next] > rank[worst]) worst = next;
  };

  // ── Signal 1: KPI statuses ───────────────────────────────────────
  const scoreboard = await getScoreboardWithHistory(companyId, {}, resolved).catch(
    () => [] as Awaited<ReturnType<typeof getScoreboardWithHistory>>,
  );
  const offTrack = scoreboard.filter((k) => k.status === "off-track");
  const atRisk = scoreboard.filter((k) => k.status === "at-risk");
  const stale = scoreboard.filter((k) => k.freshnessWarning);
  if (offTrack.length > 0) {
    bump("action");
    reasons.push({
      label: `${offTrack.length} KPI${offTrack.length === 1 ? "" : "s"} off-track`,
      detail: `${offTrack.slice(0, 3).map((k) => k.kpiId).join(", ")}${offTrack.length > 3 ? ` and ${offTrack.length - 3} more` : ""} ${offTrack.length === 1 ? "is" : "are"} significantly behind target.`,
      severity: "critical",
      link: "?view=scoreboard",
    });
  }
  if (atRisk.length > 0) {
    bump("watching");
    reasons.push({
      label: `${atRisk.length} KPI${atRisk.length === 1 ? "" : "s"} at risk`,
      detail: `${atRisk.slice(0, 3).map((k) => k.kpiId).join(", ")} trending below pace.`,
      severity: "warn",
      link: "?view=scoreboard",
    });
  }
  if (stale.length > 0) {
    bump("watching");
    reasons.push({
      label: `${stale.length} stale measurement${stale.length === 1 ? "" : "s"}`,
      detail: `Last reading on ${stale[0].kpiId} is older than 7 days — numbers may be unreliable.`,
      severity: "warn",
      link: "?view=scoreboard",
    });
  }

  // ── Signal 2: Runway ─────────────────────────────────────────────
  const burn = await getBurnRateForecast(companyId, { days: 30 }, resolved).catch(() => null);
  if (burn && burn.projectedRunwayDays != null) {
    if (burn.projectedRunwayDays < RUNWAY_ACTION_DAYS) {
      bump("action");
      reasons.push({
        label: `Runway ${burn.projectedRunwayDays}d`,
        detail: `At current burn, you have ${burn.projectedRunwayDays} days of runway — under the 90-day safety floor.`,
        severity: "critical",
        link: "?view=operations",
      });
    } else if (burn.projectedRunwayDays < RUNWAY_WATCH_DAYS) {
      bump("watching");
      reasons.push({
        label: `Runway ${burn.projectedRunwayDays}d`,
        detail: `Runway is ${burn.projectedRunwayDays} days — worth watching.`,
        severity: "warn",
        link: "?view=operations",
      });
    }
  }

  // ── Signal 3: Deliverables in review > 72h ───────────────────────
  const overdueCutoff = new Date(now - REVIEW_OVERDUE_MS);
  const dels = await queryDeliverables({ companyId, status: "in_review", limit: 50 }).catch(
    () => [],
  );
  const overdueReviews = dels.filter((d) => new Date(d.producedAt).getTime() < overdueCutoff.getTime());
  if (overdueReviews.length > 0) {
    bump("action");
    reasons.push({
      label: `${overdueReviews.length} approval${overdueReviews.length === 1 ? "" : "s"} > 72h`,
      detail: `${overdueReviews[0].title}${overdueReviews.length > 1 ? ` and ${overdueReviews.length - 1} other deliverable${overdueReviews.length === 2 ? "" : "s"}` : ""} ${overdueReviews.length === 1 ? "is" : "are"} blocked awaiting your review.`,
      severity: "critical",
      link: "?view=stream",
    });
  } else if (dels.length > 0) {
    reasons.push({
      label: `${dels.length} awaiting review`,
      detail: `${dels.length} deliverable${dels.length === 1 ? "" : "s"} pending your approval.`,
      severity: "info",
      link: "?view=stream",
    });
  }

  // ── Signal 4: Orphan work ────────────────────────────────────────
  const summary = await buildImpactSummary(companyId, resolved).catch(() => null);
  const orphanCount = summary?.orphanWork?.length ?? 0;
  if (orphanCount > ORPHAN_WATCH_THRESHOLD) {
    bump("watching");
    reasons.push({
      label: `${orphanCount} orphan tasks`,
      detail: `${orphanCount} tasks have no declared KPI impact — they may be busywork.`,
      severity: "warn",
      link: "?view=impact",
    });
  }

  // ── Signal 5: Recent activity (only relevant if no problems) ─────
  const latestEventRows = await resolved
    .select({ at: missionControlEvents.at })
    .from(missionControlEvents)
    .where(
      and(
        eq(missionControlEvents.companyId, companyId),
        gte(missionControlEvents.at, new Date(now - ACTIVITY_WINDOW_MS)),
      ),
    )
    .orderBy(desc(missionControlEvents.at))
    .limit(1);
  const hasRecentActivity = latestEventRows.length > 0;
  if (worst === "calm" && hasRecentActivity) {
    bump("active");
    reasons.push({
      label: "Agents working",
      detail: "At least one agent has emitted activity in the last 5 minutes.",
      severity: "info",
    });
  }

  // If we ended at "calm" with no reasons, leave reasons empty — the
  // popover will render a clean "All clear" state.

  // signalAgeMs = how stale our underlying snapshot is.
  const signalAgeMs = latestEventRows[0]?.at
    ? now - latestEventRows[0].at.getTime()
    : 0;

  return {
    status: worst,
    reasons,
    generatedAt: new Date(now).toISOString(),
    signalAgeMs,
  };
}
