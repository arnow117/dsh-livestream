/**
 * F5 正式回归（原预期5）：固定 DyHub 解码器对 uint64 createTime 的真实
 * 运行表示（protobufjs Long）必须被 raw 时间校验接受；有损/缺失/非法
 * 仍拒绝。fixture 由 correction-01/generate-long-fixture.mjs 用固定解码器
 * 实际解码生成（来源与三元组见文件 provenance）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toPlatformEpochMs, toLosslessSafeInteger } from '../../src/publicChat/rawProof';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, 'fixtures', 'uint64-long-createTime.json'), 'utf8')) as {
  provenance: { decoderSource: string; protobufjsVersion: string; encodedDecimal: string };
  observation: { constructorName: string | null; low: number | null; high: number | null; unsigned: boolean | null; toStringValue: string | null; toNumberValue: number | null };
};

/** 依据 fixture 的无损三元组重建真实解码输出的对象形状。 */
function longFromObservation(): Record<string, unknown> {
  if (fixture.observation.low === null || fixture.observation.high === null || fixture.observation.unsigned === null) {
    throw new Error('fixture observation incomplete');
  }
  return {
    constructor: { name: fixture.observation.constructorName },
    low: fixture.observation.low,
    high: fixture.observation.high,
    unsigned: fixture.observation.unsigned,
    toStringValue: fixture.observation.toStringValue,
  };
}

describe('F5 固定解码器 uint64 表示（原预期5）', () => {
  it('真实解码器 Long 输出被识别为可信平台时间（秒级→毫秒）', () => {
    // 原预期：trusted=true 且毫秒正确（原实现 missing-platform-time——已修正）。
    const long = longFromObservation();
    const result = toPlatformEpochMs(long);
    expect(result.trusted).toBe(true);
    if (result.trusted) {
      expect(result.ms).toBe(Number(fixture.provenance.encodedDecimal) * 1000);
    }
    // 结构分量路径与 toNumber 路径都接受同一真实形状。
    const withToNumber = {
      low: fixture.observation.low,
      high: fixture.observation.high,
      unsigned: fixture.observation.unsigned,
      toNumber: () => fixture.observation.toNumberValue,
      toString: () => fixture.observation.toStringValue,
    };
    expect(toPlatformEpochMs(withToNumber).trusted).toBe(true);
  });

  it('Long 表示的毫秒级时间原样接受', () => {
    // 1,700,000,000,000 = 395×2^32 + 3,487,918,080（无损重组）。
    const result = toPlatformEpochMs({ low: 3_487_918_080, high: 395, unsigned: true });
    expect(result.trusted).toBe(true);
    if (result.trusted) expect(result.ms).toBe(1_700_000_000_000);
  });

  it('有损/缺失/非法表示仍拒绝，本地 now 不被升级为可信', () => {
    expect(toPlatformEpochMs(undefined).trusted).toBe(false);
    expect(toPlatformEpochMs(null).trusted).toBe(false);
    expect(toPlatformEpochMs(0).trusted).toBe(false);
    expect(toPlatformEpochMs(-5).trusted).toBe(false);
    expect(toPlatformEpochMs(1.5).trusted).toBe(false);
    expect(toPlatformEpochMs(2 ** 53).trusted).toBe(false);
    expect(toPlatformEpochMs('1700000040.0').trusted).toBe(false);
    // 数字字符串往返有损（丢低位）→ 拒绝。
    expect(toLosslessSafeInteger('99999999999999999')).toEqual({ ok: false, reason: 'string-out-of-safe-range' });
    // Long 负值（unsigned=false 高位溢出）→ 拒绝。
    expect(toLosslessSafeInteger({ low: 0, high: 4294967295, unsigned: false }).ok).toBe(false);
    // 未知对象形状 → 拒绝。
    expect(toPlatformEpochMs({ foo: 1 }).trusted).toBe(false);
    // Date.now 回退不在接受范围：只有显式传入的 number 才可能可信。
    expect(toPlatformEpochMs({ missing: true }).trusted).toBe(false);
  });

  it('fixture 记录与真实解码器形状一致（防 fixture 漂移）', () => {
    expect(fixture.observation.constructorName).toBe('Long');
    expect(fixture.observation.unsigned).toBe(true);
    expect(fixture.observation.toStringValue).toBe(fixture.provenance.encodedDecimal);
    expect(fixture.provenance.decoderSource).toContain('3a79c57d85c59289db3b77211b3ec01fae47d42c');
    expect(fixture.provenance.decoderSource).toContain('Common.createTime');
  });
});
