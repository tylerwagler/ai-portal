"""Entra groups as the source of accounts, roles and plans (migration 0006, portal_api/entra_sync.py)."""

import dataclasses
import json
import os
import uuid
from urllib.parse import urlparse

import asyncpg
import httpx
import pytest
from fastapi.testclient import TestClient

from conftest import RUN, sql
from portal_api import entra_sync
from portal_api.config import Settings
from portal_api.deps import User, admin_user
from portal_api.entra_sync import Account, Directory, Person, SyncRefused, WebUser, openwebui_plan, plan
from portal_api.main import create_app

TENANT = "590a429c-bbba-49f1-b2dd-7822998989ae"
USERS, ADMINS, UNLIMITED = "g-users", "g-admins", "g-unlimited"


def acct(oid=None, email=None, role="user", status="active", disabled_by=None, tier="free", local=False, id_=None):
    return Account(id=id_ or str(uuid.uuid4()), email=email or f"{oid}@x", entra_oid=oid, role=role, status=status,
                   disabled_by=disabled_by, tier_id=tier, local=local)


def directory(members, admins=(), plans=None):
    return Directory({o: Person(o, f"{o}@x", o.upper()) for o in members}, set(admins), dict(plans or {}))


# --- plan --------------------------------------------------------------------------------

def test_roles_and_plans_follow_groups():
    d = directory(["a", "b", "c"], admins=["a"], plans={"a": "internal"})
    changes, missing = plan([acct("a", role="user"), acct("b", role="admin", tier="internal")], d, "free")
    by = {c.account.entra_oid: c for c in changes}
    assert (by["a"].role, by["a"].tier_id) == ("admin", "internal")
    assert (by["b"].role, by["b"].tier_id) == ("user", "free")
    assert [p.oid for p in missing] == ["c"]


def test_leavers_are_disabled_and_only_entra_disables_come_back():
    d = directory(["keep", "back", "manual"], admins=["keep"])
    changes, _ = plan([acct("keep", role="admin"), acct("gone"), acct("back", status="disabled", disabled_by="entra"),
                       acct("manual", status="disabled", disabled_by="admin")], d, "free")
    by = {c.account.entra_oid: (c.status, c.disabled_by) for c in changes}
    assert by == {"gone": ("disabled", "entra"), "back": ("active", None)}


def test_local_accounts_are_untouched_and_unlinked_accounts_match_by_email():
    d = directory(["a"], admins=["a"])
    changes, missing = plan([acct(None, email="a@x", role="user"), acct(None, email="bot@x", local=True)], d, "free")
    assert len(changes) == 1 and changes[0].entra_oid == "a" and changes[0].role == "admin" and missing == []


def test_refuses_an_empty_group_or_losing_every_admin():
    with pytest.raises(SyncRefused, match="no enabled members"):
        plan([acct("a", role="admin")], Directory({}), "free")
    with pytest.raises(SyncRefused, match="no active admin"):
        plan([acct("a", role="admin")], directory(["a"], admins=[]), "free")


def test_openwebui_roles_follow_accounts():
    accounts = {a.id: a for a in (acct("o1", role="admin", id_="boss"), acct("o2", id_="staff"),
                                  acct("o3", status="disabled", disabled_by="entra", id_="gone"),
                                  acct(None, role="admin", local=True, id_="bot"))}
    users = [WebUser("1", "boss", "user", "boss"), WebUser("2", "staff", "admin", "staff"),
             WebUser("3", "gone", "user", "gone"), WebUser("4", "stray", "admin", None),
             WebUser("5", "kb-sync", "user", None), WebUser("6", "bot", "admin", "bot")]
    assert {u.id: role for u, role in openwebui_plan(users, accounts)} == {
        "1": "admin", "2": "user", "3": "pending", "4": "user", "6": "user"}
    with pytest.raises(SyncRefused, match="without an admin"):
        openwebui_plan([WebUser("2", "staff", "admin", "staff")], accounts)


# --- the database: sign-in link and provisioning ------------------------------------------

