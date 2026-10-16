"""Entra ID: the sign-in trigger (migration 0006) and the Graph sync, against a fake Graph."""

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
from portal_api.entra_sync import DEFAULT_ACCESS, Directory, Profile, SyncRefused, plan
from portal_api.main import create_app

TENANT = "590a429c-bbba-49f1-b2dd-7822998989ae"
CLIENT = "cea584d7-6509-4f58-819f-d83183cfa54e"
ROLE_IDS = {"Portal.Admin": "11111111-1111-1111-1111-111111111111",
            "Portal.User": "22222222-2222-2222-2222-222222222222"}


def entra_sign_in(name: str, oid: str, roles: list[str] | None = None) -> str:
    """What Supabase Auth writes at a first Entra sign-in: the user, then its identity."""
    email = f"{name}-{RUN}@elytron.example"
    uid = sql(f"insert into auth.users (id, aud, role, email) values (gen_random_uuid(), "
              f"'authenticated', 'authenticated', '{email}') returning id;")
    sql(f"insert into auth.identities (provider_id, user_id, identity_data, provider) values "
        f"('{uuid.uuid4().hex}', '{uid}', '{json.dumps(identity_data(email, oid, roles))}', 'azure');")
    return uid


def identity_data(email: str, oid: str, roles: list[str] | None) -> dict:
    claims = {"oid": oid, "tid": TENANT}
    if roles is not None:
        claims["roles"] = roles
    return {"sub": uuid.uuid4().hex, "email": email, "custom_claims": claims}


def sign_in_again(uid: str, oid: str, roles: list[str] | None) -> None:
    sql(f"update auth.identities set identity_data = '{json.dumps(identity_data('x', oid, roles))}' "
        f"where user_id = '{uid}';")


def profile(uid: str) -> dict:
    row = sql(f"select row_to_json(p) from (select role, status, disabled_by, entra_oid::text "
              f"from public.profiles where id = '{uid}') p;")
    return json.loads(row)


# --- sign-in trigger ------------------------------------------------------------------

def test_sign_in_links_the_entra_object_id():
    oid = str(uuid.uuid4())
    uid = entra_sign_in("linked", oid)
    assert profile(uid) == {"role": "user", "status": "active", "disabled_by": None, "entra_oid": oid}


def test_app_roles_in_the_token_set_the_portal_role():
    oid = str(uuid.uuid4())
    uid = entra_sign_in("roles", oid, ["Portal.Admin"])
    assert profile(uid)["role"] == "admin"
    sign_in_again(uid, oid, ["Portal.User"])
    assert profile(uid)["role"] == "user"
    # No roles claim (Default Access, or no app roles defined): the role is left as it is.
    sql(f"update public.profiles set role = 'admin' where id = '{uid}';")
    sign_in_again(uid, oid, None)
    assert profile(uid)["role"] == "admin"


def test_pending_accounts_stay_pending_and_user_metadata_is_ignored():
    oid = str(uuid.uuid4())
    uid = entra_sign_in("held", oid)
    sql(f"update public.profiles set role = 'pending' where id = '{uid}';")
    sign_in_again(uid, oid, ["Portal.Admin"])
    assert profile(uid)["role"] == "pending"
    # A user can write their own user_metadata; it must not make them admin.
    sql(f"update public.profiles set role = 'user' where id = '{uid}';")
    sql("""update auth.users set raw_user_meta_data = '{"custom_claims": {"roles": ["Portal.Admin"]}}' """
        f"where id = '{uid}';")
    assert profile(uid)["role"] == "user"


def test_disabled_by_must_match_status():
    uid = entra_sign_in("constraint", str(uuid.uuid4()))
    with pytest.raises(RuntimeError, match="profiles_disabled_by"):
        sql(f"update public.profiles set status = 'disabled' where id = '{uid}';")


# --- plan -------------------------------------------------------------------------------

def p(oid: str | None, role: str = "user", status: str = "active", disabled_by: str | None = None) -> Profile:
    return Profile(id=oid or str(uuid.uuid4()), email=f"{oid}@x", entra_oid=oid, role=role,
                   status=status, disabled_by=disabled_by)


