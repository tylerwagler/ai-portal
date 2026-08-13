# CLAUDE.md

## What this project is

**AI Portal** (package name `gpu-dashboard`, v0.1.0-alpha) — a React 19 + Vite 7 + TypeScript management portal for a local AI inference stack. Non-admin users get chat, API keys, billing, and account settings; admins additionally get a GPU telemetry dashboard ("TemperView"), user/tier management, and a model manager for two hosts: **Ellie** (llama.cpp, local) and **Sparky** (vLLM). The repo also ships a `claude-local` wrapper that runs Claude Code against the local stack, served from `public/install/`.

## Commands

```bash
npm install          # install dependencies
npm run dev          # Vite dev server (port 3000)
npm run build        # tsc && vite build → dist/
npm run preview      # vite preview
npm run test         # vitest watch
npm run test:run     # vitest run (one-shot)
npm run test:coverage
npm run test:ui      # vitest UI inspector
```

Tests run under jsdom with `global.fetch` and `localStorage` mocked — see `src/api/__tests__/gpuApi.test.ts` for the pattern.

## Architecture & conventions

- **Entry chain:** `index.html` → `src/main.tsx` (root render) → `src/App.tsx` (`QueryClientProvider` + `ErrorBoundary`) → `src/components/portal/Portal.tsx` tab router. `Portal.tsx` is the single large file containing the portal UI.
- **Tab routing:** `Portal.tsx` renders one section per `activeTab` (`'chat' | 'keys' | 'billing' | 'settings' | 'hardware' | 'users' | 'tiers' | 'sparky'`). Admin-only tabs are gated on `profile?.role === 'admin'`.
- **UI style:** Components use **Tailwind-style class strings** (e.g. `bg-dark-900`, `text-accent-cyan`, `flex items-center gap-3`) directly in markup — not separate CSS files (except `src/style.css`/`App.css` which are legacy). Keep that idiom when touching UI.
- **Data fetching:** Telemetry uses `@tanstack/react-query` `useQuery` with `refetchInterval` (GPU stats 1s, models 3–5s, catalogs 5s). Supabase calls use `src/lib/supabase.ts`'s `supabase` client; chat/LLM endpoints use plain `fetch`.
- **API layers:** `src/api/gpuApi.ts` (aggregates `.../metrics` from hosts in `localStorage['temper_remote_hosts']`; sanitizes `inf`/`nan` → `null` before JSON parse), `src/api/modelApi.ts` (chat-ready models), `src/api/managerApi.ts` (Ellie/Sparky catalog, load/unload/update/logs via `Bearer <jwt>`).
- **GPU metric types:** `src/types/gpu.ts` — `TemperGPUMetric`, `SlotMetrics`, `AiServiceMetrics`, etc. Unit conversions live there (`MW_TO_W`, `BYTES_TO_MB`, `KB_TO_MB`).

## Environment variables

- `VITE_SUPABASE_ANON_KEY` — **required**. `src/lib/supabase.ts` throws at module load if unset. Set in `.env.local` for dev, or pass as Docker build arg.
- `VITE_GPU_API_BASE` — optional fallback telemetry host in `gpuApi.ts` and `vite.config.ts` proxy.
- `.env.example` documents both; `.env.local` is gitignored.

## Deployment / proxy

- `Dockerfile` builds with `node:20-alpine`, serves `dist/` on `nginx:alpine` with `nginx.conf`.
- `nginx.conf` proxies: Supabase auth/rest (`ai-supabase-kong:8000`), host-metrics (`host-metrics:3001`), Sparky metrics (`10.20.10.10:3001`), ai-proxy (`ai-proxy:8081` for `/api/*` and `/llama/*`), Stripe billing (`stripe-handler:8000`). Applies security headers + CSP.
- PWA: `public/manifest.json`, `public/sw.js` (network-only strategy; `fetch` handler intentionally does nothing so streaming responses aren't broken), icons in `public/`.

## Gotchas

- **`fetchGPUStats` host resolution order:** `temper_remote_hosts` localStorage (JSON array) → legacy `temper_remote_host` → `VITE_GPU_API_BASE` env → defaults `['/api', '/api/sparky']`. Throwing `'NO_HOSTS_CONFIGURED'` tells the UI to show the "Add Host" prompt. `SettingsPage.tsx` manages host lists in localStorage.
- **Host naming:** `'ellie'` = local host (`/api`, contains `localhost`/`127.0.0.1`); `'sparky'` = everything else. `managerApi.ts` uses `HostKey = 'ellie' | 'sparky'`.
- **Chat streaming:** `ChatInterface.tsx` sends to `/llama/v1/chat/completions` with `Authorization: Bearer <WebChat key>` and parses `data:` SSE lines; `<thinking>...</thinking>` tags are parsed for a collapsible thinking block. The WebChat key is required and non-deletable.
- **VRAM estimation:** `ModelManager.tsx` uses `KV_MULTIPLIERS` per cache type; load buttons are disabled when the estimate exceeds host VRAM.
- **Error boundaries:** `ErrorBoundary.tsx` shows the raw error message only in development (`NODE_ENV === 'development'`), else a generic message; stack trace is hidden in production.
- **Tests excluded from coverage:** `src/counter.ts`, `src/main.ts`, `src/test.tsx` (legacy/template files) — see `vitest.config.ts` excludes and coverage thresholds.
- **Security history:** recent commits (`security: ...`) apply the `Security_Audit.md` P1/P2 remediation (anon key removed from source, env-keyed). Don't reintroduce hardcoded Supabase keys or internal IPs into source.

## Docs

- `React19_Migration.md` — React 18→19 upgrade (already applied; low-risk).
- `Security_Audit.md` — prior audit + remediation plan for reference.
