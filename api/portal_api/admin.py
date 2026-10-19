"""Admin: accounts, plans and the Entra sync. Changes reach the gate within its 30-second cache.

With the Entra sync configured, people's role, plan and status come from Entra groups: changing
them here is refused (change the group membership instead). Local accounts (service accounts) and
the plans themselves are still managed here."""

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from portal_api import entra_sync
from portal_api.deps import Resources, User, admin_user, resources

router = APIRouter(prefix="/portal/admin", tags=["admin"])


class UserChange(BaseModel):
    role: Literal["pending", "user", "admin"] | None = None
    status: Literal["active", "disabled"] | None = None
    tier_id: str | None = None


class Tier(BaseModel):
    id: str = Field(pattern=r"^[a-z0-9_-]{1,40}$")
    display_name: str = Field(min_length=1, max_length=80)
    description: str | None = None
    price_monthly_cents: int = Field(default=0, ge=0)
    stripe_price_id: str | None = None
    rate_limit_rpm: int | None = Field(default=None, ge=0)
    rate_limit_tpm: int | None = Field(default=None, ge=0)
    hourly_limit: int | None = Field(default=None, ge=0)
    daily_limit: int | None = Field(default=None, ge=0)
    weekly_limit: int | None = Field(default=None, ge=0)
    monthly_limit: int | None = Field(default=None, ge=0)


@router.get("/users")
async def list_users(q: str = "", limit: int = 100, _: User = Depends(admin_user),
                     res: Resources = Depends(resources)):
    rows = await res.db.fetch(
        """select p.id::text, p.email, p.display_name, p.role, p.status, p.disabled_by, p.tier_id,
                  p.created_at, p.entra_oid is not null as entra_linked, p.local,
                  coalesce(sum(r.billable_tokens), 0)::bigint as tokens_30d,
                  coalesce(sum(r.requests), 0)::bigint as requests_30d
           from public.profiles p
           left join public.usage_rollups r on r.user_id = p.id and r.hour >= now() - interval '30 days'
           where $1 = '' or p.email ilike '%' || $1 || '%' or p.display_name ilike '%' || $1 || '%'
           group by p.id order by p.created_at desc limit $2""", q, min(max(limit, 1), 500))
    return [dict(r) for r in rows]


@router.patch("/users/{user_id}")
async def change_user(user_id: str, body: UserChange, admin: User = Depends(admin_user),
                      res: Resources = Depends(resources)):
    if user_id == admin.id and (body.role not in (None, "admin") or body.status == "disabled"):
        raise HTTPException(400, "you cannot remove your own admin access")
    if res.entra is not None:
        local = await res.db.fetchval("select local from public.profiles where id = $1::uuid", user_id)
        if local is None:
            raise HTTPException(404, "no such user")
        if not local:
            raise HTTPException(409, "managed in Entra: change this person's groups (AI Users, AI Admins, "
                                     "AI Plan - ...) in Entra; the portal follows within minutes")
    changes = body.model_dump(exclude_none=True)
    if not changes:
        raise HTTPException(400, "nothing to change")
    if "status" in changes:
        # The Entra sync re-enables only accounts it disabled itself, never these.
        changes["disabled_by"] = "admin" if changes["status"] == "disabled" else None
    sets = ", ".join(f"{column} = ${i}" for i, column in enumerate(changes, start=2))
    try:
        row = await res.db.fetchrow(
            f"update public.profiles set {sets}, updated_at = now() where id = $1::uuid "
            "returning id::text, email, role, status, disabled_by, tier_id", user_id, *changes.values())
    except Exception as e:  # unknown tier_id violates the foreign key
        raise HTTPException(400, str(e).splitlines()[0]) from None
    if row is None:
        raise HTTPException(404, "no such user")
    return dict(row)


@router.get("/tiers")
async def list_tiers(_: User = Depends(admin_user), res: Resources = Depends(resources)):
    return [dict(r) for r in await res.db.fetch("select * from public.tiers order by price_monthly_cents, id")]


@router.put("/tiers/{tier_id}")
async def put_tier(tier_id: str, body: Tier, _: User = Depends(admin_user), res: Resources = Depends(resources)):
    if body.id != tier_id:
        raise HTTPException(400, "tier id in path and body differ")
    t = body.model_dump()
    columns = list(t)
    values = ", ".join(f"${i}" for i in range(1, len(columns) + 1))
    updates = ", ".join(f"{c} = excluded.{c}" for c in columns if c != "id")
    row = await res.db.fetchrow(
        f"insert into public.tiers ({', '.join(columns)}) values ({values}) "
        f"on conflict (id) do update set {updates} returning *", *t.values())
    return dict(row)


@router.get("/entra")
async def entra_status(_: User = Depends(admin_user), res: Resources = Depends(resources)):
    row = await res.db.fetchrow("select * from public.entra_sync")
    s = res.settings
    return {"configured": res.entra is not None, "last": dict(row) if row else None,
            "default_tier": s.entra_default_tier, "plan_groups": [t for _, t in s.entra_plan_groups]}


@router.post("/entra/sync")
async def entra_sync_now(_: User = Depends(admin_user), res: Resources = Depends(resources)):
    if res.entra is None:
        raise HTTPException(409, "the Entra sync is not configured")
    return await entra_sync.sync_once(res.db, res.entra, res.settings.entra_default_tier)
