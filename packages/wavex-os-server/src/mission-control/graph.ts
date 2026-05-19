/** Mission Control — accountability graph builder.
 *
 *  Phase 5. Combines the ScopeTree (structural skeleton: who reports to
 *  whom) with the AssignmentLink ledger (work flow: who delegates to
 *  whom and how often). Output is a plain JSON graph the UI lays out
 *  with a simple SVG force simulation — no react-flow dep.
 *
 *  Edge weighting: each (from, to) pair gets a count of times work
 *  has flowed between them. The UI uses this to thicken hot edges.
 *
 *  Node weighting: each node gets an `activityCount` (sum of all
 *  inbound + outbound assignments). Heavy nodes render larger so the
 *  load-balance is visually obvious.
 *
 *  Time scrubber: caller passes `since` / `until` to filter edges to a
 *  window. Default = last 7 days.
 */

import { and, eq, gte, lte } from "drizzle-orm";
import {
  type Db,
  assignmentLinks,
  deliverables,
  expectedKpiImpacts,
  getDb,
} from "@wavex-os/db";
import type { PaperclipMode, ScopeNode } from "@wavex-os/shared/types/mission-control";
import { getScopeTreeCached } from "./scope-tree-cache.js";

export type NodeHealth = "healthy" | "at-risk" | "critical";

export interface GraphNode {
  id: string;
  name: string;
  kind: ScopeNode["kind"];
  /** Direct reports edge to parent (structural). */
  parentId?: string;
  /** Total inbound + outbound work links in the window. */
  activityCount: number;
  /** Phase 4 v2 — derived from deliverable backlog + assignment backlog +
   *  inherited from descendants. */
  health: NodeHealth;
  /** True when this node has >=3 in_review deliverables. */
  isBottleneck: boolean;
  /** Open deliverables (status in: draft, in_review). */
  openDeliverables: number;
  /** Open assignment links (toNodeId === this node, no completion mirror). */
  openAssignments: number;
}

export interface GraphEdge {
  fromNodeId: string;
  toNodeId: string;
  /** Number of assignment links in the window for this pair. */
  weight: number;
  /** Most-recent assignment timestamp for this pair. */
  lastAt: string;
}

export interface AccountabilityGraph {
  mode: PaperclipMode;
  instanceId: string;
  nodes: GraphNode[];
  /** Work-flow edges (assignment links). */
  workEdges: GraphEdge[];
  /** Structural edges (scope tree parent → child). */
  structuralEdges: Array<{ fromNodeId: string; toNodeId: string }>;
  window: { since: string; until: string };
  totalWorkEvents: number;
}

const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface BuildGraphInput {
  companyId: string;
  since?: Date;
  until?: Date;
  /** Optional KPI lens — only edges from links whose task has a KPI
   *  impact for this KPI are kept. v1 stub: not yet wired (Phase 6+
   *  when KPI ↔ task joins land). */
  kpiId?: string;
}

