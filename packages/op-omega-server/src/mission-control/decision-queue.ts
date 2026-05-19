/** Mission Control — Decision Queue (Frontier F2).
 *
 *  Ranked, actionable list of items that need the operator's attention.
 *  This is the surface that turns MC from "report" into "tool": every
 *  row has 1-3 inline actions, ordered by urgency × business impact.
 *
 *  Item kinds:
 *    - deliverable_review : a deliverable is in_review status
 *    - orphan_task        : a task has no declared KPI impact
 *    - runway_alert       : runway < 90d (critical) or < 180d (watch)
 *    - stale_kpi          : a KPI hasn't been measured in > 7d
 *
 *  Each item carries a numeric score (0-100). The UI sorts by score
 *  descending and renders severity-colored strips.
 *
 *  Scoring model (v1, deliberately simple — easy to tune):
 *
 *      score = base[kind] + urgency_bonus + impact_bonus
 *
 *    base["deliverable_review"]   = 40
 *    base["orphan_task"]          = 20
 *    base["runway_alert"]         = 60 (action) / 30 (watch)
 *    base["stale_kpi"]            = 15
 *
 *    urgency_bonus = min(40, age_hours / 4)   // +10 per 40h, capped
 *    impact_bonus  = 20 if linked to a KPI off-track, 10 if at-risk, 0 else
 */

import { type Db, getDb } from "@wavex-os/db";
import { queryDeliverables } from "./deliverables.js";
import { buildImpactSummary } from "./impact-graph.js";
import { getScoreboardWithHistory } from "./kpi-impacts.js";
import { getBurnRateForecast } from "./cost-attribution.js";

export type DecisionKind =
  | "deliverable_review"
  | "orphan_task"
  | "runway_alert"
  | "stale_kpi"
  | "starter";

export type DecisionSeverity = "critical" | "high" | "medium" | "low";

export interface DecisionAction {
  /** Action id the UI translates into a worker call. */
  id: string;
  /** Display label, e.g. "Approve", "Reject", "Open". */
  label: string;
  /** Style hint for the button. */
  variant: "primary" | "secondary" | "danger";
}

export interface DecisionItem {
  id: string;
  kind: DecisionKind;
  /** One-line title that fits in a row. */
  title: string;
  /** 1-2 sentence elaboration. */
  detail: string;
  severity: DecisionSeverity;
  score: number;
  /** Hours since item became actionable. */
  ageHours: number;
  /** Actions the operator can take inline. */
  actions: DecisionAction[];
  /** Optional deep-link path to open the full surface. */
  link?: string;
  /** Free-form metadata the UI / action handlers consume. */
  meta?: Record<string, unknown>;
}

export interface DecisionQueueResult {
  items: DecisionItem[];
  total: number;
  generatedAt: string;
  /** Counts by severity for badges. */
  counts: Record<DecisionSeverity, number>;
}

const STALE_KPI_THRESHOLD_DAYS = 7;
const REVIEW_OVERDUE_HOURS = 72;
const REVIEW_AGED_HOURS = 24;

function severityFromScore(score: number): DecisionSeverity {
  if (score >= 80) return "critical";
  if (score >= 60) return "high";
  if (score >= 35) return "medium";
  return "low";
}

function hoursSince(iso: string | Date): number {
  const t = typeof iso === "string" ? new Date(iso).getTime() : iso.getTime();
  return Math.max(0, (Date.now() - t) / (60 * 60 * 1000));
}

