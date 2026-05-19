/** Mission Control v2 — Phase 7 Cost Attribution.
 *
 *  Joins mission_control_events → deliverables → expected_kpi_impacts
 *  via taskRefId so each dollar of compute spend can be traced to a
 *  specific KPI movement. Three derived views:
 *
 *    getCostPerKpi(companyId, window)
 *      → per KPI: $ spent, KPI delta (sum of actualDelta), $/point
 *
 *    getCapacityHeatmap(companyId)
 *      → node × hour-bucket grid of activity over last 7d
 *
 *    getBurnRateForecast(companyId, days)
 *      → daily cost + projected runway (if a chief budget exists)
 */

import { and, eq, gte } from "drizzle-orm";
import {
  type Db,
  deliverables,
  expectedKpiImpacts,
  getDb,
  missionControlEvents,
} from "@wavex-os/db";

export interface CostPerKpiRow {
  kpiId: string;
  totalCostUSD: number;
  totalKpiDelta: number;
  dollarsPerPoint: number | null;
  contributingTasks: number;
  topContributors: Array<{
    taskRefId: string;
    costUSD: number;
    deliverableCount: number;
  }>;
}

export async function getCostPerKpi(
  companyId: string,
  options: { since?: Date; until?: Date } = {},
  db?: Db,
): Promise<CostPerKpiRow[]> {
  const resolved = db ?? (await getDb());

  // 1. All events in window with their taskRefId + cost.
  const eventConds = [eq(missionControlEvents.companyId, companyId)];
  if (options.since) eventConds.push(gte(missionControlEvents.at, options.since));
  const eventRows = await resolved
    .select({
      taskRefId: missionControlEvents.taskRefId,
      costUsd: missionControlEvents.costUsd,
    })
    .from(missionControlEvents)
    .where(and(...eventConds));

  const costByTask = new Map<string, number>();
  for (const r of eventRows) {
    if (!r.taskRefId) continue;
    const cost = r.costUsd ? Number(r.costUsd) : 0;
    if (cost === 0) continue;
    costByTask.set(r.taskRefId, (costByTask.get(r.taskRefId) ?? 0) + cost);
  }

  // 2. Deliverable count per task (just for the top-contributors display).
  const delivRows = await resolved
    .select({
      taskRefId: deliverables.taskRefId,
    })
    .from(deliverables)
    .where(eq(deliverables.companyId, companyId));
  const deliverableCountByTask = new Map<string, number>();
  for (const d of delivRows) {
    deliverableCountByTask.set(
      d.taskRefId,
      (deliverableCountByTask.get(d.taskRefId) ?? 0) + 1,
    );
  }

  // 3. KPI impacts per task.
  const impactRows = await resolved
    .select()
    .from(expectedKpiImpacts)
    .where(eq(expectedKpiImpacts.companyId, companyId));

  const byKpi = new Map<
    string,
    {
      totalCost: number;
      totalDelta: number;
      tasks: Map<string, number>;
    }
  >();
  for (const i of impactRows) {
    const cost = costByTask.get(i.taskRefId) ?? 0;
    const delta = i.actualDelta ?? 0;
    const cur = byKpi.get(i.kpiId) ?? {
      totalCost: 0,
      totalDelta: 0,
      tasks: new Map<string, number>(),
    };
    cur.totalCost += cost;
    cur.totalDelta += delta;
    cur.tasks.set(i.taskRefId, (cur.tasks.get(i.taskRefId) ?? 0) + cost);
    byKpi.set(i.kpiId, cur);
  }

  return Array.from(byKpi.entries())
    .map(([kpiId, v]) => ({
      kpiId,
      totalCostUSD: Number(v.totalCost.toFixed(4)),
      totalKpiDelta: Number(v.totalDelta.toFixed(2)),
      dollarsPerPoint:
        v.totalDelta === 0 ? null : Number((v.totalCost / Math.abs(v.totalDelta)).toFixed(2)),
      contributingTasks: v.tasks.size,
      topContributors: Array.from(v.tasks.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([taskRefId, costUSD]) => ({
          taskRefId,
          costUSD: Number(costUSD.toFixed(4)),
          deliverableCount: deliverableCountByTask.get(taskRefId) ?? 0,
        })),
    }))
    .sort((a, b) => b.totalCostUSD - a.totalCostUSD);
}

