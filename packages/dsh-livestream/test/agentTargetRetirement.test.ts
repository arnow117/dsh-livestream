import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

it('stops watching old live and game sessions after a target change', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-retire-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  vi.useFakeTimers();
  const sessions = new Map<string, { seq: number; snapshotEvents: ReturnType<typeof vi.fn> }>();
  const lookup = vi.fn((id: string) => sessions.get(id));
  for (const id of ['old', 'old-game', 'new']) {
    sessions.set(id, { seq: 0, snapshotEvents: vi.fn(() => []) });
  }
  let disposeWatch = () => {};
  const runtime = await import('../src/dsh/runtime');
  const say = vi.spyOn(runtime.show, 'say').mockResolvedValue('');
  try {
    const agent = await import('../src/dsh/agent');
    agent.apply({
      effect(effect: () => () => void, label?: string) {
        if (label === 'dsh-livestream session watch') disposeWatch = effect();
      },
      get(name: string) { return name === 'sessions' ? { get: lookup } : undefined; },
    });
    runtime.show.goLive('old', 'old-game');
    await vi.advanceTimersByTimeAsync(300);
    expect(lookup.mock.calls.map((call) => call[0])).toEqual(['old', 'old-game']);
    runtime.show.endLive();
    (runtime.show as any).finish();
    runtime.show.setPlatform('douyin');
    lookup.mockClear();
    const oldEvent = { type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'text', text: 'old message' }] } } };
    for (const id of ['old', 'old-game']) {
      const session = sessions.get(id)!;
      session.seq = 1;
      session.snapshotEvents.mockReturnValue([oldEvent]);
    }
    await vi.advanceTimersByTimeAsync(900);
    expect(lookup).not.toHaveBeenCalled();
    expect(say).not.toHaveBeenCalled();
    runtime.show.goLive('new');
    await vi.advanceTimersByTimeAsync(300);
    const current = sessions.get('new')!;
    current.seq = 1;
    current.snapshotEvents.mockReturnValue([{ ...oldEvent, data: { message: { content: [{ type: 'text', text: 'new message' }] } } }]);
    await vi.advanceTimersByTimeAsync(300);
    expect(say).toHaveBeenCalledWith('new message', 'talk', expect.any(AbortSignal), 'live');
    say.mockClear();
    runtime.show.disconnect();
    current.seq = 2;
    current.snapshotEvents.mockReturnValue([{ ...oldEvent, seq: 2, data: { message: { content: [{ type: 'text', text: 'after disconnect' }] } } }]);
    await vi.advanceTimersByTimeAsync(300);
    expect(say).toHaveBeenCalledWith('after disconnect', 'talk', expect.any(AbortSignal), 'live');
    runtime.show.endLive();
    (runtime.show as any).finish();
    runtime.show.setPlatform('bilibili');
    const old = sessions.get('old')!;
    old.snapshotEvents.mockImplementation((cursor: number) => cursor < 1 ? [oldEvent] : []);
    runtime.show.goLive('old');
    say.mockClear();
    await vi.advanceTimersByTimeAsync(600);
    expect(say).not.toHaveBeenCalled();
    old.seq = 2;
    old.snapshotEvents.mockImplementation((cursor: number) => cursor < 2 ? [{ ...oldEvent, seq: 2, data: { message: { content: [{ type: 'text', text: 'fresh old session' }] } } }] : []);
    await vi.advanceTimersByTimeAsync(300);
    expect(say).toHaveBeenCalledWith('fresh old session', 'talk', expect.any(AbortSignal), 'live');
  } finally {
    disposeWatch();
    runtime.show.endLive();
    runtime.show.dispose();
    say.mockRestore();
    vi.useRealTimers();
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    rmSync(dir, { recursive: true, force: true });
  }
});
