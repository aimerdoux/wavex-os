/** Chief of Staff — config persistence, rule list, trigger evaluation. */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetDbCache, runMigrations } from "@wavex-os/db";
import {
  addOriginationRule,
  evaluateChiefTriggers,
  getChiefConfig,
  listOriginationRules,
  upsertChiefConfig,
} from "../src/mission-control/chief-of-staff.js";
import { appendAssignmentLink } from "../src/mission-control/assignment-chain.js";
import {
  declareKpiImpact,
  recordKpiMeasurement,
} from "../src/mission-control/kpi-impacts.js";
import { invalidateAllScopeTrees } from "../src/mission-control/scope-tree-cache.js";
import {
  _resetActivityBusForTesting,
  subscribeMissionControlEvents,
} from "../src/mission-control/activity-bus.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "wavex-mc-chief-"));
  process.env.WAVEX_OS_STATE_DIR = tempDir;
  process.env.WAVEX_DB_DATA_DIR = join(tempDir, "db");
  _resetDbCache();
  _resetActivityBusForTesting();
  invalidateAllScopeTrees();
  await runMigrations();
});

afterEach(() => {
  delete process.env.WAVEX_OS_STATE_DIR;
  delete process.env.WAVEX_DB_DATA_DIR;
  rmSync(tempDir, { recursive: true, force: true });
});

function makeAvatar(avatarId: string, agents: Record<string, string> = {}) {
  const dir = join(tempDir, "instances", "default", "avatars", avatarId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "profile.json"),
    JSON.stringify({
      name: "Test",
      role: "general",
      tz: "America/New_York",
      working_hours: ["09:00", "17:00"],
    }),
  );
  writeFileSync(
    join(dir, "paperclip-handoff.json"),
    JSON.stringify({
      paperclipCompanyId: avatarId,
      conductorAgentId: agents.conductor,
      agents,
    }),
  );
}

describe("chief of staff", () => {
  it("upserts config, lists rules, and round-trips through getChiefConfig", async () => {
    const cfg = await upsertChiefConfig({
      instanceId: "co-chief",
      mode: "solo_founder",
      dailyBudgetUSD: 5,
      cooldownMinutes: 30,
      maxOriginationsPerDay: 10,
    });
    expect(cfg.dailyBudgetUSD).toBe(5);
    const rule = await addOriginationRule({
      instanceId: "co-chief",
      name: "ARR slipping",
      description: "Alert when ARR attainment drops",
      triggerKind: "kpi_threshold",
      triggerConfig: { kpiId: "arr", minRatio: 0.8 },
      taskTemplate: {
        title: "Investigate ARR slip",
        description: "Find what changed",
        assigneeStrategy: "best_performer_for_kpi",
      },
      enabled: true,
    });
    expect(rule.id).toBeTruthy();
    const rules = await listOriginationRules("co-chief");
    expect(rules).toHaveLength(1);
    const reload = await getChiefConfig("co-chief");
    expect(reload!.originationRules).toHaveLength(1);
    expect(reload!.originationRules[0]!.name).toBe("ARR slipping");
  });

  it("emits chief_pattern_detected when a kpi_threshold rule fires", async () => {
    const events: string[] = [];
    subscribeMissionControlEvents((e) => events.push(e.kind));

    await upsertChiefConfig({
      instanceId: "co-fire",
      mode: "solo_founder",
    });
    await addOriginationRule({
      instanceId: "co-fire",
      name: "Leads below 50%",
      description: "",
      triggerKind: "kpi_threshold",
      triggerConfig: { kpiId: "weekly_leads", minRatio: 0.5 },
      taskTemplate: {
        title: "Boost leads",
        description: "Push outreach",
        assigneeStrategy: "least_loaded_in_scope",
      },
      enabled: true,
    });
    // Seed a KPI measurement that's below threshold (attainment 0.3).
    const impact = await declareKpiImpact({
      companyId: "co-fire",
      taskRefType: "avatar_approval",
      taskRefId: "t-1",
      kpiId: "weekly_leads",
      scopeNodeId: "agent-sales",
      direction: "increase",
      estimatedDelta: 10,
      unit: "leads",
      timeHorizon: "days",
      confidence: 0.6,
      rationale: "Outbound forecast",
    });
    await recordKpiMeasurement({
      impactId: impact.id,
      actualDelta: 3,
      modeContext: "solo_founder",
      recordedByNodeId: "chief-1",
    });

    const result = await evaluateChiefTriggers({
      instanceId: "co-fire",
      modeContext: "solo_founder",
    });
    expect(result.triggered).toHaveLength(1);
    expect(result.triggered[0]!.eventKind).toBe("chief_pattern_detected");
    expect(events).toContain("chief_pattern_detected");
  });

  it("emits chief_rebalance_recommended for capacity_imbalance", async () => {
    const companyId = "av-balance";
    // The capacity check pulls from the AccountabilityGraph which filters
    // node activity by membership in the scope tree, so the test fixture
    // has to register the same agent ids the assignment links reference.
    const agents = { conductor: "chief-1", mail: "agent-A", cal: "agent-B" };
    makeAvatar(companyId, agents);
    await upsertChiefConfig({
      instanceId: companyId,
      mode: "avatar",
    });
    await addOriginationRule({
      instanceId: companyId,
      name: "Rebalance",
      description: "",
      triggerKind: "capacity_imbalance",
      triggerConfig: { imbalanceRatio: 1.5 },
      taskTemplate: {
        title: "Rebalance load",
        description: "Move work to lighter nodes",
        assigneeStrategy: "least_loaded_in_scope",
      },
      enabled: true,
    });
    // Skew activity: 5 assignments to agent-A, 1 to agent-B.
    const chief = "agent:chief-1";
    const a = "agent:agent-A";
    const b = "agent:agent-B";
    for (let i = 0; i < 5; i += 1) {
      await appendAssignmentLink({
        companyId,
        instanceId: companyId,
        modeContext: "avatar",
        taskRefType: "avatar_approval",
        taskRefId: `t-A-${i}`,
        kind: "assigned",
        fromNodeId: chief,
        toNodeId: a,
      });
    }
    await appendAssignmentLink({
      companyId,
      instanceId: companyId,
      modeContext: "avatar",
      taskRefType: "avatar_approval",
      taskRefId: "t-B-1",
      kind: "assigned",
      fromNodeId: chief,
      toNodeId: b,
    });
    const events: string[] = [];
    subscribeMissionControlEvents((e) => events.push(e.kind));

    const result = await evaluateChiefTriggers({
      instanceId: companyId,
      modeContext: "avatar",
    });
    expect(result.triggered).toHaveLength(1);
    expect(result.triggered[0]!.eventKind).toBe("chief_rebalance_recommended");
    expect(events).toContain("chief_rebalance_recommended");
  });

  it("skips disabled rules", async () => {
    await upsertChiefConfig({ instanceId: "co-skip", mode: "solo_founder" });
    await addOriginationRule({
      instanceId: "co-skip",
      name: "Disabled rule",
      description: "",
      triggerKind: "schedule",
      triggerConfig: {},
      taskTemplate: { title: "x", description: "y", assigneeStrategy: "least_loaded_in_scope" },
      enabled: false,
    });
    const result = await evaluateChiefTriggers({
      instanceId: "co-skip",
      modeContext: "solo_founder",
    });
    expect(result.triggered).toHaveLength(0);
    expect(result.skipped).toBe(1);
  });
});