export interface HeatmapResult {
  nodes: string[];
  hours: string[];
  cells: number[][];
}

/** node × hour-bucket grid for the last `days` days (default 7). Each
 *  cell holds the count of assignment events that landed in that hour.
 *  Hours are ISO-truncated to the top of the hour, oldest first. */
export async function getCapacityHeatmap(
  companyId: string,
  options: { days?: number } = {},
  db?: Db,
): Promise<HeatmapResult> {
  const resolved = db ?? (await getDb());
  const days = options.days ?? 7;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const rows = await resolved
    .select({
      actorNodeId: missionControlEvents.actorNodeId,
      at: missionControlEvents.at,
    })
    .from(missionControlEvents)
    .where(
      and(
        eq(missionControlEvents.companyId, companyId),
        gte(missionControlEvents.at, since),
      ),
    );

  const truncateHour = (d: Date): string => {
    const h = new Date(d);
    h.setMinutes(0, 0, 0);
    return h.toISOString();
  };

  // Build the hour axis (oldest → newest), one entry per hour in window.
  const hours: string[] = [];
  const startHour = new Date(since);
  startHour.setMinutes(0, 0, 0);
  for (let t = startHour.getTime(); t < Date.now(); t += 3_600_000) {
    hours.push(new Date(t).toISOString());
  }
  const hourIndex = new Map<string, number>();
  hours.forEach((h, i) => hourIndex.set(h, i));

  // Distinct actor nodes that had events in the window.
  const nodeSet = new Set<string>();
  for (const r of rows) nodeSet.add(r.actorNodeId);
  const nodes = Array.from(nodeSet).sort();
  const nodeIndex = new Map<string, number>();
  nodes.forEach((n, i) => nodeIndex.set(n, i));

  const cells: number[][] = nodes.map(() =>
    hours.map(() => 0),
  );
  for (const r of rows) {
    const ni = nodeIndex.get(r.actorNodeId);
    const hi = hourIndex.get(truncateHour(r.at));
    if (ni == null || hi == null) continue;
    cells[ni]![hi]! += 1;
  }
  return { nodes, hours, cells };
}

export interface BurnRateResult {
  daily: Array<{ date: string; costUSD: number }>;
  projectedRunwayDays: number | null;
  dailyBudgetUSD: number | null;
}

export async function getBurnRateForecast(
  companyId: string,
  options: { days?: number; dailyBudgetUSD?: number } = {},
  db?: Db,
): Promise<BurnRateResult> {
  const resolved = db ?? (await getDb());
  const days = options.days ?? 30;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await resolved
    .select({
      at: missionControlEvents.at,
      costUsd: missionControlEvents.costUsd,
    })
    .from(missionControlEvents)
    .where(
      and(
        eq(missionControlEvents.companyId, companyId),
        gte(missionControlEvents.at, since),
      ),
    );

  const dayKey = (d: Date): string => d.toISOString().slice(0, 10);
  const byDay = new Map<string, number>();
  for (const r of rows) {
    if (!r.costUsd) continue;
    const cost = Number(r.costUsd);
    if (cost === 0) continue;
    const k = dayKey(r.at);
    byDay.set(k, (byDay.get(k) ?? 0) + cost);
  }

  const daily: BurnRateResult["daily"] = [];
  for (let t = since.getTime(); t < Date.now(); t += 86_400_000) {
    const k = dayKey(new Date(t));
    daily.push({ date: k, costUSD: Number((byDay.get(k) ?? 0).toFixed(4)) });
  }

  const totalCost = daily.reduce((a, b) => a + b.costUSD, 0);
  const avgDaily = daily.length === 0 ? 0 : totalCost / daily.length;
  const budget = options.dailyBudgetUSD ?? null;
  const projectedRunwayDays =
    budget != null && avgDaily > 0
      ? Math.max(0, Math.floor((budget * daily.length) / avgDaily))
      : null;

  return {
    daily,
    projectedRunwayDays,
    dailyBudgetUSD: budget,
  };
}
