import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  class Socket extends EventEmitter {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 0;
    constructor(url: URL) {
      super();
      const roomId = url.searchParams.get('roomId');
      queueMicrotask(() => {
        this.readyState = 1;
        this.emit('open');
        this.emit('message', Buffer.from(JSON.stringify({ type: '__connected', roomId, room: { roomId, status: 'connecting' } })));
      });
    }
    terminate() { this.readyState = 3; this.emit('close'); }
    ping() {}
  }
  return { default: Socket };
});

describe('explicit owner subscription', () => {
  let dir: string;
  let runtime: typeof import('../src/dsh/runtime');
  const env = { ...process.env };
  const routes = new Map<string, (request: Request) => Response | Promise<Response>>();
  const post = (path: string, value: object = {}) => routes.get(`/api/dsh-livestream/${path}`)!(new Request('http://localhost/', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
  }));
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'douyin-connect-'));
    process.env.DSH_HOME = dir;
    process.env.DSH_LIVESTREAM_LOCAL_REHEARSAL = '1';
    process.env.DSH_LIVESTREAM_DOUYIN_BRIDGE_URL = 'http://127.0.0.1:1';
    vi.stubGlobal('fetch', async (input: URL | string) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/accounts') return Response.json({ accounts: [{ id: 'anon', name: 'dsh-livestream-anonymous-test', hasCookie: false, hasLogin: false }] });
      return Response.json({ room: { roomId: '1234567890123456789', status: 'connecting' } });
    });
    const host = await import('../src/dsh/index');
    runtime = await import('../src/dsh/runtime');
    host.apply({
      effect(effect: () => unknown, label?: string) {
        if (['settings', 'connect', 'disconnect'].includes(label ?? '')) effect();
      },
      provide() {},
      connection: { fetch: { register(route: { path: string; fetch: (request: Request) => Response }) { routes.set(route.path, route.fetch); return () => {}; } } },
    });
  });
  afterAll(async () => {
    runtime.show.dispose();
    vi.unstubAllGlobals();
    process.env = env;
    await rm(dir, { recursive: true, force: true });
  });
  it('requires a saved room, then holds the target until explicit disconnect', async () => {
    expect((await post('settings', { livePlatform: 'douyin' })).status).toBe(200);
    expect((await post('connect')).status).toBe(400);
    expect((await post('settings', { douyinRoomId: '1234567890123456789' })).status).toBe(200);
    expect((await post('connect')).status).toBe(200);
    expect(runtime.show.hub.currentConfig).toMatchObject({ platform: 'douyin', roomId: '1234567890123456789' });
    expect((await post('connect')).status).toBe(409);
    expect((await post('settings', { livePlatform: 'bilibili' })).status).toBe(409);
    expect((await post('disconnect')).status).toBe(200);
    expect(runtime.show.hub.currentConfig).toBeNull();
    expect((await post('settings', { livePlatform: 'bilibili' })).status).toBe(200);
  });
});
