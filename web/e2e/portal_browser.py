"""Browser walk-through of the portal against a dev stack (vite on :5173 proxying Supabase and portal-api).

    E2E_SUPABASE_KEY=... E2E_ADMIN_PSQL='docker exec -i supabase-db psql -U supabase_admin -d postgres -Atq' \
      python e2e/portal_browser.py
Screenshots land next to this file.
"""

import os
import re
import secrets
import shlex
import subprocess
import sys
from pathlib import Path

import requests
from playwright.sync_api import expect, sync_playwright

WEB = os.environ.get("E2E_WEB_URL", "http://127.0.0.1:5173")
KEY = os.environ["E2E_SUPABASE_KEY"]
PSQL = os.environ.get("E2E_ADMIN_PSQL", "docker exec -i supabase-db psql -U supabase_admin -d postgres -Atq")
GATE = os.environ.get("E2E_GATE_URL", "http://127.0.0.1:8111")
HERE = Path(__file__).parent


def sql(statement: str) -> str:
    out = subprocess.run(shlex.split(PSQL), input=statement, capture_output=True, text=True, check=True)
    return out.stdout.strip()


def main() -> int:
    # A prepared admin account can be passed in when this runs where psql is unavailable.
    email, password = os.environ.get("E2E_EMAIL"), os.environ.get("E2E_PASSWORD")
    if not email:
        email, password = f"browser-{secrets.token_hex(3)}@example.com", secrets.token_urlsafe(14)
        requests.post(f"{WEB}/auth/v1/signup", headers={"apikey": KEY},
                      json={"email": email, "password": password}).raise_for_status()
        sql(f"update public.profiles set role = 'admin' where email = '{email}';")

    with sync_playwright() as p:
        page = p.chromium.launch().new_page(viewport={"width": 1100, "height": 900})
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        # Signed-out visitors go to the login page and come back afterwards.
        page.goto(f"{WEB}/")
        page.wait_for_url(re.compile(r"/login\?next="))
        page.fill("#email", email)
        page.fill("#password", password)
        page.get_by_role("button", name="Sign in").click()
        expect(page.get_by_role("heading", name="Free plan")).to_be_visible()
        expect(page.get_by_text("Tokens today")).to_be_visible()
        print("PASS  sign-in lands on the account page with the Free plan and usage")

        page.fill("input[placeholder^='Key name']", "laptop")
        page.get_by_role("button", name="Create").click()
        shown = page.locator("code", has_text="sk_ai_").first
        expect(shown).to_be_visible()
        new_key = shown.inner_text()
        assert requests.get(f"{GATE}/v1/models", headers={"Authorization": f"Bearer {new_key}"}).status_code == 200
        page.screenshot(path=str(HERE / "account.png"), full_page=True)
        print("PASS  new key is shown once and works at the gate")

        # claude-local --login: the CLI starts, the browser approves, the CLI gets a key.
        start = requests.post(f"{WEB}/portal/cli/start", json={"device_name": "claude-local (e2e)"}).json()
        page.goto(start["verify_url"].replace("http://localhost:5173", WEB))
        expect(page.get_by_text("claude-local (e2e)")).to_be_visible()
        page.get_by_role("button", name="Approve this device").click()
        expect(page.get_by_text("is signed in")).to_be_visible()
        polled = requests.post(f"{WEB}/portal/cli/poll", json={"device_code": start["device_code"]}).json()
        assert requests.get(f"{GATE}/v1/models", headers={"Authorization": f"Bearer {polled['api_key']}"}).status_code == 200
        print("PASS  CLI device login approved in the browser; the CLI key works at the gate")

        page.get_by_role("link", name="Admin").click()
        expect(page.get_by_role("cell", name=email)).to_be_visible()
        expect(page.get_by_role("heading", name="Plans")).to_be_visible()
        page.screenshot(path=str(HERE / "admin.png"), full_page=True)
        print("PASS  admin page lists users and plans")

        if errors:
            print("FAIL  page errors:", *errors, sep="\n  ")
            return 1
    print("\nALL PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
