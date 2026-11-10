import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

describe('platform tool selection', () => {
  let dir: string;
  let runtime: typeof import('../src/dsh/runtime');
  const env = { ...process.env };
  const tools = new Map<string, any>();
  const installed = new Map<string, any>();
  const conditions = new Map<string, any>();
  const disposers: Array<() => void> = [];
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'douyin-agent-'));
    process.env.DSH_HOME = dir;
    delete process.env.DSH_LIVESTREAM_LOCAL_REHEARSAL;
    runtime = await import('../src/dsh/runtime');
    const agent = await import('../src/dsh/agent');
    agent.apply({
      effect(effect: () => () => void, label?: string) {
        if (label?.endsWith(' tool')) disposers.push(effect());
      },
      tools: { register(tool: any, options?: any) {
        if (options?.when) conditions.set(tool.name, options.when);
        tools.set(tool.name, tool);
        installed.set(tool.name, tool);
        return () => installed.delete(tool.name);
      } },
    });
  });
  afterAll(async () => {
    for (const dispose of disposers) dispose();
    runtime.show.dispose();
    process.env = env;
    await rm(dir, { recursive: true, force: true });
  });
  it('removes Bili tools, rejects retained references, then restores tools on Bili', async () => {
    const oldTools = [...tools.values()].filter((tool) => !['show_stats', 'weather_lookup', 'public_search'].includes(tool.name));
    expect(oldTools.length).toBeGreaterThan(10);
    runtime.show.setPlatform('douyin');
    runtime.updateSettings({ livePlatform: 'douyin' });
    expect([...installed.keys()]).toEqual(['weather_lookup', 'public_search', 'show_stats']);
    for (const when of conditions.values()) expect(await when({ agent: { session: { id: 'live' } }, signal: new AbortController().signal })).toBe(false);
    const fetch = vi.spyOn(globalThis, 'fetch');
    try {
      for (const tool of oldTools) {
        expect(await tool.execute({})).toContain('抖音只读接入');
      }
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
    runtime.show.setPlatform('bilibili');
    runtime.updateSettings({ livePlatform: 'bilibili' });
    expect(installed.has('view_profile')).toBe(true);
    expect(await installed.get('read_dm').execute({ who: '1234' })).toContain('请先连接 B 站直播间');
  });
});
