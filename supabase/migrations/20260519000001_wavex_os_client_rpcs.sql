-- Customer-facing RPCs for the WaveX OS onboarding wizard + Mission
-- Control. Replaces 6 direct `supabase.schema("wavex_os").from(...)`
-- calls in the browser that were 400'ing with
--   "The schema must be one of the following: public, graphql_public,
--    meta_ads"
-- because the wavex_os schema is intentionally NOT exposed via
-- PostgREST (db.schemas). Exposing it would force every wavex_os table
-- to be RLS-safe for anon/authenticated reads, which we don't want as a
-- blanket grant. RPCs are the right boundary: SECURITY DEFINER, filter
-- by auth.uid() inside the function body, GRANT EXECUTE only to
-- authenticated.
--
-- Surfaced by the live foodexinc.com onboarding QA on 2026-05-19 — the
-- wizard called .schema("wavex_os").from(...) during Pillar 1 draft
-- save and the user saw "Failed to save draft".
--
-- All RPCs mirror the existing wavex_os_list_my_hires pattern (search
-- path empty, auth.uid() → wavex_os.subscriptions → catalog/hires).

-- ─── 1. List active catalog ──────────────────────────────────────────
-- HireAgentFlow.tsx: catalog browser. Anyone authenticated can read
-- the public catalog of Expert Agents they could hire — there's no
-- per-user filtering here.
create or replace function public.wavex_os_list_active_catalog()
returns table (
  id              text,
  display_name    text,
  purpose         text,
  data_scope      text[],
  output_types    text[],
  required_tier   text,
  daily_token_cap int
)
language sql
security definer
set search_path = ''
as $$
  select
    c.id,
    c.display_name,
    c.purpose,
    c.data_scope,
    c.output_types,
    c.required_tier,
    c.daily_token_cap
  from wavex_os.expert_agent_catalog c
  where c.is_active = true
  order by c.required_tier, c.display_name;
$$;

grant execute on function public.wavex_os_list_active_catalog() to authenticated;

-- ─── 2. My digest access log ─────────────────────────────────────────
-- PrivacyPanel.tsx: read which fields each hired Expert Agent has
-- decrypted on the customer's behalf. Filtered by hires that belong
-- to the caller's subscription.
create or replace function public.wavex_os_my_digest_access_log(
  p_limit int default 100
)
returns table (
  id                uuid,
  hired_agent_id    uuid,
  fields_accessed   text[],
  purpose           text,
  accessed_at       timestamptz
)
language sql
security definer
set search_path = ''
as $$
  select
    l.id,
    l.hired_agent_id,
    l.fields_accessed,
    l.purpose,
    l.accessed_at
  from wavex_os.digest_access_log l
  join wavex_os.hired_expert_agents h on h.id = l.hired_agent_id
  join wavex_os.subscriptions s on s.id = h.subscription_id
  where s.user_id = auth.uid()
  order by l.accessed_at desc
  limit greatest(1, least(p_limit, 500));
$$;

grant execute on function public.wavex_os_my_digest_access_log(int) to authenticated;

