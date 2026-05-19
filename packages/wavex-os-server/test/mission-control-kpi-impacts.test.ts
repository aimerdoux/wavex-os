/** Mission Control KPI impacts — declare, measure, scoreboard.
 *
 *  Three scenarios:
 *    1. declareKpiImpact + recordKpiMeasurement → target_hit event
 *    2. recordKpiMeasurement with off-by-much actual → target_missed event
 *    3. getScoreboard aggregates per-KPI attainment ratio
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetDbCache, runMigrations } from "@wavex-os/db";
import type { ActivityEvent } from "@wavex-os/shared/types/mission-control";
import {
  declareKpiImpact,
  getScoreboard,
  listDueKpiImpacts,
  recordKpiMeasurement,
} from "../src/mission-control/kpi-impacts.js";
import {
  _resetActivityBusForTesting,
  subscribeMissionControlEvents,
} from "../src/mission-control/activity-bus.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "wavex-mc-kpi-"));
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

describe("kpi-impacts", () => {
  it("declare + measure-on-target emits kpi_target_hit", async () => {
    const events: ActivityEvent[] = [];
    subscribeMissionControlEvents((e) => events.push(e));

    const impact = await declareKpiImpact({
      companyId: "co-hit",
      taskRefType: "avatar_approval",
      taskRefId: "task-1",
      kpiId: "weekly_leads",
      scopeNodeId: "agent-sales",
      direction: "increase",
      estimatedDelta: 10,
      unit: "leads",
      timeHorizon: "days",
      confidence: 0.7,
      rationale: "Cold outreach historically converts ~10 leads/week.",
    });
    expect(impact.id).toBeTruthy();
    expect(impact.actualDelta).toBeUndefined();

    const result = await recordKpiMeasurement({
      impactId: impact.id,
      actualDelta: 10.2, // ~2% off — within target_hit threshold
      modeContext: "solo_founder",
      recordedByNodeId: "chief-1",
    });
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe("target_hit");
    expect(events.map((e) => e.kind)).toContain("kpi_target_hit");
  });

  it("measure-far-off emits kpi_target_missed with gap", async () => {
    const events: ActivityEvent[] = [];
    subscribeMissionControlEvents((e) => events.push(e));

    const impact = await declareKpiImpact({
      companyId: "co-miss",
      taskRefType: "avatar_approval",
      taskRefId: "task-2",
      kpiId: "weekly_leads",
      scopeNodeId: "agent-sales",
      direction: "increase",
      estimatedDelta: 20,
      unit: "leads",
      timeHorizon: "days",
      confidence: 0.5,
      rationale: "Aggressive forecast.",
    });

    const result = await recordKpiMeasurement({
      impactId: impact.id,
      actualDelta: 3, // 85% off
      modeContext: "solo_founder",
      recordedByNodeId: "chief-1",
    });
    expect(result!.outcome).toBe("target_missed");
    expect(result!.variance).toBe(3 - 20);
    const missEvent = events.find((e) => e.kind === "kpi_target_missed");
    expect(missEvent).toBeDefined();
    expect(missEvent!.subjectRef.gap).toBe(17);
  });

  it("getScoreboard aggregates attainment per KPI", async () => {
    for (const delta of [10, 10, 10]) {
      const i = await declareKpiImpact({
        companyId: "co-board",
        taskRefType: "avatar_approval",
        taskRefId: `task-${delta}-${Math.random()}`,
        kpiId: "arr",
        scopeNodeId: "agent-sales",
        direction: "increase",
        estimatedDelta: delta,
        unit: "USD",
        timeHorizon: "weeks",
        confidence: 0.6,
        rationale: "Outbound deal flow.",
      });
      await recordKpiMeasurement({
        impactId: i.id,
        actualDelta: 8, // each one hits 8 → cumulative 24 vs 30 estimated
        modeContext: "solo_founder",
        recordedByNodeId: "chief-1",
      });
    }
    const board = await getScoreboard("co-board");
    expect(board).toHaveLength(1);
    expect(board[0]!.kpiId).toBe("arr");
    expect(board[0]!.cumulativeEstimated).toBe(30);
    expect(board[0]!.cumulativeActual).toBe(24);
    expect(board[0]!.attainmentRatio).toBeCloseTo(24 / 30, 3);
    expect(board[0]!.measuredImpacts).toBe(3);
  });

  it("listDueKpiImpacts returns impacts whose measure_at has passed", async () => {
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60 * 60_000);
    await declareKpiImpact({
      companyId: "co-due",
      taskRefType: "avatar_approval",
      taskRefId: "task-past",
      kpiId: "k1",
      scopeNodeId: "n1",
      direction: "increase",
      estimatedDelta: 1,
      unit: "x",
      timeHorizon: "immediate",
      confidence: 0.5,
      rationale: "test",
      measureAt: past,
    });
    await declareKpiImpact({
      companyId: "co-due",
      taskRefType: "avatar_approval",
      taskRefId: "task-future",
      kpiId: "k1",
      scopeNodeId: "n1",
      direction: "increase",
      estimatedDelta: 1,
      unit: "x",
      timeHorizon: "weeks",
      confidence: 0.5,
      rationale: "test",
      measureAt: future,
    });
    const due = await listDueKpiImpacts("co-due");
    expect(due).toHaveLength(1);
    expect(due[0]!.taskId).toBe("task-past");
  });
});
