/**
 * 固定目标发送控制器（FEAT-008 API-1/4/5，L 侧）。
 *
 * 单在途、有界队列（默认 10 条/30 秒）、派发间隔至少 3 秒、HTTP 15 秒：
 * 都是本地限制，不冒称平台限额。任何发送 HTTP 之前先持久化 dispatching；
 * 派发后不确定一律 unknown 并全目标 hold，不换 ID/目标/渠道重发。
 * 原 request/sourceKey tombstone；重启 dispatching→unknown，无授权恢复、
 * 无队列重放。授权仅内存；异步资格响应返回后复核 revision，过期响应
 * 不能重建授权。
 */

import { randomBytes } from 'node:crypto';
import { createHash } from 'node:crypto';
import { SEND_QUEUE_LIMIT, SEND_QUEUE_WAIT_MS, SEND_DISPATCH_INTERVAL_MS, SEND_HTTP_TIMEOUT_MS, boundedString, isObject, PUBLIC_CHAT_PROTOCOL, type Clock, defaultClock } from './protocol';
import { validateBindingTuple, bindingMatches, isValidPrincipalUid, type BindingTuple } from './binding';
import { validatePublicText } from './textPolicy';
import { type GrantRecord, type QualificationSnapshot } from './grantManager';
import { GrantManager, type GrantRevokeReason } from './grantManager';
import { PublicChatOperationJournal } from './journal';
import {
  appendFact, applyDispatchOutcome, applyRestartRecovery, reconcileHold, validateFactInput, validateInternalFactInput,
  type AppendFactResult, type DispatchOutcomeInput, type FactInput, type InternalFactInput, type OriginalOperation, type ReconciliationState,
} from './operations';
import { validateAutoEvent } from './eventRef';
import { controlPayloadHash, type AuthorizeRequest, type RevokeRequest, type ControlRecord, type GrantSnapshot } from './grantAuthority';
import type { JournalControl } from './journal';
import { isQualificationFresh } from './identity';
import { FrozenControllerCore } from './frozenController';
import { FrozenPublicChatOperationJournal, type FrozenJournalMessage } from './frozenJournal';
import type { SenderClient } from './senderClient';
import type { FrozenGrantSnapshot } from './frozenGrant';
import { validateMessageRef, type MessageRef } from './recoveryFacts';

/** sender 交互面：生产用 SenderClient，测试用替身；按结构化类型匹配。 */
export interface SenderGateway {
  state(): Promise<{ ok: true; value: import('./protocol').SenderStateWire } | { ok: false; error: string; untrusted: boolean }>;
  qualification(captureId?: string, expectedSenderProcessNonce?: string): Promise<{ ok: true; value: import('./protocol').QualificationWire } | { ok: false; error: string; untrusted: boolean }>;
  authorizeGrant?(request: AuthorizeRequest): Promise<{ ok: true; value: ControlRecord } | { ok: false; error: string; untrusted: boolean }>;
  revokeControl?(request: RevokeRequest): Promise<{ ok: true; value: ControlRecord } | { ok: false; error: string; untrusted: boolean }>;
  controlOperation?(id: string, kind: 'authorize' | 'revoke', nonce: string, payloadHash: string, original: { target: AuthorizeRequest['target'] | RevokeRequest['target']; qualificationToken?: string }): Promise<{ ok: true; value: ControlRecord } | { ok: false; error: string; untrusted: boolean }>;
  revokeGrant(reason: string): Promise<{ ok: true; value: import('./protocol').SenderStateWire } | { ok: false; error: string; untrusted: boolean }>;
  send(request: import('./protocol').SendRequestWire): Promise<{ ok: true; value: import('./protocol').SendResponseWire } | { ok: false; error: string; untrusted: boolean }>;
  operation(requestId: string): Promise<{ ok: true; value: import('./protocol').SenderOperationWire } | { ok: false; error: string; untrusted: boolean }>;
}

export interface ControllerDeployment {
  expectedPrincipalUid: string;
  roomId: string;
  accountRecordId: string;
  buildDigest: string;
  instanceId: string;
}

export interface ControllerBounds {
  queueLimit?: number;
  queueWaitMs?: number;
  dispatchIntervalMs?: number;
  httpTimeoutMs?: number;
}

export interface ControllerDeps {
  deployment: ControllerDeployment;
  gateway: SenderGateway;
  journal: PublicChatOperationJournal | FrozenPublicChatOperationJournal;
  bounds?: ControllerBounds;
  clock?: Clock;
  processNonce?: string;
}

export interface SubmitInput {
  requestId: string;
  sourceKey: string | null;
  text: string;
  /** 自动动作：必须携带真实原事件对象与 sender raw 声明。 */
  autoEvent?: { event: object; rawId: string; rawType: string };
}

export type SubmitResult =
  | { status: 'accepted'; requestId: string }
  | { status: 'rejected'; reason: string }
  | { status: 'duplicate'; requestId: string; outcome: string | null };

interface QueueEntry {
  requestId: string;
  deadlineWall: number;
  text: string;
  autoEventClaim: { rawId: string; rawType: string } | null;
}

function validAcknowledgedGrant(grant: GrantSnapshot, request: AuthorizeRequest): boolean {
  if (!grant || grant.authorizationId !== request.authorizationId || !boundedString(grant.grantId, 128)
    || grant.grantId === request.qualificationToken || !Number.isSafeInteger(grant.authorizedAtMs)
    || grant.authorizedAtMs < request.target.liveEpochStartedAtMs) return false;
  const { authorizationId, grantId, authorizedAtMs, ...target } = grant;
  return controlPayloadHash(target) === controlPayloadHash(request.target);
}

function validStoredGrant(grant: GrantSnapshot, id: string, target: AuthorizeRequest['target']): boolean {
  if (!grant || grant.authorizationId !== id || !boundedString(grant.grantId, 128)
    || createHash('sha256').update(grant.grantId).digest('hex') === target.qualificationDigest
    || !Number.isSafeInteger(grant.authorizedAtMs) || grant.authorizedAtMs < target.liveEpochStartedAtMs) return false;
  const { authorizationId, grantId, authorizedAtMs, ...grantTarget } = grant;
  return controlPayloadHash(grantTarget) === controlPayloadHash(target);
}

const sleep = (ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms));

