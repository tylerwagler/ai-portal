"""Entra sync: Microsoft Entra ID decides who may use the portal and who administers it.

Every PORTAL_ENTRA_SYNC_SECONDS it reads the portal's enterprise app (the app registration whose
client id portal-api signs in with) and the tenant's users from Microsoft Graph, then for each
account linked to Entra (profiles.entra_oid, copied at sign-in by migration 0006's trigger):

- disabled or deleted in Entra, or no longer assigned to the app while the app requires
  assignment: the account is disabled (disabled_by 'entra'). Its API keys stop at the gate within
  its 30-second cache, Open WebUI requests with them;
- allowed in again: re-enabled, but only if the sync disabled it, never an admin's own disable;
- once the app defines the Portal.Admin app role: admin with it, user without. Accounts held as
  'pending' are left alone.

Accounts not linked to Entra (none can sign in now; their API keys still work) are counted, not
touched. A run that would remove the last active admin changes nothing.

Graph application permissions: User.Read.All, Application.Read.All, GroupMember.Read.All.
"""

import asyncio
import logging
import time
from dataclasses import dataclass, field

import asyncpg
import httpx

from portal_api.config import Settings

log = logging.getLogger("portal_api.entra")

GRAPH_URL = "https://graph.microsoft.com/v1.0"
LOGIN_URL = "https://login.microsoftonline.com"
ADMIN_ROLE = "Portal.Admin"
# The app role id Entra uses for an assignment without a role ("Default Access").
DEFAULT_ACCESS = "00000000-0000-0000-0000-000000000000"
# Keeps two portal-api processes from syncing at once.
LOCK_ID = 0x656E747261  # "entra"


class SyncRefused(Exception):
    """The directory read back looks wrong; applying it could lock everyone out."""


@dataclass
class Directory:
    assignment_required: bool
    manages_roles: bool
    # Every user in the tenant: oid -> accountEnabled.
    enabled: dict[str, bool]
    # Users assigned to the app, directly or through a group: oid -> app role values.
    assigned: dict[str, set[str]] = field(default_factory=dict)


@dataclass
class Profile:
    id: str
    email: str
    entra_oid: str | None
    role: str
    status: str
    disabled_by: str | None


@dataclass
class Change:
    profile: Profile
    role: str
    status: str
    disabled_by: str | None
    reason: str


class Graph:
    def __init__(self, http: httpx.AsyncClient, settings: Settings,
                 graph_url: str = GRAPH_URL, login_url: str = LOGIN_URL):
        self.http, self.s, self.graph_url, self.login_url = http, settings, graph_url, login_url
        self._token, self._expires = "", 0.0

    async def token(self) -> str:
        if time.time() < self._expires - 60:
            return self._token
        r = await self.http.post(
            f"{self.login_url}/{self.s.entra_tenant_id}/oauth2/v2.0/token",
            data={"grant_type": "client_credentials", "client_id": self.s.entra_client_id,
                  "client_secret": self.s.entra_client_secret,
                  "scope": "https://graph.microsoft.com/.default"})
        if r.status_code != 200:
            raise RuntimeError(f"Entra token request failed: {r.status_code} {r.text[:300]}")
        body = r.json()
        self._token, self._expires = body["access_token"], time.time() + int(body.get("expires_in", 3600))
        return self._token

    async def get(self, url: str) -> dict:
        if not url.startswith("http"):
            url = self.graph_url + url
        r = await self.http.get(url, headers={"Authorization": f"Bearer {await self.token()}"})
        if r.status_code != 200:
            raise RuntimeError(f"Graph {url.split('?')[0]}: {r.status_code} {r.text[:300]}")
        return r.json()

    async def get_all(self, url: str) -> list[dict]:
        items: list[dict] = []
        next_url: str | None = url
        while next_url:
            page = await self.get(next_url)
            items += page.get("value", [])
            next_url = page.get("@odata.nextLink")
        return items

    async def directory(self) -> Directory:
        sp = await self.get(f"/servicePrincipals(appId='{self.s.entra_client_id}')"
                            "?$select=id,appRoleAssignmentRequired,appRoles")
        role_values = {r["id"]: r["value"] for r in sp.get("appRoles", []) if r.get("isEnabled", True)}
        role_values[DEFAULT_ACCESS] = ""
        d = Directory(assignment_required=bool(sp.get("appRoleAssignmentRequired")),
                      manages_roles=ADMIN_ROLE in role_values.values(), enabled={})
        assignments = await self.get_all(f"/servicePrincipals/{sp['id']}/appRoleAssignedTo"
                                         "?$select=principalId,principalType,appRoleId&$top=999")
        for a in assignments:
            value = role_values.get(a["appRoleId"])
            if value is None:  # a disabled or deleted app role grants nothing
                continue
            if a["principalType"] == "User":
                members = [a["principalId"]]
            elif a["principalType"] == "Group":
                members = [u["id"] for u in await self.get_all(
                    f"/groups/{a['principalId']}/transitiveMembers/microsoft.graph.user?$select=id&$top=999")]
            else:
                continue
            for oid in members:
                d.assigned.setdefault(oid.lower(), set()).add(value)
        for u in await self.get_all("/users?$select=id,accountEnabled&$top=999"):
            d.enabled[u["id"].lower()] = bool(u.get("accountEnabled"))
        return d


