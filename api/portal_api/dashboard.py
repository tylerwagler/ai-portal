"""The system dashboard (pulsar-gui) on its own host, for signed-in portal admins.

pulsar-gui has no login and uses absolute paths (/assets, /api, /ws), so it keeps its own
host name, and portal-api stands in front of every request to it:

    Portal:   POST /portal/dashboard/code          (admin, signed in) -> one-time code
    Browser:  GET  https://<dash host>/__auth?code  -> session cookie on the dash host only
    Browser:  anything else on the dash host        -> checked, then passed to pulsar-gui

A request without a valid session is sent to the portal's /dashboard page, which gets a
code and comes straight back, so a signed-in admin never sees a login.
"""

import asyncio
import contextlib
import secrets
from http.cookies import SimpleCookie

import websockets
from fastapi import APIRouter, Depends
from starlette.requests import Request
from starlette.responses import RedirectResponse, Response
from starlette.types import ASGIApp, Receive, Scope, Send
from starlette.websockets import WebSocket, WebSocketDisconnect

from portal_api.deps import Resources, User, admin_user, resources

router = APIRouter(prefix="/portal/dashboard", tags=["dashboard"])

CODE_TTL = 60
SESSION_TTL = 12 * 3600
COOKIE = "dash_session"
# Request headers pulsar-gui may see; the session cookie and Cloudflare headers stay here.
FORWARD_REQUEST = ("accept", "accept-encoding", "content-type", "user-agent", "if-none-match",
                   "if-modified-since")
FORWARD_RESPONSE = ("content-type", "content-encoding", "cache-control", "etag", "last-modified")


@router.post("/code")
async def code(user: User = Depends(admin_user), res: Resources = Depends(resources)):
    """A one-time code the browser trades for a dashboard session."""
    value = secrets.token_urlsafe(32)
    await res.valkey.set(f"dash:code:{value}", user.id, ex=CODE_TTL)
    return {"code": value, "url": f"https://{res.settings.dashboard_host}/__auth?code={value}"}


class DashboardHost:
    """Takes over every request for the dashboard host; other hosts pass through."""

    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send):
        if scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)
        res: Resources | None = getattr(scope["app"].state, "resources", None)
        host = dict(scope["headers"]).get(b"host", b"").decode().split(":")[0]
        if res is None or not res.settings.dashboard_host or host != res.settings.dashboard_host:
            return await self.app(scope, receive, send)
        if scope["type"] == "websocket":
            return await websocket_proxy(res, WebSocket(scope, receive, send))
        response = await http_proxy(res, Request(scope, receive))
        await response(scope, receive, send)


async def signed_in_admin(res: Resources, cookie_header: str) -> bool:
    """The session is live and its user is still an active admin."""
    cookie = SimpleCookie(cookie_header)
    if COOKIE not in cookie:
        return False
    user_id = await res.valkey.get(f"dash:session:{cookie[COOKIE].value}")
    if not user_id:
        return False
    row = await res.db.fetchrow(
        "select role, status from public.profiles where id = $1::uuid", user_id)
    return row is not None and row["role"] == "admin" and row["status"] == "active"


def login_redirect(res: Resources) -> Response:
    return RedirectResponse(f"https://{res.settings.account_host}/dashboard", status_code=302)


async def http_proxy(res: Resources, request: Request) -> Response:
    if request.url.path == "/__auth":
        return await start_session(res, request)
    if not await signed_in_admin(res, request.headers.get("cookie", "")):
        # Only page loads are redirected; the app's own calls just fail until it reloads.
        if request.method == "GET" and not request.url.path.startswith("/api/"):
            return login_redirect(res)
        return Response("sign in required", status_code=401)
    headers = {k: v for k, v in request.headers.items() if k.lower() in FORWARD_REQUEST}
    upstream = await res.http.request(
        request.method, f"{res.settings.dashboard_upstream}{request.url.path}",
        params=request.query_params, headers=headers, content=await request.body())
    return Response(content=upstream.content, status_code=upstream.status_code,
                    headers={k: v for k, v in upstream.headers.items()
                             if k.lower() in FORWARD_RESPONSE})


async def start_session(res: Resources, request: Request) -> Response:
    code = request.query_params.get("code", "")
    user_id = await res.valkey.getdel(f"dash:code:{code}") if code else None
    if not user_id:
        return login_redirect(res)
    session = secrets.token_urlsafe(32)
    await res.valkey.set(f"dash:session:{session}", user_id, ex=SESSION_TTL)
    response = RedirectResponse("/", status_code=302)
    # Host-only: the cookie never leaves the dashboard host.
    response.set_cookie(COOKIE, session, max_age=SESSION_TTL, secure=True, httponly=True,
                        samesite="lax", path="/")
    return response


async def websocket_proxy(res: Resources, client: WebSocket):
    if client.url.path != "/ws" or not await signed_in_admin(res, client.headers.get("cookie", "")):
        await client.close(code=4401)
        return
    target = res.settings.dashboard_upstream.replace("http", "ws", 1) + "/ws"
    try:
        async with websockets.connect(target, open_timeout=10) as upstream:
            await client.accept()

            async def to_upstream():
                with contextlib.suppress(WebSocketDisconnect):
                    while True:
                        await upstream.send(await client.receive_text())

            async def to_client():
                async for message in upstream:
                    if isinstance(message, bytes):
                        await client.send_bytes(message)
                    else:
                        await client.send_text(message)

            tasks = [asyncio.create_task(to_upstream()), asyncio.create_task(to_client())]
            _, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
    except (OSError, websockets.WebSocketException):
        pass
    with contextlib.suppress(RuntimeError):
        await client.close()