def test_plan_disables_and_re_enables_by_entra_only():
    admin = p("a", role="admin")
    d = Directory(assignment_required=True, manages_roles=False,
                  enabled={"a": True, "off": False, "gone2": True, "back": True, "manual": True},
                  assigned={"a": {""}, "off": {""}, "back": {""}, "manual": {""}})
    changes = {c.profile.entra_oid: c for c in plan([
        admin, p("off"), p("gone"), p("gone2"), p("back", status="disabled", disabled_by="entra"),
        p("manual", status="disabled", disabled_by="admin"), p(None)], d)}
    assert {k: (c.status, c.disabled_by, c.reason) for k, c in changes.items()} == {
        "off": ("disabled", "entra", "disabled in Entra"),
        "gone": ("disabled", "entra", "deleted in Entra"),
        "gone2": ("disabled", "entra", "not assigned to the app"),
        "back": ("active", None, "allowed in again"),
    }


def test_plan_without_required_assignment_lets_the_whole_tenant_in():
    d = Directory(assignment_required=False, manages_roles=False, enabled={"u": True})
    assert plan([p("u")], d) == []


def test_plan_takes_admin_from_the_app_role():
    d = Directory(assignment_required=True, manages_roles=True, enabled={"a": True, "b": True, "c": True, "x": True},
                  assigned={"a": {"Portal.Admin"}, "b": {"Portal.User"}, "c": {"Portal.Admin"},
                            "x": {"Portal.Admin"}})
    changes = plan([p("a", role="admin"), p("b", role="admin"), p("c"), p("x", role="pending")], d)
    assert {c.profile.entra_oid: c.role for c in changes} == {"b": "user", "c": "admin"}


def test_plan_refuses_to_remove_the_last_admin_or_trust_an_empty_directory():
    d = Directory(assignment_required=True, manages_roles=True, enabled={"a": True}, assigned={"a": {""}})
    with pytest.raises(SyncRefused, match="no active admin"):
        plan([p("a", role="admin")], d)
    with pytest.raises(SyncRefused, match="no users"):
        plan([p("a", role="admin")], Directory(assignment_required=False, manages_roles=False, enabled={}))


# --- sync through a fake Microsoft Graph ------------------------------------------------

class FakeGraph:
    def __init__(self):
        self.required = True
        self.users: dict[str, bool] = {}
        self.assignments: list[tuple[str, str, str]] = []  # (principalType, principalId, role value)
        self.groups: dict[str, list[str]] = {}

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = urlparse(str(request.url)).path
        if path == f"/{TENANT}/oauth2/v2.0/token":
            assert request.content and b"client_credentials" in request.content
            return httpx.Response(200, json={"access_token": "t", "expires_in": 3600})
        assert request.headers["authorization"] == "Bearer t"
        if path == f"/v1.0/servicePrincipals(appId='{CLIENT}')":
            return httpx.Response(200, json={
                "id": "sp", "appRoleAssignmentRequired": self.required,
                "appRoles": [{"id": i, "value": v, "isEnabled": True} for v, i in ROLE_IDS.items()]})
        if path == "/v1.0/servicePrincipals/sp/appRoleAssignedTo":
            value = [{"principalType": t, "principalId": pid, "appRoleId": ROLE_IDS.get(r, DEFAULT_ACCESS)}
                     for t, pid, r in self.assignments]
            # Two pages, to exercise @odata.nextLink.
            if "page=2" in str(request.url):
                return httpx.Response(200, json={"value": value[1:]})
            return httpx.Response(200, json={"value": value[:1], "@odata.nextLink":
                                             "https://graph.test/v1.0/servicePrincipals/sp/appRoleAssignedTo?page=2"})
        if path.startswith("/v1.0/groups/"):
            gid = path.split("/")[3]
            return httpx.Response(200, json={"value": [{"id": m} for m in self.groups[gid]]})
        if path == "/v1.0/users":
            return httpx.Response(200, json={"value": [{"id": u, "accountEnabled": e} for u, e in self.users.items()]})
        return httpx.Response(404, json={"error": path})


@pytest.fixture(scope="module")
def fake_graph():
    return FakeGraph()


@pytest.fixture(scope="module")
def settings():
    return Settings(database_url=os.environ["TEST_DATABASE_URL"], valkey_url="redis://127.0.0.1:1/0",
                    jwks_url="http://127.0.0.1:1/jwks", jwt_issuer="http://127.0.0.1:1/auth/v1",
                    cli_verify_url="https://account.example.test/cli", run_usage_consumer=False,
                    entra_tenant_id=TENANT, entra_client_id=CLIENT, entra_client_secret="s")


