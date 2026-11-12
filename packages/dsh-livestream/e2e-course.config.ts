import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';

const app = {
  url: 'http://127.0.0.1:0',
  command: {
    executable: 'node',
    args: ['test/e2e-course/start.mjs', '{port}'],
    log: '.e2e/feat-007-build/fixture.log',
    env: process.env.FEAT007_REAL_ASSET_ROOT ? { FEAT007_REAL_ASSET_ROOT: process.env.FEAT007_REAL_ASSET_ROOT } : {},
  },
};
export default {
  tests: 'test/e2e-course/*.e2e.ts',
  targets: [
    { name: 'desktop', engine: web({ browser: 'chromium', viewport: { width: 1440, height: 900 } }), app },
    { name: 'narrow', engine: web({ browser: 'chromium', viewport: { width: 375, height: 812 } }), app },
  ],
  cache: { mode: 'read-only', strict: true },
  timeout: 120000,
  actionTimeout: 5000,
  assertionTimeout: 5000,
  workers: 1,
  retries: 0,
  output: '.e2e/feat-007-build',
  trace: 'on',
} satisfies E2EConfig;
