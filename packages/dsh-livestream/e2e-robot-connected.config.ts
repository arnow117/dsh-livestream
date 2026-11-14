import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';

// FEAT-DSH-004：已连接机器人插件的确定性 Web 旅程（真实安装 + 真实 owner 路由）。
const app = {
  url: 'http://127.0.0.1:0',
  command: { executable: 'node', args: ['test/e2e-robot-connected/start.mjs', '{port}'], log: '.e2e/feat-dsh004-robot-connected/fixture.log', startupTimeout: 150000, shutdownTimeout: 15000 },
};
export default {
  tests: 'test/e2e-robot-connected/*.e2e.ts',
  targets: [
    { name: 'desktop', engine: web({ browser: 'chromium', viewport: { width: 1440, height: 900 } }), app },
  ],
  cache: { mode: 'read-only', strict: true },
  timeout: 180000,
  actionTimeout: 8000,
  assertionTimeout: 15000,
  workers: 1,
  retries: 0,
  output: '.e2e/feat-dsh004-robot-connected',
  trace: 'on',
} satisfies E2EConfig;
