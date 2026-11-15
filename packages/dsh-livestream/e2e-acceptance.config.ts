import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { join } from 'node:path';

/**
 * FEAT-010-T001 同版内部组合入口的浏览器配置。
 *
 * 真实 SDK owner 准入由 fixture 认证头触发；未认证请求为 401。
 * SDK 公共 API 创建的 guest Peer 只用于直接检查路由权限；浏览器 guest 准入未装配。
 */
const taskRoot = process.env.DSH_ACCEPTANCE_ROOT;
if (!taskRoot) throw new Error('DSH_ACCEPTANCE_ROOT required');
const app = {
  url: 'http://127.0.0.1:0',
  command: {
    executable: 'node',
    args: ['test/acceptance/start.mjs', '{port}'],
    env: {
      DSH_ACCEPTANCE_ROOT: taskRoot,
      DSH_ACCEPTANCE_SENDER_MODE: process.env.DSH_ACCEPTANCE_SENDER_MODE ?? '',
      DSH_ACCEPTANCE_STANDARD_PACKAGE: process.env.DSH_ACCEPTANCE_STANDARD_PACKAGE ?? '',
      DSH_ACCEPTANCE_SDK_ROOT: process.env.DSH_ACCEPTANCE_SDK_ROOT ?? '',
      DSH_ACCEPTANCE_ARTIFACT: process.env.DSH_ACCEPTANCE_ARTIFACT ?? '',
      DSH_ACCEPTANCE_COURSE_ROOT: process.env.DSH_ACCEPTANCE_COURSE_ROOT ?? '',
    },
  },
};
export default {
  tests: 'test/acceptance/*.e2e.ts',
  targets: [
    { name: 'desktop', engine: web({ browser: 'chromium', viewport: { width: 1440, height: 900 } }), app },
    { name: 'narrow', engine: web({ browser: 'chromium', viewport: { width: 375, height: 812 } }), app },
  ],
  cache: { mode: 'read-only', strict: true, dir: join(taskRoot, 'cache') },
  timeout: 180000,
  actionTimeout: 10000,
  assertionTimeout: 15000,
  workers: 1,
  retries: 0,
  output: join(taskRoot, 'results'),
  trace: 'on',
} satisfies E2EConfig;
