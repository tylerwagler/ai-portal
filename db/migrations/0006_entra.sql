-- Microsoft Entra ID is the single source of truth for who may use the portal, who administers it
-- and which plan they are on. Entra security groups decide (portal-api's sync, entra_sync.py):
--
--   AI Users              may use the AI services; members get a portal account before they first
--                         sign in, and lose it (disabled, keys stop) when removed or disabled in Entra
--   AI Admins             role admin (portal and Open WebUI); everyone else in AI Users is a user
--   AI Plan - <name>      the plan (tier); AI Users in no plan group get the default plan
--
-- The portal keeps what is product configuration, not identity: the plans themselves (limits,
-- prices). Local accounts (service accounts such as the Teams bots' gate keys) are not in Entra and
-- stay under the admin tab.

alter table public.profiles
  add column entra_oid   uuid unique,
  -- Who disabled the account: the sync re-enables only what it disabled itself.
  add column disabled_by text check (disabled_by in ('admin', 'entra')),
  -- Not an Entra user: managed in the portal (service accounts).
  add column local       boolean not null default false;

update public.profiles set disabled_by = 'admin' where status = 'disabled';
alter table public.profiles
  add constraint profiles_disabled_by check ((status = 'disabled') = (disabled_by is not null));

update public.profiles set local = true
where email in ('ferret-bot@elytrondefense.ai', 'merlin-bot@elytrondefense.ai');

-- At every Entra sign-in Supabase Auth rewrites the identity's identity_data from the ID token; the
-- object id (custom_claims.oid) links the account to its Entra user. Read from auth.identities,
-- which only Auth writes (users can edit their own user_metadata).
create function public.handle_entra_identity() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  oid text := new.identity_data -> 'custom_claims' ->> 'oid';
begin
  if new.provider = 'azure' and oid ~* '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$' then
    update public.profiles set entra_oid = oid::uuid, updated_at = now()
    where id = new.user_id and entra_oid is distinct from oid::uuid;
  end if;
  return new;
end $$;

create trigger on_auth_identity_saved
  after insert or update of identity_data on auth.identities
  for each row execute function public.handle_entra_identity();

update public.profiles p set entra_oid = (i.identity_data -> 'custom_claims' ->> 'oid')::uuid
from auth.identities i
where i.user_id = p.id and i.provider = 'azure'
  and i.identity_data -> 'custom_claims' ->> 'oid' ~* '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$';

-- An account for an Entra user who has not signed in yet. Auth links their Entra identity to it by
-- email at their first sign-in (the email is marked confirmed, as Auth requires for linking).
-- portal-api may call this and nothing else in the auth schema.
create function public.entra_provision(p_email text, p_name text, p_oid uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid;
begin
  select id into uid from auth.users where lower(email) = lower(p_email);
  if uid is null then
    insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data,
                            raw_user_meta_data, created_at, updated_at)
    values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            lower(p_email), now(), '{"provider": "azure", "providers": ["azure"]}',
            jsonb_build_object('name', p_name), now(), now())
    returning id into uid;
  end if;
  update public.profiles set entra_oid = p_oid, display_name = coalesce(nullif(p_name, ''), display_name),
         updated_at = now()
  where id = uid and entra_oid is distinct from p_oid;
  return uid;
end $$;

revoke all on function public.entra_provision(text, text, uuid) from public;
grant execute on function public.entra_provision(text, text, uuid) to portal_api;

-- The last Entra sync, for the admin tab. One row.
create table public.entra_sync (
  id           boolean primary key default true check (id),
  ran_at       timestamptz not null,
  ok           boolean not null,
  message      text not null,
  members      integer not null default 0,
  created      integer not null default 0,
  disabled     integer not null default 0,
  enabled      integer not null default 0,
  changed      integer not null default 0
);
alter table public.entra_sync enable row level security;

-- The sync links an account to its Entra user by email before their first sign-in (entra_oid).
grant update (disabled_by, entra_oid) on public.profiles to portal_api;
grant select, insert, update on public.entra_sync to portal_api;
