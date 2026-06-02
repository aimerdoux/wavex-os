-- WaveX OS — Inbound-quality scoreboard + marketing_campaigns registry
-- (WAVAAAAA-141)
--
-- CDO/TELEMETRY deliverable. Owns:
--   1. wavex_os.marketing_campaigns           — campaign registry (channel + surface enums)
--   2. wavex_os.compute_inbound_quality()     — weekly compute RPC, returns rows
--   3. public.wavex_os_compute_inbound_quality()  SECURITY DEFINER wrapper
--
-- Schema-reality reconciliation (vs WAVAAAAA-141 v0 description):
--   The original ticket assumed `public.professionals.first_touch_source`.
--   What actually shipped via WAVAAAAA-206 is the sidecar
--     wavex_os.professional_first_touch (telegram_user_id, user_id, first_touch_source, first_touch_at)
--   with sentinel `unknown_legacy` (not `unknown_unknown`). This migration
--   uses the as-shipped names. The taxonomy v1.1 sentinel-name mismatch is
--   flagged separately on the issue thread; until CMO/CONTENT publishes
--   v1.2, the RPC treats `unknown_legacy` AND `unknown_unknown` as the
--   `legacy` confidence bucket so either spelling is safe.
--
-- Storage placement: wavex_os schema (not public). This is wavex-os fleet
-- governance data, not tenant-app data. Same Supabase project; isolated
-- namespace consistent with telegram_events / professional_first_touch.

begin;

-- ─── marketing_campaigns registry ──────────────────────────────────

create table if not exists wavex_os.marketing_campaigns (
  campaign_slug    text         primary key,
  owner_agent_id   uuid         null,
  channel          text         not null,
  surface          text         not null,
  launched_at      timestamptz  not null,
  ended_at         timestamptz  null,
  notes            text         null,
  created_at       timestamptz  not null default now(),
  updated_at       timestamptz  not null default now(),
  constraint marketing_campaigns_channel_chk
    check (channel in ('seo','social','email','referral','partner','paid','community','direct','unknown')),
  -- surface enum mirrors CMO/CONTENT taxonomy v1.1 §4 (closed enum).
  -- If §4 expands, this constraint must be updated in a follow-up migration.
  constraint marketing_campaigns_surface_chk
    check (surface in (
      'tg_bot','tg_channel','tg_group',
      'ig_reel','ig_post','ig_story',
      'tiktok','youtube','twitter',
      'email','partner_page','landing_page',
      'blog','referral_link','direct','unknown'
    )),
  constraint marketing_campaigns_slug_format
    check (campaign_slug ~ '^[A-Za-z0-9_-]{1,64}$')
);

create index if not exists marketing_campaigns_channel_idx
  on wavex_os.marketing_campaigns (channel);
create index if not exists marketing_campaigns_window_idx
  on wavex_os.marketing_campaigns (launched_at desc, ended_at desc nulls first);

comment on table wavex_os.marketing_campaigns is
  'Campaign registry. CMO/CONTENT, CMO/DEMAND, CMO/BRAND, CMO/ADVOCACY '
  'register here before publishing content. The (launched_at, ended_at) '
  'window is used by the inbound-quality scoring RPC to infer first-touch '
  'sources for legacy professionals whose first_touch_source is '
  'unknown_legacy.';

comment on column wavex_os.marketing_campaigns.campaign_slug is
  'Stable token referenced by /start deep-link params and by '
  'kpi_snapshots.kpi_name suffixes (e.g. inbound_quality_social_ig_f1miami_reel1).';

-- ─── public wrapper for inserts (board-only) ───────────────────────

create or replace function public.wavex_os_register_campaign(
  p_campaign_slug  text,
  p_owner_agent_id uuid,
  p_channel        text,
  p_surface        text,
  p_launched_at    timestamptz,
  p_ended_at       timestamptz,
  p_notes          text
)
returns wavex_os.marketing_campaigns
language sql
volatile
security definer
set search_path = ''
as $$
  insert into wavex_os.marketing_campaigns (
    campaign_slug, owner_agent_id, channel, surface, launched_at, ended_at, notes
  )
  values (p_campaign_slug, p_owner_agent_id, p_channel, p_surface, p_launched_at, p_ended_at, p_notes)
  on conflict (campaign_slug) do update
    set owner_agent_id = excluded.owner_agent_id,
        channel        = excluded.channel,
        surface        = excluded.surface,
        launched_at    = excluded.launched_at,
        ended_at       = excluded.ended_at,
        notes          = excluded.notes,
        updated_at     = now()
  returning *;
$$;

revoke all on function public.wavex_os_register_campaign(text, uuid, text, text, timestamptz, timestamptz, text) from public;
grant execute on function public.wavex_os_register_campaign(text, uuid, text, text, timestamptz, timestamptz, text) to service_role;

-- ─── compute_inbound_quality RPC ───────────────────────────────────
-- Rolling 90d cohort over wavex_os.professional_first_touch joined to
-- public.bookings via user_id. Status filter matches the kpi_history
-- snapshotter (booking_status in 'confirmed','completed').
--
-- Output columns map 1:1 to the kpi_snapshots writer in
-- packages/wavex-os-server/src/mission-control/inbound-quality-sampler.ts.
-- The writer encodes (kpi_name, value, metadata) per WAVAAAAA-141 §3.