export async function buildDecisionQueue(
  companyId: string,
  db?: Db,
): Promise<DecisionQueueResult> {
  const resolved = db ?? (await getDb());
  const items: DecisionItem[] = [];

  // Build a KPI-status lookup so we can weight items that affect off-track KPIs.
  const scoreboard = await getScoreboardWithHistory(companyId, {}, resolved).catch(
    () => [] as Awaited<ReturnType<typeof getScoreboardWithHistory>>,
  );
  const kpiStatus = new Map<string, string>();
  for (const k of scoreboard) kpiStatus.set(k.kpiId, k.status ?? "unknown");

  // ── Source 1: Deliverables awaiting review ─────────────────────────
  const reviewables = await queryDeliverables(
    { companyId, status: "in_review", limit: 50 },
    resolved,
  ).catch(() => []);
  for (const d of reviewables) {
    const age = hoursSince(d.producedAt);
    const urgencyBonus = Math.min(40, age / 4);
    const impactBonus = 0; // future: join deliverable → expected_kpi_impacts → KPI status
    const score = 40 + urgencyBonus + impactBonus;
    items.push({
      id: `deliverable:${d.id}`,
      kind: "deliverable_review",
      title: `Approve: ${d.title}`,
      detail:
        age > REVIEW_OVERDUE_HOURS
          ? `Pending your review for ${Math.round(age)}h — past the 72h freshness window.`
          : age > REVIEW_AGED_HOURS
            ? `Pending your review for ${Math.round(age)}h.`
            : `Waiting on your review (${Math.round(age)}h old).`,
      severity: severityFromScore(score),
      score,
      ageHours: Math.round(age),
      actions: [
        { id: "approve", label: "Approve", variant: "primary" },
        { id: "reject", label: "Reject", variant: "danger" },
        { id: "open", label: "Open", variant: "secondary" },
      ],
      link: `?view=stream&deliverableId=${encodeURIComponent(d.id)}`,
      meta: { deliverableId: d.id, kind: d.kind, sizeBytes: d.sizeBytes },
    });
  }

  // ── Source 2: Runway alert (single item if tripped) ─────────────────
  const burn = await getBurnRateForecast(companyId, { days: 30 }, resolved).catch(
    () => null,
  );
  if (burn && burn.projectedRunwayDays != null) {
    if (burn.projectedRunwayDays < 90) {
      items.push({
        id: "runway:action",
        kind: "runway_alert",
        title: `Runway ${burn.projectedRunwayDays}d — under safety floor`,
        detail: `At current burn you have ${burn.projectedRunwayDays} days of runway. Cut spend, raise more, or defer commitments.`,
        severity: "critical",
        score: 95,
        ageHours: 0,
        actions: [
          { id: "open-cost", label: "Cut spend", variant: "primary" },
          { id: "dismiss", label: "Dismiss for 24h", variant: "secondary" },
        ],
        link: "?view=operations",
        meta: { runwayDays: burn.projectedRunwayDays },
      });
    } else if (burn.projectedRunwayDays < 180) {
      items.push({
        id: "runway:watch",
        kind: "runway_alert",
        title: `Runway ${burn.projectedRunwayDays}d — worth watching`,
        detail: `Runway is comfortable but not unlimited. Review the burn projection.`,
        severity: "medium",
        score: 50,
        ageHours: 0,
        actions: [
          { id: "open-cost", label: "Review burn", variant: "primary" },
          { id: "dismiss", label: "Dismiss", variant: "secondary" },
        ],
        link: "?view=operations",
        meta: { runwayDays: burn.projectedRunwayDays },
      });
    }
  }

  // ── Source 3: Stale KPI measurements ────────────────────────────────
  for (const k of scoreboard) {
    if (!k.freshnessWarning) continue;
    const score = 15 + (kpiStatus.get(k.kpiId) === "off-track" ? 20 : 0);
    items.push({
      id: `stale:${k.kpiId}`,
      kind: "stale_kpi",
      title: `Re-measure ${k.kpiId}`,
      detail: `Last reading is older than ${STALE_KPI_THRESHOLD_DAYS} days. The headline may be reflecting stale data.`,
      severity: severityFromScore(score),
      score,
      ageHours: 168, // > 7d by definition
      actions: [
        { id: "remeasure", label: "Re-measure now", variant: "primary" },
        { id: "open-scoreboard", label: "Open KPI", variant: "secondary" },
      ],
      link: `?view=scoreboard&kpi=${encodeURIComponent(k.kpiId)}`,
      meta: { kpiId: k.kpiId },
    });
  }

  // ── Source 4: Orphan tasks (no declared KPI impact) ────────────────
  const summary = await buildImpactSummary(companyId, resolved).catch(() => null);
  const orphans = (summary?.orphanWork ?? []).slice(0, 5); // surface only the top-5
  for (const o of orphans) {
    const urgencyBonus = Math.min(30, o.ageHours / 6);
    const score = 20 + urgencyBonus;
    items.push({
      id: `orphan:${o.taskRefId}`,
      kind: "orphan_task",
      title: `Declare KPI impact for task ${o.taskRefId.slice(0, 10)}`,
      detail: `Task has been assigned for ${o.ageHours}h with no declared KPI impact. Either link it to a KPI or archive it.`,
      severity: severityFromScore(score),
      score,
      ageHours: o.ageHours,
      actions: [
        { id: "declare-impact", label: "Declare impact", variant: "primary" },
        { id: "archive", label: "Archive", variant: "secondary" },
      ],
      link: `?view=impact&taskRefId=${encodeURIComponent(o.taskRefId)}`,
      meta: { taskRefId: o.taskRefId, ownerNodeId: o.ownerNodeId },
    });
  }

  // ── Starter CTAs (only when queue is otherwise empty) ──────────────
  // The operator landed on a freshly-onboarded company with no KPIs,
  // no events, no deliverables. Don't leave them staring at "all clear"
  // — actively pull them into the first action that creates state.
  if (items.length === 0) {
    const hasAnyKpi = scoreboard.length > 0;
    if (!hasAnyKpi) {
      items.push({
        id: "starter:declare-first-kpi",
        kind: "starter",
        title: "Declare your first KPI",
        detail:
          "Mission Control has nothing to score yet. Pick a north-star metric (revenue, signups, meetings booked) and declare it so agents can be measured against it.",
        severity: "medium",
        score: 30,
        ageHours: 0,
        actions: [
          { id: "open-kpi-setup", label: "Add KPI", variant: "primary" },
          { id: "dismiss", label: "Later", variant: "secondary" },
        ],
        link: "?view=scoreboard",
      });
    }
    // Even with KPIs, an empty queue means agents aren't producing. Surface
    // an "activate fleet" CTA.
    items.push({
      id: "starter:activate-fleet",
      kind: "starter",
      title: "Activate your agent fleet",
      detail:
        "No agent activity in the last 24h. Finish onboarding from the Inception Status panel to let agents start working.",
      severity: "medium",
      score: 25,
      ageHours: 0,
      actions: [
        { id: "dismiss", label: "Got it", variant: "secondary" },
      ],
    });
  }

  // ── Sort + count ────────────────────────────────────────────────────
  items.sort((a, b) => b.score - a.score);

  const counts: Record<DecisionSeverity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  };
  for (const it of items) counts[it.severity]++;

  return {
    items,
    total: items.length,
    counts,
    generatedAt: new Date().toISOString(),
  };
}