export class PublicChatSendController {
  private readonly nonce = randomBytes(16).toString('hex');
  private counter = 0;
  private readonly deployment: ControllerDeployment;
  private readonly gateway: SenderGateway;
  private readonly journal: PublicChatOperationJournal;
  private readonly frozenCore: FrozenControllerCore | null;
  private readonly clock: Clock;
  private readonly queueLimit: number;
  private readonly queueWaitMs: number;
  private readonly dispatchIntervalMs: number;
  private readonly httpTimeoutMs: number;
  private readonly processNonce: string;

  readonly grants = new GrantManager();
  private operations = new Map<string, OriginalOperation>();
  private sourceKeyIndex = new Map<string, string>();
  private queue: QueueEntry[] = [];
  private pumpRunning = false;
  private lastDispatchWall = -Infinity;
  private holdAll = false;
  private journalDegraded = false;
  private pendingQualification: QualificationSnapshot | null = null;
  private pendingCaptureId: string | null = null;
  private liveEpochStartedAtMs: number | null = null;
  /** 宿主在输入连接代次推进时更新的当前来源令牌（auto 事件校验用）。 */
  private currentSourceConnectionToken = '';

  constructor(deps: ControllerDeps) {
    if (!isValidPrincipalUid(deps.deployment.expectedPrincipalUid)) throw new Error('预期主体 UID 无效');
    if (!/^[0-9]{1,64}$/.test(deps.deployment.roomId)) throw new Error('固定房间号无效');
    this.deployment = deps.deployment;
    this.gateway = deps.gateway;
    this.journal = deps.journal as PublicChatOperationJournal;
    this.clock = deps.clock ?? defaultClock();
    this.queueLimit = deps.bounds?.queueLimit ?? SEND_QUEUE_LIMIT;
    this.queueWaitMs = deps.bounds?.queueWaitMs ?? SEND_QUEUE_WAIT_MS;
    this.dispatchIntervalMs = deps.bounds?.dispatchIntervalMs ?? SEND_DISPATCH_INTERVAL_MS;
    this.httpTimeoutMs = deps.bounds?.httpTimeoutMs ?? SEND_HTTP_TIMEOUT_MS;
    this.processNonce = deps.processNonce ?? randomBytes(16).toString('hex');
    this.grants.advanceInputConnection();
    if (deps.journal instanceof FrozenPublicChatOperationJournal) {
      const gateway = deps.gateway as unknown as SenderClient;
      if (typeof gateway.frozenState !== 'function' || typeof gateway.frozenCapture !== 'function' ||
        typeof gateway.frozenAuthorize !== 'function' || typeof gateway.frozenRevoke !== 'function' ||
        typeof gateway.frozenControlOperation !== 'function' || typeof gateway.frozenSend !== 'function' ||
        typeof gateway.frozenOperation !== 'function' || typeof gateway.frozenReconcileMessage !== 'function' ||
        typeof gateway.frozenRecoveryOperation !== 'function') {
        throw new Error('缺少冻结 sender 客户端');
      }
      this.frozenCore = new FrozenControllerCore({ deployment: deps.deployment, gateway, journal: deps.journal,
        clock: this.clock, queueLimit: this.queueLimit, queueWaitMs: this.queueWaitMs, dispatchIntervalMs: this.dispatchIntervalMs });
    } else {
      this.frozenCore = null;
      this.restartRecovery();
    }
  }

  get revision(): string {
    if (this.frozenCore) return this.frozenCore.revision;
    return `${this.nonce}:${this.counter}`;
  }

  get hold(): boolean {
    if (this.frozenCore) return this.frozenCore.hold;
    return this.holdAll || this.controlRecoveryHold() || this.journal.corrupt || this.journalDegraded;
  }

  /** 仅供受信宿主连接原事件；不从持久记录构造可用授权。 */
  currentFrozenGrant(): Readonly<FrozenGrantSnapshot> | null {
    return this.frozenCore?.currentGrant() ?? null;
  }

  /** Only the matching sender recovery notification was already invalidated locally. */
  ownsPendingRecoveryInvalidation(controlId: string, payloadHash: string): boolean {
    return this.frozenCore?.ownsPendingRecoveryInvalidation(controlId, payloadHash) ?? false;
  }

  /** 设置保存只做本地失效，不启动 sender HTTP。 */
  suspendFrozenLocally(): void {
    if (!this.frozenCore) throw new Error('frozen sender unavailable');
    this.frozenCore.suspendLocally();
  }

  /** 部署/房间/epoch 变化时由宿主调用；旧异步响应一律作废。 */
  advanceRevision(): string {
    if (this.frozenCore) return this.frozenCore.advanceRevision();
    this.counter += 1;
    return this.revision;
  }

  setCurrentSourceConnectionToken(token: string): void {
    if (!boundedString(token, 200)) throw new Error('来源连接令牌无效');
    if (this.frozenCore) { this.frozenCore.setSourceConnectionToken(token); return; }
    this.currentSourceConnectionToken = token;
  }

  /** ---------- 资格与授权 ---------- */

  /** A previous unresolved control always blocks a fresh authorization. */
  private controlsPending(): boolean {
    return this.journal.controls.some((control) => control.kind === 'authorize'
      ? !['rejected', 'revoked'].includes(control.state)
      : control.state !== 'revoked');
  }

  private controlRecoveryHold(): boolean {
    const activeId = this.grants.active?.snapshot?.authorizationId;
    return this.journal.controls.some((control) => control.kind === 'authorize'
      ? !['rejected', 'revoked'].includes(control.state) && !(control.state === 'active' && control.id === activeId)
      : control.state !== 'revoked');
  }

