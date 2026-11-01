-- Remote agents (Pro). The relay Edge Function is the only writer (service role).
-- RLS is on and anon/authenticated have no grants, so a logged-in user cannot read another
-- user's mailbox through the Data API. Hashes are sha256 hex text rather than bytea: same
-- one-way storage, and the function can look a token up without a bytea codec.

create table public.remote_devices (
  id text primary key,
  user_id uuid not null references auth.users on delete cascade,
  name text not null,
  platform text not null,
  app_version text,
  ack_cursor bigint not null default 0,
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.remote_agents (
  id text primary key,
  user_id uuid not null references auth.users on delete cascade,
  kind text not null check (kind in ('grokbot', 'dots', 'openclaw', 'hermes', 'custom')),
  name text not null,
  instance text,
  hub_id text not null,
  scopes text[] not null,
  status text not null default 'active' check (status in ('active', 'revoked')),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  unique (user_id, hub_id)
);

create table public.remote_tokens (
  token_hash text primary key,
  agent_id text not null references public.remote_agents on delete cascade,
  prefix text not null,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.remote_pairings (
  id text primary key,
  user_id uuid not null references auth.users on delete cascade,
  device_id text,
  code_hash text unique,
  failures int not null default 0,
  expires_at timestamptz not null,
  claim_id text unique,
  claim_secret_hash text,
  claim jsonb,
  agent_id text,
  status text not null default 'open' check (status in ('open', 'claimed', 'approved', 'denied', 'expired'))
);

-- One ordered mailbox per user. Event rows also live in remote_events (idempotency).
-- Control frames (pairing, question_closed, plan check) have no agent, so they cannot be
-- rows of remote_events, whose agent_id is required.
create table public.remote_frames (
  cursor bigserial primary key,
  user_id uuid not null,
  frame jsonb not null,
  received_at timestamptz not null default now()
);
create index remote_frames_user_cursor on public.remote_frames (user_id, cursor);

create table public.remote_events (
  cursor bigserial primary key,
  user_id uuid not null,
  agent_id text not null references public.remote_agents on delete cascade,
  event_id text not null unique,
  idempotency_key text not null,
  body_hash text not null,
  frame jsonb not null,
  frame_cursor bigint,
  received_at timestamptz not null default now(),
  unique (agent_id, idempotency_key)
);
create index remote_events_user_cursor on public.remote_events (user_id, cursor);

create table public.remote_questions (
  id text primary key,
  user_id uuid not null,
  agent_id text not null references public.remote_agents on delete cascade,
  session_id text not null,
  agent_question_id text,
  options jsonb not null,
  allow_text boolean not null,
  prompt text not null default '',
  status text not null default 'open' check (status in ('open', 'answered', 'superseded', 'expired', 'revoked')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index remote_questions_open on public.remote_questions (user_id) where status = 'open';

create table public.remote_replies (
  id text primary key,
  cursor bigserial,
  agent_id text not null references public.remote_agents on delete cascade,
  question_id text references public.remote_questions on delete cascade,
  client_reply_id text unique,
  reply jsonb not null,
  created_at timestamptz not null default now(),
  acked_at timestamptz
);
create index remote_replies_pending on public.remote_replies (agent_id, cursor) where acked_at is null;

-- Registered in the schema for v2. The relay does not deliver webhooks in this release.
create table public.remote_webhooks (
  id text primary key,
  agent_id text not null unique references public.remote_agents on delete cascade,
  url text not null,
  secret_enc text not null,
  created_at timestamptz not null default now()
);

create table public.remote_rate (
  bucket text primary key,
  n int not null default 0,
  window_start timestamptz not null default now()
);

create table public.remote_usage (
  user_id uuid not null,
  day date not null,
  events int not null default 0,
  questions int not null default 0,
  replies int not null default 0,
  http_402 int not null default 0,
  http_429 int not null default 0,
  primary key (user_id, day)
);

alter table public.remote_devices enable row level security;
alter table public.remote_agents enable row level security;
alter table public.remote_tokens enable row level security;
alter table public.remote_pairings enable row level security;
alter table public.remote_frames enable row level security;
alter table public.remote_events enable row level security;
alter table public.remote_questions enable row level security;
alter table public.remote_replies enable row level security;
alter table public.remote_webhooks enable row level security;
alter table public.remote_rate enable row level security;
alter table public.remote_usage enable row level security;

revoke all on public.remote_devices from anon, authenticated;
revoke all on public.remote_agents from anon, authenticated;
revoke all on public.remote_tokens from anon, authenticated;
revoke all on public.remote_pairings from anon, authenticated;
revoke all on public.remote_frames from anon, authenticated;
revoke all on public.remote_events from anon, authenticated;
revoke all on public.remote_questions from anon, authenticated;
revoke all on public.remote_replies from anon, authenticated;
revoke all on public.remote_webhooks from anon, authenticated;
revoke all on public.remote_rate from anon, authenticated;
revoke all on public.remote_usage from anon, authenticated;

-- Fixed window. Returns the count inside the window after this hit.
create or replace function public.remote_rate_hit(p_bucket text, p_window_s int)
returns int
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  got int;
begin
  insert into public.remote_rate as r (bucket, n, window_start)
  values (p_bucket, 1, now())
  on conflict (bucket) do update set
    n = case when r.window_start < now() - make_interval(secs => p_window_s) then 1 else r.n + 1 end,
    window_start = case when r.window_start < now() - make_interval(secs => p_window_s) then now() else r.window_start end
  returning n into got;
  return got;
end;
$$;
revoke all on function public.remote_rate_hit(text, int) from public, anon, authenticated;

create or replace function public.remote_purge()
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  q record;
begin
  for q in
    update public.remote_questions
    set status = 'expired'
    where status = 'open' and expires_at < now()
    returning id, agent_id, user_id, agent_question_id, session_id
  loop
    insert into public.remote_replies (id, agent_id, question_id, reply)
    values (
      'rpl_purge_' || q.id,
      q.agent_id,
      q.id,
      jsonb_build_object(
        'reply_id', 'rpl_purge_' || q.id,
        'type', 'expired',
        'question_id', q.id,
        'agent_question_id', q.agent_question_id,
        'session_id', q.session_id,
        'choice', null,
        'text', null
      )
    )
    on conflict (id) do nothing;
    insert into public.remote_frames (user_id, frame)
    values (q.user_id, jsonb_build_object('frame', 'question_closed', 'question_id', q.id, 'reason', 'expired'));
  end loop;

  delete from public.remote_frames f
  where f.received_at < now() - interval '24 hours'
     or (
       exists (select 1 from public.remote_devices d where d.user_id = f.user_id)
       and f.cursor <= (select min(d.ack_cursor) from public.remote_devices d where d.user_id = f.user_id)
     );

  delete from public.remote_events e
  where e.received_at < now() - interval '24 hours'
     or (
       e.frame_cursor is not null
       and exists (select 1 from public.remote_devices d where d.user_id = e.user_id)
       and e.frame_cursor <= (select min(d.ack_cursor) from public.remote_devices d where d.user_id = e.user_id)
     );

  delete from public.remote_replies r
  where r.acked_at is not null or r.created_at < now() - interval '24 hours';

  delete from public.remote_pairings p where p.expires_at < now();

  delete from public.remote_agents a
  where a.status = 'revoked' and a.revoked_at is not null and a.revoked_at < now() - interval '30 days';

  delete from public.remote_rate where window_start < now() - interval '2 days';
end;
$$;
revoke all on function public.remote_purge() from public, anon, authenticated;

-- Every 10 minutes when pg_cron is installed. Without it, schedule the function yourself.
do $$
begin
  perform cron.unschedule('remote-purge');
exception when others then
  null;
end $$;

do $$
begin
  perform cron.schedule('remote-purge', '*/10 * * * *', 'select public.remote_purge()');
exception when others then
  raise notice 'pg_cron is not available; call public.remote_purge() every 10 minutes';
end $$;
