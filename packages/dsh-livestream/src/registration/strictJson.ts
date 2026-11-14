const MAX_BYTES = 1024 * 1024;
const MAX_DEPTH = 64;
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

/** Decode bounded untrusted CLI/control JSON; duplicate object keys are never accepted. */
export function parseStrictJson(bytes: Uint8Array): unknown {
  if (bytes.byteLength > MAX_BYTES) throw new Error("invalid_shape");
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("invalid_shape");
  }
  let offset = 0;
  function whitespace(): void {
    while (offset < source.length && /[\x20\x09\x0a\x0d]/.test(source[offset]))
      offset++;
  }
  function string(): string {
    if (source[offset++] !== '"') throw new Error("invalid_shape");
    const start = offset - 1;
    let escaped = false;
    while (offset < source.length) {
      const code = source.charCodeAt(offset++);
      if (!escaped && code === 0x22) {
        let value: unknown;
        try {
          value = JSON.parse(source.slice(start, offset));
        } catch {
          throw new Error("invalid_shape");
        }
        if (typeof value !== "string" || LONE_SURROGATE.test(value))
          throw new Error("invalid_shape");
        return value;
      }
      if (!escaped && code < 0x20) throw new Error("invalid_shape");
      if (!escaped && code === 0x5c) escaped = true;
      else escaped = false;
    }
    throw new Error("invalid_shape");
  }
  function value(depth: number): unknown {
    if (depth > MAX_DEPTH) throw new Error("invalid_shape");
    whitespace();
    const char = source[offset];
    if (char === '"') return string();
    if (char === "{") {
      offset++;
      const result: Record<string, unknown> = Object.create(null);
      const keys = new Set<string>();
      whitespace();
      if (source[offset] === "}") {
        offset++;
        return result;
      }
      for (;;) {
        whitespace();
        const key = string();
        if (keys.has(key)) throw new Error("invalid_shape");
        keys.add(key);
        whitespace();
        if (source[offset++] !== ":") throw new Error("invalid_shape");
        result[key] = value(depth + 1);
        whitespace();
        const separator = source[offset++];
        if (separator === "}") return result;
        if (separator !== ",") throw new Error("invalid_shape");
      }
    }
    if (char === "[") {
      offset++;
      const result: unknown[] = [];
      whitespace();
      if (source[offset] === "]") {
        offset++;
        return result;
      }
      for (;;) {
        result.push(value(depth + 1));
        whitespace();
        const separator = source[offset++];
        if (separator === "]") return result;
        if (separator !== ",") throw new Error("invalid_shape");
      }
    }
    for (const [literal, decoded] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (source.startsWith(literal, offset)) {
        offset += literal.length;
        return decoded;
      }
    }
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      source.slice(offset),
    );
    if (!match) throw new Error("invalid_shape");
    offset += match[0].length;
    const number = Number(match[0]);
    if (!Number.isFinite(number)) throw new Error("invalid_shape");
    return number;
  }
  const result = value(0);
  whitespace();
  if (offset !== source.length) throw new Error("invalid_shape");
  return result;
}
