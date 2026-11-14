import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
const root = process.env.DSH_PUBLIC_CHAT_E2E_ROOT;
const packageRoot = process.env.DSH_PUBLIC_CHAT_PACKAGE_DIR;
if (!root || !packageRoot) throw new Error('task-owned output and package root required');
const app = {
  url: 'http://127.0.0.1:0',
  command: {
    executable: 'node', args: ['test/publicChat/e2e/launch-integration.mjs', '{port}'],
    cwd: packageRoot, startupTimeout: 120000, shutdownTimeout: 30000,
    env: { DSH_E2E_PORT: '{port}', DSH_PUBLIC_CHAT_E2E_ROOT: root,
      DSH_HOME: `${root}/home`, DSH_LIVESTREAM_PACKAGE_DIR: packageRoot,
      DSH_PUBLIC_CHAT_FIXTURE_ROOT: root, DSH_PUBLIC_CHAT_BUILT_ROOT: process.env.DSH_PUBLIC_CHAT_BUILT_ROOT ?? '',
      DSH_PUBLIC_CHAT_BUILT_RUNTIME: process.env.DSH_PUBLIC_CHAT_BUILT_RUNTIME ?? '',
      DSH_PUBLIC_CHAT_BUILT_SENDER: process.env.DSH_PUBLIC_CHAT_BUILT_SENDER ?? '',
      DSH_PUBLIC_CHAT_SENDER_BUNDLE: process.env.DSH_PUBLIC_CHAT_SENDER_BUNDLE ?? '',
      DSH_PUBLIC_CHAT_SENDER_MANIFEST: process.env.DSH_PUBLIC_CHAT_SENDER_MANIFEST ?? '',
      DSH_PUBLIC_CHAT_SENDER_MANIFEST_SHA256: process.env.DSH_PUBLIC_CHAT_SENDER_MANIFEST_SHA256 ?? '',
      DSH_PUBLIC_CHAT_RAW_EXPORT: process.env.DSH_PUBLIC_CHAT_RAW_EXPORT ?? '',
      DSH_PUBLIC_CHAT_BROWSER_BINARY: process.env.DSH_PUBLIC_CHAT_BROWSER_BINARY ?? '',
      DSH_PUBLIC_CHAT_E2E_VITEST: process.env.DSH_PUBLIC_CHAT_E2E_VITEST ?? '',
      DSH_PUBLIC_CHAT_VITEST_CACHE: `${root}/cache`, GOTOOLCHAIN: 'local', GOWORK: 'off', GOPROXY: 'off',
      GOMODCACHE: `${root}/gomodcache`, GOCACHE: `${root}/gocache`, GOTMPDIR: `${root}/gotmp`,
      NODE_OPTIONS: `--require=${packageRoot}/test/publicChat/e2e/network-guard.cjs` },
    log: '.task-e2e/integration-fixture-13.log',
  },
};
export default {
  tests: 'integration.e2e.ts',
  targets: [
    { name: 'desktop', engine: web({ browser: 'chromium', viewport: { width: 1440, height: 900 }, headers: { 'x-fixture-owner': 'owner-fixture' } }), app },
    { name: 'narrow', engine: web({ browser: 'chromium', viewport: { width: 375, height: 812 }, headers: { 'x-fixture-owner': 'owner-fixture' } }), app },
  ],
  cache: { mode: 'read-only', strict: true, dir: `${root}/cache/e2e` }, workers: 1, retries: 0,
  timeout: 120000, actionTimeout: 10000, assertionTimeout: 15000, trace: 'on',
} satisfies E2EConfig;
