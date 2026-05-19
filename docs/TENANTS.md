# Tenants — how WaveX OS keeps the runtime company-neutral

WaveX OS ships open-source. The dogfood operator (the WaveX team) runs
its own bookings + concierge tenant on top of the same runtime that
every customer fork uses. This doc explains how the two layers compose
so a fork from `aimerdoux/wavex-os` can model **any** business — SaaS,
agency, e-commerce, internal ops — without inheriting bookings-domain
assumptions.

## The three layers

```
┌────────────────────────────────────────────────────────────────┐
│ 1. Runtime (this repo)                                         │
│    packages/{wavex-os-server, mock-core, agent-templates}      │
│    Domain-neutral. Knows about pillars, manifests, KPIs,       │
│    Expert Agents — never about bookings, GMV, or concierges.   │
└────────────────────────────────────────────────────────────────┘
                          │
                          │  reads at handoff time
                          ▼
┌────────────────────────────────────────────────────────────────┐
│ 2. Tenant manifest (per company)                               │
│    ~/.wavex-os/instances/<id>/companies/<co>/onboarding/       │
│    company.manifest.{yaml,json} — the customer's answers:      │
│      • goal: { kpiId, current, target, days }                  │
│      • pillar responses (industry, ICP, GTM, comm, …)          │
│      • connector_manifest, swarm_manifest, workflow_manifest   │
│    This is the *only* place tenant-specific data lives.        │
└────────────────────────────────────────────────────────────────┘
                          │
                          │  applyManifestOverlay() composes them
                          ▼
┌────────────────────────────────────────────────────────────────┐
│ 3. Rendered agent bundle (per role)                            │
│    AGENTS.md, CONTEXT.md, WORKFLOW.md per spawned agent.       │
│    Header sentence parameterized from manifest.goal.           │
│    Body is the role template with dogfood patterns stripped.   │
└────────────────────────────────────────────────────────────────┘
```

The composition lives in
[`packages/wavex-os-server/src/bridge/paperclip-handoff.ts`](../packages/wavex-os-server/src/bridge/paperclip-handoff.ts)
in two functions: `buildCeoBundle` (CEO is special-cased — fully
synthesized) and `applyManifestOverlay` (all other 13 roles — read the
template, strip dogfood patterns, prepend manifest-driven goal header).

## What "domain-neutral" actually means for templates

A template under `packages/agent-templates/<role>/SKILL.md` is allowed to:

✅ Talk about the **role's craft** in general terms
(e.g., CRO discusses "pipeline coverage", "deal velocity", "AOV")

✅ Reference the **WaveX OS runtime contract**
(e.g., `kpi_snapshots`, `wake_reason`, `tier`, `heartbeat`)

✅ Use **placeholder KPIs** that the overlay binds to manifest.goal at
handoff (e.g., `primary_revenue_metric`, `primary_conversion_rate`).
These names are intentionally generic — they will never appear in the
rendered bundle the spawned agent reads.

❌ NOT allowed: hardcoded tenant KPI names like `booking_gmv`,
`booking_conversion_rate`, `concierge_to_registration_rate` (the strip
patterns in `applyManifestOverlay` are a transition safety net while
templates are still being genericized — they shouldn't be load-bearing
long-term).

❌ NOT allowed: hardcoded data-plane references
(`public.bookings`, `public.concierge_*`, `wavex-experience-architect`,
fixed dollar examples like `$25,000`).

❌ NOT allowed: tenant-specific stories or incident tags
("lesson from WAV-3293", "Effective: 2026-05-01. Owner: WaveX CEO.").

## Where WaveX-Experiences-specific content lives

Tenant-specific knowledge for the operator's own dogfood tenant
belongs in **the operator's `~/.wavex-os/instances/<id>/...` filesystem
state**, not in this repo. The operator's CEO bundle picks up
`Bookings GMV` and `public.bookings` from `manifest.goal.kpiId =
"booking_gmv"` + the rendered CONTEXT.md (which is built from
`pillar_responses.json`, not from the template).

A customer fork of `aimerdoux/wavex-os` writing their own
`manifest.goal.kpiId = "weekly_active_users"` gets a bundle that says
"defend `weekly_active_users` from N to M" — same template, different
overlay output.

## What still needs to be cleaned up (Phase 10 work)

The `applyManifestOverlay` strip-pattern list in
`paperclip-handoff.ts:545-552` still contains:

```
/Bookings GMV/gi, /booking_gmv/gi,
"$25,000", "$25000",
"public.bookings", "public.genesis_leads", "public.concierge_*",
"public.concierge_messages", "public.concierge_sessions",
"public.marketing_events",
"$HOME/ObsidianVault", "wavex-experience-architect",
"WaveX Supabase business data",
"WaveX CEO v2", "Effective: 2026-05-01. Owner: WaveX CEO.",
```

These exist because 9 mirror SKILL files under
`packages/onboarding-ui/public/agent-templates/` still contain dogfood
prose (longest: `ceo/SKILL_KPI_OWNERSHIP.md` with 12 dogfood lines
across 213 total). The follow-up work is to:

1. Rewrite those 9 files to use the placeholder pattern (this doc's
   "what's allowed" rules above).
2. Drop the strip patterns from `applyManifestOverlay`, leaving only
   the goal-header prepend behavior.
3. Update `paperclip-handoff.ts` comments to reflect that the overlay
   is now an additive composer, not a defensive stripper.

Tracking issue: this `docs/TENANTS.md` doc is itself the design.
The cleanup PRs will reference it.

## How a fork models their own business

1. Clone `aimerdoux/wavex-os`.
2. Run `pnpm dev` → wizard at http://127.0.0.1:5173.
3. Walk the 5 pillars. Pillar 1 captures your business in
   `pillar_responses.json`. Pillar 5 captures your goal — the wizard
   prompts you to write down the one KPI your fleet exists to move.
4. The pillar handlers wire that into `manifest.goal.kpiId`. The CEO
   bundle generated at activate-time uses your `kpiId`, never ours.

No part of the runtime needs to know your tenant's domain. If you find
a place where it does, that's a bug — open an issue tagged
`phase-10-decouple`.
