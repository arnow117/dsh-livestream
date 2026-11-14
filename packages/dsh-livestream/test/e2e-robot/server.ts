/**
 * 机器人联动 E2E fixture：真实插件路由（state/settings/robot task）+ 真实控制台，
 * 不安装 dsh-qdroid（联动不可用的原因分支由真实装配路径产生）。
 */

import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const port = Number(process.argv[2]);
const dir = await mkdtemp(join(tmpdir(), 'dsh-robot-e2e-'));
process.env.DSH_HOME = dir;
process.env.DSH_LIVESTREAM_LOCAL_REHEARSAL = '1';
await mkdir(join(dir, 'dsh-livestream'), { recursive: true });
await writeFile(join(dir, 'dsh-livestream', 'settings.json'), JSON.stringify({ stageToken: 'fixture', stagePort: 0 }));

let sharedRequests = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && ['3080', '3081', '7390', '8757'].includes(url.port)) {
    sharedRequests++;
    throw new Error('fixture blocked a shared service request');
  }
  return originalFetch(input, init);
};

const host = await import('../../src/dsh/index');
const runtime = await import('../../src/dsh/runtime');
Object.defineProperty(runtime.server, 'url', { get: () => `http://127.0.0.1:${port}/__stage?token=fixture` });
const routes = new Map<string, (request: Request) => Response | Promise<Response>>();
let disposeRobot = () => {};
host.apply({
  effect(effect: () => unknown, label?: string) {
    if (label === 'dsh-livestream robot live') disposeRobot = (effect() as () => void) ?? (() => {});
    else if (['state', 'settings', 'robot task get', 'robot task cancel'].includes(label ?? '')) effect();
  },
  provide() {},
  get() { return undefined; },
  connection: { fetch: { register(route: { path: string; fetch: (request: Request) => Response | Promise<Response> }) { routes.set(route.path, route.fetch); return () => {}; } } },
});

const app = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  res.setHeader('cache-control', 'no-store');
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script src="/client.js"></script></body></html>');
  }
  if (url.pathname === '/__stage') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end('<!doctype html><title>本地测试舞台</title>');
  }
  if (url.pathname === '/client.js') {
    res.writeHead(200, { 'content-type': 'application/javascript' });
    return res.end(await readFile(new URL('./client.js', import.meta.url), 'utf8'));
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (url.pathname === '/__save-robot') {
    const stateRoute = routes.get('/api/dsh-livestream/state')!;
    const current = await (await stateRoute(new Request('http://fixture/'))).json();
    void current;
    const settingsRoute = routes.get('/api/dsh-livestream/settings')!;
    const response = await settingsRoute(new Request('http://fixture/', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: Buffer.concat(chunks),
    }));
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ status: response.status, body: await response.json() }));
  }
  if (url.pathname === '/__fixture') {
    res.writeHead(200, { 'content-type': 'application/json' });
    const stateRoute = routes.get('/api/dsh-livestream/state')!;
    const state = await (await stateRoute(new Request('http://fixture/'))).json();
    return res.end(JSON.stringify({
      robot: state.robot,
      savedRobotLive: runtime.settings.robotLive ?? null,
      sharedRequests,
    }));
  }
  const handler = routes.get(url.pathname);
  if (!handler) { res.writeHead(404); return res.end(); }
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  try {
    const response = await handler(new Request(url, { method: req.method, headers: { 'content-type': 'application/json' }, ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}), signal: controller.signal }));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    if (!res.destroyed) { res.writeHead(500); res.end(); }
  }
});
app.listen(port, '127.0.0.1');
const shutdown = () => {
  disposeRobot();
  app.closeAllConnections();
  app.close(() => { void rm(dir, { recursive: true, force: true }).then(() => process.exit(0)); });
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
