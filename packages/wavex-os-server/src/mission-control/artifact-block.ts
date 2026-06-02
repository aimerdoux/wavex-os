/** Parse a `wavex-artifact` fenced block out of issue text.
 *
 *  Agents that finish a unit of work emit a block so the reconciler can
 *  turn their output into a git-committed, verifiable deliverable. It
 *  mirrors the existing `wavex-contract` block convention (see
 *  liaison-ext/DELIVERABLE_LEDGER.md): a header of `key: value` lines,
 *  an optional `---` separator, then the raw artifact body.
 *
 *    ```wavex-artifact
 *    kind: document
 *    title: Q3 campaign brief
 *    mime: text/markdown
 *    ---
 *    # Q3 campaign
 *    Launch the autumn line via IG + email...
 *    ```
 *
 *  The header carries `kind` + `title` (+ optional `mime`/`filename`); the
 *  body after `---` is the artifact content. A block with no `---` and no
 *  body is treated as header-only (content empty) — still a valid signal
 *  that a deliverable was produced, just without inline content. */

import type { DeliverableKind } from "@wavex-os/shared/types/mission-control";

export interface ParsedArtifact {
  kind: DeliverableKind;
  title: string;
  mimeType?: string;
  filename?: string;
  /** Inline artifact body (everything after the `---` separator). */
  content: string;
}

const FENCE_RE = /```wavex-artifact\s*\n([\s\S]*?)```/;

const KNOWN_KINDS: ReadonlySet<string> = new Set([
  "document",
  "code",
  "email_draft",
  "message_draft",
  "data_artifact",
  "meeting_artifact",
]);

/** Extract the first `wavex-artifact` block from `text`. Returns null when
 *  there is no block, or when the block lacks the required `title`. `kind`
 *  defaults to "document" if absent or unrecognized — a deliverable with a
 *  loose kind is better than dropping a real artifact on the floor. */
export function parseArtifactBlock(text: string | null | undefined): ParsedArtifact | null {
  if (!text) return null;
  const m = FENCE_RE.exec(text);
  if (!m) return null;
  const inner = m[1] ?? "";

  // Split header from body on the first line that is exactly `---`.
  const lines = inner.split("\n");
  let sepIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() === "---") {
      sepIdx = i;
      break;
    }
  }
  const headerLines = sepIdx >= 0 ? lines.slice(0, sepIdx) : lines;
  const bodyLines = sepIdx >= 0 ? lines.slice(sepIdx + 1) : [];

  const header: Record<string, string> = {};
  for (const line of headerLines) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    if (key) header[key] = val;
  }

  const title = header.title;
  if (!title) return null;

  const rawKind = (header.kind ?? "").toLowerCase();
  const kind = (KNOWN_KINDS.has(rawKind) ? rawKind : "document") as DeliverableKind;

  return {
    kind,
    title,
    mimeType: header.mime || header.mimetype || undefined,
    filename: header.filename || undefined,
    content: bodyLines.join("\n").trim(),
  };
}
