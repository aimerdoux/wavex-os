-- Pool B accountability + observability hardening.
--
-- Goals:
--   1. Allow Pool B rows into wavex_os.usage_ledger (the base migration only
--      allowed A/C, which caused later Pool B writes to fail).
--   2. Add a dedicated append-only forensic audit stream for every Pool B
--      request attempt, including disabled/rejected/duplicate/fallback cases.
--   3. Provide SECURITY DEFINER RPCs so the local inference server can write
--      and operators can read recent rows without exposing wavex_os directly
--      through PostgREST schemas.

do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conname = 'usage_ledger_pool_check'
      and conrelid = 'wavex_os.usage_ledger'::regclass
  ) then
    alter table wavex_os.usage_ledger
      drop constraint usage_ledger_pool_check;
  end if;
end
$$;

alter table wavex_os.usage_ledger
  add constraint usage_ledger_pool_check
  check (pool in ('A', 'B', 'C'));

drop policy if exists "customer reads own usage ledger" on wavex_os.usage_ledger;
create policy "customer reads own usage ledger"
  on wavex_os.usage_ledger for select
  using (
    pool in ('B', 'C') and auth.uid() = (
      select user_id
      from wavex_os.subscriptions
      where id = usage_ledger.subscription_id
    )
  );

comment on table wavex_os.usage_ledger is
  'Append-only ledger of every Pool A + Pool B + Pool C inference call. Source of truth for spend, throttles, and customer-visible attribution.';

create table if not exists wavex_os.inference_audit_events (
  id                    uuid primary key default gen_random_uuid(),
  pool                  text not null check (pool = 'B'),
  route                 text not null check (route in ('http', 'realtime', 'anthropic-messages')),
  request_id            text not null,
  attempt_no            integer not null default 0 check (attempt_no >= 0),
  user_id               uuid,
  subscription_id       uuid references wavex_os.subscriptions(id) on delete set null,
  device_id             uuid references wavex_os.os_devices(id) on delete set null,
  purpose               text,
  client_name           text,
  client_version        text,
  source                text,
  session_id            text,
  conversation_id       text,
  trace_id              text,
  provider              text not null,
  fallback_mode         text not null,
  fallback_used         boolean not null default false,
  provider_response_id  text,
  model                 text,
  status                text not null check (status in ('accepted', 'rejected', 'failed', 'disabled', 'rate_limited', 'duplicate')),
  outcome               text not null,
  error_class           text,
  duration_ms           integer,
  prompt_chars          integer,
  message_count         integer,
  context_input_tokens  integer,
  prompt_sha256         text,
  prompt_tokens         integer,
  completion_tokens     integer,
  cache_read_tokens     integer not null default 0,
  cache_creation_tokens integer not null default 0,
  cost_cents            integer,
  server_hostname       text not null,
  server_pid            integer,
  metadata              jsonb not null default '{}'::jsonb,
  occurred_at           timestamptz not null default now()
);

create index if not exists inference_audit_events_occurred_idx
  on wavex_os.inference_audit_events(occurred_at desc);

create index if not exists inference_audit_events_request_idx
  on wavex_os.inference_audit_events(request_id, attempt_no);

create index if not exists inference_audit_events_user_idx
  on wavex_os.inference_audit_events(user_id, occurred_at desc)
  where user_id is not null;

create index if not exists inference_audit_events_device_idx
  on wavex_os.inference_audit_events(device_id, occurred_at desc)
  where device_id is not null;

create index if not exists inference_audit_events_sub_idx
  on wavex_os.inference_audit_events(subscription_id, occurred_at desc)
  where subscription_id is not null;

comment on table wavex_os.inference_audit_events is
  'Append-only forensic audit stream for every Pool B request attempt, including rejects, disabled requests, duplicates, and provider fallback hops.';

alter table wavex_os.inference_audit_events enable row level security;

drop policy if exists "customer reads own inference audit events" on wavex_os.inference_audit_events;
create policy "customer reads own inference audit events"
  on wavex_os.inference_audit_events for select
  using (
    user_id is not null and auth.uid() = user_id
  );

