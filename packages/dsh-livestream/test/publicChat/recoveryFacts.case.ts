import { describe, expect, it } from 'vitest';
import { appendRecoveryFact, isQualifyingObservation, messageRefDigest, validateMessageRef,
  type MessageRef, type RecoveryFact } from '../../src/publicChat/recoveryFacts';
import { controlPayloadHash } from '../../src/publicChat/grantAuthority';
import { helperReconcilePayload, messageReconcileHash, validateRecoveryReceipt,
  type MessageReconcileRequest } from '../../src/publicChat/recoveryProtocol';

const ref: MessageRef = {
  requestId: 'request', sourceKey: 'source', requestHash: 'a'.repeat(64), helperPayloadHash: 'b'.repeat(64),
  textDigest: 'c'.repeat(64), grant: {
    version: 'dsh-public-chat-v1', transportKind: 'frozen_http', buildDigest: 'd'.repeat(64), instanceId: 'instance',
    senderProcessNonce: 'sender', senderConnectionGeneration: 1, authorizationId: 'auth', captureId: 'capture',
    qualificationDigest: 'e'.repeat(64), qualificationRevision: 1, identityEpoch: 1, accountRecordId: 'record',
    principalUid: '42', roomId: '101', platformRoomId: '202', helperProcessNonce: 'helper', authContextId: 'context',
    authContextRevision: 1, materialDigest: 'f'.repeat(64), rawSourceSessionId: 'session', rawSourceConnectionGeneration: 1,
    rawBrowserContextId: 'raw-context', roomBindingProofDigest: '1'.repeat(64), inputConnectionGeneration: 1,
    liveEpoch: 'live', liveEpochStartedAtMs: 1000, grantId: 'grant', authorizedAtMs: 1100,
  },
};

const note = { kind: 'note', factId: 'fact-1', seq: 1, refDigest: messageRefDigest(ref), hostRecordedAtMs: 1300, note: 'not seen' } as const;
const direct = { kind: 'positive_observation', factId: 'fact-2', seq: 2, refDigest: messageRefDigest(ref),
  hostRecordedAtMs: 1600, source: 'owner', attributionStrength: 'direct', observedAtMs: 1500,
  textDigest: ref.textDigest, principalUid: '42', roomId: '101', platformRoomId: '202', observerRef: null } as const;

describe('schema4 message references and facts', () => {
  it('requires the full exact original reference and forbids new or missing grant fields', () => {
    expect(validateMessageRef(ref)).toBe(true);
    expect(validateMessageRef({ ...ref, grant: { ...ref.grant, senderProcessNonce: '' } })).toBe(false);
    expect(validateMessageRef({ ...ref, grant: { ...ref.grant, arbitrary: true } })).toBe(false);
    expect(validateMessageRef({ ...ref, executionEnded: true })).toBe(false);
  });

  it('deduplicates a stable fact without advancing the head and rejects altered identity', () => {
    const first = appendRecoveryFact(ref, [], note);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('fixture failure');
    const duplicate = appendRecoveryFact(ref, first.facts, note);
    expect(duplicate.ok && duplicate.duplicate).toBe(true);
    expect(duplicate.ok && duplicate.digest).toBe(first.digest);
    const conflict = appendRecoveryFact(ref, first.facts, { ...note, note: 'changed' });
    expect(conflict).toMatchObject({ ok: false, conflict: true });
    expect(first.facts).toEqual([note]);
  });

  it('rejects caller-supplied terminal and recovery fields or mismatched original identity', () => {
    for (const candidate of [
      { ...note, executionEnded: true },
      { ...note, safeToResume: true },
      { ...direct, seq: 1, principalUid: '43' },
      { ...direct, seq: 1, platformRoomId: '203' },
      { ...direct, seq: 1, textDigest: '0'.repeat(64) },
    ]) expect(appendRecoveryFact(ref, [], candidate).ok).toBe(false);
  });

  it('only qualifies a directly attributed observation in the original operation time window', () => {
    expect(isQualifyingObservation(ref, direct as RecoveryFact, 1200, 1250)).toBe(true);
    expect(isQualifyingObservation(ref, { ...direct, attributionStrength: 'indirect' }, 1200, 1250)).toBe(false);
    expect(isQualifyingObservation(ref, { ...direct, observedAtMs: 1249 }, 1200, 1250)).toBe(false);
    expect(isQualifyingObservation(ref, { ...direct, observedAtMs: 6601 }, 1200, 1250)).toBe(false);
    expect(isQualifyingObservation(ref, note, 1200, 1250)).toBe(false);
    expect(isQualifyingObservation(ref, direct, 1200, null)).toBe(false);
  });

  it('requires the original helper receipt and a matching direct observation', () => {
    const facts = [note, direct];
    const request: MessageReconcileRequest = { controlId: 'control', expectedSenderProcessNonce: 'sender', ref,
      factsRevision: facts.length, factsDigest: controlPayloadHash(facts), facts, localFactsToken: 'local-1' };
    const receipt = { version: 'dsh-public-chat-recovery-v1', controlId: 'control', kind: 'message_reconcile',
      originControlPayloadHash: messageReconcileHash(request), helperPayloadHash: controlPayloadHash(helperReconcilePayload(request)),
      ref, refDigest: messageRefDigest(ref), factsRevision: 2, factsDigest: request.factsDigest,
      helperNonce: 'helper', senderProcessNonce: 'sender', authContextId: 'context', authContextRevision: 1,
      materialDigest: ref.grant.materialDigest, joinedWitnessId: 'joined', acceptedAtMs: 1200, firstWriteAttemptAtMs: 1250,
      joinedAtMs: 1500, writeAttempted: true, recoveryCommitId: 'commit', committedAtMs: 1600,
      decision: 'observed_unknown_released' };
    expect(validateRecoveryReceipt(receipt, request)).toBe(true);
    expect(validateRecoveryReceipt({ ...receipt, senderProcessNonce: 'new-process' }, request)).toBe(false);
    expect(validateRecoveryReceipt({ ...receipt, joinedAtMs: 1249 }, request)).toBe(false);
    expect(validateRecoveryReceipt({ ...receipt, safeToResume: true }, request)).toBe(false);
    expect(validateRecoveryReceipt({ ...receipt, firstWriteAttemptAtMs: null }, request)).toBe(false);
    expect(validateRecoveryReceipt({ ...receipt, committedAtMs: 5101 }, request, 100)).toBe(false);
  });
});
