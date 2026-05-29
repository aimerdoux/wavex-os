/** Auto-producer: turn completed Paperclip issues into git-committed
 *  deliverables.
 *
 *  Slice 3 of the deliverable write-path. An agent that finishes work
 *  emits a `wavex-artifact` block on its issue (see DELIVERABLE_EMIT.md).
 *  This reconciler scans completed issues, finds those blocks, and calls
 *  writeDeliverable() — which commits the artifact to the company's
 *  deliverables git repo. Idempotent: one deliverable per issue, skipped
 *  if one already exists for that taskRefId.
 *
 *  The caller supplies the already-fetched issues (the route + scheduler
 *  do the Paperclip fetch), so this core logic is pure and testable. */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Db } from "@wavex-os/db";
import type { PaperclipMode } from "@wavex-os/shared/types/mission-control";
import { parseArtifactBlock } from "./artifact-block.js";
import { queryDeliverables, writeDeliverable } from "./deliverables.js";

/** A Paperclip issue, flattened to what the reconciler needs. The route's
 *  fetcher maps Paperclip's issue shape into this. `body` should already
 *  include the description plus any comments to scan for the block. */
export interface ReconcileIssue {
  id: string;
  state: string;
  title: string;
  body: string;
  assignee?: string;
}

export interface ReconcileInput {
  companyId: string;
  instanceId: string;
  modeContext?: PaperclipMode;
  issues: ReconcileIssue[];
}

export interface ReconcileResult {
  created: string[]; // deliverable ids created this run
  skipped: number; // issues with a block but an existing deliverable
  errors: number; // issues that threw during write
}

const TERMINAL_HINTS = ["done", "closed", "completed", "resolved", "verified", "delivered"];

/** An issue is "completed" when its state contains a terminal hint. We
 *  match loosely because Paperclip state vocabularies vary by install. */
export function isTerminalState(state: string | null | undefined): boolean {
  if (!state) return false;
  const s = state.toLowerCase();
  return TERMINAL_HINTS.some((h) => s.includes(h));
}

// ── I/O glue (not unit-tested — the pure reconcileDeliverables is) ───────

interface PaperclipHandoff {
  paperclipUrl?: string;
  paperclipCompanyId?: string;
}

function stateRoot(): string {
  return process.env.WAVEX_OS_STATE_DIR ?? join(homedir(), ".wavex-os");
}

async function readHandoff(companyId: string): Promise<PaperclipHandoff | null> {
  try {
    const path = join(stateRoot(), "instances", "default", "companies", companyId, "paperclip-handoff.json");
    return JSON.parse(await readFile(path, "utf8")) as PaperclipHandoff;
  } catch {
    return null;
  }
}

/** Fetch completed issues for a company from the local Paperclip, flattened
 *  into ReconcileIssue[]. Defensive on every axis: missing handoff, an
 *  unreachable Paperclip, or an unexpected response shape all yield [] so
 *  the reconciler simply no-ops that tick rather than throwing. Field-name
 *  fallbacks (id|key, state|status, body|description) absorb Paperclip API
 *  drift. Comments are appended to the body so artifact blocks posted as a
 *  closing comment are still scanned. */
export async function fetchCompletedIssuesForCompany(
  companyId: string,
): Promise<ReconcileIssue[]> {
  const handoff = await readHandoff(companyId);
  const base = handoff?.paperclipUrl ?? process.env.PAPERCLIP_HANDOFF_URL ?? "http://127.0.0.1:3100";
  const pcId = handoff?.paperclipCompanyId ?? companyId;
  try {
    const r = await fetch(`${base}/api/companies/${encodeURIComponent(pcId)}/issues`);
    if (!r.ok) return [];
    const raw = (await r.json()) as unknown;
    const list = Array.isArray(raw)
      ? raw
      : Array.isArray((raw as { issues?: unknown }).issues)
        ? (raw as { issues: unknown[] }).issues
        : [];
    return list
      .map((it): ReconcileIssue | null => {
        const o = it as Record<string, unknown>;
        const id = String(o.id ?? o.key ?? "");
        if (!id) return null;
        const description = String(o.description ?? o.body ?? "");
        const comments = Array.isArray(o.comments)
          ? (o.comments as Array<Record<string, unknown>>)
              .map((c) => String(c.body ?? c.text ?? ""))
              .join("\n")
          : "";
        return {
          id,
          state: String(o.state ?? o.status ?? ""),
          title: String(o.title ?? o.name ?? id),
          body: `${description}\n${comments}`,
          assignee: o.assignee ? String(o.assignee) : undefined,
        };
      })
      .filter((x): x is ReconcileIssue => x !== null);
  } catch {
    return [];
  }
}

export async function reconcileDeliverables(
  input: ReconcileInput,
  db?: Db,
): Promise<ReconcileResult> {
  const result: ReconcileResult = { created: [], skipped: 0, errors: 0 };

  for (const issue of input.issues) {
    if (!isTerminalState(issue.state)) continue;
    const parsed = parseArtifactBlock(issue.body);
    if (!parsed) continue;

    // Idempotency — one deliverable per issue. The local deliverables
    // table does not upsert, so we guard on existing rows for this issue.
    try {
      const existing = await queryDeliverables(
        { companyId: input.companyId, taskRefId: issue.id, limit: 1 },
        db,
      );
      if (existing.length > 0) {
        result.skipped += 1;
        continue;
      }

      const d = await writeDeliverable(
        {
          companyId: input.companyId,
          instanceId: input.instanceId,
          modeContext: input.modeContext ?? "solo_founder",
          taskRefType: "issue",
          taskRefId: issue.id,
          producedByNodeId: issue.assignee ?? "unknown",
          kind: parsed.kind,
          title: parsed.title,
          mimeType: parsed.mimeType,
          filename: parsed.filename,
          payload: { body: parsed.content, issueTitle: issue.title },
          plainLanguageSentence: `Captured deliverable "${parsed.title}" from completed issue ${issue.id}.`,
        },
        db,
      );
      result.created.push(d.id);
    } catch {
      result.errors += 1;
    }
  }

  return result;
}
