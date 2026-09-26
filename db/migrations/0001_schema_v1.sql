-- AI Portal schema v1: tiers, profiles, API keys, usage, billing, and the gate's lookup functions.
-- Runs as supabase_admin (or postgres) against the Supabase database.

-- ---------------------------------------------------------------------------
-- Tiers. A NULL limit means unlimited.
-- ---------------------------------------------------------------------------
create table public.tiers (
  id                  text primary key,
  display_name        text not null,
  description         text,
  price_monthly_cents integer not null default 0,
  stripe_price_id     text unique,
  rate_limit_rpm      integer,
  rate_limit_tpm      bigint,
  hourly_limit        bigint,
  daily_limit         bigint,
  weekly_limit        bigint,
  monthly_limit       bigint,
  created_at          timestamptz not null default now()
);

insert into public.tiers (id, display_name, description, rate_limit_rpm, rate_limit_tpm, daily_limit)
values ('free', 'Free', 'Try it out', 10, 20000, 200000);

-- ---------------------------------------------------------------------------
-- Profiles: one per auth user, created by trigger. New users start pending.
-- ---------------------------------------------------------------------------
create table public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  email        text not null,
  display_name text,
  timezone     text,
  role         text not null default 'pending' check (role in ('pending', 'user', 'admin')),
  status       text not null default 'active' check (status in ('active', 'disabled')),
  tier_id      text not null default 'free' references public.tiers (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index profiles_email_lower on public.profiles (lower(email));

create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1)));
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin' and status = 'active');
$$;

-- ---------------------------------------------------------------------------
-- API keys. Only a SHA-256 hash of the key is stored; the key is shown once at creation.
-- ---------------------------------------------------------------------------
create table public.api_keys (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles (id) on delete cascade,
  name              text not null,
  key_hash          text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  prefix            text not null,
  last4             text not null,
  -- A forwarder (Open WebUI) may act for the user named in its X-OpenWebUI-User-Email header.
  trusted_forwarder boolean not null default false,
  created_at        timestamptz not null default now(),
  last_used_at      timestamptz,
  revoked_at        timestamptz
);
create index api_keys_user on public.api_keys (user_id);

-- ---------------------------------------------------------------------------
-- Usage: raw events from the gate (via the Valkey stream), plus hourly rollups.
-- ---------------------------------------------------------------------------
create table public.usage_events (
  id                    bigint generated always as identity primary key,
  stream_id             text not null unique,  -- Valkey stream entry id; makes ingest idempotent
  ts                    timestamptz not null,
  user_id               uuid not null references public.profiles (id) on delete cascade,
  api_key_id            uuid references public.api_keys (id) on delete set null,
  via                   text not null check (via in ('key', 'openwebui')),
  model                 text not null,
  input_tokens          bigint not null default 0,
  output_tokens         bigint not null default 0,
  cached_tokens         bigint not null default 0,
  cache_creation_tokens bigint not null default 0,
  reasoning_tokens      bigint not null default 0,
  latency_ms            integer,
  complete              boolean not null,
  estimated             boolean not null,
  chat_id               text
);
create index usage_events_user_ts on public.usage_events (user_id, ts desc);

create table public.usage_rollups (
  hour          timestamptz not null,
  user_id       uuid not null references public.profiles (id) on delete cascade,
  api_key_id    uuid references public.api_keys (id) on delete set null,
  model         text not null,
  requests      bigint not null default 0,
  input_tokens  bigint not null default 0,
  output_tokens bigint not null default 0,
  cached_tokens bigint not null default 0,
  unique nulls not distinct (hour, user_id, api_key_id, model)
);

-- ---------------------------------------------------------------------------
-- Billing: mirrored from Stripe webhooks by portal-api. Never written by clients.
-- ---------------------------------------------------------------------------
create table public.billing_customers (
  user_id            uuid primary key references public.profiles (id) on delete cascade,
  stripe_customer_id text not null unique
);

create table public.subscriptions (
  id                   text primary key,  -- Stripe subscription id
  user_id              uuid not null references public.profiles (id) on delete cascade,
  tier_id              text not null references public.tiers (id),
  status               text not null,
  current_period_end   timestamptz,
  cancel_at_period_end boolean not null default false,
  updated_at           timestamptz not null default now()
);
create index subscriptions_user on public.subscriptions (user_id);

-- ---------------------------------------------------------------------------
-- Row-level security. Users read their own rows; admins read everything.
-- Writes to keys, usage, billing and roles go through portal-api (service role).
-- ---------------------------------------------------------------------------
alter table public.tiers             enable row level security;
alter table public.profiles          enable row level security;
alter table public.api_keys          enable row level security;
alter table public.usage_events      enable row level security;
alter table public.usage_rollups     enable row level security;
alter table public.billing_customers enable row level security;
alter table public.subscriptions     enable row level security;

create policy tiers_read on public.tiers for select to anon, authenticated using (true);
create policy profiles_read on public.profiles for select to authenticated using (id = auth.uid() or public.is_admin());
create policy profiles_update_own on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
create policy keys_read on public.api_keys for select to authenticated using (user_id = auth.uid() or public.is_admin());
create policy usage_read on public.usage_events for select to authenticated using (user_id = auth.uid() or public.is_admin());
create policy rollups_read on public.usage_rollups for select to authenticated using (user_id = auth.uid() or public.is_admin());
create policy subscriptions_read on public.subscriptions for select to authenticated using (user_id = auth.uid() or public.is_admin());

-- Users may edit only their display fields, never role, tier or status.
revoke update on public.profiles from authenticated;
grant update (display_name, timezone) on public.profiles to authenticated;
revoke insert, update, delete on public.api_keys, public.usage_events, public.usage_rollups,
  public.billing_customers, public.subscriptions, public.tiers from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Gate (Switchyard) contract: a login role that can only call these two functions.
-- Create the role separately:  create role switchyard_gate login password '...';
-- ---------------------------------------------------------------------------
create schema gate;

create type gate.identity as (
  key_id            uuid,
  user_id           uuid,
  role              text,
  status            text,
  trusted_forwarder boolean,
  tier_id           text,
  rate_limit_rpm    integer,
  rate_limit_tpm    bigint,
  hourly_limit      bigint,
  daily_limit       bigint,
  weekly_limit      bigint,
  monthly_limit     bigint
);

-- Active key by SHA-256 hex hash, with its owner's role, status and tier limits.
create function gate.lookup_key(p_key_hash text) returns setof gate.identity
language sql stable security definer set search_path = '' as $$
  select k.id, p.id, p.role, p.status, k.trusted_forwarder, t.id,
         t.rate_limit_rpm, t.rate_limit_tpm, t.hourly_limit, t.daily_limit, t.weekly_limit, t.monthly_limit
  from public.api_keys k
  join public.profiles p on p.id = k.user_id
  join public.tiers t on t.id = p.tier_id
  where k.key_hash = p_key_hash and k.revoked_at is null;
$$;

-- User named by a trusted forwarder (Open WebUI), by email.
create function gate.lookup_user_by_email(p_email text) returns setof gate.identity
language sql stable security definer set search_path = '' as $$
  select null::uuid, p.id, p.role, p.status, false, t.id,
         t.rate_limit_rpm, t.rate_limit_tpm, t.hourly_limit, t.daily_limit, t.weekly_limit, t.monthly_limit
  from public.profiles p
  join public.tiers t on t.id = p.tier_id
  where lower(p.email) = lower(p_email);
$$;

revoke all on schema gate from public;
revoke all on all functions in schema gate from public;
