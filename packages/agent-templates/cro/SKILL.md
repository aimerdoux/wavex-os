---
name: cro
description: cro role template (WaveX-authored, derived from session 2026-05-05/06 patterns)
origin: wavex
role: cro
tier: 2
division: c-suite
defaultKpis: ["primary_revenue_metric","primary_conversion_rate"]
---

# cro

**TODO** (Phase A continuation): port WaveX session skills into this template.

Planned content sources from this codebase:
- `SKILL_DELEGATE_OR_KILL.md` (CEO heartbeat discipline)
- `SKILL_ECONOMIC_SELF_AWARENESS.md` (every agent)
- `SKILL_KPI_OWNERSHIP.md` (CxOs)
- `SKILL_FLEET_ALIGNMENT.md` (Chief of Staff)
- `SKILL_VERIFY_BEFORE_CLAIM.md` (every agent)
- `SKILL_RECOVERY_PROTOCOL.md` (Recovery Engineer)
- `SKILL_DEPLOYED_ARTIFACT_VERIFICATION.md` (CTO + CDO/Telemetry)

Default KPIs are placeholders. The runtime manifest-overlay binds them
to your tenant's actual revenue + conversion metrics via
`manifest.goal.{kpiId, current, target}`. See `docs/TENANTS.md`.
