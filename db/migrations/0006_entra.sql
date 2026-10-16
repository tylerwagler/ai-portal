-- Microsoft Entra ID as the source of who may use the portal and who administers it.
--
-- Each account remembers its Entra object id (oid). At every Entra sign-in Supabase Auth rewrites
-- the identity's identity_data from the ID token; a trigger here copies the oid and, when the
-- token carries app roles, sets the portal role (Portal.Admin -> admin, else user). portal-api's
-- Entra sync (portal_api/entra_sync.py) does the same from Microsoft Graph between sign-ins and
-- disables accounts Entra no longer lets in. The roles are read from auth.identities, never from
-- user_metadata: users can change their own user_metadata.

alter table public.profiles
  add column entra_oid   uuid unique,
  -- Who disabled the account: the sync re-enables only what it disabled itself.
  add column disabled_by text check (disabled_by in ('admin', 'entra'));

update public.profiles set disabled_by = 'admin' where status = 'disabled';
alter table public.profiles
  add constraint profiles_disabled_by check ((status = 'disabled') = (disabled_by is not null));

create function public.handle_entra_identity() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  claims jsonb := new.identity_data -> 'custom_claims';
  oid    text  := claims ->> 'oid';
  roles  jsonb := claims -> 'roles';
begin
  if new.provider <> 'azure' then
    return new;
  end if;
  update public.profiles p set
    entra_oid  = case when oid ~* '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$' then oid::uuid else p.entra_oid end,
    -- 'pending' is an account held by hand; Entra does not release it.
    role       = case when p.role = 'pending' or jsonb_typeof(roles) is distinct from 'array' then p.role
                      when roles ? 'Portal.Admin' then 'admin'
                      else 'user' end,
    updated_at = now()
  where p.id = new.user_id;
  return new;
end $$;

create trigger on_auth_identity_saved
  after insert or update of identity_data on auth.identities
  for each row execute function public.handle_entra_identity();

-- Accounts that have signed in with Entra before this migration.
update public.profiles p set entra_oid = (i.identity_data -> 'custom_claims' ->> 'oid')::uuid
from auth.identities i
where i.user_id = p.id and i.provider = 'azure'
  and i.identity_data -> 'custom_claims' ->> 'oid' ~* '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$';

-- The last Entra sync, for the admin page. One row.
create table public.entra_sync (
  id            boolean primary key default true check (id),
  ran_at        timestamptz not null,
  ok            boolean not null,
  message       text not null,
  manages_roles boolean not null default false,
  linked        integer not null default 0,
  unlinked      integer not null default 0,
  disabled      integer not null default 0,
  enabled       integer not null default 0,
  role_changes  integer not null default 0
);
alter table public.entra_sync enable row level security;

grant update (disabled_by) on public.profiles to portal_api;
grant select, insert, update on public.entra_sync to portal_api;
