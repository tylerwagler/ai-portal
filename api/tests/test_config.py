"""Settings that take a list while the public domain moves. No services needed."""

from portal_api.config import Settings

BASE = dict(database_url="postgresql://x", valkey_url="redis://x", jwks_url="https://x/jwks",
            cli_verify_url="https://account.elytrondefense.ai/cli")


def test_a_single_value_reads_as_before():
    s = Settings(**BASE, jwt_issuer="https://account.elytrondefense.com/auth/v1",
                 api_host="api.elytrondefense.com", dashboard_host="dash.elytrondefense.com")
    assert s.jwt_issuers == ["https://account.elytrondefense.com/auth/v1"]
    assert s.api_hosts == {"api.elytrondefense.com"}
    assert s.dashboard_hosts == ("dash.elytrondefense.com",)
    assert s.dashboard_host_for("account.elytrondefense.ai") == "dash.elytrondefense.com"


def test_both_domains_while_moving():
    s = Settings(**BASE,
                 jwt_issuer=" https://account.elytrondefense.ai/auth/v1 , https://account.elytrondefense.com/auth/v1",
                 api_host="api.elytrondefense.ai,api.elytrondefense.com",
                 dashboard_host="dash.elytrondefense.ai, dash.elytrondefense.com")
    assert s.jwt_issuers == ["https://account.elytrondefense.ai/auth/v1",
                             "https://account.elytrondefense.com/auth/v1"]
    assert s.api_hosts == {"api.elytrondefense.ai", "api.elytrondefense.com"}
    # The dashboard link follows the domain the portal is used from; anything else gets the first.
    assert s.dashboard_host_for("account.elytrondefense.com") == "dash.elytrondefense.com"
    assert s.dashboard_host_for("account.elytrondefense.ai:443") == "dash.elytrondefense.ai"
    assert s.dashboard_host_for("10.20.20.211:8200") == "dash.elytrondefense.ai"


def test_unset_hosts_are_empty():
    s = Settings(**BASE, jwt_issuer="https://a/auth/v1")
    assert s.api_hosts == frozenset() and s.dashboard_hosts == ()
    assert s.dashboard_host_for("anything") == ""
