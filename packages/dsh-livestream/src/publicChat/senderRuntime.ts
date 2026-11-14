/**
 * 独立 sender 运行时（FEAT-008 API-2/3/4/8；F1/F2/F4 纠正版）。
 *
 * 粘性授权模型（F4 最小实现，不改 v1 路由面）：
 *  - 每次成功采证签发不可复用 `qualificationToken`；grantId 必须取自它。
 *  - `identityEpoch` 在撤销、每次采证开始、连接变化、会话替换时推进；
 *    token 只在签发时的 epoch 内有效——撤销/重新采证后旧请求永久失效。
 *  - send 校验绑定与签发快照一致（nonce/Session/房间/连接代/身份代/token），
 *    不接受「最新代次修补」。
 * 采证防迟到（F2）：采证修订号覆盖撤权/新采证/连接/会话；每个 await
 * 返回与发布前都复核，旧结果不得发布、并发采集互相作废。
 * 受控发送走实际 patched `LiveSession.sendChat` 内部队列（T001 装配）：
 * glue 的 enqueueControlledSend 把受控流程注入原队列执行。
 */

import { createHash, randomBytes } from 'node:crypto';
import { GrantAuthority, controlPayloadHash, type AuthorizeRequest, type RevokeRequest, type ControlResult, type GrantSnapshot } from './grantAuthority';
import { PUBLIC_CHAT_PROTOCOL, type Clock, defaultClock, type SenderStateWire, type QualificationWire, type SendResponseWire, type SenderOperationWire, type SendRequestWire } from './protocol';
import { validateBindingTuple, type BindingTuple } from './binding';
import { isQualificationFresh, verifyProfileCapture, type ProfileCaptureRaw, type PrincipalProof } from './identity';
import { RawProofStore } from './rawProof';
import { runGuardedSendChat, BindingLostError, InputResidualError, isPostEnterError, type ChatSessionPort, type SendGuard } from './guardedSend';
import { validatePublicText } from './textPolicy';

export interface SenderDeployment {
  buildDigest: string;
  instanceId: string;
  expectedPrincipalUid: string;
  roomId: string;
  accountRecordId: string;
  profileOrigin: string;
}

export interface SenderSessionInfo {
  sessionId: string;
  roomId: string;
  contextId: string;
}

/** 由固定 DyHub 副本 patch 提供的浏览器侧适配。 */
export interface SenderRuntimePort {
  /** 当前发送会话；null 表示未建立。 */
  currentSession(): SenderSessionInfo | null;
  /** 当前会话页面 URL（用于固定房间页面核对）；未建立时 null。 */
  currentSessionPageUrl(): string | null;
  /** 同 Context 当前认证 Cookie 摘要；值不出进程。 */
  authCookieDigest(): Promise<{ digest: string; generation: number } | null>;
  /** 同 Context 专属 probe page 采集本人资料响应（页面自身发起的请求）。 */
  captureProfile(): Promise<ProfileCaptureRaw | null>;
  /**
   * 构建绑定 guard 的受控发送端口；端口内部的每个 await 边界（含
   * clearInput 的多步循环）都必须复核 guard 与当前页面房间。
   */
  sendPort(sessionId: string, guard: SendGuard): ChatSessionPort | null;
  /**
   * 把受控发送流程注入实际 patched `LiveSession.sendChat` 内部队列执行
   * （SendChatControl.execute）。run 闭包自持 sendPort(guard) 构建的端口；
   * 返回原队列的 Promise。未建立时返回 null。
   */
  enqueueControlledSend(sessionId: string, run: () => Promise<unknown>): Promise<unknown> | null;
}

interface SenderOperationRecord {
  requestId: string;
  senderProcessNonce: string;
  sourceKey: string | null;
  binding: SendRequestWire['binding'];
  requestHash: string;
  enterAttempted: boolean;
  executionTerminated: boolean;
  enterNeverCalled: boolean;
  pageSubmitted: boolean;
  finishedAt: number | null;
}

