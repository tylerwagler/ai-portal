"""Shared resources and the signed-in user, as FastAPI dependencies."""

import asyncio
from dataclasses import dataclass

import asyncpg
import httpx
import jwt
import redis.asyncio as redis
from fastapi import Depends, HTTPException, Request

from portal_api.config import Settings


@dataclass
class Resources:
    settings: Settings
    db: asyncpg.Pool
    valkey: redis.Redis
    jwks: jwt.PyJWKClient
    http: httpx.AsyncClient


@dataclass
class User:
    id: str
    email: str
    role: str
    status: str
    tier_id: str

    @property
    def is_admin(self) -> bool:
        return self.role == "admin" and self.status == "active"


def resources(request: Request) -> Resources:
    return request.app.state.resources


async def current_user(request: Request, res: Resources = Depends(resources)) -> User:
    """The caller, from their Supabase session token. Disabled accounts are refused."""
    header = request.headers.get("authorization", "")
    if not header.startswith("Bearer "):
        raise HTTPException(401, "sign in required")
    token = header.removeprefix("Bearer ").strip()
    try:
        # The JWKS client fetches over HTTP on a cache miss; keep that off the event loop.
        key = await asyncio.to_thread(res.jwks.get_signing_key_from_jwt, token)
        claims = jwt.decode(token, key.key, algorithms=["ES256", "RS256"],
                            audience="authenticated", issuer=res.settings.jwt_issuer)
    except jwt.PyJWTError as e:
        raise HTTPException(401, f"invalid session: {e}") from None
    row = await res.db.fetchrow(
        "select id::text, email, role, status, tier_id from public.profiles where id = $1::uuid",
        claims["sub"])
    if row is None:
        raise HTTPException(401, "no profile for this account")
    user = User(**dict(row))
    if user.status != "active":
        raise HTTPException(403, "account disabled")
    return user


async def admin_user(user: User = Depends(current_user)) -> User:
    if not user.is_admin:
        raise HTTPException(403, "admin access required")
    return user
