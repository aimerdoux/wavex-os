/** Mission Control — Deliverable write + read helpers.
 *
 *  Phase 2 (Task → Deliverable). A Deliverable is the artifact a node
 *  produced while working a task; the spec invariant is "every successful
 *  task has at least one Deliverable." We write to the @wavex-os/db table
 *  introduced in Phase 0.3 and emit a `deliverable_produced` Mission
 *  Control event so the Stream widget surfaces it in real time.
 *
 *  Disk path conventions (Phase 0 open question, resolved here):
 *    - Avatar mode   : ~/.wavex-os/instances/default/avatars/<id>/deliverables/<id>.json
 *    - Company mode  : ~/.wavex-os/instances/default/companies/<id>/deliverables/<id>.json
 *
 *  We write a small JSON envelope to disk so the folder-reveal route
 *  (Phase 2.2) has something to surface. Runners can call this without
 *  knowing the layout; `writeDeliverable()` computes the path. */

import { randomUUID, createHash } from "node:crypto";
import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { and, desc, eq } from "drizzle-orm";

const execFileAsync = promisify(execFile);
import {
  type Db,
  deliverables,
  getDb,
  type DeliverableInsert,
} from "@wavex-os/db";
import type {
  ActivityEventKind,
  DeliverableKind,
  DeliverableStatus,
  PaperclipMode,
  Deliverable as DeliverableShape,
  TaskRef,
} from "@wavex-os/shared/types/mission-control";
import { getWavexDataRoot } from "../state-bridge.js";
import { logMissionControlActivity } from "./activity-log.js";

export interface WriteDeliverableInput {
  companyId: string;
  instanceId: string;
  modeContext: PaperclipMode;
  /** Discriminator for the upstream record type — issues|avatar_approval|mission_control_task. */
  taskRefType: "issue" | "avatar_approval" | "mission_control_task";
  taskRefId: string;
  producedByNodeId: string;
  kind: DeliverableKind;
  title: string;
  description?: string;
  previewText?: string;
  mimeType?: string;
  status?: DeliverableStatus;
  /** Raw payload — serialized to disk + hashed for content addressing. */
  payload?: unknown;
  templateUsed?: string;
  promptUsedRef?: string;
  expectedKpiImpactId?: string;
  /** Optional override for the on-disk filename. Defaults to <id>.json. */
  filename?: string;
  /** Optional richer task ref for the activity event. */
  taskRef?: TaskRef;
  /** Optional plain-language sentence override for the event. */
  plainLanguageSentence?: string;
}

function deliverableDir(input: WriteDeliverableInput): string {
  const root = getWavexDataRoot();
  const base = join(root, "instances", "default");
  if (input.modeContext === "avatar") {
    return join(base, "avatars", input.instanceId, "deliverables");
  }
  return join(base, "companies", input.instanceId, "deliverables");
}

function deliverableActionForKind(kind: DeliverableKind): string {
  switch (kind) {
    case "email_draft":
      return "deliverable.email_draft.produced";
    case "message_draft":
      return "deliverable.message_draft.produced";
    case "document":
      return "deliverable.document.produced";
    case "code":
      return "deliverable.code.produced";
    case "data_artifact":
      return "deliverable.data_artifact.produced";
    default:
      return `deliverable.${kind}.produced`;
  }
}

const PRODUCED_EVENT: ActivityEventKind = "deliverable_produced";
const VERIFIED_EVENT: ActivityEventKind = "deliverable_verified";

// Inline committer identity so we never depend on the operator's global
// git config (which may be unset on a fresh box). Local-only repo.
const GIT_IDENT = [
  "-c", "user.email=deliverables@wavex-os.local",
  "-c", "user.name=WaveX Deliverables",
];

