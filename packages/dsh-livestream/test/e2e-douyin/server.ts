import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';

const port = Number(process.argv[2]);
const dir = await mkdtemp(join(tmpdir(), 'douyin-ui-'));
const bridge = createServer(async (request, response) => {
  response.setHeader('content-type', 'application/json');
  if (request.url === '/api/stats') return response.end(JSON.stringify({ uptimeSec: 1 }));
  if (request.url === '/api/accounts') return response.end(JSON.stringify({ accounts: [{ id: 'fixture-anonymous', name: 'dsh-livestream-anonymous-fixture', hasCookie: false, hasLogin: false }] }));
  if (request.url === '/api/rooms/connect' && request.method === 'POST') {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString());
    startRequests++;
    if (unknownStart) return response.end('{');
    room = input.roomId;
    bridgeStatus = 'connecting';
    return response.end(JSON.stringify({ ok: true, room: { roomId: room, status: bridgeStatus, startedAt: Date.now() } }));
  }
  if (request.url === `/api/rooms/${room}/disconnect` && request.method === 'POST') {
    stopRequests++;
    bridgeStatus = 'stopped';
    return response.end(JSON.stringify({ ok: true }));
  }
  const requestedRoom = request.url?.match(/^\/api\/rooms\/(\d+)$/)?.[1];
  if (requestedRoom && !room) {
    response.statusCode = 404;
    return response.end('{}');
  }
  response.end(JSON.stringify({ room: { roomId: requestedRoom ?? room, status: bridgeStatus } }));
});
const sockets = new WebSocketServer({ server: bridge });
let bridgeStatus = 'connecting';
let room = '';
let subscriptions = 0;
let stopRequests = 0;
let startRequests = 0;
let unknownStart = false;
let selectedPreset = '';
const prompts: string[] = [];
sockets.on('connection', (socket, request) => {
  subscriptions++;
  room = new URL(request.url ?? '/', 'http://localhost').searchParams.get('roomId') ?? '';
  socket.send(JSON.stringify({ type: '__connected', roomId: room, room: { roomId: room, status: bridgeStatus } }));
});
await new Promise<void>((resolve) => bridge.listen(0, '127.0.0.1', resolve));
const address = bridge.address();
if (!address || typeof address === 'string') throw new Error('missing bridge port');
if ([3080, 3081, 7390, 8757].includes(address.port)) throw new Error('fixture selected a shared service port');
console.log(`fixture bridge listening on 127.0.0.1:${address.port}`);
process.env.DSH_HOME = dir;
process.env.DSH_LIVESTREAM_LOCAL_REHEARSAL = '1';
process.env.DSH_LIVESTREAM_TTS_BACKEND = 'macos';
process.env.DSH_LIVESTREAM_DOUYIN_BRIDGE_URL = `http://127.0.0.1:${address.port}`;
let sharedRequests = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
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
let stageRequests = 0;
(runtime.show as any).hooks.push = async (_session: string, prompt: string) => { prompts.push(prompt); return true; };
(runtime.show as any).hooks.synthesize = async () => null;
const routes = new Map<string, (request: Request) => Response | Promise<Response>>();
host.apply({
  effect(effect: () => unknown, label?: string) {
    if (['state', 'settings', 'room control', 'connect', 'disconnect', 'collector stop', 'onair', 'offair', 'events', 'simulate'].includes(label ?? '')) effect();
  },
  provide() {},
  connection: { fetch: { register(route: { path: string; fetch: (request: Request) => Response }) { routes.set(route.path, route.fetch); return () => {}; } } },
});
function send(frame: unknown): void {
  for (const socket of sockets.clients) socket.send(JSON.stringify(frame));
}
const app = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script src="/client.js"></script></body></html>');
    return;
  }
  if (url.pathname === '/__stage') {
    stageRequests++;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>本地测试舞台</title>');
    return;
  }
  if (url.pathname === '/client.js') {
    res.writeHead(200, { 'content-type': 'application/javascript' });
    res.end(await readFile(new URL('./client.js', import.meta.url)));
    return;
  }
  if (url.pathname === '/__reset') {
    runtime.show.endLive();
    runtime.show.dispose();
    runtime.updateSettings({ livePlatform: 'bilibili', douyinRoomId: '', roomId: null });
    runtime.show.setPlatform('bilibili');
    bridgeStatus = 'connecting';
    room = '';
    subscriptions = 0;
    stopRequests = 0;
    startRequests = 0;
    unknownStart = false;
    sharedRequests = 0;
    prompts.length = 0;
    selectedPreset = '';
    res.end('ok');
    return;
  }
  if (url.pathname === '/__live') {
    bridgeStatus = 'live';
    send({ id: 'status-live', type: 'roomStatus', platform: 'douyin', roomId: room, ts: Date.now(), data: { status: 'live' } });
    res.end('ok');
    return;
  }
  if (url.pathname === '/__unknown-start') { unknownStart = true; res.end('ok'); return; }
  if (url.pathname === '/__error') {
    bridgeStatus = 'error';
    send({ type: '__connected', roomId: room, room: { roomId: room, status: 'connecting', progress: { step: 'error', message: '测试故障' } } });
    res.end('ok');
    return;
  }
  if (url.pathname === '/__rearm') {
    bridgeStatus = 'connecting';
    res.end('ok');
    return;
  }
  if (url.pathname === '/__drop') {
    for (const socket of sockets.clients) socket.terminate();
    res.end('ok');
    return;
  }
  if (url.pathname === '/__chat') {
    runtime.show.turnEnded('fake-brain');
    send({ id: 'chat-1', type: 'chat', platform: 'douyin', roomId: room, ts: Date.now(), user: { id: '42', nickname: '测试观众' }, data: { content: '测试弹幕' } });
    res.end('ok');
    return;
  }
  if (url.pathname === '/__preset') {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    selectedPreset = Buffer.concat(chunks).toString();
    res.end('ok');
    return;
  }
  if (url.pathname === '/__fixture') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ subscriptions, startRequests, stopRequests, sharedRequests, bridgeStatus, selectedPreset, prompts, stageRequests, stageUrl: runtime.server.url, status: runtime.show.status(), settings: runtime.settings }));
    return;
  }
  const handler = routes.get(url.pathname);
  if (!handler) { res.writeHead(404); res.end(); return; }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  try {
    const response = await handler(new Request(url, {
      method: req.method,
      headers: { 'content-type': 'application/json' },
      ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}),
      signal: controller.signal,
    }));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (!response.body) { res.end(); return; }
    const reader = response.body.getReader();
    while (!controller.signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  } catch {
    if (!res.destroyed) { res.writeHead(500); res.end(); }
  }
});
app.listen(port, '127.0.0.1');
const shutdown = () => {
  console.log(`fixture shutdown: app ${port}, bridge ${address.port}`);
  runtime.show.dispose();
  for (const socket of sockets.clients) socket.terminate();
  sockets.close();
  app.closeAllConnections();
  bridge.closeAllConnections();
  app.close();
  bridge.close();
  void rm(dir, { recursive: true, force: true }).then(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
