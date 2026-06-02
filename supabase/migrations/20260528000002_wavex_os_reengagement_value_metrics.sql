-- WAVAAAAA-213: extend professional_reengagement_metrics with post-nudge booking value
--
-- Append-only: adds 4 new columns to the RPC return type.
-- Existing columns (nudges_sent, nudges_dry_run, reactivated, reactivation_rate)
-- are unchanged.
--
-- New columns:
--   mean_post_nudge_booking_value  avg(bookings.amount) for confirmed bookings
--                                  within p_window_hours of a real nudge send.
--                                  NULL when no real sends in window.
--   total_post_nudge_gmv           sum of same. NULL when no real sends.
--   pro_aov_baseline_90d           cohort-level average of per-pro avg booking
--                                  value in the 90d prior to their nudge send.
--                                  NULL when no real sends or no prior bookings.
--   aov_delta_pct                  (mean_post_nudge - baseline) / baseline.
--                                  NULL when baseline is NULL or zero.
--
-- CRO/EXPANSION will not flip WAVEX_REENGAGEMENT_DRY_RUN=false until this
-- lands and the dashboard shows non-null value fields from the dry-run cohort.

create or replace function wavex_os.professional_reengagement_metrics(
  p_window_hours integer     default 48,
  p_since        timestamptz default (now() - interval '30 days')
)
returns table (
  nudges_sent                   integer,
  nudges_dry_run                integer,
  reactivated                   integer,
  reactivation_rate             numeric,
  mean_post_nudge_booking_value numeric,
  total_post_nudge_gmv          numeric,
  pro_aov_baseline_90d          numeric,
  aov_delta_pct                 numeric
)
language sql
stable
set search_path = ''
as $$
  with sent as (
    select n.*
    from wavex_os.professional_reengagement_nudges n
    where n.sent_at >= p_since
  ),
  real_sends as (
    select * from sent where dry_run = false
  ),
  reactivated as (
    select distinct s.id as nudge_id
    from real_sends s
    join wavex_os.telegram_events t
      on  t.user_id    = s.user_id
      and t.event_type = 'booking_confirmed'
      and t.occurred_at >  s.sent_at
      and t.occurred_at <= (s.sent_at + make_interval(hours => p_window_hours))
  ),
  -- Confirmed bookings created within the reactivation window after each real send.
  -- Dry-run sends excluded — they have no expected downstream bookings.
  post_nudge_bookings as (
    select bk.amount
    from real_sends s
    join public.bookings bk
      on  bk.user_id        = s.user_id
      and bk.booking_status in ('confirmed', 'completed')
      and bk.created_at >   s.sent_at
      and bk.created_at <=  (s.sent_at + make_interval(hours => p_window_hours))
  ),
  -- Per-nudged-pro average booking value in the 90 days before their send.
  -- Used as the pre-nudge AOV baseline to detect regression.
  baseline_per_pro as (
    select
      s.user_id,
      avg(bk.amount) as pro_avg
    from real_sends s
    join public.bookings bk
      on  bk.user_id        = s.user_id
      and bk.booking_status in ('confirmed', 'completed')
      and bk.created_at >=  (s.sent_at - interval '90 days')
      and bk.created_at <   s.sent_at
    group by s.user_id
  )
  select
    (select count(*)::int from sent       where dry_run = false)  as nudges_sent,
    (select count(*)::int from sent       where dry_run = true)   as nudges_dry_run,
    (select count(*)::int from reactivated)                       as reactivated,
    -- reactivation_rate: 0 (not null) when no real sends, matching prior contract
    case
      when (select count(*) from sent where dry_run = false) = 0
        then 0::numeric
      else round(
             (select count(*)::numeric from reactivated)
             / (select count(*)::numeric from sent where dry_run = false),
             4)
    end                                                           as reactivation_rate,
    -- Value fields: NULL (not 0) when no real sends — distinguishes "no data"
    -- from "zero AOV". avg/sum of empty set return NULL naturally.
    (select avg(amount)    from post_nudge_bookings)              as mean_post_nudge_booking_value,
    (select sum(amount)    from post_nudge_bookings)              as total_post_nudge_gmv,
    (select avg(pro_avg)   from baseline_per_pro)                 as pro_aov_baseline_90d,
    case
      when (select avg(pro_avg) from baseline_per_pro) is null
        or (select avg(pro_avg) from baseline_per_pro) = 0
        then null
      else round(
             (
               coalesce((select avg(amount) from post_nudge_bookings), 0)
               - (select avg(pro_avg) from baseline_per_pro)
             ) / (select avg(pro_avg) from baseline_per_pro),
             4)
    end                                                           as aov_delta_pct;
$$;

-- Replace the public wrapper to reflect the extended return type.
create or replace function public.wavex_os_professional_reengagement_metrics(
  p_window_hours integer     default 48,
  p_since        timestamptz default (now() - interval '30 days')
)
returns table (
  nudges_sent                   integer,
  nudges_dry_run                integer,
  reactivated                   integer,
  reactivation_rate             numeric,
  mean_post_nudge_booking_value numeric,
  total_post_nudge_gmv          numeric,
  pro_aov_baseline_90d          numeric,
  aov_delta_pct                 numeric
)
language sql
security definer
set search_path = ''
as $$
  select * from wavex_os.professional_reengagement_metrics(p_window_hours, p_since);
$$;

revoke all on function public.wavex_os_professional_reengagement_metrics(integer, timestamptz) from public;
grant execute on function public.wavex_os_professional_reengagement_metrics(integer, timestamptz) to service_role;

comment on function wavex_os.professional_reengagement_metrics(integer, timestamptz) is
  'WAVAAAAA-63 nudge efficacy metrics. Original fields: nudges_sent (real), '
  'nudges_dry_run, reactivated (booking within p_window_hours of a real send), '
  'reactivation_rate. Extended by WAVAAAAA-213: mean_post_nudge_booking_value, '
  'total_post_nudge_gmv (value of those bookings), pro_aov_baseline_90d '
  '(cohort avg booking value 90d pre-nudge), aov_delta_pct '
  '((post - baseline) / baseline). Value fields are NULL, not 0, when no real '
  'sends exist — distinguishes no-data from zero-AOV.';
