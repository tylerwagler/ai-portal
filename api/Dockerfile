# portal-api with the built web app and the installers. Context: repository root.
FROM node:22-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web ./
# Public values only (publishable key, OAuth client ids, URLs).
ARG VITE_SUPABASE_KEY
ARG VITE_FIRST_PARTY_CLIENTS=""
ARG VITE_API_URL=https://api.elytrondefense.com
ARG VITE_CHAT_URL=https://ai.elytrondefense.com
RUN test -n "$VITE_SUPABASE_KEY" && npm run build

FROM python:3.13-slim
COPY --from=ghcr.io/astral-sh/uv:0.12.2 /uv /bin/uv
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy
COPY api/pyproject.toml api/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY api/portal_api ./portal_api
RUN uv sync --frozen --no-dev
COPY --from=web /web/dist ./web
COPY deploy/install ./install
RUN useradd --system --no-create-home portal
USER portal
ENV PORTAL_WEB_DIR=/app/web PORTAL_INSTALL_DIR=/app/install
EXPOSE 8200
CMD ["/app/.venv/bin/uvicorn", "portal_api.main:app", "--host", "0.0.0.0", "--port", "8200", "--proxy-headers", "--forwarded-allow-ips", "*"]
