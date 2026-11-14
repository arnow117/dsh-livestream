import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FrozenSenderRuntime } from '../../src/publicChat/frozenSenderRuntime';
import { SenderService } from '../../src/publicChat/senderService';
import { SenderClient } from '../../src/publicChat/senderClient';
import { PublicChatSendController } from '../../src/publicChat/controller';
import { FrozenPublicChatOperationJournal, messageReference } from '../../src/publicChat/frozenJournal';
import { controlPayloadHash } from '../../src/publicChat/grantAuthority';
import { messageRefDigest, type MessageRef } from '../../src/publicChat/recoveryFacts';
import type { FrozenGrantProposal } from '../../src/publicChat/frozenGrant';
import type { HelperProcess, HelperReply } from '../../src/publicChat/helperLauncher';

const base = 1_700_000_000_000;

describe('schema4 protected HTTP composition with helper substitute', () => {
  it('requires original recovery before a new explicit authorization and preserves the old unknown', async () => {
    let now = base + 1000;
    let grants = 0;
    let sends = 0;
    const identity = { helperNonce: 'helper', authContextId: 'context', authContextRevision: 1, materialDigest: 'c'.repeat(64) };
    const reply = (kind: string, id: string, payload: unknown, status: string, record: unknown): HelperReply => ({
      protocol: 'dsh-public-chat-http-v1', seq: 1, kind, operationId: id, payloadHash: controlPayloadHash(payload),
      ...identity, status, payload: record,
    });
    const helper = {
      identity, recoveryVerified: true, close: async () => {},
      request: async (kind: string, id: string, payload: unknown, guard?: () => boolean) => {
        if (guard && !guard()) throw new Error('stale');
        if (kind === 'profile') {
          const frame = payload as { qualificationRevision: number; identityEpoch: number };
          return reply(kind, id, payload, 'qualified', { kind: 'profile', state: 'qualified', targetId: id,
            payloadHash: controlPayloadHash(payload), qualification: { captureId: id, digest: 'b'.repeat(64), principalUid: '42',
              revision: frame.qualificationRevision, identityEpoch: frame.identityEpoch, capturedAtMs: now } });
        }
        if (kind === 'bindGrant') {
          const grant = { ...(payload as FrozenGrantProposal), grantId: `grant-${++grants}`, authorizedAtMs: now };
          return reply(kind, id, payload, 'authorized', { kind: 'authorize', state: 'authorized',
            payloadHash: controlPayloadHash(payload), grant });
        }
        if (kind === 'revoke') {
          const frame = payload as { targetId: string };
          return reply(kind, id, payload, 'revoked', { kind: 'revoke', state: 'revoked', targetId: frame.targetId,
            payloadHash: controlPayloadHash(payload) });
        }
        if (kind === 'send') {
          const frame = payload as { requestId: string; sourceKey: string; requestHash: string; grant: unknown; text: string };
          const status = ++sends === 1 ? 'unknown' : 'api_reported_success';
          return reply(kind, id, payload, status, { kind: 'send', state: status, payloadHash: controlPayloadHash(payload),
            message: { requestId: frame.requestId, sourceKey: frame.sourceKey, requestHash: frame.requestHash, grant: frame.grant,
              textDigest: createHash('sha256').update(frame.text).digest('hex'), acceptedAtMs: now, firstWriteAttemptAtMs: now,
              joinedWitnessId: `joined-${sends}`, joinedAtMs: now, writeAttempted: true, executionEnded: true,
              httpStatus: status === 'unknown' ? 500 : 200, responseLength: 17, responseDigest: 'e'.repeat(64) } });
        }
        if (kind === 'reconcileMessage') {
          const frame = payload as { controlId: string; ref: MessageRef; factsRevision: number; factsDigest: string;
            originControlPayloadHash: string };
          const grant = frame.ref.grant;
          const receipt = { version: 'dsh-public-chat-recovery-v1', controlId: frame.controlId, kind: 'message_reconcile',
            originControlPayloadHash: frame.originControlPayloadHash, helperPayloadHash: controlPayloadHash(payload),
            ref: frame.ref, refDigest: messageRefDigest(frame.ref), factsRevision: frame.factsRevision, factsDigest: frame.factsDigest,
            helperNonce: grant.helperProcessNonce, senderProcessNonce: grant.senderProcessNonce, authContextId: grant.authContextId,
            authContextRevision: grant.authContextRevision, materialDigest: grant.materialDigest, joinedWitnessId: 'joined-1',
            acceptedAtMs: base + 1000, firstWriteAttemptAtMs: base + 1000, joinedAtMs: base + 1000,
            writeAttempted: true, recoveryCommitId: 'recovery-1', committedAtMs: now, decision: 'observed_unknown_released' };
          return reply(kind, id, payload, 'committed', { kind: 'message_reconcile', state: 'committed', payloadHash: controlPayloadHash(payload),
            targetId: frame.ref.requestId, reconcile: { request: payload, receipt } });
        }
        throw new Error('unexpected fixture operation');
      },
    } as unknown as HelperProcess;
    let hostController: PublicChatSendController | null = null;
    let matchingRecoveryNotifications = 0;
    const runtime = new FrozenSenderRuntime({ deployment: { buildDigest: 'a'.repeat(64), instanceId: 'instance', accountRecordId: 'record',
      expectedPrincipalUid: '42', roomId: '101' }, decodeRaw: () => ({ common: { roomId: '202', createTime: now } }),
      clock: { wall: () => now, monotonic: () => now }, launch: async () => helper,
      onInvalidated: (context) => {
        if (context && hostController?.ownsPendingRecoveryInvalidation(context.recoveryControlId, context.recoveryPayloadHash)) {
          expect(hostController.ownsPendingRecoveryInvalidation('unrelated-control', context.recoveryPayloadHash)).toBe(false);
          expect(hostController.ownsPendingRecoveryInvalidation(context.recoveryControlId, '0'.repeat(64))).toBe(false);
          matchingRecoveryNotifications++;
          return;
        }
        hostController?.revokeGrant('sender-connection-change');
      } });
    runtime.setInputAndLive(1, 'live', base - 1000);
    const observer = runtime.createRawEvidenceObserver('101', { url: () => 'https://live.douyin.com/101', context: () => ({}) }, {});
    observer.socketCreated('socket', 'wss://webcast100-ws-web-lq.douyin.com/webcast/im/push/v2/?room_id=202');
    observer.rawMessage('socket', { method: 'WebcastChatMessage', msgId: 'raw', payload: new Uint8Array() });
    expect((await runtime.beginAuthenticationMaintenance({ manifestPath: '/fixture', manifestSha256: 'a'.repeat(64),
      sourceDirectory: '/fixture', materialPath: '/fixture', deploymentPath: '/fixture', deploymentSha256: 'a'.repeat(64), dataDirectory: '/fixture' })).ok).toBe(true);
    const service = new SenderService({ runtime, token: 'fixture-token', deployment: { schemaVersion: 1,
      listenUrl: 'http://127.0.0.1:0', token: 'fixture-token', expectedPrincipalUid: '42', roomId: '101', accountRecordId: 'record',
      buildDigest: 'a'.repeat(64), instanceId: 'instance', profileOrigin: 'https://www.douyin.com', dataDir: '/fixture' } });
    const origin = await service.start();
    const port = new URL(origin).port;
    console.info(`owned-http-listener pid=${process.pid} port=${port}`);
    const guardedFetch: typeof fetch = (resource, options) => {
      const url = new URL(resource instanceof Request ? resource.url : String(resource));
      if (url.hostname !== '127.0.0.1' || url.origin !== origin || ['3080', '3081', '7390', '8757'].includes(url.port)) throw new Error('unexpected target');
      return fetch(resource, options);
    };
    const client = new SenderClient({ url: origin, token: 'fixture-token', expected: { buildDigest: 'a'.repeat(64), instanceId: 'instance' },
      clock: { wall: () => now, monotonic: () => now }, fetcher: guardedFetch });
    const dir = fs.mkdtempSync(join(process.env.DSH_HOME!, 'schema4-composition-'));
    try {
      const journal = new FrozenPublicChatOperationJournal(dir);
      const controller = new PublicChatSendController({ deployment: { buildDigest: 'a'.repeat(64), instanceId: 'instance', accountRecordId: 'record',
        expectedPrincipalUid: '42', roomId: '101' }, gateway: client, journal, bounds: { dispatchIntervalMs: 0 },
        clock: { wall: () => now, monotonic: () => now } });
      hostController = controller;
      controller.setLiveEpoch('live', base - 1000);
      controller.advanceInputConnection();
      expect((await controller.refreshQualification()).ok).toBe(true);
      expect((await controller.authorize()).ok).toBe(true);
      expect((await controller.submit({ requestId: 'old-message', sourceKey: 'old-source', text: 'fixture' })).status).toBe('accepted');
      for (let i = 0; i < 100 && controller.frozenOperationView('old-message')?.state !== 'unknown'; i++) await new Promise((resolve) => setTimeout(resolve, 5));
      const original = controller.frozenOperationView('old-message');
      if (!original || original.state !== 'unknown') throw new Error('original unknown missing');
      expect(controller.hold).toBe(true);
      now = base + 1100;
      expect(controller.recordVerificationFact({ requestId: original.requestId, principalUid: '42', roomId: '101', grantId: original.grant.grantId,
        liveEpoch: 'live', inputConnectionGeneration: 1, ref: messageReference(original), factId: 'observation',
        observationSource: { source: 'owner', observerRef: null }, fact: { kind: 'positive_observation', attributionStrength: 'direct',
          observedAtMs: now, textDigest: original.textDigest, principalUid: '42', roomId: '101', platformRoomId: '202' } }).ok).toBe(true);
      const result = await controller.reconcileFrozenMessage('old-message');
      expect(result.ok).toBe(true);
      expect(matchingRecoveryNotifications).toBe(1);
      expect(controller.frozenOperationView('old-message')?.state).toBe('unknown');
      for (let i = 0; i < 100 && controller.hold; i++) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(controller.hold).toBe(false);
      expect((await controller.submit({ requestId: 'old-message', sourceKey: 'old-source', text: 'fixture' })).status).toBe('duplicate');
      expect(sends).toBe(1);
      expect((await controller.refreshQualification()).ok).toBe(true);
      expect((await controller.authorize()).ok).toBe(true);
      expect((await controller.submit({ requestId: 'new-message', sourceKey: 'new-source', text: 'fixture two' })).status).toBe('accepted');
      for (let i = 0; i < 100 && sends !== 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(sends).toBe(2);
    } finally {
      await service.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
