/** Accountability graph — verifies edge aggregation + node activity counts. */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetDbCache, runMigrations } from "@wavex-os/db";
import { appendAssignmentLink } from "../src/mission-control/assignment-chain.js";
import { buildAccountabilityGraph } from "../src/mission-control/graph.js";
import { invalidateAllScopeTrees } from "../src/mission-control/scope-tree-cache.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "wavex-mc-graph-"));
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

function makeAvatarInstance(avatarId: string) {
  // ScopeTree's avatar mode reads avatars/<id>/profile.json and the
  // optional tools.json. We only need profile.json for the tree to be
  // resolvable; tools.json is optional.
  const dir = join(
    tempDir,
    "instances",
    "default",
    "avatars",
    avatarId,
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "profile.json"),
    JSON.stringify({
      name: `Test Avatar ${avatarId}`,
      role: "general",
      tz: "America/New_York",
      working_hours: ["09:00", "17:00"],
    }),
  );
}

describe("accountability graph", () => {
  it("aggregates edges + activity from assignment links", async () => {
    const companyId = "av-graph";
    makeAvatarInstance(companyId);

    for (let i = 0; i < 3; i += 1) {
      await appendAssignmentLink({
        companyId,
        instanceId: companyId,
        modeContext: "avatar",
        taskRefType: "avatar_approval",
        taskRefId: `task-${i}`,
        kind: "assigned",
        fromNodeId: "chief-1",
        toNodeId: "agent-mail",
        reason: "triage",
      });
    }
    await appendAssignmentLink({
      companyId,
      instanceId: companyId,
      modeContext: "avatar",
      taskRefType: "avatar_approval",
      taskRefId: "task-delegate",
      kind: "delegated",
      fromNodeId: "agent-mail",
      toNodeId: "agent-cal",
      reason: "needs calendar context",
    });

    const graph = await buildAccountabilityGraph({ companyId });
    expect(graph).not.toBeNull();
    expect(graph!.totalWorkEvents).toBe(4);
    const chiefMailEdge = graph!.workEdges.find(
      (e) => e.fromNodeId === "chief-1" && e.toNodeId === "agent-mail",
    );
    expect(chiefMailEdge?.weight).toBe(3);
    const mailCalEdge = graph!.workEdges.find(
      (e) => e.fromNodeId === "agent-mail" && e.toNodeId === "agent-cal",
    );
    expect(mailCalEdge?.weight).toBe(1);
  });

  it("returns null when the instance has no scope tree", async () => {
    const graph = await buildAccountabilityGraph({
      companyId: "no-such-instance",
    });
    expect(graph).toBeNull();
  });

  it("filters edges by since/until window", async () => {
    const companyId = "av-window";
    makeAvatarInstance(companyId);
    await appendAssignmentLink({
      companyId,
      instanceId: companyId,
      modeContext: "avatar",
      taskRefType: "avatar_approval",
      taskRefId: "task-window",
      kind: "assigned",
      fromNodeId: "n1",
      toNodeId: "n2",
    });
    const future = new Date(Date.now() + 60_000);
    const farFuture = new Date(Date.now() + 120_000);
    const graph = await buildAccountabilityGraph({
      companyId,
      since: future,
      until: farFuture,
    });
    expect(graph!.totalWorkEvents).toBe(0);
  });
});
