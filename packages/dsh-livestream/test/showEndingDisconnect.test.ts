import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LiveShow } from '../src/body/show';

describe('ending across subscription disconnect', () => {
  it.each(['bilibili', 'douyin'] as const)('preserves an unsent ending on %s', async (platform) => {
    const dir = mkdtempSync(join(tmpdir(), 'show-ending-'));
    const push = vi.fn(async () => true);
    const show = new LiveShow({ push, synthesize: vi.fn(async () => null) }, { dataDir: dir, names: ['角色'] });
    try {
      show.setPlatform(platform);
      show.goLive('session');
      show.ownerSay('obsolete room topic');
      show.endLive();
      show.disconnect();
      await (show as any).direct();
      expect(push).toHaveBeenCalledTimes(1);
      expect((show as any).endingPushed).toBe(true);
      expect((show as any).priority).toEqual([]);
      show.turnEnded('session');
      await (show as any).direct();
      expect(show.isOnAir).toBe(false);
      expect(push).toHaveBeenCalledTimes(1);
    } finally {
      show.endLive();
      show.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(['bilibili', 'douyin'] as const)('settles one in-flight ending on %s without duplicating it', async (platform) => {
    const dir = mkdtempSync(join(tmpdir(), 'show-ending-'));
    let settle!: (value: boolean) => void;
    const push = vi.fn(() => new Promise<boolean>((resolve) => { settle = resolve; }));
    const show = new LiveShow({ push, synthesize: vi.fn(async () => null) }, { dataDir: dir, names: ['角色'] });
    try {
      show.setPlatform(platform);
      show.goLive('session');
      show.endLive();
      const pending = (show as any).direct();
      expect(push).toHaveBeenCalledTimes(1);
      show.disconnect();
      await (show as any).direct();
      expect(push).toHaveBeenCalledTimes(1);
      settle(true);
      await pending;
      expect((show as any).endingPushed).toBe(true);
      show.turnEnded('session');
      await (show as any).direct();
      expect(show.isOnAir).toBe(false);
      expect(push).toHaveBeenCalledTimes(1);
    } finally {
      show.endLive();
      show.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(['bilibili', 'douyin'] as const)('retries a failed in-flight ending on %s', async (platform) => {
    const dir = mkdtempSync(join(tmpdir(), 'show-ending-'));
    let settle!: (value: boolean) => void;
    const push = vi.fn()
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => { settle = resolve; }))
      .mockResolvedValue(true);
    const show = new LiveShow({ push, synthesize: vi.fn(async () => null) }, { dataDir: dir, names: ['角色'] });
    try {
      show.setPlatform(platform);
      show.goLive('session');
      show.endLive();
      const pending = (show as any).direct();
      show.disconnect();
      settle(false);
      await pending;
      expect((show as any).priority).toEqual([expect.objectContaining({ kind: 'ending' })]);
      await (show as any).direct();
      expect(push).toHaveBeenCalledTimes(2);
      expect((show as any).endingPushed).toBe(true);
      show.turnEnded('session');
      await (show as any).direct();
      expect(show.isOnAir).toBe(false);
    } finally {
      show.endLive();
      show.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([true, false])('ignores an old ending result %s after a new session starts', async (result) => {
    const dir = mkdtempSync(join(tmpdir(), 'show-ending-'));
    let settle!: (value: boolean) => void;
    const push = vi.fn(() => new Promise<boolean>((resolve) => { settle = resolve; }));
    const show = new LiveShow({ push, synthesize: vi.fn(async () => null) }, { dataDir: dir, names: ['角色'] });
    try {
      show.goLive('old');
      show.endLive();
      const pending = (show as any).direct();
      show.disconnect();
      (show as any).finish();
      show.setPlatform('douyin');
      show.goLive('new');
      const priority = [...(show as any).priority];
      settle(result);
      await pending;
      expect(show.currentSession).toBe('new');
      expect(show.isOnAir).toBe(true);
      expect((show as any).endingPushed).toBe(false);
      expect((show as any).priority).toEqual(priority);
      expect(show.status().brain).not.toBe('away');
    } finally {
      show.endLive();
      show.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('waits for the currently playing line before finishing after disconnect', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'show-ending-'));
    const show = new LiveShow({
      push: vi.fn(async () => true),
      synthesize: vi.fn(async () => ({ audio: new Uint8Array([1]), timeline: [] })),
    }, { dataDir: dir, names: ['角色'] });
    let lineId = '';
    const unsubscribe = show.stage.subscribe((event) => {
      if (event.type === 'say') lineId = event.id;
    }, false);
    try {
      show.goLive('session');
      show.endLive();
      await (show as any).direct();
      const speech = show.say('ending line', '', new AbortController().signal);
      await vi.waitFor(() => expect(lineId).not.toBe(''));
      show.disconnect();
      show.turnEnded('session');
      await (show as any).direct();
      expect(show.isOnAir).toBe(true);
      show.stage.said(lineId);
      await speech;
      await (show as any).direct();
      expect(show.isOnAir).toBe(false);
    } finally {
      unsubscribe();
      show.endLive();
      show.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('retires an old ending and its timer when the live session is replaced', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'show-ending-'));
    let settle!: (value: boolean) => void;
    const show = new LiveShow({
      push: vi.fn(() => new Promise<boolean>((resolve) => { settle = resolve; })),
      synthesize: vi.fn(async () => null),
    }, { dataDir: dir, names: ['角色'] });
    try {
      show.goLive('old');
      show.endLive();
      const pending = (show as any).direct();
      show.disconnect();
      show.goLive('new');
      expect((show as any).ending).toBe(false);
      expect((show as any).endingTimer).toBeNull();
      settle(true);
      await pending;
      expect(show.currentSession).toBe('new');
      expect(show.isOnAir).toBe(true);
      expect((show as any).endingPushed).toBe(false);
    } finally {
      show.endLive();
      show.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
