/** Test fixtures for renderer snapshot tests.
 *
 *  We use a small fake ScopeTree + KPI catalog + deliverable catalog so
 *  renderer outputs are deterministic — the same fixtures power every
 *  test file. Renderers are pure, so identical input always produces
 *  identical output (the snapshot guarantee).
 */

import type {
  ActivityEvent,
  ActivityEventKind,
  Deliverable,
  KPI,
  ScopeNode,
  Task,
} from "@wavex-os/shared/types/mission-control";
import type { RenderContext } from "../../src/renderers/render-context.js";

export function makeNode(
  id: string,
  name: string,
  kind: ScopeNode["kind"] = "simulated_agent",
): ScopeNode {
  return {
    id,
    kind,
    name,
    childIds: [],
    metadata: {
      activeTaskCount: 0,
      kpisOwned: [],
      costThisPeriodUSD: 0,
    },
  };
}

export function makeKpi(id: string, name: string): KPI {
  return {
    id,
    instanceId: "test-instance",
    name,
    type: "output",
    unit: "count",
    target: 100,
    window: "week",
    source: { kind: "manual_input" },
    ownerNodeIds: [],
    history: [],
  };
}

export function makeDeliverable(
  id: string,
  title: string,
  sizeBytes = 0,
): Deliverable {
  return {
    id,
    instanceId: "test-instance",
    taskId: "task-1",
    producedByNodeId: "agent-1",
    producedAt: "2026-01-01T00:00:00.000Z",
    kind: "document",
    diskPath: `/tmp/${id}`,
    relPath: id,
    sizeBytes,
    contentHash: "hash",
    title,
    description: "",
    mimeType: "application/octet-stream",
    status: "draft",
    taskRef: { id: "task-1", title: "parent task", status: "completed" },
  };
}

export function makeCtx(): RenderContext {
  const nodes: ScopeNode[] = [
    makeNode("user-1", "Founder", "user"),
    makeNode("chief-1", "Chief of Staff", "chief_of_staff"),
    makeNode("agent-sales", "Sales Agent", "simulated_agent"),
    makeNode("agent-eng", "Eng Agent", "simulated_agent"),
    makeNode("dept-sales", "Sales", "department"),
    makeNode("member-jane", "Jane", "human_member"),
    makeNode("avatar-1", "Sales Avatar", "avatar"),
  ];
  return {
    mode: "solo_founder",
    scopeTree: { byId: new Map(nodes.map((n) => [n.id, n])) },
    kpiCatalog: new Map([
      ["kpi-arr", makeKpi("kpi-arr", "ARR")],
      ["kpi-leads", makeKpi("kpi-leads", "Weekly Leads")],
    ]),
    taskCatalog: new Map<string, Task>(),
    deliverableCatalog: new Map([
      ["deliv-1", makeDeliverable("deliv-1", "Q3 Plan", 4096)],
    ]),
  };
}

interface EventOverrides {
  kind: ActivityEventKind;
  actorNodeId?: string;
  action?: string;
  subjectRef?: ActivityEvent["subjectRef"];
  taskRef?: ActivityEvent["taskRef"];
  kpiRef?: ActivityEvent["kpiRef"];
  deliverableRef?: ActivityEvent["deliverableRef"];
  costUSD?: number;
  expectedImpact?: string;
  severity?: ActivityEvent["severity"];
}

export function makeEvent(o: EventOverrides): ActivityEvent {
  return {
    id: "evt-1",
    instanceId: "test-instance",
    at: "2026-01-01T00:00:00.000Z",
    kind: o.kind,
    modeContext: "solo_founder",
    scopeChain: [],
    actorNodeId: o.actorNodeId ?? "agent-sales",
    action: o.action ?? o.kind,
    subjectRef: o.subjectRef ?? { kind: "generic" },
    taskRef: o.taskRef,
    kpiRef: o.kpiRef,
    deliverableRef: o.deliverableRef,
    costUSD: o.costUSD,
    expectedImpact: o.expectedImpact,
    plainLanguageSentence: "",
    severity: o.severity ?? "info",
    detailUrl: "/mission-control/event/evt-1",
  };
}
