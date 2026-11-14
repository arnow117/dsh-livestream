import { createHash } from 'node:crypto';
import { controlPayloadHash } from '../../src/publicChat/grantAuthority';
import type { FrozenAuthorizationRequest, FrozenRevokeRequest } from '../../src/publicChat/frozenControl';
import type { FrozenSendInput, RuntimeOperation } from '../../src/publicChat/frozenSenderRuntime';
import type { SenderClient } from '../../src/publicChat/senderClient';
import { TEST_ACCOUNT_RECORD_ID, TEST_BUILD_DIGEST, TEST_INSTANCE_ID, TEST_LIVE_EPOCH, TEST_PRINCIPAL_UID,
  TEST_ROOM_ID, TEST_SENDER_NONCE } from './test-helpers';

export const FROZEN_TEST_DEPLOYMENT = { buildDigest: TEST_BUILD_DIGEST, instanceId: TEST_INSTANCE_ID,
  accountRecordId: TEST_ACCOUNT_RECORD_ID, expectedPrincipalUid: TEST_PRINCIPAL_UID, roomId: TEST_ROOM_ID };

export function makeFrozenTestGateway(startedAtMs: number) {
  const helper = { helperNonce: 'helper', authContextId: 'context', authContextRevision: 1, materialDigest: 'a'.repeat(64) };
  const raw = { sessionId: 'session', contextId: 'raw-context', generation: 1,
    proof: { webRoomId: TEST_ROOM_ID, platformRoomId: '202', liveEpoch: TEST_LIVE_EPOCH, digest: 'b'.repeat(64) } };
  const state = { buildDigest: TEST_BUILD_DIGEST, instanceId: TEST_INSTANCE_ID, processNonce: TEST_SENDER_NONCE,
    senderConnectionGeneration: 4, hold: false, helper, raw };
  const calls: { sends: FrozenSendInput[]; authorizations: FrozenAuthorizationRequest[]; revocations: FrozenRevokeRequest[] } =
    { sends: [], authorizations: [], revocations: [] };
  let produce: (request: FrozenSendInput) => Promise<{ ok: true; value: RuntimeOperation } | { ok: false; error: string; untrusted: boolean }> =
    async (request) => ({ ok: true, value: successfulOperation(request) });
  const gateway = {
    frozenState: async () => ({ ok: true as const, value: state }),
    frozenCapture: async (captureId: string) => ({ ok: true as const, value: {
      senderConnectionGeneration: 4, helper, raw,
      record: { state: 'qualified', qualification: { captureId, qualificationToken: 'fixture-qualification',
        qualificationDigest: 'c'.repeat(64), qualificationRevision: 1, identityEpoch: 1,
        principalUid: TEST_PRINCIPAL_UID, capturedAtMs: Math.max(startedAtMs, Date.now()) } },
    } }),
    frozenAuthorize: async (request: FrozenAuthorizationRequest) => {
      calls.authorizations.push(request);
      return { ok: true as const, value: { kind: 'authorize', id: request.authorizationId,
        senderProcessNonce: request.expectedSenderProcessNonce, payloadHash: controlPayloadHash(request),
        helperPayloadHash: controlPayloadHash(request.target), state: 'authorized', target: request.target,
        grant: { ...request.target, grantId: 'fixture-grant', authorizedAtMs: Date.now() } } };
    },
    frozenRevoke: async (request: FrozenRevokeRequest) => {
      calls.revocations.push(request);
      const targetId = request.target.kind === 'authorization' ? request.target.authorizationId : request.target.captureId;
      const grantId = request.target.kind === 'authorization' ? request.target.grantId ?? request.target.snapshot?.grantId : undefined;
      const helperPayload = { id: request.revokeId, helperNonce: helper.helperNonce, kind: request.target.kind, targetId,
        ...(grantId === undefined ? {} : { grantId }) };
      return { ok: true as const, value: { kind: 'revoke', id: request.revokeId,
        senderProcessNonce: request.expectedSenderProcessNonce, payloadHash: controlPayloadHash(request),
        helperPayloadHash: controlPayloadHash(helperPayload), state: 'revoked', target: request.target } };
    },
    frozenControlOperation: async () => ({ ok: false as const, error: 'not found', untrusted: true }),
    frozenSend: async (request: FrozenSendInput) => { calls.sends.push(request); return produce(request); },
    frozenOperation: async () => ({ ok: false as const, error: 'not found', untrusted: true }),
    frozenReconcileMessage: async () => ({ ok: false as const, error: 'not found', untrusted: true }),
    frozenRecoveryOperation: async () => ({ ok: false as const, error: 'not found', untrusted: true }),
  };
  return { gateway: gateway as unknown as SenderClient, calls,
    setSend: (handler: typeof produce) => { produce = handler; }, state };
}

export function successfulOperation(request: FrozenSendInput): RuntimeOperation {
  const hash = controlPayloadHash(request);
  const helperPayload = { requestId: request.requestId, sourceKey: request.sourceKey, requestHash: hash,
    sourceKind: request.autoEvent ? 'auto' : 'manual', grant: request.grant, text: request.text };
  const at = Math.max(Date.now(), request.grant.authorizedAtMs);
  return { requestId: request.requestId, sourceKey: request.sourceKey, hash, helperPayloadHash: controlPayloadHash(helperPayload),
    textDigest: createHash('sha256').update(request.text, 'utf8').digest('hex'), grant: request.grant,
    state: 'api_reported_success', executionEnded: true, writeAttempted: true, acceptedAtMs: at,
    firstWriteAttemptAtMs: at, joinedWitnessId: 'fixture-joined', joinedAtMs: at,
    factsRevision: 0, factsDigest: controlPayloadHash([]), recoveryControlId: null, recoveryReceipt: null,
    httpResponse: { version: 'dsh-public-chat-http-response-v1', status: 200, length: 17, digest: 'e'.repeat(64) } };
}
