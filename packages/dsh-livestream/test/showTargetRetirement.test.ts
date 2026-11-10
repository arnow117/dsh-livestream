import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LiveShow } from '../src/body/show';

describe('show target retirement', () => {
  it('keeps the on-air session usable for new owner speech after disconnect', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'show-retire-'));
    let oldResult!: (ok: boolean) => void;
    const push = vi.fn((session: string, text: string) => text.includes('old owner')
      ? new Promise<boolean>((resolve) => { oldResult = resolve; })
      : Promise.resolve(true));
    const show = new LiveShow({ push, synthesize: vi.fn(async () => null) }, { dataDir: dir, names: ['角色'] });
    try {
      show.goLive('live-session', 'game-session');
      const old = { kind: 'owner', text: 'old owner', id: 'old', priority: 200, heat: 0, createdAt: Date.now() };
      const oldPush = (show as any).deliver(old, Date.now());
      show.disconnect();
      expect(show.isOnAir).toBe(true);
      expect(show.currentSession).toBe('live-session');
      expect(show.currentGameSession).toBe('game-session');
      show.ownerSay('new owner');
      await (show as any).direct();
      expect(push).toHaveBeenCalledWith('live-session', expect.stringContaining('new owner'), false, expect.objectContaining({ kind: 'owner' }));
      oldResult(false);
      expect(await oldPush).toBe(false);
      expect(show.status().brain).not.toBe('away');
      expect((show as any).priority).toEqual([]);
    } finally {
      show.endLive();
      show.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('retires old sessions and ignores a late push result after a new session starts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'show-retire-'));
    let finishPush!: (ok: boolean) => void;
    const show = new LiveShow({
      push: vi.fn((session) => session === 'old'
        ? new Promise<boolean>((resolve) => { finishPush = resolve; })
        : Promise.resolve(true)),
      synthesize: vi.fn(async () => null),
    }, { dataDir: dir, names: ['角色'] });
    try {
      show.goLive('old', 'old-game');
      const topic = { kind: 'owner', text: 'old-message', id: 'old-topic', priority: 200, heat: 0, createdAt: Date.now() };
      const pending = (show as any).deliver(topic, Date.now());
      show.endLive();
      (show as any).finish();
      show.setPlatform('douyin');
      expect(show.currentSession).toBeNull();
      expect(show.currentGameSession).toBeNull();
      show.goLive('new');
      const priority = [...(show as any).priority];
      finishPush(false);
      expect(await pending).toBe(false);
      expect((show as any).priority).toEqual(priority);
      expect(show.status().brain).not.toBe('away');
      expect(show.currentSession).toBe('new');
    } finally {
      show.endLive();
      show.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('finishes the current line but drops old queued speech and accepts new speech', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'show-retire-'));
    const synthesize = vi.fn(async () => ({ audio: new Uint8Array([1]), timeline: [] }));
    const show = new LiveShow({ push: vi.fn(async () => true), synthesize }, { dataDir: dir, names: ['角色'] });
    const lines: Array<{ id: string; text: string }> = [];
    const unsubscribe = show.stage.subscribe((event) => {
      if (event.type === 'say') lines.push({ id: event.id, text: event.text });
    }, false);
    try {
      show.goLive('old');
      const first = show.say('old-current', '', new AbortController().signal);
      const queued = show.say('old-queued', '', new AbortController().signal);
      const guest = show.guestSay('guest', 'old-guest', 'fake', new AbortController().signal);
      await vi.waitFor(() => expect(lines).toHaveLength(1));
      show.endLive();
      (show as any).finish();
      show.setPlatform('douyin');
      show.goLive('new');
      show.stage.said(lines[0].id);
      await first;
      expect(await queued).toBe('');
      expect(await guest).toBe('');
      expect(synthesize.mock.calls.map((call) => call[0])).toEqual(['old-current']);
      expect(show.status().lines).toEqual([]);
      expect((show as any).priority).not.toEqual(expect.arrayContaining([expect.objectContaining({ text: 'old-guest' })]));
      const current = show.say('new-current', '', new AbortController().signal);
      await vi.waitFor(() => expect(lines).toHaveLength(2));
      show.stage.said(lines[1].id);
      expect(await current).toBe('new-current');
      expect(synthesize.mock.calls.map((call) => call[0])).toEqual(['old-current', 'new-current']);
    } finally {
      unsubscribe();
      show.endLive();
      show.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not let a late game-line push alter the new game session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'show-retire-'));
    let oldResult!: (ok: boolean) => void;
    let newResult!: (ok: boolean) => void;
    const show = new LiveShow({
      push: vi.fn((session, text) => {
        if (text === 'old-mail') return new Promise<boolean>((resolve) => { oldResult = resolve; });
        if (text === 'new-mail') return new Promise<boolean>((resolve) => { newResult = resolve; });
        return Promise.resolve(true);
      }),
      synthesize: vi.fn(async () => null),
    }, { dataDir: dir, names: ['角色'] });
    try {
      show.goLive('old', 'old-game');
      (show as any).gameMail.push('old-mail');
      const oldPush = (show as any).directGameLine(Date.now());
      show.endLive();
      (show as any).finish();
      show.setPlatform('douyin');
      show.goLive('new', 'new-game');
      (show as any).gameMail.push('new-mail');
      const newPush = (show as any).directGameLine(Date.now());
      oldResult(false);
      await oldPush;
      expect((show as any).gameMail).toEqual([]);
      expect((show as any).gamePushing).toBe(true);
      expect((show as any).gameTurnRunning).toBe(false);
      newResult(true);
      await newPush;
      expect((show as any).gamePushing).toBe(false);
      expect((show as any).gameTurnRunning).toBe(true);
    } finally {
      show.endLive();
      show.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

it('discards a query-owned TTS result after cancellation, even when synthesis ignores abort', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'show-query-'));
  let finish!: (value: { audio: Uint8Array; timeline: [] }) => void;
  const synthesize = vi.fn(() => new Promise<{ audio: Uint8Array; timeline: [] }>((resolve) => { finish = resolve; }));
  const show = new LiveShow({ push: vi.fn(async () => true), synthesize }, { dataDir: dir, names: ['角色'] });
  const events: any[] = [];
  const unsubscribe = show.stage.subscribe((event) => events.push(event), true, 'owned-live-v1');
  try {
    show.goLive('session');
    const abort = new AbortController();
    const lease = { owner: { epoch: show.stage.outputEpoch!, turn: '1' }, signal: abort.signal, valid: () => !abort.signal.aborted };
    const speaking = show.say('过期答案', '', abort.signal, 'live', lease);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    abort.abort();
    finish({ audio: new Uint8Array([1]), timeline: [] });
    expect(await speaking).toBe('');
    expect(events.filter((event) => event.type === 'say')).toEqual([]);
    expect(show.status().lines).toEqual([]);
  } finally {
    unsubscribe();
    show.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

it.each(['disconnect', 'ending', 'offair'] as const)(
  'discards a delayed query-owned TTS result after %s',
  async (transition) => {
    const dir = mkdtempSync(join(tmpdir(), 'show-query-transition-'));
    let finish!: (value: { audio: Uint8Array; timeline: [] }) => void;
    const synthesize = vi.fn(() => new Promise<{ audio: Uint8Array; timeline: [] }>((resolve) => { finish = resolve; }));
    const show = new LiveShow({ push: vi.fn(async () => true), synthesize }, { dataDir: dir, names: ['角色'] });
    const events: any[] = [];
    const unsubscribe = show.stage.subscribe((event) => events.push(event), true, 'owned-live-v1');
    try {
      show.goLive('session');
      const signal = new AbortController().signal;
      const lease = { owner: { epoch: show.stage.outputEpoch!, turn: '1' }, signal, valid: () => true };
      const speaking = show.say('过期答案', '', signal, 'live', lease);
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
      if (transition === 'disconnect') show.disconnect();
      else {
        show.endLive();
        if (transition === 'offair') (show as any).finish();
      }
      finish({ audio: new Uint8Array([1]), timeline: [] });
      expect(await speaking).toBe('');
      expect(events.filter((event) => event.type === 'say')).toEqual([]);
      expect(show.status().lines).toEqual([]);
    } finally {
      unsubscribe();
      show.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

it('does not synthesize a cancelled owned sentence waiting in the microphone queue', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'show-query-queue-'));
  const synthesize = vi.fn(async () => ({ audio: new Uint8Array([1]), timeline: [] }));
  const show = new LiveShow({ push: vi.fn(async () => true), synthesize }, { dataDir: dir, names: ['角色'] });
  let releaseMic!: () => void;
  const events: any[] = [];
  const unsubscribe = show.stage.subscribe((event) => events.push(event), true, 'owned-live-v1');
  try {
    show.goLive('session');
    const occupied = show.stage.withMic(() => new Promise<void>((resolve) => { releaseMic = resolve; }));
    await vi.waitFor(() => expect(releaseMic).toBeTypeOf('function'));
    const abort = new AbortController();
    const lease = { owner: { epoch: show.stage.outputEpoch!, turn: '1' }, signal: abort.signal, valid: () => !abort.signal.aborted };
    const queued = show.say('已取消的排队句', '', abort.signal, 'live', lease);
    abort.abort();
    releaseMic();
    await occupied;
    expect(await queued).toBe('');
    expect(synthesize).not.toHaveBeenCalled();
    expect(events.filter((event) => event.type === 'say')).toEqual([]);
    expect((show as any).queued).toBe(0);
  } finally {
    unsubscribe();
    show.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
