-- WaveX OS — Unified user event stream (WAVAAAAA-25)
--
-- CDO/TELEMETRY deliverable: a single time-ordered event stream keyed by
-- auth.users.id (uuid) that fuses signals from the three real customer-
-- facing surfaces:
--
--   • Telegram concierge bot (@wavexcardbot)     → wavex_os.telegram_events
--   • Stripe billing                              → wavex_os.stripe_webhook_events
--                                                   joined via subscriptions
--   • Supabase product surfaces                   → auth_events, wizard_events,
--                                                   product_activation_events
--
-- The stream is the substrate for retention, activation, GMV-attribution
-- and on_fire/anomaly detection. One row per emitted event; immutable.
--
-- Why a view (not a materialized table):
--   • Sources are append-only — no double-count risk.
--   • Volume at pre-PMF stage is small enough to query live.
--   • A materialized view can be layered on top later without breaking
--     the contract on this view's column set.
--
-- Contract (do not break without bumping a new view):
--   user_id        uuid          — auth.users.id when resolvable, else NULL
--   source         text          — 'telegram' | 'stripe' | 'supabase'
--   surface        text          — finer-grained origin (e.g. 'telegram.bot',
--                                  'stripe.subscription', 'supabase.wizard')
--   event_type     text          — verb-style identifier scoped to surface
--   occurred_at    timestamptz   — when the event happened (source clock)
--   external_id    text          — best-effort foreign key into source
--                                  (telegram message id, stripe evt_*, etc.)
--   external_user  text          — source-native user handle (telegram
--                                  user id, stripe customer id, email)
--   payload        jsonb         — raw event-specific context

-- ─── telegram_events ────────────────────────────────────────────────────
-- New table. Populated by the Telegram bot worker on every inbound update
-- and outbound concierge reply. user_id is best-effort resolved at insert
-- time from auth.users by telegram_user_id; left NULL when the chatter
-- hasn't linked an account yet (cold-acquisition funnel).

create table if not exists wavex_os.telegram_events (
  id                uuid        primary key default gen_random_uuid(),
  user_id           uuid        references auth.users(id) on delete set null,
  telegram_user_id  text        not null,
  chat_id           text,
  event_type        text        not null check (event_type in (
                      'message_in',          -- inbound user message
                      'message_out',         -- outbound bot reply
                      'command',             -- /start, /help, ...
                      'callback_query',      -- inline keyboard button
                      'booking_intent',      -- bot parsed a booking request
                      'booking_confirmed',   -- booking flowed through to partner
                      'booking_cancelled',
                      'concierge_handoff',   -- bot escalated to human ops
                      'link_account',        -- telegram_user_id ↔ auth.users
                      'unlink_account'
                    )),
  external_id       text,                    -- telegram message id / update id
  occurred_at       timestamptz not null default now(),
  payload           jsonb       not null default '{}'::jsonb,
  created_at        timestamptz not null default now()
);

create index if not exists telegram_events_user_idx
  on wavex_os.telegram_events(user_id, occurred_at desc)
  where user_id is not null;

create index if not exists telegram_events_tg_user_idx
  on wavex_os.telegram_events(telegram_user_id, occurred_at desc);

create index if not exists telegram_events_type_idx
  on wavex_os.telegram_events(event_type, occurred_at desc);

create unique index if not exists telegram_events_external_id_uniq
  on wavex_os.telegram_events(external_id)
  where external_id is not null;

comment on table wavex_os.telegram_events is
  'Append-only log of every Telegram concierge interaction. user_id is '
  'resolved best-effort from telegram_user_id; rows for un-linked chatters '
  'keep user_id NULL until link_account fires. Drives the demand-side '
  'half of the booking_gmv attribution chain.';

-- ─── user_event_stream view ─────────────────────────────────────────────
-- Single time-ordered view fusing Telegram + Stripe + Supabase signals
-- under a stable contract. Consumers (retention dashboards, on_fire
-- detectors, GMV attribution) should select against this view, not the
-- underlying tables, so the substrate can evolve underneath.

