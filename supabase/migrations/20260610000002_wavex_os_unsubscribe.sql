-- WAV-59: Add unsubscribed flag to public.leads and public.genesis_leads.
--
-- CAN-SPAM requires a working unsubscribe mechanism for all outbound email.
-- This migration adds the unsubscribed column to both contact tables and
-- creates the public.wavex_os_unsubscribe_contact RPC used by the
-- /api/unsubscribe endpoint.

alter table public.leads
  add column if not exists unsubscribed boolean not null default false,
  add column if not exists unsubscribed_at timestamptz null;

create index if not exists leads_unsubscribed_idx
  on public.leads (unsubscribed)
  where unsubscribed = true;

alter table public.genesis_leads
  add column if not exists unsubscribed boolean not null default false,
  add column if not exists unsubscribed_at timestamptz null;

create index if not exists genesis_leads_unsubscribed_idx
  on public.genesis_leads (unsubscribed)
  where unsubscribed = true;

-- ─── RPC: wavex_os_unsubscribe_contact ───────────────────────────────────────
-- Marks the contact with the given email as unsubscribed across all tables.
-- Returns the number of rows updated (0 = email not found).

create or replace function public.wavex_os_unsubscribe_contact(
  p_email text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email       text := lower(trim(p_email));
  v_leads_count integer := 0;
  v_genesis_count integer := 0;
begin
  if v_email is null or v_email = '' then
    return jsonb_build_object('ok', false, 'error', 'email_required');
  end if;

  update public.leads
     set unsubscribed    = true,
         unsubscribed_at = now()
   where lower(email) = v_email
     and unsubscribed = false;
  get diagnostics v_leads_count = row_count;

  update public.genesis_leads
     set unsubscribed    = true,
         unsubscribed_at = now()
   where lower(email) = v_email
     and unsubscribed = false;
  get diagnostics v_genesis_count = row_count;

  return jsonb_build_object(
    'ok',            true,
    'email',         v_email,
    'leads_updated', v_leads_count,
    'genesis_updated', v_genesis_count,
    'total_updated', v_leads_count + v_genesis_count
  );
end;
$$;

revoke all on function public.wavex_os_unsubscribe_contact(text) from public;
grant execute on function public.wavex_os_unsubscribe_contact(text) to service_role;
-- Allow anon to call from the browser unsubscribe page (one-click, no auth required)
grant execute on function public.wavex_os_unsubscribe_contact(text) to anon;

comment on function public.wavex_os_unsubscribe_contact is
  'CAN-SPAM unsubscribe: marks the contact with p_email as unsubscribed in '
  'public.leads and public.genesis_leads. Called by the /api/unsubscribe '
  'endpoint (WAV-59). Idempotent — safe to call multiple times.';
