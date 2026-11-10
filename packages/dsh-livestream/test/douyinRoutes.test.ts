import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { beginBiliOperation } from '../src/shared/biliOperations';

describe('Douyin owner settings', () => {
  let dir: string;
  let routes: Map<string, (request: Request) => Promise<Response> | Response>;
  let runtime: typeof import('../src/dsh/runtime');
  const env = { ...process.env };
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'douyin-routes-'));
    process.env.DSH_HOME = dir;
    process.env.DSH_LIVESTREAM_LOCAL_REHEARSAL = '1';
    const host = await import('../src/dsh/index');
    runtime = await import('../src/dsh/runtime');
    routes = new Map();
    host.apply({
      effect(effect: () => unknown, label?: string) {
        if (['state', 'settings', 'disconnect', 'simulate', 'account', 'onair'].includes(label ?? '')) effect();
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
  const post = (path: string, value: object) => routes.get(`/api/dsh-livestream/${path}`)!(new Request('http://localhost/', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
  }));

  it('uses the platform default while preserving custom and empty boards', async () => {
    const boards: string[] = [];
    const unsubscribe = runtime.show.stage.subscribe((event) => {
      if (event.type === 'board') boards.push(event.text);
    }, false);
    try {
      await post('settings', { livePlatform: 'douyin' });
      runtime.publishBoard();
      expect(boards.at(-1)).toBe('和大肥鱼聊聊天\n发弹幕提问，一起聊聊有趣的事\n谢谢大家的陪伴与支持');
      await post('settings', { boardText: '自定义告示' });
      expect(boards.at(-1)).toBe('自定义告示');
      await post('settings', { boardText: '' });
      expect(boards.at(-1)).toBe('');
      await post('settings', { boardText: runtime.DEFAULT_BOARD, livePlatform: 'bilibili' });
      runtime.publishBoard();
      expect(boards.at(-1)).toBe('本地彩排\n和主人聊天，回应模拟观众的弹幕与礼物');
    } finally {
      unsubscribe();
    }
  });

  it('persists a string ID, rejects invalid input and preserves existing Bili settings', async () => {
    const id = '90071992547409931234567';
    expect((await post('settings', { livePlatform: 'douyin', douyinRoomId: `https://live.douyin.com/${id}` })).status).toBe(200);
    expect(runtime.settings.douyinRoomId).toBe(id);
    expect((await post('settings', { douyinRoomId: 123 })).status).toBe(400);
    expect(runtime.settings.douyinRoomId).toBe(id);
    expect((await post('settings', { ownRoom: true })).status).toBe(400);
    const secret = vi.fn();
    runtime.hooks.secret = secret;
    await expect(runtime.cookie()).rejects.toThrow('不使用 B 站 Cookie');
    expect(secret).not.toHaveBeenCalled();
  });
  it('rejects unsupported platform actions and a target change while on air', async () => {
    expect((await post('settings', { livePlatform: 'invalid' })).status).toBe(400);
    expect((await post('settings', { broadcast: true })).status).toBe(400);
    expect((await post('settings', { blocked: [] })).status).toBe(400);
    expect((await post('onair', { sessionId: 'fake-brain', gameSessionId: 'blocked-game' })).status).toBe(200);
    expect(runtime.show.currentGameSession).toBeNull();
    try {
      const response = await post('settings', { douyinRoomId: '999' });
      expect(response.status).toBe(409);
      expect(runtime.settings.douyinRoomId).toBe('90071992547409931234567');
    } finally {
      runtime.show.endLive();
      runtime.show.dispose();
    }
  });
  it('blocks a target change until an in-flight Bili operation settles', async () => {
    const lease = beginBiliOperation();
    try {
      const response = await post('settings', { livePlatform: 'bilibili' });
      expect(response.status).toBe(409);
      expect(runtime.settings.livePlatform).toBe('douyin');
    } finally { lease.release(); }
    expect((await post('settings', { livePlatform: 'bilibili' })).status).toBe(200);
  });
  it('does not retain a previous platform viewer after disconnect and switch', async () => {
    await post('settings', { livePlatform: 'douyin' });
    runtime.show.inject({ kind: 'chat', platform: 'douyin', id: 'one', ts: Date.now(), user: { id: '1234', name: '旧观众' }, text: 'hello' });
    expect(runtime.show.hub.recentEvents()).toHaveLength(1);
    await post('disconnect', {});
    await post('settings', { livePlatform: 'bilibili' });
    expect(runtime.show.hub.recentEvents()).toHaveLength(0);
    expect(runtime.show.knowsViewer('1234')).toBe(false);
    expect(runtime.show.lookupViewer('1234')).toEqual({ kind: 'missing', suggestions: [] });
  });
});
