/** Mission Control Deliverables — write + query round-trip. */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetDbCache, runMigrations } from "@wavex-os/db";
import {
  writeDeliverable,
  queryDeliverables,
  deliverableFolder,
  verifyDeliverable,
} from "../src/mission-control/deliverables.js";
import {
  _resetActivityBusForTesting,
  subscribeMissionControlEvents,
} from "../src/mission-control/activity-bus.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "wavex-mc-deliv-"));
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

describe("writeDeliverable", () => {
  it("writes a row + disk envelope + emits deliverable_produced", async () => {
    const received: string[] = [];
    subscribeMissionControlEvents((e) => received.push(e.kind));

    const d = await writeDeliverable({
      companyId: "co-test",
      instanceId: "avatar-1",
      modeContext: "avatar",
      taskRefType: "avatar_approval",
      taskRefId: "apv_abc",
      producedByNodeId: "agent-mail",
      kind: "email_draft",
      title: "Reply: hello",
      description: "Draft reply",
      previewText: "Hi there,",
      mimeType: "text/plain",
      payload: { draftText: "Hi there, thanks for reaching out." },
    });

    expect(d.id).toBeTruthy();
    expect(d.kind).toBe("email_draft");
    expect(d.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(d.sizeBytes).toBeGreaterThan(0);
    expect(existsSync(d.diskPath)).toBe(true);
    const onDisk = JSON.parse(readFileSync(d.diskPath, "utf8"));
    expect(onDisk.title).toBe("Reply: hello");
    expect(onDisk.payload.draftText).toContain("thanks for reaching out");

    expect(received).toEqual(["deliverable_produced"]);
  });

  it("queries by kind + taskRefId", async () => {
    await writeDeliverable({
      companyId: "co-q",
      instanceId: "avatar-1",
      modeContext: "avatar",
      taskRefType: "avatar_approval",
      taskRefId: "task-1",
      producedByNodeId: "agent-mail",
      kind: "email_draft",
      title: "Mail 1",
    });
    await writeDeliverable({
      companyId: "co-q",
      instanceId: "avatar-1",
      modeContext: "avatar",
      taskRefType: "avatar_approval",
      taskRefId: "task-2",
      producedByNodeId: "agent-cal",
      kind: "meeting_artifact",
      title: "Invite reply",
    });
    const emails = await queryDeliverables({
      companyId: "co-q",
      kind: "email_draft",
    });
    expect(emails).toHaveLength(1);
    expect(emails[0]!.title).toBe("Mail 1");

    const byTask = await queryDeliverables({
      companyId: "co-q",
      taskRefId: "task-2",
    });
    expect(byTask).toHaveLength(1);
    expect(byTask[0]!.kind).toBe("meeting_artifact");
  });

  it("deliverableFolder returns the directory + path", async () => {
    const d = await writeDeliverable({
      companyId: "co-f",
      instanceId: "avatar-1",
      modeContext: "avatar",
      taskRefType: "avatar_approval",
      taskRefId: "task-folder",
      producedByNodeId: "agent-mail",
      kind: "document",
      title: "Some doc",
    });
    const f = await deliverableFolder(d.id);
    expect(f).not.toBeNull();
    expect(f!.diskPath).toBe(d.diskPath);
    expect(f!.folder).toMatch(/deliverables$/);
  });
});

describe("git-first deliverable artifact", () => {
  it("commits the artifact and the commit resolves via git", async () => {
    const d = await writeDeliverable({
      companyId: "co-git",
      instanceId: "co-git",
      modeContext: "solo_founder",
      taskRefType: "issue",
      taskRefId: "WAV-100",
      producedByNodeId: "agent-cmo",
      kind: "document",
      title: "Q3 campaign brief",
      payload: { body: "Launch the autumn line via IG + email." },
    });

    // commit_sha is recorded (git sha1 = 40 hex, sha256 = 64 hex).
    expect(d.commitSha).toMatch(/^[a-f0-9]{40,64}$/);
    expect(d.gitRef).toBe("main");

    // The recorded commit resolves in the deliverables repo, and the file
    // is part of that commit.
    const dir = dirname(d.diskPath);
    expect(() =>
      execFileSync("git", ["cat-file", "-e", `${d.commitSha}^{commit}`], { cwd: dir }),
    ).not.toThrow();
    const tree = execFileSync("git", ["show", "--stat", "--oneline", d.commitSha!], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(tree).toContain(d.relPath);
  });

  it("verifyDeliverable flips a clean artifact to verified", async () => {
    const received: string[] = [];
    subscribeMissionControlEvents((e) => received.push(e.kind));

    const d = await writeDeliverable({
      companyId: "co-v",
      instanceId: "co-v",
      modeContext: "solo_founder",
      taskRefType: "issue",
      taskRefId: "WAV-200",
      producedByNodeId: "agent-strategy",
      kind: "document",
      title: "GTM plan",
      payload: { body: "Plan body." },
    });

    const result = await verifyDeliverable(d.id, "reviewer-cto");
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(true);
    expect(result!.status).toBe("verified");
    expect(result!.deliverable.status).toBe("verified");
    expect(result!.deliverable.reviewedByNodeId).toBe("reviewer-cto");
    expect(received).toContain("deliverable_verified");
  });

  it("verifyDeliverable fails when the on-disk artifact is tampered", async () => {
    const d = await writeDeliverable({
      companyId: "co-t",
      instanceId: "co-t",
      modeContext: "solo_founder",
      taskRefType: "issue",
      taskRefId: "WAV-300",
      producedByNodeId: "agent-x",
      kind: "document",
      title: "Tamper test",
      payload: { body: "original" },
    });

    // Mutate the artifact on disk after it was recorded + committed.
    writeFileSync(d.diskPath, JSON.stringify({ tampered: true }), "utf8");

    const result = await verifyDeliverable(d.id, undefined);
    expect(result!.ok).toBe(false);
    expect(result!.status).toBe("failed");
    expect(result!.reason).toMatch(/hash mismatch/i);
  });
});
