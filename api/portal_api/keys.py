"""API keys: list, create (the key is shown once), rename, revoke.

Only a SHA-256 hash of each key is stored. The gate caches key lookups for 30 seconds,
so a revoked key can keep working for up to that long.
"""

import hashlib
import secrets

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from portal_api.deps import Resources, User, current_user, resources

router = APIRouter(prefix="/portal/keys", tags=["keys"])

KEY_PREFIX = "sk_ai_"


def new_key() -> str:
    return KEY_PREFIX + secrets.token_urlsafe(32)


def hash_key(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()


async def create_key(res: Resources, user_id: str, name: str) -> dict:
    key = new_key()
    row = await res.db.fetchrow(
        """insert into public.api_keys (user_id, name, key_hash, prefix, last4)
           values ($1::uuid, $2, $3, $4, $5)
           returning id::text, name, prefix, last4, created_at""",
        user_id, name, hash_key(key), KEY_PREFIX, key[-4:])
    return {**dict(row), "key": key}


class NewKey(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class Rename(BaseModel):
    name: str = Field(min_length=1, max_length=80)


@router.get("")
async def list_keys(user: User = Depends(current_user), res: Resources = Depends(resources)):
    rows = await res.db.fetch(
        """select id::text, name, prefix, last4, created_at, last_used_at
           from public.api_keys where user_id = $1::uuid and revoked_at is null
           order by created_at desc""", user.id)
    return [dict(r) for r in rows]


@router.post("", status_code=201)
async def add_key(body: NewKey, user: User = Depends(current_user), res: Resources = Depends(resources)):
    return await create_key(res, user.id, body.name)


@router.patch("/{key_id}")
async def rename_key(key_id: str, body: Rename, user: User = Depends(current_user),
                     res: Resources = Depends(resources)):
    done = await res.db.execute(
        """update public.api_keys set name = $3
           where id = $1::uuid and user_id = $2::uuid and revoked_at is null""",
        key_id, user.id, body.name)
    if done == "UPDATE 0":
        raise HTTPException(404, "no such key")
    return {"id": key_id, "name": body.name}


@router.delete("/{key_id}", status_code=204)
async def revoke_key(key_id: str, user: User = Depends(current_user), res: Resources = Depends(resources)):
    done = await res.db.execute(
        """update public.api_keys set revoked_at = now()
           where id = $1::uuid and (user_id = $2::uuid or $3) and revoked_at is null""",
        key_id, user.id, user.is_admin)
    if done == "UPDATE 0":
        raise HTTPException(404, "no such key")
