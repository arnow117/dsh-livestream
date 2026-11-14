/**
 * publicChat 专属 runner（FEAT-008-T001）。
 *
 * 显式只选本目录 *.case.ts：默认 vitest 发现不到半成品，也绝不把共享
 * runner 配置牵扯进来。缓存写入系统临时目录，不写包内受保护路径。
 * T002 的专属 e2e 入口单独提供（e2e.config.ts 属于 T002 范围）。
 */
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: join(here, '..', '..'),
  // 缓存写入系统临时目录，不写包内受保护路径（vitest 3 顶层 cacheDir）。
  cacheDir: process.env.DSH_PUBLIC_CHAT_VITEST_CACHE ?? join(tmpdir(), 'dsh-public-chat-vitest-cache'),
  test: {
    include: ['test/publicChat/**/*.case.ts'],
    exclude: ['**/node_modules/**'],
    reporters: ['default'],
  },
});
