/**
 * publicChat 离线 case 共享测试辅助（不由默认 runner 发现；仅被 *.case.ts 引入）。
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PUBLIC_CHAT_PROTOCOL, type SenderStateWire, type QualificationWire, type SendRequestWire, type SendResponseWire, type SenderOperationWire } from '../../src/publicChat/protocol';
import type { SenderGateway } from '../../src/publicChat/controller';
import { controlPayloadHash, type GrantSnapshot } from '../../src/publicChat/grantAuthority';

export const TEST_PRINCIPAL_UID = '4400889900112233445';
export const TEST_OTHER_PRINCIPAL_UID = '9988776655443322110';
export const TEST_ROOM_ID = '708764876300';
export const TEST_BUILD_DIGEST = 'ab'.repeat(32);
export const TEST_INSTANCE_ID = 'instance-under-test';
export const TEST_ACCOUNT_RECORD_ID = 'local-account-record-1';
export const TEST_LIVE_EPOCH = 'epoch-20261113-1';
export const TEST_COOKIE_DIGEST = 'cd'.repeat(32);
/** sender 签发的资格令牌（grantId 语义，F4）。 */
export const TEST_QUALIFICATION_TOKEN = 'qtoken-0123456789abcdef';
export const TEST_SENDER_NONCE = 'sender-nonce-1';
export const TEST_SENDER_CONNECTION_GENERATION = 4;
export const TEST_IDENTITY_EPOCH = 7;

export function testGrantSnapshot(overrides: Partial<GrantSnapshot> = {}): GrantSnapshot {
  return {
    version: PUBLIC_CHAT_PROTOCOL, buildDigest: TEST_BUILD_DIGEST, instanceId: TEST_INSTANCE_ID,
    senderProcessNonce: TEST_SENDER_NONCE, captureId: 'capture-fixture', qualificationDigest: 'e'.repeat(64),
    qualificationRevision: 3, accountRecordId: TEST_ACCOUNT_RECORD_ID, principalUid: TEST_PRINCIPAL_UID,
    roomId: TEST_ROOM_ID, browserContextId: 'ctx-1', senderSessionId: 'session-1', senderConnectionGeneration: 4,
    identityEpoch: 3, authCookieGeneration: 3, liveEpoch: TEST_LIVE_EPOCH, liveEpochStartedAtMs: 500,
    inputConnectionGeneration: 1, authorizationId: 'auth-fixture', grantId: 'grant-1', authorizedAtMs: 600,
    ...overrides,
  };
}

export interface TempDirHandle {
  directory: string;
  cleanup(): void;
}