def entra_sign_in(email: str, oid: str) -> str:
    uid = sql(f"insert into auth.users (id, aud, role, email) values (gen_random_uuid(), 'authenticated', "
              f"'authenticated', '{email}') returning id;")
    data = {"sub": uuid.uuid4().hex, "email": email, "custom_claims": {"oid": oid, "tid": TENANT}}
    sql(f"insert into auth.identities (provider_id, user_id, identity_data, provider) values "
        f"('{uuid.uuid4().hex}', '{uid}', '{json.dumps(data)}', 'azure');")
    return uid


def test_sign_in_links_the_entra_object_id():
    oid = str(uuid.uuid4())
    uid = entra_sign_in(f"linked-{RUN}@elytron.example", oid)
    assert sql(f"select entra_oid from public.profiles where id = '{uid}';") == oid


def test_provisioning_creates_once_and_marks_the_email_confirmed():
    oid, email = str(uuid.uuid4()), f"new-{RUN}@elytron.example"
    a = sql(f"select public.entra_provision('{email.upper()}', 'New Person', '{oid}');")
    b = sql(f"select public.entra_provision('{email}', 'New Person', '{oid}');")
    assert a == b
    assert sql(f"select email_confirmed_at is not null from auth.users where id = '{a}';") == "t"
    assert sql(f"select entra_oid || ' ' || display_name from public.profiles where id = '{a}';") == f"{oid} New Person"


def test_disabled_by_must_match_status():
    uid = entra_sign_in(f"constraint-{RUN}@elytron.example", str(uuid.uuid4()))
    with pytest.raises(RuntimeError, match="profiles_disabled_by"):
        sql(f"update public.profiles set status = 'disabled' where id = '{uid}';")


# --- a whole sync against a fake Graph ----------------------------------------------------

class FakeGraph:
    def __init__(self):
        self.groups: dict[str, list[dict]] = {USERS: [], ADMINS: [], UNLIMITED: []}

    def add(self, group, oid, email, enabled=True):
        self.groups[group].append({"id": oid, "mail": email, "userPrincipalName": email, "displayName": email.split("@")[0],
                                   "accountEnabled": enabled})

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = urlparse(str(request.url)).path
        if path.endswith("/oauth2/v2.0/token"):
            return httpx.Response(200, json={"access_token": "t", "expires_in": 3600})
        group = path.split("/")[3]
        return httpx.Response(200, json={"value": self.groups.get(group, [])})


@pytest.fixture(scope="module")
def settings():
    return Settings(database_url=os.environ["TEST_DATABASE_URL"], valkey_url="redis://127.0.0.1:1/0",
                    jwks_url="http://127.0.0.1:1/jwks", jwt_issuer="http://127.0.0.1:1/auth/v1",
                    cli_verify_url="https://account.example.test/cli", run_usage_consumer=False,
                    entra_tenant_id=TENANT, entra_client_id="c", entra_client_secret="s",
                    entra_users_group=USERS, entra_admins_group=ADMINS, entra_plan_groups=((UNLIMITED, "internal"),))


@pytest.fixture(scope="module")
def unlimited_tier():
    sql("insert into public.tiers (id, display_name) values ('internal', 'Internal') on conflict do nothing;")


def graph_for(fake, settings):
    return entra_sync.Graph(httpx.AsyncClient(transport=httpx.MockTransport(fake.handler)), settings,
                            graph_url="https://graph.test/v1.0", login_url="https://login.test")


async def run_sync(fake, settings):
    db = await asyncpg.create_pool(os.environ["TEST_DATABASE_URL"], min_size=1, max_size=2)
    try:
        return await entra_sync.sync_once(db, graph_for(fake, settings), "free")
    finally:
        await db.close()


def profile(email):
    return json.loads(sql(f"select row_to_json(p) from (select role, status, disabled_by, tier_id, local "
                          f"from public.profiles where lower(email) = lower('{email}')) p;") or "null")


