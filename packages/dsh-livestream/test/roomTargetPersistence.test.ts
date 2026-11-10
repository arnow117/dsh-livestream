import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const faults = vi.hoisted(() => ({ fail: false }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (faults.fail && String(args[1]).endsWith('settings.json')) throw new Error('injected settings failure');
      return actual.renameSync(...args);
    },
  };
});

describe('room target persistence through the owner route', () => {
  const environment = { ...process.env };
  const routes = new Map<string, (request: Request) => Response | Promise<Response>>();
  let directory: string;
  let runtime: typeof import('../src/dsh/runtime');
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'room-target-persistence-'));
    process.env.DSH_HOME = directory;
    const host = await import('../src/dsh/index');
    runtime = await import('../src/dsh/runtime');
    host.apply({
      effect(effect: () => unknown, label?: string) {
        if (['state', 'settings'].includes(label ?? '')) effect();
      },
      provide() {},
      connection: { fetch: { register(route: { path: string; fetch: (request: Request) => Response }) {
        routes.set(route.path, route.fetch);
        return () => {};
      } } },
    });
  });
  afterAll(async () => {
    runtime.show.dispose();
    process.env = environment;
    await rm(directory, { recursive: true, force: true });
  });
  const save = (value: object) => routes.get('/api/dsh-livestream/settings')!(new Request('http://localhost/', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
  }));

  it('keeps the saved platform, both room fields, revision and disk unchanged when rename fails', async () => {
    expect((await save({ roomId: 42 })).status).toBe(200);
    const before = await readFile(join(directory, 'dsh-livestream', 'settings.json'), 'utf8');
    const state = await (await routes.get('/api/dsh-livestream/state')!(new Request('http://localhost/'))).json();
    faults.fail = true;
    try {
      expect((await save({ livePlatform: 'douyin', douyinRoomId: '123', controlRevision: state.roomControl.controlRevision })).status).toBe(500);
    } finally {
      faults.fail = false;
    }
    const after = await (await routes.get('/api/dsh-livestream/state')!(new Request('http://localhost/'))).json();
    expect(after.settings).toMatchObject({ livePlatform: 'bilibili', roomId: 42, douyinRoomId: '' });
    expect(after.roomControl.controlRevision).toBe(state.roomControl.controlRevision);
    expect(await readFile(join(directory, 'dsh-livestream', 'settings.json'), 'utf8')).toBe(before);
  });
});
