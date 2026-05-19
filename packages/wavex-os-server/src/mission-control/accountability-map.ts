/** Mission Control — Accountability Map (Frontier F6).
 *
 *  Replaces the abstract force-directed Graph with a scannable card
 *  grid: one card per owner (agent, role, human member, or chief).
 *  Each card answers the operator's question at a glance:
 *
 *    Who is this? What are they accountable for? Are they OK?
 *    What did they do recently, and how much did it cost?
 *
 *  Click → opens Receipts for their top-owned KPI.
 *
 *  Composes existing services (no new DB queries beyond the joins).
 */

import { type Db, getDb } from "@wavex-os/db";
import { buildAccountabilityGraph } from "./graph.js";
import { getScoreboardWithHistory } from "./kpi-impacts.js";
import { queryDeliverables } from "./deliverables.js";
import { getCostDashboard } from "./polish.js";
import { queryMissionControlEvents } from "./activity-log.js";

export type CardHealth = "healthy" | "at-risk" | "critical";
export type KpiStatus = "on-track" | "at-risk" | "off-track" | "unknown";

export interface OwnedKpi {
  kpiId: string;
  status: KpiStatus;
  current: number | null;
  target: number | null;
}

export interface AccountabilityCard {
  nodeId: string;
  name: string;
  /** Human-readable role label derived from ScopeNode kind. */
  role: string;
  kind: string;
  health: CardHealth;
  isBottleneck: boolean;
  ownedKpis: OwnedKpi[];
  openWork: number;
  reviewables: number;
  activityCount: number;
  /** Most recent activity sentence (from mission-control-events). */
  recentActivity: string | null;
  recentAt: string | null;
  costUSD7d: number;
  /** Top KPI to open in Receipts on card click. */
  topKpiId: string | null;
}

export interface AccountabilityMapResult {
  cards: AccountabilityCard[];
  total: number;
  generatedAt: string;
}

const KIND_TO_ROLE: Record<string, string> = {
  avatar: "Avatar",
  org: "Organization",
  department: "Department",
  role: "Role",
  simulated_agent: "Agent",
  workspace: "Workspace",
  team: "Team",
  human_member: "Human",
  workspace_agent: "Agent",
  chief_of_staff: "Chief of Staff",
};

/** KPI status → card health (worst owned KPI wins). */
function kpiStatusToHealth(s: KpiStatus): CardHealth {
  if (s === "off-track") return "critical";
  if (s === "at-risk") return "at-risk";
  return "healthy";
}

function worseHealth(a: CardHealth, b: CardHealth): CardHealth {
  const rank: Record<CardHealth, number> = { healthy: 0, "at-risk": 1, critical: 2 };
  return rank[b] > rank[a] ? b : a;
}

