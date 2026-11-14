/**
 * sender 侧 raw proto 证明（FEAT-008 API-6 / P2-01 修订）。
 *
 * sender 在同房间真实 raw proto 进入归一化之前，取 msgId/method 与
 * common.createTime 平台时间，按字符串 rawId/类型/当前 sender 连接代次
 * 保留有界短期证明。普通 frame.ts 或 Date.now 回退不可信；
 * 缺时间/证明/精确匹配均 unavailable。
 */

import { boundedString, safeInteger, type Clock } from './protocol';

export const RAW_PROOF_WINDOW_MS = 30_000;
export const RAW_PROOF_STORE_LIMIT = 512;
/** 平台时间超前本地时钟的可容忍漂移；超过视为伪造/时钟异常，拒绝。 */
export const RAW_FUTURE_DRIFT_MS = 5_000;

export interface RawEventProof {
  rawId: string;
  rawType: string;
  roomId: string;
  senderConnectionGeneration: number;
  grantId?: string | null;
  /** 平台 createTime 推导毫秒；不可信时为 null。 */
  platformTsMs: number | null;
  platformTsTrusted: boolean;
  receivedAt: number;
}

/**
 * 把抖音 common.createTime 明确解析为平台毫秒时间。
 *
 * 固定 D 解码器（protobufjs）对 uint64 字段的真实运行表示是 Long 对象
 * （{low, high, unsigned, …}），因此这里接受：protobufjs Long、BigInt、
 * 数字字符串与 number，全部做严格无损转换与安全范围校验。
 * 秒级（1e9..1e11）×1000；毫秒级（≥1e12）原样；其余（缺失/0/负数/超界/
 * 有损）一律不可信，调用方不得拿 Date.now 回退冒充。
 */
export function toLosslessSafeInteger(value: unknown): { ok: true; n: number } | { ok: false; reason: string } {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) return { ok: false, reason: 'not-safe-integer' };
    return { ok: true, n: value };
  }
  if (typeof value === 'bigint') {
    if (value < 0 || value > BigInt(Number.MAX_SAFE_INTEGER)) return { ok: false, reason: 'bigint-out-of-safe-range' };
    return { ok: true, n: Number(value) };
  }
  // protobufjs Long 的无损结构表示：low/high 为 32 位分量、unsigned 标志。
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const candidate = value as { low?: unknown; high?: unknown; unsigned?: unknown; toNumber?: unknown };
    const low = candidate.low;
    const high = candidate.high;
    const unsigned = candidate.unsigned;
    if (typeof low === 'number' && typeof high === 'number' && typeof unsigned === 'boolean'
      && Number.isSafeInteger(low) && Number.isSafeInteger(high)
      && low >= -0x80000000 && low <= 0xffffffff && high >= -0x80000000 && high <= 0xffffffff) {
      const normalizedLow = low < 0 ? low + 0x100000000 : low;
      const normalizedHigh = high < 0 ? high + 0x100000000 : high;
      if (!unsigned && normalizedHigh >= 0x80000000) return { ok: false, reason: 'long-negative-out-of-range' };
      const magnitude = normalizedHigh * 0x100000000 + normalizedLow;
      if (!Number.isSafeInteger(magnitude)) return { ok: false, reason: 'long-out-of-safe-range' };
      return { ok: true, n: magnitude };
    }
    // Long 兼容形态：带 toNumber 的对象（严格校验往返无损）。
    if (typeof candidate.toNumber === 'function') {
      const viaMethod = (candidate.toNumber as () => number).call(value);
      if (!Number.isSafeInteger(viaMethod)) return { ok: false, reason: 'long-toNumber-out-of-range' };
      const viaString = typeof (value as { toString: () => string }).toString === 'function'
        ? (value as { toString: () => string }).toString()
        : null;
      if (viaString === null || !/^-?\d+$/.test(viaString) || Number(viaString) !== viaMethod) {
        return { ok: false, reason: 'long-roundtrip-lossy' };
      }
      return { ok: true, n: viaMethod };
    }
    return { ok: false, reason: 'unsupported-64bit-shape' };
  }
  if (typeof value === 'string') {
    if (!/^\d+$/.test(value)) return { ok: false, reason: 'not-numeric-string' };
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) return { ok: false, reason: 'string-out-of-safe-range' };
    // 无损校验：十进制往返必须一致（拒绝 Number 化丢失低位）。
    if (String(parsed) !== value) return { ok: false, reason: 'string-roundtrip-lossy' };
    return { ok: true, n: parsed };
  }
  return { ok: false, reason: 'missing-platform-time' };
}

export function toPlatformEpochMs(value: unknown): { trusted: true; ms: number } | { trusted: false; reason: string } {
  const lossless = toLosslessSafeInteger(value);
  if (!lossless.ok) return { trusted: false, reason: lossless.reason === 'missing-platform-time' ? 'missing-platform-time' : lossless.reason };
  const raw = lossless.n;
  if (raw <= 0) return { trusted: false, reason: 'missing-platform-time' };
  if (raw >= 1_000_000_000 && raw < 100_000_000_000) {
    return { trusted: true, ms: raw * 1000 };
  }
  if (raw >= 1_000_000_000_000 && raw < 100_000_000_000_000) {
    return { trusted: true, ms: raw };
  }
  return { trusted: false, reason: 'platform-time-out-of-range' };
}