  async refreshQualification(): Promise<{ ok: boolean; reason: string }> {
    if (this.frozenCore) return this.frozenCore.refreshQualification();
    if (this.holdAll || this.controlsPending() || this.journal.corrupt || this.journalDegraded) return { ok: false, reason: 'control-or-message-hold' };
    if (this.pendingCaptureId !== null) {
      this.revokeGrant('identity-proof-invalid');
      return { ok: false, reason: 'capture-cancellation-pending' };
    }
    const revisionAtStart = this.advanceRevision();
    const state = await this.gateway.state();
    if (this.revision !== revisionAtStart) return { ok: false, reason: 'stale-response' };
    if (!state.ok || state.value.protocol !== PUBLIC_CHAT_PROTOCOL || state.value.buildDigest !== this.deployment.buildDigest
      || state.value.instanceId !== this.deployment.instanceId || !boundedString(state.value.processNonce, 128)
      || !['explicit-grant-snapshot-v1', 'frozen-http-auth-v1', 'no-replay-http1-v1'].every((capability) => state.value.capabilities?.includes(capability))
      || state.value.privateProtocol !== 'dsh-public-chat-http-v1' || !state.value.session?.connected
      || state.value.session.roomId !== this.deployment.roomId) return { ok: false, reason: 'sender-unavailable' };
    const captureId = randomBytes(16).toString('hex');
    this.pendingCaptureId = captureId;
    this.lastCaptureNonce = state.value.processNonce;
    this.pendingQualification = null;
    const result = await this.gateway.qualification(captureId, state.value.processNonce);
    if (this.revision !== revisionAtStart || this.pendingCaptureId !== captureId) return { ok: false, reason: 'stale-response' };
    if (!result.ok || !result.value.qualified) {
      this.revokeGrant('identity-proof-invalid');
      return { ok: false, reason: 'identity_unverified' };
    }
    const wire = result.value;
    if (wire.principalUid !== this.deployment.expectedPrincipalUid || wire.senderProcessNonce !== state.value.processNonce
      || wire.sessionId !== state.value.session.sessionId || wire.senderConnectionGeneration !== state.value.senderConnectionGeneration) {
      this.revokeGrant('identity-proof-invalid');
      return { ok: false, reason: 'identity-mismatch' };
    }
    this.pendingCaptureId = captureId;
    this.lastCaptureNonce = wire.senderProcessNonce;
    this.pendingQualification = {
      principalUid: wire.principalUid, contextId: wire.contextId, sessionId: wire.sessionId,
      authCookieDigest: wire.authCookieDigest, authCookieGeneration: wire.authCookieGeneration,
      capturedAt: wire.capturedAt, profileOrigin: wire.profileOrigin, profileStatus: wire.profileStatus,
      qualificationToken: wire.qualificationToken, identityEpoch: wire.identityEpoch,
      senderProcessNonce: wire.senderProcessNonce, senderConnectionGeneration: wire.senderConnectionGeneration,
    };
    return { ok: true, reason: 'ok' };
  }

  /** Journal the stable control before HTTP; publish only a matching persisted ACK. */
  async authorize(): Promise<{ ok: boolean; reason: string; grantId?: string }> {
    if (this.frozenCore) return this.frozenCore.authorize();
    if (this.holdAll || this.controlsPending()) return { ok: false, reason: 'control-or-message-hold' };
    if (this.journal.corrupt || this.journalDegraded) return { ok: false, reason: 'journal-unavailable' };
    const q = this.pendingQualification;
    const captureId = this.pendingCaptureId;
    const liveEpoch = this.grants.liveEpoch;
    const liveStart = this.liveEpochStartedAtMs;
    const inputGeneration = this.grants.currentInputGeneration;
    if (!q || !captureId || !liveEpoch || liveStart === null || !Number.isSafeInteger(liveStart) || liveStart <= 0
      || !isQualificationFresh(q, this.clock.wall()) || inputGeneration < 0 || !this.gateway.authorizeGrant) return { ok: false, reason: 'authorization-prerequisite-missing' };
    const authorizationId = randomBytes(16).toString('hex');
    const localRevision = this.revision;
    const request: AuthorizeRequest = {
      authorizationId, expectedSenderProcessNonce: q.senderProcessNonce, qualificationToken: q.qualificationToken, localRevision,
      target: {
        version: PUBLIC_CHAT_PROTOCOL, buildDigest: this.deployment.buildDigest, instanceId: this.deployment.instanceId,
        senderProcessNonce: q.senderProcessNonce, captureId, qualificationDigest: createHash('sha256').update(q.qualificationToken).digest('hex'),
        qualificationRevision: q.identityEpoch, accountRecordId: this.deployment.accountRecordId, principalUid: q.principalUid,
        roomId: this.deployment.roomId, browserContextId: q.contextId, senderSessionId: q.sessionId,
        senderConnectionGeneration: q.senderConnectionGeneration, identityEpoch: q.identityEpoch, authCookieGeneration: q.authCookieGeneration,
        liveEpoch, liveEpochStartedAtMs: liveStart, inputConnectionGeneration: inputGeneration,
      },
    };
    const record: JournalControl = { kind: 'authorize', id: authorizationId, payloadHash: controlPayloadHash(request),
      senderProcessNonce: q.senderProcessNonce, target: request.target, localRevision, state: 'authorizing', grant: null };
    this.journal.controls.push(record);
    if (this.persist() !== null) { this.journalDegraded = true; return { ok: false, reason: 'journal-write-failed' }; }
    const result = await this.gateway.authorizeGrant(request).catch(() => ({ ok: false as const, error: 'authorization transport failed', untrusted: false }));
    const index = this.journal.controls.findIndex((item) => item.id === authorizationId);
    const current = this.journal.controls[index];
    if (!current || current.kind !== 'authorize') return { ok: false, reason: 'control-missing' };
    if (current.state === 'revoked') return { ok: false, reason: 'authorization-revoked' };
    if (!result.ok || result.value.kind !== 'authorize' || result.value.state !== 'authorized'
      || result.value.id !== authorizationId || result.value.senderProcessNonce !== q.senderProcessNonce
      || result.value.payloadHash !== record.payloadHash
      || controlPayloadHash(result.value.target) !== controlPayloadHash(request.target)
      || !validAcknowledgedGrant(result.value.grant, request)
      || result.value.grant.authorizedAtMs > this.clock.wall() + 5000
      || this.revision !== localRevision || this.pendingQualification !== q) {
      this.journal.controls[index] = { ...current, state: 'authorizing_unknown' };
      if (this.persist() !== null) this.journalDegraded = true;
      return { ok: false, reason: 'authorizing-unknown' };
    }
    const snapshot = Object.freeze({ ...result.value.grant });
    this.journal.controls[index] = { ...current, state: 'active', grant: snapshot };
    if (this.persist() !== null) { this.journalDegraded = true; return { ok: false, reason: 'journal-write-failed' }; }
    const installed = this.grants.install(snapshot, q);
    if (!installed.ok) return { ok: false, reason: installed.reason };
    return { ok: true, reason: 'ok', grantId: snapshot.grantId };
  }

