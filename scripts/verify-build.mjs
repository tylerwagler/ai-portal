#!/usr/bin/env node
/**
 * Smoke-check the production bundle.
 *
 * The failure this exists to catch: building without VITE_SUPABASE_ANON_KEY.
 * src/lib/supabase.ts throws at module scope when the key is missing, and
 * because the key is inlined at build time the guard folds to a constant, so
 * the bundle becomes a module that does nothing but throw on load. `vite build`
 * still exits 0 and the whole test suite still passes, because vitest
 * transforms modules itself and never loads the built output — so nothing else
 * in the pipeline notices that the artifact cannot start.
 *
 * How visible that is depends on the bundler. Rolldown (Vite 8) proves the rest
 * of the app unreachable and eliminates it, leaving a ~200 kB stub. Rollup
 * (Vite 7) keeps the dead code, so the bundle looks a normal size and passes a
 * naive size check while still being unrunnable. Hence: check for the throw
 * directly, not just for size.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DIST = 'dist';
const ASSETS = join(DIST, 'assets');

// Strings that only exist in this application's own source. If the bundler
// silently drops app code, these disappear while the vendor chunks remain.
const REQUIRED_MARKERS = [
  'TemperView',                    // GPUDashboard
  'WebChat',                       // ChatInterface / Portal key handling
  '/llama/v1/chat/completions',    // ChatInterface streaming endpoint
  'temper_remote_hosts',           // gpuApi host resolution
  'NO_HOSTS_CONFIGURED',           // gpuApi sentinel
];

// A bundle far below this almost certainly lost application code.
const MIN_BUNDLE_BYTES = 300_000;

function fail(message) {
  console.error(`\n  verify-build: ${message}\n`);
  process.exit(1);
}

let jsFiles;
try {
  jsFiles = readdirSync(ASSETS).filter((f) => f.endsWith('.js'));
} catch {
  fail(`no ${ASSETS}/ directory — run \`npm run build\` first`);
}

if (jsFiles.length === 0) fail(`no JavaScript emitted into ${ASSETS}/`);

const bundles = jsFiles.map((f) => join(ASSETS, f));
const totalBytes = bundles.reduce((sum, f) => sum + statSync(f).size, 0);
const combined = bundles.map((f) => readFileSync(f, 'utf8')).join('\n');

// Checked first: it is the most common cause and gives the clearest message.
// The bundle retains this string whenever the key was absent at build time.
if (combined.includes('VITE_SUPABASE_ANON_KEY is not set')) {
  fail(
    `built without VITE_SUPABASE_ANON_KEY.\n` +
      `  src/lib/supabase.ts throws at module scope, so this bundle throws on\n` +
      `  load and the app never mounts — regardless of its size.\n` +
      `  Set it in .env.local, or pass --build-arg VITE_SUPABASE_ANON_KEY=... to docker build.`
  );
}

const missing = REQUIRED_MARKERS.filter((marker) => !combined.includes(marker));

if (missing.length > 0) {
  fail(
    `the bundle is missing application code.\n` +
      `  Absent markers: ${missing.join(', ')}\n` +
      `  This usually means the bundler tree-shook away reachable modules.`
  );
}

if (totalBytes < MIN_BUNDLE_BYTES) {
  fail(
    `bundle is only ${totalBytes} bytes, below the ${MIN_BUNDLE_BYTES} floor — ` +
      `app code may have been dropped.`
  );
}

console.log(
  `  verify-build: ok — ${bundles.length} chunk(s), ${(totalBytes / 1024).toFixed(1)} kB, ` +
    `all ${REQUIRED_MARKERS.length} markers present`
);
