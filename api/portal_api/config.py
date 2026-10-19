"""Settings, read once from the environment."""

import os
from dataclasses import dataclass
from urllib.parse import urlparse


@dataclass(frozen=True)
class Settings:
    database_url: str
    valkey_url: str
    # Supabase Auth, as seen from portal-api (internal) and as named in tokens (public issuer).
    # The issuer may be a comma-separated list: while the public domain moves, sessions
    # from the old and the new account host are both valid.
    jwks_url: str
    jwt_issuer: str
    # Where users approve a CLI login.
    cli_verify_url: str
    run_usage_consumer: bool = True
    # Supabase Auth itself (not its gateway), for the public OIDC endpoints.
    supabase_auth_url: str = ""
    # Built web app and installer scripts; unset means not served.
    web_dir: str = ""
    install_dir: str = ""
    # Host name of the API; only /portal and /install are served there. Comma-separated
    # while the domain moves, like the dashboard host below.
    api_host: str = ""
    # The system dashboard (pulsar-gui): its public host(s), first preferred, and where it
    # runs; unset means off.
    dashboard_host: str = ""
    dashboard_upstream: str = ""
    # Microsoft Entra ID, the source of accounts, roles and plans (portal_api/entra_sync.py): the
    # tenant, an app registration that may read its groups and users, and the groups. Unset means
    # no sync, and the admin tab manages accounts as before.
    entra_tenant_id: str = ""
    entra_client_id: str = ""
    entra_client_secret: str = ""
    entra_users_group: str = ""
    entra_admins_group: str = ""
    # (group id, tier id) in order of precedence: a member of several gets the first.
    entra_plan_groups: tuple[tuple[str, str], ...] = ()
    entra_default_tier: str = "free"
    entra_sync_seconds: int = 300

    @property
    def entra_configured(self) -> bool:
        return bool(self.entra_tenant_id and self.entra_client_id and self.entra_client_secret
                    and self.entra_users_group)

    @property
    def jwt_issuers(self) -> list[str]:
        return _split(self.jwt_issuer)

    @property
    def api_hosts(self) -> frozenset[str]:
        return frozenset(_split(self.api_host))

    @property
    def dashboard_hosts(self) -> tuple[str, ...]:
        return tuple(_split(self.dashboard_host))

    def dashboard_host_for(self, host: str) -> str:
        """The dashboard host on the domain the request came in on, else the first."""
        hosts = self.dashboard_hosts
        domain = _domain(host)
        return next((h for h in hosts if _domain(h) == domain), hosts[0] if hosts else "")

    @property
    def account_host(self) -> str:
        """The portal's own host, where users sign in."""
        return urlparse(self.cli_verify_url).hostname or ""

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            database_url=os.environ["PORTAL_DATABASE_URL"],
            valkey_url=os.environ["PORTAL_VALKEY_URL"],
            jwks_url=os.environ["PORTAL_JWKS_URL"],
            jwt_issuer=os.environ["PORTAL_JWT_ISSUER"],
            cli_verify_url=os.environ["PORTAL_CLI_VERIFY_URL"],
            run_usage_consumer=os.environ.get("PORTAL_USAGE_CONSUMER", "1") == "1",
            supabase_auth_url=os.environ.get("PORTAL_SUPABASE_AUTH_URL", "").rstrip("/"),
            web_dir=os.environ.get("PORTAL_WEB_DIR", ""),
            install_dir=os.environ.get("PORTAL_INSTALL_DIR", ""),
            api_host=os.environ.get("PORTAL_API_HOST", ""),
            dashboard_host=os.environ.get("PORTAL_DASHBOARD_HOST", ""),
            dashboard_upstream=os.environ.get("PORTAL_DASHBOARD_UPSTREAM", "").rstrip("/"),
            entra_tenant_id=os.environ.get("PORTAL_ENTRA_TENANT_ID", ""),
            entra_client_id=os.environ.get("PORTAL_ENTRA_CLIENT_ID", ""),
            entra_client_secret=os.environ.get("PORTAL_ENTRA_CLIENT_SECRET", ""),
            entra_users_group=os.environ.get("PORTAL_ENTRA_USERS_GROUP", "").strip(),
            entra_admins_group=os.environ.get("PORTAL_ENTRA_ADMINS_GROUP", "").strip(),
            entra_plan_groups=_plan_groups(os.environ.get("PORTAL_ENTRA_PLAN_GROUPS", "")),
            entra_default_tier=os.environ.get("PORTAL_ENTRA_DEFAULT_TIER", "free"),
            entra_sync_seconds=int(os.environ.get("PORTAL_ENTRA_SYNC_SECONDS", "300")),
        )


def _plan_groups(value: str) -> tuple[tuple[str, str], ...]:
    """"<group id>=<tier id>,..." in order of precedence."""
    pairs = []
    for item in _split(value):
        group, _, tier = item.partition("=")
        if not group.strip() or not tier.strip():
            raise ValueError(f"PORTAL_ENTRA_PLAN_GROUPS: expected group=tier, got {item!r}")
        pairs.append((group.strip(), tier.strip()))
    return tuple(pairs)


def _split(value: str) -> list[str]:
    return [v.strip() for v in value.split(",") if v.strip()]


def _domain(host: str) -> str:
    """The registrable domain, as far as this deployment needs: the last two labels."""
    return ".".join(host.split(":")[0].lower().split(".")[-2:])
