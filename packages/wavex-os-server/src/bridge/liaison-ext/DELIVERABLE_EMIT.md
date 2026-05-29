# Skill: emit a deliverable artifact when you finish

When you complete a unit of work that produced something — a document, a
draft, a plan, a dataset, an analysis — **emit a `wavex-artifact` block** as
your closing comment on the issue before you mark it done. WaveX captures
that block into a **git-committed, verifiable deliverable**: the proof that
the work happened and what it produced, inspectable later via
`git show <commit>`.

This is the producer half of the deliverable ledger. The Liaison mirrors
the *accountability* (who/what/cost); your block supplies the *artifact*.

## When to emit

- You finished work on an issue AND it produced a concrete output.
- One block per issue, in your final comment, right before you close it.

Do **not** emit for: pure coordination/triage with no output, or
`code_change` / `db_migration` work — those go through the Git Engineer's
PR flow (`artifacts.pr_url`), not this block.

## The block

A fenced block tagged `wavex-artifact`: a header of `key: value` lines, a
`---` separator, then the artifact body.

```
\`\`\`wavex-artifact
kind: document
title: Q3 campaign brief
mime: text/markdown
---
# Q3 Campaign
- Channel: Instagram + email
- Offer: autumn line, 15% launch discount
- Timeline: ships Sept 1
...the full artifact content...
\`\`\`
```

### Header keys

- `kind` (optional) — one of `document`, `code`, `email_draft`,
  `message_draft`, `data_artifact`, `meeting_artifact`. Defaults to
  `document` if omitted or unrecognized.
- `title` (**required**) — a short name for the deliverable. No title → the
  block is ignored.
- `mime` (optional) — e.g. `text/markdown`, `text/plain`, `application/json`.
- `filename` (optional) — a preferred on-disk name for the artifact.

### Body

Everything after `---` is committed verbatim as the artifact. Put the actual
deliverable there — not a summary of it. If the real output lives elsewhere
(a connected doc, a file the Git Engineer handles), keep the body short and
reference it; the block still records that the deliverable exists.

## Rules

- **One block per issue.** Re-emitting is harmless — the reconciler is
  idempotent (one deliverable per issue) and skips issues that already have
  one.
- **Real content, not a recap.** The body is the thing a reviewer opens.
- **No secrets / PII** beyond what already belongs in the issue.
- The deliverable only materializes once the issue reaches a terminal state
  (done/closed/completed/resolved/verified). Emit the block, then close.
