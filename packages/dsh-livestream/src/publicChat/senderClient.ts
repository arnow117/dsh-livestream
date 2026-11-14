/**
 * 受保护 v1 客户端（L → sender）与部署配置读取（FEAT-008 API-1/8）。
 *
 * 客户端强制数字 loopback、redirect:'error'、JSON 校验与
 * protocol/buildDigest/instanceId 固定绑定；任何不符都按不可信响应处理。
 * sender token 只从 0600 部署文件读取，绝不回显；凭据沿宿主 resolver
 * 在部署装配时写入该文件（T002/部署文档），本模块不做 resolver 查询。
 */

import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import {
  boundedString, isObject, hexDigest64, safeInteger, PUBLIC_CHAT_PROTOCOL, MAX_WIRE_BODY_BYTES,
  parseSenderListenUrl, validateSenderDeploymentFile,
  type Clock, defaultClock, type SenderStateWire, validateSenderStateWire,
  type QualificationWire, validateQualificationWire, type SendRequestWire, type SendResponseWire,
  validateSendResponseWire, type SenderOperationWire, validateSenderOperationWire,
} from './protocol';
import { validateBindingTuple } from './binding';
import { controlPayloadHash, type AuthorizeRequest, type RevokeRequest, type ControlRecord } from './grantAuthority';
import { parseHelperJSON } from './helperProtocol';
import { validateCommittedGrant, validateFrozenProposal } from './frozenGrant';
import type { FrozenAuthorizationRequest, FrozenCaptureRecord, FrozenControlRecord, FrozenRevokeRequest } from './frozenControl';
import type { FrozenSendInput, FrozenSenderState, RuntimeOperation } from './frozenSenderRuntime';
import { helperReconcilePayload, messageReconcileHash, validMessageReconcileRequest, validateRecoveryReceipt,
  type MessageReconcileRequest } from './recoveryProtocol';
import type { FrozenRecoveryControl } from './frozenRecovery';
import { isHttpResponseEvidence } from './httpResponse';

export interface SenderClientDeps {
  url: string;
  token: string;
  expected: { buildDigest: string; instanceId: string };
  timeoutMs?: number;
  clock?: Clock;
  fetcher?: typeof fetch;
}

export type SenderCallResult<T> = { ok: true; value: T } | { ok: false; error: string; untrusted: boolean };

export class SenderClient {
  private readonly origin: URL;
  private readonly timeoutMs: number;
  private readonly clock: Clock;
  private readonly fetcher: typeof fetch;
  /** 生效超时（合同值：默认 SEND_HTTP_TIMEOUT_MS=15000）。 */
  readonly effectiveTimeoutMs: number;

  constructor(private readonly deps: SenderClientDeps) {
    const parsed = parseSenderListenUrl(deps.url);
    if (!parsed.ok) throw new Error(parsed.error);
    this.origin = new URL(parsed.value.origin);
    this.timeoutMs = deps.timeoutMs ?? 15_000;
    this.effectiveTimeoutMs = this.timeoutMs;
    this.clock = deps.clock ?? defaultClock();
    this.fetcher = deps.fetcher ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    if (!boundedString(deps.token, 256)) throw new Error('sender token 无效');
    if (!hexDigest64(deps.expected.buildDigest)) throw new Error('expected buildDigest 无效');
    if (!boundedString(deps.expected.instanceId, 128)) throw new Error('expected instanceId 无效');
  }

