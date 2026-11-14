import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const port = Number(process.argv[2]);
const taskRoot = process.env.DSH_PUBLIC_CHAT_E2E_ROOT;
const builtRoot = process.env.DSH_PUBLIC_CHAT_BUILT_ROOT;
if (!taskRoot || !builtRoot || !Number.isSafeInteger(port) || port <= 0 || [3080, 3081, 7390, 8757].includes(port)) {
  throw new Error('isolated fixture configuration required');
}
const dataDir = join(process.env.DSH_HOME, 'dsh-livestream');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ stagePort: 0, stageToken: 'fixture-stage-token',
  livePlatform: 'douyin', douyinRoomId: '101' }), { mode: 0o600 });
const sdk = process.env.DSH_PUBLIC_CHAT_E2E_SDK_ROOT;
if (!sdk) throw new Error('public SDK root required');
const { Context } = await import(pathToFileURL(join(sdk, '@deepseek-ai/cordis/lib/index.js')).href);
const { HostConnectionService } = await import(pathToFileURL(join(sdk, '@deepseek-ai/dsh-client-connection/lib/index.js')).href);
const ctx = new Context();
const connection = new HostConnectionService(ctx, [], {
  isAuthenticated: (request) => request.headers['x-fixture-owner'] === 'owner-fixture',
  authenticateApi: () => undefined,
});
const disposers = [];
const effects = new Set(['state', 'settings', 'public chat', 'dsh-livestream public chat']);
const hostContext = {
  effect(effect, label) {
    if (!effects.has(label)) return;
    const dispose = effect();
    if (typeof dispose === 'function') disposers.push(dispose);
  },
  get() { return undefined; },
  provide() {},
  connection: { fetch: connection.fetch },
};
const host = await import(pathToFileURL(join(builtRoot, 'index.js')).href);
const runtime = await import(pathToFileURL(process.env.DSH_PUBLIC_CHAT_BUILT_RUNTIME).href);
host.apply(hostContext);
const handler = connection.createSharedFetchHandler('/api');
let failNextSave = false;
let settingsPosts = 0;
let publicActions = 0;
const server = createServer((request, response) => {
  void (async () => {
    if (request.url === '/') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><html><body><div id="app"></div><script src="/console.js"></script></body></html>');
      return;
    }
    if (request.url === '/console.js') {
      response.writeHead(200, { 'content-type': 'text/javascript' });
      response.end(readFileSync(join(taskRoot, 'output/e2e-console.js')));
      return;
    }
    if (request.url === '/fixture-counts') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ settingsPosts, publicActions }));
      return;
    }
    if (request.url === '/fixture-finish') {
      response.once('finish', () => { void close().then(() => process.exit(0)); });
      response.writeHead(204); response.end(); return;
    }
    if (request.url === '/fixture-fail-next-save') {
      failNextSave = true;
      response.writeHead(204); response.end(); return;
    }
    const admission = connection.admit(request);
    if ('rejection' in admission) { response.writeHead(admission.rejection); response.end(); return; }
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    if (request.url === '/api/dsh-livestream/settings' && request.method === 'POST') {
      settingsPosts++;
      if (failNextSave) {
        failNextSave = false;
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: false, error: 'fixture failure' }));
        return;
      }
    }
    if (request.url === '/api/dsh-livestream/public-chat' && request.method === 'POST') publicActions++;
    const result = await handler.fetch(new Request(`http://127.0.0.1:${port}${request.url}`, {
      method: request.method, headers: { 'content-type': 'application/json' }, ...(body.length ? { body } : {}),
    }), admission.peer);
    response.writeHead(result.status, Object.fromEntries(result.headers.entries()));
    response.end(Buffer.from(await result.arrayBuffer()));
  })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
});
server.listen(port, '127.0.0.1', () => console.log(`owned-e2e-listener pid=${process.pid} port=${port}`));
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  server.closeAllConnections();
  for (const dispose of disposers.reverse()) await dispose();
  runtime.show.dispose();
  await ctx.fiber.dispose();
  await new Promise((resolve) => { server.close(resolve); server.closeIdleConnections(); });
  console.log(`owned-e2e-listener pid=${process.pid} closed`);
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void close().then(() => process.exit(0)); });