/** 发布的资格：证明 + 签发令牌 + 签发时代次快照。 */
interface PublishedQualification extends PrincipalProof {
  qualificationToken: string;
  identityEpoch: number;
  senderConnectionGeneration: number;
}

const OPERATION_RECORD_LIMIT = 128;
const FIXED_ROOM_PAGE_PATTERN = /^https:\/\/live\.douyin\.com\/([0-9]{1,64})$/;

export type SenderSendResult = SendResponseWire;

export class SenderRuntime {
  private readonly port: SenderRuntimePort;
  private readonly deployment: SenderDeployment;
  private readonly clock: Clock;
  readonly processNonce = randomBytes(16).toString('hex');
  private readonly rawProofs: RawProofStore;
  private readonly authority: GrantAuthority;
  private currentCaptureId: string | null = null;
  private readonly captures = new Map<string, Promise<QualificationWire>>();
  private session: SenderSessionInfo | null = null;
  private connected = false;
  private connectionGeneration = 0;
  /** 身份代次：撤销/采证开始/连接变化/会话替换时推进（F2/F4 粘性）。 */
  private identityEpoch = 0;
  private qualification: PublishedQualification | null = null;
  private hold = false;
  private readonly operations = new Map<string, SenderOperationRecord>();
  private readonly sourceOperations = new Map<string, string>();
  private activeSend: string | null = null;

  constructor(deps: { deployment: SenderDeployment; port: SenderRuntimePort; clock?: Clock }) {
    this.deployment = deps.deployment;
    this.port = deps.port;
    this.clock = deps.clock ?? defaultClock();
    this.rawProofs = new RawProofStore(this.clock);
    this.authority = new GrantAuthority(this.processNonce, 1024, () => this.clock.wall());
  }

  /** ---------- glue 通知（全部同步推进） ---------- */

  /** 真实 CDP/页面回调：任何 down/up 都推进代次并废弃旧资格。 */
  notifyConnectionChange(connected = false): void {
    this.authority.invalidateActive();
    this.connected = connected;
    this.connectionGeneration += 1;
    this.identityEpoch += 1;
    this.qualification = null;
  }

  /** 会话建立或替换：代次推进、旧资格作废。 */
  notifySessionEstablished(info: SenderSessionInfo): void {
    this.authority.invalidateActive();
    this.session = info;
    this.connected = false;
    this.connectionGeneration += 1;
    this.identityEpoch += 1;
    this.qualification = null;
  }

  notifySessionClosed(): void {
    this.authority.invalidateActive();
    this.session = null;
    this.connected = false;
    this.connectionGeneration += 1;
    this.identityEpoch += 1;
    this.qualification = null;
  }

  /** 归一化前的 raw hook：只采集有界短期证明，不替换匿名采集。 */
  notifyRawMessage(input: { rawId: string; rawType: string; roomId: string; rawCreateTime: unknown }): void {
    if (input.roomId !== this.deployment.roomId || !this.connected || this.session?.roomId !== input.roomId) return;
    this.rawProofs.capture({
      rawId: input.rawId,
      rawType: input.rawType,
      roomId: input.roomId,
      senderConnectionGeneration: this.connectionGeneration,
      grantId: this.authority.active?.grantId ?? null,
      rawCreateTime: input.rawCreateTime,
      receivedAt: this.clock.wall(),
    });
  }

  private sessionMatchesPort(session: SenderSessionInfo): boolean {
    const current = this.port.currentSession();
    return current !== null && current.sessionId === session.sessionId
      && current.contextId === session.contextId && current.roomId === session.roomId;
  }

  /** ---------- v1 处理 ---------- */

