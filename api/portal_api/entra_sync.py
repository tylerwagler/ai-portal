"""Entra sync: Microsoft Entra ID groups decide who has a portal account, its role and its plan.

Every PORTAL_ENTRA_SYNC_SECONDS (and on "Sync now" in Admin) it reads, from Microsoft Graph:

- the users group (AI Users): members, with nested groups, that are enabled in Entra;
- the admins group (AI Admins);
- the plan groups (PORTAL_ENTRA_PLAN_GROUPS, "group id=tier id", first match wins).

Then for every account:

- a member without an account gets one (public.entra_provision), active, before their first
  sign-in; Supabase Auth links their Entra identity to it by email when they do sign in;
- a member's role is admin if they are in the admins group, else user; their plan is their plan
  group's tier, else PORTAL_ENTRA_DEFAULT_TIER;
- an account whose Entra user left the users group, was disabled or deleted is disabled
  (disabled_by 'entra'): its API keys stop at the gate within its 30-second cache;
- an account the sync disabled is re-enabled when its user is back; an admin's own disable stays.

Local accounts (service accounts, profiles.local) are not touched. An account matches its Entra
user by object id, else (before their first sign-in) by email. A run that would leave no active
admin, or that reads an empty users group, changes nothing.

With PORTAL_OPENWEBUI_SCHEMA set it then sets Open WebUI's roles from the accounts, in the same
transaction: a user linked to an account (their OIDC sub is the account id) is admin if the account
is an active admin, user if it is active, and pending (locked out, sessions included) if it is
disabled. A user linked to no account may not be admin, and becomes user. Open WebUI reads the role
from its database on every request; its own role management (OAuth roles claim) stays off.

Graph application permissions (the AI Portal app): GroupMember.Read.All, User.Read.All.
"""

import asyncio
import logging
import re
import time
from dataclasses import dataclass, field

import asyncpg
import httpx

from portal_api.config import Settings

log = logging.getLogger("portal_api.entra")

GRAPH_URL = "https://graph.microsoft.com/v1.0"
LOGIN_URL = "https://login.microsoftonline.com"
LOCK_ID = 0x656E747261  # "entra": one sync at a time across portal-api processes


class SyncRefused(Exception):
    """What Graph returned looks wrong; applying it could lock everyone out."""


@dataclass
class Person:
    oid: str
    email: str
    name: str


@dataclass
class Directory:
    members: dict[str, Person]          # oid -> enabled member of the users group
    admins: set[str] = field(default_factory=set)
    plans: dict[str, str] = field(default_factory=dict)   # oid -> tier id


@dataclass
class Account:
    id: str
    email: str
    entra_oid: str | None
    role: str
    status: str
    disabled_by: str | None
    tier_id: str
    local: bool


@dataclass
class Change:
    account: Account
    role: str
    status: str
    disabled_by: str | None
    tier_id: str
    entra_oid: str | None
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
                  "client_secret": self.s.entra_client_secret, "scope": "https://graph.microsoft.com/.default"})
        if r.status_code != 200:
            raise RuntimeError(f"Entra token request failed: {r.status_code} {r.text[:300]}")
        body = r.json()
        self._token, self._expires = body["access_token"], time.time() + int(body.get("expires_in", 3600))
        return self._token

    async def get_all(self, url: str) -> list[dict]:
        items: list[dict] = []
        next_url: str | None = url if url.startswith("http") else self.graph_url + url
        while next_url:
            r = await self.http.get(next_url, headers={"Authorization": f"Bearer {await self.token()}"}, timeout=60)
            if r.status_code != 200:
                raise RuntimeError(f"Graph {next_url.split('?')[0]}: {r.status_code} {r.text[:300]}")
            page = r.json()
            items += page.get("value", [])
            next_url = page.get("@odata.nextLink")
        return items

    async def users_of(self, group: str) -> list[dict]:
        return await self.get_all(f"/groups/{group}/transitiveMembers/microsoft.graph.user"
                                  "?$select=id,mail,userPrincipalName,displayName,accountEnabled&$top=999")

    async def directory(self) -> Directory:
        s = self.s
        members = {}
        for u in await self.users_of(s.entra_users_group):
            if u.get("accountEnabled"):
                oid = u["id"].lower()
                members[oid] = Person(oid, (u.get("mail") or u["userPrincipalName"]).lower(), u.get("displayName") or "")
        d = Directory(members)
        if s.entra_admins_group:
            d.admins = {u["id"].lower() for u in await self.users_of(s.entra_admins_group)}
        for group, tier in reversed(s.entra_plan_groups):  # first listed wins: apply it last
            for u in await self.users_of(group):
                d.plans[u["id"].lower()] = tier
        return d


