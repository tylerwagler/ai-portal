FROM python:3.13-slim
COPY --from=ghcr.io/astral-sh/uv:0.12.2 /uv /bin/uv
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY portal_api ./portal_api
RUN uv sync --frozen --no-dev
RUN useradd --system --no-create-home portal
USER portal
EXPOSE 8200
CMD ["/app/.venv/bin/uvicorn", "portal_api.main:app", "--host", "0.0.0.0", "--port", "8200", "--proxy-headers", "--forwarded-allow-ips", "*"]
