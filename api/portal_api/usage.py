"""Live usage against plan limits, read from the gate's Valkey counters.

The window numbers and key names must match switchyard-gate's `quota.rs` exactly:
fixed UTC windows (minute, hour, day, week from Monday, calendar month).
"""

import time
from datetime import UTC, datetime

WEEK_OFFSET = 3 * 86_400  # Unix day 0 was a Thursday; this starts weeks on Monday.


def windows(now: int) -> dict[str, int]:
    d = datetime.fromtimestamp(now, UTC)
    return {
        "minute": now // 60,
        "hour": now // 3600,
        "day": now // 86_400,
        "week": (now + WEEK_OFFSET) // (7 * 86_400),
        "month": d.year * 12 + (d.month - 1),
    }


def resets_at(now: int) -> dict[str, int]:
    w = windows(now)
    d = datetime.fromtimestamp(now, UTC)
    next_month = datetime(d.year + (d.month == 12), d.month % 12 + 1, 1, tzinfo=UTC)
    return {
        "minute": (w["minute"] + 1) * 60,
        "hour": (w["hour"] + 1) * 3600,
        "day": (w["day"] + 1) * 86_400,
        "week": (w["week"] + 1) * 7 * 86_400 - WEEK_OFFSET,
        "month": int(next_month.timestamp()),
    }


# (window, gate counter key part, tier limit column)
TOKEN_WINDOWS = [
    ("minute", "tm", "rate_limit_tpm"),
    ("hour", "th", "hourly_limit"),
    ("day", "td", "daily_limit"),
    ("week", "tw", "weekly_limit"),
    ("month", "tmo", "monthly_limit"),
]


async def live_usage(valkey, user_id: str, tier: dict, now: int | None = None) -> dict:
    now = int(time.time()) if now is None else now
    w = windows(now)
    resets = resets_at(now)
    keys = [f"q:{user_id}:rm:{w['minute']}"] + [f"q:{user_id}:{part}:{w[name]}" for name, part, _ in TOKEN_WINDOWS]
    values = await valkey.mget(keys)
    used = [int(v or 0) for v in values]
    out = {"requests_per_minute": {"used": used[0], "limit": tier.get("rate_limit_rpm"), "resets_at": resets["minute"]}}
    for (name, _, column), value in zip(TOKEN_WINDOWS, used[1:]):
        label = "tokens_per_minute" if name == "minute" else f"tokens_{name}"
        out[label] = {"used": value, "limit": tier.get(column), "resets_at": resets[name]}
    return out
