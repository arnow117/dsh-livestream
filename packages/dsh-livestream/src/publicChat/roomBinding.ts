import { createHash } from 'node:crypto';
import { boundedString, safeInteger } from './protocol';

export interface RoomBindingProof {
  webRoomId: string;
  platformRoomId: string;
  rawSourceSessionId: string;
  rawSourceConnectionGeneration: number;
  rawBrowserContextId: string;
  liveEpoch: string;
  socketId: string;
  observedAtMs: number;
  digest: string;
}

/** Convert the actual protobufjs uint64 representation without Number loss. */
export function losslessUint64(value: unknown): string | null {
  let number: bigint;
  try {
    if (typeof value === 'bigint') number = value;
    else if (typeof value === 'number' && Number.isSafeInteger(value)) number = BigInt(value);
    else if (typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value)) number = BigInt(value);
    else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const long = value as { low?: unknown; high?: unknown; unsigned?: unknown };
      if (long.unsigned !== true || typeof long.low !== 'number' || typeof long.high !== 'number' ||
        !Number.isInteger(long.low) || !Number.isInteger(long.high) || long.low < -0x80000000 || long.low > 0xffffffff ||
        long.high < -0x80000000 || long.high > 0xffffffff) return null;
      number = (BigInt(long.high >>> 0) << 32n) | BigInt(long.low >>> 0);
    } else return null;
  } catch {
    return null;
  }
  return number > 0n && number <= 0xffffffffffffffffn ? number.toString() : null;
}

/**
 * Fed only by the fixed raw Session's CDP callback, never an external frame or
 * model claim. A connection replacement/conflict invalidates this instance.
 */
export class RoomBindingTracker {
  private readonly sockets = new Map<string, string>();
  private active: RoomBindingProof | null = null;
  private lastObservedAtMs = 0;
  private invalid = false;

  constructor(private readonly fixed: {
    webRoomId: string;
    rawSourceSessionId: string;
    rawSourceConnectionGeneration: number;
    rawBrowserContextId: string;
    liveEpoch: string;
    currentPageUrl: () => string | null;
    onInvalidated: () => void;
  }) {
    if (!/^[0-9]{1,64}$/.test(fixed.webRoomId) || !boundedString(fixed.rawSourceSessionId, 128) ||
      !safeInteger(fixed.rawSourceConnectionGeneration) || !boundedString(fixed.rawBrowserContextId, 128) ||
      !boundedString(fixed.liveEpoch, 128)) throw new Error('invalid raw room binding');
  }

  private invalidate(): void {
    if (this.invalid) return;
    this.invalid = true;
    this.active = null;
    this.lastObservedAtMs = 0;
    this.sockets.clear();
    this.fixed.onInvalidated();
  }

  private pageMatches(): boolean {
    return this.fixed.currentPageUrl() === `https://live.douyin.com/${this.fixed.webRoomId}`;
  }

  socketCreated(socketId: string, socketUrl: string): void {
    if (this.invalid || !boundedString(socketId, 128)) return;
    if (!this.pageMatches()) { this.invalidate(); return; }
    let url: URL;
    try { url = new URL(socketUrl); } catch { return; }
    if (url.protocol !== 'wss:' || url.username || url.password || url.port || url.hash ||
      !/^webcast[0-9]+-ws-web-[a-z0-9-]+\.douyin\.com$/.test(url.hostname) || url.pathname !== '/webcast/im/push/v2/') return;
    const rooms = url.searchParams.getAll('room_id');
    if (rooms.length !== 1) return;
    const room = losslessUint64(rooms[0]);
    if (!room) return;
    if (!this.sockets.has(socketId) && this.sockets.size >= 64) { this.invalidate(); return; }
    if (this.sockets.has(socketId) && this.sockets.get(socketId) !== room) { this.invalidate(); return; }
    if (this.active && this.active.socketId !== socketId) { this.invalidate(); return; }
    this.sockets.set(socketId, room);
  }

  rawMessage(socketId: string, commonRoomId: unknown, observedAtMs: number): RoomBindingProof | null {
    if (this.invalid || !this.pageMatches()) { this.invalidate(); return null; }
    const socketRoom = this.sockets.get(socketId);
    const messageRoom = losslessUint64(commonRoomId);
    if (!socketRoom || !messageRoom || !safeInteger(observedAtMs) || observedAtMs <= 0) return null;
    if (socketRoom !== messageRoom || (this.active && (this.active.platformRoomId !== messageRoom || this.active.socketId !== socketId))) {
      this.invalidate();
      return null;
    }
    if (this.active) {
      if (observedAtMs < this.lastObservedAtMs) { this.invalidate(); return null; }
      this.lastObservedAtMs = observedAtMs;
      return this.active;
    }
    const fields = { webRoomId: this.fixed.webRoomId, platformRoomId: messageRoom,
      rawSourceSessionId: this.fixed.rawSourceSessionId, rawSourceConnectionGeneration: this.fixed.rawSourceConnectionGeneration,
      rawBrowserContextId: this.fixed.rawBrowserContextId, liveEpoch: this.fixed.liveEpoch, socketId, observedAtMs };
    this.active = Object.freeze({ ...fields, digest: createHash('sha256').update(JSON.stringify(fields)).digest('hex') });
    this.lastObservedAtMs = observedAtMs;
    return this.active;
  }

  current(nowMs: number): RoomBindingProof | null {
    if (!this.pageMatches()) { this.invalidate(); return null; }
    if (this.invalid || !this.active || !safeInteger(nowMs) || nowMs < this.lastObservedAtMs || nowMs - this.lastObservedAtMs > 30_000) return null;
    return this.active;
  }

  socketClosed(socketId: string): void {
    this.sockets.delete(socketId);
    if (this.active?.socketId === socketId) this.invalidate();
  }

  disconnect(): void { this.invalidate(); }
}
