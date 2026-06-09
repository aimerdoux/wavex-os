-- WaveX OS — auth_events RPCs
--
-- The wavex_os schema is NOT exposed via PostgREST (intentional — same
-- pattern as wavex_os_client_rpcs). These SECURITY DEFINER functions in
-- the public schema are the only write/read path for auth_events from
-- server-side code using the service-role key.
--
-- Three functions:
--   wavex_os_record_auth_event      — upsert one signup event row
--   wavex_os_get_unfired_auth_events — read unfired signup_confirmed rows (backfill)
--   wavex_os_mark_auth_event_fired  — mark one row resend_fired=true (backfill)

-- ─── 1. Record an auth event ─────────────────────────────────────────────────
-- Called from wavex-os-server POST /api/auth-events. Inserts the event row
-- and returns the new row id (or null if duplicate-suppressed).
create or replace function public.wavex_os_record_auth_event(
  p_user_id      text,
  p_email        text,
  p_event_type   text,
  p_utm_campaign text,
  p_utm_source   text,
  p_ref          text,
  p_resend_fired boolean
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into wavex_os.auth_events (
    user_id, email, event_type, utm_campaign, utm_source, ref, resend_fired
  )
  values (
    p_user_id, p_email, p_event_type, p_utm_campaign, p_utm_source, p_ref, p_resend_fired
  )
  on conflict do nothing
  returning id into v_id;

  return v_id;
end;
$$;

-- Service-role key is used server-side; no user session involved.
grant execute on function public.wavex_os_record_auth_event(text,text,text,text,text,text,boolean)
  to service_role;

-- ─── 2. Get unfired signup_confirmed events for backfill ─────────────────────
-- Returns up to p_limit rows where resend_fired=false, event_type='signup_confirmed',
-- and email is not null. Ordered oldest-first for deterministic backfill.
create or replace function public.wavex_os_get_unfired_auth_events(
  p_limit int default 100
)
returns table (
  id           uuid,
  email        text,
  utm_campaign text,
  created_at   timestamptz
)
language sql
security definer
set search_path = ''
as $$
  select id, email, utm_campaign, created_at
  from wavex_os.auth_events
  where resend_fired  = false
    and event_type    = 'signup_confirmed'
    and email         is not null
  order by created_at asc
  limit greatest(1, least(p_limit, 1000));
$$;

grant execute on function public.wavex_os_get_unfired_auth_events(int)
  to service_role;

-- ─── 3. Mark one event as resend_fired ───────────────────────────────────────
-- Called once per row during backfill after Resend contact is created.
create or replace function public.wavex_os_mark_auth_event_fired(
  p_id uuid
)
returns void
language sql
security definer
set search_path = ''
as $$
  update wavex_os.auth_events
  set    resend_fired = true
  where  id = p_id;
$$;

grant execute on function public.wavex_os_mark_auth_event_fired(uuid)
  to service_role;

-- ─── 4. Count distinct signup_confirmed users for a campaign (last 7d) ───────
-- Used by GET /api/auth-events/count to verify campaign conversion.
create or replace function public.wavex_os_count_campaign_signups(
  p_utm_campaign text,
  p_days         int default 7
)
returns int
language sql
security definer
set search_path = ''
as $$
  select count(distinct user_id)::int
  from wavex_os.auth_events
  where utm_campaign  = p_utm_campaign
    and event_type    = 'signup_confirmed'
    and created_at    >= now() - (p_days || ' days')::interval;
$$;

grant execute on function public.wavex_os_count_campaign_signups(text, int)
  to service_role;
