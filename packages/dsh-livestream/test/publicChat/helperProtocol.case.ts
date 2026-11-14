import { describe, expect, it } from 'vitest';
import { encodeHelperFrame, HelperFrameDecoder, parseHelperJSON } from '../../src/publicChat/helperProtocol';

describe('private helper frame decoding', () => {
  it('handles split and coalesced frames without losing boundaries', () => {
    const decoder = new HelperFrameDecoder();
    const first = encodeHelperFrame({ seq: 1, message: '欢迎' });
    const second = encodeHelperFrame({ seq: 2 });
    expect(decoder.push(first.subarray(0, 3))).toEqual([]);
    expect(decoder.push(Buffer.concat([first.subarray(3), second]))).toEqual([{ seq: 1, message: '欢迎' }, { seq: 2 }]);
    decoder.finish();
  });

  it.each([
    '{"a":1,"a":2}',
    '{"a":{"x":1,"x":2}}',
    '{"a":"\\ud800"}',
    '{"a":"\\udc00"}',
    '{"a":9007199254740992}',
    '{"a":0.1}',
    '{"a":1}{}',
  ])('rejects malformed or ambiguous input', (text) => {
    expect(() => parseHelperJSON(Buffer.from(text))).toThrow();
  });

  it('accepts a valid surrogate pair and rejects truncation and oversize', () => {
    expect(parseHelperJSON(Buffer.from('{"a":"\\ud83d\\ude00"}'))).toEqual({ a: '😀' });
    const decoder = new HelperFrameDecoder();
    decoder.push(encodeHelperFrame({ x: 1 }).subarray(0, 5));
    expect(() => decoder.finish()).toThrow();
    const length = Buffer.alloc(4);
    length.writeUInt32BE(65537);
    expect(() => new HelperFrameDecoder().push(length)).toThrow();
  });
});