export type RawProofTakeResult =
  | { ok: true; proof: RawEventProof }
  | {
    ok: false;
    reason: 'missing' | 'expired' | 'stale-epoch-boundary' | 'future-drift' | 'type-mismatch' | 'generation-mismatch' | 'untrusted-time';
  };

export interface RawProofTakeExpectation {
  rawType: string;
  senderConnectionGeneration: number;
  roomId?: string;
  now: number;
  /** 授权/开播边界：平台时间早于该边界的 raw 消息属于上一场，拒绝。 */
  authBoundaryMs?: number;
  grantId?: string;
}

/** 有界短期证明存储：一次消费，30 秒本地有效窗。 */
export class RawProofStore {
  private readonly entries = new Map<string, RawEventProof>();
  private readonly seen = new Map<string, number>();
  private saturatedUntil = 0;
  private readonly clock: Clock;

  constructor(clock: Clock) {
    this.clock = clock;
  }

  capture(input: {
    rawId: string;
    rawType: string;
    roomId: string;
    senderConnectionGeneration: number;
    grantId?: string | null;
    rawCreateTime: unknown;
    receivedAt?: number;
  }): { trusted: boolean } {
    if (!boundedString(input.rawId, 128) || !boundedString(input.rawType, 64) || !boundedString(input.roomId, 64)
      || !safeInteger(input.senderConnectionGeneration)) {
      return { trusted: false };
    }
    const platform = toPlatformEpochMs(input.rawCreateTime);
    const receivedAt = input.receivedAt ?? this.clock.wall();
    for (const [key, expiresAt] of this.seen) {
      if (expiresAt < receivedAt) this.seen.delete(key);
    }
    const proof: RawEventProof = {
      rawId: input.rawId,
      rawType: input.rawType,
      roomId: input.roomId,
      senderConnectionGeneration: input.senderConnectionGeneration,
      grantId: input.grantId,
      platformTsMs: platform.trusted ? platform.ms : null,
      platformTsTrusted: platform.trusted,
      receivedAt,
    };
    const key = this.key(proof.senderConnectionGeneration, proof.rawType, proof.rawId);
    // 首次接收固定所属授权；重放不得在新授权下升级资格。
    if (this.seen.has(key)) return { trusted: false };
    if (receivedAt < this.saturatedUntil || this.seen.size >= RAW_PROOF_STORE_LIMIT * 2) {
      // Do not accept untracked replays until every frame received during overload
      // has aged beyond the validity window.
      this.saturatedUntil = receivedAt + RAW_PROOF_WINDOW_MS + RAW_FUTURE_DRIFT_MS;
      return { trusted: false };
    }
    const latestPossibleTime = platform.trusted ? Math.max(receivedAt, platform.ms) : receivedAt;
    this.seen.set(key, latestPossibleTime + RAW_PROOF_WINDOW_MS + RAW_FUTURE_DRIFT_MS);
    this.entries.set(key, proof);
    while (this.entries.size > RAW_PROOF_STORE_LIMIT) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return { trusted: platform.trusted };
  }

  /** 消费一条证明：精确匹配 rawId/类型/当前代次，检查有效窗与边界。 */
  take(rawId: string, expectation: RawProofTakeExpectation): RawProofTakeResult {
    const key = this.key(expectation.senderConnectionGeneration, expectation.rawType, rawId);
    const proof = this.entries.get(key);
    if (proof === undefined) {
      // 类型或代次不匹配时给出更精确的原因，便于离线断言。
      for (const candidate of this.entries.values()) {
        if (candidate.rawId !== rawId) continue;
        if (candidate.rawType !== expectation.rawType) return { ok: false, reason: 'type-mismatch' };
        if (candidate.senderConnectionGeneration !== expectation.senderConnectionGeneration) {
          return { ok: false, reason: 'generation-mismatch' };
        }
      }
      return { ok: false, reason: 'missing' };
    }
    if ((expectation.grantId !== undefined && proof.grantId !== expectation.grantId)
      || (expectation.roomId !== undefined && proof.roomId !== expectation.roomId)) return { ok: false, reason: 'generation-mismatch' };
    if (!proof.platformTsTrusted || proof.platformTsMs === null) return { ok: false, reason: 'untrusted-time' };
    if (proof.platformTsMs > expectation.now + RAW_FUTURE_DRIFT_MS) return { ok: false, reason: 'future-drift' };
    if (expectation.now - proof.platformTsMs > RAW_PROOF_WINDOW_MS) return { ok: false, reason: 'expired' };
    if (expectation.authBoundaryMs !== undefined && proof.platformTsMs < expectation.authBoundaryMs) {
      return { ok: false, reason: 'stale-epoch-boundary' };
    }
    this.entries.delete(key);
    return { ok: true, proof };
  }

  size(): number {
    return this.entries.size;
  }

  private key(generation: number, rawType: string, rawId: string): string {
    return `${generation}:${rawType}:${rawId}`;
  }
}
