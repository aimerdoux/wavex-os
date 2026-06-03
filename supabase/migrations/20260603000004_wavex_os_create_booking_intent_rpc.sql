-- wavex_os_create_booking_intent RPC (WAVAAAA-1203)
--
-- The Telegram bot needs a way to create rows in wavex_os.booking_intents.
-- The wavex_os schema is not exposed to PostgREST, so direct table access
-- from the bot (or any edge function without Deno.env.SUPABASE_SERVICE_ROLE_KEY
-- + schema override) fails with 'relation not found'.
-- 
-- This RPC gives the bot a stable public-schema entry point, following the
-- same security-definer + search_path pattern as the other booking RPCs.

create or replace function public.wavex_os_create_booking_intent(
  p_telegram_user_id         text,
  p_experience_id            text,
  p_experience_name          text,
  p_experience_price_cents   bigint,
  p_currency                 text        default 'usd',
  p_booking_time             timestamptz default null,
  p_user_id                  uuid        default null
)
returns jsonb
language plpgsql
security definer
set search_path = wavex_os, public
as $$
declare
  v_id uuid;
begin
  insert into wavex_os.booking_intents (
    telegram_user_id,
    user_id,
    experience_id,
    experience_name,
    experience_price_cents,
    currency,
    booking_time
  ) values (
    p_telegram_user_id,
    p_user_id,
    p_experience_id,
    p_experience_name,
    p_experience_price_cents,
    lower(p_currency),
    p_booking_time
  )
  returning id into v_id;

  return jsonb_build_object('id', v_id);
end;
$$;

revoke all on function public.wavex_os_create_booking_intent(text, text, text, bigint, text, timestamptz, uuid) from public;
grant execute on function public.wavex_os_create_booking_intent(text, text, text, bigint, text, timestamptz, uuid) to service_role;

comment on function public.wavex_os_create_booking_intent is
  'Create a row in wavex_os.booking_intents from the Telegram bot or any '
  'service_role caller. The wavex_os schema is not PostgREST-exposed so this '
  'public security-definer wrapper is the correct entry point. Returns {id} '
  'for use in the create-booking-checkout-session call.';
