-- Open WebUI's roles follow the accounts (portal_api/entra_sync.py, PORTAL_OPENWEBUI_SCHEMA): admin
-- from the Entra admins group, pending once the account is disabled. Open WebUI keeps its tables in
-- schema openwebui of this database, owned by its own role; portal-api may read who is linked to
-- which account and set the role, nothing else. Open WebUI's migrations alter that table in place,
-- which keeps these grants; re-run this file if it is ever recreated.

do $$
begin
  if exists (select from pg_namespace where nspname = 'openwebui') then
    grant usage on schema openwebui to portal_api;
    grant select (id, email, role, oauth), update (role, updated_at) on openwebui."user" to portal_api;
  end if;
end $$;
