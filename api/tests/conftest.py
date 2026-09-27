"""Integration fixtures against a running Supabase, Valkey, and switchyard-gate.

Defaults point at the spike stack on the dev VM; override with the TEST_* variables.
    TEST_SUPABASE_URL      public Supabase URL (sign-up, sign-in)
    TEST_SUPABASE_ANON     publishable key
    TEST_DATABASE_URL      portal_api role connection
    TEST_VALKEY_URL        the Valkey the gate writes to
    TEST_GATE_URL          switchyard-gate base URL
    TEST_ADMIN_PSQL        command that runs SQL as an admin role (reads stdin)
"""

import os
import secrets
import shlex
import subprocess

import httpx
import pytest
from fastapi.testclient import TestClient

from portal_api.config import Settings
from portal_api.main import create_app

SUPABASE = os.environ.get("TEST_SUPABASE_URL", "http://10.20.20.10:8800")
ANON = os.environ["TEST_SUPABASE_ANON"]
GATE = os.environ.get("TEST_GATE_URL", "http://127.0.0.1:8111")
ADMIN_PSQL = os.environ.get(
    "TEST_ADMIN_PSQL", "docker exec -i supabase-db psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -Atq")
RUN = secrets.token_hex(3)


def sql(statement: str) -> str:
    out = subprocess.run(shlex.split(ADMIN_PSQL), input=statement, capture_output=True, text=True)
    if out.returncode:
        raise RuntimeError(out.stderr)
    return out.stdout.strip()


class Person:
    def __init__(self, name: str, role: str = "user", tier: str = "free"):
        self.email = f"{name}-{RUN}@example.com"
        password = secrets.token_urlsafe(16)
        httpx.post(f"{SUPABASE}/auth/v1/signup", headers={"apikey": ANON},
                   json={"email": self.email, "password": password}).raise_for_status()
        self.id = sql(f"update public.profiles set role = '{role}', tier_id = '{tier}' "
                      f"where email = '{self.email}' returning id;")
        r = httpx.post(f"{SUPABASE}/auth/v1/token?grant_type=password", headers={"apikey": ANON},
                       json={"email": self.email, "password": password})
        r.raise_for_status()
        self.headers = {"Authorization": f"Bearer {r.json()['access_token']}"}


API_HOST = "api.example.test"
DASH_HOST = "dash.example.test"


@pytest.fixture(scope="session")
def fake_dashboard():
    """A stand-in pulsar-gui: a page, an API call, and a WebSocket that echoes."""
    import socket
    import threading
    import time

    import uvicorn
    from starlette.applications import Starlette
    from starlette.responses import HTMLResponse, JSONResponse
    from starlette.routing import Route, WebSocketRoute

    async def page(request):
        return HTMLResponse("<title>observatory</title>")

    async def state(request):
        return JSONResponse({"seen_cookie": "cookie" in request.headers})

    async def ws(websocket):
        await websocket.accept()
        await websocket.send_text("hello")
        async for message in websocket.iter_text():
            await websocket.send_text(f"echo:{message}")

    app = Starlette(routes=[Route("/", page), Route("/api/state", state), WebSocketRoute("/ws", ws)])
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    threading.Thread(target=server.run, daemon=True).start()
    while not server.started:
        time.sleep(0.05)
    yield f"http://127.0.0.1:{port}"
    server.should_exit = True


@pytest.fixture(scope="session")
def site_dirs(tmp_path_factory):
    """A stand-in built web app and installer directory."""
    web = tmp_path_factory.mktemp("web")
    (web / "index.html").write_text("<title>AI Portal</title>")
    (web / "assets").mkdir()
    (web / "assets" / "app-1234.js").write_text("console.log(1)")
    install = tmp_path_factory.mktemp("install")
    (install / "setup.sh").write_text("#!/bin/bash\necho hi\n")
    return web, install


@pytest.fixture(scope="session")
def client(site_dirs, fake_dashboard):
    web, install = site_dirs
    settings = Settings(
        database_url=os.environ["TEST_DATABASE_URL"],
        valkey_url=os.environ.get("TEST_VALKEY_URL", "redis://127.0.0.1:6390/0"),
        jwks_url=f"{SUPABASE}/auth/v1/.well-known/jwks.json",
        jwt_issuer=f"{SUPABASE}/auth/v1",
        cli_verify_url="https://account.example.test/cli",
        run_usage_consumer=False,
        # The spike's edge already exposes Auth's OIDC endpoints without an apikey.
        supabase_auth_url=f"{SUPABASE}/auth/v1",
        web_dir=str(web),
        install_dir=str(install),
        api_host=API_HOST,
        dashboard_host=DASH_HOST,
        dashboard_upstream=fake_dashboard,
    )
    with TestClient(create_app(settings)) as c:
        yield c


@pytest.fixture(scope="session")
def unlimited_tier():
    tier = f"unl_{RUN}"
    sql(f"insert into public.tiers (id, display_name) values ('{tier}', 'Unlimited');")
    return tier
