/** Mission Control v2 — causal impact graph (Phase 3).
 *
 *  Surfaces the task → deliverable → KPI chain that's otherwise invisible
 *  in the v1 widgets. Two endpoints:
 *
 *    GET /api/mission-control/:companyId/kpi/:kpiId/impact-graph
 *      → all impacts targeting this KPI, joined to deliverables + the
 *        latest assignment-link per task, with forecast/realized/accuracy
 *
 *    GET /api/mission-control/:companyId/impact-summary
 *      → top KPIs by estimated delta, top contributing work items,
 *        + ORPHAN WORK (tasks with no declared impact, no justification)
 *
 *  Joins are pure SQL over wavex tables — no cross-DB plumbing required:
 *    expected_kpi_impacts.task_ref_id ↔ deliverables.task_ref_id
 *    expected_kpi_impacts.task_ref_id ↔ assignment_links.task_ref_id
 *
 *  Owner of a task = latest non-terminal assignmentLink.toNodeId. */

import { and, desc, eq, sql } from "drizzle-orm";
import {
  type Db,
  assignmentLinks,
  deliverables,
  expectedKpiImpacts,
  getDb,
} from "@wavex-os/db";

export interface ImpactGraphNode {
  taskRefId: string;
  taskRefType: string;
  impactId: string;
  forecastDelta: number;
  realizedDelta: number | null;
  accuracy: number | null; // 1 − |variance| / |forecast|
  ownerNodeId: string | null;
  deliverableIds: string[];
  measureAt: string;
  measuredAt: string | null;
}

export interface ImpactGraphResult {
  kpiId: string;
  totalImpacts: number;
  measuredImpacts: number;
  cumulativeForecast: number;
  cumulativeRealized: number;
  nodes: ImpactGraphNode[];
}

async function ownerOfTask(
  db: Db,
  taskRefId: string,
): Promise<string | null> {
  const rows = await db
    .select()
    .from(assignmentLinks)
    .where(eq(assignmentLinks.taskRefId, taskRefId))
    .orderBy(desc(assignmentLinks.at))
    .limit(1);
  const latest = rows[0];
  if (!latest) return null;
  if (
    latest.kind === "assigned" ||
    latest.kind === "delegated" ||
    latest.kind === "accepted"
  ) {
    return latest.toNodeId ?? null;
  }
  if (latest.kind === "rejected") return latest.fromNodeId ?? null;
  return latest.toNodeId ?? latest.fromNodeId ?? null;
}

export async function buildImpactGraph(
  companyId: string,
  kpiId: string,
  db?: Db,
): Promise<ImpactGraphResult> {
  const resolved = db ?? (await getDb());
  const impacts = await resolved
    .select()
    .from(expectedKpiImpacts)
    .where(
      and(
        eq(expectedKpiImpacts.companyId, companyId),
        eq(expectedKpiImpacts.kpiId, kpiId),
      ),
    );
  const nodes: ImpactGraphNode[] = [];
  let cumulativeForecast = 0;
  let cumulativeRealized = 0;
  let measuredImpacts = 0;
  for (const imp of impacts) {
    cumulativeForecast += imp.estimatedDelta;
    if (imp.actualDelta != null) {
      cumulativeRealized += imp.actualDelta;
      measuredImpacts += 1;
    }
    const deliverableRows = await resolved
      .select({ id: deliverables.id })
      .from(deliverables)
      .where(eq(deliverables.taskRefId, imp.taskRefId));
    const owner = await ownerOfTask(resolved, imp.taskRefId);
    const accuracy =
      imp.actualDelta != null && imp.estimatedDelta !== 0
        ? 1 - Math.abs(imp.actualDelta - imp.estimatedDelta) / Math.abs(imp.estimatedDelta)
        : null;
    nodes.push({
      taskRefId: imp.taskRefId,
      taskRefType: imp.taskRefType,
      impactId: imp.id,
      forecastDelta: imp.estimatedDelta,
      realizedDelta: imp.actualDelta ?? null,
      accuracy,
      ownerNodeId: owner,
      deliverableIds: deliverableRows.map((d) => d.id),
      measureAt: imp.measureAt.toISOString(),
      measuredAt: imp.measurementCompletedAt?.toISOString() ?? null,
    });
  }
  return {
    kpiId,
    totalImpacts: impacts.length,
    measuredImpacts,
    cumulativeForecast,
    cumulativeRealized,
    nodes: nodes.sort(
      (a, b) => Math.abs(b.forecastDelta) - Math.abs(a.forecastDelta),
    ),
  };
}

