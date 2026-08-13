# AI Portal

A management portal for a local AI inference stack. Users sign in through Supabase auth, manage API keys and billing, chat against locally hosted LLMs (llama.cpp / vLLM), and — for admins — monitor real-time GPU telemetry, manage users, tiers, and the model catalog across two inference hosts.

The portal doubles as a PWA ("TemperView") with live GPU/host metrics, and ships a `claude-local` wrapper that runs Claude Code against the local stack instead of Anthropic's API.

- **Version:** 0.1.0-alpha
- **Requires:** Node.js **26+**
- **Tech:** React 19 · TypeScript 7 · Vite 7 · Tailwind CSS 4 · Vitest 4 · React Query (TanStack) · Supabase · Recharts · Nginx proxy

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
                              ├── api/               — gpuApi, modelApi, managerApi
                              └── lib/               — supabase client, SSE decoder
```

There is no router library — `Portal.tsx` switches sections from component state.

- **Telemetry:** `src/api/gpuApi.ts` aggregates `.../metrics` from hosts read from `localStorage` (`temper_remote_hosts`), falling back to `VITE_GPU_API_BASE` then `/api` + `/api/sparky`. Invalid JSON (`inf`/`nan`) is sanitized to `null` before parsing.
- **Model manager:** `src/api/managerApi.ts` talks to `/api/ellie/*` and `/api/sparky/*` endpoints (catalog, running, load, unload, logs, updates) using the Supabase session JWT. All endpoints are authenticated.
- **Chat streaming:** `src/lib/sse.ts` decodes the SSE stream, buffering partial frames across network chunks so no tokens are lost.
- **Supabase:** `src/lib/supabase.ts` creates a client against the nginx-proxied origin using `VITE_SUPABASE_ANON_KEY` (build-time env; the app **throws** if unset).
- **Nginx proxy (`nginx.conf`):** routes Supabase auth/rest, host-metrics, Sparky metrics, ai-proxy (`/api/*`), Stripe billing, and user-authenticated `/llama/*` chat; also serves `/install/*` scripts and applies security headers + CSP.

## Getting started

**Prerequisites:** Node.js 26 or newer. `VITE_SUPABASE_ANON_KEY` must be set — in `.env.local` for development or as a Docker build arg for production. `VITE_GPU_API_BASE` is optional (used as a fallback telemetry host).

> The test suite requires Node 26+. jsdom 30 fails to initialise on older runtimes (`webidl.util.markAsUncloneable is not a function`) before any test runs.

```bash
# Development
npm install
npm run dev          # Vite server on port 3000

# Build (typecheck → bundle → verify)
npm run build

# Type-check only
npm run typecheck

# Preview
npm run preview

# Tests (Vitest + jsdom)
npm run test         # watch mode
npm run test:run     # one-shot
npm run test:coverage
npm run test:ui      # Vitest UI inspector
```

See `.env.example` for the available environment variables.

### About the build guard

`npm run build` runs `scripts/verify-build.mjs` as a `postbuild` step. It checks that the emitted bundle still contains the application's own code and meets a size floor.

This is not ceremony. Upgrading to Vite 8 produced a build that **exited 0, passed every test, and shipped a bundle with all application modules stripped out** — only vendor code remained. The test suite cannot catch this, because Vitest transforms modules itself and never loads the built output. Keep Vite on 7.x, and keep the guard.

## Deployment

Two-stage Docker build (`Dockerfile`), `node:26-alpine` → `nginx:alpine`:

```bash
# Pass the Supabase anon key at build time
docker build --build-arg VITE_SUPABASE_ANON_KEY=... -t ai-portal .
```

The nginx image serves `dist/` and applies `nginx.conf` (security headers, CSP, dynamic DNS resolution, and all API/chat/Supabase/Stripe proxy rules). The install scripts for `claude-local` are served from `/install/`.

> **Note:** the stack runs on Proxmox (`pve1` / `pve2`, with Ellie as a VM) and is moving from Docker/compose toward LXCs. The compose-style upstream names in `nginx.conf` (`ai-supabase-kong`, `host-metrics`, `ai-proxy`, `stripe-handler`) will need revisiting when that migration happens. Nothing in this repo has been migrated yet.

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
.dockerignore           Keeps node_modules/.env out of the image build context
.env.example            Environment variables (VITE_GPU_API_BASE, VITE_SUPABASE_ANON_KEY)
Dockerfile              node:26-alpine build → nginx:alpine serve
nginx.conf              Proxy/security config for the deployed portal
scripts/verify-build.mjs  Postbuild guard — asserts app code is present in dist/
React19_Migration.md    React 19 upgrade guide (completed)
Security_Audit.md       Prior security audit + remediation plan
src/App.tsx             QueryClientProvider + ErrorBoundary wrapper
src/App.css             Tailwind v4 entrypoint + @theme (colors, keyframes)
src/main.tsx            Root render entry
src/components/portal/Portal.tsx   Tab router
src/components/                   GPU dashboard, model manager, settings, error boundary
src/components/charts/             Per-metric GPU/host cards
src/api/                gpuApi / modelApi / managerApi
src/lib/supabase.ts     Supabase client factory (env-keyed)
src/lib/sse.ts          Buffered Server-Sent Events decoder
src/types/gpu.ts        Temper GPU metric / slot / AI-service types
src/test/               Vitest setup and utils
public/                 PWA assets (manifest, sw.js, icons) + install scripts
```

## Styling

Tailwind CSS 4 with **CSS-first configuration**. There is no `tailwind.config.js`; the theme (colors such as `dark-900` / `accent-cyan`, plus keyframes and animations) is defined in the `@theme` block of `src/App.css`. Tailwind 4 ignores a JS config unless it is explicitly pulled in with `@config`.

## Related documentation

- `CLAUDE.md` — working notes and gotchas for contributors and AI assistants
- `React19_Migration.md` — React 18 → 19 migration plan (low-risk, already applied)
- `Security_Audit.md` — dated security audit with the remediation plan the `security:` commits were built from

## Notes

- Admin-only tabs (Hardware, Users, Tiers, Models) are gated on `profile.role === 'admin'` **in the UI**; the backend must enforce authorization independently.
- The "WebChat" API key is required by the chat interface and cannot be deleted.
- The Models tab is internally keyed `'sparky'` for legacy reasons but manages both hosts.
- `ErrorBoundary` shows raw error text only in development; production shows a generic message.
- Tests mock `localStorage` and `global.fetch`; coverage thresholds are configured in `vitest.config.ts`.
