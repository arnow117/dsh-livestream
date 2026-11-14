import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const output = '.e2e/feat-dsh004-robot-build';
await mkdir(output, { recursive: true });
await build({ entryPoints: ['test/e2e-robot/client.tsx'], outfile: `${output}/client.js`, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic' });
await build({
  entryPoints: ['test/e2e-robot/server.ts'], outdir: output, bundle: true, platform: 'node', format: 'esm', target: 'node22', splitting: true,
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  // dsh-qdroid 是可选依赖：这个 fixture 故意不安装它，运行时 import 失败产生真实的「插件不可用」分支
  external: ['dsh-qdroid', 'dsh-qdroid/robot'],
});
const child = spawn(process.execPath, [`${output}/server.js`, process.argv[2]], { stdio: 'inherit' });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('exit', (code) => process.exit(code ?? 0));