async function gitDir(dir: string): Promise<boolean> {
  try {
    await stat(join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

/** Commit one artifact file into the per-company deliverables git repo so
 *  it is verifiable via `git -C <dir> show <sha>`. Lazily `git init`s the
 *  repo on first write. Best-effort: returns null on any git failure so
 *  the caller still records the DB row (the row is the source of truth;
 *  the commit is the proof layer). */
async function commitArtifact(
  dir: string,
  relPath: string,
  message: string,
): Promise<{ commitSha: string; gitRef: string } | null> {
  try {
    if (!(await gitDir(dir))) {
      await execFileAsync("git", ["init", "-q"], { cwd: dir });
      // Pin a deterministic default branch — older git defaults to master.
      await execFileAsync("git", ["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: dir }).catch(() => {});
    }
    await execFileAsync("git", ["add", "--", relPath], { cwd: dir });
    await execFileAsync(
      "git",
      [...GIT_IDENT, "commit", "-q", "-m", message, "--", relPath],
      { cwd: dir },
    );
    const { stdout: sha } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: dir });
    const { stdout: ref } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir });
    return { commitSha: sha.trim(), gitRef: ref.trim() };
  } catch {
    return null;
  }
}

/** Write a Deliverable row + JSON envelope to disk + emit MC event.
 *  Returns the canonical Deliverable shape. Best-effort disk write — a
 *  filesystem failure logs the deliverable row anyway because the row
 *  is the source of truth, and the disk artifact is a convenience. */
export async function writeDeliverable(
  input: WriteDeliverableInput,
  db?: Db,
): Promise<DeliverableShape> {
  const resolved = db ?? (await getDb());
  const id = randomUUID();
  const status: DeliverableStatus = input.status ?? "draft";
  const mimeType = input.mimeType ?? "application/json";
  const description = input.description ?? "";
  const filename = input.filename ?? `${id}.json`;
  const dir = deliverableDir(input);
  const diskPath = join(dir, filename);

  // Serialize the payload to a JSON envelope for the folder-reveal route.
  const envelope = JSON.stringify(
    {
      id,
      kind: input.kind,
      title: input.title,
      description,
      producedByNodeId: input.producedByNodeId,
      taskRefType: input.taskRefType,
      taskRefId: input.taskRefId,
      payload: input.payload ?? null,
      writtenAt: new Date().toISOString(),
    },
    null,
    2,
  );
  const contentHash = createHash("sha256").update(envelope).digest("hex");
  const sizeBytes = Buffer.byteLength(envelope, "utf8");

  let commitSha = "";
  let gitRef = "";
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(diskPath, envelope, "utf8");
    // Git-first: commit the artifact so it is verifiable. Best-effort —
    // a git failure leaves commitSha empty and the row is still written.
    const committed = await commitArtifact(
      dir,
      filename,
      `deliverable(${input.kind}): ${input.title} [${input.taskRefType}:${input.taskRefId}]`,
    );
    if (committed) {
      commitSha = committed.commitSha;
      gitRef = committed.gitRef;
    }
  } catch {
    // Disk write is best-effort — the DB row is the canonical record.
  }

  const row: DeliverableInsert = {
    id,
    companyId: input.companyId,
    instanceId: input.instanceId,
    taskRefType: input.taskRefType,
    taskRefId: input.taskRefId,
    producedByNodeId: input.producedByNodeId,
    kind: input.kind,
    diskPath,
    relPath: filename,
    sizeBytes,
    contentHash,
    commitSha,
    gitRef,
    title: input.title,
    description,
    previewText: input.previewText ?? null,
    mimeType,
    status,
    templateUsed: input.templateUsed ?? null,
    promptUsedRef: input.promptUsedRef ?? null,
    expectedKpiImpactId: input.expectedKpiImpactId ?? null,
  };
  const inserted = await resolved.insert(deliverables).values(row).returning();
  const stored = inserted[0];
  if (!stored) {
    throw new Error("writeDeliverable insert returned no row");
  }

  const deliverable: DeliverableShape = rowToDeliverable(stored);

  await logMissionControlActivity({
    companyId: input.companyId,
    instanceId: input.instanceId,
    kind: PRODUCED_EVENT,
    modeContext: input.modeContext,
    actorNodeId: input.producedByNodeId,
    action: deliverableActionForKind(input.kind),
    subjectRef: {
      kind: "deliverable",
      id,
      title: input.title,
    },
    taskRef: input.taskRef,
    deliverableRef: {
      id,
      title: input.title,
      kind: input.kind,
    },
    plainLanguageSentence: input.plainLanguageSentence,
  });

  return deliverable;
}

export interface QueryDeliverablesInput {
  companyId: string;
  kind?: DeliverableKind;
  taskRefId?: string;
  status?: DeliverableStatus;
  producedByNodeId?: string;
  limit?: number;
}

export async function queryDeliverables(
  input: QueryDeliverablesInput,
  db?: Db,
): Promise<DeliverableShape[]> {
  const resolved = db ?? (await getDb());
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const conds = [eq(deliverables.companyId, input.companyId)];
  if (input.kind) conds.push(eq(deliverables.kind, input.kind));
  if (input.taskRefId) conds.push(eq(deliverables.taskRefId, input.taskRefId));
  if (input.status) conds.push(eq(deliverables.status, input.status));
  if (input.producedByNodeId)
    conds.push(eq(deliverables.producedByNodeId, input.producedByNodeId));
  const rows = await resolved
    .select()
    .from(deliverables)
    .where(and(...conds))
    .orderBy(desc(deliverables.producedAt))
    .limit(limit);
  return rows.map(rowToDeliverable);
}

export async function getDeliverable(
  id: string,
  db?: Db,
): Promise<DeliverableShape | null> {
  const resolved = db ?? (await getDb());
  const rows = await resolved
    .select()
    .from(deliverables)
    .where(eq(deliverables.id, id))
    .limit(1);
  const row = rows[0];
  return row ? rowToDeliverable(row) : null;
}

