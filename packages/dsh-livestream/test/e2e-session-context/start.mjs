import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const output = '.e2e/feat-006-build-fixture';
await mkdir(`${output}/lib`, { recursive: true });
await cp('stage', `${output}/stage`, { recursive: true });
await build({ entryPoints: ['test/e2e-session-context/client.tsx'], outfile: `${output}/client.js`, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic' });
await build({ entryPoints: ['src/stage/main.tsx'], outfile: `${output}/lib/stage.js`, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic' });
await build({
  entryPoints: ['test/e2e-session-context/server.ts'], outfile: `${output}/server.js`, bundle: true, platform: 'node', format: 'esm', target: 'node22',
  external: ['@deepseek-ai/*', '@modelcontextprotocol/client', 'ws'],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
const child = spawn(process.execPath, [`${output}/server.js`, process.argv[2]], { stdio: 'inherit' });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('exit', (code) => process.exit(code ?? 0));
