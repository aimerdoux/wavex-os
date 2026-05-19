/** Mission Control activity-log + bus smoke test.
 *
 *  Round-trips a logMissionControlActivity() call against PGlite (per-test
 *  temp dir) and asserts:
 *    1. queryMissionControlEvents() returns the row with all denormalized
 *       refs (taskRef/kpiRef/deliverableRef) intact;
 *    2. the in-process bus fires for every successful insert (Phase 1.3
 *       SSE endpoint depends on this);
 *    3. filtering by kind + scopeNodeId both work.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetDbCache, runMigrations } from "@wavex-os/db";
import type { ActivityEvent } from "@wavex-os/shared/types/mission-control";
import {
  logMissionControlActivity,
  queryMissionControlEvents,
} from "../src/mission-control/activity-log.js";
import {
  subscribeMissionControlEvents,
  _resetActivityBusForTesting,
} from "../src/mission-control/activity-bus.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "wavex-mc-test-"));
  process.env.WAVEX_OS_STATE_DIR = tempDir;
  process.env.WAVEX_DB_DATA_DIR = join(tempDir, "db");
  _resetDbCache();
  _resetActivityBusForTesting();
  await runMigrations();
});

afterEach(() => {
  delete process.env.WAVEX_OS_STATE_DIR;
  delete process.env.WAVEX_DB_DATA_DIR;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("logMissionControlActivity", () => {
  it("round-trips a deliverable_produced event with all refs", async () => {
    const event = await logMissionControlActivity({
      companyId: "co-test",
      instanceId: "co-test",
      kind: "deliverable_produced",
      modeContext: "solo_founder",
      actorNodeId: "agent-sales",
      action: "deliverable.produced",
      subjectRef: { kind: "deliverable", title: "Pitch deck v1" },
      scopeChain: ["org-1", "dept-sales", "agent-sales"],
      taskRef: { id: "task-1", title: "Draft pitch", status: "completed" },
      kpiRef: { id: "kpi-leads", name: "Weekly Leads" },
      deliverableRef: {
        id: "deliv-1",
        title: "Pitch deck v1",
        kind: "document",
      },
      costUSD: 0.12,
      expectedImpact: "+5 leads next week",
      plainLanguageSentence: "Sales Agent produced document: Pitch deck v1",
    });
    expect(event.id).toBeTruthy();
    expect(event.kind).toBe("deliverable_produced");
    expect(event.taskRef?.title).toBe("Draft pitch");
    expect(event.kpiRef?.name).toBe("Weekly Leads");
    expect(event.deliverableRef?.kind).toBe("document");
    expect(event.costUSD).toBe(0.12);
    expect(event.scopeChain).toEqual(["org-1", "dept-sales", "agent-sales"]);

    const queried = await queryMissionControlEvents({ companyId: "co-test" });
    expect(queried).toHaveLength(1);
    expect(queried[0]!.id).toBe(event.id);
    expect(queried[0]!.taskRef?.id).toBe("task-1");
  });

  it("publishes onto the bus for each insert", async () => {
    const received: ActivityEvent[] = [];
    const unsub = subscribeMissionControlEvents((e) => received.push(e));
    await logMissionControlActivity({
      companyId: "co-pub",
      instanceId: "co-pub",
      kind: "task_originated",
      modeContext: "solo_founder",
      actorNodeId: "chief-1",
      action: "task.originated",
      subjectRef: { kind: "task", title: "Outreach burst" },
    });
    await logMissionControlActivity({
      companyId: "co-pub",
      instanceId: "co-pub",
      kind: "task_completed",
      modeContext: "solo_founder",
      actorNodeId: "agent-sales",
      action: "task.completed",
      subjectRef: { kind: "task" },
    });
    unsub();
    expect(received).toHaveLength(2);
    expect(received[0]!.kind).toBe("task_originated");
    expect(received[1]!.kind).toBe("task_completed");
  });

  it("filters by kinds and respects scopeNodeId via scope_chain", async () => {
    for (const [i, kind] of (
      ["task_originated", "task_completed", "kpi_target_hit"] as const
    ).entries()) {
      await logMissionControlActivity({
        companyId: "co-filter",
        instanceId: "co-filter",
        kind,
        modeContext: "solo_founder",
        actorNodeId: i === 2 ? "chief-1" : "agent-sales",
        action: kind,
        subjectRef: { kind: "fixture" },
        scopeChain: i === 2 ? ["chief-1"] : ["dept-sales", "agent-sales"],
      });
    }
    const tasks = await queryMissionControlEvents({
      companyId: "co-filter",
      kinds: ["task_originated", "task_completed"],
    });
    expect(tasks).toHaveLength(2);
    expect(tasks.every((e) => e.kind.startsWith("task_"))).toBe(true);

    const inDeptSales = await queryMissionControlEvents({
      companyId: "co-filter",
      scopeNodeId: "dept-sales",
    });
    expect(inDeptSales).toHaveLength(2);
    expect(
      inDeptSales.every((e) => e.scopeChain.includes("dept-sales")),
    ).toBe(true);

    const chiefOnly = await queryMissionControlEvents({
      companyId: "co-filter",
      scopeNodeId: "chief-1",
    });
    expect(chiefOnly).toHaveLength(1);
    expect(chiefOnly[0]!.kind).toBe("kpi_target_hit");
  });
});
