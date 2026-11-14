/** sender raw proto 证明边界（FEAT-008 / P2-01）与礼物增量策略。 */
import { describe, expect, it } from 'vitest';
import { RawProofStore, toPlatformEpochMs, RAW_FUTURE_DRIFT_MS } from '../../src/publicChat/rawProof';
import { OutputPolicyEngine } from '../../src/publicChat/welcomeThanks';
import type { Clock } from '../../src/publicChat/protocol';

function fixedClock(now: number): Clock {
  return { wall: () => now, monotonic: () => 0 };
}

describe('toPlatformEpochMs', () => {
  it('秒级 createTime 转毫秒；毫秒级原样', () => {
    expect(toPlatformEpochMs(1_700_000_000)).toEqual({ trusted: true, ms: 1_700_000_000_000 });
    expect(toPlatformEpochMs(1_700_000_000_000)).toEqual({ trusted: true, ms: 1_700_000_000_000 });
  });

  it('缺失/零/负数/超界一律不可信，不用 Date.now 回退', () => {
    expect(toPlatformEpochMs(undefined).trusted).toBe(false);
    expect(toPlatformEpochMs(0).trusted).toBe(false);
    expect(toPlatformEpochMs(-5).trusted).toBe(false);
    expect(toPlatformEpochMs(123).trusted).toBe(false);
    expect(toPlatformEpochMs(1e18).trusted).toBe(false);
    // F5：精确数字字符串（Long.toString 形态）经无损校验后可信。
    expect(toPlatformEpochMs('1700000000').trusted).toBe(true);
    expect(toPlatformEpochMs('1700000000.5').trusted).toBe(false);
    expect(toPlatformEpochMs('009999999999').trusted).toBe(false);
  });
});