export async function buildAccountabilityMap(
  companyId: string,
  db?: Db,
): Promise<AccountabilityMapResult> {
  const resolved = db ?? (await getDb());

  // Parallel fetch — none depend on each other.
  const [graph, scoreboard, allDeliverables, costDash, recentEvents] = await Promise.all([
    buildAccountabilityGraph({ companyId }, resolved).catch(() => null),
    getScoreboardWithHistory(companyId, {}, resolved).catch(
      () => [] as Awaited<ReturnType<typeof getScoreboardWithHistory>>,
    ),
    queryDeliverables({ companyId, limit: 500 }, resolved).catch(() => []),
    getCostDashboard(companyId, { since: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }, resolved).catch(
      () => ({ totals: { costUSD: 0, events: 0 }, byNode: [] as Array<{ nodeId: string; costUSD: number }> }),
    ),
    queryMissionControlEvents({
      companyId,
      since: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      limit: 500,
    }).catch(() => []),
  ]);

  if (!graph) {
    return { cards: [], total: 0, generatedAt: new Date().toISOString() };
  }

  // Cost lookup (sum by nodeId).
  const costByNode = new Map<string, number>();
  for (const n of costDash.byNode ?? []) {
    costByNode.set(n.nodeId, (costByNode.get(n.nodeId) ?? 0) + (n.costUSD ?? 0));
  }

  // KPIs grouped by owner.
  const kpisByOwner = new Map<string, OwnedKpi[]>();
  for (const k of scoreboard) {
    const owners = k.ownerNodeIds ?? [];
    const owned: OwnedKpi = {
      kpiId: k.kpiId,
      status: (k.status as KpiStatus) ?? "unknown",
      current: k.current ?? null,
      target: k.target ?? null,
    };
    for (const o of owners) {
      const list = kpisByOwner.get(o) ?? [];
      list.push(owned);
      kpisByOwner.set(o, list);
    }
  }

  // Deliverables grouped by producer.
  const deliverablesByNode = new Map<string, { open: number; review: number }>();
  for (const d of allDeliverables) {
    const node = d.producedByNodeId ?? "";
    if (!node) continue;
    const slot = deliverablesByNode.get(node) ?? { open: 0, review: 0 };
    if (d.status === "in_review") slot.review++;
    if (d.status === "draft" || d.status === "in_review") slot.open++;
    deliverablesByNode.set(node, slot);
  }

  // Most-recent activity per actor.
  const recentByActor = new Map<string, { sentence: string; at: string }>();
  const eventsArr = Array.isArray(recentEvents) ? recentEvents : [];
  for (const ev of eventsArr) {
    const actor = ev.actorNodeId ?? "";
    if (!actor || recentByActor.has(actor)) continue; // events are desc-ordered, take first
    recentByActor.set(actor, {
      sentence: ev.plainLanguageSentence ?? `${ev.kind} (${ev.action})`,
      at: String(ev.at),
    });
  }

  // Filter graph nodes to those that are meaningful as owners:
  // skip pure-structural nodes (org, department, workspace, team).
  const ownerNodes = graph.nodes.filter((n) =>
    [
      "avatar",
      "role",
      "simulated_agent",
      "human_member",
      "workspace_agent",
      "chief_of_staff",
    ].includes(n.kind),
  );

  const cards: AccountabilityCard[] = ownerNodes.map((n) => {
    const ownedKpis = (kpisByOwner.get(n.id) ?? []).sort(
      (a, b) => {
        const rank: Record<KpiStatus, number> = {
          "off-track": 0,
          "at-risk": 1,
          unknown: 2,
          "on-track": 3,
        };
        return rank[a.status] - rank[b.status];
      },
    );

    // Card health = worst of graph health + KPI-derived health.
    let health: CardHealth = n.health;
    for (const k of ownedKpis) {
      health = worseHealth(health, kpiStatusToHealth(k.status));
    }

    const dels = deliverablesByNode.get(n.id) ?? { open: 0, review: 0 };
    const recent = recentByActor.get(n.id);
    const topKpiId = ownedKpis[0]?.kpiId ?? null;
    const role = KIND_TO_ROLE[n.kind] ?? n.kind;

    return {
      nodeId: n.id,
      name: n.name,
      role,
      kind: n.kind,
      health,
      isBottleneck: n.isBottleneck,
      ownedKpis,
      openWork: dels.open + n.openAssignments,
      reviewables: dels.review,
      activityCount: n.activityCount,
      recentActivity: recent?.sentence ?? null,
      recentAt: recent?.at ?? null,
      costUSD7d: costByNode.get(n.id) ?? 0,
      topKpiId,
    };
  });

  // Rank: critical first, then at-risk, then by activity desc.
  const healthRank: Record<CardHealth, number> = { critical: 0, "at-risk": 1, healthy: 2 };
  cards.sort((a, b) => {
    const hr = healthRank[a.health] - healthRank[b.health];
    if (hr !== 0) return hr;
    return b.activityCount - a.activityCount;
  });

  return {
    cards,
    total: cards.length,
    generatedAt: new Date().toISOString(),
  };
}
