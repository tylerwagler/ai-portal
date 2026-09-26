import asyncio
import time

import httpx
import pytest

from conftest import GATE, Person, sql
from portal_api import usage_consumer
from portal_api.usage import resets_at, windows


def gate_chat(key: str) -> httpx.Response:
    return httpx.post(f"{GATE}/v1/chat/completions", headers={"Authorization": f"Bearer {key}"},
                      json={"model": "mock-model", "messages": [{"role": "user", "content": "hi"}]})


# --- auth ------------------------------------------------------------------------

def test_requests_need_a_valid_session(client):
    assert client.get("/portal/me").status_code == 401
    assert client.get("/portal/me", headers={"Authorization": "Bearer not.a.jwt"}).status_code == 401


def test_disabled_account_is_refused(client, unlimited_tier):
    p = Person("disabled", tier=unlimited_tier)
    sql(f"update public.profiles set status = 'disabled' where id = '{p.id}';")
    assert client.get("/portal/me", headers=p.headers).status_code == 403


def test_new_signup_is_active_on_free_tier(client):
    p = Person("fresh")
    sql(f"update public.profiles set role = default where id = '{p.id}';")
    body = client.get("/portal/me", headers=p.headers).json()
    assert body["user"]["role"] == "user"
    assert body["plan"]["id"] == "free"


# --- keys ------------------------------------------------------------------------

def test_key_is_shown_once_works_at_the_gate_and_revokes(client, unlimited_tier):
    p = Person("keys", tier=unlimited_tier)
    made = client.post("/portal/keys", headers=p.headers, json={"name": "laptop"}).json()
    assert made["key"].startswith("sk_ai_") and made["last4"] == made["key"][-4:]

    listed = client.get("/portal/keys", headers=p.headers).json()
    assert [k["id"] for k in listed] == [made["id"]]
    assert "key" not in listed[0] and "key_hash" not in listed[0]

    assert gate_chat(made["key"]).status_code == 200

    assert client.patch(f"/portal/keys/{made['id']}", headers=p.headers, json={"name": "desk"}).status_code == 200
    assert client.delete(f"/portal/keys/{made['id']}", headers=p.headers).status_code == 204
    assert client.get("/portal/keys", headers=p.headers).json() == []


def test_users_cannot_touch_each_others_keys(client, unlimited_tier):
    owner, other = Person("owner", tier=unlimited_tier), Person("other", tier=unlimited_tier)
    made = client.post("/portal/keys", headers=owner.headers, json={"name": "mine"}).json()
    assert client.delete(f"/portal/keys/{made['id']}", headers=other.headers).status_code == 404
    assert client.patch(f"/portal/keys/{made['id']}", headers=other.headers, json={"name": "x"}).status_code == 404
    assert len(client.get("/portal/keys", headers=owner.headers).json()) == 1


# --- CLI device login --------------------------------------------------------------

def test_cli_device_login_hands_over_one_working_key(client, unlimited_tier):
    p = Person("cli", tier=unlimited_tier)
    start = client.post("/portal/cli/start", json={"device_name": "claude-local (test)"}).json()
    assert start["verify_url"].endswith(f"?code={start['user_code']}")

    poll = client.post("/portal/cli/poll", json={"device_code": start["device_code"]})
    assert poll.status_code == 202 and poll.json()["status"] == "pending"

    shown = client.get(f"/portal/cli/pending/{start['user_code'].replace('-', '').lower()}", headers=p.headers)
    assert shown.json()["device_name"] == "claude-local (test)"

    assert client.post("/portal/cli/approve", headers=p.headers, json={"user_code": start["user_code"]}).status_code == 200
    # A code can be approved only once.
    assert client.post("/portal/cli/approve", headers=p.headers, json={"user_code": start["user_code"]}).status_code == 404

    got = client.post("/portal/cli/poll", json={"device_code": start["device_code"]})
    assert got.status_code == 200
    key = got.json()["api_key"]
    assert gate_chat(key).status_code == 200
    # The key is handed over once.
    assert client.post("/portal/cli/poll", json={"device_code": start["device_code"]}).status_code == 410
    assert [k["name"] for k in client.get("/portal/keys", headers=p.headers).json()] == ["claude-local (test)"]


def test_cli_poll_with_unknown_device_code_expires(client):
    assert client.post("/portal/cli/poll", json={"device_code": "x" * 40}).status_code == 410


# --- live usage and ingest ----------------------------------------------------------