describe('RawProofStore', () => {
  const NOW = 1_700_000_050_000;
  const store = () => new RawProofStore(fixedClock(NOW));
  const capture = (rawStore: RawProofStore, overrides: Record<string, unknown> = {}) => rawStore.capture({
    rawId: 'raw-1', rawType: 'chat', roomId: '708764876300', senderConnectionGeneration: 7,
    rawCreateTime: 1_700_000_040, ...overrides,
  });
  const take = (rawStore: RawProofStore, overrides: Record<string, unknown> = {}) => rawStore.take('raw-1', {
    rawType: 'chat', senderConnectionGeneration: 7, now: NOW,
    authBoundaryMs: 1_700_000_000_000, ...overrides,
  });

  it('齐全证明可消费：精确匹配 rawId/类型/当前代次', () => {
    const rawStore = store();
    expect(capture(rawStore).trusted).toBe(true);
    const result = take(rawStore);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.proof.platformTsMs).toBe(1_700_000_040_000);
    // 一次性消费：同一证明不可重复使用（防同 raw 重放多动作）。
    expect(take(rawStore).ok).toBe(false);
  });

  it('缺平台时间/伪造未来/过期均 unavailable', () => {
    const missingAgain = store();
    capture(missingAgain, { rawCreateTime: undefined });
    const missingResult = missingAgain.take('raw-1', { rawType: 'chat', senderConnectionGeneration: 7, now: NOW });
    expect(missingResult.ok).toBe(false);
    if (!missingResult.ok) expect(missingResult.reason).toBe('untrusted-time');

    const future = store();
    capture(future, { rawCreateTime: 1_700_000_060 });
    const futureResult = future.take('raw-1', { rawType: 'chat', senderConnectionGeneration: 7, now: NOW });
    expect(futureResult.ok).toBe(false);
    if (!futureResult.ok) expect(futureResult.reason).toBe('future-drift');

    const expired = store();
    capture(expired, { rawCreateTime: 1_700_000_000 - 60 });
    const expiredResult = expired.take('raw-1', { rawType: 'chat', senderConnectionGeneration: 7, now: NOW });
    expect(expiredResult.ok).toBe(false);
    if (!expiredResult.ok) expect(expiredResult.reason).toBe('expired');
  });

  it('上一场旧时间帧（早于授权/开播边界）拒绝', () => {
    const rawStore = store();
    // 平台时间在 30 秒窗内、但早于授权边界：属于上一场。
    capture(rawStore, { rawCreateTime: 1_700_000_042 });
    const result = rawStore.take('raw-1', { rawType: 'chat', senderConnectionGeneration: 7, now: NOW, authBoundaryMs: 1_700_000_045_000 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('stale-epoch-boundary');
  });

  it('类型或代次不匹配给出精确 unavailable 原因', () => {
    const typeMismatch = store();
    capture(typeMismatch, { rawType: 'gift' });
    const typeResult = typeMismatch.take('raw-1', { rawType: 'chat', senderConnectionGeneration: 7, now: NOW });
    expect(typeResult.ok).toBe(false);
    if (!typeResult.ok) expect(typeResult.reason).toBe('type-mismatch');

    const generationMismatch = store();
    capture(generationMismatch, { senderConnectionGeneration: 6 });
    const generationResult = generationMismatch.take('raw-1', { rawType: 'chat', senderConnectionGeneration: 7, now: NOW });
    expect(generationResult.ok).toBe(false);
    if (!generationResult.ok) expect(generationResult.reason).toBe('generation-mismatch');

    expect(store().take('raw-404', { rawType: 'chat', senderConnectionGeneration: 7, now: NOW }).ok).toBe(false);
  });

  it('有界存储：超限淘汰最旧，容量上限 512', () => {
    const rawStore = new RawProofStore(fixedClock(NOW));
    for (let index = 0; index < 520; index++) {
      rawStore.capture({ rawId: `raw-${index}`, rawType: 'chat', roomId: 'x', senderConnectionGeneration: 1, rawCreateTime: 1_700_000_000 });
    }
    expect(rawStore.size()).toBeLessThanOrEqual(512);
    expect(rawStore.size()).toBe(512);
  });

  it('未来漂移容差边界：5 秒内接受，超过拒绝', () => {
    const withinDrift = store();
    capture(withinDrift, { rawCreateTime: 1_700_000_054 });
    expect(withinDrift.take('raw-1', { rawType: 'chat', senderConnectionGeneration: 7, now: NOW }).ok).toBe(true);

    const overDrift = store();
    capture(overDrift, { rawCreateTime: 1_700_000_050 + RAW_FUTURE_DRIFT_MS / 1000 + 2 });
    const result = overDrift.take('raw-1', { rawType: 'chat', senderConnectionGeneration: 7, now: NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('future-drift');
  });
});

describe('OutputPolicyEngine：欢迎 60 秒节流', () => {
  const NOW = 1_700_000_000_000;
  const engine = () => new OutputPolicyEngine();
  const input = {
    userId: 'user-1', displayNameRaw: '小明', rawProofOk: true,
    epoch: 'epoch-1', grantId: 'grant-1',
  };

  it('首次放行；60 秒内重复进场不再发送', () => {
    const policy = engine();
    const first = policy.planWelcome(input, NOW);
    expect(first.send).toBe(true);
    const repeat = policy.planWelcome(input, NOW + 30_000);
    expect(repeat.send).toBe(false);
    expect(repeat.reason).toBe('throttled');
    const later = policy.planWelcome(input, NOW + 61_000);
    expect(later.send).toBe(true);
  });

  it('缺 raw 证明不可用；不同用户互不影响', () => {
    const policy = engine();
    const noProof = policy.planWelcome({ ...input, rawProofOk: false }, NOW);
    expect(noProof.send).toBe(false);
    if (!noProof.send) expect(noProof.reason).toBe('unavailable:no-raw-proof');
    const other = policy.planWelcome({ ...input, userId: 'user-2' }, NOW);
    expect(other.send).toBe(true);
  });

  it('不安全名字退回不含名字模板；跨 epoch 不继承节流', () => {
    const policy = engine();
    const unsafe = policy.planWelcome({ ...input, displayNameRaw: '小明 http://x' }, NOW);
    expect(unsafe.send).toBe(true);
    if (unsafe.send) expect(unsafe.text).toBe('欢迎来到直播间');
    const crossEpoch = policy.planWelcome({ ...input, epoch: 'epoch-2' }, NOW + 10_000);
    expect(crossEpoch.send).toBe(true);
  });
});

describe('OutputPolicyEngine：礼物增量合并', () => {
  const NOW = 1_700_000_000_000;
  const input = {
    userId: 'user-1', displayNameRaw: '小明', rawProofOk: true,
    epoch: 'epoch-1', grantId: 'grant-1', giftNameRaw: '小星星',
  };

  it('短窗增量合并；到期 flush 出一条感谢，不跨 epoch/grant', () => {
    const policy = new OutputPolicyEngine();
    expect(policy.mergeGiftIncrement({ ...input, delta: 1 }, NOW).accepted).toBe(true);
    expect(policy.mergeGiftIncrement({ ...input, delta: 2 }, NOW + 3_000).reason).toBe('merged');
    // 不同 grant 的同名增量不合并。
    expect(policy.mergeGiftIncrement({ ...input, grantId: 'grant-2', delta: 5 }, NOW + 4_000).reason).toBe('opened');
    // 两个合并窗都到期（第二个窗在 NOW+12000 到期）。
    const decisions = policy.flushDueGiftThanks(NOW + 13_000);
    const merged = decisions.find((decision) => decision.text?.includes('小星星'));
    expect(merged?.send).toBe(true);
    if (merged?.text) expect(merged.text).toContain('小星星');
    // 两条独立感谢（增量 1+2 合并为一条；grant-2 的一条），不是按累计数重复。
    expect(decisions.filter((decision) => decision.send).length).toBe(2);
  });

  it('拒绝把累计 count 当增量（delta<=0）与缺 raw 证明', () => {
    const policy = new OutputPolicyEngine();
    expect(policy.mergeGiftIncrement({ ...input, delta: 0 }, NOW).accepted).toBe(false);
    expect(policy.mergeGiftIncrement({ ...input, delta: -1 }, NOW).accepted).toBe(false);
    expect(policy.mergeGiftIncrement({ ...input, delta: 3, rawProofOk: false }, NOW).accepted).toBe(false);
  });

  it('感谢文本不提及金额/0 元；目标切换时在途合并被清空', () => {
    const policy = new OutputPolicyEngine();
    policy.mergeGiftIncrement({ ...input, delta: 1 }, NOW);
    policy.resetForScope('epoch-1', 'grant-1');
    expect(policy.flushDueGiftThanks(NOW + 10_000)).toEqual([]);
  });
});

describe('raw event grant boundary', () => {
  it('does not upgrade a pre-grant raw replay and rejects a later live boundary', () => {
    const now = 1_700_000_050_000;
    const store = new RawProofStore(fixedClock(now));
    const event = { rawId: 'pre', rawType: 'chat', roomId: '456', senderConnectionGeneration: 1, rawCreateTime: 1_700_000_049_000 };
    store.capture({ ...event, grantId: null });
    store.capture({ ...event, grantId: 'new-grant' });
    expect(store.take('pre', { rawType: 'chat', senderConnectionGeneration: 1, now, grantId: 'new-grant', authBoundaryMs: now - 2000 }).ok).toBe(false);
    store.capture({ ...event, rawId: 'current', grantId: 'new-grant' });
    expect(store.take('current', { rawType: 'chat', senderConnectionGeneration: 1, now, grantId: 'new-grant', authBoundaryMs: now - 2000 }).ok).toBe(true);
    store.capture({ ...event, rawId: 'late-boundary', grantId: 'new-grant' });
    expect(store.take('late-boundary', { rawType: 'chat', senderConnectionGeneration: 1, now, grantId: 'new-grant', authBoundaryMs: now }).ok).toBe(false);
  });
});
