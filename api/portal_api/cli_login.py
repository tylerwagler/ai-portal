"""Device login for claude-local: the CLI shows a code, the user approves it in the portal,
and the CLI receives a new API key. The CLI never handles the user's password.

    CLI:     POST /portal/cli/start           -> device_code, user_code, verify_url
    Browser: POST /portal/cli/approve         (signed in; enters or confirms user_code)
    CLI:     POST /portal/cli/poll            -> pending, or the new API key (once)
"""

import json
import secrets

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from portal_api.deps import Resources, User, current_user, resources
from portal_api.keys import create_key

router = APIRouter(prefix="/portal/cli", tags=["cli"])

TTL_SECONDS = 600
POLL_INTERVAL = 3
# No 0/O or 1/I, so codes read back without mistakes.
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def user_code() -> str:
    raw = "".join(secrets.choice(CODE_ALPHABET) for _ in range(8))
    return f"{raw[:4]}-{raw[4:]}"


def normalize(code: str) -> str:
    raw = "".join(c for c in code.upper() if c.isalnum())
    return f"{raw[:4]}-{raw[4:]}"


class Start(BaseModel):
    device_name: str = Field(default="claude-local", max_length=80)


class Approve(BaseModel):
    user_code: str = Field(min_length=8, max_length=12)


class Poll(BaseModel):
    device_code: str = Field(min_length=20, max_length=100)


@router.post("/start")
async def start(body: Start, res: Resources = Depends(resources)):
    device = secrets.token_urlsafe(32)
    code = user_code()
    pending = json.dumps({"user_code": code, "device_name": body.device_name, "status": "pending"})
    async with res.valkey.pipeline(transaction=True) as pipe:
        pipe.set(f"cli:device:{device}", pending, ex=TTL_SECONDS)
        pipe.set(f"cli:code:{code}", device, ex=TTL_SECONDS)
        await pipe.execute()
    return {
        "device_code": device,
        "user_code": code,
        "verify_url": f"{res.settings.cli_verify_url}?code={code}",
        "expires_in": TTL_SECONDS,
        "interval": POLL_INTERVAL,
    }


@router.get("/pending/{code}")
async def describe(code: str, user: User = Depends(current_user), res: Resources = Depends(resources)):
    """What the approval page shows before the user confirms."""
    device = await res.valkey.get(f"cli:code:{normalize(code)}")
    record = device and await res.valkey.get(f"cli:device:{device}")
    if not record:
        raise HTTPException(404, "code expired or not found")
    data = json.loads(record)
    return {"user_code": data["user_code"], "device_name": data["device_name"], "status": data["status"]}


@router.post("/approve")
async def approve(body: Approve, user: User = Depends(current_user), res: Resources = Depends(resources)):
    code = normalize(body.user_code)
    # Take the code so it can be approved only once.
    device = await res.valkey.getdel(f"cli:code:{code}")
    record = device and await res.valkey.get(f"cli:device:{device}")
    if not record:
        raise HTTPException(404, "code expired or not found")
    data = json.loads(record)
    key = await create_key(res, user.id, data["device_name"])
    ttl = await res.valkey.ttl(f"cli:device:{device}")
    approved = json.dumps({**data, "status": "approved", "api_key": key["key"]})
    await res.valkey.set(f"cli:device:{device}", approved, ex=max(ttl, 1))
    return {"approved": True, "device_name": data["device_name"], "key_last4": key["last4"]}


@router.post("/poll")
async def poll(body: Poll, res: Resources = Depends(resources)):
    record = await res.valkey.get(f"cli:device:{body.device_code}")
    if not record:
        return JSONResponse({"status": "expired"}, status_code=410)
    data = json.loads(record)
    if data["status"] != "approved":
        return JSONResponse({"status": "pending", "interval": POLL_INTERVAL}, status_code=202)
    # Hand the key over once: only the poll that deletes the record gets it.
    if not await res.valkey.delete(f"cli:device:{body.device_code}"):
        return JSONResponse({"status": "expired"}, status_code=410)
    return {"status": "approved", "api_key": data["api_key"]}
