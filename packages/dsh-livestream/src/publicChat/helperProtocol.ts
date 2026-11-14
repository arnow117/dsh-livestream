import { TextDecoder } from 'node:util';

export const HELPER_PROTOCOL = 'dsh-public-chat-http-v1';
export const MAX_HELPER_FRAME_BYTES = 64 * 1024;

/** Reject malformed Unicode, duplicate keys and non-integral/unsafe numbers. */
export function parseHelperJSON(bytes: Uint8Array): unknown {
  return parseStrictJSON(bytes, MAX_HELPER_FRAME_BYTES);
}

/** Shared strict decoder; each caller supplies its own independent byte cap. */
export function parseStrictJSON(bytes: Uint8Array, maximumBytes: number): unknown {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0 || bytes.byteLength === 0 || bytes.byteLength > maximumBytes) throw new Error('invalid helper frame');
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw new Error('invalid helper frame');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  let offset = 0;
  const space = () => { while (offset < text.length && /[\x20\x09\x0a\x0d]/.test(text[offset])) offset++; };
  const string = (): string => {
    if (text[offset++] !== '"') throw new Error('invalid helper JSON');
    const start = offset - 1;
    let escaped = false;
    while (offset < text.length) {
      const char = text[offset++];
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (char !== '"') continue;
      const value: unknown = JSON.parse(text.slice(start, offset));
      if (typeof value !== 'string') throw new Error('invalid helper JSON');
      for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        if (code >= 0xd800 && code <= 0xdbff) {
          const next = value.charCodeAt(++index);
          if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('invalid helper Unicode');
        } else if (code >= 0xdc00 && code <= 0xdfff) {
          throw new Error('invalid helper Unicode');
        }
      }
      return value;
    }
    throw new Error('invalid helper JSON');
  };
  const value = (depth: number): void => {
    if (depth > 32) throw new Error('invalid helper JSON depth');
    space();
    const char = text[offset];
    if (char === '"') { string(); return; }
    if (char === '{') {
      offset++;
      const keys = new Set<string>();
      space();
      if (text[offset] === '}') { offset++; return; }
      for (;;) {
        space();
        const key = string();
        if (keys.has(key)) throw new Error('duplicate helper JSON key');
        keys.add(key);
        space();
        if (text[offset++] !== ':') throw new Error('invalid helper JSON');
        value(depth + 1);
        space();
        const next = text[offset++];
        if (next === '}') return;
        if (next !== ',') throw new Error('invalid helper JSON');
      }
    }
    if (char === '[') {
      offset++;
      space();
      if (text[offset] === ']') { offset++; return; }
      for (;;) {
        value(depth + 1);
        space();
        const next = text[offset++];
        if (next === ']') return;
        if (next !== ',') throw new Error('invalid helper JSON');
      }
    }
    const remaining = text.slice(offset);
    const literal = /^(?:true|false|null)/.exec(remaining);
    if (literal) { offset += literal[0].length; return; }
    const number = /^-?(?:0|[1-9][0-9]*)/.exec(remaining);
    if (!number || !Number.isSafeInteger(Number(number[0]))) throw new Error('invalid helper number');
    offset += number[0].length;
  };
  value(0);
  space();
  if (offset !== text.length) throw new Error('invalid helper JSON');
  return JSON.parse(text) as unknown;
}

export function encodeHelperFrame(value: unknown): Buffer {
  const data = Buffer.from(JSON.stringify(value), 'utf8');
  if (data.length === 0 || data.length > MAX_HELPER_FRAME_BYTES) throw new Error('invalid helper frame');
  const frame = Buffer.allocUnsafe(data.length + 4);
  frame.writeUInt32BE(data.length, 0);
  data.copy(frame, 4);
  return frame;
}

export class HelperFrameDecoder {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    if (this.buffer.length + chunk.length > 2 * MAX_HELPER_FRAME_BYTES + 8) throw new Error('helper stream overflow');
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const output: unknown[] = [];
    while (this.buffer.length >= 4) {
      const size = this.buffer.readUInt32BE(0);
      if (size === 0 || size > MAX_HELPER_FRAME_BYTES) throw new Error('invalid helper frame');
      if (this.buffer.length < size + 4) break;
      output.push(parseHelperJSON(this.buffer.subarray(4, size + 4)));
      this.buffer = this.buffer.subarray(size + 4);
    }
    return output;
  }

  finish(): void {
    if (this.buffer.length !== 0) throw new Error('truncated helper frame');
  }
}
