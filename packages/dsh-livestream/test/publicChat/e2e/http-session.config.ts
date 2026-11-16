import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';

const root = process.env.DSH_PUBLIC_CHAT_E2E_ROOT;
const packageRoot = process.env.DSH_PUBLIC_CHAT_PACKAGE_DIR;
const kind = process.env.DSH_SESSION_E2E_KIND;
const runId = process.env.DSH_SESSION_E2E_RUN_ID;
const headless = process.env.DSH_TEST_HEADLESS;
const browserDigest = '5882798f6fde47054e94a74016c36b79dba79e1cc7687f6080dd24a7f617bd74';
if (!root || !packageRoot || !headless || !['source', 'built'].includes(kind ?? '') || !/^[a-z0-9-]+$/.test(runId ?? '')) throw new Error('task-owned fixture paths required');
if (realpathSync(headless) !== headless || !statSync(headless).isFile() || createHash('sha256').update(readFileSync(headless)).digest('hex') !== browserDigest) {
  throw new Error('fixed task-owned browser mismatch');
}
const runOutput = `.session-e2e-${runId}`;
const processes = new Map<string, ChildProcess>();
const browser = {
  name: 'task-owned-headless-shell-157', scope: 'worker' as const,
  async acquire() {
    const profile = mkdtempSync(join(root!, 'chrome-profile-'));
    const child = spawn(headless!, [
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-sandbox', '--disable-gpu', '--in-process-gpu',
      '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update',
      '--disable-sync', '--disable-features=MediaRouter,OptimizationHints', 'about:blank',
    ], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, TMPDIR: join(root!, 'tmp') } });
    if (!child.pid || !child.stderr) throw new Error('task-owned Chrome unavailable');
    const id = String(child.pid);
    processes.set(id, child);
    appendFileSync(join(root!, 'output/browser-processes.log'), `start ${id}\n`);
    const endpoint = await new Promise<string>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Chrome startup timeout')), 15000);
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        const sanitized = output.replace(/wss?:\/\/\S+/g, '[local-cdp]').replace(/https?:\/\/\S+/g, '[url]').replace(/\/Users\/[^\s:]*/g, '[path]');
        appendFileSync(join(root!, 'output/browser-startup.log'), `exit code=${code} signal=${signal}\n${sanitized}\n`);
        reject(new Error('Chrome exited during startup'));
      });
      child.stderr!.on('data', (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-4096);
        const match = /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[a-z0-9-]+)/i.exec(output);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
    }).catch(async (error) => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
        child.once('close', () => { clearTimeout(timer); resolve(); });
      });
      processes.delete(id);
      appendFileSync(join(root!, 'output/browser-processes.log'), `closed ${id}\n`);
      throw error;
    });
    return { id, cdpEndpoint: endpoint };
  },
  async release(lease: { id: string }) {
    const child = processes.get(lease.id);
    if (!child) throw new Error('Chrome ownership unavailable');
    processes.delete(lease.id);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const timer = setTimeout(() => { child.kill('SIGKILL'); }, 5000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
    });
    appendFileSync(join(root!, 'output/browser-processes.log'), `closed ${lease.id}\n`);
  },
};
const app = {
  url: 'http://127.0.0.1:0',
  command: { executable: 'node', args: ['test/publicChat/e2e/http-session-start.mjs', '{port}'], cwd: packageRoot,
    env: { DSH_PUBLIC_CHAT_E2E_ROOT: root, DSH_SESSION_E2E_KIND: kind!, DSH_E2E_PORT: '{port}', DSH_HOME: `${root}/home`,
      DSH_LIVESTREAM_PACKAGE_DIR: packageRoot, DSH_PUBLIC_CHAT_BUILT_ROOT: process.env.DSH_PUBLIC_CHAT_BUILT_ROOT ?? '',
      DSH_PUBLIC_CHAT_BUILT_RUNTIME: process.env.DSH_PUBLIC_CHAT_BUILT_RUNTIME ?? '',
      DSH_PUBLIC_CHAT_E2E_SDK_ROOT: process.env.DSH_PUBLIC_CHAT_E2E_SDK_ROOT ?? '',
      DSH_QR_FIXTURE: process.env.DSH_QR_FIXTURE ?? '', TMPDIR: process.env.TMPDIR ?? '',
      NODE_OPTIONS: `--require=${packageRoot}/test/publicChat/e2e/network-guard.cjs` },
    log: `${runOutput}/server.log` },
};
export default {
  tests: 'http-session.e2e.ts',
  targets: [
    { name: 'desktop', engine: web({ browser, viewport: { width: 1440, height: 900 }, headers: { 'x-fixture-owner': 'owner-fixture' } }), app },
    { name: 'narrow', engine: web({ browser, viewport: { width: 375, height: 812 }, headers: { 'x-fixture-owner': 'owner-fixture' } }), app },
  ],
  cache: { mode: 'read-only', strict: true, dir: `${root}/cache` }, workers: 1, retries: 0,
  timeout: 120000, actionTimeout: 5000, assertionTimeout: 5000, trace: 'on', output: runOutput,
} satisfies E2EConfig;
