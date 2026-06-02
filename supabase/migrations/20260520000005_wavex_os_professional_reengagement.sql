-- WaveX OS — Professional re-engagement nudges (WAVAAAAA-63)
--
-- Goal: stop grr/nrr leakage by triggering a Telegram concierge re-engagement
-- message to professionals whose last booking_confirmed was >7 days ago.
--
-- A "professional" here is operationally defined as a user with >=1
-- booking_confirmed event in wavex_os.telegram_events. We don't carry a
-- separate professionals table yet — the booking history is the segment.
--
-- This migration adds:
--   • wavex_os.professional_reengagement_nudges    — append-only nudge log
--   • wavex_os_list_professionals_with_stale_booking(...)  RPC
--   • wavex_os_record_professional_reengagement_nudge(...) RPC
--   • wavex_os_professional_reengagement_metrics(...)      RPC
--
-- The list RPC honours a cooldown window so a professional isn't nudged
-- twice inside the cadence. The metrics RPC computes re-activation rate
-- (booking_confirmed within p_window_hours after nudge) — the success
-- metric named in the issue (>=20%).

-- ─── nudge log ──────────────────────────────────────────────────────────

create table if not exists wavex_os.professional_reengagement_nudges (
  id                uuid        primary key default gen_random_uuid(),
  user_id           uuid        references auth.users(id) on delete set null,
  telegram_user_id  text        not null,
  chat_id           text        not null,
  last_booking_at   timestamptz not null,
  sent_at           timestamptz not null default now(),
  message_id        text,
  message_text      text        not null,
  dry_run           boolean     not null default true,
  reactivated_at    timestamptz,
  reactivation_event_id text,
  created_at        timestamptz not null default now()
);

create index if not exists professional_reengagement_nudges_user_idx
  on wavex_os.professional_reengagement_nudges(user_id, sent_at desc)
  where user_id is not null;

create index if not exists professional_reengagement_nudges_sent_idx
  on wavex_os.professional_reengagement_nudges(sent_at desc);

comment on table wavex_os.professional_reengagement_nudges is
  'Append-only log of Telegram re-engagement nudges fired at professionals '
  'with stale booking activity. Joined to wavex_os.telegram_events to '
  'compute the re-activation success metric (booking_confirmed within 48h '
  'after sent_at).';

-- ─── list candidates ────────────────────────────────────────────────────
-- Returns one row per professional whose latest booking_confirmed is older
-- than p_gap_days and who has not been nudged within p_cooldown_hours.
-- chat_id is taken from the most recent telegram_event for that user, so
-- the bot has a destination even if the original booking row carried only
-- telegram_user_id.

create or replace function wavex_os.list_professionals_with_stale_booking(
  p_gap_days       integer default 7,
  p_cooldown_hours integer default 168  -- 7d cooldown between nudges per pro
)
returns table (
  user_id          uuid,
  telegram_user_id text,
  chat_id          text,
  last_booking_at  timestamptz,
  last_nudged_at   timestamptz
)
language sql
stable
set search_path = ''
as $$
  with last_booking as (
    select
      t.user_id,
      max(t.occurred_at) as last_booking_at
    from wavex_os.telegram_events t
    where t.event_type = 'booking_confirmed'
      and t.user_id is not null
    group by t.user_id
  ),
  destination as (
    -- pick the most recent telegram_user_id + chat_id per user_id
    select distinct on (t.user_id)
      t.user_id,
      t.telegram_user_id,
      t.chat_id
    from wavex_os.telegram_events t
    where t.user_id is not null
      and t.chat_id is not null
    order by t.user_id, t.occurred_at desc
  ),
  last_nudge as (
    select
      n.user_id,
      max(n.sent_at) as last_nudged_at
    from wavex_os.professional_reengagement_nudges n
    where n.user_id is not null
    group by n.user_id
  )
  select
    lb.user_id,
    d.telegram_user_id,
    d.chat_id,
    lb.last_booking_at,
    ln.last_nudged_at
  from last_booking lb
  join destination d using (user_id)
  left join last_nudge ln using (user_id)
  where lb.last_booking_at < (now() - make_interval(days => p_gap_days))
    and (ln.last_nudged_at is null
         or ln.last_nudged_at < (now() - make_interval(hours => p_cooldown_hours)))
  order by lb.last_booking_at asc;  -- nudge the staleest first
$$;

comment on function wavex_os.list_professionals_with_stale_booking(integer, integer) is
  'Candidate list for the WAVAAAAA-63 Telegram re-engagement nudge. '
  'Returns professionals whose latest booking_confirmed is older than '
  'p_gap_days and who have not been nudged in p_cooldown_hours.';