@dataclass
class WebUser:
    id: str
    email: str
    role: str
    sub: str | None     # the portal account id, for users who signed in through it


def openwebui_plan(users: list[WebUser], accounts: dict[str, Account]) -> list[tuple[WebUser, str]]:
    """(Open WebUI user, the role it should have) for every role to change."""
    changes = []
    for u in users:
        a = accounts.get(u.sub or "")
        if a is not None and not a.local:
            role = "pending" if a.status != "active" else "admin" if a.role == "admin" else "user"
        elif u.role == "admin":
            role = "user"
        else:
            continue
        if role != u.role:
            changes.append((u, role))
    wanted = {u.id: u.role for u in users} | {u.id: role for u, role in changes}
    if users and "admin" not in wanted.values():
        raise SyncRefused("the sync would leave Open WebUI without an admin; check the admins group")
    return changes


def plan(accounts: list[Account], d: Directory, default_tier: str) -> tuple[list[Change], list[Person]]:
    """(changes to existing accounts, members who need an account)."""
    if not d.members:
        raise SyncRefused("the users group has no enabled members")
    by_email = {p.email: p for p in d.members.values()}
    matched: set[str] = set()
    changes = []
    for a in accounts:
        if a.local:
            continue
        person = d.members.get((a.entra_oid or "").lower()) or (None if a.entra_oid else by_email.get(a.email.lower()))
        role, status, disabled_by, tier, oid, why = a.role, a.status, a.disabled_by, a.tier_id, a.entra_oid, []
        if person is None:
            if a.status == "active":
                status, disabled_by = "disabled", "entra"
                why.append("not an enabled member of the users group")
        else:
            matched.add(person.oid)
            oid = person.oid
            role = "admin" if person.oid in d.admins else "user"
            tier = d.plans.get(person.oid, default_tier)
            if a.status == "disabled" and a.disabled_by == "entra":
                status, disabled_by = "active", None
                why.append("back in the users group")
            if role != a.role:
                why.append(f"role {a.role} -> {role}")
            if tier != a.tier_id:
                why.append(f"plan {a.tier_id} -> {tier}")
        if (role, status, tier, oid) != (a.role, a.status, a.tier_id, a.entra_oid):
            changes.append(Change(a, role, status, disabled_by, tier, oid, "; ".join(why) or "linked to Entra"))
    missing = [p for oid, p in d.members.items() if oid not in matched]
    before = {a.id for a in accounts if (a.role, a.status) == ("admin", "active")}
    after = set(before)
    for c in changes:
        after.discard(c.account.id)
        if (c.role, c.status) == ("admin", "active"):
            after.add(c.account.id)
    if before and not after and not any(p.oid in d.admins for p in missing):
        raise SyncRefused("the sync would leave no active admin; check the admins group")
    return changes, missing