  state(): SenderStateWire {
    const session = this.session;
    return {
      protocol: PUBLIC_CHAT_PROTOCOL,
      buildDigest: this.deployment.buildDigest,
      instanceId: this.deployment.instanceId,
      processNonce: this.processNonce,
      senderConnectionGeneration: this.connectionGeneration,
      capabilities: ['explicit-grant-snapshot-v1'],
      activeAuthorizationId: this.authority.active?.authorizationId ?? null,
      session: session === null ? null : { sessionId: session.sessionId, roomId: session.roomId, connected: this.connected },
      qualification: this.qualification === null
        ? { state: 'none', capturedAt: null, principalUid: null, qualificationToken: null }
        : {
          state: 'captured',
          capturedAt: this.qualification.capturedAt,
          principalUid: this.qualification.principalUid,
          qualificationToken: this.qualification.qualificationToken,
        },
      hold: this.hold,
    };
  }

  /**
   * 资格采集：先撤现有资格（受保护维护前提），再同 Context 取证。
   * 采证修订 = 身份代次快照；每次 await 返回与发布前复核，迟到的旧采集
   * 不能发布，并发采集互相作废（F2）。
   */
  async refreshQualification(): Promise<QualificationWire> {
    this.authority.invalidateActive();
    this.qualification = null;
    if (this.hold) return { qualified: false, reason: 'hold-unknown-pending' };
    const session = this.session;
    if (session === null || !this.connected || session.roomId !== this.deployment.roomId) {
      return { qualified: false, reason: 'identity_unverified:no-session' };
    }
    const pageUrl = this.port.currentSessionPageUrl();
    if (pageUrl === null || !FIXED_ROOM_PAGE_PATTERN.test(pageUrl) || !pageUrl.endsWith(`/${this.deployment.roomId}`)) {
      return { qualified: false, reason: 'identity_unverified:not-on-fixed-room' };
    }
    // 采证修订快照：采证开始即推进身份代次，作废一切旧授权。
    const captureStartEpoch = ++this.identityEpoch;
    const captureStartGeneration = this.connectionGeneration;
    const captureStartSession = session;
    const assertCaptureAlive = (): string | null => {
      if (this.identityEpoch !== captureStartEpoch) return 'superseded-capture-or-revoked';
      if (this.connectionGeneration !== captureStartGeneration) return 'connection-changed-during-capture';
      if (!this.connected) return 'connection-down-during-capture';
      if (this.session !== captureStartSession) return 'session-changed-during-capture';
      if (!this.sessionMatchesPort(captureStartSession)) return 'context-changed-during-capture';
      if (this.port.currentSessionPageUrl() !== `https://live.douyin.com/${this.deployment.roomId}`) return 'page-changed-during-capture';
      return null;
    };

    const stale = assertCaptureAlive();
    if (stale !== null) return { qualified: false, reason: `identity_unverified:${stale}` };
    const capture = await this.port.captureProfile();
    let staleReason = assertCaptureAlive();
    if (staleReason !== null) return { qualified: false, reason: `identity_unverified:${staleReason}` };
    if (capture === null) return { qualified: false, reason: 'identity_unverified:capture-failed' };
    const verified = verifyProfileCapture(capture, {
      profileOrigin: this.deployment.profileOrigin,
      expectedPrincipalUid: this.deployment.expectedPrincipalUid,
      roomId: this.deployment.roomId,
      now: this.clock.wall(),
    });
    if (!verified.ok) return { qualified: false, reason: `identity_unverified:${verified.reason}` };
    staleReason = assertCaptureAlive();
    if (staleReason !== null) return { qualified: false, reason: `identity_unverified:${staleReason}` };
    const digest = await this.port.authCookieDigest();
    staleReason = assertCaptureAlive();
    if (staleReason !== null) return { qualified: false, reason: `identity_unverified:${staleReason}` };
    if (digest === null || digest.digest !== verified.proof.authCookieDigest || digest.generation !== verified.proof.authCookieGeneration) {
      return { qualified: false, reason: 'identity_unverified:cookie-digest-mismatch' };
    }
    // 采集与会话信息不一致时拒绝（同一 Context 才有资格）。
    if (capture.sessionId !== session.sessionId || capture.contextId !== session.contextId) {
      return { qualified: false, reason: 'identity_unverified:context-mismatch' };
    }
    // 发布前最后一次复核（无并发 await 之后仅同步事实）。
    staleReason = assertCaptureAlive();
    if (staleReason !== null) return { qualified: false, reason: `identity_unverified:${staleReason}` };
    const qualificationToken = randomBytes(16).toString('hex');
    this.qualification = {
      ...verified.proof,
      authCookieGeneration: digest.generation,
      qualificationToken,
      identityEpoch: captureStartEpoch,
      senderConnectionGeneration: captureStartGeneration,
    };
    return {
      qualified: true,
      principalUid: this.qualification.principalUid,
      contextId: this.qualification.contextId,
      sessionId: this.qualification.sessionId,
      authCookieDigest: this.qualification.authCookieDigest,
      authCookieGeneration: this.qualification.authCookieGeneration,
      capturedAt: this.qualification.capturedAt,
      profileOrigin: this.qualification.profileOrigin,
      profileStatus: this.qualification.profileStatus,
      qualificationToken: this.qualification.qualificationToken,
      identityEpoch: this.qualification.identityEpoch,
      senderProcessNonce: this.processNonce,
      senderConnectionGeneration: this.qualification.senderConnectionGeneration,
    };
  }

