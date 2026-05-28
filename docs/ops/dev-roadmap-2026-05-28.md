# WaveX OS — Dev Roadmap, 2026-05-28

Today's deliverables, ordered. Context: Codex landed a Pool B accountability
suite (mostly uncommitted) per `pool-b-production-gap-analysis-2026-05-27.md`.
The build is currently broken and the local fleet is dormant. This roadmap
sequences the work to get from "broken + dormant" → "Pool B accountable +
fleet live + can't burn quota invisibly."

## State at start of day

| Area | State |
|---|---|
| Build | ❌ BROKEN — 8 tsc errors in `wavex-os-server/src/mission-control/pool-b-health.ts` (null-safety, from PR #28) |
| inference-server | ✅ compiles clean (Codex's +825 worker / +464 os-paid changes are sound) |
| Local fleet | ⏸ dormant — Paperclip (3100) + mock-core (3101) not running |
| Inference mode | ✅ `~/.wavex-os/inference.env` = oauth (BYOC); agent model env-driven `WAVEX_AGENT_MODEL ?? claude-sonnet-4-6` |
| Codex Pool B suite | 🟡 uncommitted: audit table + RPCs + provider fallback + WAL + 8 migrations + gap doc |
| Plugin / connectors | ✅ wavex plugin installs (manifest v0.15.0, Connectors sidebar live); Composio still needs an API key |
| Claude Max quota | weekly 25% / sonnet bucket was the May-19 blocker → fixed by opus switch |

## Uncommitted work inventory (Codex)

**New source (untracked):**
- `inference-server/src/lib/{inference-audit,openai-responses,pool-b-control,pool-b-prompt-coverage}.ts`
- `wavex-os-server/src/jobs/{booking-fulfillment-resolver,professional-reengagement}.ts`
- `wavex-os-server/src/mission-control/inbound-quality-sampler.ts`
- `wavex-os-server/src/routes/reengagement.ts`

**Modified (tracked):** `cloud-client/src/inference.ts`, `inference-server/src/{realtime/worker.ts,routes/admin.ts,routes/health.ts,routes/os-paid.ts}`, `paperclip-plugin-wavex/src/worker.ts`, `wavex-os-server/src/{bridge/paperclip-handoff.ts,index.ts,routes/mission-control.ts}`

**8 untracked migrations** (May 20 + May 27):
- `20260520000001_wavex_os_user_event_stream`
- `20260520000002_wavex_os_kpi_history`
- `20260520000002_wavex_os_professional_reengagement` ⚠️ duplicate sequence prefix with kpi_history
- `20260520000003_wavex_os_snapshot_booking_gmv_rpc`
- `20260520000004_wavex_os_bookings_fulfillment_instrumentation`
- `20260521000002_wavex_os_inbound_quality`
- `20260527000001_wavex_os_device_lookup_rpc` ← Pool B rollout
- `20260527000002_wavex_os_pool_b_accountability` ← Pool B rollout

---

## D1 — Unblock the build (P0, blocks everything) ~30 min

Fix the 8 null-safety errors in `pool-b-health.ts` (lines 147, 183, 196, 230,
253, 308, 371, 375 — `wavex`/object possibly null). Then a full-workspace
typecheck must be green for non-vendor packages.

**Done when:** `pnpm -r exec tsc --noEmit` shows 0 non-vendor errors.

## D2 — Land Codex's Pool B accountability suite (P0) ~1.5h

The gap-analysis doc is the spec. Review + typecheck + commit the uncommitted
suite in logically-grouped commits (don't dump 1300 lines in one):

1. **migrations** — the 8 SQL files. **Resolve the duplicate `20260520000002`
   prefix first** (rename professional_reengagement → `…000005`) or migrations
   apply out of order.
2. **inference-server audit core** — `inference-audit.ts`, `pool-b-control.ts`,
   `openai-responses.ts`, `pool-b-prompt-coverage.ts` + the `worker.ts` /
   `os-paid.ts` / `admin.ts` wiring.
3. **wavex-os-server jobs + routes** — reengagement, booking-fulfillment,
   inbound-quality + mission-control route additions.

**Done when:** all committed, typecheck green, gap-doc's "What this PR changes"
section matches what's on disk.

## D3 — Controlled Supabase rollout (P0, gated, follow gap-doc §rollout) ~30 min

Per the gap doc — **do NOT blind `supabase db push`** (remote/local drift).
Apply ONLY the two May 27 Pool B migrations in a controlled release:
- `20260527000001_wavex_os_device_lookup_rpc`
- `20260527000002_wavex_os_pool_b_accountability`

Then verify remotely that these RPCs exist: `wavex_os_device_lookup`,
`wavex_os_record_inference_audit`, `wavex_os_recent_inference_audit`, and that
`usage_ledger`'s pool check now includes `B`.

> The May 20 migrations (event stream, kpi history, booking GMV snapshot,
> reengagement) are a separate batch — stage them after D3 once their feature
> code is committed. Don't bundle them into the Pool B safety release.

**Done when:** the 3 RPCs resolve remotely + `usage_ledger` accepts pool=B.

## D4 — Restart fleet on opus + verify health (P0) ~30 min

Servers are down. Bring back `pnpm dev` (mock-core 3101 + onboarding-ui 5173),
confirm Paperclip 3100 is up, set `WAVEX_AGENT_MODEL=opus` in the fleet env
(Sonnet bucket is the one that throttles), resume the 35 agents **staggered**
(not all at once — that tripped the 429 burst on May 21).

**Done when:** one CEO heartbeat completes (not failed) on opus, and ≥3 agents
have produced issue activity without `claude_transient_upstream`.

## D5 — Pool B accountability smoke test (P1, gap-doc §rollout step 4) ~30 min

With `WAVEX_OS_STREAMING_INFERENCE_ENABLED` unset, run the 4-case smoke:
1 HTTP prompt, 1 Realtime prompt, 1 rejected, 1 duplicate. Confirm all four
land in `inference_audit_events` and `/admin/pool-b/requests` returns them.

**Done when:** all 4 cases queryable in Supabase within seconds.

## D6 — Inference-handling gates G1 + G2 (P1, the "better inference handling" ask) ~1.5h

These prevent the May-19 quota-storm from recurring:
- **G1** — pre-flight quota check before `activate` + before bulk pillar T2
  calls. If the target model bucket is exhausted, HALT with a clear operator
  message + reset window instead of spawning 35 doomed agents.
- **G2** — heartbeat retry classifier: on `claude_transient_upstream` whose
  message contains a usage-limit signature ("hit your … limit", "resets"),
  switch to `paused_quota_exhausted` + schedule one retry after the reset
  window — do NOT retry-storm into a hard ceiling.

**Done when:** a simulated quota-exhausted response produces one paused run
with a reset-aware retry, not 3+ immediate retries.

---

## Secondary (today if D1–D6 land early, else tomorrow)

- **G3** — AllocationSlider reads live Claude quota state (per-model bucket %),
  not just the operator's preference number.
- **G4** — surface `claude_transient_upstream` + quota state in Mission Control
  banner + Telegram (hook the wavex-local-ops daemon).
- **Composio key UX** — the Directory modal asks for `ak_…` and says "stored in
  `<repo>/.env`". Wire it so a key entered there persists + auto-loads on
  restart, and the 16 toolkits flip `available → connectable`.
- **Phase 10 follow-up (#191)** — genericize the 9 mirror SKILL files so the
  `applyManifestOverlay` strip-patterns can be deleted.

## Sequencing rationale

D1 first (nothing ships broken). D2 commits the in-flight value before it rots.
D3 is the gated DB release the gap doc insists on. D4 gets the fleet earning
again. D5 proves Pool B is accountable. D6 makes the whole thing safe to leave
running unattended — which is the actual product requirement behind "better
inference handling."

## End-of-session status (2026-05-28, autonomous run)

Branch `feat/skills-sh-listing`, pushed through `76ce0fb6`.

| # | Status | Result |
|---|---|---|
| D1 | ✅ done | `e001d64c` — 8 null-safety errors fixed; build green (0 non-vendor tsc errors) |
| D2 | ✅ done | `cba4f681`+`3e76959b`+`0baa7a3f`+`3bb53968`+`19de4855` — Codex Pool B suite committed in 5 grouped commits; migration prefix collision resolved; all 4 touched packages typecheck clean |
| D3 | ✅ done | 2 May-27 migrations applied to prod Supabase; verified: `wavex_os_device_lookup`, `wavex_os_record_inference_audit`, `wavex_os_recent_inference_audit` all resolve; `usage_ledger` pool check now `A,B,C` |
| D6 | ✅ done | G1 `6c291153` (pre-flight quota gate on activate, classifier 4/4 unit-tested) + G2 `76ce0fb6` (circuit-breaker script). This is the "creation/activation" inference fix. |
| D4 | ⏸ DEFERRED | needs live servers + supervision — see runbook below |
| D5 | ⏸ DEFERRED | needs inference-server + a paired device — see runbook below |

**Why D4/D5 were deferred (not skipped):** the entire point of today's work
was to stop invisible quota burn. Turning a 35-agent fleet loose unattended —
even on opus — before a human can watch it would contradict that. The fleet is
left dormant (safe default). G1 now gates any re-activation, and G2 can be
armed as a cron breaker the moment the fleet comes up.

### D4 runbook (run supervised)

```bash
cd /Users/geniex/wavex-os
export WAVEX_AGENT_MODEL=opus            # Sonnet bucket throttles independently
pnpm dev                                  # boots mock-core :3101 + onboarding-ui :5173
# in another shell, confirm Paperclip :3100 is up (npx paperclipai run from ~/paperclip if not)
# the 35 agents already carry model=opus in Paperclip's DB (patched 2026-05-21)
# resume STAGGERED — do NOT mass-resume (that tripped the 429 burst):
#   resume CEO first, watch one heartbeat complete, then resume the rest in small batches
curl -s -X POST http://127.0.0.1:3100/api/agents/<CEO_ID>/heartbeat/invoke -d '{}'
# arm the breaker on a 10-min cron so a drain auto-pauses the fleet:
node scripts/ops/wavex-quota-circuit-breaker.mjs b515f8b2-0976-4838-b8a9-c08d430d8177
```

### D5 runbook (Pool B 4-case smoke — gap-doc step 4)

With `WAVEX_OS_STREAMING_INFERENCE_ENABLED` unset, drive: 1 HTTP prompt,
1 Realtime prompt, 1 rejected, 1 duplicate. Then confirm all four land:

```sql
select route, status, request_id, occurred_at
from wavex_os.inference_audit_events
order by occurred_at desc limit 10;
```
or `GET /admin/pool-b/requests` on the inference-server.

## Hard constraints (carry-over)

- NEVER clean `usage_ledger`, `inference_audit_events`, `fleet_digests`,
  `injection_queue_v2`, `digest_access_log`, `optimizer_runs`, or heartbeat-run
  history — they're training data for future Expert Agents.
- FROZEN paths per CLAUDE.md (`vendor/wavex-os/**`, `packages/healing/**`,
  `packages/observability/src/**`, etc.) — surface concerns, don't edit.
- Controlled Supabase releases only — no blind `db push` (remote/local drift).