async def sync_once(db: asyncpg.Pool, graph: Graph, default_tier: str) -> dict:
    """One sync, recorded in public.entra_sync. Returns that record."""
    try:
        d = await graph.directory()
        async with db.acquire() as conn, conn.transaction():
            if not await conn.fetchval("select pg_try_advisory_xact_lock($1)", LOCK_ID):
                return {"ok": True, "message": "another sync is running"}
            rows = await conn.fetch("select id::text, email, entra_oid::text, role, status, disabled_by, tier_id, local "
                                    "from public.profiles for update")
            changes, missing = plan([Account(**dict(r)) for r in rows], d, default_tier)
            for c in changes:
                await conn.execute(
                    "update public.profiles set role = $2, status = $3, disabled_by = $4, tier_id = $5, "
                    "entra_oid = $6::uuid, updated_at = now() where id = $1::uuid",
                    c.account.id, c.role, c.status, c.disabled_by, c.tier_id, c.entra_oid)
                log.info("entra sync: %s %s/%s/%s -> %s/%s/%s (%s)", c.account.email, c.account.role,
                         c.account.status, c.account.tier_id, c.role, c.status, c.tier_id, c.reason)
            for p in missing:
                uid = await conn.fetchval("select public.entra_provision($1, $2, $3::uuid)", p.email, p.name, p.oid)
                await conn.execute("update public.profiles set role = $2, tier_id = $3, status = 'active', "
                                   "disabled_by = null, updated_at = now() where id = $1",
                                   uid, "admin" if p.oid in d.admins else "user", d.plans.get(p.oid, default_tier))
                log.info("entra sync: created %s", p.email)
            result = dict(ok=True, message="in step with Entra", members=len(d.members), created=len(missing),
                          disabled=sum(c.status == "disabled" and c.account.status == "active" for c in changes),
                          enabled=sum(c.status == "active" and c.account.status == "disabled" for c in changes),
                          changed=len(changes))
            if graph.s.openwebui_schema:
                try:
                    async with conn.transaction():
                        n = await sync_openwebui(conn, graph.s.openwebui_schema)
                    if n:
                        result["message"] += f"; Open WebUI: {n} role{'s' * (n != 1)} changed"
                except (SyncRefused, asyncpg.PostgresError) as e:
                    log.error("entra sync: Open WebUI roles not synced: %s", e)
                    result.update(ok=False, message=f"accounts in step; Open WebUI roles not synced: {e}")
            await record(conn, result)
    except (SyncRefused, RuntimeError, httpx.HTTPError) as e:
        log.error("entra sync refused or failed: %s", e)
        result = dict(ok=False, message=str(e))
        async with db.acquire() as conn:
            await record(conn, result)
    return result


async def sync_openwebui(conn: asyncpg.Connection, schema: str) -> int:
    """Open WebUI's roles from the accounts (as they now are). Returns how many changed."""
    if not re.fullmatch(r"[a-z_][a-z0-9_]*", schema):
        raise SyncRefused(f"bad Open WebUI schema name {schema!r}")
    table = f'{schema}."user"'
    users = [WebUser(**dict(r)) for r in await conn.fetch(
        f"select id, email, role, oauth -> 'oidc' ->> 'sub' as sub from {table}")]
    accounts = {r["id"]: Account(**dict(r)) for r in await conn.fetch(
        "select id::text, email, entra_oid::text, role, status, disabled_by, tier_id, local from public.profiles")}
    changed = 0
    for u, role in openwebui_plan(users, accounts):
        # Only if nobody changed it meanwhile (Open WebUI writes its user rows all the time).
        if await conn.fetchval(f"update {table} set role = $2, updated_at = extract(epoch from now())::bigint "
                               f"where id = $1 and role = $3 returning id", u.id, role, u.role):
            changed += 1
            log.info("entra sync: Open WebUI %s %s -> %s", u.email, u.role, role)
    return changed


async def record(conn: asyncpg.Connection, result: dict) -> None:
    columns = ["ran_at", *result]
    await conn.execute(
        f"insert into public.entra_sync ({', '.join(columns)}) "
        f"values (now(), {', '.join(f'${i}' for i in range(1, len(result) + 1))}) "
        f"on conflict (id) do update set {', '.join(f'{c} = excluded.{c}' for c in columns)}",
        *result.values())


async def run(db: asyncpg.Pool, graph: Graph, every: int, default_tier: str) -> None:
    log.info("entra sync every %d s", every)
    while True:
        try:
            await sync_once(db, graph, default_tier)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("entra sync crashed; retrying next round")
        await asyncio.sleep(every)
