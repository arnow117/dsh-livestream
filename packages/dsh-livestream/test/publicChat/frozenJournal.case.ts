import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FrozenPublicChatOperationJournal, messageReference, type FrozenJournalMessage } from '../../src/publicChat/frozenJournal';
import type { FrozenGrantProposal } from '../../src/publicChat/frozenGrant';
import { controlPayloadHash } from '../../src/publicChat/grantAuthority';
import { PublicChatSendController, type ControllerDeps } from '../../src/publicChat/controller';
import { helperReconcilePayload, messageReconcileHash, type MessageReconcileRequest } from '../../src/publicChat/recoveryProtocol';
import { messageRefDigest } from '../../src/publicChat/recoveryFacts';
import type { FrozenRecoveryControl } from '../../src/publicChat/frozenRecovery';

const dirs: string[] = [];
function directory(): string {
  const root = process.env.DSH_HOME;
  if (!root) throw new Error('task-local DSH_HOME required');
  const path = fs.mkdtempSync(join(root, 'frozen-journal-'));
  dirs.push(path);
  return path;
}
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

const proposal: FrozenGrantProposal = {
  version: 'dsh-public-chat-v1', transportKind: 'frozen_http', buildDigest: 'a'.repeat(64), instanceId: 'instance',
  senderProcessNonce: 'sender', senderConnectionGeneration: 1, authorizationId: 'authorization', captureId: 'capture',
  qualificationDigest: 'b'.repeat(64), qualificationRevision: 1, identityEpoch: 1, accountRecordId: 'record',
  principalUid: '42', roomId: '101', platformRoomId: '202', helperProcessNonce: 'helper', authContextId: 'context',
  authContextRevision: 1, materialDigest: 'c'.repeat(64), rawSourceSessionId: 'raw-session', rawSourceConnectionGeneration: 1,
  rawBrowserContextId: 'raw-context', roomBindingProofDigest: 'd'.repeat(64), inputConnectionGeneration: 1,
  liveEpoch: 'live', liveEpochStartedAtMs: 1000,
};
const grant = { ...proposal, grantId: 'grant', authorizedAtMs: 1200 };
const message: FrozenJournalMessage = { requestId: 'message', sourceKey: 'source', senderProcessNonce: 'sender', grant,
  requestHash: 'e'.repeat(64), helperPayloadHash: 'f'.repeat(64), textDigest: createHash('sha256').update('fixture text').digest('hex'),
  autoEvent: null, state: 'dispatching', executionEnded: false, writeAttempted: false, httpResponse: null,
  createdAtMs: 1300, facts: [], factsRevision: 0, factsDigest: controlPayloadHash([]), conflicts: [], terminalEvidence: null,
  recovery: { state: 'blocked', factsRevision: 0, factsDigest: controlPayloadHash([]), controlId: null, receipt: null } };

function addAuthorization(journal: FrozenPublicChatOperationJournal): void {
  journal.controls.push({ kind: 'authorize', id: 'authorization', payloadHash: 'a'.repeat(64), senderProcessNonce: 'sender',
    target: proposal, qualificationTokenDigest: 'b'.repeat(64), localRevision: 'revision', state: 'active', grant,
    ack: { kind: 'authorize', id: 'authorization', payloadHash: 'a'.repeat(64), helperPayloadHash: controlPayloadHash(proposal),
      senderProcessNonce: 'sender', state: 'authorized', target: proposal, grant } });
}

function revokeAuthorization(journal: FrozenPublicChatOperationJournal): void {
  const original = journal.controls[0];
  if (original.kind !== 'authorize') throw new Error('fixture authorization missing');
  original.state = 'revoked';
  original.ack = { kind: 'authorize', id: original.id, payloadHash: original.payloadHash,
    helperPayloadHash: controlPayloadHash(original.target), senderProcessNonce: original.senderProcessNonce,
    state: 'revoked', target: original.target };
}

