#!/usr/bin/env node
/**
 * Smoke-check the production bundle.
 *
 * A toolchain upgrade once produced a build that exited 0, passed the whole test
 * suite, and shipped a bundle containing only vendor code — every one of the
 * app's own modules had been dropped. Neither `vite build`'s exit code nor
 * vitest catches that, because vitest transforms modules itself and never loads
 * the built output. This asserts the app is actually present in dist/.
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
