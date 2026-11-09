import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveHub } from '../src/core/hub';
import { DOUYIN_CACHE_TTL_MS, DouyinLiveSource } from '../src/core/platforms/douyin/douyinSource';
import type { LiveEvent } from '../src/core/live';

afterEach(() => vi.restoreAllMocks());

describe('Douyin gift cache lifetime', () => {
  it('keeps independent users and non-combo messages separate and ignores duplicates', () => {
    const source = new DouyinLiveSource('123', 'http://127.0.0.1:9999');
    const adapter = source as any;
    const events: LiveEvent[] = [];
    adapter.listener = { event: (event: LiveEvent) => events.push(event), stats() {}, room() {}, state() {} };
    const frame = (id: string, userId: string, groupId: string, combo: boolean) => ({
      id, roomId: '123', platform: 'douyin', type: 'gift', ts: Date.now(),
      user: { id: userId, nickname: userId }, data: { giftId: '9', giftName: '花', groupId, combo, repeatCount: 1 },
    });
    adapter.receive(frame('a', 'u1', '1', true));
    adapter.receive(frame('a', 'u1', '1', true));
    adapter.receive(frame('b', 'u2', '1', true));
    adapter.receive(frame('c', 'u1', '0', false));
    adapter.receive(frame('d', 'u1', '0', false));
    expect(events).toHaveLength(4);
    expect(new Set(events.map((event) => event.id)).size).toBe(4);
  });
  it('uses local observation time and makes a new identity after expiration or eviction', () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const source = new DouyinLiveSource('123', 'http://127.0.0.1:9999');
    const hub = new LiveHub();
    const events: LiveEvent[] = [];
    hub.subscribe((event) => events.push({ ...event }));
    const adapter = source as any;
    adapter.listener = { event: (event: LiveEvent) => hub.ingest(event, now), stats() {}, room() {}, state() {} };
    const send = (message: string, groupId: string, repeatCount: number) => adapter.receive({
      id: message, roomId: '123', platform: 'douyin', type: 'gift', ts: now + 10_000_000,
      user: { id: 'u', nickname: '人' },
      data: { giftId: '9', giftName: '花', groupId, combo: true, repeatCount },
    });
    send('one', 'same', 1);
    now += 31_000;
    send('two', 'same', 3);
    expect(events.map((event) => event.kind === 'gift' && event.count)).toEqual([1, 3]);
    expect(events[0].id).toBe(events[1].id);
    now += DOUYIN_CACHE_TTL_MS + 1;
    send('three', 'same', 4);
    expect(events[2]).toMatchObject({ count: 4 });
    expect(events[2].id).not.toBe(events[1].id);

    for (let i = 0; i < 4000; i++) send(`m${i}`, `g${i}`, 1);
    send('after-eviction', 'same', 5);
    expect(events.at(-1)).toMatchObject({ count: 5 });
    expect(events.at(-1)?.id).not.toBe(events[2].id);
  });
});
