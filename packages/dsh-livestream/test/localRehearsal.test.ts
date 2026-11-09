import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

describe('local rehearsal mode', () => {
  let dir: string;
  let routes: Map<string, (request: Request) => Promise<Response> | Response>;
  let tools: string[];
  let statsTool: { execute: (args: object) => Promise<string> };
  let runtime: typeof import('../src/dsh/runtime');
  const followup = vi.fn();
  const previous = { ...process.env };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-local-test-'));
    process.env.DSH_HOME = dir;
    process.env.DSH_LIVESTREAM_LOCAL_REHEARSAL = '1';
    process.env.DSH_LIVESTREAM_TTS_BACKEND = 'macos';
    const host = await import('../src/dsh/index');
    const agent = await import('../src/dsh/agent');
    runtime = await import('../src/dsh/runtime');
    routes = new Map();
    tools = [];
    host.apply({
      effect(effect: () => unknown, label?: string) {
        if (['state', 'account', 'connect', 'login start', 'login poll', 'broadcast start', 'broadcast stop', 'obs check'].includes(label ?? '')) effect();
      },
      provide() {},
      connection: { fetch: { register(route: { path: string; fetch: (request: Request) => Response }) { routes.set(route.path, route.fetch); return () => {}; } } },
    });
    agent.apply({
      effect(effect: () => unknown, label?: string) { if (label?.endsWith(' tool')) effect(); },
      tools: { register(tool: { name: string; execute: (args: object) => Promise<string> }) { tools.push(tool.name); statsTool = tool; return () => {}; } },
      get(name: string) { return name === 'agents' ? { get: () => ({ followup }) } : undefined; },
    });
  });

  afterAll(async () => {
    process.env = previous;
    await rm(dir, { recursive: true, force: true });
  });

  it('returns local status and refuses account, stream and OBS operations without network calls', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network call'));
    try {
      const account = await routes.get('/api/dsh-livestream/account')!(new Request('http://localhost/'));
      expect(await account.json()).toEqual({ ok: true, account: null });
      for (const path of ['connect', 'login/start', 'login/poll', 'broadcast/start', 'broadcast/stop', 'obs/check']) {
        const response = await routes.get(`/api/dsh-livestream/${path}`)!(new Request('http://localhost/', { method: 'POST' }));
        expect(response.status).toBe(400);
      }
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  it('exposes only the local statistics tool', () => {
    expect(tools).toEqual(['show_stats']);
  });

  it('exposes runtime mode alongside the existing state without changing saved settings', async () => {
    const response = await routes.get('/api/dsh-livestream/state')!(new Request('http://localhost/'));
    const state = await response.json();
    expect(state.runtime).toEqual({ localRehearsal: true, ttsBackend: 'macos' });
    expect(state.settings).toHaveProperty('distillModel');
    expect(runtime.settings).not.toHaveProperty('runtime');
  });

  it('tells the agent and stage the actual local capabilities', async () => {
    const events: Array<{ type: string; text?: string }> = [];
    const unsubscribe = runtime.show.stage.subscribe((event) => events.push(event), false);
    unsubscribe();
    expect(events.find((event) => event.type === 'board')?.text).toContain('本地彩排');
    expect(await runtime.hooks.push('test-session', '开场')).toBe(true);
    const message = followup.mock.calls.at(-1)?.[0];
    expect(message.content[0].text).toContain('视频、游戏、账号和社交工具均不可用');
    expect(message.content[0].text).toContain('开场');
  });

  it('reports yovoice as local speech without a cloud TTS charge', async () => {
    process.env.DSH_LIVESTREAM_TTS_BACKEND = 'yovoice';
    try {
      const response = await routes.get('/api/dsh-livestream/state')!(new Request('http://localhost/'));
      expect((await response.json()).runtime.ttsBackend).toBe('yovoice');
      const result = await statsTool.execute({});
      expect(result).toContain('使用本地语音');
      expect(result).not.toContain('3 元一万字');
    } finally {
      process.env.DSH_LIVESTREAM_TTS_BACKEND = 'macos';
    }
  });
});
