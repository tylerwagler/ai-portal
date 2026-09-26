"""portal-api application: routers, shared resources, and the usage consumer."""

import asyncio
import contextlib
import logging
from contextlib import asynccontextmanager

import asyncpg
import jwt
import redis.asyncio as redis
from fastapi import FastAPI

from portal_api import admin, cli_login, keys, me, oidc_proxy, static, usage_consumer
from portal_api.config import Settings
from portal_api.deps import Resources


def create_app(settings: Settings | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        s = settings or Settings.from_env()
        db = await asyncpg.create_pool(s.database_url, min_size=1, max_size=10)
        # redis-py defaults to a 5 s socket timeout, which a blocking stream read would hit.
        valkey = redis.from_url(s.valkey_url, decode_responses=True,
                                socket_timeout=usage_consumer.BLOCK_MS / 1000 + 10)
        app.state.resources = Resources(settings=s, db=db, valkey=valkey,
                                        jwks=jwt.PyJWKClient(s.jwks_url, cache_keys=True, lifespan=3600),
                                        http=oidc_proxy.http_client())
        consumer = asyncio.create_task(usage_consumer.run(db, valkey)) if s.run_usage_consumer else None
        try:
            yield
        finally:
            if consumer:
                consumer.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await consumer
            await app.state.resources.http.aclose()
            await valkey.aclose()
            await db.close()

    app = FastAPI(title="AI Portal API", lifespan=lifespan, docs_url=None, redoc_url=None,
                  openapi_url=None)
    for module in (me, keys, cli_login, admin, oidc_proxy):
        app.include_router(module.router)

    @app.get("/portal/health")
    async def health():
        return {"ok": True}

    # Last: its catch-all must not shadow any API route.
    app.include_router(static.router)
    return app


logging.basicConfig(level=logging.INFO)
app = create_app()
