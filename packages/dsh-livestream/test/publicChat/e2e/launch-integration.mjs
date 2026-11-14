import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const port = Number(process.argv[2]);
if (!Number.isSafeInteger(port) || port <= 0 || [3080, 3081, 7390, 8757].includes(port)) throw new Error('invalid fixture port');
const vitest = process.env.DSH_PUBLIC_CHAT_E2E_VITEST;
const root = process.env.DSH_PUBLIC_CHAT_E2E_ROOT;
if (!vitest || !root) throw new Error('missing fixture runner');
const child = spawn(vitest, ['run', '--config', 'test/publicChat/vitest.public-chat.config.ts',
  'test/publicChat/actualHelperComposition.case.ts', '--maxWorkers', '1', '--no-file-parallelism'], {
  stdio: 'inherit', env: { ...process.env, DSH_PUBLIC_CHAT_E2E_PORT: String(port) },
});
let stopping = false;
let fallback;
let childResult;
async function stop() {
  if (stopping) return;
  stopping = true;
  if (childResult) { process.exit(childResult.code ?? 1); }
  try { await fetch(`http://127.0.0.1:${port}/fixture-finish`, { signal: AbortSignal.timeout(3000) }); }
  catch { /* The test may already have requested normal shutdown. */ }
  fallback = setTimeout(() => child.kill('SIGTERM'), 20000);
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => void stop());
child.on('exit', (code, signal) => {
  if (fallback) clearTimeout(fallback);
  childResult = { code, signal };
  writeFileSync(join(root, 'output', `e2e-cleanup-${port}.json`), JSON.stringify(childResult), { flag: 'wx', mode: 0o600 });
  console.log(`owned-e2e-journey child=${child.pid} exit=${code} signal=${signal}`);
  if (stopping) process.exit(code ?? 1);
});
