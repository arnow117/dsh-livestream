import { describe, expect, it, vi } from 'vitest';
import { Stage } from '../src/body/stage';

describe('course audio completion evidence', () => {
  it('does not expose course events to legacy or console subscribers', () => {
    const stage = new Stage();
    const legacy: string[] = [];
    const capable: string[] = [];
    stage.subscribe((event) => legacy.push(event.type), false);
    stage.subscribe((event) => capable.push(event.type), true, 'owned-live-v1');
    stage.broadcast({ type: 'course', action: 'open', epoch: 'test', url: '/course/asset/fake/test.html' });
    const late: string[] = [];
    stage.subscribe((event) => late.push(event.type), false);
    expect(legacy).toEqual([]);
    expect(late).toEqual([]);
    expect(capable).toEqual(['course']);
  });
  it('accepts explicit audio-ended but treats legacy said as unknown', async () => {
    const stage = new Stage();
    const disconnect = stage.subscribe(() => {}, true, 'owned-live-v1', 'watcher');
    const signal = new AbortController().signal;
    const ended = stage.waitAudio('one', 10, signal);
    stage.audioResult('one', 'ended', 'watcher');
    stage.said('one');
    await expect(ended).resolves.toBe('ended');
    const legacy = stage.waitAudio('two', 10, signal);
    stage.said('two');
    await expect(legacy).resolves.toBe('unknown');
    const wrongWatcher = stage.waitAudio('three', 10, signal);
    stage.audioResult('three', 'ended', 'stale-watcher');
    stage.said('three');
    await expect(wrongWatcher).resolves.toBe('unknown');
    disconnect();
  });

  it('returns unknown without a watcher and on watcher loss, and cancelled on abort', async () => {
    const stage = new Stage();
    const abort = new AbortController();
    await expect(stage.waitAudio('none', 10, abort.signal)).resolves.toBe('unknown');
    const disconnect = stage.subscribe(() => {}, true, 'owned-live-v1');
    const lost = stage.waitAudio('lost', 10, abort.signal);
    disconnect();
    await expect(lost).resolves.toBe('unknown');
    const off = stage.subscribe(() => {}, true, 'owned-live-v1');
    const cancelled = stage.waitAudio('cancelled', 10, abort.signal);
    abort.abort();
    await expect(cancelled).resolves.toBe('cancelled');
    off();
  });

  it('treats multiple speakers or a legacy speaker as unknown playback', async () => {
    const stage = new Stage();
    const first = stage.subscribe(() => {}, true, 'owned-live-v1', 'first');
    const second = stage.subscribe(() => {}, true, 'owned-live-v1', 'second');
    await expect(stage.waitAudio('multiple', 10, new AbortController().signal)).resolves.toBe('unknown');
    second();
    const legacy = stage.subscribe(() => {}, true);
    await expect(stage.waitAudio('legacy', 10, new AbortController().signal)).resolves.toBe('unknown');
    legacy();
    first();
  });

  it('does not turn timeout into an audio-ended result', async () => {
    vi.useFakeTimers();
    try {
      const stage = new Stage();
      const off = stage.subscribe(() => {}, true, 'owned-live-v1');
      const waiting = stage.waitAudio('timeout', 10, new AbortController().signal);
      await vi.advanceTimersByTimeAsync(15010);
      await expect(waiting).resolves.toBe('timeout');
      off();
    } finally {
      vi.useRealTimers();
    }
  });
});