async def test_sync_creates_sets_and_disables(settings, unlimited_tier):
    fake = FakeGraph()
    admin, user, leaver = (f"{n}-{RUN}@elytron.example" for n in ("boss", "staff", "leaver"))
    a_oid, u_oid, l_oid = (str(uuid.uuid4()) for _ in range(3))
    entra_sign_in(leaver, l_oid)                               # has signed in before, then leaves
    for oid, email in ((a_oid, admin), (u_oid, user)):
        fake.add(USERS, oid, email)
    fake.add(ADMINS, a_oid, admin)
    fake.add(UNLIMITED, a_oid, admin)

    result = await run_sync(fake, settings)
    assert result["ok"], result
    assert profile(admin) == {"role": "admin", "status": "active", "disabled_by": None, "tier_id": "internal", "local": False}
    assert profile(user) == {"role": "user", "status": "active", "disabled_by": None, "tier_id": "free", "local": False}
    assert profile(leaver)["status"] == "disabled" and profile(leaver)["disabled_by"] == "entra"

    fake.add(USERS, l_oid, leaver)                             # back in the group
    await run_sync(fake, settings)
    assert profile(leaver)["status"] == "active"

    fake.groups[ADMINS] = []                                   # would leave no admin: refused, nothing changes
    result = await run_sync(fake, settings)
    assert not result["ok"] and "no active admin" in result["message"]
    assert profile(admin)["role"] == "admin"


@pytest.fixture(scope="module")
def openwebui():
    """A stand-in for Open WebUI's user table, granted as migration 0007 grants the real one."""
    schema = f"owui_{RUN}"
    sql(f'create schema {schema}; create table {schema}."user" (id text primary key, email text, role text, '
        f'oauth json, updated_at bigint); grant usage on schema {schema} to portal_api; '
        f'grant select (id, email, role, oauth), update (role, updated_at) on {schema}."user" to portal_api;')
    yield schema
    sql(f"drop schema {schema} cascade;")


async def test_sync_sets_openwebui_roles(settings, unlimited_tier, openwebui):
    fake = FakeGraph()
    boss, staff, leaver = (f"ow-{n}-{RUN}@elytron.example" for n in ("boss", "staff", "leaver"))
    oids = {e: str(uuid.uuid4()) for e in (boss, staff, leaver)}
    uids = {e: entra_sign_in(e, oid) for e, oid in oids.items()}
    for e in (boss, staff):
        fake.add(USERS, oids[e], e)
    fake.add(ADMINS, oids[boss], boss)
    for i, (email, role, sub) in enumerate([(boss, "user", uids[boss]), (staff, "admin", uids[staff]),
                                            (leaver, "user", uids[leaver]), ("stray@gmail.example", "admin", None)]):
        oauth = json.dumps({"oidc": {"sub": sub}}) if sub else "null"
        sql(f"""insert into {openwebui}."user" values ('w{i}', '{email}', '{role}', '{oauth}', 0);""")

    result = await run_sync(fake, dataclasses.replace(settings, openwebui_schema=openwebui))
    assert result["ok"] and "Open WebUI: 4 roles changed" in result["message"], result
    roles = sql(f"""select string_agg(role, ' ' order by id) from {openwebui}."user";""")
    assert roles == "admin user pending user"


def test_admin_tab_refuses_editing_entra_people_but_not_local_accounts(settings, unlimited_tier, monkeypatch):
    async def no_loop(*_):
        pass
    monkeypatch.setattr(entra_sync, "run", no_loop)
    person = entra_sign_in(f"edited-{RUN}@elytron.example", str(uuid.uuid4()))
    bot = sql(f"insert into auth.users (id, aud, role, email) values (gen_random_uuid(), 'authenticated', "
              f"'authenticated', 'bot-{RUN}@elytron.example') returning id;")
    sql(f"update public.profiles set local = true where id = '{bot}';")
    app = create_app(settings)
    app.dependency_overrides[admin_user] = lambda: User(id=str(uuid.uuid4()), email="a", role="admin",
                                                        status="active", tier_id="internal")
    with TestClient(app) as c:
        r = c.patch(f"/portal/admin/users/{person}", json={"tier_id": "internal"})
        assert r.status_code == 409 and "managed in Entra" in r.json()["detail"]
        r = c.patch(f"/portal/admin/users/{bot}", json={"tier_id": "internal"})
        assert r.status_code == 200 and r.json()["tier_id"] == "internal"
        status = c.get("/portal/admin/entra").json()
        assert status["configured"] and status["default_tier"] == "free" and status["plan_groups"] == ["internal"]