@pytest.fixture
def graph(fake_graph, settings):
    http = httpx.AsyncClient(transport=httpx.MockTransport(fake_graph.handler))
    return entra_sync.Graph(http, settings, graph_url="https://graph.test/v1.0", login_url="https://login.test")


@pytest.fixture(scope="module")
def keeper(fake_graph):
    """An admin who stays an admin, so the last-admin guard never trips by accident."""
    oid = str(uuid.uuid4())
    uid = entra_sign_in("keeper", oid, ["Portal.Admin"])
    fake_graph.users[oid] = True
    fake_graph.assignments.append(("User", oid, "Portal.Admin"))
    return uid


async def run_sync(graph) -> dict:
    db = await asyncpg.create_pool(os.environ["TEST_DATABASE_URL"], min_size=1, max_size=2)
    try:
        return await entra_sync.sync_once(db, graph)
    finally:
        await db.close()


async def test_sync_follows_entra(graph, fake_graph, keeper):
    member, direct, leaver = (str(uuid.uuid4()) for _ in range(3))
    group = str(uuid.uuid4())
    m_id, d_id, l_id = entra_sign_in("member", member), entra_sign_in("direct", direct), entra_sign_in("leaver", leaver)
    fake_graph.users |= {member: True, direct: True, leaver: True}
    fake_graph.groups[group] = [member]
    fake_graph.assignments += [("Group", group, "Portal.Admin"), ("User", direct, "Portal.User"),
                               ("User", leaver, "")]

    result = await run_sync(graph)
    assert result["ok"] and result["manages_roles"] and result["message"] == "assignment required"
    assert profile(m_id)["role"] == "admin"  # Portal.Admin through a group
    assert (profile(d_id)["role"], profile(d_id)["status"]) == ("user", "active")

    # The leaver is disabled in Entra: disabled here, by Entra; an admin's own disable is kept.
    fake_graph.users[leaver] = False
    sql(f"update public.profiles set status = 'disabled', disabled_by = 'admin' where id = '{d_id}';")
    await run_sync(graph)
    assert profile(l_id)["status"] == "disabled" and profile(l_id)["disabled_by"] == "entra"

    # Back in Entra: the sync re-enables what it disabled, not what an admin disabled.
    fake_graph.users[leaver] = True
    result = await run_sync(graph)
    assert profile(l_id)["status"] == "active" and profile(l_id)["disabled_by"] is None
    assert profile(d_id)["status"] == "disabled"
    assert sql("select ok from public.entra_sync;") == "t"


async def test_sync_records_a_refusal_and_changes_nothing(graph, fake_graph, keeper):
    saved = list(fake_graph.assignments)
    fake_graph.assignments = [a for a in saved if a[2] != "Portal.Admin"]
    try:
        before = sql("select string_agg(id || role || status, ',' order by id) from public.profiles;")
        result = await run_sync(graph)
        assert not result["ok"] and "no active admin" in result["message"]
        assert sql("select string_agg(id || role || status, ',' order by id) from public.profiles;") == before
        assert sql("select ok from public.entra_sync;") == "f"
    finally:
        fake_graph.assignments = saved


def test_admin_endpoints(settings, fake_graph, keeper, monkeypatch):
    async def no_loop(*_):
        pass

    # The background loop would sync against the real Microsoft Graph before the fake is in.
    monkeypatch.setattr(entra_sync, "run", no_loop)
    app = create_app(settings)
    app.dependency_overrides[admin_user] = lambda: User(id=keeper, email="k", role="admin", status="active",
                                                        tier_id="free")
    with TestClient(app) as c:
        res = c.app.state.resources
        res.entra.http = httpx.AsyncClient(transport=httpx.MockTransport(fake_graph.handler))
        res.entra.graph_url, res.entra.login_url = "https://graph.test/v1.0", "https://login.test"

        assert c.post("/portal/admin/entra/sync").json()["ok"]
        status = c.get("/portal/admin/entra").json()
        assert status["configured"] and status["last"]["ok"] and status["last"]["linked"] >= 1

        target = entra_sign_in("patched", str(uuid.uuid4()))
        changed = c.patch(f"/portal/admin/users/{target}", json={"status": "disabled"}).json()
        assert changed["disabled_by"] == "admin"
        changed = c.patch(f"/portal/admin/users/{target}", json={"status": "active"}).json()
        assert changed["disabled_by"] is None
        listed = c.get("/portal/admin/users", params={"q": f"patched-{RUN}"}).json()
        assert listed[0]["entra_linked"] is True
