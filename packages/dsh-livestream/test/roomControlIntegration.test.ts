import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

describe('room control with a controlled collector', () => {
  const environment = { ...process.env };
  const routes = new Map<string, (request: Request) => Response | Promise<Response>>();
  const requests: { method: string; url: string; body: unknown }[] = [];
  let directory: string;
  let bridge: Server;
  let sockets: WebSocketServer;
  let runtime: typeof import('../src/dsh/runtime');
  let status: string | null = 'live';
  let accounts = [{ id: 'anonymous', name: 'dsh-livestream-anonymous-fixture', hasCookie: false, hasLogin: false }];
  let subscriptions = 0;
  let simulateFallback = false;
  let fallbackAccount: typeof accounts[number] | undefined;
  let detachedAtStop = false;
  let delayCreate = false;
  let finishCreate: (() => void) | undefined;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'room-control-integration-'));
    bridge = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString();
      const value = raw ? JSON.parse(raw) : undefined;
      requests.push({ method: request.method ?? '', url: request.url ?? '', body: value });
      response.setHeader('content-type', 'application/json');
      if (request.url === '/api/accounts') return response.end(JSON.stringify({ accounts }));
      if (request.url === '/api/stats') return response.end(JSON.stringify({ uptimeSec: 10 }));
      if (request.url === '/api/rooms/123' && request.method === 'GET') {
        if (!status) { response.statusCode = 404; return response.end('{}'); }
        return response.end(JSON.stringify({ room: { roomId: '123', status, startedAt: 1234 } }));
      }
      if (request.url === '/api/rooms/connect') {
        if (delayCreate) {
          delayCreate = false;
          finishCreate = () => { status = 'connecting'; };
          request.socket.destroy();
          return;
        }
        status = 'connecting';
        return response.end(JSON.stringify({ ok: true, room: { roomId: '123', status, startedAt: 1235 } }));
      }
      if (request.url === '/api/rooms/123/disconnect') {
        detachedAtStop = runtime.show.hub.currentConfig === null;
        status = 'stopped';
        return response.end(JSON.stringify({ ok: true }));
      }
      response.statusCode = 404;
      return response.end('{}');
    });
    sockets = new WebSocketServer({ server: bridge });
    sockets.on('connection', (socket) => {
      subscriptions += 1;
      if (simulateFallback) {
        fallbackAccount = accounts.find((account) => account.name === '默认') ?? accounts[0];
        status = 'connecting';
        simulateFallback = false;
      }
      socket.send(JSON.stringify({ type: '__connected', roomId: '123', room: { roomId: '123', status } }));
    });
    await new Promise<void>((resolve, reject) => { bridge.once('error', reject); bridge.listen(0, '127.0.0.1', resolve); });
    const address = bridge.address();
    if (!address || typeof address === 'string') throw new Error('missing fixture port');
    process.env.DSH_HOME = directory;
    const settingsDir = join(directory, 'dsh-livestream');
    await mkdir(settingsDir, { recursive: true, mode: 0o700 });
    await writeFile(join(settingsDir, 'settings.json'), JSON.stringify({ stagePort: 0 }), { mode: 0o600 });
    process.env.DSH_LIVESTREAM_LOCAL_REHEARSAL = '1';
    process.env.DSH_LIVESTREAM_DOUYIN_BRIDGE_URL = `http://127.0.0.1:${address.port}`;
    const host = await import('../src/dsh/index');
    runtime = await import('../src/dsh/runtime');
    host.apply({
      effect(effect: () => unknown, label?: string) {
        if (['state', 'settings', 'room control', 'connect', 'disconnect', 'collector stop'].includes(label ?? '')) effect();
      },
      provide() {},
      connection: { fetch: { register(route: { path: string; fetch: (request: Request) => Response }) {
        routes.set(route.path, route.fetch);
        return () => {};
      } } },
    });
  });

  afterAll(async () => {
    runtime?.show.dispose();
    for (const socket of sockets?.clients ?? []) socket.terminate();
    sockets?.close();
    if (bridge?.listening) await new Promise<void>((resolve, reject) => bridge.close((error) => error ? reject(error) : resolve()));
    process.env = environment;
    await rm(directory, { recursive: true, force: true });
  });

  const call = (path: string, body?: object) => routes.get(`/api/dsh-livestream/${path}`)!(new Request('http://localhost/', body === undefined
    ? undefined
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  const snapshot = async () => (await (await call('state')).json()).roomControl;

  it('rejects an existing live room when any account is authenticated', async () => {
    await call('settings', { livePlatform: 'douyin', douyinRoomId: '123' });
    accounts = [{ id: 'logged-in', name: '默认', hasCookie: true, hasLogin: true }];
    const response = await call('connect', { controlRevision: (await snapshot()).controlRevision, action: 'connect' });
    expect(response.status).toBe(502);
    expect(subscriptions).toBe(0);
    expect(requests.filter((request) => request.method === 'POST')).toEqual([]);
  });

  it('reuses a live room without HTTP start and distinguishes unsubscribe from stop', async () => {
    accounts = [{ id: 'other-anonymous', name: 'other-anonymous', hasCookie: false, hasLogin: false }];
    const initial = await snapshot();
    const response = await call('connect', { controlRevision: initial.controlRevision, action: 'connect' });
    expect(response.status).toBe(200);
    expect(subscriptions).toBe(1);
    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(0);
    expect((await call('collector/stop', { controlRevision: initial.controlRevision, confirmSharedEffect: true })).status).toBe(409);
    const connected = await snapshot();
    expect((await call('disconnect', { controlRevision: connected.controlRevision })).status).toBe(200);
    expect(requests.filter((request) => request.url.endsWith('/disconnect'))).toHaveLength(0);
    const detached = await snapshot();
    expect((await call('connect', { controlRevision: detached.controlRevision, action: 'connect' })).status).toBe(200);
    expect((await call('collector/stop', { controlRevision: connected.controlRevision, confirmSharedEffect: true })).status).toBe(409);
    expect((await call('collector/stop', { controlRevision: (await snapshot()).controlRevision, confirmSharedEffect: true })).status).toBe(200);
    expect(requests.filter((request) => request.url.endsWith('/disconnect'))).toMatchObject([{ method: 'POST', url: '/api/rooms/123/disconnect' }]);
    expect(detachedAtStop).toBe(true);
  });

  it('starts a terminal room with an explicit anonymous account', async () => {
    accounts = [{ id: 'anonymous', name: 'dsh-livestream-anonymous-fixture', hasCookie: false, hasLogin: false }];
    const response = await call('connect', { controlRevision: (await snapshot()).controlRevision, action: 'retry' });
    expect(response.status).toBe(200);
    expect(requests.filter((request) => request.url === '/api/rooms/connect')).toMatchObject([{ body: { roomId: '123', accountId: 'anonymous' } }]);
    expect(subscriptions).toBe(3);
    await call('disconnect', { controlRevision: (await snapshot()).controlRevision });
  });

  it('keeps a WS fallback anonymous when the collector restarts after preflight', async () => {
    accounts = [{ id: 'default-anonymous', name: '默认', hasCookie: false, hasLogin: false }];
    status = 'live';
    simulateFallback = true;
    expect((await call('connect', { controlRevision: (await snapshot()).controlRevision, action: 'connect' })).status).toBe(200);
    expect(fallbackAccount).toMatchObject({ id: 'default-anonymous', hasCookie: false, hasLogin: false });
    await call('disconnect', { controlRevision: (await snapshot()).controlRevision });
  });

  it('rebuilds a terminal source on explicit retry of the same room', async () => {
    accounts = [{ id: 'anonymous', name: 'dsh-livestream-anonymous-fixture', hasCookie: false, hasLogin: false }];
    status = 'live';
    expect((await call('connect', { controlRevision: (await snapshot()).controlRevision, action: 'connect' })).status).toBe(200);
    const before = subscriptions;
    for (const socket of sockets.clients) socket.send(JSON.stringify({ type: '__error', roomId: '123', error: 'fixture error' }));
    await vi.waitFor(() => expect(runtime.show.status().live.state).toBe('error'));
    status = 'stopped';
    expect((await call('connect', { controlRevision: (await snapshot()).controlRevision, action: 'retry' })).status).toBe(200);
    expect(subscriptions).toBe(before + 1);
    await call('disconnect', { controlRevision: (await snapshot()).controlRevision });
  });

  it('protects a delayed create through the real owner handlers until a new session is observed', async () => {
    accounts = [{ id: 'anonymous', name: 'dsh-livestream-anonymous-fixture', hasCookie: false, hasLogin: false }];
    status = null;
    delayCreate = true;
    const before = await snapshot();
    expect((await call('connect', { controlRevision: before.controlRevision, action: 'connect' })).status).toBe(409);
    expect((await snapshot()).operation.state).toBe('unknown');
    const missing = await (await call('room-control')).json();
    expect(missing.roomControl).toMatchObject({ collector: 'missing', operation: { state: 'unknown' } });
    expect((await call('settings', { livePlatform: 'bilibili' })).status).toBe(409);
    expect((await call('collector/stop', { controlRevision: (await snapshot()).controlRevision, confirmSharedEffect: true })).status).toBe(409);
    finishCreate?.();
    const observed = await (await call('room-control')).json();
    expect(observed.roomControl).toMatchObject({ collector: 'connecting', operation: { state: 'idle' } });
  });
});
