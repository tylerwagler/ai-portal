# Microsoft Entra ID: access and roles

Entra decides who may use the portal and who administers it; the portal keeps plans, quotas and
API keys. Two pieces do it:

- **At sign-in** (migration `0006_entra.sql`): a trigger on `auth.identities` copies the person's
  Entra object id to `profiles.entra_oid` and, when the ID token carries app roles, sets
  `profiles.role` (`Portal.Admin` → admin, any other role → user).
- **Between sign-ins** (`api/portal_api/entra_sync.py`, every 15 min and on *Sync now* in Admin):
  reads the app's assignments and the tenant's users from Microsoft Graph. Accounts disabled,
  deleted, or (with assignment required) unassigned in Entra are disabled here, which stops their
  API keys at the gate within 30 s; they are re-enabled when Entra lets them back in. Once the app
  defines `Portal.Admin`, admin follows it. An admin's own disable is never undone, `pending`
  accounts are left alone, and a run that would remove the last active admin changes nothing.

Tenant `590a429c-bbba-49f1-b2dd-7822998989ae`, app registration **AI Portal**
(`cea584d7-6509-4f58-819f-d83183cfa54e`). GitLab signs in with the same app, so assignment
settings apply to GitLab too.

## Setup, in this order

1. **App roles.** App registrations → AI Portal → App roles → create two, allowed member types
   *Users/Groups*: `Portal.Admin` ("Portal administrator") and `Portal.User` ("Portal user").
2. **Assign people.** Enterprise applications → AI Portal → Users and groups: give the portal's
   admins `Portal.Admin` first, then everyone else (or a group, which needs Entra ID P1)
   `Portal.User`. Include GitLab users.
3. **Graph access.** App registrations → AI Portal → API permissions → Microsoft Graph →
   *Application* permissions `User.Read.All`, `Application.Read.All`, `GroupMember.Read.All` →
   *Grant admin consent*. Certificates & secrets → a new client secret just for portal-api
   (rotating Supabase's then doesn't touch it).
4. **Database.** Apply `db/migrations/0006_entra.sql` on CT 125 as `supabase_admin`. It backfills
   `entra_oid` for everyone who has signed in with Entra.
5. **portal-api.** Set `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET` in
   `deploy/.env` on CT 126 and redeploy. Admin → Microsoft Entra ID shows each sync: check it ran,
   and look at the **not linked** accounts in the Users table: they predate Entra sign-in, the
   sync cannot see them, and their API keys still work; disable those that should go.
6. **Require assignment** (Enterprise applications → AI Portal → Properties → *Assignment
   required* = Yes) once everyone who should stay is assigned. From then on, unassigning someone
   in Entra disables them here at the next sync; *Sync now* applies it at once.

From step 5, admins without `Portal.Admin` become users (the last active admin excepted), and
signing in with app roles in the token does the same: hence `Portal.Admin` before anything else.

## Rolling back

Unset `ENTRA_CLIENT_SECRET` and redeploy: the sync stops, nothing else changes. The sign-in
trigger only acts on app roles in the token; delete the app roles in Entra to stop it too, or
`drop trigger on_auth_identity_saved on auth.identities`.
