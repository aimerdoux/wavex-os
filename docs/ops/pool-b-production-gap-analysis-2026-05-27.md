# Pool B Production Gap Analysis — 2026-05-27

## Why this exists

On May 27, 2026 we investigated a suspected Claude Max quota drain and found a
real accountability gap in Pool B. The operator-side Mac relay could serve
paid inference traffic without a durable, queryable Supabase record for every
attempt. That made it possible to spend subscription capacity without a
complete audit trail.

This document captures the production understanding, the remaining gaps, and
the recommended implementation shape for turning streaming inference back on
without accepting unregistered consumption.

## Current understanding

### What was happening

- Pool B traffic reached the operator Mac over Supabase Realtime and, in some
  cases, over the local HTTP route.
- The relay enforced some auth checks, but observability was split:
  local JSONL/log files knew more than Supabase.
- `wavex_os.usage_ledger` was being used as the main accountability surface,
  but it only represented successful billable rows and its original pool check
  was still limited to `A` and `C`.
- Rejected, duplicated, disabled, or upstream-failed requests were not
  available as a first-class Supabase query surface.

### Why losses happened

- A request could reach the operator relay and consume upstream capacity before
  the platform had a trustworthy per-request record in Supabase.
- The ledger was too narrow: it answered "what was billed?" better than "what
  happened?".
- Provider behavior was opaque. If Anthropic burned quota quickly, there was no
  unified per-request attribution by session, device, route, and attempt.

## What this PR changes

- Adds a durable append-only Pool B audit table:
  `wavex_os.inference_audit_events`.
- Adds public RPCs:
  `wavex_os_record_inference_audit(...)` and
  `wavex_os_recent_inference_audit(limit)`.
- Fixes the `wavex_os.usage_ledger` pool constraint so Pool B rows are allowed.
- Records every Pool B attempt with:
  request id, route, user, subscription, device, session, conversation,
  provider, fallback mode, provider response id, model, outcome, tokens, cost,
  and prompt hash.
- Adds a configurable Anthropic -> Codex/OpenAI fallback path for prompt-based
  Pool B flows.
- Keeps streaming inference disabled by default until rollout is complete.

## Remaining production gaps

### 1. Supabase rollout safety

This repository has remote/local migration drift. We should not do a blind
`supabase db push` from this checkout.

Needed:

1. Apply the two May 27 migrations in a controlled production release:
   - `20260527000001_wavex_os_device_lookup_rpc.sql`
   - `20260527000002_wavex_os_pool_b_accountability.sql`
2. Verify the RPCs exist remotely before enabling traffic:
   - `wavex_os_device_lookup`
   - `wavex_os_record_inference_audit`
   - `wavex_os_recent_inference_audit`
3. Verify the `usage_ledger` pool check includes `B`.

### 2. Durability semantics

The current design writes the audit row before or after a request phase, but it
does not yet require a strict "audit write succeeded before upstream call"
contract.

Recommended rule:

- For enabled production traffic, fail closed if the initial "attempt started"
  audit write cannot be persisted to Supabase and the local append-only backup.

That prevents "served but unregistered" traffic.

### 3. Local fallback durability

The local `pool-b-audit.jsonl` file is useful, but it is not yet treated as a
formal write-ahead log.

Recommended upgrade:

- Treat the local audit file as a write-ahead log with monotonic sequence IDs.
- Add a replay worker that backfills missing Supabase audit rows after network
  interruptions.
- Add an operator alert when replay backlog is non-zero for more than N
  minutes.

### 4. Realtime trust model

Pool B still uses Supabase Realtime channels as the rendezvous layer. This is
convenient, but the security model depends on:

- a valid device JWT
- live device-state lookup
- rate limits
- idempotency

Recommended hardening:

- Bind the request envelope to a signed `trace_id`.
- Include a short-lived nonce and reject nonce reuse.
- Add per-device and per-subscription burst budgets in Redis.
- Require a paired-device status other than just "not revoked" if the product
  introduces suspended/quarantined states.

### 5. Streaming-specific observability

Prompt-based requests now have fallback support, but the raw
`anthropic-messages` path still behaves as a single-provider relay. That path
has richer context and higher burn risk.

Recommended approach for streaming:

- Split streaming into two phases:
  1. request envelope accepted and durably registered
  2. token stream chunks emitted
- Persist per-stream aggregates:
  - `stream_opened_at`
  - `first_token_at`
  - `stream_closed_at`
  - `finish_reason`
  - exact input/output/cache token totals
- Store chunk counts and terminal reason, not raw token text.
- If the stream terminates early, mark the audit row `failed_partial`.

### 6. Context optimizer

The worrying cost pattern from the earlier forensic burst looked like a single
conversation growing turn by turn.

Recommended optimizer design:

- Add a conversation budget layer keyed by `conversation_id`.
- Track rolling prompt token growth and summarize when:
  - context exceeds a soft threshold
  - request cost slope accelerates
  - the same conversation consumes more than its configured budget window
- Persist summary events to Supabase so the cost story stays queryable.

The optimizer should not mutate user content silently. It should log when it
compacts history and how many tokens were removed.

### 7. Provider fallback governance

Codex/OpenAI fallback is valuable for continuity, but it changes the trust and
billing surface.

Recommended policy:

- Keep fallback opt-in with `WAVEX_OS_POOL_B_PROVIDER_MODE`.
- Default production mode:
  `anthropic_only`
- Incident mode:
  `anthropic_then_codex`
- Maintenance/testing mode:
  `codex_only`

Guardrails:

- Require `OPENAI_API_KEY` health checks before enabling fallback.
- Track `provider`, `fallback_used`, and `provider_response_id` on every row.
- Alert if fallback rate exceeds a threshold, because that is a signal of
  primary-provider degradation or quota exhaustion.

## Best implementation for streaming inference

The safest production shape is:

1. Customer request arrives with `request_id`, `session_id`,
   `conversation_id`, `trace_id`, and device JWT.
2. Operator relay verifies JWT, device state, subscription, and rate limits.
3. Relay writes an `attempt_started` audit record to:
   - local write-ahead log
   - Supabase `inference_audit_events`
4. Only after durable registration succeeds does the relay begin upstream
   inference.
5. Relay streams tokens while accumulating exact usage counters.
6. Relay writes a terminal audit update with:
   - provider
   - provider response id
   - status/outcome
   - exact token totals
   - cost
   - finish reason
7. A reconciler compares local WAL sequence IDs with Supabase rows and repairs
   gaps.

That is the implementation shape that most directly prevents invisible losses.

## Recommended production rollout

1. Apply the two May 27 Supabase migrations only.
2. Verify `/admin/pool-b/requests` returns rows from Supabase.
3. Keep `WAVEX_OS_STREAMING_INFERENCE_ENABLED` unset.
4. Run controlled smoke traffic with:
   - one HTTP prompt request
   - one Realtime prompt request
   - one rejected request
   - one duplicate request
5. Confirm all four cases appear in `inference_audit_events`.
6. Enable fallback only if `OPENAI_API_KEY` is configured and tested.
7. Re-enable streaming for a tiny allowlist first.
8. Add alerts for:
   - missing audit writes
   - replay backlog
   - fallback surge
   - request rate anomalies per device or conversation

## Production acceptance criteria

Pool B should not be re-enabled broadly until all are true:

- Every request attempt is visible in Supabase within seconds.
- Every request attempt is also recoverable from the local WAL.
- A request cannot be served if accountability storage is unavailable.
- Rejected and duplicate requests are queryable, not just successful ones.
- Provider fallback is explicit and attributable.
- Conversation-level growth is observable enough to catch runaway context
  before it burns quota.