  revokeGrant(reason: GrantRevokeReason): void {
    if (this.frozenCore) { this.frozenCore.revoke(); return; }
    this.advanceRevision();
    this.grants.revoke(reason, this.clock.wall());
    this.pendingQualification = null;
    const captureId = this.pendingCaptureId;
    this.pendingCaptureId = null;
    const original = [...this.journal.controls].reverse().find((item) => item.kind === 'authorize' && !['revoked', 'rejected'].includes(item.state));
    const target = original?.kind === 'authorize'
      ? { kind: 'authorization' as const, authorizationId: original.id, ...(original.grant ? { grantId: original.grant.grantId, snapshot: original.grant } : {}) }
      : captureId ? { kind: 'capture' as const, captureId } : null;
    const nonce = original?.senderProcessNonce ?? (target?.kind === 'capture' ? this.lastCaptureNonce : null);
    if (!target || !nonce) return;
    const request: RevokeRequest = { revokeId: randomBytes(16).toString('hex'), expectedSenderProcessNonce: nonce, target };
    const control: JournalControl = { kind: 'revoke', id: request.revokeId, payloadHash: controlPayloadHash(request), senderProcessNonce: nonce, target, state: 'revoking' };
    this.journal.controls.push(control);
    if (this.persist() !== null) { this.journalDegraded = true; return; }
    if (!this.gateway.revokeControl) {
      const index = this.journal.controls.findIndex((item) => item.id === request.revokeId);
      this.journal.controls[index] = { ...control, state: 'revoking_unknown' };
      if (this.persist() !== null) this.journalDegraded = true;
      return;
    }
    void this.gateway.revokeControl(request).then((result) => {
      const index = this.journal.controls.findIndex((item) => item.id === request.revokeId);
      const current = this.journal.controls[index];
      if (!current || current.kind !== 'revoke') return;
      if (!result.ok || result.value.kind !== 'revoke' || result.value.state !== 'revoked'
        || result.value.id !== request.revokeId || result.value.senderProcessNonce !== nonce
        || result.value.payloadHash !== control.payloadHash || controlPayloadHash(result.value.target) !== controlPayloadHash(target)) {
        this.journal.controls[index] = { ...current, state: 'revoking_unknown' };
      } else {
        this.journal.controls[index] = { ...current, state: 'revoked' };
        if (target.kind === 'authorization') {
          const authIndex = this.journal.controls.findIndex((item) => item.kind === 'authorize' && item.id === target.authorizationId);
          const auth = this.journal.controls[authIndex];
          if (auth?.kind === 'authorize') this.journal.controls[authIndex] = { ...auth, state: 'revoked' };
        }
      }
      if (this.persist() !== null) this.journalDegraded = true;
    }).catch(() => { this.journalDegraded = true; });
  }

  /** Query the original control; unknown or not-found never clears a hold. */
  async reconcileControl(id: string): Promise<{ ok: boolean; reason: string }> {
    if (this.frozenCore) return this.frozenCore.reconcileControl(id);
    const index = this.journal.controls.findIndex((item) => item.id === id);
    const control = this.journal.controls[index];
    if (!control || !this.gateway.controlOperation) return { ok: false, reason: 'control-query-unavailable' };
    const result = await this.gateway.controlOperation(control.id, control.kind, control.senderProcessNonce, control.payloadHash, { target: control.target });
    if (this.journal.controls[index] !== control) return { ok: false, reason: 'control-changed-during-query' };
    if (!result.ok || result.value.kind !== control.kind || result.value.id !== control.id
      || result.value.senderProcessNonce !== control.senderProcessNonce || result.value.payloadHash !== control.payloadHash
      || controlPayloadHash(result.value.target) !== controlPayloadHash(control.target)) return { ok: false, reason: 'control-unresolved' };
    if (control.kind === 'authorize' && result.value.kind === 'authorize') {
      if (result.value.state === 'rejected' || result.value.state === 'revoked') {
        this.journal.controls[index] = { ...control, state: result.value.state };
      } else if (result.value.state === 'authorized') {
        if (!validStoredGrant(result.value.grant, control.id, control.target)) return { ok: false, reason: 'control-grant-mismatch' };
        this.journal.controls[index] = { ...control, state: 'authorizing_unknown', grant: result.value.grant };
        if (this.persist() !== null) { this.journalDegraded = true; return { ok: false, reason: 'journal-write-failed' }; }
        this.revokeGrant('owner-revoke');
        return { ok: false, reason: 'targeted-revoke-started' };
      } else return { ok: false, reason: 'control-pending' };
    } else if (control.kind === 'revoke' && result.value.kind === 'revoke' && result.value.state === 'revoked') {
      this.journal.controls[index] = { ...control, state: 'revoked' };
      if (control.target.kind === 'authorization') {
        const authorizationId = control.target.authorizationId;
        const authIndex = this.journal.controls.findIndex((item) => item.kind === 'authorize' && item.id === authorizationId);
        const auth = this.journal.controls[authIndex];
        if (auth?.kind === 'authorize') this.journal.controls[authIndex] = { ...auth, state: 'revoked' };
      }
    } else return { ok: false, reason: 'control-pending' };
    if (this.persist() !== null) { this.journalDegraded = true; return { ok: false, reason: 'journal-write-failed' }; }
    return { ok: true, reason: 'control-terminal-recorded' };
  }

  /** Retry only the original persisted revoke ID and payload. */
  async retryRevokeControl(id: string): Promise<{ ok: boolean; reason: string }> {
    if (this.frozenCore) return this.frozenCore.retryRevokeControl(id);
    const index = this.journal.controls.findIndex((item) => item.id === id);
    const control = this.journal.controls[index];
    if (!control || control.kind !== 'revoke' || control.state === 'revoked' || !this.gateway.revokeControl) return { ok: false, reason: 'revoke-unavailable' };
    const request: RevokeRequest = { revokeId: control.id, expectedSenderProcessNonce: control.senderProcessNonce, target: control.target };
    if (controlPayloadHash(request) !== control.payloadHash) return { ok: false, reason: 'revoke-payload-mismatch' };
    const response = await this.gateway.revokeControl(request).catch(() => ({ ok: false as const, error: 'revoke failed', untrusted: false }));
    if (this.journal.controls[index] !== control || !response.ok || response.value.kind !== 'revoke'
      || response.value.state !== 'revoked' || response.value.id !== control.id
      || response.value.senderProcessNonce !== control.senderProcessNonce || response.value.payloadHash !== control.payloadHash
      || controlPayloadHash(response.value.target) !== controlPayloadHash(control.target)) return { ok: false, reason: 'revoke-unresolved' };
    this.journal.controls[index] = { ...control, state: 'revoked' };
    if (control.target.kind === 'authorization') {
      const authorizationId = control.target.authorizationId;
      const authIndex = this.journal.controls.findIndex((item) => item.kind === 'authorize' && item.id === authorizationId);
      const auth = this.journal.controls[authIndex];
      if (auth?.kind === 'authorize') this.journal.controls[authIndex] = { ...auth, state: 'revoked' };
    }
    if (this.persist() !== null) { this.journalDegraded = true; return { ok: false, reason: 'journal-write-failed' }; }
    return { ok: true, reason: 'revoke-confirmed' };
  }

