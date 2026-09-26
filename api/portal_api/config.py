"""Settings, read once from the environment."""

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    database_url: str
    valkey_url: str
    # Supabase Auth, as seen from portal-api (internal) and as named in tokens (public issuer).
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
    # Host name of the API; only /portal and /install are served there.
    api_host: str = ""

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
        )
