-- WaveX OS — referral blast and Day-14 nurture send infrastructure (WAVAAAAAAAA-154)
--
-- Supports two one-shot Telegram messages in the referral program:
--   1. Launch blast — sent to all active members on program launch day
--   2. Day-14 nurture — sent 14 days later to members with converted=0
--
-- Tables:
--   wavex_os.referral_sends — audit log; unique (user_id, send_type) where dry_run=false
--
-- RPCs (service_role only):
--   wavex_os_list_referral_blast_candidates()
--     — active members with a resolvable Telegram chat_id who haven't received the blast
--     — lazily creates referral_codes for members without one
--     — returns: user_id, first_name, chat_id, code, share_url
--
--   wavex_os_list_referral_nurture_candidates()
--     — members who received the blast ≥14 days ago, have 0 converted referrals,
--       and haven't received the nurture message
--     — returns: user_id, first_name, chat_id, code, share_url
--
--   wavex_os_record_referral_send(p_user_id, p_send_type, p_chat_id, p_message_text, p_message_id, p_dry_run)
--     — records a send; idempotent via unique constraint on (user_id, send_type) for real sends

begin;

-- ─── referral_sends ──────────────────────────────────────────────────────────

create table if not exists wavex_os.referral_sends (
  id            uuid        primary key default gen_random_uuid(),
  user_id       uuid        not null references auth.users(id) on delete cascade,
  send_type     text        not null check (send_type in ('blast', 'nurture_14d')),
  chat_id       text        not null,
  message_text  text        not null,
  message_id    text,                  -- Telegram message_id returned by sendMessage
  dry_run       boolean     not null default false,
  sent_at       timestamptz not null default now()
);

-- one real send per (user, type) — dry-run rows are allowed to accumulate
create unique index if not exists referral_sends_unique_real
  on wavex_os.referral_sends (user_id, send_type)
  where dry_run = false;

comment on table wavex_os.referral_sends is
  'Audit log for referral blast and nurture Telegram sends. '
  'Unique constraint on (user_id, send_type) where dry_run=false prevents double-send.';

-- ─── helpers ─────────────────────────────────────────────────────────────────

-- resolve best-effort first name from auth.users metadata
create or replace function wavex_os._referral_first_name(p_user_id uuid)
returns text
language sql
security definer
stable
set search_path = ''
as $$
  select coalesce(
    -- "First Last" → "First"
    split_part(
      coalesce(
        (select raw_user_meta_data->>'full_name' from auth.users where id = p_user_id),
        (select raw_user_meta_data->>'name'      from auth.users where id = p_user_id),
        (select raw_user_meta_data->>'first_name' from auth.users where id = p_user_id)
      ),
      ' ', 1
    ),
    'there'  -- fallback: "Hey there,"
  )
  where split_part(
    coalesce(
      (select raw_user_meta_data->>'full_name' from auth.users where id = p_user_id),
      (select raw_user_meta_data->>'name'      from auth.users where id = p_user_id),
      (select raw_user_meta_data->>'first_name' from auth.users where id = p_user_id)
    ),
    ' ', 1
  ) <> ''
  union all
  select 'there'
  limit 1
$$;

comment on function wavex_os._referral_first_name(uuid) is
  'Returns first name from auth.users raw_user_meta_data (full_name → name → first_name). '
  'Falls back to "there" when no name available.';

-- resolve latest chat_id for a user from telegram_events
create or replace function wavex_os._referral_chat_id(p_user_id uuid)
returns text
language sql
security definer
stable
set search_path = ''
as $$
  select chat_id
  from wavex_os.telegram_events
  where user_id = p_user_id
    and chat_id is not null
  order by occurred_at desc
  limit 1
$$;

comment on function wavex_os._referral_chat_id(uuid) is
  'Returns the most recent chat_id for a user from telegram_events, or NULL if unreachable.';

-- ─── wavex_os_list_referral_blast_candidates ─────────────────────────────────