  private lastCaptureNonce: string | null = null;

  setLiveEpoch(epoch: string, startedAtMs?: number): void {
    if (this.frozenCore) { this.frozenCore.setLiveEpoch(epoch, startedAtMs); return; }
    if (this.grants.liveEpoch !== epoch || this.liveEpochStartedAtMs !== startedAtMs) {
      if (this.grants.active || this.pendingQualification || this.controlsPending()) this.revokeGrant('live-epoch-changed');
      else this.advanceRevision();
      this.liveEpochStartedAtMs = startedAtMs !== undefined && Number.isSafeInteger(startedAtMs) && startedAtMs > 0 ? startedAtMs : null;
    }
    this.grants.setLiveEpoch(epoch, this.clock.wall());
  }

  advanceInputConnection(): string {
    if (this.frozenCore) return this.frozenCore.advanceInputConnection();
    if (this.grants.active || this.pendingQualification || this.controlsPending()) this.revokeGrant('sender-connection-change');
    else this.advanceRevision();
    const generation = this.grants.advanceInputConnection();
    this.currentSourceConnectionToken = `${this.nonce}:${generation}`;
    return this.currentSourceConnectionToken;
  }

  /** ---------- 提交与派发 ---------- */

  async submit(input: SubmitInput): Promise<SubmitResult> {
    if (this.frozenCore) return this.frozenCore.submit(input);
    if (!boundedString(input.requestId, 128)) return { status: 'rejected', reason: 'requestId 无效' };
    if (input.sourceKey !== null && !boundedString(input.sourceKey, 200)) return { status: 'rejected', reason: 'sourceKey 无效' };
    // 重复请求只查原操作，不再派发。
    const existing = this.operations.get(input.requestId);
    if (existing !== undefined) {
      return { status: 'duplicate', requestId: existing.requestId, outcome: existing.outcome };
    }
    if (input.sourceKey !== null) {
      const tombstoneOwner = this.sourceKeyIndex.get(input.sourceKey);
      if (tombstoneOwner !== undefined) {
        const owner = this.operations.get(tombstoneOwner);
        return { status: 'duplicate', requestId: tombstoneOwner, outcome: owner?.outcome ?? null };
      }
    }
    if (this.hold) {
      return { status: 'rejected', reason: this.journal.corrupt ? 'journal-unavailable' : this.journalDegraded ? 'journal-degraded' : 'hold-unknown-pending' };
    }
    const text = validatePublicText(input.text);
    if (!text.ok) return { status: 'rejected', reason: `text-invalid:${text.reason}` };
    const grant = this.grants.active;
    const now = this.clock.wall();
    if (grant === null || !this.grants.isUsable(grant.grantId, now)) {
      return { status: 'rejected', reason: 'grant-unavailable' };
    }
    if (grant.liveEpoch !== this.grants.liveEpoch) return { status: 'rejected', reason: 'live-epoch-changed' };
    // 队列上限计入在途一条：在途 + 排队 ≤ queueLimit。
    const activeCount = this.queue.length + (this.pumpRunning ? 1 : 0);
    if (activeCount >= this.queueLimit) return { status: 'rejected', reason: 'queue-full' };
    if (input.autoEvent !== undefined) {
      const check = validateAutoEvent(input.autoEvent.event, input.autoEvent, {
        liveEpoch: grant.liveEpoch,
        sourceConnectionToken: this.currentSourceConnectionToken,
      });
      if (!check.ok) return { status: 'rejected', reason: check.reason };
    }

    const snapshot = grant.snapshot;
    if (!snapshot) return { status: 'rejected', reason: 'explicit-grant-snapshot-missing' };
    const binding: BindingTuple = {
      ...snapshot,
      processNonce: snapshot.senderProcessNonce,
      identityGeneration: snapshot.identityEpoch,
    };
    const bindingResult = validateBindingTuple(binding);
    if (!bindingResult.ok) return { status: 'rejected', reason: `binding-invalid:${bindingResult.error}` };
    const operation: OriginalOperation = {
      schemaVersion: 1,
      requestId: input.requestId,
      sourceKey: input.sourceKey,
      binding: {
        principalUid: binding.principalUid,
        roomId: binding.roomId,
        grantId: binding.grantId,
        liveEpoch: binding.liveEpoch,
        senderSessionId: binding.senderSessionId,
        senderProcessNonce: binding.processNonce,
        inputConnectionGeneration: binding.inputConnectionGeneration,
        identityGeneration: binding.identityGeneration,
        snapshot,
      },
      textDigest: createHash('sha256').update(input.text, 'utf8').digest('hex'),
      textLength: [...input.text].length,
      phase: 'queued',
      outcome: null,
      outcomeReason: null,
      enterAttempted: false,
      pageSubmitted: false,
      senderProofApplied: false,
      conflictOpen: false,
      facts: [],
      createdAt: now,
      updatedAt: now,
      tombstone: true,
    };
    this.operations.set(operation.requestId, operation);
    if (operation.sourceKey !== null) this.sourceKeyIndex.set(operation.sourceKey, operation.requestId);
    const journalError = this.persist();
    if (journalError !== null) {
      this.operations.delete(operation.requestId);
      if (operation.sourceKey !== null) this.sourceKeyIndex.delete(operation.sourceKey);
      this.journalDegraded = true;
      return { status: 'rejected', reason: 'journal-write-failed' };
    }
    this.queue.push({ requestId: operation.requestId, deadlineWall: now + this.queueWaitMs, text: input.text, autoEventClaim: input.autoEvent ? { rawId: input.autoEvent.rawId, rawType: input.autoEvent.rawType } : null });
    void this.ensurePump();
    return { status: 'accepted', requestId: operation.requestId };
  }

