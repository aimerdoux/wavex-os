# Tony Apple QA Studio — WaveX OS E2E QA Report

**Date:** 2026-05-17
**Tester:** QA agent (Claude Opus 4.7) on operator's Mac (warm, pre-paired)
**Repo:** `/Users/geniex/wavex-os` @ `fa645dd4` (origin/main)
**Persona:** Tony Stark — QA Engineer at Apple, solofounder of a pre-revenue mobile-app QA B2B SaaS, hybrid GTM, GitHub + Linear + Slack, prefers Telegram

---

## 1. Executive summary (5 lines)

1. **Bootstrap (`pnpm wavex:start`)** — **YELLOW**: stalls on the device-pairing stage because the cached token expired 1.7 days ago and the refresh_token in this dev install is a placeholder. Tony would see a browser pop. Daemon + first cycle never ran.
2. **Dev servers (`pnpm dev`)** — **GREEN** (existing operator session is healthy); but a fresh `pnpm dev` collides on port 5173 with no graceful handling.
3. **Onboarding wizard, pillars 1–5** — **RED**: Pillar 1 silently falls back to a regex/keyword "manual_capture" path (no real LLM enrichment) — `enrichment_status: "manual_capture"`. Pillar 2 auto-fills `max_20x` with no inference and labels itself "Pool A" in BYOC mode. Pillars 3/4/5 each call Pool A `/suggest`; all calls fail with `claude-hosted-shim: fetch failed`; the UI never falls back to Pool B because `/api/inference-status` gates Pool B on the (broken) device-token instead of local `claude auth status`. **Inference fires on ZERO of the 5 pillars** under realistic warm-machine conditions even though Pool B works when called directly.
4. **Monte Carlo + finalize** — **RED**: finalize runs in **58 ms** with zero LLM calls. The MC report is deterministic (`seed: 42`, all `mean_mrr_growth: 0`, identical template-string rationale). The uncommitted `mc-narrate` route (which is supposed to add the LLM reasoning layer) has a **schema mismatch** (`results` vs `strategies`) and silently 4xxs.
5. **Paperclip first-cycle activation** — **YELLOW/RED**: 17 agents created and 13 are in `running`, but every agent run logs `local agent jwt secret missing or invalid; running without injected PAPERCLIP_API_KEY`. The CEO is briefed with a hardcoded target ("defend MRR 5000 → 15000 over 90 days") despite Tony being pre-revenue at $0. The Supabase manifest push silently fails (`column reference "company_id" is ambiguous` in `wavex_os_record_company_manifest`).

**Shippable verdict: NO.** Tony would experience the wizard as a paper form (zero real inference per pillar), and his CEO would start work briefed against fabricated MRR targets. **The 5 P0 fixes below are pre-launch gating.**

---

## 2. Stage-by-stage timing

### Phase 1 — Bootstrap

| Stage | Status | Duration | Detail |
|---|---|---|---|
| preflight | OK | <1s | node + pnpm + git on PATH |
| pulling latest | OK | ~1s | already up to date |
| installing deps | OK | ~2s | pnpm install clean |
| Claude Code CLI | OK | ~1s | 2.1.143 |
| device pairing | **HANG** | killed after 30s | prompted browser pairing — expired token, placeholder refresh_token (`test-refresh-not-used`) |
| Claude auth | n/a | n/a | not reached |
| legacy proxy | n/a | n/a | not reached (independently verified: `com.wavex-os.claude-code-proxy.plist` already absent) |
| daemon service | n/a | n/a | not reached (manually invoked: `render-launchd-templates.mjs` 0.03s; `launchctl load -w ~/Library/LaunchAgents/com.wavex-os.local-ops.plist` succeeded; `com.wavex-os.local-ops` is registered) |
| first cycle | n/a | n/a | not reached (manually invoked: `wavex-local-ops-cycle.mjs` 6.7s; cloud_push=ok; checks.token=refresh_failed; checks.processes.* all alive) |

**Phase 1 P0**: the customer-facing `pnpm wavex:start` cannot complete on this machine without a re-pair — even though every other capability is healthy.

### Phase 2 — Dev servers