  /** A capture ID is stable within this sender process; retries reuse its result. */
  captureQualification(captureId: string, expectedSenderProcessNonce: string): Promise<QualificationWire> {
    if (!captureId || captureId.length > 128 || expectedSenderProcessNonce !== this.processNonce) {
      return Promise.resolve({ qualified: false, reason: 'invalid-capture' });
    }
    if (this.authority.operation(captureId) !== null) return Promise.resolve({ qualified: false, reason: 'id-conflict' });
    if (this.authority.captureCancelled(captureId)) return Promise.resolve({ qualified: false, reason: 'capture-revoked' });
    const prior = this.captures.get(captureId);
    if (prior) return prior;
    if (this.captures.size >= 1024) return Promise.resolve({ qualified: false, reason: 'capture-capacity' });
    this.currentCaptureId = captureId;
    this.authority.invalidateActive();
    const pending = this.refreshQualification().then((result): QualificationWire => {
      if (this.authority.captureCancelled(captureId)) return { qualified: false, reason: 'capture-revoked' };
      return result;
    });
    this.captures.set(captureId, pending);
    return pending;
  }

  async authorizeGrant(input: AuthorizeRequest): Promise<ControlResult> {
    const request = structuredClone(input);
    if (this.captures.has(request?.authorizationId)) return { registered: false, reason: 'conflict' };
    const existing = this.authority.operation(request?.authorizationId);
    if (existing !== null) {
      return existing.kind === 'authorize' && existing.payloadHash === controlPayloadHash(request)
        ? { registered: true, record: existing }
        : { registered: false, reason: 'conflict' };
    }
    if (this.authority.authorizationCancelled(request?.authorizationId) || this.authority.captureCancelled(request?.target?.captureId)) {
      return this.authority.authorize(request, async () => false, () => false);
    }
    const qualification = this.qualification;
    const session = this.session;
    const target = request?.target;
    if (!qualification || !session || !target || this.currentCaptureId !== target.captureId) return { registered: false, reason: 'invalid' };
    const qualificationDigest = createHash('sha256').update(qualification.qualificationToken).digest('hex');
    const matches = (): boolean => this.qualification === qualification && isQualificationFresh(qualification, this.clock.wall()) && this.session === session && this.connected
      && this.sessionMatchesPort(session)
      && this.currentCaptureId === target.captureId
      && target.version === PUBLIC_CHAT_PROTOCOL
      && target.buildDigest === this.deployment.buildDigest && target.instanceId === this.deployment.instanceId
      && target.senderProcessNonce === this.processNonce && target.accountRecordId === this.deployment.accountRecordId
      && target.principalUid === qualification.principalUid && target.roomId === this.deployment.roomId
      && target.browserContextId === qualification.contextId && target.senderSessionId === session.sessionId
      && target.senderConnectionGeneration === this.connectionGeneration && target.identityEpoch === this.identityEpoch
      && target.qualificationRevision === qualification.identityEpoch && target.authCookieGeneration === qualification.authCookieGeneration
      && target.qualificationDigest === qualificationDigest && request.qualificationToken === qualification.qualificationToken
      && this.port.currentSessionPageUrl() === `https://live.douyin.com/${this.deployment.roomId}`;
    if (!matches()) return { registered: false, reason: 'invalid' };
    return this.authority.authorize(request, async () => {
      const digest = await this.port.authCookieDigest();
      return digest !== null && digest.digest === qualification.authCookieDigest
        && digest.generation === qualification.authCookieGeneration;
    }, matches);
  }