-- PostgREST cannot resolve schema-qualified functions, so expose a public
-- wrapper. SECURITY DEFINER lets the service role caller execute through
-- the wavex_os schema without explicit grants on every underlying table.

create or replace function public.wavex_os_list_professionals_with_stale_booking(
  p_gap_days       integer default 7,
  p_cooldown_hours integer default 168
)
returns table (
  user_id          uuid,
  telegram_user_id text,
  chat_id          text,
  last_booking_at  timestamptz,
  last_nudged_at   timestamptz
)
language sql
security definer
set search_path = ''
as $$
  select * from wavex_os.list_professionals_with_stale_booking(p_gap_days, p_cooldown_hours);
$$;

revoke all on function public.wavex_os_list_professionals_with_stale_booking(integer, integer) from public;
grant execute on function public.wavex_os_list_professionals_with_stale_booking(integer, integer) to service_role;

-- ─── record a nudge ─────────────────────────────────────────────────────

create or replace function wavex_os.record_professional_reengagement_nudge(
  p_user_id          uuid,
  p_telegram_user_id text,
  p_chat_id          text,
  p_last_booking_at  timestamptz,
  p_message_text     text,
  p_message_id       text default null,
  p_dry_run          boolean default true
)
returns uuid
language sql
volatile
set search_path = ''
as $$
  insert into wavex_os.professional_reengagement_nudges (
    user_id, telegram_user_id, chat_id, last_booking_at,
    message_text, message_id, dry_run
  )
  values (
    p_user_id, p_telegram_user_id, p_chat_id, p_last_booking_at,
    p_message_text, p_message_id, p_dry_run
  )
  returning id;
$$;

create or replace function public.wavex_os_record_professional_reengagement_nudge(
  p_user_id          uuid,
  p_telegram_user_id text,
  p_chat_id          text,
  p_last_booking_at  timestamptz,
  p_message_text     text,
  p_message_id       text default null,
  p_dry_run          boolean default true
)
returns uuid
language sql
security definer
set search_path = ''
as $$
  select wavex_os.record_professional_reengagement_nudge(
    p_user_id, p_telegram_user_id, p_chat_id, p_last_booking_at,
    p_message_text, p_message_id, p_dry_run
  );
$$;

revoke all on function public.wavex_os_record_professional_reengagement_nudge(
  uuid, text, text, timestamptz, text, text, boolean
) from public;
grant execute on function public.wavex_os_record_professional_reengagement_nudge(
  uuid, text, text, timestamptz, text, text, boolean
) to service_role;

-- ─── metrics ────────────────────────────────────────────────────────────
-- Re-activation rate = nudged professionals who logged a booking_confirmed
-- within p_window_hours after sent_at, over total nudged professionals
-- inside the same time slice. Dry-run rows are excluded from the
-- denominator so the rate reflects real-send efficacy.

create or replace function wavex_os.professional_reengagement_metrics(
  p_window_hours integer default 48,
  p_since        timestamptz default (now() - interval '30 days')
)
returns table (
  nudges_sent          integer,
  nudges_dry_run       integer,
  reactivated          integer,
  reactivation_rate    numeric
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
  reactivated as (
    select distinct s.id as nudge_id
    from sent s
    join wavex_os.telegram_events t
      on t.user_id = s.user_id
     and t.event_type = 'booking_confirmed'
     and t.occurred_at >  s.sent_at
     and t.occurred_at <= (s.sent_at + make_interval(hours => p_window_hours))
    where s.dry_run = false
  )
  select
    (select count(*)::int from sent where dry_run = false)              as nudges_sent,
    (select count(*)::int from sent where dry_run = true)               as nudges_dry_run,
    (select count(*)::int from reactivated)                             as reactivated,
    case
      when (select count(*) from sent where dry_run = false) = 0 then 0::numeric
      else round(
        (select count(*)::numeric from reactivated)
        / (select count(*)::numeric from sent where dry_run = false), 4)
    end                                                                 as reactivation_rate;
$$;

create or replace function public.wavex_os_professional_reengagement_metrics(
  p_window_hours integer default 48,
  p_since        timestamptz default (now() - interval '30 days')
)
returns table (
  nudges_sent          integer,
  nudges_dry_run       integer,
  reactivated          integer,
  reactivation_rate    numeric
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
  'Aggregate WAVAAAAA-63 nudge efficacy: nudges_sent (real), nudges_dry_run, '
  'reactivated (booked within p_window_hours after a real send), and the '
  'reactivation_rate. Drives the >=20% success metric named in the issue.';
