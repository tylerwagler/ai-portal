"""Copies the gate's usage events from the Valkey stream into Postgres.

Reads `usage:events` as consumer group `portal`. Each batch is written in one transaction:
events are inserted once (keyed by stream id) and only newly inserted events are added to
the hourly rollups, so a batch that is retried after a crash is never counted twice.
Entries are acknowledged only after the transaction commits.
"""

import asyncio
import json
import logging
import socket

import asyncpg
import redis.asyncio as redis

log = logging.getLogger("portal_api.usage")

STREAM = "usage:events"
GROUP = "portal"
BATCH = 500
# How long one read waits for new entries. The Valkey client's socket timeout must exceed it.
BLOCK_MS = 5000
# Entries another consumer read but never acknowledged are taken over after this long.
CLAIM_IDLE_MS = 60_000

INSERT_BATCH = """
with batch as (
  select * from jsonb_to_recordset($1::jsonb) as e(
    stream_id text, ts bigint, user_id uuid, api_key_id uuid, via text, model text,
    input_tokens bigint, output_tokens bigint, cached_tokens bigint,
    cache_creation_tokens bigint, reasoning_tokens bigint, billable_tokens bigint,
    latency_ms integer, complete boolean, estimated boolean, chat_id text, request_class text,
    client_version text, client_entrypoint text, client_workload text)
),
inserted as (
  insert into public.usage_events (stream_id, ts, user_id, api_key_id, via, model,
    input_tokens, output_tokens, cached_tokens, cache_creation_tokens, reasoning_tokens,
    billable_tokens, latency_ms, complete, estimated, chat_id, request_class,
    client_version, client_entrypoint, client_workload)
  select b.stream_id, to_timestamp(b.ts), b.user_id,
         -- A key deleted since the request still bills the user.
         (select k.id from public.api_keys k where k.id = b.api_key_id),
         b.via, b.model, b.input_tokens, b.output_tokens, b.cached_tokens,
         b.cache_creation_tokens, b.reasoning_tokens, b.billable_tokens,
         b.latency_ms, b.complete, b.estimated, b.chat_id, b.request_class,
         b.client_version, b.client_entrypoint, b.client_workload
  from batch b
  where exists (select 1 from public.profiles p where p.id = b.user_id)
  on conflict (stream_id) do nothing
  returning ts, user_id, api_key_id, model, input_tokens, output_tokens, cached_tokens,
            cache_creation_tokens, reasoning_tokens, billable_tokens
)
insert into public.usage_rollups (hour, user_id, api_key_id, model, requests, input_tokens, output_tokens,
                                  cached_tokens, cache_creation_tokens, reasoning_tokens, billable_tokens)
select date_trunc('hour', ts), user_id, api_key_id, model, count(*),
       sum(input_tokens), sum(output_tokens), sum(cached_tokens),
       sum(cache_creation_tokens), sum(reasoning_tokens), sum(billable_tokens)
from inserted
group by 1, 2, 3, 4
on conflict (hour, user_id, api_key_id, model) do update set
  requests = usage_rollups.requests + excluded.requests,
  input_tokens = usage_rollups.input_tokens + excluded.input_tokens,
  output_tokens = usage_rollups.output_tokens + excluded.output_tokens,
  cached_tokens = usage_rollups.cached_tokens + excluded.cached_tokens,
  cache_creation_tokens = usage_rollups.cache_creation_tokens + excluded.cache_creation_tokens,
  reasoning_tokens = usage_rollups.reasoning_tokens + excluded.reasoning_tokens,
  billable_tokens = usage_rollups.billable_tokens + excluded.billable_tokens
"""

NUMBER_FIELDS = ("ts", "input_tokens", "output_tokens", "cached_tokens",
                 "cache_creation_tokens", "reasoning_tokens", "billable_tokens", "latency_ms")


def to_row(stream_id: str, fields: dict) -> dict:
    row = {"stream_id": stream_id, "user_id": fields["user_id"],
           "api_key_id": fields.get("api_key_id"), "via": fields["via"], "model": fields["model"],
           "complete": fields.get("complete") == "1", "estimated": fields.get("estimated") == "1",
           "chat_id": fields.get("chat_id"), "request_class": fields.get("request_class"),
           "client_version": fields.get("client_version"),
           "client_entrypoint": fields.get("client_entrypoint"),
           "client_workload": fields.get("client_workload")}
    for name in NUMBER_FIELDS:
        row[name] = int(fields.get(name) or 0)
    return row


async def ensure_group(valkey: redis.Redis) -> None:
    try:
        await valkey.xgroup_create(STREAM, GROUP, id="0", mkstream=True)
    except redis.ResponseError as e:
        if "BUSYGROUP" not in str(e):
            raise


async def write_batch(db: asyncpg.Pool, entries: list[tuple[str, dict]]) -> None:
    rows = [to_row(stream_id, fields) for stream_id, fields in entries]
    async with db.acquire() as conn, conn.transaction():
        await conn.execute(INSERT_BATCH, json.dumps(rows))


async def process_once(db: asyncpg.Pool, valkey: redis.Redis, consumer: str, block_ms: int = BLOCK_MS) -> int:
    """Reads, stores, and acknowledges one batch. Returns how many entries it handled."""
    _, claimed, _ = await valkey.xautoclaim(STREAM, GROUP, consumer, CLAIM_IDLE_MS, "0-0", count=BATCH)
    entries = list(claimed)
    if not entries:
        reply = await valkey.xreadgroup(GROUP, consumer, {STREAM: ">"}, count=BATCH, block=block_ms)
        entries = reply[0][1] if reply else []
    if not entries:
        return 0
    await write_batch(db, entries)
    await valkey.xack(STREAM, GROUP, *[stream_id for stream_id, _ in entries])
    return len(entries)


async def run(db: asyncpg.Pool, valkey: redis.Redis) -> None:
    consumer = socket.gethostname()
    await ensure_group(valkey)
    log.info("usage consumer %s reading %s", consumer, STREAM)
    while True:
        try:
            await process_once(db, valkey, consumer)
        except asyncio.CancelledError:
            raise
        except Exception:
            # Unacknowledged entries stay pending and are retried after CLAIM_IDLE_MS.
            log.exception("usage batch failed; retrying")
            await asyncio.sleep(5)
