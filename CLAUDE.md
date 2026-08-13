# CLAUDE.md

## What this project is

**AI Portal** (package name `gpu-dashboard`, v0.1.0-alpha) — a React 19 + Vite 7 + TypeScript management portal for a local AI inference stack. Non-admin users get chat, API keys, billing, and account settings; admins additionally get a GPU telemetry dashboard ("TemperView"), user/tier management, and a model manager for two hosts: **Ellie** (llama.cpp, local) and **Sparky** (vLLM). The repo also ships a `claude-local` wrapper that runs Claude Code against the local stack, served from `public/install/`.

## Commands

```bash
npm install          # install dependencies (Node >= 26)
npm run dev          # Vite dev server (port 3000)
npm run build        # tsc && vite build → dist/, then the postbuild guard
npm run typecheck    # tsc --noEmit
npm run preview      # vite preview
npm run test         # vitest watch
npm run test:run     # vitest run (one-shot)
npm run test:coverage
npm run test:ui      # vitest UI inspector
```

`npm run build` automatically runs `scripts/verify-build.mjs` afterwards. See "Never upgrade Vite past 7.x" below — that guard exists for a specific reason and should not be removed.

Tests run under jsdom with `global.fetch` and `localStorage` mocked — see `src/api/__tests__/gpuApi.test.ts` for the pattern. Current state: **40 tests across 5 files, all passing** on Node 26.7.0; `npm audit` reports **0 vulnerabilities**. Every dependency is at its latest published version.

## Architecture & conventions

- **Entry chain:** `index.html` → `src/main.tsx` (root render) → `src/App.tsx` (`QueryClientProvider` + `ErrorBoundary`) → `src/components/portal/Portal.tsx` tab router. `Portal.tsx` is the single large file containing the portal UI.
- **Tab routing:** `Portal.tsx` renders one section per `activeTab` (`'chat' | 'keys' | 'billing' | 'settings' | 'hardware' | 'users' | 'tiers' | 'sparky'`). Admin-only tabs are gated on `profile?.role === 'admin'`. There is no router library — the app is a single page with state-driven tabs.
- **UI style:** Components use **Tailwind-style class strings** (e.g. `bg-dark-900`, `text-accent-cyan`, `flex items-center gap-3`) directly in markup — not separate CSS files. Keep that idiom when touching UI.
- **Data fetching:** Telemetry uses `@tanstack/react-query` `useQuery` with `refetchInterval` (GPU stats 1s, models 3–5s, catalogs 5s). Supabase calls use `src/lib/supabase.ts`'s `supabase` client; chat/LLM endpoints use plain `fetch`.
- **API layers:** `src/api/gpuApi.ts` (aggregates `.../metrics` from hosts in `localStorage['temper_remote_hosts']`; sanitizes `inf`/`nan` → `null` before JSON parse), `src/api/modelApi.ts` (chat-ready models), `src/api/managerApi.ts` (Ellie/Sparky catalog, load/unload/update/logs via `Bearer <jwt>`).
- **GPU metric types:** `src/types/gpu.ts` — `TemperGPUMetric`, `SlotMetrics`, `AiServiceMetrics`, etc. Unit conversions live there (`MW_TO_W`, `BYTES_TO_MB`, `KB_TO_MB`).

## Environment variables

- `VITE_SUPABASE_ANON_KEY` — **required**. `src/lib/supabase.ts` throws at module load if unset. Set in `.env.local` for dev, or pass as Docker build arg.
- `VITE_GPU_API_BASE` — optional fallback telemetry host in `gpuApi.ts` and `vite.config.ts` proxy.
- `.env.example` documents both; `.env.local` is gitignored.

## Deployment / proxy

