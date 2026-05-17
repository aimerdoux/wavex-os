/** Round-trip parity test for Mission Control types ↔ zod schemas.
 *
 *  Goal: catch the most common drift — a TS interface adds a field but the
 *  zod schema doesn't, or vice versa. We don't try to fuzz every field
 *  combination here; just hand-craft a representative payload per top-level
 *  type, parse it via zod (which validates structure), assert the parsed
 *  output equals the input (which catches accidental field drops by zod),
 *  and finally JSON-serialize → JSON-parse → re-validate.
 *
 *  Renderer + scoreboard work in later phases will cover the full surface.
 */

import { describe, expect, it } from "vitest";
import type {
  ActivityEvent,
  ChiefOfStaffConfig,
  Deliverable,
  ExpectedKpiImpact,
  KPI,
  ScopeNode,
  Task,
} from "../src/types/mission-control.js";
import * as schemas from "../src/schemas/mission-control.js";

describe("Mission Control round-trip", () => {
  it("Task survives parse → serialize → re-parse", () => {
    const t: Task = {
      id: "task-1",
      instanceId: "instance-1",
      modeContext: "solo_founder",
      rootTaskId: "task-1",
      originatedBy: {
        kind: "chief_of_staff",
        chiefId: "chief-1",
        triggeringPattern: "mrr_below_target_3w",
      },
      originatedAt: "2026-05-16T22:00:00.000Z",
      originationReason: "Pipeline below target three weeks running",
      currentAssigneeNodeId: "node-sales-head",
      assignmentChain: [
        {
          fromNodeId: "node-chief",
          toNodeId: "node-sales-head",
          assignedAt: "2026-05-16T22:00:00.000Z",
          reason: "KPI gap",
        },
      ],
      title: "Increase Q4 pipeline by 15%",
      description: "Research 20 ICP-fit accounts and run outreach.",
      successCriteria: ["20 contacted", "5 booked"],
      expectedKpiImpacts: ["impact-1"],
      status: "originated",
      estimatedCostUSD: 1.2,
      estimatedDurationMs: 1_500_000,
      deliverables: [],
      capabilityId: "outbound_research",
    };

    const parsed = schemas.task.parse(t);
    expect(parsed).toEqual(t);

    const serialized = JSON.stringify(t);
    const reparsed = schemas.task.parse(JSON.parse(serialized));
    expect(reparsed).toEqual(t);
  });

  it("Deliverable survives round-trip", () => {
    const d: Deliverable = {
      id: "deliv-1",
      instanceId: "instance-1",
      taskId: "task-1",
      producedByNodeId: "node-sdr-1",
      producedAt: "2026-05-16T22:14:51.000Z",
      kind: "data_artifact",
      diskPath:
        "/Users/op/.wavex-os/instances/default/org/sales/deliverables/2026-05/task-1/q4_targets.csv",
      relPath: "org/sales/deliverables/2026-05/task-1/q4_targets.csv",
      sizeBytes: 8200,
      contentHash: "sha256:abc",
      title: "Q4 targets research",
      description: "20 ICP-fit accounts with contact email + persona scoring.",
      mimeType: "text/csv",
      status: "in_review",
      taskRef: {
        id: "task-1",
        title: "Increase Q4 pipeline by 15%",
        status: "delegated",
      },
    };

    expect(schemas.deliverable.parse(d)).toEqual(d);
  });

  it("ScopeNode survives round-trip", () => {
    const n: ScopeNode = {
      id: "node-sales-dept",
      kind: "department",
      name: "Sales",
      shortId: "sdept",
      slug: "sales",
      parentId: "node-org",
      childIds: ["node-sdr-1", "node-sdr-2"],
      metadata: {
        capacityScore: 0.7,
        activeTaskCount: 4,
        kpisOwned: ["kpi-qualified-leads"],
        costThisPeriodUSD: 42.3,
      },
    };

    expect(schemas.scopeNode.parse(n)).toEqual(n);
  });

  it("ExpectedKpiImpact survives round-trip", () => {
    const i: ExpectedKpiImpact = {
      id: "impact-1",
      taskId: "task-1",
      kpiId: "kpi-qualified-leads",
      scopeNodeId: "node-sales-dept",
      direction: "increase",
      estimatedDelta: 8,
      unit: "leads/week",
      timeHorizon: "weeks",
      confidence: 0.7,
      rationale: "Prior cold outreach to similar ICP yielded ~0.4 leads/account.",
      measureAt: "2026-05-23T22:00:00.000Z",
      measurementMethod: "auto_kpi_query",
    };
    expect(schemas.expectedKpiImpact.parse(i)).toEqual(i);
  });

  it("KPI survives round-trip", () => {
    const k: KPI = {
      id: "kpi-qualified-leads",
      instanceId: "instance-1",
      name: "Qualified leads per week",
      type: "outcome",
      unit: "leads/week",
      target: 35,
      window: "week",
      source: { kind: "auto_metric", queryRef: "hubspot.qualified_leads_weekly" },
      ownerNodeIds: ["node-sales-dept"],
      current: 23,
      history: [
        { at: "2026-05-09T00:00:00.000Z", value: 18, source: "measurement" },
        { at: "2026-05-16T00:00:00.000Z", value: 23, source: "measurement" },
      ],
    };
    expect(schemas.kpi.parse(k)).toEqual(k);
  });

  it("ActivityEvent survives round-trip", () => {
    const e: ActivityEvent = {
      id: "evt-1",
      instanceId: "instance-1",
      at: "2026-05-16T22:14:32.000Z",
      kind: "task_originated",
      modeContext: "solo_founder",
      scopeChain: ["node-user", "node-chief", "node-sales-dept"],
      actorNodeId: "node-chief",
      action: "chief.task.originated",
      subjectRef: { kind: "task", id: "task-1", title: "Increase Q4 pipeline by 15%" },
      taskRef: { id: "task-1", title: "Increase Q4 pipeline by 15%", status: "originated" },
      kpiRef: { id: "kpi-qualified-leads", name: "Qualified leads per week" },
      plainLanguageSentence:
        "Chief of Staff originated task: \"Increase Q4 pipeline by 15%\" → Sales Department Head",
      severity: "notable",
      detailUrl: "/mission-control/task/task-1",
    };
    expect(schemas.activityEvent.parse(e)).toEqual(e);
  });

  it("ChiefOfStaffConfig survives round-trip with discriminated authority", () => {
    const c: ChiefOfStaffConfig = {
      instanceId: "instance-1",
      enabled: true,
      mode: "solo_founder",
      responsibilities: ["kpi_monitoring", "cross_node_orchestration"],
      originationRules: [
        {
          id: "rule-1",
          name: "Pipeline below target",
          description: "Originate research task when MRR pipeline drops 15% under target for 3 consecutive weeks.",
          triggerKind: "kpi_threshold",
          triggerConfig: { kpiId: "kpi-mrr-pipeline", deltaPct: -15, consecutivePeriods: 3 },
          taskTemplate: {
            title: "Investigate pipeline shortfall",
            description: "Research, contact, and book.",
            assigneeStrategy: "best_performer_for_kpi",
          },
          enabled: true,
        },
      ],
      scopeOfAuthority: {
        kind: "whole_org",
        departmentIds: ["dept-sales", "dept-marketing"],
      },
      dailyBudgetUSD: 50,
      cooldownMinutes: 240,
      maxOriginationsPerDay: 6,
    };
    expect(schemas.chiefOfStaffConfig.parse(c)).toEqual(c);
  });
});
