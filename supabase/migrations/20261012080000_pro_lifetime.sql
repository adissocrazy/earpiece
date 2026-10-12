-- Earpiece Pro Lifetime: one payment, Pro with no end date. `lifetime_payment_id` is the payment a
-- refund or lost dispute is matched against. The webhook never lets subscription events touch a
-- lifetime row, so cancelling an old monthly plan can't end it.
alter table public.subscriptions add column if not exists lifetime boolean not null default false;
alter table public.subscriptions add column if not exists lifetime_payment_id text;

-- What the app shows under General → Account, now with `lifetime`.
create or replace function public.my_plan()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'plan', case when public.is_pro(auth.uid()) then 'pro' else 'free' end,
    'lifetime', coalesce((select lifetime from public.subscriptions where user_id = auth.uid()), false),
    'period_end', (select current_period_end from public.subscriptions where user_id = auth.uid()),
    'lines_used', coalesce((select lines from public.usage where user_id = auth.uid() and month = date_trunc('month', now() at time zone 'utc')::date), 0),
    'lines_cap', 3000
  );
$$;
revoke execute on function public.my_plan() from public, anon;
grant execute on function public.my_plan() to authenticated;

-- Bought on earpiece.dev before ever signing in: there's no account to attach the plan to yet, so
-- the webhook keeps it here by the email paid with, and the first sign-in with that email claims it.
create table if not exists public.pending_subscriptions (
  email                    text primary key,   -- lower-case
  plan                     text not null default 'free' check (plan in ('free', 'pro')),
  status                   text not null default 'active' check (status in ('active', 'trialing', 'past_due', 'canceled')),
  provider                 text,
  provider_customer_id     text,
  provider_subscription_id text,
  current_period_end       timestamptz,
  event_at                 timestamptz,
  lifetime                 boolean not null default false,
  lifetime_payment_id      text,
  updated_at               timestamptz not null default now()
);
alter table public.pending_subscriptions enable row level security;
revoke all on public.pending_subscriptions from anon, authenticated;
grant select, insert, update, delete on public.pending_subscriptions to service_role;

create or replace function public.claim_pending_subscription()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare p public.pending_subscriptions;
begin
  select * into p from public.pending_subscriptions where email = lower(new.email);
  if not found then return new; end if;
  insert into public.subscriptions as s (user_id, plan, status, provider, provider_customer_id, provider_subscription_id,
                                         current_period_end, event_at, lifetime, lifetime_payment_id, updated_at)
  values (new.id, p.plan, p.status, p.provider, p.provider_customer_id, p.provider_subscription_id,
          p.current_period_end, p.event_at, p.lifetime, p.lifetime_payment_id, now())
  on conflict (user_id) do nothing;
  delete from public.pending_subscriptions where email = p.email;
  return new;
exception when others then
  -- Never block a sign-up over this: the pending row stays and can be moved by hand.
  raise warning 'claim_pending_subscription: %', sqlerrm;
  return new;
end;
$$;
revoke execute on function public.claim_pending_subscription() from public, anon, authenticated;

drop trigger if exists claim_pending_subscription on auth.users;
create trigger claim_pending_subscription after insert on auth.users
  for each row execute function public.claim_pending_subscription();
