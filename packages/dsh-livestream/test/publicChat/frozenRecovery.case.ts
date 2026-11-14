import { describe, expect, it } from 'vitest';
import { FrozenRecoveryAuthority } from '../../src/publicChat/frozenRecovery';
import { controlPayloadHash } from '../../src/publicChat/grantAuthority';
import { helperReconcilePayload, messageReconcileHash, type MessageReconcileRequest } from '../../src/publicChat/recoveryProtocol';
import { messageRefDigest, type MessageRef } from '../../src/publicChat/recoveryFacts';
import type { HelperProcess, HelperReply } from '../../src/publicChat/helperLauncher';
import type { RuntimeOperation } from '../../src/publicChat/frozenSenderRuntime';

const ref: MessageRef = { requestId: 'message', sourceKey: 'source', requestHash: 'a'.repeat(64),
  helperPayloadHash: 'b'.repeat(64), textDigest: 'c'.repeat(64), grant: {
    version: 'dsh-public-chat-v1', transportKind: 'frozen_http', buildDigest: 'd'.repeat(64), instanceId: 'instance',
    senderProcessNonce: 'sender', senderConnectionGeneration: 1, authorizationId: 'auth', captureId: 'capture',
    qualificationDigest: 'e'.repeat(64), qualificationRevision: 1, identityEpoch: 1, accountRecordId: 'record',
    principalUid: '42', roomId: '101', platformRoomId: '202', helperProcessNonce: 'helper', authContextId: 'context',
    authContextRevision: 1, materialDigest: 'f'.repeat(64), rawSourceSessionId: 'session', rawSourceConnectionGeneration: 1,
    rawBrowserContextId: 'raw-context', roomBindingProofDigest: '1'.repeat(64), inputConnectionGeneration: 1,
    liveEpoch: 'live', liveEpochStartedAtMs: 1000, grantId: 'grant', authorizedAtMs: 1100,
  } };
const fact = { kind: 'positive_observation' as const, factId: 'fact', seq: 1, refDigest: messageRefDigest(ref),
  hostRecordedAtMs: 1600, source: 'owner' as const, attributionStrength: 'direct' as const, observedAtMs: 1500,
  textDigest: ref.textDigest, principalUid: '42', roomId: '101', platformRoomId: '202', observerRef: null };
const request: MessageReconcileRequest = { controlId: 'control', expectedSenderProcessNonce: 'sender', ref,
  factsRevision: 1, factsDigest: controlPayloadHash([fact]), facts: [fact], localFactsToken: 'local' };
const original: RuntimeOperation = { requestId: ref.requestId, sourceKey: ref.sourceKey, hash: ref.requestHash,
  helperPayloadHash: ref.helperPayloadHash, textDigest: ref.textDigest, grant: ref.grant, state: 'unknown',
  acceptedAtMs: 1200, firstWriteAttemptAtMs: 1250, joinedWitnessId: 'joined', joinedAtMs: 1500,
  factsRevision: 0, factsDigest: controlPayloadHash([]), recoveryControlId: null, recoveryReceipt: null,
  executionEnded: true, writeAttempted: true, httpResponse: null };

function committedReply(input: MessageReconcileRequest): HelperReply {
  const payload = helperReconcilePayload(input);
  const helperPayloadHash = controlPayloadHash(payload);
  const receipt = { version: 'dsh-public-chat-recovery-v1', controlId: input.controlId, kind: 'message_reconcile',
    originControlPayloadHash: messageReconcileHash(input), helperPayloadHash, ref: input.ref, refDigest: messageRefDigest(input.ref),
    factsRevision: input.factsRevision, factsDigest: input.factsDigest, helperNonce: 'helper', senderProcessNonce: 'sender',
    authContextId: 'context', authContextRevision: 1, materialDigest: ref.grant.materialDigest,
    joinedWitnessId: 'joined', acceptedAtMs: 1200, firstWriteAttemptAtMs: 1250, joinedAtMs: 1500,
    writeAttempted: true, recoveryCommitId: 'commit', committedAtMs: 1600, decision: 'observed_unknown_released' };
  return { protocol: 'dsh-public-chat-http-v1', seq: 1, kind: 'reconcileMessage', operationId: input.controlId,
    payloadHash: helperPayloadHash, helperNonce: 'helper', authContextId: 'context', authContextRevision: 1,
    materialDigest: ref.grant.materialDigest, status: 'committed',
    payload: { kind: 'message_reconcile', payloadHash: helperPayloadHash, state: 'committed', reconcile: { request: payload, receipt } } };
}

function setup() {
  let finish!: (reply: HelperReply) => void;
  const deferred = new Promise<HelperReply>((resolve) => { finish = resolve; });
  let calls = 0;
  let revision = 0;
  let commits = 0;
  const helper = { identity: { helperNonce: 'helper', authContextId: 'context', authContextRevision: 1,
    materialDigest: ref.grant.materialDigest }, request: async () => { calls++; return deferred; } } as unknown as HelperProcess;
  const authority = new FrozenRecoveryAuthority({ senderNonce: 'sender', original: (id) => id === 'message' ? original : null,
    helper: () => helper, idTaken: () => false, countOtherRecords: () => 1,
    invalidate: () => { revision++; }, revision: () => revision, now: () => 1600, onCommitted: () => { commits++; } });
  return { authority, finish, calls: () => calls, commits: () => commits, invalidate: () => { revision++; } };
}

describe('sender recovery authority', () => {
  it('retains one pending original, publishes only its helper receipt, and never repeats it', async () => {
    const fixture = setup();
    const pending = fixture.authority.start(request);
    expect(fixture.authority.operation('control')?.state).toBe('pending');
    expect(await fixture.authority.start({ ...request, controlId: 'other-control' })).toBeNull();
    expect(fixture.authority.isReleased(original)).toBe(false);
    fixture.finish(committedReply(request));
    const completed = await pending;
    expect(completed?.state).toBe('committed');
    expect(completed?.published).toBe(true);
    expect(fixture.authority.isReleased(original)).toBe(true);
    expect(original.state).toBe('unknown');
    expect((await fixture.authority.start(request))?.receipt?.recoveryCommitId).toBe('commit');
    expect(await fixture.authority.start({ ...request, controlId: 'new-control-same-head' })).toBeNull();
    expect(fixture.calls()).toBe(1);
    expect(fixture.commits()).toBe(1);
  });

  it('keeps an old acknowledgement as history when the sender revision changes', async () => {
    const fixture = setup();
    const pending = fixture.authority.start(request);
    fixture.invalidate();
    fixture.finish(committedReply(request));
    const completed = await pending;
    expect(completed?.state).toBe('committed');
    expect(completed?.published).toBe(false);
    expect(fixture.authority.isReleased(original)).toBe(false);
    expect(fixture.commits()).toBe(0);
  });
});
