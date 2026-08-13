# AI Portal

A management portal for a local AI inference stack. Users sign in through Supabase auth, manage API keys and billing, chat against locally hosted LLMs (llama.cpp / vLLM), and — for admins — monitor real-time GPU telemetry, manage users, tiers, and the model catalog across two inference hosts.

The portal doubles as a PWA ("TemperView") with live GPU/host metrics, and ships a `claude-local` wrapper that runs Claude Code against the local stack instead of Anthropic's API.

- **Version:** 0.1.0-alpha
- **Tech:** React 19 · TypeScript 5.9 · Vite 7 · Tailwind CSS 4 · Vitest 2 · React Query (Tanstack) · Supabase · Recharts · Nginx proxy

---

## Features

| Area | What it does |
|------|--------------|
| **AI Chat** | Streams chat completions from the local stack (`/llama/v1/chat/completions`) with thinking-tag rendering, token metrics, and persisted chat sessions |
| **API Keys** | Create/list/delete keys (`sk_ai_...`), per-key and per-user token usage, tier/limit usage bars with reset timers |
| **Billing** | Upgrade to Pro/Ultimate plans via Stripe checkout, manage payment portal |
| **Account Settings** | Display name + timezone updates against the `profiles` table |
| **Hardware (admin)** | "TemperView" GPU dashboard — per-GPU cards (load, temp, fan, power, clocks, PCIe, NVLink), host metrics, live AI-service metrics, details modal |
| **Models (admin)** | Side-by-side model manager for **Ellie** (llama.cpp) and **Sparky** (vLLM): load/unload/update containers, VRAM estimation, parameter panels (ctx, parallel, KV cache), container logs, HuggingFace update checks |
| **User / Tier Management (admin)** | Admin directory with search, role/tier/subscription editing, usage logs; tier create/edit/delete with token limits |

## Architecture

```
index.html ── main.tsx ── App.tsx (React Query Client + ErrorBoundary)
                          └── Portal.tsx  — tab router (chat / keys / billing / settings / hardware / users / tiers / models)
                              ├── components/portal/  — ChatInterface, UserManager, TierManager
                              ├── components/        — ModelManager, GPUDashboard, GPUDetailsModal, SettingsPage, ...
                              ├── components/charts/  — per-metric GPU cards
                              └── api/               — gpuApi, modelApi, managerApi
```

- **Telemetry:** `src/api/gpuApi.ts` aggregates `.../metrics` from hosts read from `localStorage` (`temper_remote_hosts`), falling back to `VITE_GPU_API_BASE` then `/api` + `/api/sparky`. Invalid JSON (`inf`/`nan`) is sanitized to `null` before parsing.
- **Model manager:** `src/api/managerApi.ts` talks to `/api/ellie/*` and `/api/sparky/*` endpoints (catalog, running, load, unload, logs, updates) using the Supabase session JWT.
- **Supabase:** `src/lib/supabase.ts` creates a client against the nginx-proxied origin using `VITE_SUPABASE_ANON_KEY` (build-time env; the app **throws** if unset).
- **Nginx proxy (`nginx.conf`):** routes Supabase auth/rest, host-metrics, Sparky metrics, ai-proxy (`/api/*`), Stripe billing, and user-authenticated `/llama/*` chat; also serves `/install/*` scripts and applies security headers + CSP.

## Getting started

**Prerequisites:** `VITE_SUPABASE_ANON_KEY` must be set — in `.env.local` for development or as a Docker build arg for production. `VITE_GPU_API_BASE` is optional (used as a fallback telemetry host).

```bash
# Development
npm install
npm run dev          # Vite server on port 3000

# Build
npm run build        # tsc && vite build → dist/

# Preview
npm run preview

# Tests (Vitest + jsdom)
npm run test         # watch mode
npm run test:run     # one-shot
npm run test:coverage
npm run test:ui      # Vitest UI inspector
```

See `.env.example` for the available environment variables.

## Deployment

Two-stage Docker build (`Dockerfile`):

```bash
# Pass the Supabase anon key at build time
docker build --build-arg VITE_SUPABASE_ANON_KEY=... -t ai-portal .
```

The nginx image serves `dist/` and applies `nginx.conf` (security headers, CSP, dynamic DNS resolution, and all API/chat/Supabase/Stripe proxy rules). The install scripts for `claude-local` are served from `/install/`.

## Using `claude-local` (Claude Code on the local stack)

After signing in, the API Keys tab shows one-line installs:

```bash
# Linux / macOS
curl -fsSL https://<portal>/install/setup.sh | bash

# Windows (PowerShell)
irm https://<portal>/install/setup.ps1 | iex
```

Then:

```bash
claude-local --login   # authenticate, create/select an API key
claude-local           # start Claude Code against the local AI stack
```

The wrapper stores config in `~/.config/claude-local/env`, sets `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY`, auto-selects a ready model, and validates the key against `/api/v1/models`.

## Project structure (key files)

```
.env.example            Environment variables (VITE_GPU_API_BASE, VITE_SUPABASE_ANON_KEY)
Dockerfile              node:20-alpine build → nginx:alpine serve
nginx.conf              Proxy/security config for the deployed portal
React19_Migration.md    React 19 upgrade guide (completed)
Security_Audit.md       Prior security audit + remediation plan
src/App.tsx             QueryClientProvider + ErrorBoundary wrapper
src/main.tsx            Root render entry
src/components/portal/Portal.tsx   Tab router (chat/keys/billing/settings/hardware/users/tiers/models)
src/components/                   GPU dashboard, model manager, settings, error boundary
src/components/charts/             Per-metric GPU/host cards
src/api/                gpuApi / modelApi / managerApi
src/lib/supabase.ts     Supabase client factory (env-keyed)
src/types/gpu.ts        Temper GPU metric / slot / AI-service types
src/test/               Vitest setup, mocks, utils
public/                 PWA assets (manifest, sw.js, icons) + install scripts
```

## Related documentation

- `React19_Migration.md` — React 18 → 19 migration plan (low-risk, already applied)
- `Security_Audit.md` — dated security audit (1.8/10 critical) with the remediation plan that the recent `security:` commits were built from

## Notes

- Admin-only tabs (Hardware, Users, Tiers, Models) are gated on `profile.role === 'admin'`.
- The "WebChat" API key is required by the chat interface and cannot be deleted.
- `src/counter.ts`, `src/main.ts`, `src/test.tsx` are template/legacy files excluded from test coverage.
- Tests mock `localStorage` and `global.fetch`; coverage thresholds are configured in `vitest.config.ts`.