describe('frozen single-file journal', () => {
  it.each([1, 2])('does not restore a recovery after write %i fails at directory fsync', async (failureWrite) => {
    const dir = directory();
    let injectFailure = false;
    let replacements = 0;
    const io = new Proxy(fs, { get(target, key) {
      if (key === 'renameSync') return (...args: Parameters<typeof fs.renameSync>) => {
        const result = fs.renameSync(...args);
        if (injectFailure) replacements++;
        return result;
      };
      if (key === 'fsyncSync') return (fd: number) => {
        if (injectFailure && replacements === failureWrite && fs.fstatSync(fd).isDirectory()) {
          throw new Error('fixture directory fsync failure');
        }
        return fs.fsyncSync(fd);
      };
      return Reflect.get(target, key);
    } }) as typeof fs;
    const journal = new FrozenPublicChatOperationJournal(dir, io);
    addAuthorization(journal);
    revokeAuthorization(journal);
    journal.records.push({ ...structuredClone(message), state: 'unknown' });
    journal.write();
    const unavailable = async () => ({ ok: false });
    const gateway = { frozenState: unavailable, frozenCapture: unavailable, frozenAuthorize: unavailable,
      frozenRevoke: unavailable, frozenControlOperation: unavailable, frozenSend: unavailable, frozenOperation: unavailable,
      frozenRecoveryOperation: unavailable, frozenReconcileMessage: async (request: MessageReconcileRequest) => {
        const receipt = { version: 'dsh-public-chat-recovery-v1' as const, controlId: request.controlId,
          kind: 'message_reconcile' as const, originControlPayloadHash: messageReconcileHash(request),
          helperPayloadHash: controlPayloadHash(helperReconcilePayload(request)), ref: request.ref, refDigest: messageRefDigest(request.ref),
          factsRevision: request.factsRevision, factsDigest: request.factsDigest, helperNonce: 'helper', senderProcessNonce: 'sender',
          authContextId: 'context', authContextRevision: 1, materialDigest: 'c'.repeat(64), joinedWitnessId: 'joined',
          acceptedAtMs: 1300, firstWriteAttemptAtMs: null, joinedAtMs: 1400, writeAttempted: false,
          recoveryCommitId: 'recovery', committedAtMs: 1500, decision: 'never_written_released' as const };
        const record: FrozenRecoveryControl = { kind: 'message_reconcile', id: request.controlId, senderProcessNonce: 'sender',
          payloadHash: messageReconcileHash(request), helperPayloadHash: controlPayloadHash(helperReconcilePayload(request)),
          state: 'committed', request, receipt, published: true };
        injectFailure = true;
        return { ok: true, value: record };
      } };
    const deployment = { buildDigest: 'a'.repeat(64), instanceId: 'instance', accountRecordId: 'record',
      expectedPrincipalUid: '42', roomId: '101' };
    const controller = new PublicChatSendController({ deployment, gateway: gateway as unknown as ControllerDeps['gateway'], journal,
      clock: { wall: () => 1500, monotonic: () => 1500 } });
    const result = await controller.reconcileFrozenMessage('message');
    expect(result.ok).toBe(false);
    expect(replacements).toBe(failureWrite);
    expect(controller.hold).toBe(true);
    const restoredJournal = new FrozenPublicChatOperationJournal(dir);
    expect(restoredJournal.corrupt).toBe(false);
    if (failureWrite === 2) {
      expect(restoredJournal.records[0].recovery.state).toBe('committed');
      expect(restoredJournal.controls.find((control) => control.kind === 'message_reconcile')?.state).toBe('committed');
    }
    const restarted = new PublicChatSendController({ deployment, gateway: gateway as unknown as ControllerDeps['gateway'], journal: restoredJournal });
    expect(restarted.hold).toBe(true);
    expect((await restarted.reconcileControl('authorization')).ok).toBe(true);
    if (!result.controlId) throw new Error('recovery control missing');
    expect((await restarted.reconcileControl(result.controlId)).ok).toBe(true);
    expect(restarted.hold).toBe(false);
    expect((await restarted.submit({ requestId: 'message', sourceKey: 'source', text: 'fixture text' })).status).toBe('duplicate');
  });

  it('persists response metadata without converting an unknown into success', () => {
    const dir = directory();
    const journal = new FrozenPublicChatOperationJournal(dir);
    addAuthorization(journal);
    const response = { version: 'dsh-public-chat-http-response-v1' as const, status: 302, length: 17, digest: 'a'.repeat(64) };
    journal.records.push({ ...structuredClone(message), state: 'unknown', executionEnded: true, writeAttempted: true, httpResponse: response });
    journal.write();
    const restored = new FrozenPublicChatOperationJournal(dir);
    expect(restored.corrupt).toBe(false);
    expect(restored.records[0].httpResponse).toEqual(response);
    expect(restored.records[0].state).toBe('unknown');
  });

  it('rejects more than 1024 original records without replacing the existing journal', () => {
    const dir = directory();
    const journal = new FrozenPublicChatOperationJournal(dir);
    addAuthorization(journal);
    journal.records.push({ ...structuredClone(message), state: 'unknown' });
    const capture = (id: string) => ({ kind: 'capture' as const, id, senderProcessNonce: 'sender',
      payloadHash: controlPayloadHash({ captureId: id, expectedSenderProcessNonce: 'sender' }),
      helperNonce: 'helper', authContextId: 'context', authContextRevision: 1, materialDigest: 'c'.repeat(64),
      buildDigest: 'a'.repeat(64), instanceId: 'instance', state: 'capture_unknown' as const, ack: null });
    for (let index = 0; index < 1022; index++) journal.controls.push(capture(`capture-${index}`));
    journal.write();
    const file = join(dir, 'public-chat-operations.json');
    const before = fs.readFileSync(file);
    journal.controls.push(capture('over-capacity'));
    expect(() => journal.write()).toThrow('journal record capacity exceeded');
    expect(fs.readFileSync(file)).toEqual(before);
    const restored = new FrozenPublicChatOperationJournal(dir);
    expect(restored.corrupt).toBe(false);
    expect(restored.records[0].state).toBe('unknown');
    expect(restored.controls).toHaveLength(1023);
  });

  it('retains a conflict when a joined receipt contradicts an earlier write attempt', async () => {
    const journal = new FrozenPublicChatOperationJournal(directory());
    addAuthorization(journal);
    revokeAuthorization(journal);
    journal.records.push({ ...structuredClone(message), state: 'unknown', writeAttempted: true });
    const unavailable = async () => ({ ok: false });
    const gateway = { frozenState: unavailable, frozenCapture: unavailable, frozenAuthorize: unavailable,
      frozenRevoke: unavailable, frozenControlOperation: unavailable, frozenSend: unavailable, frozenOperation: unavailable,
      frozenRecoveryOperation: unavailable, frozenReconcileMessage: async (request: MessageReconcileRequest) => {
        const receipt = { version: 'dsh-public-chat-recovery-v1' as const, controlId: request.controlId,
          kind: 'message_reconcile' as const, originControlPayloadHash: messageReconcileHash(request),
          helperPayloadHash: controlPayloadHash(helperReconcilePayload(request)), ref: request.ref, refDigest: messageRefDigest(request.ref),
          factsRevision: request.factsRevision, factsDigest: request.factsDigest, helperNonce: 'helper', senderProcessNonce: 'sender',
          authContextId: 'context', authContextRevision: 1, materialDigest: 'c'.repeat(64), joinedWitnessId: 'joined',
          acceptedAtMs: 1300, firstWriteAttemptAtMs: null, joinedAtMs: 1400, writeAttempted: false,
          recoveryCommitId: 'recovery', committedAtMs: 1500, decision: 'never_written_released' as const };
        return { ok: true, value: { kind: 'message_reconcile', id: request.controlId, senderProcessNonce: 'sender',
          payloadHash: messageReconcileHash(request), helperPayloadHash: controlPayloadHash(helperReconcilePayload(request)),
          state: 'committed', request, receipt, published: true } };
      } };
    const controller = new PublicChatSendController({ deployment: { buildDigest: 'a'.repeat(64), instanceId: 'instance',
      accountRecordId: 'record', expectedPrincipalUid: '42', roomId: '101' },
      gateway: gateway as unknown as ControllerDeps['gateway'], journal });
    expect(await controller.reconcileFrozenMessage('message')).toMatchObject({ ok: false, reason: 'execution-facts-conflict' });
    expect(controller.frozenOperationView('message')?.state).toBe('unknown');
    expect(controller.frozenOperationView('message')?.conflicts).toMatchObject([{ reason: 'execution-facts-conflict' }]);
    expect(journal.controls.some((entry) => entry.kind === 'message_reconcile' && !!entry.ack?.receipt)).toBe(true);
    expect(controller.hold).toBe(true);
  });

  it('does not clear a different original unknown when one message is reconciled', async () => {
    const journal = new FrozenPublicChatOperationJournal(directory());
    addAuthorization(journal);
    revokeAuthorization(journal);
    journal.records.push({ ...structuredClone(message), state: 'unknown' },
      { ...structuredClone(message), requestId: 'other', sourceKey: 'other', state: 'unknown',
        executionEnded: true, writeAttempted: true });
    const unavailable = async () => ({ ok: false });
    const gateway = { frozenState: unavailable, frozenCapture: unavailable, frozenAuthorize: unavailable,
      frozenRevoke: unavailable, frozenControlOperation: unavailable, frozenSend: unavailable, frozenOperation: unavailable,
      frozenRecoveryOperation: unavailable, frozenReconcileMessage: async (request: MessageReconcileRequest) => {
        const receipt = { version: 'dsh-public-chat-recovery-v1' as const, controlId: request.controlId,
          kind: 'message_reconcile' as const, originControlPayloadHash: messageReconcileHash(request),
          helperPayloadHash: controlPayloadHash(helperReconcilePayload(request)), ref: request.ref, refDigest: messageRefDigest(request.ref),
          factsRevision: request.factsRevision, factsDigest: request.factsDigest, helperNonce: 'helper', senderProcessNonce: 'sender',
          authContextId: 'context', authContextRevision: 1, materialDigest: 'c'.repeat(64), joinedWitnessId: 'joined',
          acceptedAtMs: 1300, firstWriteAttemptAtMs: null, joinedAtMs: 1400, writeAttempted: false,
          recoveryCommitId: 'recovery', committedAtMs: 1500, decision: 'never_written_released' as const };
        const record: FrozenRecoveryControl = { kind: 'message_reconcile', id: request.controlId, senderProcessNonce: 'sender',
          payloadHash: messageReconcileHash(request), helperPayloadHash: controlPayloadHash(helperReconcilePayload(request)),
          state: 'committed', request, receipt, published: true };
        return { ok: true, value: record };
      } };
    const controller = new PublicChatSendController({ deployment: { buildDigest: 'a'.repeat(64), instanceId: 'instance',
      accountRecordId: 'record', expectedPrincipalUid: '42', roomId: '101' },
      gateway: gateway as unknown as ControllerDeps['gateway'], journal, clock: { wall: () => 1500, monotonic: () => 1500 } });
    expect((await controller.reconcileFrozenMessage('message')).ok).toBe(true);
    expect(controller.frozenOperationView('message')?.state).toBe('terminal_not_dispatched');
    expect(controller.frozenOperationView('other')?.state).toBe('unknown');
    expect(controller.requestResumeAfterReconciliation()).toMatchObject({ safeToResume: false, blockingRequestIds: ['other'] });
  });

  it('keeps new facts held while an older control has an unknown acknowledgement', async () => {
    const dir = directory();
    const journal = new FrozenPublicChatOperationJournal(dir);
    addAuthorization(journal);
    revokeAuthorization(journal);
    journal.records.push({ ...structuredClone(message), state: 'unknown', executionEnded: true, writeAttempted: true });
    let posts = 0;
    const unavailable = async () => ({ ok: false });
    const gateway = { frozenState: unavailable, frozenCapture: unavailable, frozenAuthorize: unavailable,
      frozenRevoke: unavailable, frozenControlOperation: unavailable, frozenSend: unavailable, frozenOperation: unavailable,
      frozenRecoveryOperation: unavailable, frozenReconcileMessage: async () => { posts++; return { ok: false }; } };
    const controller = new PublicChatSendController({ deployment: { buildDigest: 'a'.repeat(64), instanceId: 'instance',
      accountRecordId: 'record', expectedPrincipalUid: '42', roomId: '101' },
      gateway: gateway as unknown as ControllerDeps['gateway'], journal, clock: { wall: () => 1500, monotonic: () => 1500 } });
    const first = await controller.reconcileFrozenMessage('message');
    expect(first).toMatchObject({ ok: false, reason: 'recovery-unknown' });
    const ref = messageReference(message);
    expect(controller.recordVerificationFact({ requestId: 'message', principalUid: '42', roomId: '101', grantId: 'grant',
      liveEpoch: 'live', inputConnectionGeneration: 1, ref, factId: 'late-note', fact: { kind: 'note', note: '补充核对' } }).ok).toBe(true);
    expect((await controller.reconcileFrozenMessage('message')).reason).toBe('original-recovery-pending');
    expect(controller.requestResumeAfterReconciliation().safeToResume).toBe(false);
    expect(posts).toBe(1);
    const restored = new FrozenPublicChatOperationJournal(dir);
    expect(restored.corrupt).toBe(false);
    expect(restored.records[0].factsRevision).toBe(1);
    expect(restored.controls.some((control) => control.kind === 'message_reconcile' && control.state === 'recovery_unknown')).toBe(true);
  });

  it('retains joined never-written evidence and treats a later visible observation as a conflict', async () => {
    const dir = directory();
    const journal = new FrozenPublicChatOperationJournal(dir);
    addAuthorization(journal);
    revokeAuthorization(journal);
    journal.records.push({ ...structuredClone(message), state: 'unknown' });
    const unavailable = async () => ({ ok: false });
    const gateway = { frozenState: unavailable, frozenCapture: unavailable, frozenAuthorize: unavailable,
      frozenRevoke: unavailable, frozenControlOperation: unavailable, frozenSend: unavailable, frozenOperation: unavailable,
      frozenRecoveryOperation: unavailable, frozenReconcileMessage: async (request: MessageReconcileRequest) => {
        const receipt = { version: 'dsh-public-chat-recovery-v1' as const, controlId: request.controlId,
          kind: 'message_reconcile' as const, originControlPayloadHash: messageReconcileHash(request),
          helperPayloadHash: controlPayloadHash(helperReconcilePayload(request)), ref: request.ref, refDigest: messageRefDigest(request.ref),
          factsRevision: request.factsRevision, factsDigest: request.factsDigest, helperNonce: 'helper', senderProcessNonce: 'sender',
          authContextId: 'context', authContextRevision: 1, materialDigest: 'c'.repeat(64), joinedWitnessId: 'joined',
          acceptedAtMs: 1300, firstWriteAttemptAtMs: null, joinedAtMs: 1400, writeAttempted: false,
          recoveryCommitId: 'recovery', committedAtMs: 1500, decision: 'never_written_released' as const };
        const record: FrozenRecoveryControl = { kind: 'message_reconcile', id: request.controlId, senderProcessNonce: 'sender',
          payloadHash: messageReconcileHash(request), helperPayloadHash: controlPayloadHash(helperReconcilePayload(request)),
          state: 'committed', request, receipt, published: true };
        return { ok: true, value: record };
      } };
    const controller = new PublicChatSendController({ deployment: { buildDigest: 'a'.repeat(64), instanceId: 'instance',
      accountRecordId: 'record', expectedPrincipalUid: '42', roomId: '101' },
      gateway: gateway as unknown as ControllerDeps['gateway'], journal, clock: { wall: () => 1500, monotonic: () => 1500 } });
    expect((await controller.reconcileFrozenMessage('message')).ok).toBe(true);
    expect(controller.frozenOperationView('message')?.state).toBe('terminal_not_dispatched');
    const cleanRestartJournal = new FrozenPublicChatOperationJournal(dir);
    expect(cleanRestartJournal.records[0].terminalEvidence?.writeAttempted).toBe(false);
    const cleanRestart = new PublicChatSendController({ deployment: { buildDigest: 'a'.repeat(64), instanceId: 'instance',
      accountRecordId: 'record', expectedPrincipalUid: '42', roomId: '101' },
      gateway: gateway as unknown as ControllerDeps['gateway'], journal: cleanRestartJournal });
    expect(cleanRestart.hold).toBe(true);
    expect((await cleanRestart.reconcileControl('authorization')).ok).toBe(true);
    const recoveryId = cleanRestartJournal.records[0].recovery.controlId;
    if (!recoveryId) throw new Error('recovery control missing');
    expect((await cleanRestart.reconcileControl(recoveryId)).ok).toBe(true);
    expect(cleanRestart.hold).toBe(false);
    expect(cleanRestart.frozenOperationView('message')?.state).toBe('terminal_not_dispatched');
    expect((await cleanRestart.submit({ requestId: 'message', sourceKey: 'source', text: 'fixture text' })).status).toBe('duplicate');
    const ref = messageReference(message);
    expect(controller.recordVerificationFact({ requestId: 'message', principalUid: '42', roomId: '101', grantId: 'grant',
      liveEpoch: 'live', inputConnectionGeneration: 1, ref, factId: 'contradiction',
      observationSource: { source: 'owner', observerRef: null }, fact: { kind: 'positive_observation',
        attributionStrength: 'direct', observedAtMs: 1450, textDigest: message.textDigest,
        principalUid: '42', roomId: '101', platformRoomId: '202' } }).ok).toBe(true);
    const restored = new FrozenPublicChatOperationJournal(dir);
    expect(restored.corrupt).toBe(false);
    expect(restored.records[0].conflicts).toMatchObject([{ reason: 'never-written-observed' }]);
    expect(controller.requestResumeAfterReconciliation().safeToResume).toBe(false);
  });

  it('persists a verified published recovery before allowing future actions while retaining unknown', async () => {
    const dir = directory();
    const journal = new FrozenPublicChatOperationJournal(dir);
    addAuthorization(journal);
    revokeAuthorization(journal);
    journal.records.push({ ...structuredClone(message), state: 'unknown', executionEnded: true, writeAttempted: true });
    let release!: (record: FrozenRecoveryControl) => void;
    let issued: MessageReconcileRequest | null = null;
    const reply = new Promise<FrozenRecoveryControl>((resolve) => { release = resolve; });
    const unavailable = async () => ({ ok: false });
    const gateway = { frozenState: unavailable, frozenCapture: unavailable, frozenAuthorize: unavailable,
      frozenRevoke: unavailable, frozenControlOperation: unavailable, frozenSend: unavailable, frozenOperation: unavailable,
      frozenRecoveryOperation: unavailable,
      frozenReconcileMessage: async (request: MessageReconcileRequest) => { issued = request; return { ok: true, value: await reply }; } };
    const controller = new PublicChatSendController({
      deployment: { buildDigest: 'a'.repeat(64), instanceId: 'instance', accountRecordId: 'record',
        expectedPrincipalUid: '42', roomId: '101' }, gateway: gateway as unknown as ControllerDeps['gateway'], journal,
      clock: { wall: () => 1500, monotonic: () => 1500 },
    });
    expect((await controller.reconcileControl('authorization')).ok).toBe(true);
    const ref = messageReference(message);
    expect(controller.recordVerificationFact({ requestId: 'message', principalUid: '42', roomId: '101', grantId: 'grant',
      liveEpoch: 'live', inputConnectionGeneration: 1, ref, factId: 'observed-1',
      observationSource: { source: 'owner', observerRef: null }, fact: { kind: 'positive_observation',
        attributionStrength: 'direct', observedAtMs: 1450, textDigest: message.textDigest,
        principalUid: '42', roomId: '101', platformRoomId: '202' } }).ok).toBe(true);
    const pending = controller.reconcileFrozenMessage('message');
    if (!issued) throw new Error('recovery request was not issued');
    const request: MessageReconcileRequest = issued;
    expect(controller.requestResumeAfterReconciliation().safeToResume).toBe(false);
    expect(JSON.parse(fs.readFileSync(join(dir, 'public-chat-operations.json'), 'utf8')).controls.at(-1).state).toBe('pending');
    const receipt = { version: 'dsh-public-chat-recovery-v1' as const, controlId: request.controlId,
      kind: 'message_reconcile' as const, originControlPayloadHash: messageReconcileHash(request),
      helperPayloadHash: controlPayloadHash(helperReconcilePayload(request)), ref, refDigest: messageRefDigest(ref),
      factsRevision: request.factsRevision, factsDigest: request.factsDigest, helperNonce: 'helper', senderProcessNonce: 'sender',
      authContextId: 'context', authContextRevision: 1, materialDigest: 'c'.repeat(64), joinedWitnessId: 'joined',
      acceptedAtMs: 1300, firstWriteAttemptAtMs: 1400, joinedAtMs: 1450, writeAttempted: true,
      recoveryCommitId: 'recovery', committedAtMs: 1500, decision: 'observed_unknown_released' as const };
    release({ kind: 'message_reconcile', id: request.controlId, senderProcessNonce: 'sender',
      payloadHash: messageReconcileHash(request), helperPayloadHash: controlPayloadHash(helperReconcilePayload(request)),
      state: 'committed', request, receipt, published: true });
    expect((await pending).ok).toBe(true);
    expect(controller.frozenOperationView('message')?.state).toBe('unknown');
    expect(controller.requestResumeAfterReconciliation().safeToResume).toBe(true);
    expect((await controller.reconcileFrozenMessage('message')).reason).toBe('fact-head-already-reconciled');
    const restored = new FrozenPublicChatOperationJournal(dir);
    expect(restored.corrupt).toBe(false);
    expect(restored.records[0].recovery.state).toBe('committed');
    expect(restored.records[0].state).toBe('unknown');
    const restarted = new PublicChatSendController({
      deployment: { buildDigest: 'a'.repeat(64), instanceId: 'instance', accountRecordId: 'record',
        expectedPrincipalUid: '42', roomId: '101' },
      gateway: gateway as unknown as ControllerDeps['gateway'], journal: restored,
      clock: { wall: () => 1500, monotonic: () => 1500 },
    });
    expect(restarted.requestResumeAfterReconciliation().safeToResume).toBe(false);
    expect(restarted.frozenOperationView('message')?.recovery.state).toBe('recovery_unknown');
    expect((await restarted.reconcileControl('authorization')).ok).toBe(true);
    const controlId = restored.records[0].recovery.controlId;
    if (!controlId) throw new Error('recovery control missing');
    expect(await restarted.reconcileControl(controlId)).toMatchObject({ ok: true, reason: 'committed' });
    expect(restarted.requestResumeAfterReconciliation().safeToResume).toBe(true);
    expect(restarted.frozenOperationView('message')?.state).toBe('unknown');
    expect(restarted.frozenOperationView('message')?.recovery.state).toBe('committed');
    expect((await restarted.submit({ requestId: 'message', sourceKey: 'source', text: 'fixture text' })).status).toBe('duplicate');
  });

  it('persists a note on the original frozen reference without making unknown recoverable', () => {
    const dir = directory();
    const journal = new FrozenPublicChatOperationJournal(dir);
    addAuthorization(journal);
    journal.records.push({ ...structuredClone(message), state: 'unknown' });
    const unavailable = async () => ({ ok: false });
    const gateway = { frozenState: unavailable, frozenCapture: unavailable, frozenAuthorize: unavailable,
      frozenRevoke: unavailable, frozenControlOperation: unavailable, frozenSend: unavailable, frozenOperation: unavailable,
      frozenReconcileMessage: unavailable, frozenRecoveryOperation: unavailable };
    const controller = new PublicChatSendController({
      deployment: { buildDigest: 'a'.repeat(64), instanceId: 'instance', accountRecordId: 'record',
        expectedPrincipalUid: '42', roomId: '101' },
      gateway: gateway as unknown as ControllerDeps['gateway'], journal,
      clock: { wall: () => 1500, monotonic: () => 1500 },
    });
    const input = { requestId: 'message', principalUid: '42', roomId: '101', grantId: 'grant', liveEpoch: 'live',
      inputConnectionGeneration: 1, ref: messageReference(message), factId: 'note-1', fact: { kind: 'note', note: '未看到' } };
    expect(controller.recordVerificationFact(input).ok).toBe(true);
    expect(controller.recordVerificationFact(input).ok).toBe(true);
    expect(controller.frozenOperationView('message')?.factsRevision).toBe(1);
    expect(new FrozenPublicChatOperationJournal(dir).records[0].facts).toHaveLength(1);
    expect(controller.requestResumeAfterReconciliation().safeToResume).toBe(false);
    expect(controller.recordVerificationFact({ ...input, factId: 'bad', fact: { kind: 'note', note: 'x', executionEnded: true } }).ok).toBe(false);
    expect(controller.recordVerificationFact({ ...input, safeToResume: true } as typeof input).ok).toBe(false);
    expect(controller.recordVerificationFact({ ...input, ref: { ...input.ref, sourceKey: 'other' }, factId: 'wrong' }).ok).toBe(false);
    expect(controller.recordVerificationFact({ ...input, fact: { kind: 'note', note: '不同内容' } }).ok).toBe(false);
    const restored = new FrozenPublicChatOperationJournal(dir).records[0];
    expect(restored.facts).toHaveLength(1);
    expect(restored.conflicts).toMatchObject([{ reason: 'fact-id-conflict', factId: 'note-1' }]);
    expect(controller.requestResumeAfterReconciliation().safeToResume).toBe(false);
  });

  it('does not report recovery safe while an original frozen message is unknown', () => {
    const journal = new FrozenPublicChatOperationJournal(directory());
    journal.records.push({ ...structuredClone(message), state: 'unknown' });
    const unavailable = async () => ({ ok: false });
    const gateway = { frozenState: unavailable, frozenCapture: unavailable, frozenAuthorize: unavailable,
      frozenRevoke: unavailable, frozenControlOperation: unavailable, frozenSend: unavailable, frozenOperation: unavailable,
      frozenReconcileMessage: unavailable, frozenRecoveryOperation: unavailable };
    const controller = new PublicChatSendController({
      deployment: { buildDigest: 'a'.repeat(64), instanceId: 'instance', accountRecordId: 'record',
        expectedPrincipalUid: '42', roomId: '101' },
      gateway: gateway as unknown as ControllerDeps['gateway'],
      journal,
    });
    expect(controller.requestResumeAfterReconciliation()).toEqual({
      safeToResume: false,
      blockingRequestIds: ['message'],
    });
    expect(controller.hold).toBe(true);
  });

  it('reconciles only the matching original frozen operation without retaining its text', async () => {
    const dir = directory();
    const journal = new FrozenPublicChatOperationJournal(dir);
    addAuthorization(journal);
    journal.records.push({ ...structuredClone(message), state: 'unknown' });
    const unavailable = async () => ({ ok: false });
    const gateway = { frozenState: unavailable, frozenCapture: unavailable, frozenAuthorize: unavailable,
      frozenRevoke: unavailable, frozenControlOperation: unavailable, frozenSend: unavailable,
      frozenReconcileMessage: unavailable, frozenRecoveryOperation: unavailable,
      frozenOperation: async () => ({ ok: true, value: { requestId: message.requestId, sourceKey: message.sourceKey,
        hash: message.requestHash, helperPayloadHash: message.helperPayloadHash, textDigest: message.textDigest, grant, state: 'terminal_not_dispatched',
        executionEnded: true, writeAttempted: false, httpResponse: null } }) };
    const controller = new PublicChatSendController({
      deployment: { buildDigest: 'a'.repeat(64), instanceId: 'instance', accountRecordId: 'record',
        expectedPrincipalUid: '42', roomId: '101' },
      gateway: gateway as unknown as ControllerDeps['gateway'], journal,
    });
    expect(await controller.reconcileFromSender('message')).toEqual({ ok: true, reason: 'recorded' });
    expect(controller.frozenOperationView('message')?.state).toBe('unknown');
    expect(new FrozenPublicChatOperationJournal(dir).records[0].state).toBe('unknown');
    expect(controller.requestResumeAfterReconciliation().safeToResume).toBe(false);
  });

  it('keeps the original unknown when the sender response contradicts a recorded write', async () => {
    const journal = new FrozenPublicChatOperationJournal(directory());
    addAuthorization(journal);
    journal.records.push({ ...structuredClone(message), state: 'unknown', writeAttempted: true });
    const unavailable = async () => ({ ok: false });
    const gateway = { frozenState: unavailable, frozenCapture: unavailable, frozenAuthorize: unavailable,
      frozenRevoke: unavailable, frozenControlOperation: unavailable, frozenSend: unavailable,
      frozenReconcileMessage: unavailable, frozenRecoveryOperation: unavailable,
      frozenOperation: async () => ({ ok: true, value: { requestId: message.requestId, sourceKey: message.sourceKey,
        hash: message.requestHash, helperPayloadHash: message.helperPayloadHash, textDigest: message.textDigest, grant, state: 'terminal_not_dispatched',
        executionEnded: true, writeAttempted: false, httpResponse: null } }) };
    const controller = new PublicChatSendController({
      deployment: { buildDigest: 'a'.repeat(64), instanceId: 'instance', accountRecordId: 'record',
        expectedPrincipalUid: '42', roomId: '101' },
      gateway: gateway as unknown as ControllerDeps['gateway'], journal,
    });
    expect((await controller.reconcileFromSender('message')).ok).toBe(false);
    expect(controller.frozenOperationView('message')?.state).toBe('unknown');
    expect(controller.requestResumeAfterReconciliation().safeToResume).toBe(false);
  });

  it('retains full original grant and restores unresolved controls and messages as holds', () => {
    const dir = directory();
    const journal = new FrozenPublicChatOperationJournal(dir);
    addAuthorization(journal);
    journal.controls.push({ kind: 'capture', id: 'capture', senderProcessNonce: 'sender', state: 'qualified',
      helperNonce: 'helper', authContextId: 'context', authContextRevision: 1, materialDigest: 'c'.repeat(64),
      buildDigest: 'a'.repeat(64), instanceId: 'instance', ack: null,
      payloadHash: controlPayloadHash({ captureId: 'capture', expectedSenderProcessNonce: 'sender' }) });
    journal.records.push(structuredClone(message));
    journal.write();
    const raw = fs.readFileSync(join(dir, 'public-chat-operations.json'), 'utf8');
    expect(JSON.parse(raw).schemaVersion).toBe(4);
    expect(raw).not.toContain('fixture text');
    expect(raw).not.toContain('qualificationToken"');
    expect(fs.statSync(join(dir, 'public-chat-operations.json')).mode & 0o777).toBe(0o600);
    const restored = new FrozenPublicChatOperationJournal(dir);
    expect(restored.corrupt).toBe(false);
    expect(restored.controls[0].state).toBe('authorizing_unknown');
    expect(restored.controls[1].state).toBe('capture_unknown');
    expect(restored.records[0].state).toBe('unknown');
    expect(restored.records[0].grant).toEqual(grant);
  });

  it('preserves old schema and malformed duplicate keys without treating them as empty', () => {
    for (const raw of ['{"schemaVersion":2,"records":[],"controls":[]}', '{"schemaVersion":3,"records":[],"controls":[]}',
      '{"schemaVersion":4,"schemaVersion":4,"records":[],"controls":[]}']) {
      const dir = directory();
      const path = join(dir, 'public-chat-operations.json');
      fs.writeFileSync(path, raw, { mode: 0o600 });
      const journal = new FrozenPublicChatOperationJournal(dir);
      expect(journal.corrupt).toBe(true);
      expect(() => journal.write()).toThrow();
      expect(fs.readFileSync(path, 'utf8')).toBe(raw);
    }
  });

  it('rejects aliases and duplicate original IDs', () => {
    const dir = directory();
    const target = join(dir, 'target');
    fs.writeFileSync(target, '{}', { mode: 0o600 });
    fs.linkSync(target, join(dir, 'public-chat-operations.json'));
    expect(new FrozenPublicChatOperationJournal(dir).corrupt).toBe(true);
    const other = new FrozenPublicChatOperationJournal(directory());
    addAuthorization(other);
    other.records.push(structuredClone(message), { ...structuredClone(message), sourceKey: 'different' });
    expect(() => other.write()).toThrow();
  });

  it('preserves the original file if atomic replacement fails', () => {
    const dir = directory();
    const first = new FrozenPublicChatOperationJournal(dir);
    addAuthorization(first);
    first.records.push(structuredClone(message));
    first.write();
    const path = join(dir, 'public-chat-operations.json');
    const before = fs.readFileSync(path);
    const broken = new Proxy(fs, { get(target, key) {
      if (key === 'renameSync') return () => { throw new Error('fixture rename failed'); };
      return Reflect.get(target, key);
    } }) as typeof fs;
    const journal = new FrozenPublicChatOperationJournal(dir, broken);
    journal.records.push({ ...structuredClone(message), requestId: 'other', sourceKey: 'other' });
    expect(() => journal.write()).toThrow();
    expect(fs.readFileSync(path)).toEqual(before);
  });
});