  /** 每个响应的固定绑定校验；失败一律不可信。 */
  private async call<T>(
    path: string,
    method: 'GET' | 'POST',
    body: unknown,
    validate: (value: unknown) => { ok: true; value: T } | { ok: false; error: string },
  ): Promise<SenderCallResult<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(new URL(path, this.origin), {
        method,
        redirect: 'error',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.deps.token}`,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
        return { ok: false, error: 'sender 响应不是 JSON', untrusted: true };
      }
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => {});
        return { ok: false, error: `sender 响应状态 ${response.status}`, untrusted: false };
      }
      if (!response.body) return { ok: false, error: 'sender 响应体缺失', untrusted: true };
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.byteLength;
        if (size > MAX_WIRE_BODY_BYTES) {
          await reader.cancel().catch(() => {});
          return { ok: false, error: 'sender 响应超过本地长度上限', untrusted: true };
        }
        chunks.push(item.value);
      }
      let parsed: unknown;
      try {
        parsed = parseHelperJSON(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size));
      } catch {
        return { ok: false, error: 'sender 响应不是合法 JSON', untrusted: true };
      }
      if (!isObject(parsed)) return { ok: false, error: 'sender 响应结构无效', untrusted: true };
      if (parsed.protocol !== PUBLIC_CHAT_PROTOCOL) return { ok: false, error: '协议版本不符', untrusted: true };
      if (parsed.buildDigest !== this.deps.expected.buildDigest) return { ok: false, error: 'buildDigest 与部署不符', untrusted: true };
      if (parsed.instanceId !== this.deps.expected.instanceId) return { ok: false, error: 'instanceId 与部署不符', untrusted: true };
      const result = validate(parsed);
      if (!result.ok) return { ok: false, error: result.error, untrusted: true };
      return { ok: true, value: result.value };
    } catch (error: unknown) {
      const aborted = error instanceof Error && (error.name === 'AbortError' || error.message.includes('abort'));
      return { ok: false, error: aborted ? 'sender 响应超时' : 'sender 请求失败', untrusted: false };
    } finally {
      clearTimeout(timer);
    }
  }

  state(): Promise<SenderCallResult<SenderStateWire>> {
    return this.call('/v1/state', 'GET', undefined, validateSenderStateWire);
  }

  qualification(captureId?: string, expectedSenderProcessNonce?: string): Promise<SenderCallResult<QualificationWire>> {
    if (!boundedString(captureId, 128) || !boundedString(expectedSenderProcessNonce, 128)) {
      return Promise.resolve({ ok: false, error: 'captureId/nonce 缺失', untrusted: true });
    }
    return this.call('/v1/qualification', 'POST', { captureId, expectedSenderProcessNonce }, (value) => {
      if (!isObject(value) || value.captureId !== captureId) return { ok: false, error: 'captureId 不匹配' };
      const checked = validateQualificationWire(value);
      if (checked.ok && checked.value.qualified && checked.value.senderProcessNonce !== expectedSenderProcessNonce) return { ok: false, error: 'sender nonce 不匹配' };
      return checked;
    });
  }

  authorizeGrant(request: AuthorizeRequest): Promise<SenderCallResult<ControlRecord>> {
    return this.call('/v1/grant/authorize', 'POST', request, (value) => validateControlResponse(value, 'authorize', request.authorizationId, request.expectedSenderProcessNonce, controlPayloadHash(request), request));
  }

  revokeControl(request: RevokeRequest): Promise<SenderCallResult<ControlRecord>> {
    return this.call('/v1/grant/revoke', 'POST', request, (value) => validateControlResponse(value, 'revoke', request.revokeId, request.expectedSenderProcessNonce, controlPayloadHash(request), request));
  }

  controlOperation(id: string, kind: 'authorize' | 'revoke', nonce: string, payloadHash: string, original: { target: AuthorizeRequest['target'] | RevokeRequest['target']; qualificationToken?: string }): Promise<SenderCallResult<ControlRecord>> {
    if (!boundedString(id, 128)) return Promise.resolve({ ok: false, error: 'control ID 无效', untrusted: true });
    return this.call(`/v1/grant/operations/${encodeURIComponent(id)}`, 'GET', undefined, (value) => {
      if (!isObject(value) || value.found !== true) return { ok: false, error: 'control record unavailable' };
      return validateControlResponse({ registered: true, record: value.record }, kind, id, nonce, payloadHash, original);
    });
  }

  revokeGrant(reason: string): Promise<SenderCallResult<SenderStateWire>> {
    if (!boundedString(reason, 200)) return Promise.resolve({ ok: false, error: '撤销原因无效', untrusted: false });
    return this.call('/v1/grant/revoke', 'POST', { reason }, validateSenderStateWire);
  }

  send(request: SendRequestWire): Promise<SenderCallResult<SendResponseWire>> {
    const binding = validateBindingTuple(request.binding);
    if (!binding.ok) return Promise.resolve({ ok: false, error: `绑定元组无效：${binding.error}`, untrusted: false });
    return this.call('/v1/send', 'POST', request, validateSendResponseWire);
  }

  operation(requestId: string): Promise<SenderCallResult<SenderOperationWire>> {
    if (!boundedString(requestId, 128)) return Promise.resolve({ ok: false, error: 'requestId 无效', untrusted: false });
    return this.call(`/v1/operations/${encodeURIComponent(requestId)}`, 'GET', undefined, validateSenderOperationWire);
  }

  frozenState(): Promise<SenderCallResult<FrozenSenderState>> {
    return this.call('/v1/state', 'GET', undefined, (value) => {
      const capabilities = isObject(value) ? value.capabilities : null;
      if (!isObject(value) || !boundedString(value.processNonce, 128) || !safeInteger(value.senderConnectionGeneration) ||
        value.privateProtocol !== 'dsh-public-chat-http-v1' || !Array.isArray(capabilities) ||
        !['explicit-grant-snapshot-v1', 'frozen-http-auth-v1', 'no-replay-http1-v1', 'unknown-recovery-v1'].every((capability) => capabilities.includes(capability)) ||
        typeof value.hold !== 'boolean' || !validHelperIdentity(value.helper) || !validRawState(value.raw)) {
        return { ok: false, error: '冻结 sender 状态无效' };
      }
      return { ok: true, value: value as unknown as FrozenSenderState };
    });
  }

  frozenCapture(captureId: string, nonce: string): Promise<SenderCallResult<{ record: FrozenCaptureRecord;
    senderProcessNonce: string; senderConnectionGeneration: number; helper: FrozenSenderState['helper']; raw: FrozenSenderState['raw'] }>> {
    if (!boundedString(captureId, 128) || !boundedString(nonce, 128)) return Promise.resolve({ ok: false, error: 'capture 引用无效', untrusted: true });
    return this.call('/v1/qualification', 'POST', { captureId, expectedSenderProcessNonce: nonce }, (value) => {
      if (!isObject(value) || value.captureId !== captureId || value.senderProcessNonce !== nonce ||
        !safeInteger(value.senderConnectionGeneration) || !validHelperIdentity(value.helper) || !validRawState(value.raw) ||
        !isObject(value.record) || value.record.id !== captureId || value.record.senderProcessNonce !== nonce ||
        !hexDigest64(value.record.requestHash) || !hexDigest64(value.record.helperPayloadHash) ||
        !['capturing', 'capture_unknown', 'revoking_unknown', 'qualified', 'rejected', 'revoked'].includes(String(value.record.state))) {
        return { ok: false, error: 'capture 响应无效' };
      }
      if (value.record.state === 'qualified') {
        const q = value.record.qualification;
        if (!isObject(q) || q.captureId !== captureId || !boundedString(q.qualificationToken, 128) ||
          !hexDigest64(q.qualificationDigest) || !safeInteger(q.qualificationRevision) || !safeInteger(q.identityEpoch) ||
          !boundedString(q.principalUid, 20) || !safeInteger(q.capturedAtMs) || q.capturedAtMs === 0) {
          return { ok: false, error: 'qualification 证明无效' };
        }
      }
      return { ok: true, value: value as unknown as { record: FrozenCaptureRecord; senderProcessNonce: string;
        senderConnectionGeneration: number; helper: FrozenSenderState['helper']; raw: FrozenSenderState['raw'] } };
    });
  }

  frozenAuthorize(request: FrozenAuthorizationRequest, capturedAtMs: number): Promise<SenderCallResult<FrozenControlRecord>> {
    return this.call('/v1/grant/authorize', 'POST', request, (value) => {
      const checked = validateFrozenControl(value, 'authorize', request.authorizationId, request.expectedSenderProcessNonce,
        controlPayloadHash(request), request.target);
      if (!checked.ok) return checked;
      if (checked.value.kind === 'authorize' && checked.value.state === 'authorized' &&
        !validateCommittedGrant(checked.value.grant, request.target, request.qualificationToken, capturedAtMs, this.clock.wall())) {
        return { ok: false, error: 'helper 授权快照无效' };
      }
      return checked;
    });
  }

  frozenRevoke(request: FrozenRevokeRequest): Promise<SenderCallResult<FrozenControlRecord>> {
    return this.call('/v1/grant/revoke', 'POST', request, (value) => validateFrozenControl(value, 'revoke', request.revokeId,
      request.expectedSenderProcessNonce, controlPayloadHash(request), request.target));
  }

  frozenControlOperation(id: string, kind: 'authorize' | 'revoke', nonce: string, payloadHash: string,
    target: FrozenAuthorizationRequest['target'] | FrozenRevokeRequest['target']): Promise<SenderCallResult<FrozenControlRecord>> {
    if (!boundedString(id, 128)) return Promise.resolve({ ok: false, error: 'control ID 无效', untrusted: true });
    return this.call(`/v1/grant/operations/${encodeURIComponent(id)}`, 'GET', undefined, (value) => {
      if (!isObject(value) || value.found !== true) return { ok: false, error: 'control record unavailable' };
      return validateFrozenControl({ registered: true, record: value.record }, kind, id, nonce, payloadHash, target);
    });
  }

  frozenSend(request: FrozenSendInput): Promise<SenderCallResult<RuntimeOperation>> {
    return this.call('/v1/send', 'POST', request, (value) => validateFrozenOperation(value, request));
  }

  frozenOperation(original: Pick<RuntimeOperation, 'requestId' | 'sourceKey' | 'hash' | 'helperPayloadHash' | 'textDigest' | 'grant'>): Promise<SenderCallResult<RuntimeOperation>> {
    return this.call(`/v1/operations/${encodeURIComponent(original.requestId)}`, 'GET', undefined, (value) => {
      if (!isObject(value) || value.found !== true) return { ok: false, error: 'original operation unavailable' };
      return validateFrozenOperationReference(value.record, original);
    });
  }

  frozenReconcileMessage(request: MessageReconcileRequest): Promise<SenderCallResult<FrozenRecoveryControl>> {
    if (!validMessageReconcileRequest(request)) return Promise.resolve({ ok: false, error: 'invalid recovery request', untrusted: false });
    return this.call(`/v1/operations/${encodeURIComponent(request.ref.requestId)}/reconcile`, 'POST', request, (value) => {
      if (!isObject(value) || value.registered !== true) return { ok: false, error: 'recovery not registered' };
      return validateFrozenRecoveryControl(value.record, request, this.clock.wall());
    });
  }

  frozenRecoveryOperation(request: MessageReconcileRequest): Promise<SenderCallResult<FrozenRecoveryControl>> {
    if (!validMessageReconcileRequest(request)) return Promise.resolve({ ok: false, error: 'invalid recovery request', untrusted: false });
    return this.call(`/v1/grant/operations/${encodeURIComponent(request.controlId)}`, 'GET', undefined, (value) => {
      if (!isObject(value) || value.found !== true) return { ok: false, error: 'recovery record unavailable' };
      return validateFrozenRecoveryControl(value.record, request, this.clock.wall());
    });
  }

  /** 响应里的连接代次（state 携带）；供 L 侧监测 sender down/up。 */
  static connectionGeneration(state: SenderStateWire): number {
    if (!safeInteger(state.senderConnectionGeneration)) throw new Error('连接代次无效');
    return state.senderConnectionGeneration;
  }
}

function validHelperIdentity(value: unknown): boolean {
  return isObject(value) && boundedString(value.helperNonce, 128) && boundedString(value.authContextId, 128) &&
    safeInteger(value.authContextRevision) && hexDigest64(value.materialDigest);
}

function validRawState(value: unknown): boolean {
  if (value === null) return true;
  if (!isObject(value) || !boundedString(value.sessionId, 128) || !boundedString(value.contextId, 128) || !safeInteger(value.generation)) return false;
  if (value.proof === null) return true;
  const proof = value.proof;
  if (!isObject(proof) || !boundedString(proof.webRoomId, 64) || !boundedString(proof.platformRoomId, 20) ||
    proof.rawSourceSessionId !== value.sessionId || proof.rawSourceConnectionGeneration !== value.generation ||
    proof.rawBrowserContextId !== value.contextId || !boundedString(proof.liveEpoch, 128) || !boundedString(proof.socketId, 128) ||
    !safeInteger(proof.observedAtMs) || !hexDigest64(proof.digest)) return false;
  const fields = { webRoomId: proof.webRoomId, platformRoomId: proof.platformRoomId, rawSourceSessionId: proof.rawSourceSessionId,
    rawSourceConnectionGeneration: proof.rawSourceConnectionGeneration, rawBrowserContextId: proof.rawBrowserContextId,
    liveEpoch: proof.liveEpoch, socketId: proof.socketId, observedAtMs: proof.observedAtMs };
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex') === proof.digest;
}

function validateFrozenControl(value: unknown, kind: 'authorize' | 'revoke', id: string, nonce: string, payloadHash: string,
  target: FrozenAuthorizationRequest['target'] | FrozenRevokeRequest['target']):
  { ok: true; value: FrozenControlRecord } | { ok: false; error: string } {
  if (!isObject(value) || value.registered !== true || !isObject(value.record)) return { ok: false, error: '控制操作没有可信登记' };
  const record = value.record;
  if (record.kind !== kind || record.id !== id || record.senderProcessNonce !== nonce || record.payloadHash !== payloadHash ||
    !hexDigest64(record.helperPayloadHash) || controlPayloadHash(record.target) !== controlPayloadHash(target)) {
    return { ok: false, error: '控制操作原始引用不符' };
  }
  const states = kind === 'authorize' ? ['authorizing', 'authorizing_unknown', 'revoking_unknown', 'authorized', 'rejected', 'revoked']
    : ['revoking', 'revoking_unknown', 'revoked'];
  if (!states.includes(String(record.state))) return { ok: false, error: '控制操作状态无效' };
  if (kind === 'authorize') {
    if (!validateFrozenProposal(record.target) || record.target.authorizationId !== id ||
      record.helperPayloadHash !== controlPayloadHash(record.target)) return { ok: false, error: 'helper 原始授权不符' };
    if (record.state === 'authorized' && (!isObject(record.grant) || record.grant.authorizationId !== id)) {
      return { ok: false, error: 'helper 授权缺失' };
    }
  }
  return { ok: true, value: record as unknown as FrozenControlRecord };
}

export function validateFrozenRecoveryControl(value: unknown, request: MessageReconcileRequest, receivedAtMs?: number):
  { ok: true; value: FrozenRecoveryControl } | { ok: false; error: string } {
  const keys = ['kind', 'id', 'senderProcessNonce', 'payloadHash', 'helperPayloadHash', 'state', 'request', 'receipt', 'published'];
  if (!isObject(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)) ||
    value.kind !== 'message_reconcile' || value.id !== request.controlId || value.senderProcessNonce !== request.expectedSenderProcessNonce ||
    value.payloadHash !== messageReconcileHash(request) || value.helperPayloadHash !== controlPayloadHash(helperReconcilePayload(request)) ||
    controlPayloadHash(value.request) !== controlPayloadHash(request) || typeof value.published !== 'boolean' ||
    !['pending', 'pending_join', 'recovery_unknown', 'held', 'committed', 'superseded', 'rejected'].includes(String(value.state))) {
    return { ok: false, error: 'recovery control mismatch' };
  }
  if (value.state === 'committed') {
    if (!validateRecoveryReceipt(value.receipt, request, receivedAtMs)) return { ok: false, error: 'recovery receipt invalid' };
  } else if (value.receipt !== null || value.published) {
    return { ok: false, error: 'unexpected recovery receipt' };
  }
  return { ok: true, value: value as unknown as FrozenRecoveryControl };
}

function validateFrozenOperation(value: unknown, original: FrozenSendInput):
  { ok: true; value: RuntimeOperation } | { ok: false; error: string } {
  const helperPayload = { requestId: original.requestId, sourceKey: original.sourceKey, requestHash: controlPayloadHash(original), sourceKind: original.autoEvent ? 'auto' : 'manual',
    grant: original.grant, text: original.text };
  return validateFrozenOperationReference(value, { requestId: original.requestId, sourceKey: original.sourceKey,
    hash: controlPayloadHash(original), helperPayloadHash: controlPayloadHash(helperPayload),
    textDigest: createHash('sha256').update(original.text, 'utf8').digest('hex'), grant: original.grant });
}

function validateFrozenOperationReference(value: unknown,
  original: Pick<RuntimeOperation, 'requestId' | 'sourceKey' | 'hash' | 'helperPayloadHash' | 'textDigest' | 'grant'>):
  { ok: true; value: RuntimeOperation } | { ok: false; error: string } {
  if (!isObject(value) || value.requestId !== original.requestId || value.sourceKey !== original.sourceKey ||
    value.hash !== original.hash || controlPayloadHash(value.grant) !== controlPayloadHash(original.grant) ||
    typeof value.executionEnded !== 'boolean' || typeof value.writeAttempted !== 'boolean' ||
    !['dispatching', 'unknown', 'terminal_not_dispatched', 'api_reported_success'].includes(String(value.state))) {
    return { ok: false, error: '原消息引用不符' };
  }
  if (value.helperPayloadHash !== original.helperPayloadHash || value.textDigest !== original.textDigest ||
    (value.acceptedAtMs !== null && (!safeInteger(value.acceptedAtMs) || value.acceptedAtMs < original.grant.authorizedAtMs)) ||
    (value.firstWriteAttemptAtMs !== null && (!safeInteger(value.firstWriteAttemptAtMs) || !safeInteger(value.acceptedAtMs) ||
      value.firstWriteAttemptAtMs < value.acceptedAtMs)) ||
    (value.writeAttempted && value.firstWriteAttemptAtMs === null) ||
    (!value.writeAttempted && value.firstWriteAttemptAtMs !== null) ||
    (value.executionEnded && (!boundedString(value.joinedWitnessId, 128) || !safeInteger(value.joinedAtMs) ||
      !safeInteger(value.acceptedAtMs) || value.joinedAtMs < value.acceptedAtMs ||
      (typeof value.firstWriteAttemptAtMs === 'number' && value.joinedAtMs < value.firstWriteAttemptAtMs))) ||
    (!value.executionEnded && (value.joinedWitnessId !== null || value.joinedAtMs !== null)) ||
    !safeInteger(value.factsRevision) || value.factsRevision > 32 || !hexDigest64(value.factsDigest) ||
    (value.recoveryControlId !== null && !boundedString(value.recoveryControlId, 128)) ||
    (value.recoveryReceipt !== null && !isObject(value.recoveryReceipt)) ||
    (value.httpResponse !== null && (!isHttpResponseEvidence(value.httpResponse) || !value.executionEnded || !value.writeAttempted)) ||
    (value.state === 'terminal_not_dispatched' && (!value.executionEnded || value.writeAttempted)) ||
    (value.state === 'api_reported_success' && (!isHttpResponseEvidence(value.httpResponse) || value.httpResponse.status !== 200))) {
    return { ok: false, error: '原消息终态不符' };
  }
  return { ok: true, value: value as unknown as RuntimeOperation };
}

function validateControlResponse(value: unknown, kind: 'authorize' | 'revoke', id: string, nonce: string, payloadHash: string, original: { target: AuthorizeRequest['target'] | RevokeRequest['target']; qualificationToken?: string }): { ok: true; value: ControlRecord } | { ok: false; error: string } {
  if (!isObject(value) || value.registered !== true || !isObject(value.record)) return { ok: false, error: '控制操作没有可信登记终态' };
  const record = value.record;
  if (record.kind !== kind || record.id !== id || record.senderProcessNonce !== nonce || record.payloadHash !== payloadHash) return { ok: false, error: '控制操作引用不符' };
  if (kind === 'revoke') {
    if (record.state !== 'revoked' || controlPayloadHash(record.target) !== controlPayloadHash((original as RevokeRequest).target)) return { ok: false, error: '撤销目标不符' };
  } else {
    const request = original as { target: AuthorizeRequest['target']; qualificationToken?: string };
    if (!['authorizing', 'authorized', 'rejected', 'revoked'].includes(String(record.state)) || controlPayloadHash(record.target) !== controlPayloadHash(request.target)) return { ok: false, error: '授权目标不符' };
    if (record.state === 'authorized') {
      if (!isObject(record.grant) || !boundedString(record.grant.grantId, 128)
        || (request.qualificationToken !== undefined ? record.grant.grantId === request.qualificationToken : createHash('sha256').update(record.grant.grantId).digest('hex') === request.target.qualificationDigest)
        || record.grant.authorizationId !== id || !safeInteger(record.grant.authorizedAtMs) || record.grant.authorizedAtMs < request.target.liveEpochStartedAtMs) return { ok: false, error: '授权快照无效' };
      const { authorizationId, grantId, authorizedAtMs, ...target } = record.grant;
      if (controlPayloadHash(target) !== controlPayloadHash(request.target)) return { ok: false, error: '授权快照不符' };
    }
  }
  return { ok: true, value: record as unknown as ControlRecord };
}

export interface SenderDeploymentConfig {
  listenUrl: string;
  token: string;
  expectedPrincipalUid: string;
  roomId: string;
  accountRecordId: string;
  buildDigest: string;
  instanceId: string;
  profileOrigin: string;
  dataDir: string;
  sourcePath: string;
}

/**
 * 读取 0600 部署文件。要求：常规文件、非 symlink、硬链接数为 1、
 * 权限恰为 0600、JSON 严格解析并通过完整校验。绝不回显 token。
 */
export function readSenderDeploymentFile(path: string, io: typeof fs = fs): SenderDeploymentConfig {
  const stat = io.lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error('部署配置必须是独占常规文件');
  }
  if ((stat.mode & 0o777) !== 0o600) {
    throw new Error('部署配置权限必须是 0600');
  }
  const raw = io.readFileSync(path, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!isObject(parsed)) throw new Error('部署配置必须是 JSON 对象');
  const result = validateSenderDeploymentFile(parsed);
  if (!result.ok) throw new Error(`部署配置无效：${result.error}`);
  return { ...result.value, sourcePath: path };
}
