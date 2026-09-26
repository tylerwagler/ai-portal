"""Serving the web app, the installers, and Supabase Auth's public OIDC endpoints."""

from conftest import API_HOST, SUPABASE


def test_web_app_routes_fall_back_to_index(client):
    for path in ("/", "/cli?code=ABCD-EFGH", "/admin"):
        r = client.get(path)
        assert r.status_code == 200 and "<title>AI Portal" in r.text, path
    asset = client.get("/assets/app-1234.js")
    assert asset.status_code == 200 and "immutable" in asset.headers["cache-control"]
    # A path that tries to leave the web directory still gets only the app.
    assert client.get("/..%2F..%2Fetc%2Fpasswd").text.startswith("<title>")


def test_api_paths_and_api_host_do_not_get_the_web_app(client):
    assert client.get("/portal/nope").status_code == 404
    assert client.get("/", headers={"host": API_HOST}).status_code == 404
    assert client.get("/portal/health", headers={"host": API_HOST}).status_code == 200


def test_installers_are_plain_text(client):
    r = client.get("/install/setup.sh")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/plain")
    assert client.get("/install/.hidden").status_code == 404
    assert client.get("/install/missing.sh").status_code == 404


def test_oidc_endpoints_pass_through_to_auth(client):
    discovery = client.get("/auth/v1/.well-known/openid-configuration")
    assert discovery.status_code == 200 and discovery.json()["issuer"] == f"{SUPABASE}/auth/v1"
    # Auth's own OAuth errors come back unchanged, and no apikey is needed.
    token = client.post("/auth/v1/oauth/token", data={"grant_type": "authorization_code"})
    assert token.status_code == 400 and "client" in token.text.lower()
    assert client.get("/auth/v1/oauth/userinfo").status_code == 401
    # An authorize redirect is handed back to the browser, not followed.
    authorize = client.get("/auth/v1/oauth/authorize", params={"client_id": "nope"}, follow_redirects=False)
    assert authorize.status_code in (302, 303, 400)