  /** 每次发送 HTTP 之前先落盘 dispatching；写失败零外发并保守 hold。 */
  private persist(): string | null {
    try {
      this.journal.records = [...this.operations.values()];
      this.journal.write();
      return null;
    } catch (error: unknown) {
      return error instanceof Error ? error.message : 'journal write failed';
    }
  }

  private async ensurePump(): Promise<void> {
    if (this.pumpRunning) return;
    this.pumpRunning = true;
    try {
      await this.pumpLoop();
    } finally {
      this.pumpRunning = false;
    }
  }

  private async pumpLoop(): Promise<void> {
    while (this.queue.length > 0) {
      if (this.hold) {
        // hold/journal 降级时清空剩余队列：旧条目零 Enter，按本地事实结算。
        this.drainBlockedQueue();
        return;
      }
      const entry = this.queue[0];
      const now = this.clock.wall();
      if (now > entry.deadlineWall) {
        this.queue.shift();
        this.settleNeverDispatched(entry.requestId, 'l-queue-expired-never-dispatched', now);
        continue;
      }
      const intervalRemaining = this.lastDispatchWall + this.dispatchIntervalMs - now;
      if (intervalRemaining > 0) {
        await sleep(intervalRemaining);
        continue;
      }
      this.queue.shift();
      await this.dispatchOne(entry);
    }
  }

  /** hold/降级时把剩余排队条目结算为「从未派发」；这不是 sender 终态证明。 */
  private drainBlockedQueue(): void {
    const now = this.clock.wall();
    while (this.queue.length > 0) {
      const entry = this.queue.shift()!;
      const operation = this.operations.get(entry.requestId);
      if (operation === undefined || operation.outcome !== null) continue;
      const expired = now > entry.deadlineWall;
      this.operations.set(entry.requestId, {
        ...operation,
        outcome: 'terminal_not_dispatched',
        outcomeReason: expired
          ? 'l-queue-expired-never-dispatched'
          : this.journalDegraded ? 'journal-degraded-never-dispatched' : 'hold-during-queue-never-dispatched',
        senderProofApplied: false,
        updatedAt: now,
      });
    }
    if (this.persist() !== null) this.journalDegraded = true;
  }

  /** 本地事实的「从未派发」结算（零 HTTP、零 Enter；不是 sender 终态证明）。 */
  private settleNeverDispatched(requestId: string, reason: string, now: number): void {
    const operation = this.operations.get(requestId);
    if (operation === undefined || operation.outcome !== null) return;
    const next: OriginalOperation = {
      ...operation,
      outcome: 'terminal_not_dispatched',
      outcomeReason: reason,
      senderProofApplied: false,
      updatedAt: now,
    };
    this.operations.set(requestId, next);
    if (this.persist() !== null) this.journalDegraded = true;
  }

  private async dispatchOne(entry: QueueEntry): Promise<void> {
    const requestId = entry.requestId;
    const operation = this.operations.get(requestId);
    if (operation === undefined) return;
    const now = this.clock.wall();
    const grant = this.grants.active;
    // 出队前核绑定与资格；条目固定原 grant，新 grant 不接管旧队列。
    if (grant === null || grant.grantId !== operation.binding.grantId || !this.grants.isUsable(operation.binding.grantId, now)
      || this.grants.liveEpoch !== operation.binding.liveEpoch) {
      this.settleNeverDispatched(requestId, 'grant-invalidated-before-dispatch', now);
      return;
    }
    const snapshot = operation.binding.snapshot;
    if (!snapshot || grant.snapshot !== snapshot) {
      this.settleNeverDispatched(requestId, 'grant-snapshot-missing-or-changed', now);
      return;
    }
    const binding: BindingTuple = {
      ...snapshot,
      processNonce: snapshot.senderProcessNonce,
      identityGeneration: snapshot.identityEpoch,
    };
    const dispatching: OriginalOperation = { ...operation, phase: 'dispatching', updatedAt: now };
    this.operations.set(requestId, dispatching);
    const journalError = this.persist();
    if (journalError !== null) {
      // 持久化失败：零外发，保守 hold，不丢原不确定性。
      this.operations.set(requestId, {
        ...dispatching,
        phase: 'dispatching',
        outcome: 'unknown',
        outcomeReason: 'journal-write-failed-before-dispatch',
        updatedAt: this.clock.wall(),
      });
      this.journalDegraded = true;
      this.holdAll = true;
      return;
    }
    if (this.hold) {
      // 等待期间出现新的 unknown：本条不再派发，也不冒充已派发。
      this.operations.set(requestId, {
        ...dispatching,
        phase: 'queued',
        outcome: 'terminal_not_dispatched',
        outcomeReason: 'hold-during-queue-never-dispatched',
        updatedAt: this.clock.wall(),
      });
      this.persist();
      return;
    }
    const grantNow = this.grants.active;
    if (grantNow === null || grantNow.grantId !== operation.binding.grantId) {
      // 队列等待期间授权被撤销：零 Enter，按本地事实结算。
      this.operations.set(requestId, {
        ...dispatching,
        phase: 'queued',
        outcome: 'terminal_not_dispatched',
        outcomeReason: 'grant-revoked-before-dispatch',
        updatedAt: this.clock.wall(),
      });
      this.persist();
      return;
    }
    // 发送前核对 sender 当前状态与授权快照一致：不一致即授权已失效，
    // 按本地事实结算为未派发；绝不以最新代次修补绑定（F1/F4）。
    const senderAlive = await this.assertGrantActiveOnSender(grant);
    if (senderAlive === 'unavailable') {
      this.settle(requestId, applyDispatchOutcome(this.operations.get(requestId)!, {
        kind: 'transport_unknown',
        reason: 'sender-state-unavailable-before-dispatch',
        trustedSender: false,
      }, this.clock.wall()));
      this.enterUnknownHold();
      return;
    }
    if (senderAlive === 'mismatch') {
      this.settleNeverDispatched(requestId, 'grant-invalidated-before-dispatch', this.clock.wall());
      return;
    }
    if (!this.grants.isUsable(operation.binding.grantId, this.clock.wall()) || this.grants.active?.snapshot !== snapshot || this.hold) {
      this.settleNeverDispatched(requestId, 'grant-invalidated-after-state-check', this.clock.wall());
      return;
    }
    const finalBinding: BindingTuple = binding;
    this.lastDispatchWall = this.clock.wall();
    const response = await this.gateway.send({
      requestId,
      sourceKey: operation.sourceKey,
      binding: finalBinding,
      text: entry.text,
      autoEvent: entry.autoEventClaim,
    }).catch((): { ok: false; error: string; untrusted: boolean } => ({
      ok: false,
      error: 'send gateway threw',
      untrusted: false,
    }));
    const current = this.operations.get(requestId)!;
    if (response.ok) {
      const wire = response.value;
      if (wire.status === 'dispatched') {
        this.settle(requestId, applyDispatchOutcome(current, {
          kind: 'dispatched',
          reason: 'sender-dispatched',
          trustedSender: true,
          pageSubmitted: wire.pageSubmitted,
        }, this.clock.wall()));
      } else {
        const query = await this.gateway.operation(requestId).catch(() => ({ ok: false as const, error: 'operation query failed', untrusted: false }));
        const original = this.operations.get(requestId)!;
        if (query.ok && this.matchesSenderOperation(original, query.value) && query.value.found
          && query.value.executionTerminated && query.value.enterNeverCalled && !query.value.enterAttempted
          && !query.value.pageSubmitted && query.value.finishedAt !== null) {
          this.settle(requestId, applyDispatchOutcome(original, {
            kind: 'terminal_not_dispatched', reason: 'sender-verified-terminal', trustedSender: true,
            proof: { executionEnded: true, enterNeverCalled: true, senderProcessNonce: query.value.senderProcessNonce, recordedAt: query.value.finishedAt },
          }, this.clock.wall()));
        } else {
          this.settle(requestId, applyDispatchOutcome(original, { kind: 'transport_unknown', reason: 'sender-terminal-unverified', trustedSender: false }, this.clock.wall()));
        }
      }
    } else if (response.untrusted) {
      this.settle(requestId, applyDispatchOutcome(current, {
        kind: 'transport_unknown',
        reason: `untrusted-response:${response.error}`,
        trustedSender: false,
      }, this.clock.wall()));
      this.enterUnknownHold();
    } else {
      this.settle(requestId, applyDispatchOutcome(current, {
        kind: 'transport_unknown',
        reason: `transport:${response.error}`,
        trustedSender: false,
      }, this.clock.wall()));
      this.enterUnknownHold();
    }
    if (this.operations.get(requestId)?.outcome === 'unknown') this.enterUnknownHold();
  }

