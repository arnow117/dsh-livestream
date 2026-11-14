import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PublicChatSendController, type ControllerDeps } from '../../src/publicChat/controller';
import { FrozenPublicChatOperationJournal, type FrozenJournalMessage } from '../../src/publicChat/frozenJournal';
import { controlPayloadHash } from '../../src/publicChat/grantAuthority';
import { PublicChatOwnerActions } from '../../src/publicChat/ownerActions';

describe('owner observation actions', () => {
  it('records only schema4 facts on the original message and never accepts termination claims', () => {
    const home = process.env.DSH_HOME;
    if (!home) throw new Error('task-local DSH_HOME required');
    const dir = mkdtempSync(join(home, 'owner-facts-'));
    try {
      const journal = new FrozenPublicChatOperationJournal(dir);
      const grant = { version: 'dsh-public-chat-v1', transportKind: 'frozen_http', buildDigest: 'a'.repeat(64), instanceId: 'instance',
        senderProcessNonce: 'sender', senderConnectionGeneration: 1, authorizationId: 'authorization', captureId: 'capture',
        qualificationDigest: 'b'.repeat(64), qualificationRevision: 1, identityEpoch: 1, accountRecordId: 'record',
        principalUid: '42', roomId: '101', platformRoomId: '202', helperProcessNonce: 'helper', authContextId: 'context',
        authContextRevision: 1, materialDigest: 'c'.repeat(64), rawSourceSessionId: 'raw-session', rawSourceConnectionGeneration: 1,
        rawBrowserContextId: 'raw-context', roomBindingProofDigest: 'd'.repeat(64), inputConnectionGeneration: 1,
        liveEpoch: 'live', liveEpochStartedAtMs: 1000, grantId: 'grant', authorizedAtMs: 1200 };
      const { grantId, authorizedAtMs, ...target } = grant;
      journal.controls.push({ kind: 'authorize', id: 'authorization', payloadHash: 'a'.repeat(64), senderProcessNonce: 'sender',
        target: target as any, qualificationTokenDigest: 'b'.repeat(64), localRevision: 'revision', state: 'authorizing_unknown',
        grant: grant as any, ack: null });
      journal.records.push({ requestId: 'message', sourceKey: 'source', senderProcessNonce: 'sender', grant,
        requestHash: 'e'.repeat(64), helperPayloadHash: 'f'.repeat(64), textDigest: '1'.repeat(64), autoEvent: null,
        state: 'unknown', executionEnded: false, writeAttempted: true, httpResponse: null, createdAtMs: 1300,
        facts: [], factsRevision: 0, factsDigest: controlPayloadHash([]), conflicts: [], terminalEvidence: null,
        recovery: { state: 'blocked', factsRevision: 0, factsDigest: controlPayloadHash([]), controlId: null, receipt: null } } as FrozenJournalMessage);
      const unavailable = async () => ({ ok: false });
      const gateway = { frozenState: unavailable, frozenCapture: unavailable, frozenAuthorize: unavailable,
        frozenRevoke: unavailable, frozenControlOperation: unavailable, frozenSend: unavailable,
        frozenOperation: unavailable, frozenReconcileMessage: unavailable, frozenRecoveryOperation: unavailable };
      const controller = new PublicChatSendController({ deployment: { buildDigest: 'a'.repeat(64), instanceId: 'instance',
        accountRecordId: 'record', expectedPrincipalUid: '42', roomId: '101' }, gateway: gateway as unknown as ControllerDeps['gateway'],
        journal, clock: { wall: () => 1500, monotonic: () => 1500 } });
      const actions = new PublicChatOwnerActions(controller, () => true);
      const input = { requestId: 'message', fact: { kind: 'note', note: '没有看到' } };
      const first = actions.recordFact(input);
      expect(first, JSON.stringify(first)).toMatchObject({ ok: true, duplicate: false, factsRevision: 1 });
      expect(actions.recordFact(input)).toMatchObject({ ok: true, duplicate: true, factsRevision: 1 });
      expect(actions.recordFact({ requestId: 'message', fact: { kind: 'termination_proof', executionEnded: true } }).ok).toBe(false);
      expect(actions.recordFact({ requestId: 'message', fact: { kind: 'note', note: 'x' }, safeToResume: true }).ok).toBe(false);
      expect(actions.view().hold).toBe(true);
      expect(actions.view().messages[0].state).toBe('unknown');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
