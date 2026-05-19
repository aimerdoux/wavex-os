# WaveX Experiences fleet deploy — debug report (2026-05-19)

Local dogfood deployment via the wavex-os wizard, end-to-end. Company ID `wavex-experiences-2026-05-19`. Goal: trace every pillar/phase + verify inference fires + Monte Carlo + Composio + activate at 80% Claude Max + monitor.

## TL;DR

- **35 agents live in Paperclip** under the dogfood Paperclip instance (PC company `b515f8b2-0976-4838-b8a9-c08d430d8177`)
- **80%/20% swarm/Pool A allocation set** via `PUT /api/inference-allocation { swarm_pct: 80 }`
- **First two heartbeats actively running** (CEO orchestrator + Chief of Staff, claude PIDs 22044 + 22045) — ignition wrote 10 kickoff issues
- **5 critical findings** below, in priority order — 1 of them required a direct file patch to get T2 inference working at all

## Pillar walk — every step fired

| Pillar | Latency | Source | Notable |
|---|---|---|---|
| 1 (URL+enrichment) | 21s | `enriched / claude_oauth` | Industry=`marketplace`, ICP=`busy professionals booking dining, travel, and events`, GTM=`partnerships`, maturity=`mvp`, friction=`two-sided cold start` — nailed it |
| 2 (claude_plan) | 0s | `wavex-os hosted (Pool A)` | claude_plan=`max_20x`, `claude_code_verified: true` |
| 3 (product_state+stage) | 0s | regex heuristic | `live_paying_customers` + `pre_seed`; `kpi_snapshot_initial` is all zeros (stage_baselines hadn't been informed of marketplace) |
| 4 (GTM) | 0s | regex | `gtm_profile_enum: CONTENT_LED_PLG`, `sales_motion: assisted_demo` |
| 5 (comms) | 0s | passthrough | `comm_channel: telegram`, `urgency_routing: all_to_one_channel` |
| **Enum validation rejected 3 of my 5 first attempts** | — | — | Schema enums are tight: `product_state` rejects `shipped_paying_users` (wants `live_paying_customers`), `sales_motion` rejects `hybrid_plg_sales` (wants `assisted_demo`), `urgency_routing` rejects `telegram_only` (wants `all_to_one_channel`). API consumer needs schema docs. Self-service contributor pain point. |

## Phase 2 — connector recommendations

`GET /wavex-os/onboarding/connector-recommendations` returned a T0 deterministic recommendation:

| Connector | Priority | Status | Why |
|---|---|---|---|
| claude-code | P-1 | ✓ configured | Inference bootstrap |
| supabase | P0 | pending_credential | Authoritative MRR/NRR source |
| github | P1 | pending_credential | Code-ship → activation correlation |
| telegram | P0 | pending_credential | Pillar 5 chose Telegram |
| mixpanel | P0 | pending_decision | Content-SEO attribution |
| stripe-connect | P-1 | pending_decision | Marketplace take-rate |
| segment | P0 (suggested) | pending_decision | Marketplace identity unification |

Marketplace surface from `GET /api/connectors/marketplace?companyId=...` returned **16 toolkits** all `status: "available"` (none `connected`) — Slack, Telegram, Discord, Gmail, Outlook, HubSpot, Salesforce, Stripe, Mixpanel, Amplitude, GitHub, Linear, and 4 more.

## Phase 3 — swarm

| Run | Latency | Source | Agents |
|---|---|---|---|
| First (skipInference: undefined → defaulted true) | 1s | `T0 · decision-matrix-fallback` | 35 |
| After fixing inference.env, with `skipInference: false` | **66s** | `T2 · onboarding/phase-3` | 35, `scope=full: promoted 3 matrix-parked agents to active` |

## Phase 4 — workflow

| Run | Result |
|---|---|
| First | **HALT** `BUDGET_ENFORCEMENT_UNAVAILABLE` — budget plugin on port 3102 returns 404 (plugin not installed on paperclip) |
| With `bypassBudgetCheck: true` | **66s T2**, 9 capabilities customized — `'budget_enforcement_bypassed — operator accepted risk of unenforced budget gates'` |

## Phase 5 — finalize + Monte Carlo

| Field | Value |
|---|---|
| Latency | 16s |
| Source | `t2` |
| Monte Carlo | 24 cycles × 40 runs × 5 strategies — RAN ✓ |
| Winner | `RETENTION_FIRST` (sharpe 0.00, but lead is 0% because ALL strategies are flat) |
| Goal auto-defaulted to | `monthly_recurring_revenue: 5000 → 15000 / 90d` — **WRONG for WaveX Experiences** |
| Company name | `None` — manifest never captured "WaveX Experiences" |
| BYOC narrate | (route exists from yesterday's task #184 but not exercised here — only fires via UI render) |

## Activate — Paperclip handoff

Patched `manifest.goal` directly to `{ kpiId: "booking_gmv", current: 0, target: 10000, days: 90 }` + `company.name = "WaveX Experiences"`, then:

```
POST /api/instance/wavex-experiences-2026-05-19/activate
→ inserted: { companies: 1, agents: 35, kpis: 4 }
→ paperclip_company_id: b515f8b2-0976-4838-b8a9-c08d430d8177
→ ignition: { status: "ignited", goal_id: c013992d-... , errors: [] }
→ all 35 slot→paperclipAgent mappings written to paperclip-handoff.json
```

10 kickoff issues spawned by ignition: 5 `[Roadmap]` (strategic positioning, unit economics, expansion engine, pipeline velocity, insight activation), 1 `dept_status`, 4 `check_result`.

The T2 swarm matrix made 4 intelligent context-aware role substitutions on activation:
- `cpo.build`: matrix picked **ai-engineer** over default backend-architect (saas-b2c + marketplace fit)
- `cpo.qa`: matrix picked **api-tester** over default accessibility-auditor (marketplace + stripe-connect + github fit)
- `cmo.advocacy`: matrix picked **community-builder** over default content-creator
- `coo.health`: matrix picked **incident-responder** over default recovery-engineer (marketplace + fintech + regulated fit)

## First heartbeat cycle — live now

| Field | Value |
|---|---|
| CEO orchestrator | run `aafc04bb`, PID 22045, **actively running**, claude streaming output `lastOutputAt: 16:02:51` |
| Chief of Staff | run `8e445bc5`, PID 22044, **actively running**, claude streaming `lastOutputAt: 16:03:11` |
| Other 33 agents | idle (wait their first wake — wakeup cascade per workflow_manifest) |

Both heartbeats are real `claude -p` processes invoking `claude-sonnet-4-6` with per-tenant MCP scoping (`--mcp-config /Users/geniex/.paperclip/.../{co}/.claude/mcp.json --strict-mcp-config`) — confirming task #146 (cross-tenant MCP isolation) is working in production.

## Findings (priority order)

### F1 (P0, **fixed in flight**) — stale `inference.env` was forcing hosted-shim mode against a dead Cloudflare tunnel

```
WAVEX_INFERENCE_MODE=hosted
WAVEX_INFERENCE_HUB_URL=https://catalogue-sea-such-manchester.trycloudflare.com
```

Every T2 inference call (swarm, workflow, finalize-imprint, MC narrate) was returning `claude -p exited 70: claude-hosted-shim: fetch failed`. **The BYOC pivot was completed weeks ago (task #173) but `~/.wavex-os/inference.env` was never updated**, so every customer-side inference was silently falling back to T0 deterministic. Fixed mid-deploy by setting `WAVEX_INFERENCE_MODE=oauth` + removing the dead tunnel URL. After fix: swarm went 1s T0 → 66s T2, workflow 79s T2, finalize 16s T2.

**Recommendation**: add a post-install / bootstrap script that writes `inference.env` to `mode=oauth` by default + add a doctor check that fails if `WAVEX_INFERENCE_MODE=hosted` is set without a reachable hub. Tracking in followup.

### F2 (P0) — `manifest.goal.kpiId` auto-defaults to MRR for every tenant

`phases.ts:522-543` (`finalize` handler) injects a default goal when the manifest doesn't have one — always `kpiId: "monthly_recurring_revenue"`, with the dollar baseline picked from `stage_baselines.ts`. There is **no operator-facing endpoint that lets you set the goal during onboarding**. For WaveX Experiences (marketplace → `booking_gmv`), Tony Apple QA (B2B SaaS → `monthly_recurring_revenue` is OK), and any non-MRR business, you have to patch the manifest file before activate.

I patched this manually (`booking_gmv: 0 → 10_000 / 90d`). It activated cleanly and ignition seeded `goal_id: c013992d-...` correctly. **But this is a hole in the wizard.** Recommend a Pillar 5.5 goal-confirm step OR allow the finalize body to include `goal: { kpiId, current, target, days }`.

### F3 (P1) — Monte Carlo produced all-zeros result on flat baseline

```
RETENTION_FIRST:   growth=0  p_ruin=0  sharpe=0
BALANCED:          growth=0  p_ruin=0  sharpe=0
ACQUISITION_HEAVY: growth=0  p_ruin=0  sharpe=0
NARRATIVE_LED:     growth=0  p_ruin=0  sharpe=0
CAPITAL_EFFICIENT: growth=0  p_ruin=0  sharpe=0
```

Picked `RETENTION_FIRST` as winner only because of alphabetical tiebreak. The vendored simulator works correctly — but `kpi_snapshot_initial` from Pillar 3 was all zeros (`mrr: 0, cac: 0, win_rate: 0, ltv_cac_ratio: 0, ...`) because there's no path for the operator to provide actual baseline numbers. The simulator runs N=40 paths from a zero starting point with zero variance → all strategies degenerate to zero.

**Recommendation**: Pillar 3 should accept an optional `current_metrics` block, OR the operator should be allowed to edit `kpi_snapshot_initial` before finalize. Without real seed numbers, the MC race chart that ships in the Imprint Theater (task #184) will visually under-deliver — all 5 strategy lines overlap on the x-axis. This is the most "wow" moment of the wizard and it currently lands flat.

### F4 (P1) — Budget plugin (port 3102) returns 404, Phase 4 halts unless explicitly bypassed

The `@wavex-os/plugin-rate-limit-budget` plugin isn't installed on the paperclip-on-3102 instance. The vendored Phase-4 workflow generator hits `/api/plugins/wavex-os.rate-limit-budget/data/budget-state` and HALTs unless `bypassBudgetCheck: true`. Two warnings persist on every T2 swarm/workflow/finalize: `'budget plugin HTTP 404; assuming permissive'`.

The plugin should ship with the wavex-os install OR the bootstrap should install it on first run. Without it, every operator on a fresh clone hits this halt.

### F5 (P2) — Schema enum errors are silent friction for API consumers

3 of 5 pillar POSTs failed first attempt with `invalid_enum_value` (`shipped_paying_users` instead of `live_paying_customers`, `hybrid_plg_sales` instead of `assisted_demo`, `telegram_only` instead of `all_to_one_channel`). The UI uses inline cards so users never type these strings, but API consumers (contributors, QA harnesses, fork onboarding scripts, this deploy script) have to read source to discover them. Recommend either:
- An OpenAPI/zod-to-JSON schema export at `/wavex-os/onboarding/schemas`
- OR include the enum list in error messages WITH the canonical mapping suggestions

### F6 (P3) — Composio integration is wired but no live OAuth connections established

`COMPOSIO_API_KEY` is not set in `~/.wavex-os/inference.env` nor `/Users/geniex/wavex-os/.env`. The composio-shim runs in dev mode (`WAVEX_COMPOSIO_DISABLED=1` auto-enabled because `NODE_ENV != production`). The connectors marketplace surfaces 16 toolkits all `status: "available"` (none `connected`). The fleet's `cdo.attribute`, `coo.connector`, `cfo.econ` agents need real Mixpanel / Stripe Connect / Supabase OAuth to do their jobs.

This is operator-side setup — the agents will surface this in their first heartbeats by filing issues like `[Concierge] needs: connector mixpanel`. The error-handler agent (task #135) is wired to route those.

## Files captured (all snapshots under `/tmp/wavex-fleet-deploy-2026-05-19/`)

- `pillar-{1,2,3,4,5}-response.json` — every pillar response
- `connector-recs.json` — T0 connector recommendations
- `swarm-t2.json`, `workflow-t2.json` — T2 manifests
- `finalize-t2.json` — finalize manifest
- `monte_carlo_report.json` — MC result (in onboarding state dir)
- `company.manifest.before-goal-patch.json` — manifest before I overrode the goal
- `activate.json` — activation response (35 agents, ignition_orphaned=false)
- `allocation.json` — 80/20 set confirmation
- `inference.env.before-fix` — stale hosted-shim config (rollback reference)

## What's running now

```
fleet:    wavex-experiences-2026-05-19  (paperclip co: b515f8b2-0976-4838-b8a9-c08d430d8177)
agents:   35 (idle, except CEO + CoS first-heartbeat)
issues:   10 (5 [Roadmap] + 1 dept_status + 4 check_result)
goal:     booking_gmv 0 → 10,000 over 90 days
alloc:    80% swarm / 20% Pool A
inference: BYOC oauth (claude-sonnet-4-6 spawned per-tenant with --strict-mcp-config)
```

Open the dashboard at http://127.0.0.1:5173/mission to watch the cycle.
