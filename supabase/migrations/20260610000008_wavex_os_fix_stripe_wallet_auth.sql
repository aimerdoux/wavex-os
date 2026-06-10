-- WaveX OS — Stripe wallet-auth fixes (WAVAAAAAAAA-164)
--
-- Three problems addressed:
--
-- 1. cancelled_at invariant trigger
--    Any UPDATE that transitions booking_intents.status → 'cancelled' without
--    explicitly writing cancelled_at will have it back-filled to now() by a
--    BEFORE trigger. Covers manual DB patches, future RPCs, and any direct
--    PostgREST writes.
--
-- 2. wavex_os_set_booking_intent_pending_payment — allow re-entry
--    Previously: only accepted pending → pending_payment.
--    Now: also accepts pending_payment → pending_payment so that a user who
--    returns to checkout after the Stripe session expired gets a fresh session
--    URL without the booking_intent needing to be reset first.
--
-- 3. wavex_os_cancel_expired_pending_payment_intents
--    New RPC: cancel booking_intents stuck in pending_payment for longer than
--    p_older_than_hours (default 25 — Stripe sessions expire in 24 h, so
--    anything older is definitely abandoned). Sets cancelled_at = now().
--    Called by the booking-intent-cleanup scheduler alongside the existing
--    pending-intent cleanup. Handles the 6 intents stuck for Omar Hernandez
--    on the first run after this migration deploys.

begin;

-- ─── 1. cancelled_at back-fill trigger ───────────────────────────────────────

create or replace function wavex_os.booking_intents_set_cancelled_at()
returns trigger
language plpgsql
as $$
begin
  if NEW.status = 'cancelled'
     and (OLD.status is distinct from 'cancelled')
     and NEW.cancelled_at is null
  then
    NEW.cancelled_at = now();
  end if;
  return NEW;
end;
$$;

drop trigger if exists booking_intents_cancelled_at_tg on wavex_os.booking_intents;

create trigger booking_intents_cancelled_at_tg
before update on wavex_os.booking_intents
for each row execute function wavex_os.booking_intents_set_cancelled_at();

comment on function wavex_os.booking_intents_set_cancelled_at() is
  'Ensure cancelled_at is always written when status transitions to ''cancelled''. '
  'Defensive back-fill: any caller that sets status=cancelled without an explicit '
  'cancelled_at timestamp will have it injected here. (WAVAAAAAAAA-164)';

-- ─── 2. wavex_os_set_booking_intent_pending_payment — allow re-entry ─────────

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
  -- Accept both pending → pending_payment (first checkout) and
  -- pending_payment → pending_payment (retry after session expiry).
  update wavex_os.booking_intents
     set status                     = 'pending_payment',
         stripe_checkout_session_id = p_stripe_checkout_session_id,
         updated_at                 = now()
   where id     = p_intent_id
     and status in ('pending', 'pending_payment');

  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    return jsonb_build_object('ok', false, 'reason', 'not_payable_or_not_found');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.wavex_os_set_booking_intent_pending_payment(uuid, text) from public;
grant execute on function public.wavex_os_set_booking_intent_pending_payment(uuid, text) to service_role;

comment on function public.wavex_os_set_booking_intent_pending_payment is
  'Transition a booking_intent to pending_payment and record the Stripe checkout '
  'session id. Accepts pending (first checkout) and pending_payment (retry after '
  'session expiry) so callers need not reset the intent before retrying. '
  '(WAVAAAAAAAA-164)';

-- ─── 3. wavex_os_cancel_expired_pending_payment_intents ──────────────────────

create or replace function public.wavex_os_cancel_expired_pending_payment_intents(
  p_older_than_hours int default 25
)
returns jsonb
language plpgsql
security definer
set search_path = wavex_os, public
as $$
declare
  v_count int;
begin
  -- Stripe Checkout sessions expire after 24 h. Any booking_intent in
  -- pending_payment for longer than p_older_than_hours is definitively
  -- abandoned — the underlying session cannot be completed.
  update wavex_os.booking_intents
     set status       = 'cancelled',
         cancelled_at = now(),
         updated_at   = now()
   where status     = 'pending_payment'
     and created_at < now() - (p_older_than_hours || ' hours')::interval;

  get diagnostics v_count = row_count;
  return jsonb_build_object('cancelled', v_count);
end;
$$;

revoke all on function public.wavex_os_cancel_expired_pending_payment_intents(int) from public;
grant execute on function public.wavex_os_cancel_expired_pending_payment_intents(int) to service_role;

comment on function public.wavex_os_cancel_expired_pending_payment_intents is
  'Cancel booking_intents stuck in pending_payment for longer than p_older_than_hours '
  '(default 25 — Stripe sessions expire in 24 h). Sets cancelled_at = now(). '
  'Handles intents whose checkout.session.expired webhook was never delivered. '
  'Intended to run alongside wavex_os_cancel_stale_booking_intents in the server '
  'cleanup scheduler. (WAVAAAAAAAA-164)';

commit;