export interface OrphanTask {
  taskRefId: string;
  taskRefType: string;
  ownerNodeId: string | null;
  ageHours: number;
}

export interface ImpactSummary {
  topKpisByForecast: Array<{
    kpiId: string;
    totalImpacts: number;
    cumulativeForecast: number;
    cumulativeRealized: number;
  }>;
  topWorkForHeadline: ImpactGraphNode[];
  orphanWork: OrphanTask[];
  /** Aggregate forecast vs realized across all measured impacts. */
  ownerCalibration: Array<{
    ownerNodeId: string;
    impactsMeasured: number;
    avgAccuracy: number;
  }>;
}

export async function buildImpactSummary(
  companyId: string,
  db?: Db,
): Promise<ImpactSummary> {
  const resolved = db ?? (await getDb());

  // Aggregate KPIs by forecast magnitude
  const allImpacts = await resolved
    .select()
    .from(expectedKpiImpacts)
    .where(eq(expectedKpiImpacts.companyId, companyId));

  const byKpi = new Map<
    string,
    { totalImpacts: number; cumulativeForecast: number; cumulativeRealized: number }
  >();
  for (const imp of allImpacts) {
    const e = byKpi.get(imp.kpiId) ?? {
      totalImpacts: 0,
      cumulativeForecast: 0,
      cumulativeRealized: 0,
    };
    e.totalImpacts += 1;
    e.cumulativeForecast += imp.estimatedDelta;
    if (imp.actualDelta != null) e.cumulativeRealized += imp.actualDelta;
    byKpi.set(imp.kpiId, e);
  }
  const topKpisByForecast = Array.from(byKpi.entries())
    .map(([kpiId, agg]) => ({ kpiId, ...agg }))
    .sort(
      (a, b) =>
        Math.abs(b.cumulativeForecast) - Math.abs(a.cumulativeForecast),
    )
    .slice(0, 5);

  const headlineKpi = topKpisByForecast[0]?.kpiId;
  const topWorkForHeadline: ImpactGraphNode[] = headlineKpi
    ? (await buildImpactGraph(companyId, headlineKpi, resolved)).nodes.slice(0, 5)
    : [];

  // Orphan work: assignment_links rows whose taskRefId has zero impacts.
  const taskRefIdsInImpacts = new Set(allImpacts.map((i) => i.taskRefId));
  const allAssignments = await resolved
    .select()
    .from(assignmentLinks)
    .where(eq(assignmentLinks.companyId, companyId));
  const seen = new Set<string>();
  const orphanWork: OrphanTask[] = [];
  const now = Date.now();
  for (const a of allAssignments) {
    if (seen.has(a.taskRefId)) continue;
    seen.add(a.taskRefId);
    if (taskRefIdsInImpacts.has(a.taskRefId)) continue;
    if (a.kind === "completed" || a.kind === "failed" || a.kind === "cancelled") continue;
    orphanWork.push({
      taskRefId: a.taskRefId,
      taskRefType: a.taskRefType,
      ownerNodeId: a.toNodeId ?? a.fromNodeId ?? null,
      ageHours: Math.round((now - a.at.getTime()) / 3_600_000),
    });
  }
  orphanWork.sort((a, b) => b.ageHours - a.ageHours);

  // Owner calibration — accuracy per latest-owner across all measured impacts
  const accumByOwner = new Map<
    string,
    { sumAccuracy: number; count: number }
  >();
  for (const imp of allImpacts) {
    if (imp.actualDelta == null || imp.estimatedDelta === 0) continue;
    const owner = await ownerOfTask(resolved, imp.taskRefId);
    if (!owner) continue;
    const accuracy =
      1 - Math.abs(imp.actualDelta - imp.estimatedDelta) / Math.abs(imp.estimatedDelta);
    const e = accumByOwner.get(owner) ?? { sumAccuracy: 0, count: 0 };
    e.sumAccuracy += accuracy;
    e.count += 1;
    accumByOwner.set(owner, e);
  }
  const ownerCalibration = Array.from(accumByOwner.entries())
    .map(([ownerNodeId, e]) => ({
      ownerNodeId,
      impactsMeasured: e.count,
      avgAccuracy: e.sumAccuracy / e.count,
    }))
    .sort((a, b) => b.impactsMeasured - a.impactsMeasured);

  return { topKpisByForecast, topWorkForHeadline, orphanWork, ownerCalibration };
}

// Used by tests + future drilldowns; not exported in widget API today.
export const _helpers = { sql };
