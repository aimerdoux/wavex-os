-- WaveX OS — bookings fulfillment instrumentation (WAVAAAAA-218)
--
-- Adds the schema surface that the fulfillment-resolution stack needs:
--
--   1. fulfillment_status — extend the existing column with the four new
--      terminal states (fulfilled, no_show, cancelled_late, disputed).
--      The existing column may be a TEXT field (current shape in prod
--      per WAVAAAAA-211 forensics) or an enum; this migration normalises
--      to a CHECK-constrained TEXT to avoid the enum-rewrite trap on a
--      live table. Behaviour for the existing 'pending' state is
--      unchanged.
--
--   2. fulfilled_at TIMESTAMPTZ NULL — set when fulfillment resolves to
--      'fulfilled'. Other terminal states (no_show, cancelled_late,
--      disputed) intentionally do NOT set fulfilled_at; they are tracked
--      via fulfillment_status alone so the GMV recogniser remains
--      "fulfilled only".
--
--   3. fulfillment_source TEXT NULL — which signal closed the booking.
--      The hybrid resolver priority (WAVAAAAA-211) is
--      partner_api > user_confirm > timer_fallback > operator_manual.
--
-- All changes are additive: no column drops, no destructive backfill,
-- no data deletion. Existing 12 bookings stay 'pending' until the
-- backfill sibling issue runs.

begin;

-- ─── fulfillment_status ────────────────────────────────────────────
-- Defensive: only add the constraint if the column exists. If a
-- previous enum constraint exists with a different name we leave it
-- untouched and the new CHECK is additive.

do $$
begin
  if not exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name   = 'bookings'
       and column_name  = 'fulfillment_status'
  ) then
    alter table public.bookings
      add column fulfillment_status text not null default 'pending';
  end if;
end$$;

alter table public.bookings
  drop constraint if exists bookings_fulfillment_status_check;

alter table public.bookings
  add constraint bookings_fulfillment_status_check
  check (fulfillment_status in (
    'pending',
    'fulfilled',
    'no_show',
    'cancelled_late',
    'disputed'
  ));

-- ─── fulfilled_at ──────────────────────────────────────────────────

alter table public.bookings
  add column if not exists fulfilled_at timestamptz null;

-- ─── fulfillment_source ────────────────────────────────────────────

alter table public.bookings
  add column if not exists fulfillment_source text null;

alter table public.bookings
  drop constraint if exists bookings_fulfillment_source_check;

alter table public.bookings
  add constraint bookings_fulfillment_source_check
  check (fulfillment_source is null or fulfillment_source in (
    'partner_api',
    'user_confirm',
    'timer_fallback',
    'operator_manual'
  ));

-- ─── index for the resolver lookup ─────────────────────────────────
-- The hourly worker queries:
--   where fulfillment_status = 'pending'
--     and paid_at is not null
--     and now() > booking_time + experience_duration + interval '24 hours'
-- A partial index on the pending rows keeps the scan cheap as the
-- bookings table grows.

create index if not exists bookings_fulfillment_pending_idx
  on public.bookings (booking_time)
  where fulfillment_status = 'pending';

-- ─── comments ──────────────────────────────────────────────────────

comment on column public.bookings.fulfillment_status is
  'Lifecycle state of the booking fulfillment promise. Set to fulfilled '
  'when partner_api confirms, user user_confirms, the 24h timer_fallback '
  'fires, or an operator manually resolves. See WAVAAAAA-211 for the '
  'hybrid-signal decision.';

comment on column public.bookings.fulfilled_at is
  'Timestamp at which fulfillment_status transitioned to fulfilled. '
  'Null for pending and for terminal-non-fulfilled states '
  '(no_show / cancelled_late / disputed).';

comment on column public.bookings.fulfillment_source is
  'Which signal closed the booking. Priority order during resolution: '
  'partner_api > user_confirm > timer_fallback > operator_manual.';

commit;