create or replace view wavex_os.user_event_stream as
  -- Telegram concierge surface
  select
    t.user_id                                              as user_id,
    'telegram'::text                                       as source,
    'telegram.bot'::text                                   as surface,
    t.event_type                                           as event_type,
    t.occurred_at                                          as occurred_at,
    t.external_id                                          as external_id,
    t.telegram_user_id                                     as external_user,
    t.payload || jsonb_build_object('chat_id', t.chat_id)  as payload
  from wavex_os.telegram_events t

  union all

  -- Stripe billing surface — webhook events joined to subscriptions
  -- to recover the auth.users.id. Events that don't carry a Stripe
  -- customer/subscription (rare housekeeping events) are surfaced
  -- with user_id NULL so they still appear in the stream.
  select
    s.user_id                                              as user_id,
    'stripe'::text                                         as source,
    'stripe.webhook'::text                                 as surface,
    w.type                                                 as event_type,
    w.processed_at                                         as occurred_at,
    w.id                                                   as external_id,
    coalesce(
      s.stripe_customer_id,
      w.payload #>> '{data,object,customer}'
    )                                                      as external_user,
    jsonb_build_object(
      'api_version', w.api_version,
      'stripe_subscription_id',
        coalesce(
          s.stripe_subscription_id,
          w.payload #>> '{data,object,subscription}',
          w.payload #>> '{data,object,id}'
        ),
      'tier', s.tier,
      'status', s.status,
      'processing_error', w.processing_error
    )                                                      as payload
  from wavex_os.stripe_webhook_events w
  left join wavex_os.subscriptions s
    on  s.stripe_customer_id     = (w.payload #>> '{data,object,customer}')
     or s.stripe_subscription_id = coalesce(
          w.payload #>> '{data,object,subscription}',
          w.payload #>> '{data,object,id}'
        )

  union all

  -- Supabase product surface — auth signups (with UTM attribution).
  -- auth_events stores user_id as text; cast to uuid when it parses.
  select
    case
      when a.user_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        then a.user_id::uuid
      else null
    end                                                    as user_id,
    'supabase'::text                                       as source,
    'supabase.auth'::text                                  as surface,
    a.event_type                                           as event_type,
    a.created_at                                           as occurred_at,
    a.id::text                                             as external_id,
    a.email                                                as external_user,
    jsonb_build_object(
      'utm_campaign', a.utm_campaign,
      'utm_source',   a.utm_source,
      'ref',          a.ref,
      'resend_fired', a.resend_fired
    )                                                      as payload
  from wavex_os.auth_events a

  union all

  -- Supabase product surface — wizard funnel telemetry.
  select
    case
      when w2.user_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        then w2.user_id::uuid
      else null
    end                                                    as user_id,
    'supabase'::text                                       as source,
    'supabase.wizard'::text                                as surface,
    w2.event_type                                          as event_type,
    w2.created_at                                          as occurred_at,
    w2.id::text                                            as external_id,
    w2.user_id                                             as external_user,
    jsonb_build_object(
      'step',      w2.step,
      'last_step', w2.last_step,
      'result_id', w2.result_id,
      'status',    w2.status
    )                                                      as payload
  from wavex_os.wizard_events w2

  union all

  -- Supabase product surface — activation funnel events.
  select
    case
      when p.user_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        then p.user_id::uuid
      else null
    end                                                    as user_id,
    'supabase'::text                                       as source,
    'supabase.activation'::text                            as surface,
    p.event_type                                           as event_type,
    p.occurred_at                                          as occurred_at,
    p.id::text                                             as external_id,
    p.user_id                                              as external_user,
    p.payload || jsonb_build_object('company_id', p.company_id)
                                                           as payload
  from wavex_os.product_activation_events p;

comment on view wavex_os.user_event_stream is
  'Unified user event stream (WAVAAAAA-25). Time-ordered fusion of '
  'Telegram concierge, Stripe billing, and Supabase product events keyed '
  'by auth.users.id when resolvable. Stable column contract: '
  '(user_id, source, surface, event_type, occurred_at, external_id, '
  'external_user, payload). Substrate for retention, activation, GMV '
  'attribution and on_fire/anomaly detection.';

-- ─── helper: window slice keyed by user ────────────────────────────────
-- Convenience function used by retention/on_fire detectors to pull a
-- single user's last-N-days of events without pushing complex predicates
-- into every caller. Returns rows in chronological order.

create or replace function wavex_os.user_event_stream_window(
  p_user_id     uuid,
  p_since       timestamptz default (now() - interval '30 days'),
  p_until       timestamptz default now(),
  p_sources     text[]      default null,
  p_event_types text[]      default null
)
returns table (
  source        text,
  surface       text,
  event_type    text,
  occurred_at   timestamptz,
  external_id   text,
  external_user text,
  payload       jsonb
)
language sql
stable
set search_path = ''
as $$
  select
    s.source, s.surface, s.event_type, s.occurred_at,
    s.external_id, s.external_user, s.payload
  from wavex_os.user_event_stream s
  where s.user_id = p_user_id
    and s.occurred_at >= p_since
    and s.occurred_at <  p_until
    and (p_sources     is null or s.source     = any(p_sources))
    and (p_event_types is null or s.event_type = any(p_event_types))
  order by s.occurred_at asc;
$$;

comment on function wavex_os.user_event_stream_window(uuid, timestamptz, timestamptz, text[], text[]) is
  'Slice of wavex_os.user_event_stream scoped to a single user and time '
  'window. Used by retention loops and on_fire detectors so call sites do '
  'not have to re-implement the same filter shape.';
