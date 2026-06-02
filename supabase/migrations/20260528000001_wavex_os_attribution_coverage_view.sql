-- WaveX OS CDO/ATTRIBUTE — attribution_coverage measurement view
-- Lineage: wavex_os.auth_events → wavex_os.v_attribution_coverage_7d
-- Owner: cdo_attribute
--
-- KPI contract: utm_attribution_coverage
--   = share of signup_confirmed auth events (trailing 7d) with non-null utm_source
--   target: >= 0.80 (80%)
--   window: 7 days rolling
--
-- Usage:
--   SELECT coverage_ratio FROM wavex_os.v_attribution_coverage_7d;
--   → value in [0.0, 1.0]; multiply by 100 for percentage
--
-- Source table: wavex_os.auth_events
--   Populated by POST /api/auth-events (packages/wavex-os-server/src/routes/auth-events.ts)
--   Fired by packages/onboarding-ui/src/pages/Signup.tsx on magic-link confirmation
--   Denominator: all signup_confirmed rows in trailing 7d window (organic + attributed)
--   Numerator:   subset where utm_source IS NOT NULL

create or replace view wavex_os.v_attribution_coverage_7d as
select
  count(*) filter (where utm_source is not null)::float
    / nullif(count(*), 0)                                   as coverage_ratio,
  count(*)                                                   as total_signups_7d,
  count(*) filter (where utm_source is not null)             as attributed_signups_7d,
  count(*) filter (where utm_source is null)                 as organic_signups_7d,
  now() - interval '7 days'                                  as window_start,
  now()                                                      as window_end
from wavex_os.auth_events
where event_type = 'signup_confirmed'
  and created_at > now() - interval '7 days';

comment on view wavex_os.v_attribution_coverage_7d is
  'CDO/ATTRIBUTE measurement view for utm_attribution_coverage KPI. '
  'coverage_ratio = attributed_signups_7d / total_signups_7d. '
  'Baseline: denominator is organic-only until first paid campaign runs. '
  'Feed into mc_kpi_snapshots for kpiId=utm_attribution_coverage.';
