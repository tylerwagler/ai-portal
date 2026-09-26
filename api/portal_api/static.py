"""The portal web app and the claude-elytron installers, served by portal-api itself.

On the account host every unknown path returns the web app's index.html, so client-side
routes like /cli and /admin load. The API host serves only /portal and /install.
Registered last, so every API route wins over the catch-all.
"""

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse

from portal_api.deps import Resources, resources

router = APIRouter(tags=["static"])

# Shell and PowerShell scripts must reach curl and irm as plain text.
TEXT = "text/plain; charset=utf-8"


@router.get("/install/{name}")
async def installer(name: str, res: Resources = Depends(resources)):
    directory = res.settings.install_dir
    if not directory or "/" in name or name.startswith("."):
        raise HTTPException(404)
    path = Path(directory) / name
    if not path.is_file():
        raise HTTPException(404)
    return FileResponse(path, media_type=TEXT, headers={"Cache-Control": "no-cache"})


@router.get("/{path:path}")
async def web_app(path: str, request: Request, res: Resources = Depends(resources)):
    s = res.settings
    host = request.headers.get("host", "").split(":")[0]
    if not s.web_dir or (s.api_host and host == s.api_host) or path.startswith(("portal/", "auth/")):
        raise HTTPException(404)
    web = Path(s.web_dir).resolve()
    file = (web / path).resolve()
    if path and file.is_file() and web in file.parents:
        immutable = path.startswith("assets/")
        return FileResponse(file, headers={
            "Cache-Control": "public, max-age=31536000, immutable" if immutable else "no-cache"})
    return FileResponse(web / "index.html", headers={"Cache-Control": "no-cache"})
