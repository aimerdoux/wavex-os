/** Mission Control Deliverables — write + query round-trip. */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetDbCache, runMigrations } from "@wavex-os/db";
import {
  writeDeliverable,
  queryDeliverables,
  deliverableFolder,
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
