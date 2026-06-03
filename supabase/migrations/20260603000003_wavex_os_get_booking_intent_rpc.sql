-- wavex_os_get_booking_intent RPC (WAVAAAA-1198 smoke-test fix)
--
-- The wavex_os schema is not in the PostgREST exposed schema list, so
-- .schema("wavex_os").from("booking_intents") in the edge function returns
-- intent_not_found. Pattern in this codebase: use public-schema RPCs with
-- security definer + search_path to proxy access to wavex_os tables.

create or replace function public.wavex_os_get_booking_intent(
  p_intent_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = wavex_os, public
as $$
declare
  v_row wavex_os.booking_intents%rowtype;
begin
  select * into v_row
    from wavex_os.booking_intents
   where id = p_intent_id
   limit 1;

  if not found then
    return null;
  end if;

  return jsonb_build_object(
    'id',                         v_row.id,
    'user_id',                    v_row.user_id,
    'experience_name',            v_row.experience_name,
    'experience_price_cents',     v_row.experience_price_cents,
    'currency',                   v_row.currency,
    'status',                     v_row.status,
    'stripe_checkout_session_id', v_row.stripe_checkout_session_id
  );
end;
$$;

revoke all on function public.wavex_os_get_booking_intent(uuid) from public;
grant execute on function public.wavex_os_get_booking_intent(uuid) to service_role;
