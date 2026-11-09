import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

describe('saved Douyin configuration on plugin start', () => {
  const env = { ...process.env };
  let dir: string;
  let runtime: typeof import('../src/dsh/runtime');
  const resolveAgent = vi.fn();
  const network = vi.fn();
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'douyin-resume-'));
    const data = join(dir, 'dsh-livestream');
    await mkdir(data, { recursive: true });
    await writeFile(join(data, 'settings.json'), JSON.stringify({ livePlatform: 'douyin', douyinRoomId: '12345678901234567', stageToken: 'fixture' }));
    await writeFile(join(data, 'live.json'), JSON.stringify({ sessionId: 'old', roomId: 42, streamId: null, logFile: null, at: Date.now(), broadcasting: true }));
    process.env.DSH_HOME = dir;
    delete process.env.DSH_LIVESTREAM_LOCAL_REHEARSAL;
    vi.stubGlobal('fetch', network);
    const host = await import('../src/dsh/index');
    runtime = await import('../src/dsh/runtime');
    host.apply({
      effect(effect: () => unknown, label?: string) { if (label === 'dsh-livestream resume') effect(); },
      provide() {},
      get: () => ({ agents: { resolveAgent } }),
      connection: { fetch: { register: () => () => {} } },
    });
    await Promise.resolve();
  });
  afterAll(async () => {
    runtime.show.dispose();
    vi.unstubAllGlobals();
    process.env = env;
    await rm(dir, { recursive: true, force: true });
  });
  it('keeps settings but neither restores a legacy snapshot nor calls a provider', () => {
    expect(runtime.settings.douyinRoomId).toBe('12345678901234567');
    expect(runtime.show.isOnAir).toBe(false);
    expect(runtime.show.hub.currentConfig).toBeNull();
    expect(resolveAgent).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });
});
