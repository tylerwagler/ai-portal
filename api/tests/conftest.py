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


@pytest.fixture(scope="session")
def client():
    settings = Settings(
        database_url=os.environ["TEST_DATABASE_URL"],
        valkey_url=os.environ.get("TEST_VALKEY_URL", "redis://127.0.0.1:6390/0"),
        jwks_url=f"{SUPABASE}/auth/v1/.well-known/jwks.json",
        jwt_issuer=f"{SUPABASE}/auth/v1",
        cli_verify_url="https://account.example.test/cli",
        run_usage_consumer=False,
    )
    with TestClient(create_app(settings)) as c:
        yield c


@pytest.fixture(scope="session")
def unlimited_tier():
    tier = f"unl_{RUN}"
    sql(f"insert into public.tiers (id, display_name) values ('{tier}', 'Unlimited');")
    return tier
