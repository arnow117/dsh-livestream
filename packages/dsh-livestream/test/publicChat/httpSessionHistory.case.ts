import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FrozenPublicChatOperationJournal, type FrozenJournalMessage } from '../../src/publicChat/frozenJournal';
import { PublicChatSendController } from '../../src/publicChat/controller';
import { controlPayloadHash } from '../../src/publicChat/grantAuthority';
import type { FrozenGrantProposal } from '../../src/publicChat/frozenGrant';
import type { SenderClient } from '../../src/publicChat/senderClient';

describe('session mode preserves the original unknown', () => {
  it('holds a legacy unknown across session identity changes and new controller instances', async () => {
    const root = process.env.DSH_HOME;
    if (!root) throw new Error('task-owned fixture root required');
    const dir = mkdtempSync(join(root, 'session-old-unknown-'));
    const proposal: FrozenGrantProposal = { version:'dsh-public-chat-v1', transportKind:'frozen_http', buildDigest:'a'.repeat(64),
      instanceId:'fixture-instance', senderProcessNonce:'old-sender', senderConnectionGeneration:1, authorizationId:'old-auth',
      captureId:'old-capture', qualificationDigest:'b'.repeat(64), qualificationRevision:1, identityEpoch:1,
      accountRecordId:'fixture-account', principalUid:'42', roomId:'12345', platformRoomId:'987654321',
      helperProcessNonce:'old-helper', authContextId:'old-context', authContextRevision:1, materialDigest:'c'.repeat(64),
      rawSourceSessionId:'old-raw', rawSourceConnectionGeneration:1, rawBrowserContextId:'old-browser',
      roomBindingProofDigest:'d'.repeat(64), inputConnectionGeneration:1, liveEpoch:'old-live', liveEpochStartedAtMs:1000 };
    const grant = { ...proposal, grantId:'old-grant', authorizedAtMs:1200 };
    const message: FrozenJournalMessage = { requestId:'old-request', sourceKey:'old-source', senderProcessNonce:'old-sender', grant,
      requestHash:'e'.repeat(64), helperPayloadHash:'f'.repeat(64), textDigest:createHash('sha256').update('synthetic').digest('hex'),
      autoEvent:null, state:'unknown', executionEnded:false, writeAttempted:false, httpResponse:null, createdAtMs:1300,
      facts:[], factsRevision:0, factsDigest:controlPayloadHash([]), conflicts:[], terminalEvidence:null,
      recovery:{ state:'blocked', factsRevision:0, factsDigest:controlPayloadHash([]), controlId:null, receipt:null } };
    const journal = new FrozenPublicChatOperationJournal(dir);
    journal.controls.push({ kind:'authorize', id:'old-auth', payloadHash:'a'.repeat(64), senderProcessNonce:'old-sender',
      target:proposal, qualificationTokenDigest:'b'.repeat(64), localRevision:'old-revision', state:'active', grant,
      ack:{ kind:'authorize', id:'old-auth', payloadHash:'a'.repeat(64), helperPayloadHash:controlPayloadHash(proposal),
        senderProcessNonce:'old-sender', state:'authorized', target:proposal, grant } });
    journal.records.push(message);
    journal.write();
    const path = join(dir, 'public-chat-operations.json');
    const before = readFileSync(path);
    let calls = 0;
    const gateway = new Proxy({}, { get: () => async () => { calls++; return { ok:false, error:'fixture unavailable', untrusted:false }; } }) as SenderClient;
    const deployment = { buildDigest:'a'.repeat(64), instanceId:'fixture-instance', accountRecordId:'fixture-account', roomId:'12345',
      transportKind:'session_http' as const, expectedPrincipalUid:null as string | null };
    for (const uid of [null, '18446744073709551615', '43']) {
      deployment.expectedPrincipalUid = uid;
      const reopened = new FrozenPublicChatOperationJournal(dir);
      expect(reopened.corrupt).toBe(false);
      const controller = new PublicChatSendController({ deployment, gateway, journal:reopened });
      expect(controller.hold).toBe(true);
      expect((await controller.refreshQualification()).ok).toBe(false);
      expect((await controller.submit({ requestId:'new-request', sourceKey:'new-source', text:'synthetic' })).status).toBe('rejected');
      expect((await controller.submit({ requestId:'old-request', sourceKey:'old-source', text:'synthetic' })).status).toBe('duplicate');
      expect(readFileSync(path)).toEqual(before);
    }
    expect(calls).toBe(0);
  });
});