create or replace function public.wavex_os_record_inference_audit(
  p_pool text,
  p_route text,
  p_request_id text,
  p_attempt_no integer default 0,
  p_user_id uuid default null,
  p_subscription_id uuid default null,
  p_device_id uuid default null,
  p_purpose text default null,
  p_client_name text default null,
  p_client_version text default null,
  p_source text default null,
  p_session_id text default null,
  p_conversation_id text default null,
  p_trace_id text default null,
  p_provider text default 'control-plane',
  p_fallback_mode text default 'anthropic_only',
  p_fallback_used boolean default false,
  p_provider_response_id text default null,
  p_model text default null,
  p_status text default 'failed',
  p_outcome text default 'unknown',
  p_error_class text default null,
  p_duration_ms integer default null,
  p_prompt_chars integer default null,
  p_message_count integer default null,
  p_context_input_tokens integer default null,
  p_prompt_sha256 text default null,
  p_prompt_tokens integer default null,
  p_completion_tokens integer default null,
  p_cache_read_tokens integer default 0,
  p_cache_creation_tokens integer default 0,
  p_cost_cents integer default null,
  p_server_hostname text default '',
  p_server_pid integer default null,
  p_metadata jsonb default '{}'::jsonb
)
returns uuid
language sql
security definer
set search_path to 'wavex_os', 'public'
as $function$
  insert into wavex_os.inference_audit_events (
    pool, route, request_id, attempt_no, user_id, subscription_id, device_id,
    purpose, client_name, client_version, source, session_id, conversation_id,
    trace_id, provider, fallback_mode, fallback_used, provider_response_id,
    model, status, outcome, error_class, duration_ms, prompt_chars,
    message_count, context_input_tokens, prompt_sha256, prompt_tokens,
    completion_tokens, cache_read_tokens, cache_creation_tokens, cost_cents,
    server_hostname, server_pid, metadata, occurred_at
  ) values (
    p_pool, p_route, p_request_id, greatest(coalesce(p_attempt_no, 0), 0),
    p_user_id, p_subscription_id, p_device_id, p_purpose, p_client_name,
    p_client_version, p_source, p_session_id, p_conversation_id, p_trace_id,
    coalesce(nullif(p_provider, ''), 'control-plane'),
    coalesce(nullif(p_fallback_mode, ''), 'anthropic_only'),
    coalesce(p_fallback_used, false), p_provider_response_id, p_model,
    p_status, p_outcome, p_error_class, p_duration_ms, p_prompt_chars,
    p_message_count, p_context_input_tokens, p_prompt_sha256, p_prompt_tokens,
    p_completion_tokens, coalesce(p_cache_read_tokens, 0),
    coalesce(p_cache_creation_tokens, 0), p_cost_cents,
    coalesce(nullif(p_server_hostname, ''), 'unknown-host'),
    p_server_pid, coalesce(p_metadata, '{}'::jsonb), now()
  )
  returning id
$function$;

revoke all on function public.wavex_os_record_inference_audit(
  text, text, text, integer, uuid, uuid, uuid, text, text, text, text,
  text, text, text, text, text, boolean, text, text, text, text, text,
  integer, integer, integer, integer, text, integer, integer, integer,
  integer, integer, text, integer, jsonb
) from public, anon, authenticated;

grant execute on function public.wavex_os_record_inference_audit(
  text, text, text, integer, uuid, uuid, uuid, text, text, text, text,
  text, text, text, text, text, boolean, text, text, text, text, text,
  integer, integer, integer, integer, text, integer, integer, integer,
  integer, integer, text, integer, jsonb
) to service_role;

comment on function public.wavex_os_record_inference_audit(
  text, text, text, integer, uuid, uuid, uuid, text, text, text, text,
  text, text, text, text, text, boolean, text, text, text, text, text,
  integer, integer, integer, integer, text, integer, integer, integer,
  integer, integer, text, integer, jsonb
) is
  'Insert one Pool B forensic audit row from a public-schema RPC so the local inference server can write durable accountability records.';

create or replace function public.wavex_os_recent_inference_audit(
  p_limit integer default 100
)
returns table (
  id uuid,
  occurred_at timestamptz,
  route text,
  request_id text,
  attempt_no integer,
  user_id uuid,
  subscription_id uuid,
  device_id uuid,
  purpose text,
  client_name text,
  client_version text,
  source text,
  session_id text,
  conversation_id text,
  trace_id text,
  provider text,
  fallback_mode text,
  fallback_used boolean,
  provider_response_id text,
  model text,
  status text,
  outcome text,
  error_class text,
  duration_ms integer,
  prompt_chars integer,
  message_count integer,
  context_input_tokens integer,
  prompt_sha256 text,
  prompt_tokens integer,
  completion_tokens integer,
  cache_read_tokens integer,
  cache_creation_tokens integer,
  cost_cents integer,
  server_hostname text,
  server_pid integer,
  metadata jsonb
)
language sql
security definer
set search_path to 'wavex_os', 'public'
as $function$
  select
    e.id,
    e.occurred_at,
    e.route,
    e.request_id,
    e.attempt_no,
    e.user_id,
    e.subscription_id,
    e.device_id,
    e.purpose,
    e.client_name,
    e.client_version,
    e.source,
    e.session_id,
    e.conversation_id,
    e.trace_id,
    e.provider,
    e.fallback_mode,
    e.fallback_used,
    e.provider_response_id,
    e.model,
    e.status,
    e.outcome,
    e.error_class,
    e.duration_ms,
    e.prompt_chars,
    e.message_count,
    e.context_input_tokens,
    e.prompt_sha256,
    e.prompt_tokens,
    e.completion_tokens,
    e.cache_read_tokens,
    e.cache_creation_tokens,
    e.cost_cents,
    e.server_hostname,
    e.server_pid,
    e.metadata
  from wavex_os.inference_audit_events e
  order by e.occurred_at desc, e.request_id desc, e.attempt_no desc
  limit least(greatest(coalesce(p_limit, 100), 1), 500)
$function$;

revoke all on function public.wavex_os_recent_inference_audit(integer) from public, anon, authenticated;
grant execute on function public.wavex_os_recent_inference_audit(integer) to service_role;

comment on function public.wavex_os_recent_inference_audit(integer) is
  'Return recent Pool B forensic audit rows for operator/admin tooling.';
