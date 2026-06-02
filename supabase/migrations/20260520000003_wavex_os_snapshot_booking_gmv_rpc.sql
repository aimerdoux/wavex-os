-- WaveX OS — public RPC wrapper for wavex_os.snapshot_booking_gmv (WAVAAAAA-189)
--
-- The substrate function lives in wavex_os.snapshot_booking_gmv() per
-- WAVAAAAA-129. PostgREST only exposes public, graphql_public, meta_ads,
-- so the daily kpi_history routine (CDO/TELEMETRY run issues) cannot call
-- it without a public-schema RPC wrapper. This migration adds that
-- wrapper, matching the wavex_os_record_company_manifest pattern used by
-- other wavex_os entrypoints.

create or replace function public.wavex_os_snapshot_booking_gmv()
returns table (
  id          bigint,
  value       numeric,
  captured_at timestamptz
)
language plpgsql
security definer
set search_path to 'wavex_os', 'public'
as $$
begin
  return query select * from wavex_os.snapshot_booking_gmv();
end;
$$;

comment on function public.wavex_os_snapshot_booking_gmv() is
  'PostgREST-exposed wrapper for wavex_os.snapshot_booking_gmv(). Daily '
  'kpi_history routine (WAVAAAAA-189) invokes this from CDO/TELEMETRY '
  'run issues. Inherits the 60s idempotency guard from the underlying '
  'function.';

revoke all on function public.wavex_os_snapshot_booking_gmv() from public;
grant execute on function public.wavex_os_snapshot_booking_gmv() to service_role;
