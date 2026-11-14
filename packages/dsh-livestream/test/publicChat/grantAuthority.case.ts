import { describe, expect, it } from 'vitest';
import { GrantAuthority, controlPayloadHash, type AuthorizeRequest } from '../../src/publicChat/grantAuthority';

const nonce = 'sender-process';
const request = (id: string, captureId = 'capture-a'): AuthorizeRequest => ({
  authorizationId: id,
  expectedSenderProcessNonce: nonce,
  qualificationToken: 'qualification-token',
  localRevision: 'local-revision',
  target: {
    version: 'dsh-public-chat-v1', buildDigest: 'a'.repeat(64), instanceId: 'instance',
    senderProcessNonce: nonce, captureId, qualificationDigest: 'b'.repeat(64), qualificationRevision: 1,
    accountRecordId: 'account', principalUid: '123', roomId: '456', browserContextId: 'context',
    senderSessionId: 'session', senderConnectionGeneration: 1, identityEpoch: 1, authCookieGeneration: 1,
    liveEpoch: 'live', liveEpochStartedAtMs: 1000, inputConnectionGeneration: 1,
  },
});
const revoke = (revokeId: string, authorizationId: string) => ({
  revokeId, expectedSenderProcessNonce: nonce, target: { kind: 'authorization' as const, authorizationId },
});

describe('explicit sender grant authority', () => {
  it('registers before awaiting, issues a distinct grant, and never signs twice for the same ID', async () => {
    const authority = new GrantAuthority(nonce, 10, () => 2000);
    let release!: (value: boolean) => void;
    const first = authority.authorize(request('a'), () => new Promise((resolve) => { release = resolve; }), () => true);
    expect(authority.operation('a')?.state).toBe('authorizing');
    expect(authority.active).toBeNull();
    expect(await authority.authorize(request('b'), async () => true, () => true)).toEqual({ registered: false, reason: 'busy' });
    release(true);
    const result = await first;
    expect(result.registered && result.record.state).toBe('authorized');
    const grant = authority.active;
    expect(grant?.grantId).not.toBe('qualification-token');
    expect(grant?.authorizedAtMs).toBe(2000);
    expect(await authority.authorize(request('a'), async () => { throw new Error('must not reissue'); }, () => true)).toEqual(result);
    expect(await authority.authorize({ ...request('a'), localRevision: 'different' }, async () => true, () => true)).toEqual({ registered: false, reason: 'conflict' });
  });

  it('tombstones before arrival and revokes during an await without reviving the old operation', async () => {
    const authority = new GrantAuthority(nonce, 10, () => 2000);
    authority.revoke(revoke('r-before', 'before'));
    const before = await authority.authorize(request('before'), async () => true, () => true);
    expect(before.registered && before.record.state).toBe('revoked');
    let release!: (value: boolean) => void;
    const pending = authority.authorize(request('during'), () => new Promise((resolve) => { release = resolve; }), () => true);
    authority.revoke(revoke('r-during', 'during'));
    release(true);
    expect((await pending).registered && authority.operation('during')?.state).toBe('revoked');
    expect(authority.active).toBeNull();
  });

  it('old targeted capture and authorization revocations do not affect a later grant', async () => {
    const authority = new GrantAuthority(nonce, 10, () => 2000);
    await authority.authorize(request('old'), async () => true, () => true);
    authority.revoke(revoke('old-revoke', 'old'));
    await authority.authorize(request('new', 'capture-b'), async () => true, () => true);
    const current = authority.active;
    authority.revoke({ revokeId: 'cancel-old-capture', expectedSenderProcessNonce: nonce, target: { kind: 'capture', captureId: 'capture-a' } });
    authority.revoke(revoke('repeat-old-target', 'old'));
    expect(authority.active).toEqual(current);
  });

  it('records terminal rejection without reviving it, and never evicts records on capacity', async () => {
    const authority = new GrantAuthority(nonce, 2, () => 2000);
    const rejected = await authority.authorize(request('bad'), async () => false, () => true);
    expect(rejected.registered && rejected.record.state).toBe('rejected');
    expect(await authority.authorize(request('bad'), async () => true, () => true)).toEqual(rejected);
    authority.revoke(revoke('r', 'bad'));
    expect(await authority.authorize(request('new'), async () => true, () => true)).toEqual({ registered: false, reason: 'capacity' });
    expect(authority.operation('bad')?.state).toBe('rejected');
    expect(authority.revoke({ revokeId: 'bad', expectedSenderProcessNonce: nonce, target: { kind: 'capture', captureId: 'c' } })).toEqual({ registered: false, reason: 'conflict' });
  });

  it('freezes the accepted request snapshot across an asynchronous verification', async () => {
    const authority = new GrantAuthority(nonce, 10, () => 2000);
    const input = request('original');
    let release!: (value: boolean) => void;
    const pending = authority.authorize(input, () => new Promise((resolve) => { release = resolve; }), () => true);
    input.authorizationId = 'changed';
    input.target.liveEpoch = 'changed-live';
    release(true);
    await pending;
    expect(authority.active?.authorizationId).toBe('original');
    expect(authority.active?.liveEpoch).toBe('live');
    expect(authority.operation('changed')).toBeNull();
    expect(Object.isFrozen(authority.active)).toBe(true);
  });

  it('persists a terminal rejection when a synchronous post-await check throws', async () => {
    const authority = new GrantAuthority(nonce, 10, () => 2000);
    const rejected = await authority.authorize(request('throw'), async () => true, () => { throw new Error('invalid'); });
    expect(rejected.registered && rejected.record.state).toBe('rejected');
    expect(authority.active).toBeNull();
    expect((await authority.authorize(request('throw'), async () => true, () => true))).toEqual(rejected);
  });

  it('hashes equivalent payloads consistently', () => {
    expect(controlPayloadHash({ a: 1, b: { x: 2, y: 3 } })).toBe(controlPayloadHash({ b: { y: 3, x: 2 }, a: 1 }));
  });
});
