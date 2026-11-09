import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createBrainSession, type ConsoleServices } from '../src/console/console';

describe('platform-specific persona', () => {
  it('keeps the existing Bili persona and adds a read-only local Douyin persona', () => {
    const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
    const bili = patch.slice(patch.indexOf('id: preset-dsh-livestream\n'), patch.indexOf('id: preset-dsh-livestream-douyin'));
    const douyin = patch.slice(patch.indexOf('id: preset-dsh-livestream-douyin'), patch.indexOf('id: preset-dsh-livestream-game'));
    expect(bili).toContain('你正在 B 站直播间当主播');
    expect(douyin).toContain('抖音只读接入 / 本地舞台');
    expect(douyin).toContain('仅可用 show_stats');
    expect(douyin).toContain('没有账号操作');
    expect(douyin).not.toContain('view_profile');
    expect(douyin).not.toContain('dsh-game/agent');
  });
  it('selects the matching existing or Douyin preset without calling a model', async () => {
    const select = vi.fn(async () => ({ ok: true }));
    const svc = {
      workspaces: { list: { getSnapshot: () => ({ items: [{ workspaceId: 'workspace' }] }) } },
      sessions: {
        create: async () => 'fake-session',
        using: async (_id: string, _options: unknown, callback: (value: unknown) => unknown) => callback({ ready: Promise.resolve({ session: {} }) }),
      },
      remote: { agentPresets: { select } },
    } as unknown as ConsoleServices;
    await createBrainSession(svc, 'live', 'douyin');
    await createBrainSession(svc, 'live', 'bilibili');
    expect(select.mock.calls).toEqual([
      ['fake-session', 'dsh-livestream-douyin'],
      ['fake-session', 'dsh-livestream'],
    ]);
  });
});
