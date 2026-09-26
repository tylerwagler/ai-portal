-- Grants for portal-api's login role. Create the role separately:
--   create role portal_api login password '...';
-- portal-api checks who the caller is (Supabase JWT) and whether they are an admin;
-- these grants limit what it can touch even if that check is wrong.

-- Row-level security is written for Supabase's `authenticated` role (users reading their
-- own rows). portal-api acts for any user, so it bypasses RLS; the grants below still
-- limit which tables and columns it can touch.
alter role portal_api bypassrls;

grant usage on schema public to portal_api;

grant select on public.tiers, public.profiles, public.api_keys,
  public.usage_events, public.usage_rollups, public.subscriptions to portal_api;

-- Keys: create, revoke, rename. Never change owner or hash after creation.
grant insert on public.api_keys to portal_api;
grant update (name, revoked_at) on public.api_keys to portal_api;

-- Admin changes to accounts.
grant update (role, status, tier_id, display_name, timezone, updated_at) on public.profiles to portal_api;

-- Admin changes to plans.
grant insert, update on public.tiers to portal_api;

-- Usage ingest from the gate's stream.
grant insert on public.usage_events to portal_api;
grant usage on sequence public.usage_events_id_seq to portal_api;
grant insert, update on public.usage_rollups to portal_api;
