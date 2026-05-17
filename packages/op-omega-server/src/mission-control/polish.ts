/** Mission Control — Phase 7 polish: cost dashboard, capacity planning,
 *  weekly export. All read-only aggregates over existing tables. */

import { and, eq, gte, lte } from "drizzle-orm";
import {
  type Db,
  assignmentLinks,
  deliverables,
  getDb,
  missionControlEvents,
} from "@wavex-os/db";
import { getScopeTreeCached } from "./scope-tree-cache.js";

export interface CostByNode {
  nodeId: string;
  nodeName: string;
  costUSD: number;
  events: number;
}

export async function getCostDashboard(
  companyId: string,
  options: { since?: Date; until?: Date } = {},
  db?: Db,
): Promise<{ totals: { costUSD: number; events: number }; byNode: CostByNode[] }> {
  const resolved = db ?? (await getDb());
  const tree = await getScopeTreeCached(companyId);
  const nameById = new Map<string, string>();
  for (const n of tree?.nodes ?? []) nameById.set(n.id, n.name);
  const conds = [eq(missionControlEvents.companyId, companyId)];
  if (options.since) conds.push(gte(missionControlEvents.at, options.since));
  if (options.until) conds.push(lte(missionControlEvents.at, options.until));
  const rows = await resolved
    .select()
    .from(missionControlEvents)
    .where(and(...conds));
  const byNode = new Map<string, { costUSD: number; events: number }>();
  let totalCost = 0;
  let totalEvents = 0;
  for (const r of rows) {
    const cost = r.costUsd ? Number(r.costUsd) : 0;
    totalCost += cost;
    totalEvents += 1;
    const cur = byNode.get(r.actorNodeId) ?? { costUSD: 0, events: 0 };
    cur.costUSD += cost;
    cur.events += 1;
    byNode.set(r.actorNodeId, cur);
  }
  return {
    totals: { costUSD: totalCost, events: totalEvents },
    byNode: Array.from(byNode.entries())
      .map(([nodeId, v]) => ({
        nodeId,
        nodeName: nameById.get(nodeId) ?? nodeId,
        costUSD: v.costUSD,
        events: v.events,
      }))
      .sort((a, b) => b.costUSD - a.costUSD || b.events - a.events),
  };
}

export interface CapacityRow {
  nodeId: string;
  nodeName: string;
  inbound: number;
  outbound: number;
  load: number;
}

export async function getCapacity(
  companyId: string,
  options: { since?: Date; until?: Date } = {},
  db?: Db,
): Promise<{ rows: CapacityRow[]; avg: number; max: number }> {
  const resolved = db ?? (await getDb());
  const tree = await getScopeTreeCached(companyId);
  const nameById = new Map<string, string>();
  for (const n of tree?.nodes ?? []) nameById.set(n.id, n.name);
  const conds = [eq(assignmentLinks.companyId, companyId)];
  if (options.since) conds.push(gte(assignmentLinks.at, options.since));
  if (options.until) conds.push(lte(assignmentLinks.at, options.until));
  const rows = await resolved.select().from(assignmentLinks).where(and(...conds));
  const counts = new Map<string, { inbound: number; outbound: number }>();
  for (const r of rows) {
    if (r.fromNodeId) {
      const cur = counts.get(r.fromNodeId) ?? { inbound: 0, outbound: 0 };
      cur.outbound += 1;
      counts.set(r.fromNodeId, cur);
    }
    if (r.toNodeId) {
      const cur = counts.get(r.toNodeId) ?? { inbound: 0, outbound: 0 };
      cur.inbound += 1;
      counts.set(r.toNodeId, cur);
    }
  }
  const result: CapacityRow[] = Array.from(counts.entries())
    .map(([nodeId, v]) => ({
      nodeId,
      nodeName: nameById.get(nodeId) ?? nodeId,
      inbound: v.inbound,
      outbound: v.outbound,
      load: v.inbound + v.outbound,
    }))
    .sort((a, b) => b.load - a.load);
  const totalLoad = result.reduce((s, r) => s + r.load, 0);
  const avg = result.length > 0 ? totalLoad / result.length : 0;
  const max = result.length > 0 ? result[0]!.load : 0;
  return { rows: result, avg, max };
}

export interface WeeklyExport {
  companyId: string;
  since: string;
  until: string;
  summary: {
    events: number;
    deliverables: number;
    assignments: number;
    costUSD: number;
  };
  topNodesByCost: CostByNode[];
  topNodesByLoad: CapacityRow[];
}

export async function buildWeeklyExport(
  companyId: string,
  options: { since?: Date; until?: Date } = {},
  db?: Db,
): Promise<WeeklyExport> {
  const resolved = db ?? (await getDb());
  const until = options.until ?? new Date();
  const since =
    options.since ?? new Date(until.getTime() - 7 * 24 * 60 * 60 * 1000);
  const [cost, capacity, delivRows] = await Promise.all([
    getCostDashboard(companyId, { since, until }, resolved),
    getCapacity(companyId, { since, until }, resolved),
    resolved
      .select()
      .from(deliverables)
      .where(
        and(
          eq(deliverables.companyId, companyId),
          gte(deliverables.producedAt, since),
          lte(deliverables.producedAt, until),
        ),
      ),
  ]);
  return {
    companyId,
    since: since.toISOString(),
    until: until.toISOString(),
    summary: {
      events: cost.totals.events,
      deliverables: delivRows.length,
      assignments: capacity.rows.reduce((s, r) => s + r.outbound, 0),
      costUSD: cost.totals.costUSD,
    },
    topNodesByCost: cost.byNode.slice(0, 10),
    topNodesByLoad: capacity.rows.slice(0, 10),
  };
}

export function exportToCsv(weekly: WeeklyExport): string {
  const header = "section,node_id,node_name,metric,value";
  const lines: string[] = [header];
  for (const r of weekly.topNodesByCost) {
    lines.push(
      `cost,${csv(r.nodeId)},${csv(r.nodeName)},cost_usd,${r.costUSD.toFixed(4)}`,
    );
    lines.push(
      `cost,${csv(r.nodeId)},${csv(r.nodeName)},event_count,${r.events}`,
    );
  }
  for (const r of weekly.topNodesByLoad) {
    lines.push(
      `capacity,${csv(r.nodeId)},${csv(r.nodeName)},inbound,${r.inbound}`,
    );
    lines.push(
      `capacity,${csv(r.nodeId)},${csv(r.nodeName)},outbound,${r.outbound}`,
    );
    lines.push(`capacity,${csv(r.nodeId)},${csv(r.nodeName)},load,${r.load}`);
  }
  lines.push(
    `summary,,,events,${weekly.summary.events}`,
    `summary,,,deliverables,${weekly.summary.deliverables}`,
    `summary,,,assignments,${weekly.summary.assignments}`,
    `summary,,,cost_usd,${weekly.summary.costUSD.toFixed(4)}`,
  );
  return lines.join("\n");
}

function csv(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