  revokeControl(request: RevokeRequest): ControlResult {
    if (this.captures.has(request?.revokeId)) return { registered: false, reason: 'conflict' };
    const prior = request?.target?.kind === 'authorization' ? this.authority.operation(request.target.authorizationId) : null;
    const slotId = this.authority.currentAuthorizationId;
    const result = this.authority.revoke(request);
    const cancelsCurrentCapture = request.target.kind === 'capture' && request.target.captureId === this.currentCaptureId;
    const cancelsCurrentAuthorization = request.target.kind === 'authorization' && prior?.kind === 'authorize'
      && prior.target.captureId === this.currentCaptureId && (slotId === null || slotId === prior.id);
    if (result.registered && (cancelsCurrentCapture || cancelsCurrentAuthorization)) {
      this.currentCaptureId = null;
      this.identityEpoch += 1;
      this.qualification = null;
    }
    return result;
  }

  controlOperation(id: string) {
    return this.authority.operation(id);
  }

  revoke(reason: string): SenderStateWire {
    this.authority.invalidateActive();
    // 撤销推进身份代次：旧 token 永久失效（粘性撤权，F4）。
    this.identityEpoch += 1;
    this.qualification = null;
    if (reason === 'unknown-hold') this.hold = true;
    // Enter 已调用在途副作用不可撤回；旧队列（本端仅单在途）没有待派发条目。
    return this.state();
  }

  /** 受信 sender 侧原操作查询（供 owner 核对终态）。 */
  operation(requestId: string): SenderOperationWire {
    const record = this.operations.get(requestId);
    if (record === undefined) return { found: false };
    return {
      found: true,
      requestId: record.requestId,
      senderProcessNonce: record.senderProcessNonce,
      sourceKey: record.sourceKey,
      binding: record.binding,
      enterAttempted: record.enterAttempted,
      executionTerminated: record.executionTerminated,
      enterNeverCalled: record.enterNeverCalled,
      pageSubmitted: record.pageSubmitted,
      finishedAt: record.finishedAt,
    };
  }

