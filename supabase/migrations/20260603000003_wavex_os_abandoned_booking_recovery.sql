-- WaveX OS — abandoned booking recovery nudges (WAVAAAA-1197)
--
-- Users whose booking_intents were auto-cancelled before the Stripe checkout
-- flow was added (bfeff1f5) never had a way to pay. This migration gives us
-- the infrastructure to identify those users and send a one-time recovery
-- nudge via the Telegram concierge bot.
--
-- This migration adds:
--   • wavex_os.abandoned_booking_recovery_nudges  — append-only nudge log
--   • wavex_os_list_abandoned_booking_candidates() — find cancelled intents
--       that have a resolvable Telegram chat_id and haven't been nudged yet
--   • wavex_os_record_abandoned_booking_nudge()   — record a nudge send
--
-- The job in packages/wavex-os-server/src/jobs/abandoned-booking-recovery.ts
-- calls these RPCs. It defaults to dry-run (WAVEX_ABANDONED_BOOKING_DRY_RUN=true)
-- so the recoverable count is logged on every startup without sending anything.
-- Set WAVEX_ABANDONED_BOOKING_DRY_RUN=false to actually send once CEO approves.

begin;

-- ─── nudge log ────────────────────────────────────────────────────────────────

create table if not exists wavex_os.abandoned_booking_recovery_nudges (
  id                uuid        primary key default gen_random_uuid(),
  intent_id         uuid        not null
                                  references wavex_os.booking_intents(id)
                                  on delete cascade,
  telegram_user_id  text        not null,
  chat_id           text        not null,
  message_text      text        not null,
  message_id        text,
  dry_run           boolean     not null default true,
  sent_at           timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  constraint abandoned_booking_recovery_nudges_intent_uniq unique (intent_id)
);

comment on table wavex_os.abandoned_booking_recovery_nudges is
  'Append-only log of one-time Telegram recovery nudges sent to users whose '
  'booking_intents were cancelled before the Stripe checkout flow existed. '
  'Unique on intent_id so a replay cannot double-send.';

-- ─── list candidates ──────────────────────────────────────────────────────────
-- Returns all cancelled booking_intents where:
--   1. A telegram chat_id can be resolved (by telegram_user_id or user_id)
--   2. The user does not already have a confirmed booking (they retried on own)
--   3. The intent has not already been nudged (idempotent via nudge log)
--
-- chat_id resolution order:
--   a. Most recent telegram_event matching booking_intent.telegram_user_id
--   b. Most recent telegram_event matching booking_intent.user_id (auth link)

create or replace function public.wavex_os_list_abandoned_booking_candidates()
returns table (
  intent_id               uuid,
  telegram_user_id        text,
  chat_id                 text,
  experience_name         text,
  experience_price_cents  bigint,
  currency                text,
  created_at              timestamptz,
  cancelled_at            timestamptz
)
language sql
stable
security definer
set search_path = wavex_os, public
as $$
  select
    bi.id,
    coalesce(bi.telegram_user_id, te_uid.telegram_user_id) as telegram_user_id,
    coalesce(te_tgid.chat_id, te_uid.chat_id)              as chat_id,
    bi.experience_name,
    bi.experience_price_cents,
    bi.currency,
    bi.created_at,
    bi.cancelled_at
  from wavex_os.booking_intents bi

  -- Primary: resolve chat_id by telegram_user_id
  left join lateral (
    select te.chat_id
    from wavex_os.telegram_events te
    where te.telegram_user_id = bi.telegram_user_id
      and te.chat_id is not null
    order by te.occurred_at desc
    limit 1
  ) te_tgid on bi.telegram_user_id is not null

  -- Fallback: resolve chat_id by auth user_id
  left join lateral (
    select te.telegram_user_id, te.chat_id
    from wavex_os.telegram_events te
    where te.user_id = bi.user_id
      and te.chat_id is not null
    order by te.occurred_at desc
    limit 1
  ) te_uid on bi.user_id is not null
          and te_tgid.chat_id is null

  where bi.status = 'cancelled'
    -- Only include rows where we have a destination
    and coalesce(te_tgid.chat_id, te_uid.chat_id) is not null
    -- Skip users who already confirmed a booking (converted without nudge)
    and not exists (
      select 1 from wavex_os.booking_intents bi2
      where bi2.status = 'confirmed'
        and (
          (bi.telegram_user_id is not null
             and bi2.telegram_user_id = bi.telegram_user_id)
          or
          (bi.user_id is not null
             and bi2.user_id = bi.user_id)
        )
    )
    -- Skip if already nudged (idempotent)
    and not exists (
      select 1 from wavex_os.abandoned_booking_recovery_nudges n
      where n.intent_id = bi.id
    )

  order by bi.created_at asc
$$;

revoke all on function public.wavex_os_list_abandoned_booking_candidates() from public;
grant execute on function public.wavex_os_list_abandoned_booking_candidates() to service_role;

comment on function public.wavex_os_list_abandoned_booking_candidates is
  'Return cancelled booking_intents that are recoverable via a Telegram nudge. '
  'Resolves chat_id from wavex_os.telegram_events (by telegram_user_id, then user_id). '
  'Excludes: already-confirmed users, already-nudged intents. '
  'Called by the abandoned-booking-recovery server job on startup.';

-- ─── record nudge ─────────────────────────────────────────────────────────────
-- Idempotent: ON CONFLICT DO NOTHING on the unique (intent_id) constraint.
-- A replay (e.g. server restart with DRY_RUN=true after a live run) never
-- double-counts or overwrites an already-sent row.

create or replace function public.wavex_os_record_abandoned_booking_nudge(
  p_intent_id         uuid,
  p_telegram_user_id  text,
  p_chat_id           text,
  p_message_text      text,
  p_message_id        text    default null,
  p_dry_run           boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = wavex_os, public
as $$
declare
  v_id uuid;
begin
  insert into wavex_os.abandoned_booking_recovery_nudges (
    intent_id, telegram_user_id, chat_id, message_text, message_id, dry_run
  ) values (
    p_intent_id, p_telegram_user_id, p_chat_id, p_message_text, p_message_id, p_dry_run
  )
  on conflict (intent_id) do nothing
  returning id into v_id;
  return jsonb_build_object('id', v_id);
end;
$$;

revoke all on function public.wavex_os_record_abandoned_booking_nudge(uuid, text, text, text, text, boolean) from public;
grant execute on function public.wavex_os_record_abandoned_booking_nudge(uuid, text, text, text, text, boolean) to service_role;

comment on function public.wavex_os_record_abandoned_booking_nudge is
  'Log a recovery nudge send (real or dry-run) into '
  'wavex_os.abandoned_booking_recovery_nudges. ON CONFLICT DO NOTHING on '
  'intent_id prevents double-logging on server restarts.';

commit;
