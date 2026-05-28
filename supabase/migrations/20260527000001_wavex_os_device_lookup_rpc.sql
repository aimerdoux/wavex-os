-- Service-role RPC for validating that a device JWT still maps to a live,
-- non-reassigned wavex_os.os_devices row owned by the same user.
--
-- The inference server now rejects revoked/missing devices before touching
-- Anthropic, and this public SECURITY DEFINER wrapper lets PostgREST callers
-- perform that check without exposing the whole wavex_os schema.

create or replace function public.wavex_os_device_lookup(
  p_user_id uuid,
  p_device_id uuid
)
returns table (
  id uuid,
  user_id uuid,
  status text,
  name text,
  last_seen_at timestamptz
)
language sql
security definer
set search_path to 'wavex_os', 'public'
as $function$
  select d.id, d.user_id, d.status, d.name, d.last_seen_at
  from wavex_os.os_devices d
  where d.user_id = p_user_id
    and d.id = p_device_id
  limit 1
$function$;

revoke all on function public.wavex_os_device_lookup(uuid, uuid) from public, anon, authenticated;
grant execute on function public.wavex_os_device_lookup(uuid, uuid) to service_role;

comment on function public.wavex_os_device_lookup(uuid, uuid) is
  'Pool B device gate: resolve one wavex_os.os_devices row for a specific user/device pair so the inference server can reject revoked or unknown devices. Service-role only.';