create or replace function public.wavex_os_list_referral_blast_candidates()
returns table (
  user_id       uuid,
  first_name    text,
  chat_id       text,
  code          text,
  share_url     text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- lazily create referral codes for active members who don't have one
  insert into wavex_os.referral_codes (user_id, code)
  select
    s.user_id,
    -- deterministic 6-char slug from user_id
    upper(substring(replace(s.user_id::text, '-', ''), 1, 6)) as code
  from wavex_os.subscriptions s
  where s.status in ('active', 'trialing')
    and s.user_id is not null
    and not exists (
      select 1 from wavex_os.referral_codes rc where rc.user_id = s.user_id
    )
  on conflict (user_id) do nothing;

  return query
  select
    s.user_id,
    wavex_os._referral_first_name(s.user_id)                       as first_name,
    wavex_os._referral_chat_id(s.user_id)                          as chat_id,
    rc.code                                                         as code,
    'https://wavexcard.com/join?ref=' || rc.code
      || '&utm_campaign=referral_launch'                            as share_url
  from wavex_os.subscriptions s
  join wavex_os.referral_codes rc on rc.user_id = s.user_id
  where s.status in ('active', 'trialing')
    and s.user_id is not null
    -- reachable via Telegram
    and wavex_os._referral_chat_id(s.user_id) is not null
    -- blast not yet sent (no real send recorded)
    and not exists (
      select 1
      from wavex_os.referral_sends rs
      where rs.user_id = s.user_id
        and rs.send_type = 'blast'
        and rs.dry_run = false
    );
end;
$$;

revoke all on function public.wavex_os_list_referral_blast_candidates() from public;
grant execute on function public.wavex_os_list_referral_blast_candidates() to service_role;

comment on function public.wavex_os_list_referral_blast_candidates() is
  'Returns active members reachable via Telegram who have not yet received the referral launch blast. '
  'Lazily creates referral codes for members without one. '
  'UTM: utm_campaign=referral_launch.';

-- ─── wavex_os_list_referral_nurture_candidates ───────────────────────────────

create or replace function public.wavex_os_list_referral_nurture_candidates()
returns table (
  user_id       uuid,
  first_name    text,
  chat_id       text,
  code          text,
  share_url     text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  select
    rc.user_id,
    wavex_os._referral_first_name(rc.user_id)                       as first_name,
    wavex_os._referral_chat_id(rc.user_id)                          as chat_id,
    rc.code                                                         as code,
    'https://wavexcard.com/join?ref=' || rc.code
      || '&utm_campaign=referral_nurture_14d'                       as share_url
  from wavex_os.referral_codes rc
  -- blast was sent ≥14 days ago
  join wavex_os.referral_sends rs_blast
    on rs_blast.user_id   = rc.user_id
    and rs_blast.send_type = 'blast'
    and rs_blast.dry_run   = false
    and rs_blast.sent_at   <= now() - interval '14 days'
  -- still reachable via Telegram
  where wavex_os._referral_chat_id(rc.user_id) is not null
    -- no converted referrals
    and not exists (
      select 1
      from wavex_os.referrals r
      where r.referrer_user_id = rc.user_id
        and r.status = 'converted'
    )
    -- nurture not yet sent
    and not exists (
      select 1
      from wavex_os.referral_sends rs_n
      where rs_n.user_id   = rc.user_id
        and rs_n.send_type = 'nurture_14d'
        and rs_n.dry_run   = false
    );
end;
$$;

revoke all on function public.wavex_os_list_referral_nurture_candidates() from public;
grant execute on function public.wavex_os_list_referral_nurture_candidates() to service_role;

comment on function public.wavex_os_list_referral_nurture_candidates() is
  'Returns members whose blast was sent ≥14 days ago, have 0 converted referrals, '
  'and have not yet received the Day-14 nurture message. '
  'UTM: utm_campaign=referral_nurture_14d.';

-- ─── wavex_os_record_referral_send ───────────────────────────────────────────

create or replace function public.wavex_os_record_referral_send(
  p_user_id       uuid,
  p_send_type     text,
  p_chat_id       text,
  p_message_text  text,
  p_message_id    text,
  p_dry_run       boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into wavex_os.referral_sends (user_id, send_type, chat_id, message_text, message_id, dry_run)
  values (p_user_id, p_send_type, p_chat_id, p_message_text, p_message_id, p_dry_run)
  on conflict do nothing;  -- unique index on (user_id, send_type) where dry_run=false
end;
$$;

revoke all on function public.wavex_os_record_referral_send(uuid, text, text, text, text, boolean) from public;
grant execute on function public.wavex_os_record_referral_send(uuid, text, text, text, text, boolean) to service_role;

comment on function public.wavex_os_record_referral_send(uuid, text, text, text, text, boolean) is
  'Records a referral send event. Idempotent for real sends via unique constraint on (user_id, send_type).';

commit;
