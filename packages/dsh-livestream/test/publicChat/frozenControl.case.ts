import { describe, expect, it } from 'vitest';
import { FrozenControlAuthority, type FrozenAuthorizationRequest } from '../../src/publicChat/frozenControl';
import { controlPayloadHash } from '../../src/publicChat/grantAuthority';
import type { FrozenGrantProposal } from '../../src/publicChat/frozenGrant';
import type { HelperProcess, HelperReply } from '../../src/publicChat/helperLauncher';

const proposal: FrozenGrantProposal = {
  version: 'dsh-public-chat-v1', transportKind: 'frozen_http', buildDigest: 'a'.repeat(64), instanceId: 'instance',
  senderProcessNonce: 'sender', senderConnectionGeneration: 1, authorizationId: 'authorization', captureId: 'capture',
  qualificationDigest: 'b'.repeat(64), qualificationRevision: 1, identityEpoch: 1, accountRecordId: 'record',
  principalUid: '42', roomId: '101', platformRoomId: '202', helperProcessNonce: 'helper', authContextId: 'context',
  authContextRevision: 1, materialDigest: 'c'.repeat(64), rawSourceSessionId: 'raw-session', rawSourceConnectionGeneration: 1,
  rawBrowserContextId: 'raw-context', roomBindingProofDigest: 'd'.repeat(64), inputConnectionGeneration: 1,
  liveEpoch: 'live', liveEpochStartedAtMs: 1000,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function response(kind: string, id: string, payload: unknown, status: string, record: unknown): HelperReply {
  return { protocol: 'dsh-public-chat-http-v1', seq: 1, kind, operationId: id, payloadHash: controlPayloadHash(payload),
    helperNonce: 'helper', authContextId: 'context', authContextRevision: 1, materialDigest: 'c'.repeat(64), status, payload: record };
}

async function setup() {
  const pending = deferred<HelperReply>();
  const calls: string[] = [];
  let loseRevoke = false;
  let queryRecord: unknown = null;
  const helper = {
    identity: { helperNonce: 'helper', authContextId: 'context', authContextRevision: 1, materialDigest: 'c'.repeat(64) },
    request: (kind: string, id: string, payload: unknown, guard?: () => boolean) => {
      calls.push(kind);
      if (guard && !guard()) return Promise.reject(new Error('stale'));
      if (kind === 'profile') return Promise.resolve(response(kind, id, payload, 'qualified', {
        kind: 'profile', state: 'qualified', targetId: id, payloadHash: controlPayloadHash(payload),
        qualification: { captureId: id, digest: 'b'.repeat(64), principalUid: '42', revision: 1, identityEpoch: 1, capturedAtMs: 1100 },
      }));
      if (kind === 'bindGrant') return pending.promise;
      if (kind === 'query') return Promise.resolve(response(kind, id, payload, queryRecord ? 'rejected' : 'not_found', queryRecord));
      if (loseRevoke) return Promise.reject(new Error('lost'));
      const target = payload as { targetId: string };
      return Promise.resolve(response(kind, id, payload, 'revoked', { kind: 'revoke', state: 'revoked',
        payloadHash: controlPayloadHash(payload), targetId: target.targetId }));
    },
  } as unknown as Pick<HelperProcess, 'identity' | 'request'>;
  const authority = new FrozenControlAuthority('sender', helper, () => true, () => 1300, 1024, () => true);
  const captured = await authority.capture('capture', 'sender', '42', 1, 1);
  if (!captured?.qualification) throw new Error('fixture capture failed');
  const request: FrozenAuthorizationRequest = { authorizationId: 'authorization', expectedSenderProcessNonce: 'sender',
    qualificationToken: captured.qualification.qualificationToken, localRevision: 'revision', target: proposal };
  const grant = { ...proposal, grantId: 'grant', authorizedAtMs: 1200 };
  const acknowledge = () => pending.resolve(response('bindGrant', proposal.authorizationId, proposal, 'authorized',
    { kind: 'authorize', state: 'authorized', payloadHash: controlPayloadHash(proposal), grant }));
  return { authority, request, pending, calls, acknowledge, loseRevoke: () => { loseRevoke = true; },
    trustRejected: () => { queryRecord = { kind: 'authorize', state: 'rejected', payloadHash: controlPayloadHash(proposal) }; } };
}

describe('frozen helper control ownership', () => {
  it('publishes only the exact helper commit and never reissues an ID', async () => {
    const fixture = await setup();
    const pending = fixture.authority.authorize(fixture.request);
    expect(fixture.authority.active).toBeNull();
    fixture.acknowledge();
    const result = await pending;
    expect(result.registered && result.record.state).toBe('authorized');
    expect(fixture.authority.active?.grantId).toBe('grant');
    await fixture.authority.authorize(fixture.request);
    expect(fixture.calls).toEqual(['profile', 'bindGrant']);
    const changed = await fixture.authority.authorize({ ...fixture.request, localRevision: 'different' });
    expect(changed).toEqual({ registered: false, reason: 'conflict' });
  });

  it('does not revive a late commit after a targeted revoke', async () => {
    const fixture = await setup();
    const pending = fixture.authority.authorize(fixture.request);
    const revoke = await fixture.authority.revoke({ revokeId: 'revoke', expectedSenderProcessNonce: 'sender',
      target: { kind: 'authorization', authorizationId: 'authorization' } });
    expect(revoke.registered && revoke.record.state).toBe('revoked');
    fixture.acknowledge();
    const late = await pending;
    expect(late.registered && late.record.state).toBe('revoked');
    expect(fixture.authority.active).toBeNull();
  });

  it('holds a lost authorization rather than treating it as rejected', async () => {
    const fixture = await setup();
    const pending = fixture.authority.authorize(fixture.request);
    fixture.pending.reject(new Error('lost'));
    const result = await pending;
    expect(result.registered && result.record.state).toBe('authorizing_unknown');
    expect(fixture.authority.hasHold).toBe(true);
    await fixture.authority.authorize(fixture.request);
    expect(fixture.calls).toEqual(['profile', 'bindGrant']);
  });

  it('does not expose an unconfirmed revoke as a trusted terminal', async () => {
    const fixture = await setup();
    const pending = fixture.authority.authorize(fixture.request);
    fixture.acknowledge();
    await pending;
    fixture.loseRevoke();
    const revoked = await fixture.authority.revoke({ revokeId: 'revoke', expectedSenderProcessNonce: 'sender',
      target: { kind: 'authorization', authorizationId: 'authorization', grantId: 'grant' } });
    expect(revoked.registered && revoked.record.state).toBe('revoking_unknown');
    expect(fixture.authority.operation('authorization')?.state).toBe('revoking_unknown');
    expect(fixture.authority.active).toBeNull();
    expect(fixture.authority.hasHold).toBe(true);
  });

  it('only clears an original hold for a matching queryable irreversible terminal', async () => {
    const fixture = await setup();
    const pending = fixture.authority.authorize(fixture.request);
    fixture.pending.reject(new Error('lost'));
    await pending;
    expect(await fixture.authority.reconcile('authorization')).toBeNull();
    expect(fixture.authority.hasHold).toBe(true);
    fixture.trustRejected();
    expect((await fixture.authority.reconcile('authorization'))?.state).toBe('rejected');
    expect(fixture.authority.hasHold).toBe(false);
    const replay = await fixture.authority.authorize(fixture.request);
    expect(replay.registered && replay.record.state).toBe('rejected');
    expect(fixture.calls.filter((kind) => kind === 'bindGrant')).toHaveLength(1);
  });

  it('invalidates the original grant synchronously before maintenance can await', async () => {
    const fixture = await setup();
    const pending = fixture.authority.authorize(fixture.request);
    fixture.acknowledge();
    await pending;
    const target = fixture.authority.beginMaintenance();
    expect(fixture.authority.active).toBeNull();
    expect(fixture.authority.hasHold).toBe(true);
    expect(fixture.authority.operation('authorization')?.state).toBe('revoking_unknown');
    expect(target?.kind).toBe('authorization');
    if (!target) throw new Error('missing original target');
    const result = await fixture.authority.revoke({ revokeId: 'maintenance-revoke', expectedSenderProcessNonce: 'sender', target });
    expect(result.registered && result.record.state).toBe('revoked');
    expect(fixture.authority.hasHold).toBe(false);
  });

  it('does not let an unrelated late revoke settle a newer maintenance hold', async () => {
    const old = deferred<HelperReply>();
    let oldPayload: unknown;
    const helper = {
      identity: { helperNonce: 'helper', authContextId: 'context', authContextRevision: 1, materialDigest: 'c'.repeat(64) },
      request: (kind: string, id: string, payload: unknown) => {
        if (kind === 'profile') return Promise.resolve(response(kind, id, payload, 'qualified', {
          kind: 'profile', state: 'qualified', targetId: id, payloadHash: controlPayloadHash(payload),
          qualification: { captureId: id, digest: 'b'.repeat(64), principalUid: '42', revision: 1, identityEpoch: 1, capturedAtMs: 1100 },
        }));
        if (id === 'old-revoke') { oldPayload = payload; return old.promise; }
        const target = payload as { targetId: string };
        return Promise.resolve(response(kind, id, payload, 'revoked', { kind: 'revoke', state: 'revoked',
          payloadHash: controlPayloadHash(payload), targetId: target.targetId }));
      },
    } as unknown as Pick<HelperProcess, 'identity' | 'request'>;
    const authority = new FrozenControlAuthority('sender', helper, () => true, () => 1300, 1024, () => true);
    expect((await authority.capture('capture', 'sender', '42', 1, 1))?.state).toBe('qualified');
    const unrelated = authority.revoke({ revokeId: 'old-revoke', expectedSenderProcessNonce: 'sender',
      target: { kind: 'capture', captureId: 'old-capture' } });
    const current = authority.beginMaintenance();
    old.resolve(response('revoke', 'old-revoke', oldPayload, 'revoked', { kind: 'revoke', state: 'revoked',
      payloadHash: controlPayloadHash(oldPayload), targetId: 'old-capture' }));
    await unrelated;
    expect(authority.hasHold).toBe(true);
    if (!current) throw new Error('missing maintenance target');
    await authority.revoke({ revokeId: 'current-revoke', expectedSenderProcessNonce: 'sender', target: current });
    expect(authority.hasHold).toBe(false);
  });

  it('does not invalidate a later grant when an old capture is revoked', async () => {
    const helper = {
      identity: { helperNonce: 'helper', authContextId: 'context', authContextRevision: 1, materialDigest: 'c'.repeat(64) },
      request: (kind: string, id: string, payload: unknown) => {
        if (kind === 'profile') return Promise.resolve(response(kind, id, payload, 'qualified', {
          kind: 'profile', state: 'qualified', targetId: id, payloadHash: controlPayloadHash(payload),
          qualification: { captureId: id, digest: 'b'.repeat(64), principalUid: '42', revision: 1, identityEpoch: 1, capturedAtMs: 1100 },
        }));
        if (kind === 'bindGrant') {
          const target = payload as FrozenGrantProposal;
          return Promise.resolve(response(kind, id, payload, 'authorized', { kind: 'authorize', state: 'authorized',
            payloadHash: controlPayloadHash(payload), grant: { ...target, grantId: 'later-grant', authorizedAtMs: 1200 } }));
        }
        const revoke = payload as { targetId: string };
        return Promise.resolve(response(kind, id, payload, 'revoked', { kind: 'revoke', state: 'revoked',
          payloadHash: controlPayloadHash(payload), targetId: revoke.targetId }));
      },
    } as unknown as Pick<HelperProcess, 'identity' | 'request'>;
    const authority = new FrozenControlAuthority('sender', helper, () => true, () => 1300, 1024, () => true);
    expect((await authority.capture('capture', 'sender', '42', 1, 1))?.state).toBe('qualified');
    await authority.revoke({ revokeId: 'old-revoke', expectedSenderProcessNonce: 'sender', target: { kind: 'capture', captureId: 'capture' } });
    const laterCapture = await authority.capture('later-capture', 'sender', '42', 1, 1);
    if (!laterCapture?.qualification) throw new Error('later capture failed');
    const later = { ...proposal, captureId: 'later-capture', authorizationId: 'later-authorization' };
    const authorized = await authority.authorize({ authorizationId: later.authorizationId, expectedSenderProcessNonce: 'sender', qualificationToken: laterCapture.qualification.qualificationToken, localRevision: 'revision', target: later });
    expect(authorized.registered && authorized.record.state).toBe('authorized');
    await authority.revoke({ revokeId: 'old-revoke-again', expectedSenderProcessNonce: 'sender', target: { kind: 'capture', captureId: 'capture' } });
    expect(authority.active?.grantId).toBe('later-grant');
  });

  it('does not publish a profile response after its original capture is revoked', async () => {
    const profile = deferred<HelperReply>();
    let profilePayload: unknown;
    const helper = {
      identity: { helperNonce: 'helper', authContextId: 'context', authContextRevision: 1, materialDigest: 'c'.repeat(64) },
      request: (kind: string, id: string, payload: unknown) => {
        if (kind === 'profile') { profilePayload = payload; return profile.promise; }
        const target = payload as { targetId: string };
        return Promise.resolve(response(kind, id, payload, 'revoked', { kind: 'revoke', state: 'revoked',
          payloadHash: controlPayloadHash(payload), targetId: target.targetId }));
      },
    } as unknown as Pick<HelperProcess, 'identity' | 'request'>;
    const authority = new FrozenControlAuthority('sender', helper, () => true, () => 1300, 1024, () => true);
    const pending = authority.capture('capture', 'sender', '42', 1, 1);
    const revoked = await authority.revoke({ revokeId: 'capture-revoke', expectedSenderProcessNonce: 'sender',
      target: { kind: 'capture', captureId: 'capture' } });
    expect(revoked.registered && revoked.record.state).toBe('revoked');
    profile.resolve(response('profile', 'capture', profilePayload, 'qualified', { kind: 'profile', state: 'qualified',
      targetId: 'capture', payloadHash: controlPayloadHash(profilePayload),
      qualification: { captureId: 'capture', digest: 'b'.repeat(64), principalUid: '42', revision: 1, identityEpoch: 1, capturedAtMs: 1100 } }));
    expect((await pending)?.state).toBe('revoked');
    expect(await authority.capture('capture', 'sender', '42', 2, 1)).toBeNull();
    expect(authority.active).toBeNull();
  });

  it('holds a profile whose original source became stale before its reply', async () => {
    const profile = deferred<HelperReply>();
    let profilePayload: unknown;
    let current = true;
    const helper = {
      identity: { helperNonce: 'helper', authContextId: 'context', authContextRevision: 1, materialDigest: 'c'.repeat(64) },
      request: (kind: string, id: string, payload: unknown) => {
        if (kind === 'profile') { profilePayload = payload; return profile.promise; }
        const target = payload as { targetId: string };
        return Promise.resolve(response(kind, id, payload, 'revoked', { kind: 'revoke', state: 'revoked',
          payloadHash: controlPayloadHash(payload), targetId: target.targetId }));
      },
    } as unknown as Pick<HelperProcess, 'identity' | 'request'>;
    const authority = new FrozenControlAuthority('sender', helper, () => true, () => 1300, 1024, () => current);
    const pending = authority.capture('capture', 'sender', '42', 1, 1);
    current = false;
    profile.resolve(response('profile', 'capture', profilePayload, 'qualified', { kind: 'profile', state: 'qualified',
      targetId: 'capture', payloadHash: controlPayloadHash(profilePayload),
      qualification: { captureId: 'capture', digest: 'b'.repeat(64), principalUid: '42', revision: 1, identityEpoch: 1, capturedAtMs: 1100 } }));
    expect((await pending)?.state).toBe('capture_unknown');
    expect(authority.hasHold).toBe(true);
    await authority.revoke({ revokeId: 'capture-revoke', expectedSenderProcessNonce: 'sender', target: { kind: 'capture', captureId: 'capture' } });
    expect(authority.hasHold).toBe(false);
    expect(authority.captureOperation('capture')?.state).toBe('revoked');
  });
});
