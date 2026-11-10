import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('room control snapshots and atomic targets', () => {
  const environment = { ...process.env };
  const routes = new Map<string, (request: Request) => Response | Promise<Response>>();
  let directory: string;
  let bridge: Server;
  let bridgeStatus: 'missing' | 'live' | 'malformed' = 'missing';
  let mutations = 0;
  let runtime: typeof import('../src/dsh/runtime');

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'room-control-'));
    bridge = createServer((request, response) => {
      if (request.method !== 'GET') mutations += 1;
      response.setHeader('content-type', 'application/json');
      if (request.url === '/api/stats') return response.end(JSON.stringify({ uptimeSec: 1 }));
      if (bridgeStatus === 'missing') {
        response.statusCode = 404;
        return response.end('{}');
      }
      if (bridgeStatus === 'malformed') return response.end('{');
      return response.end(JSON.stringify({ room: { roomId: '123', status: 'live' } }));
    });
    await new Promise<void>((resolve, reject) => {
      bridge.once('error', reject);
      bridge.listen(0, '127.0.0.1', resolve);
    });
    const address = bridge.address();
    if (!address || typeof address === 'string') throw new Error('missing fixture address');
    process.env.DSH_HOME = directory;
    process.env.DSH_LIVESTREAM_LOCAL_REHEARSAL = '1';
    process.env.DSH_LIVESTREAM_DOUYIN_BRIDGE_URL = `http://127.0.0.1:${address.port}`;
    const host = await import('../src/dsh/index');
    runtime = await import('../src/dsh/runtime');
    host.apply({
      effect(effect: () => unknown, label?: string) {
        if (['state', 'settings', 'room control', 'collector stop'].includes(label ?? '')) effect();
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
    if (bridge?.listening) {
      await new Promise<void>((resolve, reject) => bridge.close((error) => error ? reject(error) : resolve()));
    }
    process.env = environment;
    await rm(directory, { recursive: true, force: true });
  });

  const call = (path: string, body?: object) => routes.get(`/api/dsh-livestream/${path}`)!(new Request('http://localhost/', body === undefined
    ? undefined
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));

  it('saves platform and room together, rejects stale revision, and queries only the saved room', async () => {
    const initial = await (await call('state')).json();
    const save = await call('settings', { livePlatform: 'douyin', douyinRoomId: '123', controlRevision: initial.roomControl.controlRevision });
    expect(save.status).toBe(200);
    const saved = await save.json();
    expect(saved.settings).toMatchObject({ livePlatform: 'douyin', douyinRoomId: '123' });
    expect(saved.roomControl.controlRevision).not.toBe(initial.roomControl.controlRevision);
    expect((await call('settings', { douyinRoomId: '456', controlRevision: initial.roomControl.controlRevision })).status).toBe(409);
    expect(runtime.settings.douyinRoomId).toBe('123');
    expect((await (await call('room-control')).json()).roomControl).toMatchObject({ bridge: 'online', collector: 'missing' });
    bridgeStatus = 'live';
    expect((await (await call('room-control')).json()).roomControl).toMatchObject({ bridge: 'online', collector: 'live' });
    bridgeStatus = 'malformed';
    expect((await (await call('room-control')).json()).roomControl).toMatchObject({ bridge: 'offline', collector: 'unknown' });
    expect(mutations).toBe(0);
  });

  it('rejects an old stop after changing A to B and back to A', async () => {
    const original = (await (await call('state')).json()).roomControl.controlRevision;
    const first = await (await call('settings', { douyinRoomId: '456', controlRevision: original })).json();
    const second = await (await call('settings', { douyinRoomId: '123', controlRevision: first.roomControl.controlRevision })).json();
    expect(second.roomControl.controlRevision).not.toBe(original);
    expect((await call('collector/stop', { controlRevision: original, confirmSharedEffect: true })).status).toBe(409);
    expect(mutations).toBe(0);
  });
});