  /** 受控发送：校验签发快照 → 注入实际 patched Session 原队列执行。 */
  async send(input: SendRequestWire): Promise<SenderSendResult> {
    const request = structuredClone(input);
    const requestHash = controlPayloadHash(request);
    const duplicate = this.operations.get(request.requestId);
    if (duplicate !== undefined) {
      if (duplicate.requestHash !== requestHash) return { status: 'rejected', reason: 'request-id-conflict' };
      // 重复 requestId 只查原操作，不再按 Enter。
      if (duplicate.executionTerminated && duplicate.enterNeverCalled) {
        return {
          status: 'terminal_not_dispatched',
          proof: {
            executionEnded: true,
            enterNeverCalled: true,
            senderProcessNonce: duplicate.senderProcessNonce,
            recordedAt: duplicate.finishedAt ?? this.clock.wall(),
          },
        };
      }
      if (duplicate.enterAttempted) {
        return { status: 'dispatched', enterAttempted: true, pageSubmitted: duplicate.pageSubmitted };
      }
      // 记录状态不完整时保守上报：L 侧会因证明不完整继续按 unknown 处理。
      return {
        status: 'terminal_not_dispatched',
        proof: {
          executionEnded: duplicate.executionTerminated,
          enterNeverCalled: false,
          senderProcessNonce: duplicate.senderProcessNonce,
          recordedAt: duplicate.finishedAt ?? this.clock.wall(),
        },
      };
    }
    if (this.activeSend !== null) {
      return { status: 'rejected', reason: 'single-in-flight' };
    }
    if (request.sourceKey !== null && this.sourceOperations.has(request.sourceKey)) return { status: 'rejected', reason: 'source-already-used' };
    if (this.operations.size >= OPERATION_RECORD_LIMIT) return { status: 'rejected', reason: 'operation-capacity' };
    this.activeSend = request.requestId;
    this.operations.set(request.requestId, {
      requestId: request.requestId, senderProcessNonce: this.processNonce, sourceKey: request.sourceKey,
      binding: request.binding, requestHash, enterAttempted: false, executionTerminated: false,
      enterNeverCalled: true, pageSubmitted: false, finishedAt: null,
    });
    if (request.sourceKey !== null) this.sourceOperations.set(request.sourceKey, request.requestId);
    let enterAttempted = false;
    try {
      const rejected = await this.validateSend(request);
      if (rejected !== null) {
        this.recordOperation(request.requestId, { enterAttempted: false, executionTerminated: true, enterNeverCalled: true, pageSubmitted: false });
        return { status: 'rejected', reason: rejected };
      }
      const qualificationAtStart = this.qualification;
      const sessionAtStart = this.session;
      const grantAtStart = this.authority.active;
      if (qualificationAtStart === null || sessionAtStart === null || grantAtStart === null || !matchesGrantSnapshot(request.binding, grantAtStart)) {
        this.recordOperation(request.requestId, { enterAttempted: false, executionTerminated: true, enterNeverCalled: true, pageSubmitted: false });
        return { status: 'rejected', reason: 'not-qualified' };
      }
      const guardGeneration = this.connectionGeneration;
      const guardEpoch = this.identityEpoch;
      const guardSession = sessionAtStart.sessionId;
      const guardQualification = qualificationAtStart;
      const guardGrant = this.authority.active;
      const guardPageUrl = this.port.currentSessionPageUrl();
      const makeLost = (): BindingLostError => new BindingLostError(enterAttempted, 'interval-wait');
      const guard: SendGuard = {
        assertValid: async (): Promise<void> => {
          if (guardGrant === null || this.authority.active !== guardGrant) throw makeLost();
          if (this.qualification !== guardQualification || this.qualification === null) throw makeLost();
          if (this.identityEpoch !== guardEpoch) throw makeLost();
          if (this.connectionGeneration !== guardGeneration) throw makeLost();
          if (!this.connected) throw makeLost();
          if (this.session === null || this.session.sessionId !== guardSession) throw makeLost();
          if (!this.sessionMatchesPort(sessionAtStart)) throw makeLost();
          const pageUrl = this.port.currentSessionPageUrl();
          if (pageUrl === null || pageUrl !== guardPageUrl) throw makeLost();
          const digest = await this.port.authCookieDigest();
          if (digest === null || digest.digest !== guardQualification.authCookieDigest || digest.generation !== guardQualification.authCookieGeneration) {
            if (this.qualification === guardQualification) {
              this.authority.invalidateActive();
              this.qualification = null;
              this.identityEpoch += 1;
            }
            throw makeLost();
          }
        },
        assertValidSync: (): void => {
          // 无 await：撤权/重采/连接/会话变化都是本进程同步状态。
          if (guardGrant === null || this.authority.active !== guardGrant) throw makeLost();
          if (this.qualification !== guardQualification || this.qualification === null) throw makeLost();
          if (this.identityEpoch !== guardEpoch) throw makeLost();
          if (this.connectionGeneration !== guardGeneration) throw makeLost();
          if (!this.connected) throw makeLost();
          if (this.session === null || this.session.sessionId !== guardSession) throw makeLost();
          if (!this.sessionMatchesPort(sessionAtStart)) throw makeLost();
          const pageUrl = this.port.currentSessionPageUrl();
          if (pageUrl === null || pageUrl !== guardPageUrl) throw makeLost();
        },
      };
      const sessionPort = this.port.sendPort(sessionAtStart.sessionId, guard);
      if (sessionPort === null) {
        this.recordOperation(request.requestId, { enterAttempted: false, executionTerminated: true, enterNeverCalled: true, pageSubmitted: false });
        return { status: 'terminal_not_dispatched', proof: this.terminalProof() };
      }
      // 受控流程经实际 patched sendChat 内部队列执行（SendChatControl.execute）；
      // 端口（含 guard）已由 sendPort 构建并在 run 闭包内使用。
      const queued = this.port.enqueueControlledSend(sessionAtStart.sessionId, () => runGuardedSendChat(sessionPort, {
        text: request.text,
        guard,
        callbacks: {
          onEnterAttempted: () => {
            enterAttempted = true;
            const original = this.operations.get(request.requestId);
            if (original) this.operations.set(request.requestId, { ...original, enterAttempted: true, enterNeverCalled: false });
          },
        },
      }));
      if (queued === null) {
        this.recordOperation(request.requestId, { enterAttempted: false, executionTerminated: true, enterNeverCalled: true, pageSubmitted: false });
        return { status: 'terminal_not_dispatched', proof: this.terminalProof() };
      }
      const outcome = (await queued) as { enterAttempted: boolean; pageSubmitted: boolean };
      this.recordOperation(request.requestId, {
        enterAttempted: true,
        executionTerminated: true,
        enterNeverCalled: false,
        pageSubmitted: outcome.pageSubmitted === true,
      });
      return { status: 'dispatched', enterAttempted: true, pageSubmitted: outcome.pageSubmitted === true };
    } catch (error: unknown) {
      if (error instanceof BindingLostError && !error.enterAttempted) {
        // 原执行已终止且从未 Enter：受信终态。
        this.recordOperation(request.requestId, { enterAttempted: false, executionTerminated: true, enterNeverCalled: true, pageSubmitted: false });
        return { status: 'terminal_not_dispatched', proof: this.terminalProof() };
      }
      if (error instanceof BindingLostError || isPostEnterError(error) || error instanceof InputResidualError) {
        // Enter 已调用：一律 unknown（dispatched + pageSubmitted=false 由 L 细化）。
        this.recordOperation(request.requestId, { enterAttempted: true, executionTerminated: true, enterNeverCalled: false, pageSubmitted: false });
        return { status: 'dispatched', enterAttempted: true, pageSubmitted: false };
      }
      // Enter 前的页面错误：执行终止且未 Enter，受信终态。
      if (!enterAttempted) {
        this.recordOperation(request.requestId, { enterAttempted: false, executionTerminated: true, enterNeverCalled: true, pageSubmitted: false });
        return { status: 'terminal_not_dispatched', proof: this.terminalProof() };
      }
      this.recordOperation(request.requestId, { enterAttempted: true, executionTerminated: true, enterNeverCalled: false, pageSubmitted: false });
      return { status: 'dispatched', enterAttempted: true, pageSubmitted: false };
    } finally {
      this.activeSend = null;
    }
  }

