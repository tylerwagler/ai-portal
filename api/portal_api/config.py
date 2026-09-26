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

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            database_url=os.environ["PORTAL_DATABASE_URL"],
            valkey_url=os.environ["PORTAL_VALKEY_URL"],
            jwks_url=os.environ["PORTAL_JWKS_URL"],
            jwt_issuer=os.environ["PORTAL_JWT_ISSUER"],
            cli_verify_url=os.environ["PORTAL_CLI_VERIFY_URL"],
            run_usage_consumer=os.environ.get("PORTAL_USAGE_CONSUMER", "1") == "1",
        )
