import { afterEach, describe, expect, it, vi } from 'vitest';
import { DouyinLiveSource } from '../src/core/platforms/douyin/douyinSource';

afterEach(() => vi.unstubAllGlobals());

describe('Douyin status and event validation', () => {
  it('does not let an older GET overwrite a newer roomStatus', async () => {
    let resolve!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((done) => { resolve = done; })));
    const source = new DouyinLiveSource('123', 'http://127.0.0.1:9876');
    const adapter = source as any;
    const states: string[] = [];
    adapter.listener = { state: (state: string) => states.push(state), stats() {}, room() {}, event() {} };
    const pending = adapter.query(0);
    adapter.receive({ id: 'live', platform: 'douyin', roomId: '123', type: 'roomStatus', ts: Date.now(), data: { status: 'live' } });
    resolve(Response.json({ room: { roomId: '123', status: 'connecting' } }));
    await pending;
    expect(states).toEqual(['connected']);
    source.stop();
  });
  it('ignores malformed and foreign events, and accepts a single aggregated like', () => {
    const source = new DouyinLiveSource('123', 'http://127.0.0.1:9876');
    const adapter = source as any;
    const events: any[] = [];
    const stats: any[] = [];
    adapter.listener = { state() {}, stats: (value: unknown) => stats.push(value), room() {}, event: (value: unknown) => events.push(value) };
    const base = { id: 'like', platform: 'douyin', roomId: '123', type: 'like', ts: Date.now(), user: { id: '1', nickname: '一' }, data: { count: 99, total: 500 } };
    for (const frame of [
      { ...base, id: 'foreign-room', roomId: '456' },
      { ...base, id: 'foreign-platform', platform: 'bilibili' },
      { ...base, id: 22 },
      { ...base, id: 'bad-time', ts: 0 },
      { ...base, id: 'bad-user', user: { id: 1 } },
    ]) adapter.receive(frame);
    expect(events).toEqual([]);
    expect(stats).toEqual([]);
    adapter.receive(base);
    expect(events).toHaveLength(1);
    expect(stats).toEqual([{ likes: 500 }]);
    adapter.receive({ ...base, id: 'status', type: 'roomStatus', data: { status: 'error', message: '测试' } });
    expect(stats.at(-1)).toEqual({ online: undefined, watched: undefined, likes: undefined, live: false });
    source.stop();
  });
});
