-- WaveX OS — booking_intents table + Stripe checkout confirmation RPC (WAVAAAA-1195)
--
-- Problem: Telegram bot creates booking_intent telegram events but there is
-- no payment path to transition them. The 30-min auto-cancel fires on every
-- unconfirmed intent because there is no way to pause the clock while the
-- user is in the Stripe redirect.
--
-- This migration adds:
--   1. wavex_os.booking_intents          — staging table for the intent-to-pay
--   2. wavex_os_confirm_booking_intent() — atomic confirm: update intent +
--                                          insert public.bookings row (service_role RPC)
--   3. wavex_os_cancel_stale_booking_intents() — auto-cancel only 'pending'
--                                          (not 'pending_payment') intents older
--                                          than 30 min. Called by a pg_cron job
--                                          or the booking-cleanup Supabase Function.
--   4. wavex_os_set_booking_intent_pending_payment() — update status to
--                                          'pending_payment' when user is sent to
--                                          Stripe; takes the checkout session id.

begin;

-- ─── booking_intents table ────────────────────────────────────────────────────

create table if not exists wavex_os.booking_intents (
  id                          uuid primary key default gen_random_uuid(),
  user_id                     uuid null,           -- auth.users.id (if linked)
  telegram_user_id            text null,           -- Telegram bot user
  experience_id               text null,           -- experience / product slug
  experience_name             text null,
  experience_price_cents      bigint not null,     -- charge amount, in cents
  currency                    text   not null default 'usd',
  booking_time                timestamptz null,    -- requested time slot
  stripe_checkout_session_id  text null,           -- Stripe checkout.session id
  stripe_payment_intent_id    text null,           -- Stripe PaymentIntent id (set on confirm)
  status                      text not null default 'pending',
  cancelled_at                timestamptz null,
  confirmed_at                timestamptz null,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  constraint booking_intents_status_check
    check (status in ('pending', 'pending_payment', 'confirmed', 'cancelled'))
);

create index if not exists booking_intents_user_id_idx
  on wavex_os.booking_intents (user_id)
  where user_id is not null;

create index if not exists booking_intents_status_created_idx
  on wavex_os.booking_intents (status, created_at)
  where status in ('pending', 'pending_payment');

create unique index if not exists booking_intents_checkout_session_uniq
  on wavex_os.booking_intents (stripe_checkout_session_id)
  where stripe_checkout_session_id is not null;

comment on table wavex_os.booking_intents is
  'Staging table for experience booking intents. Created by the Telegram bot '
  'when a user requests a booking. Transitions: pending → pending_payment '
  '(on Stripe redirect) → confirmed (on checkout.session.completed webhook). '
  'Confirmed intents produce a public.bookings row via wavex_os_confirm_booking_intent(). '
  'Only pending intents (not pending_payment) are auto-cancelled by the 30-min cleanup.';

-- ─── set pending_payment (called by create-booking-checkout-session function) ─

create or replace function public.wavex_os_set_booking_intent_pending_payment(
  p_intent_id                  uuid,
  p_stripe_checkout_session_id text
)
returns jsonb
language plpgsql
security definer
set search_path = wavex_os, public
as $$
declare
  v_rows int;
begin
  update wavex_os.booking_intents
     set status                     = 'pending_payment',
         stripe_checkout_session_id = p_stripe_checkout_session_id,
         updated_at                 = now()
   where id     = p_intent_id
     and status = 'pending';

  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    -- Already in another terminal state or doesn't exist — surface to caller.
    return jsonb_build_object('ok', false, 'reason', 'not_pending_or_not_found');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.wavex_os_set_booking_intent_pending_payment(uuid, text) from public;
grant execute on function public.wavex_os_set_booking_intent_pending_payment(uuid, text) to service_role;

comment on function public.wavex_os_set_booking_intent_pending_payment is
  'Atomically transition a booking_intent from pending → pending_payment and record '
  'the Stripe checkout session id. Called by the create-booking-checkout-session edge '
  'function immediately before redirecting the user to Stripe. Intents in '
  'pending_payment are NOT auto-cancelled by the 30-min cleanup job.';

-- ─── confirm booking intent (called by booking webhook on payment success) ────

create or replace function public.wavex_os_confirm_booking_intent(
  p_intent_id                  uuid,
  p_stripe_checkout_session_id text,
  p_stripe_payment_intent_id   text default null
)
returns jsonb
language plpgsql
security definer
set search_path = wavex_os, public
as $$
declare
  v_intent  wavex_os.booking_intents%rowtype;
  v_booking_id uuid;
