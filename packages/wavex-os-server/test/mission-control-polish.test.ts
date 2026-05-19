/** Phase 7 polish — cost / capacity / weekly export aggregates. */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetDbCache, runMigrations } from "@wavex-os/db";
import {
  buildWeeklyExport,
  exportToCsv,
  getCapacity,
  getCostDashboard,
} from "../src/mission-control/polish.js";
import { appendAssignmentLink } from "../src/mission-control/assignment-chain.js";
import { writeDeliverable } from "../src/mission-control/deliverables.js";
import { logMissionControlActivity } from "../src/mission-control/activity-log.js";
import { invalidateAllScopeTrees } from "../src/mission-control/scope-tree-cache.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "wavex-mc-polish-"));
  process.env.WAVEX_OS_STATE_DIR = tempDir;
  process.env.WAVEX_DB_DATA_DIR = join(tempDir, "db");
  _resetDbCache();
  invalidateAllScopeTrees();
  await runMigrations();
});

afterEach(() => {
  delete process.env.WAVEX_OS_STATE_DIR;
  delete process.env.WAVEX_DB_DATA_DIR;
  rmSync(tempDir, { recursive: true, force: true });
});

function makeAvatar(avatarId: string) {
  const dir = join(tempDir, "instances", "default", "avatars", avatarId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "profile.json"),
    JSON.stringify({
      name: "Avatar Polish",
      role: "general",
      tz: "America/New_York",
      working_hours: ["09:00", "17:00"],
    }),
  );
}

describe("phase 7 polish", () => {
  it("getCostDashboard sums costUSD per node + total", async () => {
    const id = "av-cost";
    makeAvatar(id);
    await logMissionControlActivity({
      companyId: id,
      instanceId: id,
      kind: "task_completed",
      modeContext: "avatar",
      actorNodeId: "agent-mail",
      action: "task.completed",
      subjectRef: { kind: "task" },
      costUSD: 1.5,
    });
    await logMissionControlActivity({
      companyId: id,
      instanceId: id,
      kind: "task_completed",
      modeContext: "avatar",
      actorNodeId: "agent-mail",
      action: "task.completed",
      subjectRef: { kind: "task" },
      costUSD: 2.5,
    });
    await logMissionControlActivity({
      companyId: id,
      instanceId: id,
      kind: "task_completed",
      modeContext: "avatar",
      actorNodeId: "agent-cal",
      action: "task.completed",
      subjectRef: { kind: "task" },
      costUSD: 0.75,
    });
    const cost = await getCostDashboard(id);
    expect(cost.totals.costUSD).toBeCloseTo(4.75, 3);
    expect(cost.totals.events).toBe(3);
    expect(cost.byNode[0]!.nodeId).toBe("agent-mail");
    expect(cost.byNode[0]!.costUSD).toBeCloseTo(4, 3);
    expect(cost.byNode[1]!.nodeId).toBe("agent-cal");
  });

  it("getCapacity counts inbound + outbound per node and computes avg/max", async () => {
    const id = "av-cap";
    makeAvatar(id);
    for (let i = 0; i < 3; i += 1) {
      await appendAssignmentLink({
        companyId: id,
        instanceId: id,
        modeContext: "avatar",
        taskRefType: "avatar_approval",
        taskRefId: `t-${i}`,
        kind: "assigned",
        fromNodeId: "chief-1",
        toNodeId: "agent-mail",
      });
    }
    await appendAssignmentLink({
      companyId: id,
      instanceId: id,
      modeContext: "avatar",
      taskRefType: "avatar_approval",
      taskRefId: "t-cal",
      kind: "assigned",
      fromNodeId: "chief-1",
      toNodeId: "agent-cal",
    });
    const cap = await getCapacity(id);
    const mail = cap.rows.find((r) => r.nodeId === "agent-mail");
    const cal = cap.rows.find((r) => r.nodeId === "agent-cal");
    const chief = cap.rows.find((r) => r.nodeId === "chief-1");
    expect(mail!.inbound).toBe(3);
    expect(cal!.inbound).toBe(1);
    expect(chief!.outbound).toBe(4);
    expect(cap.max).toBe(4);
    expect(cap.avg).toBeCloseTo(8 / 3, 3);
  });

  it("buildWeeklyExport summarizes a week + exports to CSV", async () => {
    const id = "av-export";
    makeAvatar(id);
    await writeDeliverable({
      companyId: id,
      instanceId: id,
      modeContext: "avatar",
      taskRefType: "avatar_approval",
      taskRefId: "task-1",
      producedByNodeId: "agent-mail",
      kind: "email_draft",
      title: "Test draft",
    });
    await appendAssignmentLink({
      companyId: id,
      instanceId: id,
      modeContext: "avatar",
      taskRefType: "avatar_approval",
      taskRefId: "task-1",
      kind: "assigned",
      fromNodeId: "chief-1",
      toNodeId: "agent-mail",
    });
    await logMissionControlActivity({
      companyId: id,
      instanceId: id,
      kind: "task_completed",
      modeContext: "avatar",
      actorNodeId: "agent-mail",
      action: "task.completed",
      subjectRef: { kind: "task" },
      costUSD: 1.25,
    });
    const weekly = await buildWeeklyExport(id);
    expect(weekly.summary.deliverables).toBe(1);
    expect(weekly.summary.assignments).toBe(1);
    expect(weekly.summary.costUSD).toBeCloseTo(1.25, 3);
    expect(weekly.summary.events).toBeGreaterThanOrEqual(1);
    const csv = exportToCsv(weekly);
    expect(csv).toContain("summary,,,deliverables,1");
    expect(csv).toContain("capacity");
    expect(csv).toContain("cost");
  });
});
