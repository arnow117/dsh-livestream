import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LiveShow, type LiveSnapshot } from '../../src/body/show';

describe('public chat live start boundary', () => {
  it('uses the real start of a newly started live session', () => {
    const snapshots: LiveSnapshot[] = [];
    const show = new LiveShow({
      push: async () => false,
      synthesize: async () => null,
      persist: (snapshot) => { if (snapshot) snapshots.push(snapshot); },
    }, { dataDir: mkdtempSync(join(tmpdir(), 'public-chat-live-')), names: [] });
    try {
      const before = Date.now();
      show.goLive('new-session');
      const after = Date.now();
      const actualStart = show.liveEpochStartedAtMs;
      expect(actualStart).not.toBeNull();
      expect(actualStart!).toBeGreaterThanOrEqual(before);
      expect(actualStart!).toBeLessThanOrEqual(after);
      expect(snapshots[snapshots.length - 1].startedAt).toBe(actualStart);
    } finally {
      show.dispose();
    }
  });

  it('does not promote a legacy snapshot save time into a live start after another restart', () => {
    const saved: LiveSnapshot[] = [];
    const hooks = {
      push: async () => false,
      synthesize: async () => null,
      persist: (snapshot: LiveSnapshot | null) => { if (snapshot) saved.push(snapshot); },
    };
    const first = new LiveShow(hooks, { dataDir: mkdtempSync(join(tmpdir(), 'public-chat-live-')), names: [] });
    const second = new LiveShow(hooks, { dataDir: mkdtempSync(join(tmpdir(), 'public-chat-live-')), names: [] });
    try {
      first.resumeLive({ sessionId: 'session', roomId: null, streamId: null, logFile: null, at: 1000 }, 2000);
      expect(first.liveEpochStartedAtMs).toBeNull();
      const restored = saved[saved.length - 1];
      // The existing snapshot format stores the display fallback in startedAt;
      // it does not prove whether this value was a real start time.
      expect(restored.startedAt).toBe(1000);
      second.resumeLive(restored, 3000);
      expect(second.liveEpochStartedAtMs).toBeNull();
    } finally {
      first.dispose();
      second.dispose();
    }
  });
});
