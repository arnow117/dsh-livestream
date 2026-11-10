import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('pending Bili connection ownership', () => {
  let dir: string;
  let runtime: typeof import('../src/dsh/runtime');
  const routes = new Map<string, (request: Request) => Response | Promise<Response>>();
  const env = { ...process.env };
  const post = (path: string, value: object = {}) => routes.get(`/api/dsh-livestream/${path}`)!(new Request('http://localhost/', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
  }));
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bili-connect-'));
    process.env.DSH_HOME = dir;
    delete process.env.DSH_LIVESTREAM_LOCAL_REHEARSAL;
    const host = await import('../src/dsh/index');
    runtime = await import('../src/dsh/runtime');
    host.apply({
      effect(effect: () => unknown, label?: string) {
        if (['state', 'settings', 'connect', 'disconnect'].includes(label ?? '')) effect();
      },
      provide() {},
      connection: { fetch: { register(route: { path: string; fetch: (request: Request) => Response }) { routes.set(route.path, route.fetch); return () => {}; } } },
    });
  });
  afterAll(async () => {
    runtime.show.dispose();
    process.env = env;
    await rm(dir, { recursive: true, force: true });
  });
  it('rejects concurrent connect and platform changes while credentials are pending', async () => {
    expect((await post('settings', { roomId: 42 })).status).toBe(200);
    let resolve!: (value: string) => void;
    runtime.hooks.secret = () => new Promise((done) => { resolve = done; });
    const pending = post('connect');
    expect((await post('connect')).status).toBe(409);
    expect((await post('settings', { livePlatform: 'douyin' })).status).toBe(409);
    await post('disconnect');
    resolve('fake');
    expect((await pending).status).toBe(409);
    expect(runtime.show.hub.currentConfig).toBeNull();
    expect((await post('settings', { livePlatform: 'douyin' })).status).toBe(200);
  });

  it('only accepts the matching pending connection identifier for an old revision', async () => {
    await post('settings', { livePlatform: 'bilibili' });
    const state = async () => (await routes.get('/api/dsh-livestream/state')!(new Request('http://localhost/'))).json();
    const firstRevision = (await state()).roomControl.controlRevision;
    let resolveFirst!: (value: string) => void;
    let startedFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => { startedFirst = resolve; });
    runtime.hooks.secret = () => new Promise((resolve) => { resolveFirst = resolve; startedFirst(); });
    const first = post('connect', { controlRevision: firstRevision, connectId: 'first-connect' });
    await firstStarted;
    expect((await post('disconnect', { controlRevision: firstRevision })).status).toBe(409);
    expect((await post('disconnect', { controlRevision: firstRevision, cancelConnectId: 'wrong' })).status).toBe(409);
    expect((await post('disconnect', { controlRevision: firstRevision, cancelConnectId: 'first-connect' })).status).toBe(200);
    resolveFirst('fake');
    expect((await first).status).toBe(409);

    const nextRevision = (await state()).roomControl.controlRevision;
    let resolveSecond!: (value: string) => void;
    let startedSecond!: () => void;
    const secondStarted = new Promise<void>((resolve) => { startedSecond = resolve; });
    runtime.hooks.secret = () => new Promise((resolve) => { resolveSecond = resolve; startedSecond(); });
    const second = post('connect', { controlRevision: nextRevision, connectId: 'second-connect' });
    await secondStarted;
    expect((await post('disconnect', { controlRevision: firstRevision, cancelConnectId: 'first-connect' })).status).toBe(409);
    expect((await post('disconnect', { controlRevision: nextRevision, cancelConnectId: 'second-connect' })).status).toBe(200);
    resolveSecond('fake');
    expect((await second).status).toBe(409);
    expect(runtime.show.hub.currentConfig).toBeNull();
  });
});
