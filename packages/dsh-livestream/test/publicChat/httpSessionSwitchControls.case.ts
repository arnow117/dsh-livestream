import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FrozenPublicChatOperationJournal } from '../../src/publicChat/frozenJournal';
import { PublicChatSendController, type ControllerDeps } from '../../src/publicChat/controller';
import { controlPayloadHash } from '../../src/publicChat/grantAuthority';
import type { FrozenGrantProposal } from '../../src/publicChat/frozenGrant';
import { FROZEN_TEST_DEPLOYMENT, makeFrozenTestGateway } from './frozenTestGateway';
import { TEST_LIVE_EPOCH, TEST_PRINCIPAL_UID, waitFor } from './test-helpers';

describe('session historical control after account change', () => {
  it('rejects qualification when the new session reports the wrong UID', async () => {
    const root = process.env.DSH_HOME;
    if (!root) throw new Error('task-owned fixture required');
    const journal = new FrozenPublicChatOperationJournal(mkdtempSync(join(root, 'session-wrong-uid-')));
    const startedAt = Date.now() - 1000;
    const fixture = makeFrozenTestGateway(startedAt);
    const deployment = { ...FROZEN_TEST_DEPLOYMENT, expectedPrincipalUid: '43', transportKind: 'session_http' as const };
    const controller = new PublicChatSendController({ deployment, gateway: fixture.gateway, journal });
    controller.advanceInputConnection();
    controller.setLiveEpoch(TEST_LIVE_EPOCH, startedAt);
    expect(await controller.refreshQualification()).toMatchObject({ ok: false, reason: 'identity-unverified' });
    expect((await controller.authorize()).ok).toBe(false);
    expect(fixture.calls.authorizations).toHaveLength(0);
  });

  it('allows B to qualify and authorize after A was completely revoked and adopted', async () => {
    const root = process.env.DSH_HOME;
    if (!root) throw new Error('task-owned fixture required');
    const dir = mkdtempSync(join(root, 'session-switch-flow-'));
    const journal = new FrozenPublicChatOperationJournal(dir);
    const startedAt = Date.now() - 1000;
    const fixture = makeFrozenTestGateway(startedAt);
    const deployment = { ...FROZEN_TEST_DEPLOYMENT, transportKind: 'session_http' as const };
    const capture = fixture.gateway.frozenCapture.bind(fixture.gateway);
    fixture.gateway.frozenCapture = async (...args) => {
      const result = await capture(...args);
      if (result.ok && result.value.record.qualification) result.value.record.qualification.principalUid = deployment.expectedPrincipalUid;
      return result;
    };
    const controller = new PublicChatSendController({ deployment, gateway: fixture.gateway, journal });
    controller.advanceInputConnection();
    controller.setLiveEpoch(TEST_LIVE_EPOCH, startedAt);
    expect((await controller.refreshQualification()).ok).toBe(true);
    expect((await controller.authorize()).ok).toBe(true);
    expect(fixture.calls.authorizations[0].target.principalUid).toBe(TEST_PRINCIPAL_UID);
    controller.revokeGrant('owner-revoke');
    await waitFor(() => journal.controls.filter((entry) => entry.kind === 'revoke' && entry.state === 'revoked').length === 2);
    expect(controller.hold).toBe(false);
    const original = structuredClone(journal.controls);
    deployment.expectedPrincipalUid = '43';
    expect(controller.hold).toBe(false);
    expect((await controller.refreshQualification()).ok).toBe(true);
    expect((await controller.authorize()).ok).toBe(true);
    expect(fixture.calls.authorizations[1].target.principalUid).toBe('43');
    expect(journal.controls.slice(0, original.length)).toEqual(original);
    expect(fixture.calls.sends).toHaveLength(0);
  });

  it.each(['session_http', 'frozen_http'] as const)('retains original ACK and only session mode may use a new UID: %s', async (mode) => {
    const root = process.env.DSH_HOME;
    if (!root) throw new Error('task-owned fixture required');
    const dir = mkdtempSync(join(root, 'session-switch-'));
    const journal = new FrozenPublicChatOperationJournal(dir);
    const proposal: FrozenGrantProposal = { version: 'dsh-public-chat-v1', transportKind: mode, buildDigest: 'a'.repeat(64),
      instanceId: 'instance', senderProcessNonce: 'sender', senderConnectionGeneration: 1, authorizationId: 'authorization',
      captureId: 'capture', qualificationDigest: 'b'.repeat(64), qualificationRevision: 1, identityEpoch: 1,
      accountRecordId: 'record', principalUid: '42', roomId: '101', platformRoomId: '202', helperProcessNonce: 'helper',
      authContextId: 'context', authContextRevision: 1, materialDigest: 'c'.repeat(64), rawSourceSessionId: 'raw-session',
      rawSourceConnectionGeneration: 1, rawBrowserContextId: 'raw-context', roomBindingProofDigest: 'd'.repeat(64),
      inputConnectionGeneration: 1, liveEpoch: 'live', liveEpochStartedAtMs: 1000 };
    const grant = { ...proposal, grantId: 'grant', authorizedAtMs: 1200 };
    const target = { kind: 'authorization' as const, authorizationId: 'authorization', grantId: 'grant' };
    const revokeHash = controlPayloadHash({ revokeId: 'revoke', expectedSenderProcessNonce: 'sender', target });
    const ack = { kind: 'revoke' as const, id: 'revoke', payloadHash: revokeHash, senderProcessNonce: 'sender',
      helperPayloadHash: controlPayloadHash({ id: 'revoke', helperNonce: 'helper', kind: 'authorization', targetId: 'authorization', grantId: 'grant' }),
      state: 'revoked' as const, target };
    journal.controls.push({ kind: 'authorize', id: 'authorization', payloadHash: 'e'.repeat(64), senderProcessNonce: 'sender',
      target: proposal, qualificationTokenDigest: 'f'.repeat(64), localRevision: 'revision', state: 'revoked', grant, ack });
    journal.controls.push({ kind: 'revoke', id: 'revoke', payloadHash: revokeHash, senderProcessNonce: 'sender', target, state: 'revoked', ack });
    journal.write();
    const path = join(dir, 'public-chat-operations.json');
    const before = readFileSync(path);
    const deployment = { buildDigest: 'a'.repeat(64), instanceId: 'instance', accountRecordId: 'record', roomId: '101',
      expectedPrincipalUid: '42', transportKind: mode };
    const gateway = new Proxy({}, { get: () => async () => ({ ok: false }) }) as ControllerDeps['gateway'];
    const controller = new PublicChatSendController({ deployment, gateway, journal });
    expect((await controller.reconcileControl('authorization')).ok).toBe(true);
    expect((await controller.reconcileControl('revoke')).ok).toBe(true);
    expect(controller.hold).toBe(false);
    deployment.expectedPrincipalUid = '43';
    expect(controller.hold).toBe(mode !== 'session_http');
    expect(readFileSync(path)).toEqual(before);
    const altered = journal.controls[1];
    if (altered.kind !== 'revoke' || !altered.ack) throw new Error('fixture revoke missing');
    altered.state = 'revoking_unknown';
    expect(controller.hold).toBe(true);
    altered.state = 'revoked';
    altered.ack = { ...altered.ack, helperPayloadHash: '0'.repeat(64) };
    expect(controller.hold).toBe(true);
  });
});
