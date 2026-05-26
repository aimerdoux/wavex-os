# WaveX OS

> Open-source operating system for running an AI agent company on your localhost.

[![npm version](https://img.shields.io/npm/v/tony-apple-qa)](https://www.npmjs.com/package/tony-apple-qa)
[![CI](https://github.com/aimerdoux/wavex-os/actions/workflows/ci.yml/badge.svg)](https://github.com/aimerdoux/wavex-os/actions)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![GitHub Stars](https://img.shields.io/github/stars/aimerdoux/wavex-os?style=social)](https://github.com/aimerdoux/wavex-os)
[![Status: 0.2.0 / Phase H](https://img.shields.io/badge/status-0.2.0%20%E2%80%94%20Phase%20H-4ec9b0)](docs/ROADMAP.md)
[![Built on Paperclip](https://img.shields.io/badge/built%20on-Paperclip-86c5da)](https://github.com/paperclipai/paperclip)

WaveX OS is a localhost-first wizard that materializes an AI agent company in about an hour. You answer five questions (the **5 pillars**), the wizard picks an agent roster from 165 vetted templates, builds a workflow plan, runs a Monte Carlo simulation against your goal, and activates the fleet into a real **Paperclip** runtime — where each agent gets heartbeats, KPIs, budgets, and a board.

Your data and inference stay on your machine. Spawned agents use your Claude Max OAuth via a wrapper that reads the system keychain — no API keys, no remote inference, no telemetry.

![WaveX OS — wizard walkthrough](docs/images/demo.gif)

After the wizard you're on a **Mission Control** dashboard with a live fleet graph + KPI scoreboard. An optional **System Optimizer** subscription (Phase F) can inject board-level reasoning on a daily cadence using your same OAuth — code is free, hosted optimizer is a tier on top.

---

## Walkthrough — what you actually see

▶ **[Open the interactive walkthrough](https://htmlpreview.github.io/?https://github.com/aimerdoux/wavex-os/blob/main/docs/wizard.html)** — single-page wizard with autoplay, keyboard nav, and step-by-step captions. Source: [`docs/wizard.html`](docs/wizard.html) (no build step; open the file directly).

The screenshots below come straight out of the e2e suite — every one is the real wizard against a real `pnpm dev`. Reproducible via `pnpm test:e2e e2e/screenshot-walkthrough.spec.ts`.

| Step | Screen |
|---|---|
| **Start** — pick a company name (or resume a draft) | ![Welcome](docs/images/wizard/01-welcome.png) |
| **Pillar 1 — Who you are.** Tell the wizard what you're building, in plain text. T2 enrichment infers the 10 fields you'd otherwise type yourself. | ![Pillar 1](docs/images/wizard/02-pillar-1-who.png) |
| **Pillar 1 confirm.** Review what was inferred + correct anything. The wizard signs the result and persists. | ![Pillar 1 confirm](docs/images/wizard/03-pillar-1-confirm.png) |
| **Pillar 2 — Setup verification.** Probes your local Claude CLI + plan tier. Defaults to Max 5×. | ![Pillar 2](docs/images/wizard/04-pillar-2-verify.png) |
| **Pillar 3 — Product state.** Pre-product / live customers / 10K-100K MRR / etc. Drives matrix-based template selection. | ![Pillar 3](docs/images/wizard/05-pillar-3-product-state.png) |
| **Pillar 4 — GTM motion.** Lead sources × sales motion → KPI tree shape. | ![Pillar 4](docs/images/wizard/06-pillar-4-gtm.png) |
| **Pillar 5 — Comms.** Telegram, Slack, email — where board signals land. | ![Pillar 5](docs/images/wizard/07-pillar-5-comms.png) |
| **Phase 2 — Connectors.** Decision-matrix recommends required + suggested integrations based on your pillar answers. | ![Phase 2](docs/images/wizard/08-phase-2-connectors.png) |
| **Credential Concierge.** Either paste OAuth tokens now, or click Skip per-connector. Vault encrypts everything before disk. | ![Concierge](docs/images/wizard/09-credential-concierge.png) |
| **Phase 3 — Swarm.** Reactflow org chart of your generated roster. Drag, swap templates per slot, add specialist agents under any chief. | ![Phase 3](docs/images/wizard/10-phase-3-swarm.png) |
| **Phase 4 — Workflow.** Each agent's initial workload + bundle allocation. | ![Phase 4](docs/images/wizard/11-phase-4-workflow.png) |
| **Finalize — Imprint + Monte Carlo.** Click *Finalize + sign*: the simulator projects KPI movement against your goal over N cycles. Signed company manifest written to disk. | ![Finalize](docs/images/wizard/12-finalize.png) |
| **Summary before inception.** Imprint review + signed manifest summary. *Activate fleet →* enables once the signature lands. This is your last chance to inspect before agents go live. | ![Summary](docs/images/wizard/12b-finalize-after-sign.png) |
| **Mission Control — Paperclip live.** Activate hands the 35-agent fleet off to the running Paperclip instance and lands you here: KPI scoreboard + live reactflow fleet graph that polls every 8s. Click any agent to see runs, comments, budget. | ![Mission Control](docs/images/wizard/13-mission-control.png) |

---

## What works today (v0.2.0)

### The wizard (5 pillars + 3 phases + finalize)

Owned by **wavex-os** — a full-fidelity onboarding pipeline (12K LOC plugin + 2.4K LOC server + 5.4K LOC UI) vendored at [`vendor/wavex-os/`](vendor/wavex-os/). It does:

- **10-field Pillar 1 inference** with T2 enrichment + confirm/correct preview
- **Phase 2 decision matrix** for connector recommendation, with Composio fold-in when the live integration is configured
- **Phase 3 swarm generation** from a 33-slot base roster, **165 agent templates** (165 ingested via wavex-os + WaveX-authored), and a matrix that overrides defaults based on stage + GTM
- **Phase 4 workflow allocation** with budget enforcement
- **Finalize** → signed `company.manifest.json` + Monte Carlo simulation

### The runtime (Paperclip-backed)

Activate hits [`POST /api/instance/:companyId/activate`](packages/wavex-os-server/src/routes/activate.ts) which:

1. Bridges the signed manifest into the wavex DB (Drizzle, PGlite in dev / Postgres in prod) — companies + agents tables get their rows
2. Optionally **hands off the C-Suite to a running Paperclip instance** via [`paperclip-handoff.ts`](packages/wavex-os-server/src/bridge/paperclip-handoff.ts) — opt-in via `PAPERCLIP_HANDOFF_URL`. Each agent gets:
   - The role's full vendored skill bundle as `AGENTS.md` (~60KB for CEO)
   - The company's auth wrapper as adapter `command`
   - `reportsTo` chain wired in dependency order
   - Auto-approval if Paperclip raised a board-approval gate

Once handed off, agents heartbeat every 5min via Paperclip's launchd timer, spawn `claude` CLI under the wrapper, post comments + KPI snapshots back to issues, and get observed by the fleet-observer.

### What v0.2.0 added (Phase H)

| Layer | What it does |
|---|---|
| **Minimal inception kernel** ([docs](docs/MINIMAL_INCEPTION.md)) | CEO + Chief of Staff as the only required agents — exhibits coherent self-direction with one actor + one observer. C-suite is opt-in via Pillar 3 + 4 answers. |
| **Standard cross-cutting skills** ([packages/standard-skills/](packages/standard-skills/)) | Six skill files every agent loads at heartbeat start: economic self-awareness, verify-before-claim, KPI ownership, harness recognition, lessons read, delegate-or-kill. |
| **Self-healing reference impl** ([packages/healing/](packages/healing/)) | Layer 1 (wrapper 401 self-heal + Sonnet fallback), Layer 2 (OAuth refresh with concurrency lock + invalid_grant retry), Layer 3 (worker restart with SIGTERM→SIGKILL). |
| **Observability reference impl** ([packages/observability/](packages/observability/)) | Bottleneck scoring, outcome attribution, token budget + adaptive throttle, mission-control aggregator, fleet-observer markdown synthesis. |
| **Operations** ([templates/launchd/](templates/launchd/), [scripts/](scripts/)) | Six launchd templates (recovery-on-boot, recovery-12h, fleet-assessment, economics-refresh, attribution-sweep, bottleneck-digest). Sample provisioning scripts for the Chief of Staff and KPI registry. |
| **Paperclip handoff bridge** ([packages/wavex-os-server/src/bridge/paperclip-handoff.ts](packages/wavex-os-server/src/bridge/paperclip-handoff.ts)) | After bridgeAgents, mirror the C-Suite into a running Paperclip instance. Idempotent via on-disk mapping; auto-creates the Paperclip company + auto-approves hires. |

After Phase H, **fleet burn dropped 96%** on the production deployment that produced this release. Single-agent burn dropped 95% on the heaviest agent. Spinner patterns became visible and auto-pauseable in one click.

### What v0.3 added (V2 fresh-start, 2026-05-12)

A clean-slate rebuild that backports five weeks of production-fleet learnings into the templates + adds the monetization + reliability layers. The full manifest is at [docs/V2_MANIFEST.md](docs/V2_MANIFEST.md).

| Layer | What's new |
|---|---|
| **Universal kernel rule** ([_shared/SKILL_VERIFY_BEFORE_CLAIM](packages/onboarding-ui/public/agent-templates/_shared/SKILL_VERIFY_BEFORE_CLAIM.md)) | Every agent must include an independent verification probe in any "sent/deployed/applied/live" claim. Enforced by a 10min sweeper with auto-revert. Closes the SDK-returns-lie failure mode. |
| **5 kernel lessons** ([_shared/SKILL_KERNEL_LESSONS](packages/onboarding-ui/public/agent-templates/_shared/SKILL_KERNEL_LESSONS.md)) | CEO + CoS read these every cycle: SDK returns aren't delivery, forecasted deltas are inflated (require N≥3), migrations are half the work, OVERRIDE prefixes trip prompt-injection defenses, internal traffic looks like organic until you split it. |
| **WAV-6388 measurement contract** ([ceo/SKILL_KPI_OWNERSHIP](packages/onboarding-ui/public/agent-templates/ceo/SKILL_KPI_OWNERSHIP.md)) | Every issue needs target_kpi + estimated_delta + measurement_plan + baseline_snapshot. Missing any → auto-F grade. Plus the structural-zero vs measured-zero distinction. |
| **Role collapse** ([_shared/SKILL_ROLE_COLLAPSE](packages/onboarding-ui/public/agent-templates/_shared/SKILL_ROLE_COLLAPSE.md)) | Wizard now picks roster shape by Pillar 3 stage: minimal_kernel (pre_product) → collapsed_6 → hybrid → formal_9. Solo founders get further-collapsed 5-agent kernel regardless of stage. |
| **Ignition phase** ([docs/IGNITION.md](docs/IGNITION.md), [packages/wavex-os-server/src/bridge/ignition.ts](packages/wavex-os-server/src/bridge/ignition.ts)) | After activate, the fleet now boots itself: seeds first-task issues from workflow_manifest, creates the Goal, fires CEO + CoS kickoff probe, staggers heartbeat offsets. Idempotent re-run via `POST /api/instance/:id/ignite`. |
| **System Reliability agent** ([system-reliability/SKILL](packages/onboarding-ui/public/agent-templates/system-reliability/SKILL.md)) | New role added to every V2 fleet. Owns disk + RAM + inference burn as KPIs. Calls `paperclipai worktree:cleanup` (never raw rm). Pages operator via Telegram on RED. |
| **15min resource sweep** ([scripts/wrappers/resource-sweep.sh](scripts/wrappers/resource-sweep.sh)) | Platform-level launchd job, runs even when fleet is paused. Prunes reproducible artifacts at 70% disk, throttles spawns at 80%, pages operator at 90%. The disk-crash failure mode is now blocked at three layers. |
| **Stripe + Supabase billing** ([docs/PHASE_F_SETUP.md](docs/PHASE_F_SETUP.md)) | `wavex_os` Postgres schema + Stripe products + `stripe-webhook` + `create-checkout-session` edge functions + `/pricing` route with inline Supabase magic-link sign-in. F.1 is end-to-end testable with a real Stripe test card. |
| **Mac-as-inference-server scaffold** ([packages/inference-server/](packages/inference-server/)) | Fastify on :8787 + cloudflared tunnel to `api.wavex-os.com`. Pool A endpoints stubbed; real Anthropic wiring lands in G.3.b. Topology rationale: [docs/V2_CAPTURE_C_inference_server.md](docs/V2_CAPTURE_C_inference_server.md). |
| **`wavex-os audit` CLI** | `node apps/installer/bin/init.js audit` checks disk, RAM, ports, launchd jobs, service health in one shot. Distinct from `doctor` which checks env prerequisites. |
| **Operator-facing Meta Mission Control** ([admin/](admin/)) | Single-page Fastify+HTML dashboard the operator runs to see all customer subscriptions, optimizer runs, pending injections. Hand-rolled JWT auth, no SPA bundle. |

Full launch runbook: [docs/V2_LAUNCH_RUNBOOK.md](docs/V2_LAUNCH_RUNBOOK.md).

See [docs/ROADMAP.md](docs/ROADMAP.md) for the phase plan and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design.

---

## Tony Apple QA — quick install

**Tony Apple QA** is the mobile-app QA distribution of WaveX OS. It gives iOS and Android teams an AI-powered QA agent fleet that runs entirely on your laptop: smoke-test orchestration, regression coverage plans, release checklists, and a live Mission Control dashboard — all backed by your Claude Max subscription, no API keys or cloud accounts required.

```bash
npm install -g tony-apple-qa
tony-apple-qa init
```

`tony-apple-qa init` opens the five-pillar wizard in your browser. Answer questions about your app, your Claude setup, and your QA goals; the wizard builds your agent roster and activates the fleet in under an hour. See [`packages/tony-apple-qa/`](packages/tony-apple-qa/) for the full CLI reference.

---

## Quickstart (from source)

You need [Node ≥18](https://nodejs.org), [pnpm ≥9](https://pnpm.io), [git](https://git-scm.com), and a [Claude Max](https://claude.ai/upgrade) subscription on the same machine (the wizard reads from the system keychain).

If you have [corepack](https://nodejs.org/api/corepack.html) enabled (`corepack enable`), pnpm is pinned automatically via the `packageManager` field — you don't need to install pnpm separately.

```bash
git clone https://github.com/aimerdoux/wavex-os.git
cd wavex-os
pnpm install
pnpm -r --filter "./vendor/wavex-os/*" build   # build the vendored wavex-os packages
pnpm dev
```

`pnpm dev` also re-runs `pnpm install --prefer-offline` automatically as a safety net — so if you skip the explicit install step, `pnpm dev` will still bootstrap cleanly the first time.

> **Note on a benign warning.** During `pnpm install` you'll see two `WARN` lines about a `pnpm` field in `packages/core/package.json`. That's expected — `packages/core` is the vendored Paperclip subtree with its own install lifecycle (`cd packages/core && pnpm install`), and its `patchedDependencies` / `overrides` apply there, not at the outer wavex workspace. Safe to ignore.

This boots two servers in parallel:

- `http://localhost:5173` — onboarding wizard + Mission Control (Vite + React)
- `http://localhost:3101` — `mock-core` (Fastify, hosts `/api/*` + wavex-os routes)

Open [http://localhost:5173](http://localhost:5173) and you'll land on Mission Control. Click **Start onboarding** to begin the wizard.

#### Port collision on `5173`

The onboarding UI intentionally uses Vite's strict port mode so the installer,
README commands, and Playwright QA flow all point at the same address. If
`pnpm dev` exits because `5173` is already in use, stop the other Vite/dev
server and rerun:

```bash
lsof -nP -iTCP:5173 -sTCP:LISTEN
# then stop that process, or close the terminal running it
pnpm dev
```

### Optional — hand off to a running Paperclip instance

If you've got Paperclip running locally, point WaveX OS at it and the wizard's activate step will also hire your C-Suite as real Paperclip agents:

```bash
PAPERCLIP_HANDOFF_URL=http://127.0.0.1:3100 \
PAPERCLIP_HANDOFF_WRAPPER=/abs/path/to/claude-anthropic-direct.sh \
  pnpm dev
```

Without those env vars, activate writes to the wavex DB only — the agents exist as rows but don't run heartbeats. With them, the full inception loop closes.

> **`npx wavex-os init`** ships from `apps/installer/` — Phase F will publish it to npm. For now, `pnpm dev` is the supported path.

### Pair this machine with the cloud console

The cloud console at [wavexcard.com/os](https://wavexcard.com/os) shows a
device-pairing step that asks you to run a terminal command. That command is
`wavex-os login`.

`install.sh` / `install.ps1` put the `wavex-os` command on your PATH (symlinked
into `~/.local/bin`). If you cloned the repo manually, link it once:

```bash
pnpm wavex:link        # pnpm link --global of the wavex-os bin
# …or run it without linking:
pnpm wavex:os login    # equivalent to `wavex-os login`
```

Then:

```bash
wavex-os login         # opens the browser, prints a pairing code, polls until claimed
wavex-os status        # show local pairing state (add --refresh to rotate the token)
wavex-os logout        # remove the local device token
```

`wavex-os login` runs the full device-pairing flow: it `POST`s `os-link-device`,
opens `wavexcard.com/os/link?code=…`, polls `os-device-token` until you click
**Pair this device** in the browser, then writes the device JWT + refresh token
to `~/.wavex-os/device-token.json` (chmod 600). After that the local instance is
synced to the console. `init` / `doctor` / `audit` / `reset` are delegated to the
`wavex-os-installer` bin, so a single `wavex-os` command covers the whole surface.

---

## What's in the box

```
wavex-os/
├── apps/installer/                       # npx wavex-os init CLI (doctor + spawn dev:full)
├── packages/
│   ├── core/                             # Paperclip vendored via git subtree
│   ├── db/                               # PGlite (dev) / Postgres (prod) + Drizzle schema
│   ├── plugin-sdk-shim/                  # Re-exports @paperclipai/plugin-sdk surface
│   ├── auth-shim/                        # assertBoard / assertCompanyAccess gates
│   ├── composio-shim/                    # listConnections + featured toolkits
│   ├── inference-adapter/                # tier-router claudeBin (OAuth vs API key mode)
│   ├── wavex-os-server/                  # Fastify routes for vendored onboarding + activate + handoff
│   ├── onboarding-ui/                    # Vite + React wizard + Mission Control v2
│   │   └── public/agent-templates/       # 165 role-specific skill packs (CEO, CoS, CMO, CRO, …)
│   ├── mock-core/                        # In-memory stand-in for Paperclip; Fastify on :3101
│   ├── standard-skills/                  # Cross-cutting skills every agent loads
│   ├── healing/                          # OAuth refresh + worker restart reference impl
│   ├── observability/                    # bottlenecks, attribution, budget, mission-control
│   └── onboarding-server-client/         # Typed stub for future hosted backend
├── vendor/wavex-os/                      # vendored wavex-os @ d84983a1 (2026-05-03)
│   ├── plugin-sdk/                       # @paperclipai/plugin-sdk
│   ├── shared/                           # @paperclipai/shared
│   ├── tier-router/                      # @wavex-os/plugin-tier-router
│   ├── flywheel-kernel/                  # @wavex-os/plugin-flywheel-kernel
│   ├── onboarding/                       # @wavex-os/plugin-onboarding (50 src files)
│   └── VENDOR.md                         # source SHA + vendor exceptions + update procedure
├── scripts/
│   ├── wrappers/
│   │   ├── claude-anthropic-direct.sh    # macOS keychain → OAuth wrapper
│   │   └── claude-spawn.sh               # Per-spawn execution wrapper with 401 self-heal
│   ├── render-launchd-templates.mjs      # Materialize launchd plists
│   ├── provision-chief-of-staff.sample.mjs   # Kernel completion
│   └── setup-hierarchy-and-kpis.sample.mjs   # Hierarchy + KPI registration
├── templates/launchd/                    # 6 .plist.tmpl with placeholders
├── examples/                             # config + KPI registry samples
├── docs/
│   ├── ARCHITECTURE.md
│   ├── CLAUDE_MAX_HANDOFF.md
│   ├── MINIMAL_INCEPTION.md
│   ├── SELF_HEALING.md
│   ├── ROADMAP.md
│   ├── onboarding/migration-plan.md
│   ├── ops/surface-tuning-map.md         # 40 tunables (auto-generated)
│   └── images/wizard/                    # The screenshots in this README
└── e2e/
    ├── onboarding.spec.ts                # full wizard walk
    ├── flow-variants.spec.ts             # 11 variants (reset, resume, swap, conflict, …)
    ├── bug-hunt.spec.ts                  # 14 composition + edge-case scenarios
    ├── dashboard.spec.ts                 # Mission Control behavior
    ├── screenshot-walkthrough.spec.ts    # capture for this README
    └── screenshot-mission-control.spec.ts
```

---

## Architecture

```
       ┌──── localhost (your machine) ─────────────────────────────────┐
       │                                                                │
       │  Browser  ──HTTP──▶  Vite UI  ──proxy──▶  mock-core (3101)    │
       │                       (5173)                  │                 │
       │                                                ▼                 │
       │                                         macOS Keychain           │
       │                                  via wavex-claude wrapper         │
       │                          (token never leaves this box)            │
       │                                                                   │
       │                       (optional) ──HTTP──▶  Paperclip (3100)     │
       │                                              │ heartbeats,        │
       │                                              │ claude CLI,        │
       │                                              │ KPI snapshots,     │
       │                                              ▼ fleet-observer     │
       │                                         your live agents          │
       └────────────────────────────────────────────────────────────────┘
                                       ▲
                                       │  Phase F: optional, paid
                                       │  System Optimizer cron pulls
                                       │  KPI digest, posts board-level
                                       │  injection back as a comment
                                       ▼
                            api.wavex-os.com  (planned)
```

Three design principles:

1. **Your data, your inference.** Spawned agents use *your* Claude Max plan via the wrapper. Token never crosses the wire.
2. **Open-source first, paid optimizer second.** The full local product is MIT. Hosted optimizer is a tier on top.
3. **Subtractive over additive.** Every phase has a single exit criterion. We cut features that don't pull their weight.

Full design: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). OAuth handoff details: [docs/CLAUDE_MAX_HANDOFF.md](docs/CLAUDE_MAX_HANDOFF.md). Paperclip integration: [packages/wavex-os-server/src/bridge/paperclip-handoff.ts](packages/wavex-os-server/src/bridge/paperclip-handoff.ts).

---

## Pricing

- **Code:** free, MIT, fork it.
- **System Optimizer (optional cloud subscription, Phase F):**
  - Trial — 14 days free
  - Founder — $29/mo (1 daily injection, 500K tokens/mo)
  - Growth — $99/mo (hourly during business hours, 2M tokens, on-demand asks)
  - Custom — $299/mo (unlimited, dedicated optimizer)

You can self-host the optimizer too — `docs/SELF_HOSTING.md` lands with Phase F.

---

## Credits

WaveX OS stands on the shoulders of:

- **[Paperclip](https://github.com/paperclipai/paperclip)** — the agent runtime engine, vendored via git subtree at `packages/core/`.
- **[wavex-os](https://github.com/dylanriedw10-oss/operatoromega)** — the full-fidelity onboarding pipeline, vendored at `vendor/wavex-os/` (source SHA tracked in [VENDOR.md](vendor/wavex-os/VENDOR.md)).
- **[agency-agents](https://github.com/msitarzewski/agency-agents)** by [@msitarzewski](https://github.com/msitarzewski) — 207 agent templates (MIT). 165 templates are vendored into `packages/onboarding-ui/public/agent-templates/` with per-file attribution.
- **[Anthropic](https://anthropic.com)** — Claude Max powers the spawned agents.
- **[reactflow](https://reactflow.dev)** — drives the onboarding swarm chart and the Mission Control fleet graph.
- **[Fastify](https://fastify.dev)** — the mock-core + wavex-os-server HTTP layer.

Full attribution: [CREDITS.md](CREDITS.md).

---

## Status

**v0.2.0 — Phase H** (Minimal inception kernel + four-layer self-healing). Production patterns from a 7-day deployment crystallized into open-source skills, services, and operational templates. Phase D (Paperclip handoff bridge) just shipped in this commit. Phase E completes OAuth handoff (Linux + Windows). Phase F adds Stripe + the hosted Optimizer.

See [docs/ROADMAP.md](docs/ROADMAP.md) for the full plan and what's done.

---

## Contributing

Contributions welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for local dev setup, branch conventions, and PR requirements. Browse [good first issues](https://github.com/aimerdoux/wavex-os/issues?q=is%3Aopen+label%3A%22good+first+issue%22) to find something to work on.

---

## License

MIT. See [LICENSE](LICENSE).