export function makeTempDir(prefix: string): TempDirHandle {
  const directory = mkdtempSync(join(tmpdir(), `${prefix}-`));
  return { directory, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

export interface FakeGatewayCalls {
  stateCount: number;
  qualificationCount: number;
  revokeReasons: string[];
  sends: SendRequestWire[];
}

export interface FakeGatewayOptions {
  state?: Partial<SenderStateWire>;
  qualification?: QualificationWire;
  sendResults: ((request: SendRequestWire) => SendResponseWire | { ok: false; error: string; untrusted: boolean } | Promise<SendResponseWire>)[];
  stateResults?: ({ ok: true; value: SenderStateWire } | { ok: false; error: string; untrusted: boolean })[];
}

export function makeFakeGateway(options: FakeGatewayOptions): SenderGateway & { calls: FakeGatewayCalls } {
  const calls: FakeGatewayCalls = { stateCount: 0, qualificationCount: 0, revokeReasons: [], sends: [] };
  let sendIndex = 0;
  let stateIndex = 0;
  const sendOutcomes = new Map<string, SendResponseWire>();
  const baseState: SenderStateWire = {
    protocol: PUBLIC_CHAT_PROTOCOL,
    buildDigest: TEST_BUILD_DIGEST,
    instanceId: TEST_INSTANCE_ID,
    processNonce: TEST_SENDER_NONCE,
    senderConnectionGeneration: TEST_SENDER_CONNECTION_GENERATION,
    capabilities: ['explicit-grant-snapshot-v1'],
    activeAuthorizationId: null,
    session: { sessionId: 'session-1', roomId: TEST_ROOM_ID, connected: true },
    // 默认与 fake qualification（TEST_QUALIFICATION_TOKEN）一致：预派发
    // 核对（F1）要求 state 里的资格 token 与 grant 快照相同。
    qualification: {
      state: 'captured',
      capturedAt: Date.now(),
      principalUid: TEST_PRINCIPAL_UID,
      qualificationToken: TEST_QUALIFICATION_TOKEN,
    },
    hold: false,
    ...options.state,
  };
  return {
    calls,
    async state() {
      calls.stateCount += 1;
      const result = calls.stateCount === 1 ? undefined : options.stateResults?.[stateIndex++];
      if (result !== undefined) return result.ok ? { ok: true as const, value: { ...baseState, ...result.value } } : result;
      return { ok: true as const, value: { ...baseState } };
    },
    async qualification() {
      calls.qualificationCount += 1;
      const wire = options.qualification ?? {
        qualified: true as const,
        principalUid: TEST_PRINCIPAL_UID,
        contextId: 'ctx-1',
        sessionId: 'session-1',
        authCookieDigest: TEST_COOKIE_DIGEST,
        authCookieGeneration: 3,
        capturedAt: Date.now(),
        profileOrigin: 'https://www.douyin.com',
        profileStatus: 200,
        qualificationToken: TEST_QUALIFICATION_TOKEN,
        identityEpoch: TEST_IDENTITY_EPOCH,
        senderProcessNonce: TEST_SENDER_NONCE,
        senderConnectionGeneration: TEST_SENDER_CONNECTION_GENERATION,
      };
      return { ok: true as const, value: wire };
    },
    async authorizeGrant(request) {
      const grant = { ...request.target, authorizationId: request.authorizationId, grantId: 'sender-explicit-grant', authorizedAtMs: Date.now() };
      baseState.activeAuthorizationId = request.authorizationId;
      return { ok: true as const, value: { kind: 'authorize' as const, id: request.authorizationId, payloadHash: controlPayloadHash(request), senderProcessNonce: request.expectedSenderProcessNonce, state: 'authorized' as const, target: request.target, grant } };
    },
    async revokeControl(request) {
      baseState.activeAuthorizationId = null;
      return { ok: true as const, value: { kind: 'revoke' as const, id: request.revokeId, payloadHash: controlPayloadHash(request), senderProcessNonce: request.expectedSenderProcessNonce, state: 'revoked' as const, target: request.target } };
    },
    async revokeGrant(reason: string) {
      calls.revokeReasons.push(reason);
      return { ok: true as const, value: { ...baseState } };
    },
    async send(request: SendRequestWire) {
      calls.sends.push(request);
      const produce = options.sendResults[Math.min(sendIndex, options.sendResults.length - 1)];
      sendIndex += 1;
      const produced = await produce(request);
      if ('ok' in produced) return produced;
      sendOutcomes.set(request.requestId, produced);
      return { ok: true as const, value: produced };
    },
    async operation(requestId: string): Promise<{ ok: true; value: SenderOperationWire } | { ok: false; error: string; untrusted: boolean }> {
      const request = calls.sends.find((item) => item.requestId === requestId);
      const outcome = sendOutcomes.get(requestId);
      if (!request || !outcome) return { ok: true as const, value: { found: false as const } };
      const terminal = outcome.status === 'terminal_not_dispatched';
      return { ok: true as const, value: {
        found: true as const, requestId, sourceKey: request.sourceKey, binding: request.binding,
        senderProcessNonce: terminal ? outcome.proof.senderProcessNonce : baseState.processNonce,
        enterAttempted: outcome.status === 'dispatched', executionTerminated: true,
        enterNeverCalled: terminal && outcome.proof.enterNeverCalled,
        pageSubmitted: outcome.status === 'dispatched' && outcome.pageSubmitted, finishedAt: Date.now(),
      } };
    },
  };
}

export function digestOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function randomRequestId(): string {
  return `req-${randomBytes(8).toString('hex')}`;
}

/** 真实 vitest 环境里等待微任务/定时器落定。 */
export async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
}
