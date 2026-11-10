import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';

const app = {
  url: 'http://127.0.0.1:0',
  command: { executable: 'node', args: ['test/e2e-douyin/start.mjs', '{port}'], log: '.e2e/feat-003-correction-1/fixture.log' },
};
export default {
  tests: 'test/e2e-douyin/*.e2e.ts',
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
  output: '.e2e/feat-003-correction-1',
  trace: 'on',
} satisfies E2EConfig;
