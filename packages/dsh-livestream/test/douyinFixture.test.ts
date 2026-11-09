import { describe, expect, it } from 'vitest';
import fixture from './fixtures/dyhub-normalized-defaults.json';
import { DouyinLiveSource } from '../src/core/platforms/douyin/douyinSource';
import type { LiveEvent, LiveRoomStats } from '../src/core/live';

describe('pinned DyHub normalizer fixtures', () => {
  it('treats generated default-zero totals as unknown and sentinel gifts as invalid', () => {
    const source = new DouyinLiveSource('123', 'http://127.0.0.1:9999');
    const events: LiveEvent[] = [];
    const stats: Partial<LiveRoomStats>[] = [];
    const adapter = source as any;
    adapter.listener = { event: (event: LiveEvent) => events.push(event), stats: (value: LiveRoomStats) => stats.push(value), state() {}, room() {} };
    for (const frame of fixture.frames) adapter.receive(frame);
    expect(stats).toEqual([{ likes: undefined }, { online: undefined, watched: undefined }]);
    expect(events.map((event) => event.kind)).toEqual(['like']);
    expect(fixture.frames[2].data.groupId).toBe('0');
    expect(fixture.frames[3].data.giftId).toBe('0');
  });
});