  private settle(requestId: string, next: OriginalOperation): void {
    this.operations.set(requestId, next);
    const journalError = this.persist();
    if (journalError !== null) {
      // 结果落盘失败：保留内存事实，保守 hold；绝不在晚到的成功后丢失不确定性。
      this.journalDegraded = true;
      this.holdAll = true;
    }
  }

  private enterUnknownHold(): void {
    this.holdAll = true;
    this.revokeGrant('unknown-hold');
  }

  /**
   * 派发前核对 sender 当前状态与授权快照逐项一致（nonce/Session/房间/
   * 连接代/资格 token 仍是本 grant）。返回 mismatch 时零外发；
   * unavailable（状态不可得）按传输 unknown 处理。这里只核对，不修补。
   */
  private async assertGrantActiveOnSender(grant: GrantRecord): Promise<'ok' | 'mismatch' | 'unavailable'> {
    const result = await this.gateway.state().catch(() => null);
    if (result === null || !result.ok) return 'unavailable';
    const state = result.value;
    if (state.session === null || !state.session.connected) return 'mismatch';
    if (state.processNonce !== grant.qualification.senderProcessNonce) return 'mismatch';
    if (state.session.sessionId !== grant.qualification.sessionId) return 'mismatch';
    if (state.session.roomId !== this.deployment.roomId) return 'mismatch';
    if (state.senderConnectionGeneration !== grant.qualification.senderConnectionGeneration) return 'mismatch';
    if (state.qualification.state !== 'captured' || state.qualification.qualificationToken !== grant.qualification.qualificationToken
      || !grant.snapshot || state.activeAuthorizationId !== grant.snapshot.authorizationId) return 'mismatch';
    return 'ok';
  }

  /** ---------- 核对事实与恢复 ---------- */

  /**
   * owner 显式追加核对事实：引用必须含原 requestId、主体、房间、发送/直播代次。
   * 备注/未看到不是未发送证明；正面观察单独记录。
   */
  recordVerificationFact(input: {
    requestId: string;
    principalUid: string;
    roomId: string;
    grantId: string;
    liveEpoch: string;
    inputConnectionGeneration: number;
    fact: unknown;
    ref?: MessageRef;
    factId?: string;
    observationSource?: { source: 'owner' | 'designated-viewer'; observerRef: string | null };
  }): AppendFactResult | { ok: true; duplicate: boolean; factsRevision: number } {
    if (this.frozenCore) {
      const required = ['requestId', 'principalUid', 'roomId', 'grantId', 'liveEpoch', 'inputConnectionGeneration', 'fact', 'ref', 'factId'];
      const allowed = [...required, 'observationSource'];
      if (!isObject(input) || required.some((key) => !Object.hasOwn(input, key)) || Object.keys(input).some((key) => !allowed.includes(key)) ||
        (input.observationSource !== undefined && (!isObject(input.observationSource) ||
          Object.keys(input.observationSource).length !== 2 || !Object.hasOwn(input.observationSource, 'source') ||
          !Object.hasOwn(input.observationSource, 'observerRef')))) return { ok: false, error: '核对事实格式无效' };
      const ref = input.ref;
      if (!validateMessageRef(ref) || input.requestId !== ref.requestId || input.principalUid !== ref.grant.principalUid ||
        input.roomId !== ref.grant.roomId || input.grantId !== ref.grant.grantId || input.liveEpoch !== ref.grant.liveEpoch ||
        input.inputConnectionGeneration !== ref.grant.inputConnectionGeneration) return { ok: false, error: '原消息引用不符' };
      return this.frozenCore.recordFact(ref, input.factId, input.fact, input.observationSource);
    }
    const operation = this.operations.get(input.requestId);
    if (operation === undefined) return { ok: false, error: '原操作不存在' };
    // 核对引用必须逐项命中持久化的原绑定（requestId 已定位，其余字段显式比对）。
    const referenceMatches = operation.binding.principalUid === input.principalUid
      && operation.binding.roomId === input.roomId
      && operation.binding.grantId === input.grantId
      && operation.binding.liveEpoch === input.liveEpoch
      && operation.binding.inputConnectionGeneration === input.inputConnectionGeneration;
    if (!referenceMatches) return { ok: false, error: '核对引用与原操作绑定不符' };
    const fact = validateFactInput(input.fact);
    if (!fact.ok) return { ok: false, error: fact.error };
    const result = appendFact(operation, fact.value as FactInput, this.clock.wall());
    if (result.ok) {
      this.operations.set(input.requestId, result.operation);
      if (this.persist() !== null) this.journalDegraded = true;
    }
    return result;
  }

