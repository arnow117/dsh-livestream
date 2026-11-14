import { createHash } from 'node:crypto';
import { controlPayloadHash } from '../../src/publicChat/grantAuthority';
import type { FrozenGrantProposal } from '../../src/publicChat/frozenGrant';
import type { HelperProcess, HelperReply } from '../../src/publicChat/helperLauncher';

/** In-memory helper substitute for HTTP routing tests; never evidence for OS/TLS composition. */
export function makeFrozenTestHelper(principalUid: string) {
  const identity = { helperNonce: 'helper', authContextId: 'context', authContextRevision: 1, materialDigest: 'c'.repeat(64) };
  const calls: string[] = [];
  let profileAvailable = true;
  const records = new Map<string, HelperReply>();
  const reply = (kind: string, id: string, payload: unknown, status: string, record: unknown): HelperReply => ({
    protocol: 'dsh-public-chat-http-v1', seq: 1, kind, operationId: id, payloadHash: controlPayloadHash(payload),
    ...identity, status, payload: record,
  });
  const helper = {
    identity,
    recoveryVerified: true,
    close: async () => {},
    request: async (kind: string, id: string, payload: unknown, guard?: () => boolean) => {
      if (guard && !guard()) throw new Error('stale');
      calls.push(kind);
      if (kind === 'profile') {
        const input = payload as { qualificationRevision: number; identityEpoch: number };
        if (!profileAvailable) return reply(kind, id, payload, 'rejected', { kind: 'profile', state: 'rejected',
          targetId: id, payloadHash: controlPayloadHash(payload) });
        return reply(kind, id, payload, 'qualified', { kind: 'profile', state: 'qualified', targetId: id,
          payloadHash: controlPayloadHash(payload), qualification: { captureId: id, digest: 'b'.repeat(64), principalUid,
            revision: input.qualificationRevision, identityEpoch: input.identityEpoch, capturedAtMs: Date.now() } });
      }
      if (kind === 'bindGrant') {
        const target = payload as FrozenGrantProposal;
        return reply(kind, id, payload, 'authorized', { kind: 'authorize', state: 'authorized',
          payloadHash: controlPayloadHash(payload), grant: { ...target, grantId: `grant-${id}`, authorizedAtMs: Date.now() } });
      }
      if (kind === 'revoke') {
        const input = payload as { targetId: string };
        return reply(kind, id, payload, 'revoked', { kind: 'revoke', state: 'revoked',
          targetId: input.targetId, payloadHash: controlPayloadHash(payload) });
      }
      if (kind === 'send') {
        const previous = records.get(id);
        if (previous) return previous;
        const input = payload as { requestId: string; sourceKey: string; requestHash: string; text: string; grant: unknown };
        const now = Date.now();
        const result = reply(kind, id, payload, 'api_reported_success', { kind: 'send', state: 'api_reported_success',
          payloadHash: controlPayloadHash(payload), message: { requestId: input.requestId, sourceKey: input.sourceKey,
            requestHash: input.requestHash, grant: input.grant, textDigest: createHash('sha256').update(input.text).digest('hex'),
            acceptedAtMs: now, firstWriteAttemptAtMs: now, joinedWitnessId: 'fixture-joined', joinedAtMs: now,
            writeAttempted: true, executionEnded: true, httpStatus: 200, responseLength: 17, responseDigest: 'e'.repeat(64) } });
        records.set(id, result);
        return result;
      }
      if (kind === 'query') return reply(kind, id, payload, 'not_found', null);
      throw new Error('unexpected helper operation');
    },
  } as unknown as HelperProcess;
  return { helper, calls, rejectProfile: () => { profileAvailable = false; } };
}