export async function buildAccountabilityGraph(
  input: BuildGraphInput,
  db?: Db,
): Promise<AccountabilityGraph | null> {
  const resolved = db ?? (await getDb());
  const tree = await getScopeTreeCached(input.companyId);
  if (!tree) return null;

  const since = input.since ?? new Date(Date.now() - DEFAULT_WINDOW_MS);
  const until = input.until ?? new Date();

  // KPI lens: compute eligible taskRefIds first so we can filter
  // assignment links in a single pass below.
  let lensTaskIds: Set<string> | null = null;
  if (input.kpiId) {
    const impactRows = await resolved
      .select({ taskRefId: expectedKpiImpacts.taskRefId })
      .from(expectedKpiImpacts)
      .where(
        and(
          eq(expectedKpiImpacts.companyId, input.companyId),
          eq(expectedKpiImpacts.kpiId, input.kpiId),
        ),
      );
    lensTaskIds = new Set(impactRows.map((r) => r.taskRefId));
  }

  const allRows = await resolved
    .select()
    .from(assignmentLinks)
    .where(
      and(
        eq(assignmentLinks.companyId, input.companyId),
        gte(assignmentLinks.at, since),
        lte(assignmentLinks.at, until),
      ),
    );
  const rows = lensTaskIds
    ? allRows.filter((r) => lensTaskIds!.has(r.taskRefId ?? ""))
    : allRows;

  const weightByPair = new Map<string, { weight: number; lastAt: Date }>();
  const activityByNode = new Map<string, number>();
  for (const row of rows) {
    const from = row.fromNodeId ?? "";
    const to = row.toNodeId ?? "";
    if (!from || !to) continue;
    const key = `${from}→${to}`;
    const cur = weightByPair.get(key);
    if (cur) {
      cur.weight += 1;
      if (row.at > cur.lastAt) cur.lastAt = row.at;
    } else {
      weightByPair.set(key, { weight: 1, lastAt: row.at });
    }
    activityByNode.set(from, (activityByNode.get(from) ?? 0) + 1);
    activityByNode.set(to, (activityByNode.get(to) ?? 0) + 1);
  }

  // -------------------------------------------------------------------
  // Phase 4 v2 — health propagation + bottleneck detection.
  //
  // Per-node health derived from:
  //   - open deliverables (draft + in_review)
  //   - open assignments inbound (toNodeId === id, no later completion)
  //   - inherited worst-case from descendants
  //
  // Thresholds (intentionally simple — refine if false-positives appear):
  //   bottleneck: >=3 in_review deliverables
  //   critical : openAssignments > 15 OR open deliverables > 10
  //   at-risk  : openAssignments > 5 OR open deliverables > 3
  //   healthy : else
  // -------------------------------------------------------------------
  const deliverableRows = await resolved
    .select({
      producedByNodeId: deliverables.producedByNodeId,
      status: deliverables.status,
    })
    .from(deliverables)
    .where(eq(deliverables.companyId, input.companyId));

  const openDelByNode = new Map<string, number>();
  const inReviewByNode = new Map<string, number>();
  for (const r of deliverableRows) {
    if (r.status === "draft" || r.status === "in_review") {
      openDelByNode.set(
        r.producedByNodeId,
        (openDelByNode.get(r.producedByNodeId) ?? 0) + 1,
      );
    }
    if (r.status === "in_review") {
      inReviewByNode.set(
        r.producedByNodeId,
        (inReviewByNode.get(r.producedByNodeId) ?? 0) + 1,
      );
    }
  }

  const openAssignByNode = new Map<string, number>();
  for (const row of rows) {
    if (!row.toNodeId) continue;
    openAssignByNode.set(
      row.toNodeId,
      (openAssignByNode.get(row.toNodeId) ?? 0) + 1,
    );
  }

  const ownHealth = (nodeId: string): NodeHealth => {
    const od = openDelByNode.get(nodeId) ?? 0;
    const oa = openAssignByNode.get(nodeId) ?? 0;
    if (oa > 15 || od > 10) return "critical";
    if (oa > 5 || od > 3) return "at-risk";
    return "healthy";
  };

  const childrenOf = new Map<string, string[]>();
  for (const n of tree.nodes) {
    if (n.parentId) {
      const cur = childrenOf.get(n.parentId) ?? [];
      cur.push(n.id);
      childrenOf.set(n.parentId, cur);
    }
  }

  const healthCache = new Map<string, NodeHealth>();
  const worstOf = (a: NodeHealth, b: NodeHealth): NodeHealth => {
    const rank = { healthy: 0, "at-risk": 1, critical: 2 } as const;
    return rank[a] >= rank[b] ? a : b;
  };
  const resolveHealth = (nodeId: string): NodeHealth => {
    const cached = healthCache.get(nodeId);
    if (cached) return cached;
    let h = ownHealth(nodeId);
    for (const child of childrenOf.get(nodeId) ?? []) {
      h = worstOf(h, resolveHealth(child));
    }
    healthCache.set(nodeId, h);
    return h;
  };

  const nodes: GraphNode[] = tree.nodes.map((n) => ({
    id: n.id,
    name: n.name,
    kind: n.kind,
    parentId: n.parentId,
    activityCount: activityByNode.get(n.id) ?? 0,
    health: resolveHealth(n.id),
    isBottleneck: (inReviewByNode.get(n.id) ?? 0) >= 3,
    openDeliverables: openDelByNode.get(n.id) ?? 0,
    openAssignments: openAssignByNode.get(n.id) ?? 0,
  }));

  const workEdges: GraphEdge[] = Array.from(weightByPair.entries()).map(
    ([key, value]) => {
      const [fromNodeId, toNodeId] = key.split("→");
      return {
        fromNodeId: fromNodeId ?? "",
        toNodeId: toNodeId ?? "",
        weight: value.weight,
        lastAt: value.lastAt.toISOString(),
      };
    },
  );

  const structuralEdges = tree.nodes
    .filter((n) => n.parentId)
    .map((n) => ({ fromNodeId: n.parentId!, toNodeId: n.id }));

  return {
    mode: tree.mode,
    instanceId: input.companyId,
    nodes,
    workEdges,
    structuralEdges,
    window: { since: since.toISOString(), until: until.toISOString() },
    totalWorkEvents: rows.length,
  };
}