def plan(profiles: list[Profile], d: Directory) -> list[Change]:
    """What the directory says should change, account by account."""
    if not d.enabled:
        raise SyncRefused("Graph returned no users")
    changes = []
    for p in profiles:
        if p.entra_oid is None:
            continue
        oid = p.entra_oid.lower()
        enabled = d.enabled.get(oid)
        if enabled is None:
            entitled, why = False, "deleted in Entra"
        elif not enabled:
            entitled, why = False, "disabled in Entra"
        elif d.assignment_required and oid not in d.assigned:
            entitled, why = False, "not assigned to the app"
        else:
            entitled, why = True, ""
        role, status, disabled_by, reasons = p.role, p.status, p.disabled_by, []
        if not entitled and p.status == "active":
            status, disabled_by = "disabled", "entra"
            reasons.append(why)
        elif entitled and p.status == "disabled" and p.disabled_by == "entra":
            status, disabled_by = "active", None
            reasons.append("allowed in again")
        if entitled and d.manages_roles and p.role != "pending":
            role = "admin" if ADMIN_ROLE in d.assigned.get(oid, ()) else "user"
            if role != p.role:
                reasons.append(f"{ADMIN_ROLE} {'granted' if role == 'admin' else 'removed'}")
        if (role, status) != (p.role, p.status):
            changes.append(Change(p, role, status, disabled_by, "; ".join(reasons)))
    before = {p.id: (p.role, p.status) for p in profiles}
    after = before | {c.profile.id: (c.role, c.status) for c in changes}
    if ("admin", "active") in before.values() and ("admin", "active") not in after.values():
        raise SyncRefused(f"the sync would leave no active admin; assign someone {ADMIN_ROLE}")
    return changes


async def sync_once(db: asyncpg.Pool, graph: Graph) -> dict:
    """One sync, recorded in public.entra_sync. Returns that record."""
    try:
        d = await graph.directory()
        async with db.acquire() as conn, conn.transaction():
            if not await conn.fetchval("select pg_try_advisory_xact_lock($1)", LOCK_ID):
                return {"ok": True, "message": "another sync is running"}
            rows = await conn.fetch("select id::text, email, entra_oid::text, role, status, disabled_by "
                                    "from public.profiles for update")
            profiles = [Profile(**dict(r)) for r in rows]
            changes = plan(profiles, d)
            for c in changes:
                await conn.execute("update public.profiles set role = $2, status = $3, disabled_by = $4, "
                                   "updated_at = now() where id = $1::uuid",
                                   c.profile.id, c.role, c.status, c.disabled_by)
                log.info("entra sync: %s %s/%s -> %s/%s (%s)", c.profile.email, c.profile.role,
                         c.profile.status, c.role, c.status, c.reason)
            linked = sum(p.entra_oid is not None for p in profiles)
            result = dict(
                ok=True, manages_roles=d.manages_roles, linked=linked, unlinked=len(profiles) - linked,
                disabled=sum(c.status == "disabled" and c.profile.status == "active" for c in changes),
                enabled=sum(c.status == "active" and c.profile.status == "disabled" for c in changes),
                role_changes=sum(c.role != c.profile.role for c in changes),
                message="assignment required" if d.assignment_required
                        else "assignment not required: everyone in the tenant may sign in")
            await record(conn, result)
    except (SyncRefused, RuntimeError, httpx.HTTPError) as e:
        log.error("entra sync refused or failed: %s", e)
        result = dict(ok=False, message=str(e))
        async with db.acquire() as conn:
            await record(conn, result)
    return result


async def record(conn: asyncpg.Connection, result: dict) -> None:
    columns = ["ran_at", *result]
    await conn.execute(
        f"insert into public.entra_sync ({', '.join(columns)}) "
        f"values (now(), {', '.join(f'${i}' for i in range(1, len(result) + 1))}) "
        f"on conflict (id) do update set {', '.join(f'{c} = excluded.{c}' for c in columns)}",
        *result.values())


async def run(db: asyncpg.Pool, graph: Graph, every: int) -> None:
    log.info("entra sync every %d s", every)
    while True:
        try:
            await sync_once(db, graph)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("entra sync crashed; retrying next round")
        await asyncio.sleep(every)
