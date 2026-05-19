---
name: concierge-ops
description: customer-facing operator template — adapts to any front-line ops role (concierge, intake, support triage). WaveX-authored, derived from session 2026-05-05/06 patterns.
origin: wavex
role: general
tier: 3
division: sales
defaultKpis: ["primary_engagement_rate"]
---

# concierge-ops

**TODO** (Phase A continuation): port WaveX session skills into this template.

Planned content sources from this codebase:
- `SKILL_DELEGATE_OR_KILL.md` (CEO heartbeat discipline)
- `SKILL_ECONOMIC_SELF_AWARENESS.md` (every agent)
- `SKILL_KPI_OWNERSHIP.md` (CxOs)
- `SKILL_FLEET_ALIGNMENT.md` (Chief of Staff)
- `SKILL_VERIFY_BEFORE_CLAIM.md` (every agent)
- `SKILL_RECOVERY_PROTOCOL.md` (Recovery Engineer)
- `SKILL_DEPLOYED_ARTIFACT_VERIFICATION.md` (CTO + CDO/Telemetry)

Default KPI is a placeholder. The runtime manifest-overlay binds it to
your tenant's actual front-line engagement metric via
`manifest.goal.{kpiId, current, target}`. See `docs/TENANTS.md`.