- `Dockerfile` builds with `node:26-alpine` using `npm ci`, and serves `dist/` on `nginx:alpine` with `nginx.conf`. The project tracks the latest Node line; 26.x is Current and enters LTS in October 2026, so re-pin the tag deliberately rather than letting it drift. (Supabase's floor is `>=22`.) `.dockerignore` keeps `node_modules` and any local `.env` out of the build context.
- `nginx.conf` proxies: Supabase auth/rest (`ai-supabase-kong:8000`), host-metrics (`host-metrics:3001`), Sparky metrics (`10.20.10.10:3001`), ai-proxy (`ai-proxy:8081` for `/api/*` and `/llama/*`), Stripe billing (`stripe-handler:8000`). Applies security headers + CSP.
- PWA: `public/manifest.json`, `public/sw.js` (network-only strategy; `fetch` handler intentionally does nothing so streaming responses aren't broken), icons in `public/`.
- **Infrastructure direction:** the stack runs on Proxmox hypervisors `pve1`/`pve2`, where Ellie is a VM. The operator is moving away from Docker/compose toward LXCs; the compose-style service names above will need revisiting when that lands. Nothing in this repo has been migrated yet.

## Gotchas

- **Never upgrade Vite past 7.x without checking the bundle.** Vite 8 + `@vitejs/plugin-react` 6 exits 0, passes all tests, and emits a bundle containing **only vendor code** — every application module is dropped (601 kB → 202 kB). The test suite does not catch this because vitest transforms modules itself and never loads the built output. `scripts/verify-build.mjs` runs as a `postbuild` step and asserts known app-only strings are present plus a size floor. If you change app strings it references, update the marker list.
- **Tailwind is v4 with CSS-first config.** There is no `tailwind.config.js` — it was removed because v4 ignores a JS config unless pulled in with `@config`, and its keyframes were being silently dropped (`animate-shimmer` compiled to nothing). Theme colours, keyframes and animations all live in the `@theme` block in `src/App.css`.
- **TypeScript 7 removed `baseUrl`.** The `@/*` path mapping in `tsconfig.json` must stay explicitly relative (`./src/*`).
- **The test suite requires Node >= 26.** jsdom 30 declares `^22.22.2 || ^24.15.0 || >=26.0.0` and hard-fails on older runtimes with `webidl.util.markAsUncloneable is not a function` before any test executes. If `npm run test:run` dies with that message, the Node version is the cause, not the tests. Verified passing on Node 26.7.0.
- **`fetchGPUStats` host resolution order:** `temper_remote_hosts` localStorage (JSON array) → legacy `temper_remote_host` → `VITE_GPU_API_BASE` env → defaults `['/api', '/api/sparky']`. `'NO_HOSTS_CONFIGURED'` is thrown **only when the list is explicitly empty** (the user removed every host), which tells the UI to show the "Add Host" prompt. An absent key falls through to the defaults instead. `SettingsPage.tsx` manages host lists in localStorage.
- **`fetchGPUMetrics` validates before fetching.** ID format and negative-index checks run ahead of the network call. The format regex accepts an optional leading `-` so a negative index reports its own specific error rather than the generic format one.
- **Host naming:** `'ellie'` = local host (`/api`, contains `localhost`/`127.0.0.1`); `'sparky'` = everything else. `managerApi.ts` uses `HostKey = 'ellie' | 'sparky'`.
- **The Models tab is internally called `'sparky'`.** The `activeTab` value is `'sparky'`, the UI label is "Models", and it renders `<ModelManager />` covering *both* hosts. Legacy naming — don't assume it is Sparky-only.
- **Chat streaming:** `ChatInterface.tsx` sends to `/llama/v1/chat/completions` with `Authorization: Bearer <WebChat key>`. SSE frames are decoded by `src/lib/sse.ts`, which buffers partial lines — network chunks do not align with frame boundaries, and parsing per-chunk silently dropped tokens. Do not inline that parsing again. `<thinking>...</thinking>` tags are parsed for a collapsible thinking block. The WebChat key is required and non-deletable.
- **Chat session auto-save builds its message from the accumulated stream**, not from `messages` state. The `messages` closure predates the send, so indexing it returned `undefined` and threw, which wiped the assistant's reply from the UI and saved nothing.
- **Every `managerApi` call is authenticated**, including model logs. Follow the `if (!jwt) return;` guard used throughout `ModelManager.tsx`.
- **VRAM estimation:** `ModelManager.tsx` uses `KV_MULTIPLIERS` per cache type; load buttons are disabled when the estimate exceeds host VRAM.
- **Error boundaries:** `ErrorBoundary.tsx` shows the raw error message and stack **only** when `import.meta.env.DEV`; production shows a generic message. Don't reintroduce raw error text in production — that was a finding in `Security_Audit.md`.
- **`add_header` in nginx does not merge across levels.** Declaring one inside a `location` drops every server-level security header, so `/install/` repeats the full set. Keep them in sync if you change the CSP.
- **Security history:** the `security:` commits apply the `Security_Audit.md` P1/P2 remediation. Don't reintroduce hardcoded Supabase keys into source. Note `nginx.conf` still hardcodes the internal IP `10.20.10.10` for Sparky metrics.

## Docs

- `README.md` — user-facing overview, setup, deployment.
- `React19_Migration.md` — React 18→19 upgrade (already applied; low-risk).
- `Security_Audit.md` — prior audit + remediation plan for reference.
