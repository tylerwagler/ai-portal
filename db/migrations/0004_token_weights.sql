-- Weighted ("billable") tokens: cached prefix reads cost less, as with hosted LLM providers.
-- Quotas and usage totals count billable tokens; raw counts are kept alongside.
-- Each event stores the billable figure computed with the weights in force at the time,
-- so changing weights later never rewrites history.

create table public.token_weights (
  id          boolean primary key default true check (id),  -- a single row
  input       double precision not null default 1.0,  -- uncached prompt tokens
  cache_read  double precision not null default 0.1,  -- prompt tokens served from the prefix cache
  cache_write double precision not null default 1.0,  -- prompt tokens written to the prefix cache
  output      double precision not null default 1.0,
  reasoning   double precision not null default 1.0,
  updated_at  timestamptz not null default now()
);
insert into public.token_weights default values;

alter table public.token_weights enable row level security;
create policy token_weights_read on public.token_weights for select to anon, authenticated using (true);
revoke insert, update, delete on public.token_weights from anon, authenticated;

alter table public.usage_events add column billable_tokens bigint not null default 0;
alter table public.usage_rollups
  add column cache_creation_tokens bigint not null default 0,
  add column reasoning_tokens      bigint not null default 0,
  add column billable_tokens       bigint not null default 0;

-- Backfill what was recorded before weights existed.
update public.usage_events e set billable_tokens = round(
    e.input_tokens * w.input + e.cached_tokens * w.cache_read + e.cache_creation_tokens * w.cache_write
  + e.output_tokens * w.output + e.reasoning_tokens * w.reasoning)
from public.token_weights w;
update public.usage_rollups r set
  cache_creation_tokens = s.cache_creation_tokens,
  reasoning_tokens = s.reasoning_tokens,
  billable_tokens = s.billable_tokens
from (
  select date_trunc('hour', ts) as hour, user_id, api_key_id, model,
         sum(cache_creation_tokens) as cache_creation_tokens, sum(reasoning_tokens) as reasoning_tokens,
         sum(billable_tokens) as billable_tokens
  from public.usage_events group by 1, 2, 3, 4
) s
where r.hour = s.hour and r.user_id = s.user_id and r.model = s.model
  and r.api_key_id is not distinct from s.api_key_id;

-- The gate's lookups now also return the weights. Changing the returned type means
-- recreating the functions, which drops their grants; they are granted again below.
drop function gate.lookup_key(text);
drop function gate.lookup_user_by_email(text);
drop type gate.identity;

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
  monthly_limit     bigint,
  w_input           double precision,
  w_cache_read      double precision,
  w_cache_write     double precision,
  w_output          double precision,
  w_reasoning       double precision
);

create function gate.lookup_key(p_key_hash text) returns setof gate.identity
language sql stable security definer set search_path = '' as $$
  select k.id, p.id, p.role, p.status, k.trusted_forwarder, t.id,
         t.rate_limit_rpm, t.rate_limit_tpm, t.hourly_limit, t.daily_limit, t.weekly_limit, t.monthly_limit,
         w.input, w.cache_read, w.cache_write, w.output, w.reasoning
  from public.api_keys k
  join public.profiles p on p.id = k.user_id
  join public.tiers t on t.id = p.tier_id
  cross join public.token_weights w
  where k.key_hash = p_key_hash and k.revoked_at is null;
$$;

create function gate.lookup_user_by_email(p_email text) returns setof gate.identity
language sql stable security definer set search_path = '' as $$
  select null::uuid, p.id, p.role, p.status, false, t.id,
         t.rate_limit_rpm, t.rate_limit_tpm, t.hourly_limit, t.daily_limit, t.weekly_limit, t.monthly_limit,
         w.input, w.cache_read, w.cache_write, w.output, w.reasoning
  from public.profiles p
  join public.tiers t on t.id = p.tier_id
  cross join public.token_weights w
  where lower(p.email) = lower(p_email);
$$;

revoke all on all functions in schema gate from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'switchyard_gate') then
    grant execute on function gate.lookup_key(text), gate.lookup_user_by_email(text) to switchyard_gate;
  end if;
  if exists (select 1 from pg_roles where rolname = 'portal_api') then
    grant select, update on public.token_weights to portal_api;
  end if;
end $$;
