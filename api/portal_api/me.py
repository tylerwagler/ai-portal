"""The signed-in user's account: profile, plan, live usage, and recent history."""

from fastapi import APIRouter, Depends

from portal_api.deps import Resources, User, current_user, resources
from portal_api.usage import live_usage

router = APIRouter(prefix="/portal", tags=["me"])


async def tier_row(res: Resources, tier_id: str) -> dict:
    row = await res.db.fetchrow("select * from public.tiers where id = $1", tier_id)
    return dict(row) if row else {}


@router.get("/me")
async def me(user: User = Depends(current_user), res: Resources = Depends(resources)):
    tier = await tier_row(res, user.tier_id)
    return {
        "user": {"id": user.id, "email": user.email, "role": user.role},
        "plan": {k: tier.get(k) for k in ("id", "display_name", "description", "price_monthly_cents")},
        "usage": await live_usage(res.valkey, user.id, tier),
    }


@router.get("/me/usage/daily")
async def daily_usage(days: int = 30, user: User = Depends(current_user), res: Resources = Depends(resources)):
    """Tokens per day and model, from the hourly rollups."""
    rows = await res.db.fetch(
        """select date_trunc('day', hour)::date as day, model,
                  sum(requests)::bigint as requests,
                  sum(input_tokens)::bigint as input_tokens,
                  sum(output_tokens)::bigint as output_tokens,
                  sum(cached_tokens)::bigint as cached_tokens
           from public.usage_rollups
           where user_id = $1::uuid and hour >= now() - make_interval(days => $2)
           group by 1, 2 order by 1, 2""", user.id, min(max(days, 1), 366))
    return [dict(r) for r in rows]
