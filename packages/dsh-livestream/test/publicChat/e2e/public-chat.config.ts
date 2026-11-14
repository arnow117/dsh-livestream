import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
const root = process.env.DSH_PUBLIC_CHAT_E2E_ROOT;
const packageRoot = process.env.DSH_PUBLIC_CHAT_PACKAGE_DIR;
if (!root || !packageRoot) throw new Error('task-owned output and package root required');
const app = {
  url: 'http://127.0.0.1:0',
  command: {
    executable: 'node', args: ['test/publicChat/e2e/start.mjs', '{port}'],
    cwd: packageRoot,
    env: { DSH_E2E_PORT: '{port}', DSH_PUBLIC_CHAT_E2E_ROOT: root,
      DSH_HOME: `${root}/home`, DSH_LIVESTREAM_PACKAGE_DIR: packageRoot,
      DSH_PUBLIC_CHAT_BUILT_ROOT: process.env.DSH_PUBLIC_CHAT_BUILT_ROOT ?? '',
      DSH_PUBLIC_CHAT_BUILT_RUNTIME: process.env.DSH_PUBLIC_CHAT_BUILT_RUNTIME ?? '',
      DSH_PUBLIC_CHAT_E2E_SDK_ROOT: process.env.DSH_PUBLIC_CHAT_E2E_SDK_ROOT ?? '',
      NODE_OPTIONS: `--require=${packageRoot}/test/publicChat/e2e/network-guard.cjs` },
    log: '.task-e2e/settings-fixture-05.log',
  },
};
export default {
  tests: 'settings.e2e.ts',
  targets: [
    { name: 'desktop', engine: web({ browser: 'chromium', viewport: { width: 1440, height: 900 }, headers: { 'x-fixture-owner': 'owner-fixture' } }), app },
    { name: 'narrow', engine: web({ browser: 'chromium', viewport: { width: 375, height: 812 }, headers: { 'x-fixture-owner': 'owner-fixture' } }), app },
  ],
  cache: { mode: 'off', dir: `${root}/cache/e2e` }, workers: 1, retries: 0,
  timeout: 120000, actionTimeout: 5000, assertionTimeout: 5000, trace: 'on',
} satisfies E2EConfig;