begin
  -- Idempotency: if already confirmed, return the existing booking_id from
  -- the public.bookings row tied to this checkout session.
  select * into v_intent
    from wavex_os.booking_intents
   where id = p_intent_id
   limit 1;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'intent_not_found');
  end if;

  if v_intent.status = 'confirmed' then
    -- Already confirmed; look up the booking row and return idempotently.
    select id into v_booking_id
      from public.bookings
     where booking_intent_id = p_intent_id
     limit 1;
    return jsonb_build_object('ok', true, 'idempotent', true, 'booking_id', v_booking_id);
  end if;

  if v_intent.status not in ('pending', 'pending_payment') then
    return jsonb_build_object('ok', false, 'reason', 'intent_not_payable', 'status', v_intent.status);
  end if;

  -- Confirm the intent.
  update wavex_os.booking_intents
     set status                    = 'confirmed',
         stripe_checkout_session_id = p_stripe_checkout_session_id,
         stripe_payment_intent_id  = p_stripe_payment_intent_id,
         confirmed_at              = now(),
         updated_at                = now()
   where id = p_intent_id;

  -- Insert the public.bookings row.
  insert into public.bookings (
    user_id,
    booking_intent_id,
    booking_status,
    amount,
    currency,
    booking_time,
    experience_id,
    experience_name,
    stripe_checkout_session_id,
    stripe_payment_intent_id,
    paid_at
  ) values (
    v_intent.user_id,
    p_intent_id,
    'confirmed',
    (v_intent.experience_price_cents / 100.0)::numeric,
    upper(v_intent.currency),
    v_intent.booking_time,
    v_intent.experience_id,
    v_intent.experience_name,
    p_stripe_checkout_session_id,
    p_stripe_payment_intent_id,
    now()
  )
  returning id into v_booking_id;

  return jsonb_build_object('ok', true, 'booking_id', v_booking_id);
end;
$$;

revoke all on function public.wavex_os_confirm_booking_intent(uuid, text, text) from public;
grant execute on function public.wavex_os_confirm_booking_intent(uuid, text, text) to service_role;

comment on function public.wavex_os_confirm_booking_intent is
  'Atomically confirm a booking_intent and create the public.bookings row. '
  'Called by the wavex-os-booking-webhook edge function on checkout.session.completed. '
  'Idempotent: replaying the same p_intent_id returns ok=true with idempotent=true. '
  'Only accepts intents in pending or pending_payment state.';

-- ─── cancel stale pending intents (30-min clock — NOT pending_payment) ───────

create or replace function public.wavex_os_cancel_stale_booking_intents(
  p_older_than_minutes int default 30
)
returns jsonb
language plpgsql
security definer
set search_path = wavex_os, public
as $$
declare
  v_cancelled_ids uuid[];
begin
  update wavex_os.booking_intents
     set status       = 'cancelled',
         cancelled_at = now(),
         updated_at   = now()
   where status    = 'pending'     -- never cancel pending_payment
     and created_at < now() - (p_older_than_minutes || ' minutes')::interval
  returning id
  into v_cancelled_ids;

  return jsonb_build_object('cancelled', coalesce(array_length(v_cancelled_ids, 1), 0));
end;
$$;

revoke all on function public.wavex_os_cancel_stale_booking_intents(int) from public;
grant execute on function public.wavex_os_cancel_stale_booking_intents(int) to service_role;

comment on function public.wavex_os_cancel_stale_booking_intents is
  'Cancel booking_intents that remain in ''pending'' status for longer than '
  'p_older_than_minutes (default 30). Intentionally does NOT cancel '
  'pending_payment intents — those are live Stripe redirect sessions and '
  'will be resolved by the checkout.session.completed or checkout.session.expired webhook.';

-- ─── extend public.bookings to accept booking_intent_id ──────────────────────

alter table public.bookings
  add column if not exists booking_intent_id uuid null
    references wavex_os.booking_intents(id) on delete set null;

alter table public.bookings
  add column if not exists experience_id text null;

alter table public.bookings
  add column if not exists experience_name text null;

alter table public.bookings
  add column if not exists stripe_checkout_session_id text null;

alter table public.bookings
  add column if not exists stripe_payment_intent_id text null;

create unique index if not exists bookings_booking_intent_id_uniq
  on public.bookings (booking_intent_id)
  where booking_intent_id is not null;

create unique index if not exists bookings_stripe_checkout_session_uniq
  on public.bookings (stripe_checkout_session_id)
  where stripe_checkout_session_id is not null;

commit;
