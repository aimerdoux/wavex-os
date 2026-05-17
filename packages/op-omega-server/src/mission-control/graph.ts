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
import { type Db, assignmentLinks, getDb } from "@wavex-os/db";
import type { PaperclipMode, ScopeNode } from "@wavex-os/shared/types/mission-control";
import { getScopeTreeCached } from "./scope-tree-cache.js";

export interface GraphNode {
  id: string;
  name: string;
  kind: ScopeNode["kind"];
  /** Direct reports edge to parent (structural). */
  parentId?: string;
  /** Total inbound + outbound work links in the window. */
  activityCount: number;
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

  const rows = await resolved
    .select()
    .from(assignmentLinks)
    .where(
      and(
        eq(assignmentLinks.companyId, input.companyId),
        gte(assignmentLinks.at, since),
        lte(assignmentLinks.at, until),
      ),
    );

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

  const nodes: GraphNode[] = tree.nodes.map((n) => ({
    id: n.id,
    name: n.name,
    kind: n.kind,
    parentId: n.parentId,
    activityCount: activityByNode.get(n.id) ?? 0,
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
