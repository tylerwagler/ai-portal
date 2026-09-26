"""Passes Supabase Auth's public OIDC endpoints through to Auth itself.

Supabase's API gateway demands an `apikey` on every /auth/v1 request, which browsers
and OAuth clients (Open WebUI) never send for these four endpoints. The tunnel routes
them here instead, and they are forwarded to Auth unchanged, minus the /auth/v1 prefix.
Redirects are passed back to the browser, not followed.
"""

import httpx
from fastapi import APIRouter, Depends, Request
from fastapi.responses import Response

from portal_api.deps import Resources, resources

router = APIRouter(tags=["oidc"])

# Request headers Auth needs; everything else (cookies, Cloudflare headers) stays behind.
FORWARD_REQUEST = ("authorization", "content-type", "accept", "user-agent")
# Response headers that matter to browsers and OAuth clients.
FORWARD_RESPONSE = ("content-type", "location", "cache-control", "pragma", "www-authenticate")


async def forward(request: Request, res: Resources, path: str) -> Response:
    headers = {k: v for k, v in request.headers.items() if k.lower() in FORWARD_REQUEST}
    headers["x-forwarded-proto"] = "https"
    if forwarded_for := request.headers.get("cf-connecting-ip") or request.headers.get("x-forwarded-for"):
        headers["x-forwarded-for"] = forwarded_for
    upstream = await res.http.request(
        request.method, f"{res.settings.supabase_auth_url}/{path}",
        params=request.query_params, headers=headers, content=await request.body())
    return Response(content=upstream.content, status_code=upstream.status_code,
                    headers={k: v for k, v in upstream.headers.items() if k.lower() in FORWARD_RESPONSE})


@router.get("/auth/v1/.well-known/openid-configuration")
async def discovery(request: Request, res: Resources = Depends(resources)):
    return await forward(request, res, ".well-known/openid-configuration")


@router.get("/auth/v1/oauth/authorize")
async def authorize(request: Request, res: Resources = Depends(resources)):
    return await forward(request, res, "oauth/authorize")


@router.post("/auth/v1/oauth/token")
async def token(request: Request, res: Resources = Depends(resources)):
    return await forward(request, res, "oauth/token")


@router.api_route("/auth/v1/oauth/userinfo", methods=["GET", "POST"])
async def userinfo(request: Request, res: Resources = Depends(resources)):
    return await forward(request, res, "oauth/userinfo")


def http_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=httpx.Timeout(15.0), follow_redirects=False)
