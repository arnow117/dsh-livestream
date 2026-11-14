import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GrantManager, type QualificationSnapshot } from '../../src/publicChat/grantManager';
import { testGrantSnapshot, TEST_COOKIE_DIGEST, TEST_IDENTITY_EPOCH, TEST_LIVE_EPOCH, TEST_PRINCIPAL_UID,
  TEST_QUALIFICATION_TOKEN, TEST_SENDER_CONNECTION_GENERATION, TEST_SENDER_NONCE } from './test-helpers';

function proof(): QualificationSnapshot {
  return {
    principalUid: TEST_PRINCIPAL_UID, contextId: 'ctx-1', sessionId: 'session-1', authCookieDigest: TEST_COOKIE_DIGEST,
    authCookieGeneration: 3, capturedAt: 1_000, profileOrigin: 'https://www.douyin.com', profileStatus: 200,
    qualificationToken: TEST_QUALIFICATION_TOKEN, identityEpoch: TEST_IDENTITY_EPOCH,
    senderProcessNonce: TEST_SENDER_NONCE, senderConnectionGeneration: TEST_SENDER_CONNECTION_GENERATION,
  };
}

function snapshot(inputConnectionGeneration: number, authorizationId = 'auth-1', grantId = 'grant-1') {
  return testGrantSnapshot({ authorizationId, grantId, inputConnectionGeneration, identityEpoch: TEST_IDENTITY_EPOCH,
    senderConnectionGeneration: TEST_SENDER_CONNECTION_GENERATION,
    qualificationDigest: createHash('sha256').update(TEST_QUALIFICATION_TOKEN).digest('hex') });
}

describe('GrantManager explicit grant lifecycle', () => {
  it('never turns qualification alone into a sendable grant', () => {
    const manager = new GrantManager();
    const generation = manager.advanceInputConnection();
    manager.setLiveEpoch(TEST_LIVE_EPOCH, 900);
    expect(manager.authorize({ qualification: proof(), expectedPrincipalUid: TEST_PRINCIPAL_UID,
      liveEpoch: TEST_LIVE_EPOCH, inputConnectionGeneration: generation, now: 1_000 }))
      .toEqual({ ok: false, reason: 'explicit-sender-grant-required' });
    expect(manager.active).toBeNull();
  });

  it('installs an independent sender grant and never revives it after revocation', () => {
    const manager = new GrantManager();
    const generation = manager.advanceInputConnection();
    manager.setLiveEpoch(TEST_LIVE_EPOCH, 900);
    const original = snapshot(generation);
    expect(manager.install(original, proof()).ok).toBe(true);
    expect(manager.isUsable(original.grantId, 1_100)).toBe(true);
    manager.revoke('owner-revoke', 1_200);
    expect(manager.isUsable(original.grantId, 1_300)).toBe(false);
    expect(manager.install(original, proof()).ok).toBe(false);
    expect(manager.install(snapshot(generation, 'auth-2', 'grant-2'), proof()).ok).toBe(true);
  });

  it('rejects a qualification token as grant and rejects mismatched identity bindings', () => {
    const manager = new GrantManager();
    const generation = manager.advanceInputConnection();
    manager.setLiveEpoch(TEST_LIVE_EPOCH, 900);
    expect(manager.install(snapshot(generation, 'a', TEST_QUALIFICATION_TOKEN), proof()).ok).toBe(false);
    expect(manager.install({ ...snapshot(generation), principalUid: '2' }, proof()).ok).toBe(false);
    expect(manager.install({ ...snapshot(generation), qualificationDigest: 'f'.repeat(64) }, proof()).ok).toBe(false);
    expect(manager.active).toBeNull();
  });

  it('connection generation and live epoch changes invalidate the original grant', () => {
    const manager = new GrantManager();
    const generation = manager.advanceInputConnection();
    manager.setLiveEpoch(TEST_LIVE_EPOCH, 900);
    const original = snapshot(generation);
    expect(manager.install(original, proof()).ok).toBe(true);
    manager.advanceInputConnection();
    expect(manager.isUsable(original.grantId, 1_100)).toBe(false);
    manager.setLiveEpoch('next-live', 1_200);
    expect(manager.isUsable(original.grantId, 1_300)).toBe(false);
  });
});
