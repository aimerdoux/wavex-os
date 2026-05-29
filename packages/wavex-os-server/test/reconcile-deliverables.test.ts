/** Auto-producer — artifact-block parsing + issue→deliverable reconcile. */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetDbCache, runMigrations } from "@wavex-os/db";
import { parseArtifactBlock } from "../src/mission-control/artifact-block.js";
import {
  reconcileDeliverables,
  isTerminalState,
  type ReconcileIssue,
} from "../src/mission-control/reconcile-deliverables.js";
import { queryDeliverables } from "../src/mission-control/deliverables.js";
import { _resetActivityBusForTesting } from "../src/mission-control/activity-bus.js";

describe("parseArtifactBlock", () => {
  it("parses kind/title/mime + body after ---", () => {
    const text = [
      "Some preamble comment.",
      "```wavex-artifact",
      "kind: document",
      "title: Q3 campaign brief",
      "mime: text/markdown",
      "---",
      "# Q3 Campaign",
      "Launch the autumn line.",
      "```",
      "trailing text",
    ].join("\n");
    const p = parseArtifactBlock(text);
    expect(p).not.toBeNull();
    expect(p!.kind).toBe("document");
    expect(p!.title).toBe("Q3 campaign brief");
    expect(p!.mimeType).toBe("text/markdown");
    expect(p!.content).toBe("# Q3 Campaign\nLaunch the autumn line.");
  });

  it("returns null when there is no block", () => {
    expect(parseArtifactBlock("just a normal comment")).toBeNull();
    expect(parseArtifactBlock("")).toBeNull();
    expect(parseArtifactBlock(null)).toBeNull();
  });

  it("returns null when title is missing", () => {
    const text = "```wavex-artifact\nkind: document\n---\nbody\n```";
    expect(parseArtifactBlock(text)).toBeNull();
  });

  it("defaults unknown/absent kind to document", () => {
    const text = "```wavex-artifact\nkind: wat\ntitle: T\n---\nx\n```";
    expect(parseArtifactBlock(text)!.kind).toBe("document");
    const text2 = "```wavex-artifact\ntitle: T2\n---\nx\n```";
    expect(parseArtifactBlock(text2)!.kind).toBe("document");
  });

  it("treats a header-only block (no ---) as empty content", () => {
    const text = "```wavex-artifact\ntitle: Header only\nkind: document\n```";
    const p = parseArtifactBlock(text);
    expect(p).not.toBeNull();
    expect(p!.content).toBe("");
  });
});

describe("isTerminalState", () => {
  it("matches terminal hints loosely, rejects open states", () => {
    for (const s of ["done", "Closed", "completed", "resolved", "VERIFIED", "delivered"]) {
      expect(isTerminalState(s)).toBe(true);
    }
    for (const s of ["open", "in progress", "assigned", "", null, undefined]) {
      expect(isTerminalState(s)).toBe(false);
    }
  });
});

describe("reconcileDeliverables", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "wavex-reconcile-"));
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

  const withBlock = (id: string, state: string): ReconcileIssue => ({
    id,
    state,
    title: `Issue ${id}`,
    body: `done\n\`\`\`wavex-artifact\ntitle: Output ${id}\nkind: document\n---\nthe artifact for ${id}\n\`\`\``,
    assignee: "agent-cmo",
  });

  it("materializes a git-committed deliverable for a completed issue with a block", async () => {
    const r = await reconcileDeliverables({
      companyId: "co-r",
      instanceId: "co-r",
      issues: [withBlock("WAV-1", "done")],
    });
    expect(r.created).toHaveLength(1);
    expect(r.skipped).toBe(0);

    const got = await queryDeliverables({ companyId: "co-r", taskRefId: "WAV-1" });
    expect(got).toHaveLength(1);
    expect(got[0]!.title).toBe("Output WAV-1");
    expect(got[0]!.producedByNodeId).toBe("agent-cmo");
    // Git-first: the reconciled deliverable carries a commit.
    expect(got[0]!.commitSha).toMatch(/^[a-f0-9]{40,64}$/);
  });

  it("skips non-terminal issues and issues without a block", async () => {
    const r = await reconcileDeliverables({
      companyId: "co-r2",
      instanceId: "co-r2",
      issues: [
        withBlock("WAV-2", "in progress"), // has block but not terminal
        { id: "WAV-3", state: "done", title: "no block", body: "just closed it" },
      ],
    });
    expect(r.created).toHaveLength(0);
    expect(r.skipped).toBe(0);
  });

  it("is idempotent — a second run skips the already-captured issue", async () => {
    const issues = [withBlock("WAV-4", "completed")];
    const first = await reconcileDeliverables({ companyId: "co-r3", instanceId: "co-r3", issues });
    expect(first.created).toHaveLength(1);

    const second = await reconcileDeliverables({ companyId: "co-r3", instanceId: "co-r3", issues });
    expect(second.created).toHaveLength(0);
    expect(second.skipped).toBe(1);

    const got = await queryDeliverables({ companyId: "co-r3", taskRefId: "WAV-4" });
    expect(got).toHaveLength(1); // not duplicated
  });
});
