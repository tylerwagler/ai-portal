"""The Valkey client keeps working after the server drops its connection."""

import os

from portal_api.main import connect_valkey

VALKEY = os.environ.get("TEST_VALKEY_URL", "redis://127.0.0.1:6390/0")


async def test_pipeline_survives_a_dropped_connection():
    valkey = connect_valkey(VALKEY)
    try:
        await valkey.set("test:reconnect", "1", ex=60)
        # Kill only this client's own connection, as a Valkey restart would.
        await connect_valkey(VALKEY).client_kill_filter(_id=await valkey.client_id())
        # Same shape as cli_login.start: a transaction on the now-dead pooled connection.
        async with valkey.pipeline(transaction=True) as pipe:
            pipe.set("test:reconnect", "2", ex=60)
            pipe.get("test:reconnect")
            assert (await pipe.execute())[1] == "2"
    finally:
        await valkey.delete("test:reconnect")
        await valkey.aclose()
