import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';

// FEAT-DSH-004：机器人联动设置的确定性 Web 旅程（真实控制台 + 真实路由；不安装 dsh-qdroid）。
const app = {
  url: 'http://127.0.0.1:0',
  command: { executable: 'node', args: ['test/e2e-robot/start.mjs', '{port}'], log: '.e2e/feat-dsh004-robot/fixture.log' },
};
export default {
  tests: 'test/e2e-robot/*.e2e.ts',
  targets: [
    { name: 'desktop', engine: web({ browser: 'chromium', viewport: { width: 1440, height: 900 } }), app },
    { name: 'narrow', engine: web({ browser: 'chromium', viewport: { width: 375, height: 812 } }), app },
  ],
  cache: { mode: 'read-only', strict: true },
  timeout: 120000,
  actionTimeout: 5000,
  assertionTimeout: 10000,
  workers: 1,
  retries: 0,
  output: '.e2e/feat-dsh004-robot',
  trace: 'on',
} satisfies E2EConfig;