  private terminalProof(): { executionEnded: boolean; enterNeverCalled: boolean; senderProcessNonce: string; recordedAt: number } {
    return {
      executionEnded: true,
      enterNeverCalled: true,
      senderProcessNonce: this.processNonce,
      recordedAt: this.clock.wall(),
    };
  }

  private recordOperation(requestId: string, fields: Pick<SenderOperationRecord, 'enterAttempted' | 'executionTerminated' | 'enterNeverCalled' | 'pageSubmitted'>): void {
    const original = this.operations.get(requestId);
    if (!original) throw new Error('sender operation was not registered');
    this.operations.set(requestId, { ...original, ...fields, finishedAt: this.clock.wall() });
  }

  /**
   * 预派发校验：绑定必须与「授权签发时快照」逐字段一致，且资格仍以同一
   * token/epoch 活着（撤销粘性：重新采证后旧请求零发送，F4）。
   * Cookie 摘要校验含 await——返回后复核资格未被撤销/替换（同 F2 纪律）。
   * 全部通过返回 null，否则返回拒绝原因（零副作用）。
   */
  private async validateSend(request: SendRequestWire): Promise<string | null> {
    if (!validatePublicText(request.text).ok) return 'text-policy-rejected';
    const bindingResult = validateBindingTuple(request.binding);
    if (!bindingResult.ok) return `binding-invalid:${bindingResult.error}`;
    const binding = bindingResult.value;
    const grant = this.authority.active;
    if (grant === null || !matchesGrantSnapshot(request.binding, grant)) return 'grant-not-authorized';
    if (this.hold) return 'hold-unknown-pending';
    if (!this.connected) return 'sender-disconnected';
    if (this.qualification === null) return 'not-qualified';
    const qualificationAtStart = this.qualification;
    const session = this.session;
    if (session === null) return 'no-session';
    if (!bindingMatchesRuntime(binding, this.deployment, session, this.processNonce, this.connectionGeneration)) {
      return 'binding-mismatch';
    }
    // 显式 sender grant 与资格令牌互相独立。
    if (binding.grantId !== grant.grantId) return 'grant-token-stale';
    if (binding.identityGeneration !== qualificationAtStart.identityEpoch) return 'identity-epoch-stale';
    if (binding.principalUid !== qualificationAtStart.principalUid) return 'principal-mismatch';
    const digest = await this.port.authCookieDigest();
    // await 返回后复核资格未被撤销/重新采证（撤权窗口零副作用）。
    if (this.qualification !== qualificationAtStart || this.qualification === null || this.authority.active !== grant || !this.sessionMatchesPort(session)) return 'revoked-during-validation';
    if (digest === null) return 'cookie-digest-unavailable';
    if (digest.digest !== qualificationAtStart.authCookieDigest || digest.generation !== qualificationAtStart.authCookieGeneration) {
      // Cookie 已变化：旧资格立即作废。
      this.authority.invalidateActive();
      this.qualification = null;
      this.identityEpoch += 1;
      return 'cookie-changed';
    }
    const pageUrl = this.port.currentSessionPageUrl();
    if (pageUrl === null || !pageUrl.endsWith(`/${this.deployment.roomId}`) || !FIXED_ROOM_PAGE_PATTERN.test(pageUrl)) {
      return 'not-on-fixed-room';
    }
    if (request.autoEvent !== null) {
      const taken = this.rawProofs.take(request.autoEvent.rawId, {
        rawType: request.autoEvent.rawType,
        senderConnectionGeneration: this.connectionGeneration,
        roomId: grant.roomId,
        now: this.clock.wall(),
        authBoundaryMs: Math.max(grant.authorizedAtMs, grant.liveEpochStartedAtMs),
        grantId: grant.grantId,
      });
      if (!taken.ok) return `auto-event-unavailable:${taken.reason}`;
    }
    return null;
  }
}

function matchesGrantSnapshot(binding: SendRequestWire['binding'], grant: GrantSnapshot): boolean {
  const wire = binding as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(grant)) {
    const wireKey = key === 'senderProcessNonce' ? 'processNonce' : key === 'identityEpoch' ? 'identityGeneration' : key;
    if (wire[wireKey] !== value) return false;
  }
  return true;
}

function bindingMatchesRuntime(
  binding: BindingTuple,
  deployment: SenderDeployment,
  session: SenderSessionInfo,
  processNonce: string,
  connectionGeneration: number,
): boolean {
  return binding.version === PUBLIC_CHAT_PROTOCOL
    && binding.buildDigest === deployment.buildDigest
    && binding.instanceId === deployment.instanceId
    && binding.processNonce === processNonce
    && binding.roomId === deployment.roomId
    && binding.roomId === session.roomId
    && binding.senderSessionId === session.sessionId
    && binding.senderConnectionGeneration === connectionGeneration
    && binding.accountRecordId === deployment.accountRecordId;
}
