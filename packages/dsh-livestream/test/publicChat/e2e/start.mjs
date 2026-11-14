import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.env.DSH_PUBLIC_CHAT_E2E_ROOT;
if (!root) throw new Error('task-owned output required');
await build({ entryPoints: ['test/publicChat/e2e/production-client-fixture.tsx'], outfile: join(root, 'output/e2e-console.js'),
  bundle: true, platform: 'browser', format: 'iife', target: 'chrome120', logLevel: 'silent' });
const child = spawn(process.execPath, ['test/publicChat/e2e/fixture-server.mjs', process.argv[2]], { stdio: 'inherit' });
let stopped = false;
let childResult;
let fallback;
async function stop() {
  if (stopped) return;
  stopped = true;
  if (childResult) process.exit(childResult.code ?? 1);
  try { await fetch(`http://127.0.0.1:${process.argv[2]}/fixture-finish`, { signal: AbortSignal.timeout(3000) }); }
  catch { /* The test may already have requested normal shutdown. */ }
  fallback = setTimeout(() => child.kill('SIGTERM'), 20000);
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => void stop());
child.on('exit', (code, signal) => {
  if (fallback) clearTimeout(fallback);
  childResult = { code, signal };
  writeFileSync(join(root, 'output', `e2e-settings-cleanup-${process.argv[2]}.json`), JSON.stringify(childResult), { flag: 'wx', mode: 0o600 });
  console.log(`owned-e2e-settings child=${child.pid} exit=${code} signal=${signal}`);
  if (stopped) process.exit(code ?? 1);
});
