#!/usr/bin/env node
/** Mission Control — Deliverable backfill.
 *
 *  Synthesizes one `kind: configuration, status: approved` Deliverable
 *  row per:
 *    1. Avatar approval JSON on disk under
 *       ~/.wavex-os/instances/default/avatars/<id>/approvals/*.json
 *       (writes one Deliverable per existing approval — pending or approved).
 *
 *  Idempotent: skips any approval whose `taskRefId` already has a
 *  Deliverable row. Safe to re-run.
 *
 *  We deliberately don't backfill Paperclip `issues` rows in this script
 *  because they live in a different DB (@paperclipai/db) we don't have
 *  a connection string for in this dev mode. Issues backfill ships when
 *  the wavex side gets a cross-DB bridge (or when the kpi/issue mirror
 *  table lands in a later phase).
 *
 *  Usage:  node scripts/backfill-deliverables.mjs [--dry-run]
 */

import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const dryRun = process.argv.includes("--dry-run");
const verbose = process.argv.includes("--verbose");

const root = process.env.WAVEX_OS_STATE_DIR ?? join(homedir(), ".wavex-os");
const avatarsDir = join(root, "instances", "default", "avatars");

if (!existsSync(avatarsDir)) {
  console.log(`No avatars dir at ${avatarsDir} — nothing to backfill.`);
  process.exit(0);
}

const { getDb, runMigrations, deliverables } = await import("@wavex-os/db");
const { eq } = await import("drizzle-orm");
const { writeDeliverable } = await import(
  "../packages/op-omega-server/src/mission-control/deliverables.js"
);

await runMigrations();
const db = await getDb();

let scanned = 0;
let synthesized = 0;
let skipped = 0;
let errors = 0;

const avatarIds = await readdir(avatarsDir);
for (const avatarId of avatarIds) {
  const approvalsDir = join(avatarsDir, avatarId, "approvals");
  if (!existsSync(approvalsDir)) continue;
  const files = (await readdir(approvalsDir)).filter((f) => f.endsWith(".json"));

  // Resolve paperclipCompanyId from handoff mapping (avatar-handoff writes
  // it). Fallback: avatarId itself (so the row links to *something*).
  let companyId = avatarId;
  const handoffPath = join(avatarsDir, avatarId, "paperclip-handoff.json");
  if (existsSync(handoffPath)) {
    try {
      const handoff = JSON.parse(await readFile(handoffPath, "utf8"));
      if (typeof handoff.paperclipCompanyId === "string") {
        companyId = handoff.paperclipCompanyId;
      }
    } catch {
      // Ignore parse errors — fall back to avatarId.
    }
  }

  for (const f of files) {
    scanned += 1;
    try {
      const approval = JSON.parse(await readFile(join(approvalsDir, f), "utf8"));
      const taskRefId = approval.id;
      if (!taskRefId) {
        if (verbose) console.warn(`[skip] ${f}: no approval.id`);
        skipped += 1;
        continue;
      }
      const existing = await db
        .select()
        .from(deliverables)
        .where(eq(deliverables.taskRefId, taskRefId))
        .limit(1);
      if (existing.length > 0) {
        if (verbose) console.log(`[skip] ${taskRefId}: deliverable exists`);
        skipped += 1;
        continue;
      }
      if (dryRun) {
        console.log(`[dry-run] would synthesize for ${taskRefId} (${avatarId})`);
        synthesized += 1;
        continue;
      }
      const payload = approval.payload ?? {};
      const kind = inferKind(approval.type);
      const previewText = pickPreview(payload);
      await writeDeliverable({
        companyId,
        instanceId: avatarId,
        modeContext: "avatar",
        taskRefType: "avatar_approval",
        taskRefId,
        producedByNodeId: approval.requestedByAgentId ?? "system",
        kind,
        title: `(migrated) ${summarize(approval)}`,
        description: "Synthesized by backfill-deliverables.mjs",
        previewText,
        status:
          approval.status === "approved"
            ? "approved"
            : approval.status === "rejected"
              ? "rejected"
              : "draft",
        templateUsed: approval.type ?? undefined,
        payload,
      });
      synthesized += 1;
    } catch (err) {
      errors += 1;
      console.error(`[error] ${f}:`, err instanceof Error ? err.message : err);
    }
  }
}

console.log(
  `\nDone. Scanned ${scanned} approvals across ${avatarIds.length} avatars.`,
);
console.log(`  Synthesized: ${synthesized}`);
console.log(`  Skipped:     ${skipped}`);
console.log(`  Errors:      ${errors}`);
if (dryRun) console.log(`  (dry-run — no rows written)`);

function inferKind(approvalType) {
  if (typeof approvalType !== "string") return "configuration";
  if (approvalType.includes("draft_reply") || approvalType.includes("mail"))
    return "email_draft";
  if (approvalType.includes("invite") || approvalType.includes("calendar"))
    return "meeting_artifact";
  if (approvalType.includes("slack")) return "message_draft";
  return "configuration";
}

function pickPreview(payload) {
  if (!payload || typeof payload !== "object") return undefined;
  for (const key of ["draftText", "draft_message", "text", "preview", "summary"]) {
    if (typeof payload[key] === "string") return payload[key].slice(0, 280);
  }
  return undefined;
}

function summarize(approval) {
  const p = approval.payload ?? {};
  if (typeof p.subject === "string") return `Reply: ${p.subject}`;
  if (typeof p.summary === "string") return `Invite: ${p.summary}`;
  if (typeof p.channel === "string") return `Slack ${p.channel}`;
  return approval.type ?? approval.id ?? "approval";
}
