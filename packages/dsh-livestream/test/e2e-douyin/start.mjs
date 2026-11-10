import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const output = '.e2e/feat-003-correction-1-build';
await mkdir(output, { recursive: true });
await build({ entryPoints: ['test/e2e-douyin/client.tsx'], outfile: `${output}/client.js`, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic' });
await build({
  entryPoints: ['test/e2e-douyin/server.ts'], outfile: `${output}/server.js`, bundle: true, platform: 'node', format: 'esm', target: 'node22', external: ['ws'],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
const child = spawn(process.execPath, [`${output}/server.js`, process.argv[2]], { stdio: 'inherit' });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('exit', (code) => process.exit(code ?? 0));
