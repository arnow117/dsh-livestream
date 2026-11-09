import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveAttention } from '../src/core/attention/attention';
import { LiveHub } from '../src/core/hub';
import { DouyinLiveSource } from '../src/core/platforms/douyin/douyinSource';
import { topicText } from '../src/core/topicText';
import type { LiveEvent } from '../src/core/live';

afterEach(() => vi.restoreAllMocks());

describe('Douyin local scheduling time', () => {
  it('settles and expires future-dated upstream gifts using local reception time', () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const source = new DouyinLiveSource('123', 'http://127.0.0.1:9999');
    const adapter = source as any;
    const hub = new LiveHub();
    const attention = new LiveAttention(now);
    hub.subscribe((event, update) => attention.observe(event, update, now));
    adapter.listener = { event: (event: LiveEvent) => hub.ingest(event, now), stats() {}, state() {}, room() {} };
    const send = (id: string, type: string, userId: string, data: object) => adapter.receive({
      id, type, platform: 'douyin', roomId: '123', ts: now + 1_000_000_000,
      user: { id: userId, nickname: `观众${userId}` }, data,
    });
    for (let i = 0; i < 8; i++) send(`chat-${i}`, 'chat', String(i + 1), { content: `消息${i}` });
    expect(attention.heat(now)).toBe('normal');
    send('gift-1', 'gift', '42', { giftId: '9', groupId: '1', combo: true, giftName: '花', repeatCount: 1 });
    now += 31_000;
    const topic = attention.next(now);
    expect(topic?.kind).toBe('gifts');
    expect(topicText(topic!, { platform: 'douyin' })).toContain('金额未知');
    send('gift-2', 'gift', '42', { giftId: '9', groupId: '2', combo: true, giftName: '花', repeatCount: 1 });
    now += 180_001;
    expect(attention.next(now)?.kind).not.toBe('gifts');
  });
});
