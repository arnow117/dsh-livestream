import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { FrozenSenderRuntime } from '../../src/publicChat/frozenSenderRuntime';
import { SenderService } from '../../src/publicChat/senderService';
import { SenderClient } from '../../src/publicChat/senderClient';
import { PublicChatSendController } from '../../src/publicChat/controller';
import { FrozenPublicChatOperationJournal } from '../../src/publicChat/frozenJournal';
import { registerSourceEventMetadata } from '../../src/publicChat/eventRef';
import { controlPayloadHash } from '../../src/publicChat/grantAuthority';
import type { FrozenGrantProposal } from '../../src/publicChat/frozenGrant';
import { HelperShutdownUnconfirmedError, type HelperLaunchOptions, type HelperProcess, type HelperReply } from '../../src/publicChat/helperLauncher';

const base = 1_700_000_000_000;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

describe('frozen sender runtime candidate', () => {
  it('does not start a replacement if the previous helper shutdown was not confirmed', async () => {
    let launches = 0;
    const runtime = new FrozenSenderRuntime({ deployment: { buildDigest: 'a'.repeat(64), instanceId: 'instance',
      accountRecordId: 'record', expectedPrincipalUid: '42', roomId: '101' }, decodeRaw: () => null,
      launch: async () => { launches++; throw new HelperShutdownUnconfirmedError(); } });
    const settings = { manifestPath: '/fixture', manifestSha256: 'a'.repeat(64), sourceDirectory: '/fixture',
      materialPath: '/fixture', deploymentPath: '/fixture', deploymentSha256: 'a'.repeat(64), dataDirectory: '/fixture' };
    expect((await runtime.beginAuthenticationMaintenance(settings)).ok).toBe(false);
    expect(runtime.state().hold).toBe(true);
    expect((await runtime.beginAuthenticationMaintenance(settings)).ok).toBe(false);
    expect(launches).toBe(1);
  });

  it('does not upgrade pre-grant raw, and rejects old grants after revoke', async () => {
    let now = base + 500;
    let sends = 0;
    const grantAck = deferred<HelperReply>();
    const bindEntered = deferred<void>();
    let bindPayload: unknown;
    const identity = { helperNonce: 'helper', authContextId: 'context', authContextRevision: 1, materialDigest: 'c'.repeat(64) };
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
        if (kind === 'profile') {
          const frame = payload as { qualificationRevision: number; identityEpoch: number };
          return reply(kind, id, payload, 'qualified', { kind: 'profile', state: 'qualified', targetId: id,
            payloadHash: controlPayloadHash(payload), qualification: { captureId: id, digest: 'b'.repeat(64), principalUid: '42',
              revision: frame.qualificationRevision, identityEpoch: frame.identityEpoch, capturedAtMs: base + 400 } });
        }
        if (kind === 'bindGrant') { bindPayload = payload; bindEntered.resolve(); return grantAck.promise; }
        if (kind === 'revoke') {
          const frame = payload as { targetId: string };
          return reply(kind, id, payload, 'revoked', { kind: 'revoke', state: 'revoked', targetId: frame.targetId, payloadHash: controlPayloadHash(payload) });
        }
        if (kind === 'send') {
          sends++;
          const frame = payload as { requestId: string; sourceKey: string; requestHash: string; grant: unknown; text: string };
          return reply(kind, id, payload, 'api_reported_success', { kind: 'send', state: 'api_reported_success',
            payloadHash: controlPayloadHash(payload), message: { requestId: frame.requestId, sourceKey: frame.sourceKey,
              grant: frame.grant, requestHash: frame.requestHash, textDigest: createHash('sha256').update(frame.text).digest('hex'),
              acceptedAtMs: now, firstWriteAttemptAtMs: now, joinedWitnessId: 'joined', joinedAtMs: now,
              writeAttempted: true, executionEnded: true,
              httpStatus: 200, responseLength: 17, responseDigest: 'e'.repeat(64) } });
        }
        throw new Error('unexpected helper operation');
      },
    } as unknown as HelperProcess;
    const launch = (async (_options: HelperLaunchOptions) => helper) as typeof import('../../src/publicChat/helperLauncher').launchHelper;
    const runtime = new FrozenSenderRuntime({ deployment: { buildDigest: 'a'.repeat(64), instanceId: 'instance', accountRecordId: 'record',
      expectedPrincipalUid: '42', roomId: '101' }, decodeRaw: (raw) => ({ common: { roomId: '202', createTime: raw.msgId === 'old' ? base + 450 : base + 900 } }),
      clock: { wall: () => now, monotonic: () => now }, launch });
    runtime.setInputAndLive(1, 'live', base - 1000);
    const context = {};
    const observer = runtime.createRawEvidenceObserver('101', { url: () => 'https://live.douyin.com/101', context: () => context }, {});
    observer.socketCreated('socket', 'wss://webcast100-ws-web-lq.douyin.com/webcast/im/push/v2/?room_id=202');
    observer.rawMessage('socket', { method: 'WebcastChatMessage', msgId: 'old', payload: new Uint8Array() });
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
      if (url.hostname !== '127.0.0.1' || url.origin !== origin || ['3080', '3081', '7390', '8757'].includes(url.port)) throw new Error('unexpected network target');
      return fetch(resource, options);
    };
    const client = new SenderClient({ url: origin, token: 'fixture-token', expected: { buildDigest: 'a'.repeat(64), instanceId: 'instance' },
      clock: { wall: () => now, monotonic: () => now }, fetcher: guardedFetch });
    const dataDir = fs.mkdtempSync(join(process.env.DSH_HOME!, 'frozen-controller-'));
    try {
    const journal = new FrozenPublicChatOperationJournal(dataDir);
    const controller = new PublicChatSendController({ deployment: { buildDigest: 'a'.repeat(64), instanceId: 'instance',
      accountRecordId: 'record', expectedPrincipalUid: '42', roomId: '101' }, gateway: client, journal,
      clock: { wall: () => now, monotonic: () => now } });
    controller.setLiveEpoch('live', base - 1000);
    const inputToken = controller.advanceInputConnection();
    expect((await controller.refreshQualification()).ok).toBe(true);
    const stateReply = await client.frozenState();
    if (!stateReply.ok) throw new Error('fixture state HTTP failed');
    const state = stateReply.value;
    if (!state.raw?.proof || !state.helper) throw new Error('fixture raw proof missing');
    const pending = controller.authorize();
    await bindEntered.promise;
    const proposal = bindPayload as FrozenGrantProposal;
    const grant = { ...proposal, grantId: 'grant', authorizedAtMs: base + 600 };
    expect((await client.frozenSend({ requestId: 'before-ack', sourceKey: 'before-ack', grant, text: 'fixture', autoEvent: null })).ok).toBe(false);
    now = base + 1000;
    grantAck.resolve(reply('bindGrant', proposal.authorizationId, bindPayload, 'authorized', { kind: 'authorize', state: 'authorized',
      payloadHash: controlPayloadHash(bindPayload), grant }));
    expect((await pending).ok).toBe(true);
    observer.rawMessage('socket', { method: 'WebcastChatMessage', msgId: 'old', payload: new Uint8Array() });
    expect((await client.frozenSend({ requestId: 'old', sourceKey: 'old', grant, text: 'fixture',
      autoEvent: { rawId: 'old', rawType: 'WebcastChatMessage' } })).ok).toBe(false);
    observer.rawMessage('socket', { method: 'WebcastChatMessage', msgId: 'current', payload: new Uint8Array() });
    const event = {};
    registerSourceEventMetadata(event, { rawId: 'current', rawType: 'WebcastChatMessage', rawFrameTsUntrusted: null,
      receivedAt: now, sourceConnectionToken: inputToken, roomId: '101', liveEpoch: 'live' });
    const sent = await controller.submit({ requestId: 'current', sourceKey: null, text: 'fixture',
      autoEvent: { event, rawId: 'current', rawType: 'WebcastChatMessage' } });
    expect(sent.status).toBe('accepted');
    for (let i = 0; i < 100 && controller.frozenOperationView('current')?.state !== 'api_reported_success'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(controller.frozenOperationView('current')?.state).toBe('api_reported_success');
    expect(sends).toBe(1);
    controller.revokeGrant('owner-revoke');
    for (let i = 0; i < 100 && runtime.state().activeAuthorizationId !== null; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect((await client.frozenSend({ requestId: 'after', sourceKey: 'after', grant, text: 'fixture', autoEvent: null })).ok).toBe(false);
    expect(sends).toBe(1);
    } finally {
      await service.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