def test_me_shows_live_usage_from_gate_counters(client, unlimited_tier):
    p = Person("usage", tier=unlimited_tier)
    key = client.post("/portal/keys", headers=p.headers, json={"name": "k"}).json()["key"]
    assert gate_chat(key).status_code == 200
    for _ in range(50):  # the gate records usage asynchronously
        usage = client.get("/portal/me", headers=p.headers).json()["usage"]
        if usage["tokens_day"]["used"]:
            break
        time.sleep(0.1)
    assert usage["tokens_day"]["used"] == 16  # mock upstream: 11 in + 5 out
    assert usage["requests_per_minute"]["used"] == 1
    assert usage["tokens_day"]["limit"] is None


def test_consumer_stores_events_once_and_rolls_them_up(client, unlimited_tier):
    res = client.app.state.resources
    p = Person("ingest", tier=unlimited_tier)
    key = client.post("/portal/keys", headers=p.headers, json={"name": "k"}).json()["key"]
    for _ in range(2):
        assert gate_chat(key).status_code == 200
    time.sleep(0.5)

    async def drain():
        await usage_consumer.ensure_group(res.valkey)
        while await usage_consumer.process_once(res.db, res.valkey, "test", block_ms=100):
            pass
        entries = await res.valkey.xrange(usage_consumer.STREAM)
        mine = [(i, f) for i, f in entries if f["user_id"] == p.id]
        # Replaying already-stored entries must not double count.
        await usage_consumer.write_batch(res.db, mine)
        return len(mine)

    assert client.portal.call(drain) == 2
    events = int(sql(f"select count(*) from public.usage_events where user_id = '{p.id}';"))
    rollup = sql(f"select requests || ',' || input_tokens || ',' || output_tokens || ',' || billable_tokens "
                 f"from public.usage_rollups where user_id = '{p.id}';")
    assert events == 2
    assert rollup == "2,22,10,32"  # no cached tokens, so billable = input + output
    daily = client.get("/portal/me/usage/daily", headers=p.headers).json()
    assert daily[0]["requests"] == 2 and daily[0]["model"] == "mock-model"


def test_idle_consumer_read_does_not_time_out(client):
    """An empty stream makes the consumer wait the full BLOCK_MS; the client must allow it."""
    res = client.app.state.resources

    async def idle_read():
        await res.valkey.xread({f"idle-{time.time()}": "$"}, block=usage_consumer.BLOCK_MS)

    started = time.time()
    client.portal.call(idle_read)
    assert time.time() - started >= usage_consumer.BLOCK_MS / 1000 - 0.5


# --- admin ------------------------------------------------------------------------

def test_admin_endpoints_need_an_admin(client, unlimited_tier):
    p = Person("notadmin", tier=unlimited_tier)
    assert client.get("/portal/admin/users", headers=p.headers).status_code == 403
    assert client.patch(f"/portal/admin/users/{p.id}", headers=p.headers, json={"tier_id": "free"}).status_code == 403


def test_admin_changes_accounts_and_plans(client, unlimited_tier):
    admin, target = Person("admin", role="admin", tier=unlimited_tier), Person("target", tier=unlimited_tier)
    found = client.get("/portal/admin/users", headers=admin.headers, params={"q": target.email}).json()
    assert [u["id"] for u in found] == [target.id]

    changed = client.patch(f"/portal/admin/users/{target.id}", headers=admin.headers,
                           json={"tier_id": "free", "status": "disabled"}).json()
    assert changed["tier_id"] == "free" and changed["status"] == "disabled"
    bad = client.patch(f"/portal/admin/users/{target.id}", headers=admin.headers, json={"tier_id": "no-such-tier"})
    assert bad.status_code == 400
    self_demote = client.patch(f"/portal/admin/users/{admin.id}", headers=admin.headers, json={"role": "user"})
    assert self_demote.status_code == 400

    tier = {"id": f"pro_{admin.id[:6]}", "display_name": "Pro", "price_monthly_cents": 2000, "daily_limit": 1_000_000}
    assert client.put(f"/portal/admin/tiers/{tier['id']}", headers=admin.headers, json=tier).json()["daily_limit"] == 1_000_000
    tier["daily_limit"] = 2_000_000
    assert client.put(f"/portal/admin/tiers/{tier['id']}", headers=admin.headers, json=tier).json()["daily_limit"] == 2_000_000


# --- window math must match switchyard-gate ------------------------------------------

def test_windows_match_the_gate():
    fri = 1_790_380_770  # 2026-09-25 23:59:30 UTC, same instant as the gate's tests
    w, r = windows(fri), resets_at(fri)
    assert w["month"] == 2026 * 12 + 8
    assert r["minute"] - fri == 30 and r["day"] - fri == 30
    assert r["week"] - fri == 2 * 86_400 + 30
    assert r["month"] - fri == 5 * 86_400 + 30
