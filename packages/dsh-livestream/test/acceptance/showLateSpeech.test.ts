import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { LiveShow } from '../../src/body/show';

it.each(['finished', 'new-session', 'input-disconnected'] as const)(
  'drops late synthesis and queued speech after %s',
  async (transition) => {
    const directory = mkdtempSync(join(tmpdir(), 'feat010-late-speech-'));
    let release!: (value: { audio: Uint8Array; timeline: [] }) => void;
    let started!: () => void;
    const synthesizing = new Promise<void>((resolve) => { started = resolve; });
    const synthesize = vi.fn(() => new Promise<{ audio: Uint8Array; timeline: [] }>((resolve) => {
      release = resolve;
      started();
    }));
    const show = new LiveShow({ push: async () => true, synthesize }, { dataDir: directory, names: ['角色'] });
    const events: string[] = [];
    const unsubscribe = show.stage.subscribe((event) => {
      if (event.type === 'say') events.push(event.text);
    }, false);
    try {
      show.goLive('old');
      const first = show.say('旧音频', 'talk', new AbortController().signal);
      await synthesizing;
      const queued = show.say('旧待播音频', 'talk', new AbortController().signal);
      if (transition === 'input-disconnected') {
        show.disconnect();
      } else {
        show.endLive();
        (show as any).finish();
        if (transition === 'new-session') show.goLive('new');
      }
      release({ audio: new Uint8Array([1]), timeline: [] });
      await Promise.all([first, queued]);
      expect(events).toEqual([]);
      expect(synthesize).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
      show.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

it('still permits ordinary farewell speech while the show is ending', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'feat010-farewell-'));
  const show = new LiveShow({
    push: async () => true,
    synthesize: async () => ({ audio: new Uint8Array([1]), timeline: [] }),
  }, { dataDir: directory, names: ['角色'] });
  const events: string[] = [];
  const unsubscribe = show.stage.subscribe((event) => {
    if (event.type !== 'say') return;
    events.push(event.text);
    show.stage.said(event.id);
  }, false);
  try {
    show.goLive('session');
    show.endLive();
    await show.say('再见', 'talk', new AbortController().signal);
    expect(events).toEqual(['再见']);
    expect(show.isEnding).toBe(true);
  } finally {
    unsubscribe();
    show.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});