-- ─── 3. Revoke one of my hires ───────────────────────────────────────
-- PrivacyPanel.tsx: customer revokes an Expert Agent's access. Only
-- works on hires that belong to the caller's subscription. Returns
-- the updated row so the client can refresh its local state.
create or replace function public.wavex_os_revoke_hire(
  p_hire_id uuid
)
returns table (
  id            uuid,
  catalog_id    text,
  status        text,
  revoked_at    timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  return query
    update wavex_os.hired_expert_agents h
      set status     = 'revoked',
          revoked_at = now()
    from wavex_os.subscriptions s
    where h.id = p_hire_id
      and s.id = h.subscription_id
      and s.user_id = v_user_id
    returning h.id, h.catalog_id, h.status, h.revoked_at;

  -- If nothing was returned the caller doesn't own this hire (or
  -- the hire doesn't exist). Treating both as the same 404-equivalent
  -- avoids leaking hire existence to non-owners.
  if not found then
    raise exception 'hire not found or not owned by caller'
      using errcode = '42501';
  end if;
end;
$$;

grant execute on function public.wavex_os_revoke_hire(uuid) to authenticated;

-- ─── 4. Hire an Expert Agent ─────────────────────────────────────────
-- Pricing.tsx: customer confirms hire after accepting the Processing
-- Agreement. Inserts one (subscription_id, catalog_id) row. Verifies
-- the subscription belongs to the caller AND that the customer's tier
-- meets the catalog entry's required_tier.
create or replace function public.wavex_os_hire_expert(
  p_catalog_id        text,
  p_agreement_version text default '1.0'
)
returns table (
  id                  uuid,
  subscription_id     uuid,
  catalog_id          text,
  status              text,
  hired_at            timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_sub     wavex_os.subscriptions%rowtype;
  v_cat     wavex_os.expert_agent_catalog%rowtype;
  v_tier_ok boolean;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  -- Caller's active or trialing subscription.
  select * into v_sub
  from wavex_os.subscriptions
  where user_id = v_user_id
    and status in ('trialing', 'active')
  order by status = 'active' desc, created_at desc
  limit 1;

  if v_sub.id is null then
    raise exception 'no active subscription'
      using errcode = '42501';
  end if;

  -- Target catalog entry must exist + be active.
  select * into v_cat
  from wavex_os.expert_agent_catalog
  where id = p_catalog_id and is_active = true;

  if v_cat.id is null then
    raise exception 'catalog entry not found or inactive'
      using errcode = '42501';
  end if;

  -- Tier gating: founder < growth < custom. Customer's tier must be
  -- >= required_tier on the catalog row.
  v_tier_ok := (
    case v_sub.tier
      when 'founder' then 0
      when 'growth'  then 1
      when 'custom'  then 2
      else -1
    end
    >=
    case v_cat.required_tier
      when 'founder' then 0
      when 'growth'  then 1
      when 'custom'  then 2
      else 99
    end
  );
  if not v_tier_ok then
    raise exception 'subscription tier % below required tier %',
      v_sub.tier, v_cat.required_tier
      using errcode = '42501';
  end if;

  return query
    insert into wavex_os.hired_expert_agents (
      subscription_id, catalog_id, status, agreement_version
    )
    values (
      v_sub.id, p_catalog_id, 'active', p_agreement_version
    )
    on conflict (subscription_id, catalog_id) do update
      set status                = 'active',
          agreement_version     = excluded.agreement_version,
          agreement_accepted_at = now(),
          revoked_at            = null
    returning id, subscription_id, catalog_id, status, hired_at;
end;
$$;

grant execute on function public.wavex_os_hire_expert(text, text) to authenticated;

-- ─── 5. Active hires + recipient public keys (for Liaison encrypt) ──
-- encrypt-envelopes.mjs in the wavex-liaison agent runs on the
-- customer's Mac, authenticated as that customer. It needs the
-- (catalog_id, data_scope, recipient_public_key) tuple for every
-- active hire under the caller's subscription, so it can build
-- per-field sealed-box envelopes addressed to each Expert Agent.
-- Returns only the caller's hires via auth.uid() join.
create or replace function public.wavex_os_my_active_hires_for_envelopes()
returns table (
  catalog_id            text,
  data_scope            text[],
  recipient_public_key  bytea
)
language sql
security definer
set search_path = ''
as $$
  select
    c.id            as catalog_id,
    c.data_scope,
    c.recipient_public_key
  from wavex_os.hired_expert_agents h
  join wavex_os.expert_agent_catalog c on c.id = h.catalog_id
  join wavex_os.subscriptions s on s.id = h.subscription_id
  where s.user_id = auth.uid()
    and h.status = 'active'
    and c.recipient_public_key is not null;
$$;

grant execute on function public.wavex_os_my_active_hires_for_envelopes() to authenticated;

-- ─── Notes ────────────────────────────────────────────────────────────
-- After this migration is applied, the onboarding-ui can drop all
-- supabase.schema("wavex_os").from(...) calls in:
--   - packages/onboarding-ui/src/components/PrivacyPanel.tsx
--   - packages/onboarding-ui/src/components/HireAgentFlow.tsx
--   - packages/onboarding-ui/src/pages/Pricing.tsx
-- and the wavex-liaison agent tool encrypt-envelopes.mjs can drop its
-- direct schema() join. Switch to supabase.rpc("wavex_os_*") instead.
-- PostgREST exposure of the wavex_os schema is intentionally NOT
-- required, and these RPCs keep the auth boundary inside SECURITY
-- DEFINER bodies.
