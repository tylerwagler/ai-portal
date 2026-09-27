"""The system dashboard: portal admins get in through their portal session, nobody else does."""

import pytest
from starlette.websockets import WebSocketDisconnect

from conftest import DASH_HOST, Person

DASH = {"host": DASH_HOST}


def session_for(client, person) -> str:
    code = client.post("/portal/dashboard/code", headers=person.headers)
    assert code.status_code == 200
    assert code.json()["url"].startswith(f"https://{DASH_HOST}/__auth?code=")
    r = client.get("/__auth", params={"code": code.json()["code"]}, headers=DASH, follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"] == "/"
    cookie = r.headers["set-cookie"]
    assert "HttpOnly" in cookie and "Secure" in cookie and "Domain" not in cookie
    return cookie.split(";")[0]


def test_signed_out_visitors_are_sent_to_the_portal(client):
    r = client.get("/", headers=DASH, follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"] == "https://account.example.test/dashboard"
    assert client.get("/api/state", headers=DASH).status_code == 401
    bogus = client.get("/", headers={**DASH, "cookie": "dash_session=nope"}, follow_redirects=False)
    assert bogus.status_code == 302


def test_only_admins_get_a_code(client, unlimited_tier):
    user = Person("dash-user", tier=unlimited_tier)
    assert client.post("/portal/dashboard/code", headers=user.headers).status_code == 403
    assert client.post("/portal/dashboard/code").status_code == 401


def test_admin_session_reaches_the_dashboard_and_code_is_single_use(client, unlimited_tier):
    admin = Person("dash-admin", role="admin", tier=unlimited_tier)
    code = client.post("/portal/dashboard/code", headers=admin.headers).json()["code"]
    first = client.get("/__auth", params={"code": code}, headers=DASH, follow_redirects=False)
    cookie = first.headers["set-cookie"].split(";")[0]
    again = client.get("/__auth", params={"code": code}, headers=DASH, follow_redirects=False)
    assert "set-cookie" not in again.headers and again.headers["location"].endswith("/dashboard")

    page = client.get("/", headers={**DASH, "cookie": cookie})
    assert page.status_code == 200 and "observatory" in page.text
    # The session cookie stays with portal-api.
    assert client.get("/api/state", headers={**DASH, "cookie": cookie}).json() == {"seen_cookie": False}

    with client.websocket_connect("/ws", headers={**DASH, "cookie": cookie}) as ws:
        assert ws.receive_text() == "hello"
        ws.send_text("ping")
        assert ws.receive_text() == "echo:ping"


def test_losing_admin_ends_the_dashboard_session(client, unlimited_tier):
    from conftest import sql

    admin = Person("dash-demoted", role="admin", tier=unlimited_tier)
    cookie = session_for(client, admin)
    assert client.get("/", headers={**DASH, "cookie": cookie}).status_code == 200
    sql(f"update public.profiles set role = 'user' where id = '{admin.id}';")
    assert client.get("/", headers={**DASH, "cookie": cookie}, follow_redirects=False).status_code == 302
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws", headers={**DASH, "cookie": cookie}) as ws:
            ws.receive_text()


def test_other_hosts_are_untouched(client):
    assert client.get("/__auth").status_code == 200  # the web app, not the dashboard