function rowToDeliverable(row: typeof deliverables.$inferSelect): DeliverableShape {
  return {
    id: row.id,
    instanceId: row.instanceId,
    taskId: row.taskRefId,
    producedByNodeId: row.producedByNodeId,
    producedAt: row.producedAt.toISOString(),
    kind: row.kind as DeliverableKind,
    diskPath: row.diskPath,
    relPath: row.relPath,
    sizeBytes: row.sizeBytes,
    contentHash: row.contentHash,
    commitSha: row.commitSha || undefined,
    gitRef: row.gitRef || undefined,
    title: row.title,
    description: row.description,
    previewText: row.previewText ?? undefined,
    mimeType: row.mimeType,
    templateUsed: row.templateUsed ?? undefined,
    promptUsedRef: row.promptUsedRef ?? undefined,
    status: row.status as DeliverableStatus,
    reviewedByNodeId: row.reviewedByNodeId ?? undefined,
    reviewedAt: row.reviewedAt?.toISOString(),
    reviewNotes: row.reviewNotes ?? undefined,
    taskRef: {
      id: row.taskRefId,
      title: "",
      status: "originated",
    },
    expectedKpiImpactRef: row.expectedKpiImpactId ?? undefined,
  };
}

/** Folder-reveal: compute the directory containing this deliverable's
 *  on-disk artifact. UIs can then open it via Finder/Explorer using a
 *  platform-specific endpoint (Phase 2.2 wraps this). Returns null if
 *  the deliverable doesn't exist. */
export async function deliverableFolder(
  id: string,
  db?: Db,
): Promise<{ folder: string; diskPath: string } | null> {
  const d = await getDeliverable(id, db);
  if (!d || !d.diskPath) return null;
  return { folder: dirname(d.diskPath), diskPath: d.diskPath };
}

export interface VerifyResult {
  ok: boolean;
  /** Final status written to the row: "verified" on success, "failed" otherwise. */
  status: DeliverableStatus;
  /** Human-readable reason when verification fails. */
  reason?: string;
  deliverable: DeliverableShape;
}

/** Verify a deliverable's git artifact: (1) the recorded commit resolves
 *  in the company's deliverables repo, and (2) the on-disk file still
 *  hashes to the recorded contentHash. Sets status `verified` / `failed`,
 *  stamps reviewedAt, and emits a `deliverable_verified` event. Returns
 *  null if the deliverable id is unknown. */
export async function verifyDeliverable(
  id: string,
  reviewerNodeId: string | undefined,
  db?: Db,
): Promise<VerifyResult | null> {
  const resolved = db ?? (await getDb());
  const rows = await resolved
    .select()
    .from(deliverables)
    .where(eq(deliverables.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  const dir = dirname(row.diskPath);
  const failures: string[] = [];

  // (1) Commit must resolve in the deliverables repo.
  if (row.commitSha) {
    try {
      await execFileAsync("git", ["cat-file", "-e", `${row.commitSha}^{commit}`], { cwd: dir });
    } catch {
      failures.push(`commit ${row.commitSha.slice(0, 10)} not found in deliverables repo`);
    }
  } else {
    failures.push("no commit_sha recorded (artifact was not git-committed)");
  }

  // (2) On-disk content must still match the recorded hash.
  try {
    const buf = await readFile(row.diskPath);
    const actual = createHash("sha256").update(buf).digest("hex");
    if (actual !== row.contentHash) {
      failures.push("content hash mismatch — artifact changed since it was recorded");
    }
  } catch {
    failures.push("artifact file missing on disk");
  }

  const status: DeliverableStatus = failures.length === 0 ? "verified" : "failed";
  const reason = failures.length ? failures.join("; ") : undefined;
  const reviewedAt = new Date();

  const updated = await resolved
    .update(deliverables)
    .set({
      status,
      reviewedByNodeId: reviewerNodeId ?? null,
      reviewedAt,
      reviewNotes: reason ?? null,
    })
    .where(eq(deliverables.id, id))
    .returning();
  const stored = updated[0] ?? row;
  const deliverable = rowToDeliverable(stored);

  const modeContext: PaperclipMode = row.diskPath.includes("/avatars/")
    ? "avatar"
    : "solo_founder";
  await logMissionControlActivity({
    companyId: row.companyId,
    instanceId: row.instanceId,
    kind: VERIFIED_EVENT,
    modeContext,
    actorNodeId: reviewerNodeId ?? row.producedByNodeId,
    action: `deliverable.${row.kind}.${status}`,
    subjectRef: { kind: "deliverable", id, title: row.title },
    deliverableRef: { id, title: row.title, kind: row.kind as DeliverableKind },
    plainLanguageSentence:
      status === "verified"
        ? `Verified deliverable "${row.title}" — commit resolves and content is intact.`
        : `Could not verify deliverable "${row.title}": ${reason}.`,
  });

  return { ok: status === "verified", status, reason, deliverable };
}
