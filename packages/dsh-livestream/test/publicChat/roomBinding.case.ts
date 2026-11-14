import { describe, expect, it } from 'vitest';
import { losslessUint64, RoomBindingTracker } from '../../src/publicChat/roomBinding';

describe('fixed raw room binding', () => {
  it('preserves uint64 values and rejects lossy or invalid forms', () => {
    expect(losslessUint64({ low: -1, high: -1, unsigned: true })).toBe('18446744073709551615');
    expect(losslessUint64(Number.MAX_SAFE_INTEGER + 1)).toBeNull();
    expect(losslessUint64('18446744073709551616')).toBeNull();
    expect(losslessUint64({ low: 1, high: 0, unsigned: false })).toBeNull();
    expect(losslessUint64('0')).toBeNull();
  });

  it('requires a fixed page, recognized socket and matching raw room', () => {
    let page = 'https://live.douyin.com/101';
    let invalidations = 0;
    const tracker = new RoomBindingTracker({ webRoomId: '101', rawSourceSessionId: 'session', rawSourceConnectionGeneration: 2,
      rawBrowserContextId: 'context', liveEpoch: 'live', currentPageUrl: () => page, onInvalidated: () => { invalidations++; } });
    tracker.socketCreated('wrong', 'wss://example.com/webcast/im/push/v2/?room_id=202');
    expect(tracker.rawMessage('wrong', '202', 1000)).toBeNull();
    tracker.socketCreated('socket', 'wss://webcast100-ws-web-lq.douyin.com/webcast/im/push/v2/?room_id=202');
    const proof = tracker.rawMessage('socket', { low: 202, high: 0, unsigned: true }, 1000);
    expect(proof?.platformRoomId).toBe('202');
    expect(proof?.webRoomId).toBe('101');
    expect(tracker.current(31_001)).toBeNull();
    page = 'https://live.douyin.com/other';
    expect(tracker.current(1_001)).toBeNull();
    expect(invalidations).toBe(1);
    page = 'https://live.douyin.com/101';
    expect(tracker.rawMessage('socket', '202', 1_002)).toBeNull();
  });

  it('synchronously invalidates conflicting messages and closed original sockets', () => {
    let invalidations = 0;
    const make = () => new RoomBindingTracker({ webRoomId: '101', rawSourceSessionId: 'session', rawSourceConnectionGeneration: 1,
      rawBrowserContextId: 'context', liveEpoch: 'live', currentPageUrl: () => 'https://live.douyin.com/101',
      onInvalidated: () => { invalidations++; } });
    const first = make();
    first.socketCreated('socket', 'wss://webcast100-ws-web-lq.douyin.com/webcast/im/push/v2/?room_id=202');
    expect(first.rawMessage('socket', '202', 1_000)).not.toBeNull();
    expect(first.rawMessage('socket', '203', 1_001)).toBeNull();
    const second = make();
    second.socketCreated('socket', 'wss://webcast100-ws-web-lq.douyin.com/webcast/im/push/v2/?room_id=202');
    expect(second.rawMessage('socket', '202', 1_000)).not.toBeNull();
    second.socketClosed('socket');
    expect(second.current(1_001)).toBeNull();
    expect(invalidations).toBe(2);
  });

  it('retains the original immutable proof while fresh matching frames continue', () => {
    let invalidations = 0;
    const tracker = new RoomBindingTracker({ webRoomId: '101', rawSourceSessionId: 'session', rawSourceConnectionGeneration: 1,
      rawBrowserContextId: 'context', liveEpoch: 'live', currentPageUrl: () => 'https://live.douyin.com/101',
      onInvalidated: () => { invalidations++; } });
    tracker.socketCreated('socket', 'wss://webcast100-ws-web-lq.douyin.com/webcast/im/push/v2/?room_id=202');
    const original = tracker.rawMessage('socket', '202', 1000);
    expect(tracker.rawMessage('socket', '202', 30_000)).toBe(original);
    expect(tracker.current(31_001)).toBe(original);
    expect(tracker.current(60_001)).toBeNull();
    expect(tracker.rawMessage('socket', '202', 29_999)).toBeNull();
    expect(invalidations).toBe(1);
  });
});
