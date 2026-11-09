import { describe, expect, it } from 'vitest';
import { parseDouyinRoomId } from '../src/shared/liveTarget';
import { normalizeDouyinBridgeUrl } from '../src/core/platforms/douyin/douyinSource';

describe('Douyin target validation', () => {
  it('retains long string IDs and accepts the canonical URL', () => {
    const id = '123456789012345678901234567890';
    expect(parseDouyinRoomId(id)).toBe(id);
    expect(parseDouyinRoomId(`https://live.douyin.com/${id}`)).toBe(id);
  });
  it.each([123, '', 'x', 'https://v.douyin.com/123', 'https://live.douyin.com/123/', 'https://live.douyin.com/123?a=1', 'https://live.douyin.com:443/123', '1'.repeat(65)])('rejects %s', (value) => {
    expect(() => parseDouyinRoomId(value)).toThrow();
  });
  it('only accepts a numeric loopback HTTP bridge', () => {
    expect(normalizeDouyinBridgeUrl('http://127.0.0.1:9876')).toBe('http://127.0.0.1:9876');
    for (const url of ['http://localhost:9876', 'http://127.0.0.1:0', 'http://127.1:9876', 'http://0x7f000001:9876', 'https://127.0.0.1', 'http://127.0.0.1/x', 'http://user@127.0.0.1', 'http://127.0.0.1/?x=1']) {
      expect(() => normalizeDouyinBridgeUrl(url)).toThrow();
    }
  });
});
