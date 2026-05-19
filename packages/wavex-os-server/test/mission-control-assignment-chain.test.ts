/** AssignmentLink chain — append, query, current-owner reconstruction. */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetDbCache, runMigrations } from "@wavex-os/db";
import {
  appendAssignmentLink,
  currentOwnerOf,
  listOpenAssignmentsForNode,
  queryAssignmentChain,
} from "../src/mission-control/assignment-chain.js";
import {
  _resetActivityBusForTesting,
  subscribeMissionControlEvents,
} from "../src/mission-control/activity-bus.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "wavex-mc-chain-"));
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

const baseInput = {
  companyId: "co-chain",
  instanceId: "co-chain",
  modeContext: "solo_founder" as const,
  taskRefType: "mission_control_task" as const,
  taskRefId: "task-1",
};

describe("assignment-chain", () => {
  it("appends links and reconstructs chain in order", async () => {
    const events: string[] = [];
    subscribeMissionControlEvents((e) => events.push(e.kind));

    await appendAssignmentLink({
      ...baseInput,
      kind: "originated",
      toNodeId: "chief-1",
      reason: "Originated by chief",
    });
    await appendAssignmentLink({
      ...baseInput,
      kind: "assigned",
      fromNodeId: "chief-1",
      toNodeId: "agent-sales",
      reason: "best fit",
    });
    await appendAssignmentLink({
      ...baseInput,
      kind: "accepted",
      fromNodeId: "agent-sales",
      toNodeId: "agent-sales",
    });

    const chain = await queryAssignmentChain("task-1");
    expect(chain).toHaveLength(3);
    expect(chain[1]!.fromNodeId).toBe("chief-1");
    expect(chain[1]!.toNodeId).toBe("agent-sales");
    expect(chain[2]!.acceptedAt).toBeTruthy();

    // task_originated + task_assigned + task_accepted (event kinds)
    expect(events).toContain("task_originated");
    expect(events).toContain("task_assigned");
    expect(events).toContain("task_accepted");
  });

  it("currentOwnerOf walks to the latest assigned/delegated/accepted entry", async () => {
    await appendAssignmentLink({
      ...baseInput,
      taskRefId: "task-owner",
      kind: "assigned",
      fromNodeId: "chief-1",
      toNodeId: "agent-sales",
    });
    await appendAssignmentLink({
      ...baseInput,
      taskRefId: "task-owner",
      kind: "delegated",
      fromNodeId: "agent-sales",
      toNodeId: "agent-eng",
      reason: "needs SQL",
    });
    expect(await currentOwnerOf("task-owner")).toBe("agent-eng");

    await appendAssignmentLink({
      ...baseInput,
      taskRefId: "task-owner",
      kind: "rejected",
      fromNodeId: "agent-eng",
      toNodeId: "agent-sales",
      reason: "out of scope",
    });
    // Rejected → ownership rolls back to fromNodeId in our reconstruction.
    expect(await currentOwnerOf("task-owner")).toBe("agent-eng");
  });

  it("listOpenAssignmentsForNode surfaces only still-open links", async () => {
    await appendAssignmentLink({
      ...baseInput,
      taskRefId: "task-open",
      kind: "assigned",
      fromNodeId: "chief-1",
      toNodeId: "agent-sales",
    });
    await appendAssignmentLink({
      ...baseInput,
      taskRefId: "task-closed",
      kind: "assigned",
      fromNodeId: "chief-1",
      toNodeId: "agent-sales",
    });
    await appendAssignmentLink({
      ...baseInput,
      taskRefId: "task-closed",
      kind: "completed",
      fromNodeId: "agent-sales",
      toNodeId: "agent-sales",
    });

    const open = await listOpenAssignmentsForNode("agent-sales");
    const ids = open.map((r) => r.taskRefId);
    expect(ids).toContain("task-open");
    expect(ids).not.toContain("task-closed");
  });

  it("currentOwnerOf returns null when chain ends in terminal state", async () => {
    await appendAssignmentLink({
      ...baseInput,
      taskRefId: "task-done",
      kind: "assigned",
      fromNodeId: "chief-1",
      toNodeId: "agent-sales",
    });
    await appendAssignmentLink({
      ...baseInput,
      taskRefId: "task-done",
      kind: "completed",
      fromNodeId: "agent-sales",
      toNodeId: "agent-sales",
    });
    expect(await currentOwnerOf("task-done")).toBeNull();
  });
});
