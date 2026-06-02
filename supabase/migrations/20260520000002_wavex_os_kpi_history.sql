-- WaveX OS — KPI history sink + booking_gmv snapshot procedure (WAVAAAAA-129)
--
-- CDO/TELEMETRY deliverable: the substrate the recurring kpi_history routine
-- (WAVAAAAA-1) fires against. One row per snapshot, immutable, indexed by
-- (kpi, captured_at desc) so backfills and time-series queries are cheap.
--
-- Why a sink table (not a view): KPI snapshots are point-in-time. We
-- explicitly want a historical record we can backfill against and audit
-- against drift, not a live derivation that silently re-computes when the
-- underlying surface mutates.
--
-- Contract (do not break without bumping a new table/version):
--   id           bigint        — surrogate pk
--   kpi          text          — kpi name (e.g. 'booking_gmv')
--   value        numeric       — measured value at captured_at
--   currency     text          — ISO 4217 when monetary, else NULL
--   dimensions   jsonb         — slicer dims (geo, segment, tier, ...)
--   captured_at  timestamptz   — snapshot wall-clock
--   source       text          — emitting agent / procedure name

create table if not exists wavex_os.kpi_history (
  id          bigint generated always as identity primary key,
  kpi         text        not null,
  value       numeric     not null,
  currency    text,
  dimensions  jsonb       not null default '{}'::jsonb,
  captured_at timestamptz not null default now(),
  source      text
);

create index if not exists kpi_history_kpi_captured_at_idx
  on wavex_os.kpi_history(kpi, captured_at desc);

comment on table wavex_os.kpi_history is
  'Append-only KPI snapshot sink (WAVAAAAA-129). One row per measurement; '
  'the recurring routine writes here on cadence so we have a historical '
  'series to drift-check, backfill, and attribute against. Substrate for '
  'kpi_freshness_seconds and kpi_translation_drift telemetry.';

-- ─── snapshot_booking_gmv() ────────────────────────────────────────────
-- Computes cumulative booking_gmv from public.bookings filtered to
-- status in ('confirmed','completed') and currency='USD', then writes a
-- single row to wavex_os.kpi_history. Idempotent within a 60s window:
-- if the most recent booking_gmv snapshot is younger than 60 seconds we
-- skip the insert and return the existing row. This keeps the routine
-- safe to re-fire on overlapping schedules and during migration replays.

create or replace function wavex_os.snapshot_booking_gmv()
returns table (
  id          bigint,
  value       numeric,
  captured_at timestamptz
)
language plpgsql
set search_path = ''
as $$
declare
  v_gmv     numeric;
  v_last_at timestamptz;
  v_last_id bigint;
  v_last_v  numeric;
begin
  -- Idempotency guard: if the most recent booking_gmv row is younger
  -- than 60s, return it instead of inserting a duplicate.
  select h.id, h.value, h.captured_at
    into v_last_id, v_last_v, v_last_at
    from wavex_os.kpi_history h
   where h.kpi = 'booking_gmv'
   order by h.captured_at desc
   limit 1;

  if v_last_at is not null and v_last_at > now() - interval '60 seconds' then
    id          := v_last_id;
    value       := v_last_v;
    captured_at := v_last_at;
    return next;
    return;
  end if;

  select coalesce(sum(b.amount), 0)::numeric
    into v_gmv
    from public.bookings b
   where b.booking_status in ('confirmed', 'completed')
     and b.currency = 'USD';

  insert into wavex_os.kpi_history (kpi, value, currency, dimensions, source)
  values (
    'booking_gmv',
    v_gmv,
    'USD',
    jsonb_build_object(
      'booking_status', jsonb_build_array('confirmed', 'completed'),
      'source_table',   'public.bookings'
    ),
    'wavex_os.snapshot_booking_gmv'
  )
  returning kpi_history.id, kpi_history.value, kpi_history.captured_at
       into id, value, captured_at;

  return next;
end;
$$;

comment on function wavex_os.snapshot_booking_gmv() is
  'Captures cumulative booking_gmv (sum of public.bookings.amount where '
  'booking_status in (confirmed, completed) and currency = USD) into '
  'wavex_os.kpi_history. Idempotent within 60s: re-fires return the '
  'existing row rather than writing a duplicate. Fired by the recurring '
  'kpi_history routine (WAVAAAAA-1) and on-demand by drift checks.';

-- ─── t=0 baseline ──────────────────────────────────────────────────────
-- Required by the issue acceptance criteria: execute the procedure once
-- on landing so a baseline row exists in kpi_history before the routine
-- starts firing. The idempotency guard above keeps replays safe.

select * from wavex_os.snapshot_booking_gmv();
