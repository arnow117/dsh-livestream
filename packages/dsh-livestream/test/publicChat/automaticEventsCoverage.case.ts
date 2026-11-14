import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveEvent } from '../../src/core/live';
import type { RawObservation } from '../../src/publicChat/frozenSenderRuntime';
import type { TrustedSender } from '../../src/publicChat/trustedSender';
import type { SubmitInput } from '../../src/publicChat/controller';
import { PublicChatAutomaticEvents } from '../../src/publicChat/automaticEvents';

const NOW = 1_800_000_000_000;
function setup() {
  let grant: any = { grantId: 'grant', roomId: '101', liveEpoch: 'live', rawSourceSessionId: 'raw-session',
    rawSourceConnectionGeneration: 1, authorizedAtMs: NOW - 1000, liveEpochStartedAtMs: NOW - 2000 };
  const references = new WeakMap<object, any>();
  const submit = vi.fn(async (_input: SubmitInput) => ({ status: 'accepted' }));
  const enabled = { welcome: true, thanks: true };
  const sender = { input: { reference: (event: object) => references.get(event) ?? null },
    controller: { currentFrozenGrant: () => grant, submit } } as unknown as TrustedSender;
  const automatic = new PublicChatAutomaticEvents(sender, (kind) => enabled[kind]);
  function event(id: string, kind: 'enter' | 'gift', overrides: Record<string, unknown> = {}) {
    const rawType = kind === 'enter' ? 'WebcastMemberMessage' : 'WebcastGiftMessage';
    const value = { id, platform: 'douyin', kind, ts: Date.now(), user: { id: 'viewer', name: '观众' },
      ...(kind === 'gift' ? { giftName: '小星星', count: 1, valueYuan: 0, valueKnown: false } : {}), ...overrides } as LiveEvent;
    references.set(value, { sourceEvent: value, rawId: id, rawType, grantId: 'grant', liveEpoch: 'live',
      inputConnectionGeneration: 1, valid: () => !!grant && grant.grantId === 'grant' });
    const proof: RawObservation = { rawId: id, rawType, grantId: 'grant', roomId: '101', liveEpoch: 'live',
      rawSourceSessionId: 'raw-session', rawSourceConnectionGeneration: 1, platformTsMs: Date.now(), receivedAt: Date.now() };
    return { value, proof };
  }
  return { automatic, event, submit, enabled, revoke: () => { grant = null; },
    replace: () => { grant = { ...grant, grantId: 'replacement' }; } };
}

describe('automatic event association and cancellation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('pairs in either arrival order, deduplicates and throttles welcome by user', () => {
    const f = setup();
    const first = f.event('one', 'enter');
    f.automatic.observed(first.proof);
    f.automatic.original(first.value);
    f.automatic.original(first.value);
    expect(f.submit).toHaveBeenCalledTimes(1);
    expect(f.submit.mock.calls[0][0]).toMatchObject({ text: '欢迎 观众 来到直播间',
      autoEvent: { event: first.value, rawId: 'one', rawType: 'WebcastMemberMessage' } });
    const second = f.event('two', 'enter');
    f.automatic.original(second.value);
    f.automatic.observed(second.proof);
    expect(f.submit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    const third = f.event('three', 'enter');
    f.automatic.original(third.value);
    f.automatic.observed(third.proof);
    expect(f.submit).toHaveBeenCalledTimes(2);
    f.automatic.clear();
  });

  it('merges distinct raw gift increments once and keeps the original source event', () => {
    const f = setup();
    const first = f.event('gift-1', 'gift');
    const second = f.event('gift-2', 'gift', { count: 2 });
    f.automatic.original(first.value);
    f.automatic.observed(first.proof);
    f.automatic.observed(second.proof);
    f.automatic.original(second.value);
    expect(f.submit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(8_000);
    expect(f.submit).toHaveBeenCalledTimes(1);
    expect(f.submit.mock.calls[0][0]).toMatchObject({ text: '谢谢 观众 送的 小星星',
      autoEvent: { event: first.value, rawId: 'gift-1' } });
    expect(f.submit.mock.calls[0][0].text).not.toContain('0元');
    f.automatic.clear();
  });

  it('does not send mismatched, stale, disabled or invalidated evidence', () => {
    const f = setup();
    const wrong = f.event('wrong', 'enter');
    f.automatic.original(wrong.value);
    f.automatic.observed({ ...wrong.proof, roomId: '102' });
    const old = f.event('old', 'enter');
    f.automatic.original(old.value);
    f.automatic.observed({ ...old.proof, platformTsMs: NOW - 5000 });
    f.enabled.welcome = false;
    const disabled = f.event('disabled', 'enter');
    f.automatic.original(disabled.value);
    f.automatic.observed(disabled.proof);
    expect(f.submit).not.toHaveBeenCalled();
    f.enabled.welcome = true;
    const gift = f.event('revoked', 'gift');
    f.automatic.original(gift.value);
    f.automatic.observed(gift.proof);
    f.revoke();
    vi.advanceTimersByTime(8_000);
    expect(f.submit).not.toHaveBeenCalled();
    f.automatic.clear();
  });

  it('drops pending gifts on clear or a replacement grant', () => {
    const f = setup();
    const one = f.event('first', 'gift');
    f.automatic.original(one.value);
    f.automatic.observed(one.proof);
    f.automatic.clear();
    vi.advanceTimersByTime(8_000);
    expect(f.submit).not.toHaveBeenCalled();
    const two = f.event('second', 'gift');
    f.automatic.original(two.value);
    f.automatic.observed(two.proof);
    f.replace();
    vi.advanceTimersByTime(8_000);
    expect(f.submit).not.toHaveBeenCalled();
    f.automatic.clear();
  });
});