create or replace function wavex_os.compute_inbound_quality(
  p_window_end timestamptz default date_trunc('week', now() at time zone 'UTC')
)
returns table (
  source           text,
  inbound_count    integer,
  cohort_size      integer,
  fbc14            numeric,
  rr60             numeric,
  inbound_quality  numeric,
  unknown_share    numeric,
  channel          text,
  confidence       text,
  bucket           text,
  window_start     timestamptz,
  window_end       timestamptz
)
language sql
stable
set search_path = ''
as $$
  with bounds as (
    select
      (p_window_end - interval '90 days')::timestamptz as w_start,
      p_window_end::timestamptz                         as w_end,
      (p_window_end - interval '7 days')::timestamptz   as recent_start
  ),
  -- One row per professional we've ever first-touched within the window.
  cohort as (
    select
      f.telegram_user_id,
      f.user_id,
      f.first_touch_source as source,
      f.first_touch_at,
      f.first_touch_at >= b.recent_start as is_recent
    from wavex_os.professional_first_touch f
    cross join bounds b
    where f.first_touch_at >= b.w_start
      and f.first_touch_at <  b.w_end
  ),
  -- Bookings joined by user_id (resolved once the account links).
  booked as (
    select
      c.telegram_user_id,
      c.source,
      c.first_touch_at,
      c.is_recent,
      count(*) filter (
        where bk.booking_status in ('confirmed','completed')
          and bk.created_at <= c.first_touch_at + interval '14 days'
      ) as bookings_14d,
      count(*) filter (
        where bk.booking_status in ('confirmed','completed')
          and bk.created_at <= c.first_touch_at + interval '60 days'
      ) as bookings_60d
    from cohort c
    left join public.bookings bk
      on c.user_id is not null
     and bk.user_id = c.user_id
    group by c.telegram_user_id, c.source, c.first_touch_at, c.is_recent
  ),
  agg as (
    select
      source,
      count(*)::int                                                              as cohort_size,
      sum(case when is_recent then 1 else 0 end)::int                             as inbound_count,
      (sum(case when bookings_14d >= 1 then 1 else 0 end)::numeric / count(*))    as fbc14,
      (sum(case when bookings_60d >= 2 then 1 else 0 end)::numeric / count(*))    as rr60
    from booked
    group by source
  ),
  channel_totals as (
    select
      split_part(source, '_', 1) as channel,
      sum(cohort_size)::numeric  as total,
      sum(case when source in ('unknown_legacy','unknown_unknown') then cohort_size else 0 end)::numeric as unk
    from agg
    group by 1
  )
  select
    a.source,
    a.inbound_count,
    a.cohort_size,
    a.fbc14,
    a.rr60,
    (a.fbc14 * a.rr60)                                                            as inbound_quality,
    case
      when ct.total > 0 then round(ct.unk / ct.total, 6)
      else 0::numeric
    end                                                                            as unknown_share,
    split_part(a.source, '_', 1)                                                   as channel,
    case
      when a.source in ('unknown_legacy','unknown_unknown') then 'legacy'
      when exists (
        select 1
        from wavex_os.marketing_campaigns mc
        where mc.campaign_slug = a.source
          and mc.launched_at <= (select w_end   from bounds)
          and (mc.ended_at is null or mc.ended_at >= (select w_start from bounds))
      ) then 'inferred'
      else 'captured'
    end                                                                            as confidence,
    case when a.cohort_size >= 5 then 'ranked' else 'insufficient_data' end        as bucket,
    (select w_start from bounds)                                                   as window_start,
    (select w_end   from bounds)                                                   as window_end
  from agg a
  left join channel_totals ct
    on split_part(a.source, '_', 1) = ct.channel
  order by inbound_quality desc nulls last;
$$;

create or replace function public.wavex_os_compute_inbound_quality(
  p_window_end timestamptz default date_trunc('week', now() at time zone 'UTC')
)
returns table (
  source           text,
  inbound_count    integer,
  cohort_size      integer,
  fbc14            numeric,
  rr60             numeric,
  inbound_quality  numeric,
  unknown_share    numeric,
  channel          text,
  confidence       text,
  bucket           text,
  window_start     timestamptz,
  window_end       timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select * from wavex_os.compute_inbound_quality(p_window_end);
$$;

revoke all on function public.wavex_os_compute_inbound_quality(timestamptz) from public;
grant execute on function public.wavex_os_compute_inbound_quality(timestamptz) to service_role;

comment on function wavex_os.compute_inbound_quality(timestamptz) is
  'Returns per-source inbound-quality rows for the 90d window ending at '
  'p_window_end (default = start of current ISO week, UTC). Confidence is '
  'derived from source identity: legacy sentinels → legacy; sources '
  'matching an active marketing_campaigns row → inferred; otherwise → '
  'captured. The Node writer (inbound-quality-sampler.ts) deletes any '
  'prior kpi_snapshots row matching (kpi_name, metadata->>window_end) '
  'before inserting, so re-runs are idempotent.';

commit;
