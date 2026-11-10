import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

describe('host apply lifecycle owns the room controller', () => {
  const environment = { ...process.env };
  let directory: string;
  let runtime: typeof import('../src/dsh/runtime');
  let host: typeof import('../src/dsh/index');
  let releaseResponse!: (response: Response) => void;
  let dispatched = false;
  let mutations = 0;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'room-control-lifecycle-'));
    process.env.DSH_HOME = directory;
    process.env.DSH_LIVESTREAM_LOCAL_REHEARSAL = '1';
    process.env.DSH_LIVESTREAM_DOUYIN_BRIDGE_URL = 'http://127.0.0.1:1234';
    vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/stats') return Response.json({ uptimeSec: 1 });
      if (path === '/api/accounts') return Response.json({ accounts: [{ id: 'anon', name: 'dsh-livestream-anonymous-test', hasCookie: false, hasLogin: false }] });
      if (path === '/api/rooms/123') return Response.json({}, { status: 404 });
      if (path === '/api/rooms/connect' && init?.method === 'POST') {
        mutations++;
        dispatched = true;
        return new Promise<Response>((resolve) => { releaseResponse = resolve; });
      }
      throw new Error(`unexpected request: ${path}`);
    });
    host = await import('../src/dsh/index');
    runtime = await import('../src/dsh/runtime');
  });

  afterAll(async () => {
    runtime.show.dispose();
    vi.unstubAllGlobals();
    process.env = environment;
    await rm(directory, { recursive: true, force: true });
  });

  function apply() {
    const routes = new Map<string, (request: Request) => Response | Promise<Response>>();
    let dispose = () => {};
    host.apply({
      effect(effect: () => () => void, label?: string) {
        if (label === 'dsh-livestream room control') dispose = effect();
        else if (['state', 'settings', 'connect'].includes(label ?? '')) effect();
      },
      provide() {},
      connection: { fetch: { register(route: { path: string; fetch: (request: Request) => Response }) {
        routes.set(route.path, route.fetch);
        return () => {};
      } } },
    });
    const call = (path: string, body?: object) => routes.get(`/api/dsh-livestream/${path}`)!(new Request('http://localhost/', body === undefined
      ? undefined
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    return { call, dispose };
  }

  it('reloads the persisted unknown marker on reapply and ignores the prior handler’s late response', async () => {
    const initial = apply();
    expect((await initial.call('settings', { livePlatform: 'douyin', douyinRoomId: '123' })).status).toBe(200);
    const initialRevision = (await (await initial.call('state')).json()).roomControl.controlRevision;
    initial.dispose();
    const first = apply();
    const before = (await (await first.call('state')).json()).roomControl;
    expect(before.operation.state).toBe('idle');
    expect(before.controlRevision).not.toBe(initialRevision);
    const pending = first.call('connect', { controlRevision: before.controlRevision, action: 'connect' });
    await vi.waitFor(() => expect(dispatched).toBe(true));
    const journalFile = join(directory, 'dsh-livestream', 'douyin-control.json');
    const original = await readFile(journalFile, 'utf8');
    first.dispose();
    const next = apply();
    const restored = (await (await next.call('state')).json()).roomControl;
    expect(restored.operation.state).toBe('unknown');
    expect(restored.controlRevision).not.toBe(before.controlRevision);
    releaseResponse(Response.json({ ok: true, room: { roomId: '123', status: 'connecting', startedAt: 200 } }));
    await pending;
    await Promise.resolve();
    expect(await readFile(journalFile, 'utf8')).toBe(original);
    expect((await (await next.call('state')).json()).roomControl.operation.state).toBe('unknown');
    expect(mutations).toBe(1);
    next.dispose();
  });
});