  /** owner 显式查询 sender 侧原操作终态并作为受信事实追加（内部通道）。 */
  private matchesSenderOperation(operation: OriginalOperation, wire: import('./protocol').SenderOperationWire): boolean {
    if (!wire.found || !wire.binding || !operation.binding.snapshot) return false;
    const snapshot = operation.binding.snapshot;
    const expected = { ...snapshot, processNonce: snapshot.senderProcessNonce, identityGeneration: snapshot.identityEpoch };
    return wire.requestId === operation.requestId && wire.sourceKey === operation.sourceKey
      && wire.senderProcessNonce === operation.binding.senderProcessNonce
      && controlPayloadHash(wire.binding) === controlPayloadHash(expected);
  }

  async reconcileFromSender(requestId: string): Promise<{ ok: boolean; reason: string }> {
    if (this.frozenCore) return this.frozenCore.reconcileMessage(requestId);
    const operation = this.operations.get(requestId);
    if (operation === undefined) return { ok: false, reason: '原操作不存在' };
    const result = await this.gateway.operation(requestId);
    if (!result.ok) return { ok: false, reason: result.error };
    const wire = result.value;
    if (wire.found === false) {
      // 新进程空表不是 not_found=未发送：仅记录观察，不结算。
      this.appendAndPersist(operation, { kind: 'note', note: 'sender 报告该 requestId 无记录；进程重启后空表不构成未发送证明' });
      return { ok: true, reason: 'noted-empty-sender-record' };
    }
    // 查询响应的 sender nonce 必须与持久化的原 nonce 一致；新进程的记录
    // 不能证明旧进程执行已终止（F1/静态缺口4）。
    if (!this.matchesSenderOperation(operation, wire)) {
      this.appendAndPersist(operation, {
        kind: 'note',
        note: 'sender 进程已更换（nonce 不一致）；其记录不构成原执行终态证明，保持 hold',
      });
      return { ok: true, reason: 'noted-sender-process-changed' };
    }
    const internalFact = validateInternalFactInput({
      kind: 'termination_proof',
      proof: {
        executionEnded: wire.executionTerminated,
        enterNeverCalled: wire.enterNeverCalled,
        senderProcessNonce: wire.senderProcessNonce,
        recordedAt: this.clock.wall(),
      },
    });
    if (!internalFact.ok) return { ok: false, reason: internalFact.error };
    const factResult = this.appendAndPersist(operation, internalFact.value);
    return factResult.ok ? { ok: true, reason: factResult.settled ? 'settled' : 'recorded' } : { ok: false, reason: factResult.error };
  }

  async reconcileFrozenMessage(requestId: string): Promise<{ ok: boolean; reason: string; controlId?: string }> {
    if (!this.frozenCore) return { ok: false, reason: 'frozen-sender-unavailable' };
    return this.frozenCore.startRecovery(requestId);
  }

  /** 追加事实并持久化（内部统一入口）。 */
  private appendAndPersist(operation: OriginalOperation, fact: FactInput | InternalFactInput): AppendFactResult {
    const result = appendFact(operation, fact, this.clock.wall());
    if (result.ok) {
      this.operations.set(operation.requestId, result.operation);
      if (this.persist() !== null) {
        this.journalDegraded = true;
        return { ok: false, error: 'journal-write-failed' };
      }
    }
    return result;
  }

  /** 只有全部 unknown 都有「原执行已终止」受信事实时才允许恢复新发送。 */
  requestResumeAfterReconciliation(): ReconciliationState {
    if (this.frozenCore) return this.frozenCore.reconciliationState();
    const state = reconcileHold([...this.operations.values()]);
    if (this.journal.corrupt || this.journalDegraded || this.controlRecoveryHold()) return { ...state, safeToResume: false };
    if (state.safeToResume) this.holdAll = false;
    return state;
  }

  /** ---------- 重启恢复与视图 ---------- */

  private restartRecovery(): void {
    if (this.journal.corrupt) {
      this.holdAll = true;
      return;
    }
    const now = this.clock.wall();
    let changed = false;
    const recovered = this.journal.records.map((record) => {
      const next = applyRestartRecovery(record, now, null);
      if (next !== record) changed = true;
      return next;
    });
    this.operations = new Map(recovered.map((record) => [record.requestId, record]));
    for (const record of recovered) {
      if (record.sourceKey !== null) this.sourceKeyIndex.set(record.sourceKey, record.requestId);
    }
    // 重启：无授权恢复、无队列重放；未决 dispatching 全部保守 hold。
    this.holdAll = recovered.some((record) => record.outcome === 'unknown');
    if (changed) {
      this.journal.records = recovered;
      try {
        this.journal.write();
      } catch {
        this.journalDegraded = true;
        this.holdAll = true;
      }
    }
    this.queue = [];
  }

  operationView(requestId: string): OriginalOperation | null {
    return this.operations.get(requestId) ?? null;
  }

  frozenOperationView(requestId: string): FrozenJournalMessage | null {
    return this.frozenCore?.operation(requestId) ?? null;
  }

  listFrozenOperations(): FrozenJournalMessage[] {
    return this.frozenCore?.operations() ?? [];
  }

  listFrozenControls(): ReturnType<FrozenControllerCore['controls']> {
    return this.frozenCore?.controls() ?? [];
  }

  listOperations(): OriginalOperation[] {
    return [...this.operations.values()];
  }
}
