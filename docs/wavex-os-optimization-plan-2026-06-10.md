# WaveX-OS Optimization Plan — from Fleet-Audit Failures to Business Cockpit

**Date:** 2026-06-10 · **Input:** `wavex-experience-architect/docs/marketing/2026-06-flywheel/FLEET-AUDIT-2026-06-10.md`
**Mandate:** fix the 5 audited failure modes with better prompts + platform features; QA Composio e2e; turn Mission Control from placeholder into the cockpit (KPIs, roadmap, deliverables inbox). Authorized for full 5h-window token use.

## What already exists (recon findings — build on, don't duplicate)

| Found | Where | State |
|---|---|---|
| Budget system: policies, incidents, pause-on-budget, `getInvocationBlock` | `server/src/services/budgets.ts`, DB tables `budget_policies/budget_incidents/cost_events` | **Working but inert**: only metric is `billed_cents`; subscription runs bill $0, so it never trips. This is the "half implemented during onboarding" piece (plus `BudgetChip.tsx` in onboarding-ui). |
| Live provider quota: real Anthropic 5h-window utilization via OAuth/CLI | `services/quota-windows.ts`, `adapters/claude-local/src/server/quota.ts`, exposed in `routes/costs.ts` | **Fetched but consumed by nothing** — no scheduler linkage, no dashboard bar. |
| Run pipeline chokepoints | `services/heartbeat.ts` — budget gate at invocation (~L3011) and claim (~L3980) | Gating pattern exists; governor can hook the same seams. |
| Liveness/continuation + watchdog | `heartbeat.ts` decideRunLivenessContinuation, recovery-issue filing | Source of the wake storm + "Recover stalled" duplicates. |
| Plateau adapter (bounded context) | external plugin `plateau_local`, **all 148 agents migrated 2026-06-10** | Done; first-run validation pending. |

---

## Fix per audited issue

### Issue 1 — Cached-context re-reads (94M tokens) → DONE, validate
Plateau enforcement shipped (all 148 agents on `plateau_local`, role mode, 40 steps/1500s, checkpoint-resume). **Remaining:** (a) validate first run when fleet resumes; (b) make `plateau_local` the default `adapterType` in provisioning so new hires comply.

### Issue 2 — System auto-wake storm (142/168 system wakes, 64 same-error retries) → Circuit breaker
**Feature `run-governor.ts` (breaker half):** before any *system-sourced* wake/claim for agent A: look at A's last 3 finished runs (≤45 min). If all 3 failed with the same `errorCode` → **trip breaker**: skip the wake, log one `agent_breaker_tripped` activity, and on 6 consecutive same-error failures auto-pause the agent with `pauseReason: "system"` + file ONE escalation issue (dedupe-guarded). Manual (`triggerDetail: "manual"`) wakes bypass the breaker so a human can always test.

### Issue 3 — Cadence compression (weekly loops ran 4× in 2h) → Defer-aware wakes + prompt rule
Platform half: next-cycle issues are filed with `status: backlog` and a `DEFER-UNTIL: <ISO>` line in the description; system wakes for backlog issues whose defer marker is in the future are skipped by the governor (cheap regex check at the wake seam — no schema change). Prompt half (meta-prompts v2): every loop MUST file its next cycle as backlog with an explicit DEFER-UNTIL ≥ its cadence, and MUST NOT self-wake.

### Issue 4 — Coordination ping-pong / 15 duplicate clusters → Create-time dedupe guard
**Feature in issue-create service:** on create, normalize the title (lowercase, strip whitespace/punctuation runs); if an **open** (non-done/cancelled) issue in the same company has the same normalized title → return `409 duplicate_open_issue` with the existing identifier, unless the request passes `allowDuplicate: true`. This kills the 3× policy asks, 3× re-reviews, and 2× watchdog recovery pairs at the source (watchdog files through the same path). Prompt half: gates iterate **in-thread on the original issue** (comment rounds), never by filing "Re-review" issues.

### Issue 5 — Timeouts + usage-aware scheduling → **The Run Governor (economic model)**
The core feature. A single service consulted at the run-claim seam:

1. **Signal:** cached (60s TTL) `fetchAllQuotaWindows()` → utilization % of the **real Anthropic 5h window** (and weekly window when present). This is the same number your Claude Max subscription enforces — the system self-regulates against the true constraint, not a proxy.
2. **Allowance tiers** (configurable via env, defaults):
   - `< 50%` → **open**: all work runs.
   - `50–75%` → **conserve**: only issues with priority `critical`/`high` **or** `estimatedDelta ≥ $200` run; others stay queued (not cancelled).
   - `75–90%` → **critical-only**: priority `critical` only.
   - `≥ 90%` → **frozen**: no system-triggered runs; manual wakes still allowed.
3. **Economic ranking:** within a tier, claimable runs are ordered by `estimatedDelta × priority-weight` — the revenue-intensive task always gets the next slot. Issues with no `estimatedDelta` rank last (and meta-prompts v2 makes agents PATCH their own estimate or close the task as not-revenue-relevant: "ditch what doesn't move the goal").
4. **Dashboard metric:** `GET /api/governor/status` → `{windows, utilizationPct, tier, thresholds, nextEvaluation}`; UI renders the **quota progress bar** on the Dashboard (replacing the dead `$0.00 Month Spend` signal for subscription billers) and on Mission Control.
5. **Timeout fix folded in:** `plateau_local` runs at 1500s target/1800s hard stop with `--resume` checkpoints, so a timeout no longer discards work — the next allowed run continues from the checkpoint. The governor decides *when* that next run is affordable.

### CEO ⇄ CoS parity (orchestrator/scheduler vs judge/feedback)
Audit verdict: both loops ran (CEO cycles 1–4, CoS digests WAV-13/50) but **the grades fed nothing**. v2 contract:
- CEO = *scheduler*: owns DEFER-UNTIL cadence, tranche gates, and (new) acts on governor tier in council decisions.
- CoS = *judge*: grades A–F against each loop's own QUALITY GATE; grades are now an **economic input** — meta-prompts v2 instruct the CEO to halve the wake cadence of any agent with 2 consecutive sub-B grades and restore it on the next A/B (token budget follows demonstrated quality).
- Neither files work for the other's lane; disputes go to the user.

---

## Composio e2e QA (ask #1)
Trace `COMPOSIO_API_KEY` + `WAVEX_COMPOSIO_DISABLED` through onboarding-ui (`AddConnectorWidget`, `Phase2Connectors`, `connector-catalog.ts`) and the server config; verify the Directory banner condition; document the exact enable steps; test the OAuth round-trip as far as possible without the user's key; deliver a QA checklist with pass/fail per step. (The fleet correctly never fabricated connector actions while disabled — the audit confirmed drafts-only behavior.)

## Mission Control v1 (ask #2)
From placeholder to cockpit, additive sections:
1. **Quota/Governor bar** — live 5h-window utilization + tier (shared component with Dashboard).
2. **KPI strip** — revenue-relevant numbers from the issue graph: attributed revenue (sum of `estimatedDelta` on done revenue issues vs target), open critical count, intent→booking conversion, runs success rate.
3. **Roadmap panel** — render the phased roadmap (the text roadmap lives in the repo; Mission Control reads it from a pinned issue document so agents can update it).
4. **Deliverables inbox** — list of issue **documents** (the existing `PUT /issues/:id/documents/:slug` artifacts) newest-first with issue link + author agent: every report/memo/spec the staff produces lands in one reviewable feed.

## Delivery order (this session)
1. ✅ This plan.
2. Run Governor service + claim-seam gate + breaker + `GET /api/governor/status` (server).
3. Dedupe guard in issue create.
4. Dashboard quota bar (UI).
5. Composio QA doc + wiring check.
6. Mission Control v1 sections (as far as context allows; remaining scoped as Paperclip issues for the fleet itself once resumed under the governor).
7. Meta-prompts v2 patch file.

**Verification per step:** existing test suites for touched services (`quota-windows`, `budgets`, issue routes) must pass; new logic gets unit tests where the harness exists; live smoke via `curl` against the dev server (it hot-reloads).
