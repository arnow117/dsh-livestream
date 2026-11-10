import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const deadline = Date.now() + 300_000;
const args = process.argv.slice(2);
const budgets = new Map([
  ['--approve=search:2,model:4,tts:0,seconds:300', 0],
  ['--approve=search:2,model:4,tts:1,seconds:300', 1],
]);
const real = args.length === 2 && args[0] === '--real' && budgets.has(args[1]);
const ttsBudget = real ? budgets.get(args[1]) : 0;
if (args.length && !real) {
  console.error('Invalid mode or budget approval; no work started.');
  process.exit(2);
}
if (real && (!process.env.GLM_CODING_PLAN_API_KEY || (ttsBudget === 1 && !process.env.YOVOICE_API_TOKEN))) {
  console.error('Required credential references are not configured; no work started.');
  process.exit(2);
}
const here = dirname(fileURLToPath(import.meta.url));
const buildDir = await mkdtemp(join(here, '.run-'));
const isolatedDir = await mkdtemp(join(tmpdir(), 'dsh-query-home-'));
const artifacts = await mkdtemp(join(tmpdir(), 'dsh-query-artifacts-'));
async function runChild(command, childArgs, env, gracefulStop) {
  const child = spawn(command, childArgs, { env, stdio: 'ignore' });
  const stopChild = () => child.kill(gracefulStop ? 'SIGTERM' : 'SIGKILL');
  process.once('SIGINT', stopChild);
  process.once('SIGTERM', stopChild);
  const watchdog = setTimeout(() => child.kill('SIGKILL'), Math.max(0, deadline - Date.now()));
  try {
    return await new Promise((resolveResult, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolveResult({ code, signal }));
    });
  } finally {
    clearTimeout(watchdog);
    process.removeListener('SIGINT', stopChild);
    process.removeListener('SIGTERM', stopChild);
  }
}
try {
  const entry = join(buildDir, 'entry.mjs');
  const compiler = join(here, '../../node_modules/.bin/esbuild');
  const compilation = await runChild(compiler, [join(here, 'main.ts'), '--bundle', '--platform=node', '--format=esm', '--packages=external', '--log-level=silent', `--outfile=${entry}`], { PATH: process.env.PATH ?? '' }, false);
  if (compilation.code !== 0) throw new Error('Isolated entry preparation failed.');
  const env = {
    PATH: process.env.PATH ?? '',
    TMPDIR: tmpdir(),
    DSH_HOME: isolatedDir,
    DSH_ACCEPTANCE_ARTIFACT_DIR: artifacts,
    DSH_ACCEPTANCE_MODE: real ? 'real' : 'offline',
    DSH_ACCEPTANCE_WEATHER_CACHE_FILE: real
      ? join(here, '../../.e2e/feat-004-live-weather/weather-cache-v1.json')
      : join(isolatedDir, 'dsh-livestream/weather-cache-v1.json'),
    ...(real && process.env.DSH_LIVESTREAM_WEATHER_GEOCODER_URL
      ? { DSH_LIVESTREAM_WEATHER_GEOCODER_URL: process.env.DSH_LIVESTREAM_WEATHER_GEOCODER_URL } : {}),
    DSH_ACCEPTANCE_DEADLINE: String(deadline),
    DSH_ACCEPTANCE_TTS_BUDGET: String(ttsBudget),
    ...(real ? { GLM_CODING_PLAN_API_KEY: process.env.GLM_CODING_PLAN_API_KEY } : {}),
    ...(real && ttsBudget === 1 ? { YOVOICE_API_TOKEN: process.env.YOVOICE_API_TOKEN } : {}),
  };
  const result = await runChild(process.execPath, [resolve(entry)], env, true);
  let evidenceAvailable = false;
  try {
    const evidence = JSON.parse(await readFile(join(artifacts, 'result.json'), 'utf8'));
    console.log(JSON.stringify(evidence));
    evidenceAvailable = true;
  } catch {
    console.error('No sanitized result available.');
  }
  await rm(isolatedDir, { recursive: true, force: true });
  console.log(JSON.stringify({ artifactDirectory: artifacts, homeRemoved: true, hardDeadlineTerminated: result.signal === 'SIGKILL', cleanup: result.signal === 'SIGKILL' || !evidenceAvailable ? 'unknown' : 'finished' }));
  process.exitCode = result.code ?? 1;
} finally {
  await rm(buildDir, { recursive: true, force: true });
  await rm(isolatedDir, { recursive: true, force: true });
}