| Check | Result |
|---|---|
| `pnpm dev` cold start | **FAIL** — port 5173 in use (long-running operator session) → exit 1, no fallback messaging |
| Existing servers reachable | OK — `GET /` 200 in 52ms, `GET /api/system/health` 200 in 10ms |
| Mock-core banner visible | n/a (started days ago by operator) |
| Vite banner visible | n/a (same) |

### Phase 3 — Wizard run-through (companyId `tony-apple-qa`)

| Step | Wall-clock | Inference fired? | Notes |
|---|---|---|---|
| `/onboarding` → `/onboarding-chat` redirect | 0.1s | — | Welcome shows 3 cards (Avatar / Solo Founder / Hybrid). |
| Click "Solo Founder" | 2.5s | — | Reveals chat hero "What do you want to build?". |
| Type Tony's pitch + ↑ | 5s total | **NO** (`enrichment_status: "manual_capture"`) | Server fast-paths to regex heuristics whenever `manual_context ≥ 40 chars` and never calls Claude. |
| Pillar 1 confirm card | <1s | — | UI offers correctable chips (industry, model, has_product). Tony clicks "Looks right — keep going →". |
| Pillar 2 (Claude plan) | <1s | **NO** | UI auto-POSTs `{"claude_plan":"max_20x"}` — no user dialog, no inference. Persisted `claude_version: "wavex-os hosted (Pool A)"` is **wrong** under BYOC. |
| Pillar 3 suggest | 1s | **FAILED** (502/Pool A) | `claude -p exited 70: claude-hosted-shim: fetch failed`. UI does not retry Pool B because `/api/inference-status.mode !== "pool_b"`. Card renders un-highlighted chips. |
| Pillar 3 submit (manual chips) | <1s | — | Stage chip options for "Built but not selling" are revenue brackets only — no pre-revenue option. |
| Pillar 4 suggest | 1s | **FAILED** | same as P3. |
| Pillar 4 submit | <1s | — | `sales_motion` has no "hybrid" enum — Tony forced into `assisted_demo`. |
| Pillar 5 suggest | 1s | **FAILED** | same. |
| Pillar 5 submit | <1s | — | `comm_channel: telegram` accepted. |
| Connector manifest gen | 6s | **FAILED** (T2 fell back to decision-matrix) | `warnings: ["T2 generation failed: claude -p exited 70: claude-hosted-shim: fetch failed"]`. Output excluded Linear + Slack (Tony's stated stack). |
| Swarm manifest gen | <1s | **NO** (`generated_by: T0 · decision-matrix-fallback`) | 25/34 agents active, sensible org. |
| Finalize | **58 ms** | **NO** | Workflow regen + manifest assembly + MC sim all bundled, totally programmatic. |
| MC report | — | **NO** (deterministic `seed:42`) | All `mean_mrr_growth: 0`, identical hardcoded template rationale. The new `mc-narrate` route is unwired and broken (schema mismatch). |
| `POST /api/instance/tony-apple-qa/activate` | ~700 ms | — | Paperclip company + 35 wavex_agents inserted; Supabase `wavex_os_record_company_manifest` silently 400'd. |

### Phase 4 — Paperclip first cycle

| Check | Result |
|---|---|
| Paperclip company created | OK — `c293df60-5f75-48a3-8fdc-201464473094` |
| Agents handed off | 17 (CEO + Chief of Staff + CPO/CMO/CRO leads + 12 sub-roles) |
| Agent fleet shape vs Tony | **Mostly OK** — slot-matrix selected `api-tester` for `cpo.qa`, `community-builder` for `cmo.demand`/`cmo.advocacy`, `content-creator` for `cmo.brand`. CRO has outbound/demo/close/expansion (fits hybrid motion). Skill overlays look context-aware. |
| Agents running | 13 / 17 (CEO + Chief-of-Staff + CPO/CMO/CRO + most subs) |
| Heartbeats | None — `lastHeartbeatAt: null` everywhere |
| **PAPERCLIP_API_KEY injection** | **BROKEN** — every run logs `local agent jwt secret missing or invalid; running without injected PAPERCLIP_API_KEY`. Agents fire but can't write back to Paperclip API. |
| Issues created | 18 (5 Roadmap + 13 `task_brief/dept_status/lead_list/kpi_history/open_deals`) — **generic boilerplate**, not Tony-specific. |
| CEO CONTEXT.md correctness | Company-context paragraph: ✓ correct. ICP "enterprise ops teams": ✗ wrong. Differentiator: just echoes pitch. **Goal "MRR 5000 → 15000": HARDCODED template — Tony is at $0**. |

### Phase 5 — five-feature sanity

| Feature | Result |
|---|---|
| Pool C injection (Expert Agent) | **EMPTY** — `wavex_os_injection_queue_pull(p_subscription_id=<tony_user>)` returns `[]`. (Manifest never landed in Supabase, so the trigger that enqueues never fired.) |
| Mission Control fleet visibility | **NOT YET POPULATED** — daemon's next 5-min cycle hasn't fired since activate; existing `os_record_instance_health` RPC works (used by local-ops). |
| Manifest persistence (Supabase) | **BROKEN** — `wavex_os_record_company_manifest` returns `42702: column reference "company_id" is ambiguous`. Local disk fine. |
| Connector marketplace (AddConnectorWidget) | Present at `packages/onboarding-ui/src/op-omega/components/AddConnectorWidget.tsx` (393 LOC); used by `Phase2Connectors.tsx`. Reachable but not yet relocated to a Paperclip wavex-os instance (per task note). |
| Pool A fallback when BYOC unavailable | **NOT TESTED** — would require `claude auth logout` which I declined to do (task constraint: warm machine, restore claims). Pool A is already failing under normal conditions (see above) regardless. |

---

## 3. Friction log (what Tony would have to think about)

| # | Where | Friction |
|---|---|---|
| F1 | Bootstrap | Re-pairs on every >1-hour gap because access_token TTL is 1h and refresh_token in dev installs is `"test-refresh-not-used"`. A non-technical buyer would refuse to repeatedly re-pair. |
| F2 | Local-ops state | After bootstrap, UI shows persistent banner "**! Action required** — Discard local changes" because the wavex-os git tree has my QA artifact directories. A paying customer's clone wouldn't have uncommitted changes — but the same banner appears for every `wavex-local-ops-cycle` after any apt-driven file change. The "Discard local changes" CTA is **dev-only language** that shouldn't leak into BYOC UI. |
| F3 | Wizard hero | The chat hero accepts a free-text pitch but **converts it into a slug** via `deriveSlug` (looks for a URL). When Tony pastes a pitch without a URL, the slug becomes "tony-apple" (first 3 words) and resumes any prior company with that slug — leaking state from prior tests. |
| F4 | Pillar 1 confirm | The card shows 3 chip groups (industry / model / has_product). The heuristic correctly picks `dev_tools` and `subscription` for Tony, but silently invents `ideal_customer_profile: "enterprise ops teams"` and `competitive_position: "emerging"` based on regex — **not surfaced for review**. Those wrong values leak straight into the CEO's CONTEXT.md. |
| F5 | Pillar 2 | Tony never chose `max_20x`. The system auto-decides + auto-submits. Under BYOC this should ask "We see you have a Claude Max subscription — confirm we use it?" |
| F6 | Pillar 3 stage chips | For `product_state: built_not_selling`, only revenue brackets (< $10k MRR, $10k–$100k…) are shown — no semantic option for pre-revenue. Tony is forced to either pick "< $10k MRR" (wrong because $0 isn't < $10k in spirit) or "Other — specify". |
| F7 | Pillar 4 motion | "Hybrid" isn't an enum (`self_serve_plg / assisted_demo / high_touch_enterprise / none_yet / other`). Tony has to pick "assisted_demo" + "other" — the description is lost. |
| F8 | Pillar suggest reasoning chip | Always absent because every `/suggest` call fails with `claude-hosted-shim: fetch failed`. UI doesn't fall back. |
| F9 | Pillar 5 test-send | Telegram option exists but never asks Tony to provide chat_id / bot_token; persists `comm_channel: telegram` with no `comm_config`. CEO's Telegram dispatch will silently noop. |
| F10 | Finalize speed | 58 ms feels suspicious for "5-strategy Monte Carlo + manifest assembly + signing". No "thinking" feedback to soften that. |
| F11 | Activate "warnings" | The activate response shows 4 `matrix-selected` warnings about default overrides — useful debug info, but customer-facing language. |
| F12 | First-cycle CEO brief | `monthly_recurring_revenue: 5000 → 15000` is hardcoded in the agent template. Tony's CEO has a fabricated MRR target on minute 1. |

---

## 4. Inference-per-pillar table

| Pillar | Has "Suggest" UI? | Fires LLM in normal warm-machine state? | What fires instead |
|---|---|---|---|
| 1 (Org/context) | No explicit button — chat hero | **NO** | `handlePillar1` short-circuits to `manual_capture` (regex `guessIndustryHint/guessBusinessModelHint/...`) when `manual_context ≥ 40 chars`. Loaded directly into pillar_responses.json with `enrichment_status: "manual_capture"`. |
| 2 (Claude plan) | No | **NO** | Auto-POSTed with `claude_plan: max_20x`. No LLM call. |
| 3 (Product state / stage) | Implicit (`usePillarSuggestion` on mount) | **NO** (Pool A 500 + UI gate prevents Pool B) | Card renders un-highlighted chips. `POST /op-omega/onboarding/pillar/3/suggest` → `{ok:false, error:"claude -p exited 70: claude-hosted-shim: fetch failed"}` |
| 4 (Sales motion / lead sources) | Same | **NO** | Same Pool A failure. |
| 5 (Comm channel) | Same | **NO** | Same Pool A failure. |
| MC simulation | No | **NO** | Deterministic (`seed: 42`); `mc-narrate` route exists but is uncommitted, unwired, and has a schema bug (`report.results` vs `report.strategies`, `winner.strategy` vs `winner.strategy_id`). |
| Connector recommendation (between P5 + Swarm) | n/a | **NO** | `generateConnectorManifest` returns `source: "fallback"` with `T2 generation failed` warning. |
| Workflow generation | n/a | **NO** | `finalize` calls with `skipInference: true`. |
| Swarm generation | n/a | **NO** | `generated_by: "T0 · decision-matrix-fallback"`. |

**Confirmed**: under realistic warm-machine conditions with an expired device token, **zero LLM calls fire across the entire onboarding wizard**. Every "AI" output is regex heuristics or hard-coded options. This is the failure mode the user warned about. Pool B (BYOC) **does work when called directly** (`curl /op-omega/onboarding/pillar/3/suggest-pool-b` returns real, context-aware suggestions in ~7s) — the wiring is just wrong.

---

## 5. Screenshots

All saved under `docs/qa/2026-05-17/screens/`:

- `00-welcome.png` — first-load Welcome (Avatar / Solo Founder / Hybrid)
- `01-after-solo.png` — chat hero "What do you want to build?"
- `02-pitch.png` — Tony's pitch typed
- `03-after-pitch.png` / `04-pillar1-result.png` — Pillar 1 confirm card with heuristic-derived chips
- `s00.png` … `s29.png` — first drive (1 stuck on infinite Pillar 1 confirm due to redirect-companyId race)
- `d4-*.png` — pillar 3 attempt + after
- `d5-*.png` — final fresh-companyId drive

(60 PNGs total — a representative subset is sufficient. The "thinking" overlays were never observed because no LLM call was in flight.)

---

## 6. Network log highlights

Real API request/response shapes captured at `docs/qa/2026-05-17/artifacts/network.ndjson` (+ network2 + network3).

```
POST /op-omega/onboarding/pillar/1
  body = {"companyId":"tony-apple-qa","org_name":"tony-apple-qa","raw_input":"no product yet","manual_context":"Tony Apple QA Studio — …"}
  resp = {"ok":true,"response":{"enrichment_status":"manual_capture", …regex-derived fields…}}    [served in <1s]

POST /op-omega/onboarding/pillar/2
  body = {"companyId":"tony-apple-qa","claude_plan":"max_20x"}    [auto, no LLM]
  resp = {"ok":true,"response":{"claude_plan":"max_20x","claude_version":"wavex-os hosted (Pool A)", …}}

POST /op-omega/onboarding/pillar/3/suggest   (Pool A — UI gate prevented Pool B)
  resp = {"ok":false,"pillar":3,"recommended":{},"reasoning":null,
          "error":"claude -p exited 70: claude-hosted-shim: fetch failed\n"}

POST /op-omega/onboarding/pillar/3/suggest-pool-b   (manually called by QA)
  resp = {"ok":true,"pillar":3,
          "recommended":{"product_state":"built_not_selling","stage":"pre_revenue_validating"},
          "reasoning":"Working product exists but no paying customers yet — classic built-not-selling, validating PMF pre-revenue.",
          "mode":"pool_b"}    [served in ~7s]

GET  /api/inference-status
  resp = {"ok":true,"online":false,"mode":"offline","reason":"refresh_failed",
          "detail":"refresh_failed: invalid_refresh_token"}

POST /rest/v1/rpc/wavex_os_record_company_manifest   (Supabase)
  resp = 400 {"code":"42702","details":"It could refer to either a PL/pgSQL variable or a table column.",
              "hint":null,"message":"column reference \"company_id\" is ambiguous"}
```

---

## 7. Top 5 P0 fixes (gate launch)

| # | Issue | Customer impact | Where |
|---|---|---|---|
| **P0-1** | **`/api/inference-status` gates Pool B on device-token instead of local Claude auth.** UI never routes pillar 3/4/5 suggest to BYOC because `mode` is `"offline"` whenever the cached cloud JWT expires (every 1h in dev installs). Net effect: 0 inference firings across pillars 3–5 for the typical paying customer. | Wizard feels programmatic; Pillar 1 + 2 + 3 + 4 + 5 all run without LLM. | `packages/op-omega-server/src/routes/device-status.ts` — should report `online: true, mode: "pool_b"` whenever `claude auth status` reports `loggedIn === true`, regardless of device-bundle state. The UI's `isPoolBReachable` (in `lib/api.ts`) is correct. |
| **P0-2** | **Pillar 1 manual_context bypass.** When the chat hero sends `manual_context ≥ 40 chars`, the server skips the T2 enrichment call entirely and returns regex-derived fields. The "thinking…" bubble in the UI is theatre. | Tony's wrong "ideal_customer_profile: enterprise ops teams" + fake differentiator + ICP errors propagate into every downstream agent's CONTEXT.md. | `vendor/op-omega/onboarding/src/phases/phase-1-onboard/pillar-1.ts:272-292`. Either always call T2 (and let it override the heuristic) or route through BYOC for the chat-hero path. |
| **P0-3** | **Monte Carlo is fully programmatic.** finalize completes in 58 ms with `seed: 42` and identical hardcoded `winner.rationale` template strings. `mc-narrate` exists (uncommitted at `routes/mc-narrate.ts`) but (a) isn't wired into finalize, (b) parses `report.results` while the actual report uses `report.strategies` + `winner.strategy_id`. The CEO's strategy choice is template, not reasoned. | Violates the explicit user requirement "Monte Carlo must not be programmatic". | Fix mc-narrate schema; call it from finalize; surface its narrative to the user before they hit Activate. |
| **P0-4** | **Supabase manifest push silently fails.** `wavex_os_record_company_manifest` returns 400 `42702 ambiguous "company_id"`. Server logs the failure to console but `activate` returns `ok: true`. Manifests never land in `wavex_os.company_manifests`. | No Mission Control row, no Pool C injection enqueue, no fleet observability for the paying customer. The whole "centralized observability" story is dead from day 1. | Fix the SQL function (likely a `company_id` parameter shadowing a column inside the function body). Add an outbound-call check in `activate.ts` so the response surfaces the cloud-sync failure instead of swallowing it. |
| **P0-5** | **CEO briefing carries hardcoded MRR target.** Tony (pre-revenue, $0 MRR) gets a CEO briefed to "defend monthly_recurring_revenue 5000 → 15000 over 90 days". And every agent run logs `local agent jwt secret missing or invalid`, so the CEO can't write back to Paperclip even if it tried. | Day-1 CEO acts on fabricated targets, then can't report. Worst single-finding for "does it feel like an AI company in a box?" | Template path in `packages/agent-templates/ceo/AGENTS.md`. The `5000 → 15000` is a placeholder that needs to read from manifest goal. The JWT injection problem is in `packages/core/server/src/services/heartbeat.ts` (agent invoke path). |

---

## 8. Top 5 P1 polish items

| # | Issue | Where |
|---|---|---|
| **P1-1** | Dirty-tree banner "Discard local changes" surfaces to BYOC customers. Customer-mode flag should hide it (no developer ever runs `pnpm wavex:start` from a clean clone). | `packages/onboarding-ui/src/components/SystemHealthChip.tsx` (and the `requires_user_action.reason: "dirty_tree"` source: `scripts/wavex-local-ops-cycle.mjs`) |
| **P1-2** | "Hybrid" sales_motion has no enum option. Tony's motion is real (sales + PLG). Add `hybrid_plg_sales` (and surface a "Suggested for you" reasoning chip). | `vendor/op-omega/onboarding/src/schema/pillar-responses.ts` + `packages/onboarding-ui/src/op-omega/lib/options.ts` |
| **P1-3** | "Built but not selling" forces revenue brackets for the stage chips. Tony has $0 MRR — no semantic option fits. Mirror the `STAGE_PRE` options here. | `packages/onboarding-ui/src/op-omega/components/inline-cards/Pillar3PromptCard.tsx:67` |
| **P1-4** | `deriveSlug` swallows pasted pitches that don't contain a URL into "first 3 words" → reuses prior tenant's company state. Should either accept the typed company name verbatim or prompt explicitly. | `packages/onboarding-ui/src/op-omega/pages/OnboardingShell.tsx:48-58` |
| **P1-5** | `claude_version: "wavex-os hosted (Pool A)"` persisted into pillar_2 even under BYOC. Mislabels every downstream attribution. | `packages/op-omega-server/src/routes/pillars.ts` (Pillar 2 handler — should read `WAVEX_INFERENCE_MODE` or the `inference-status` mode). |

---

## 9. What we couldn't observe from this warm Mac

Calling these out so the launch deck doesn't claim a fresh-machine test happened here:

- **First-time browser pairing flow** — this Mac already had `device-token.json` so we never saw the pairing UX; we only saw the **expired**-token branch.
- **Cold `pnpm install`** — dependencies were on disk and warm.
- **Claude Code CLI install path** — `claude` was already on PATH; the `npm install -g @anthropic-ai/claude-code` branch didn't fire.
- **Claude OAuth browser pop** — already authed (`claude.ai`, dylanriedw10@icloud.com, max plan).
- **Cloudflare named-tunnel deploy** — `com.wavex-os.cloudflared` was already loaded from the operator's previous session.

A fresh machine would also hit (at minimum): pairing browser pop, claude install + browser pop, Telegram bot setup (still un-prompted), GitHub OAuth, Linear OAuth, Slack OAuth.

---

## 10. Artifacts

- Full report: `/Users/geniex/wavex-os/docs/qa/2026-05-17/tony-e2e-report.md` (this file)
- Screenshots (60): `/Users/geniex/wavex-os/docs/qa/2026-05-17/screens/`
- API request/response logs: `docs/qa/2026-05-17/artifacts/network*.ndjson`
- Bootstrap stdout: `docs/qa/2026-05-17/artifacts/bootstrap.log`
- Local-ops cycle state: `docs/qa/2026-05-17/artifacts/local-ops-state.json`
- Tony's persisted pillar responses: `docs/qa/2026-05-17/artifacts/tony-pillar_responses.json`
- Tony's Monte Carlo report: `docs/qa/2026-05-17/artifacts/tony-monte_carlo_report.json`
- Tony's signed company manifest: `docs/qa/2026-05-17/artifacts/tony-company.manifest.json`
- Tony's CEO context overlay: `docs/qa/2026-05-17/artifacts/tony-ceo-context.md`
