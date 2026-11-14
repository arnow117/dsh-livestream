// 已连接机器人插件的 E2E 启动器：构建 fixture 控制台 bundle，再启动转发型 fixture
// 服务器（server.mjs 负责打包安装两个候选包与 SDK 层，并从安装产物加载全部生产代码）。
import { mkdtemp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';

const output = '.e2e/feat-dsh004-robot-connected';
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(output, 'client-'));
// 控制台客户端与仓库其它 e2e fixture 相同：由 src/console 构建独立 bundle
//（打包产物里的 lib/client.js 是 DSH 网页外壳的模块工厂，离开外壳无法独立渲染）。
// 插件/路由/robot 服务的安装与身份核对由 server.mjs 自己执行（preparePackedInstall）。
const clientOut = join(root, 'client-bundle.js');
await build({
  entryPoints: [new URL('./client.tsx', import.meta.url).pathname],
  outfile: clientOut,
  bundle: true,
  platform: 'browser',
  format: 'iife',
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
});
console.log(`[t02-connected-prep] client bundle built ${clientOut}`);
process.env.DSH_T02_CLIENT_BUNDLE = clientOut;
const child = spawn(process.execPath, [new URL('./server.mjs', import.meta.url).pathname, process.argv[2]], { stdio: 'inherit', env: process.env });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('exit', (code) => process.exit(code ?? 0));
