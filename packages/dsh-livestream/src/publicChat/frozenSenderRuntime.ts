import { createHash, randomBytes } from 'node:crypto';
import { FrozenControlAuthority, type FrozenAuthorizationRequest, type FrozenRevokeRequest, type FrozenRevokeTarget } from './frozenControl';
import { controlPayloadHash } from './grantAuthority';
import { HelperShutdownUnconfirmedError, launchHelper, type HelperLaunchOptions, type HelperProcess } from './helperLauncher';
import { RoomBindingTracker, type RoomBindingProof } from './roomBinding';
import { RawProofStore, toPlatformEpochMs } from './rawProof';
import { defaultClock, boundedString, safeInteger, type Clock } from './protocol';
import { validatePublicText } from './textPolicy';
import type { FrozenGrantProposal, FrozenGrantSnapshot } from './frozenGrant';
import { FrozenRecoveryAuthority } from './frozenRecovery';
import type { MessageReconcileRequest, RecoveryReceipt } from './recoveryProtocol';
import { helperHttpResponse, type HttpResponseEvidence } from './httpResponse';

export interface FrozenSenderDeployment {
  buildDigest: string;
  instanceId: string;
  accountRecordId: string;
  expectedPrincipalUid: string;
  roomId: string;
}

interface RawPage {
  url(): string;
  context(): object;
}

interface RawMessage {
  method: string;
  msgId: string;
  payload: Uint8Array;
}

interface RawSession {
  page: RawPage;
  sessionId: string;
  contextId: string;
  generation: number;
  tracker: RoomBindingTracker | null;
}

type HelperSettings = Omit<HelperLaunchOptions, 'authContextRevision' | 'onDisconnect'>;
type HelperSettingsSource = HelperSettings | ((authContextRevision: number) => Promise<HelperSettings>);
type RuntimeOperationState = 'dispatching' | 'unknown' | 'terminal_not_dispatched' | 'api_reported_success';

export interface RuntimeOperation {
  requestId: string;
  sourceKey: string;
  hash: string;
  helperPayloadHash: string;
  textDigest: string;
  acceptedAtMs: number | null;
  firstWriteAttemptAtMs: number | null;
  joinedWitnessId: string | null;
  joinedAtMs: number | null;
  factsRevision: number;
  factsDigest: string;
  recoveryControlId: string | null;
  recoveryReceipt: RecoveryReceipt | null;
  httpResponse: HttpResponseEvidence | null;
  grant: FrozenGrantSnapshot;
  state: RuntimeOperationState;
  executionEnded: boolean;
  writeAttempted: boolean;
}

export interface FrozenSendInput {
  requestId: string;
  sourceKey: string;
  grant: FrozenGrantSnapshot;
  text: string;
  autoEvent: { rawId: string; rawType: string } | null;
}

/** 仅发送实例的受信进程内消费者可观察；不是 HTTP 或 helper 接口。 */
export interface RawObservation {
  rawId: string;
  rawType: string;
  grantId: string;
  roomId: string;
  liveEpoch: string;
  rawSourceSessionId: string;
  rawSourceConnectionGeneration: number;
  platformTsMs: number;
  receivedAt: number;
}

/**
 * Sender-only owner of one immutable helper and one raw source session. The
 * caller is trusted composition code; no model or public route receives the
 * maintenance settings, decoder, Page, CDP object, or helper handle.
 */
export class FrozenSenderRuntime {
  readonly processNonce = randomBytes(16).toString('hex');
  private readonly clock: Clock;
  private readonly rawProofs: RawProofStore;
  private readonly contextIds = new WeakMap<object, string>();
  private readonly operations = new Map<string, RuntimeOperation>();
  private readonly sourceOperations = new Map<string, string>();
  private readonly recovery: FrozenRecoveryAuthority;
  private helper: HelperProcess | null = null;
  private helperConnected = false;
  private helperShutdownUnconfirmed = false;
  private controls: FrozenControlAuthority | null = null;
  private raw: RawSession | null = null;
  private rawGeneration = 0;
  private senderGeneration = 0;
  private authRevision = 0;
  private localRevision = 0;
  private qualificationRevision = 0;
  private identityEpoch = 0;
  private inputGeneration = 0;
  private liveEpoch: string | null = null;
  private liveEpochStartedAtMs = 0;
  private maintaining = false;
  private maintenanceTarget: FrozenRevokeTarget | null = null;
  private maintenanceRevokeId: string | null = null;
  private activeMessage: string | null = null;

  constructor(private readonly deps: {
    deployment: FrozenSenderDeployment;
    decodeRaw: (message: RawMessage) => { common?: { roomId?: unknown; createTime?: unknown } } | null;
    clock?: Clock;
    launch?: typeof launchHelper;
    onInvalidated?: (context?: { recoveryControlId: string; recoveryPayloadHash: string }) => void;
    onRawObserved?: (observation: RawObservation) => void;
  }) {
    this.clock = deps.clock ?? defaultClock();
    this.rawProofs = new RawProofStore(this.clock);
    this.recovery = new FrozenRecoveryAuthority({
      senderNonce: this.processNonce,
      original: (id) => this.operations.get(id) ?? null,
      helper: () => this.helper,
      idTaken: (id) => this.operations.has(id) || !!this.controls?.operation(id) || !!this.controls?.captureOperation(id),
      countOtherRecords: () => this.operations.size + (this.controls?.size ?? 0),
      invalidate: (recoveryControlId, recoveryPayloadHash) => this.invalidateOriginal({ recoveryControlId, recoveryPayloadHash }),
      revision: () => this.localRevision,
      now: () => this.clock.wall(),
      onCommitted: (id, receipt) => {
        const original = this.operations.get(id);
        if (!original) return;
        this.operations.set(id, { ...original, state: receipt.writeAttempted ? original.state : 'terminal_not_dispatched',
          executionEnded: true, writeAttempted: receipt.writeAttempted,
          acceptedAtMs: receipt.acceptedAtMs, firstWriteAttemptAtMs: receipt.firstWriteAttemptAtMs,
          joinedWitnessId: receipt.joinedWitnessId, joinedAtMs: receipt.joinedAtMs });
        if (this.activeMessage === id) this.activeMessage = null;
      },
    });
  }

  private get messageHold(): boolean {
    return [...this.operations.values()].some((original) => this.recovery.blocks(original) ||
      (original.state === 'unknown' && !this.recovery.isReleased(original)));
  }

  /** The invalidation and revision advance happen before any async work. */
  beginAuthenticationMaintenance(settings: HelperSettingsSource): Promise<{ ok: boolean; reason: string }> {
    this.deps.onInvalidated?.();
    this.localRevision++;
    const revision = ++this.authRevision;
    const originalControls = this.controls;
    const originalHelper = this.helper;
    const target = originalControls?.beginMaintenance() ?? null;
    this.helperConnected = false;
    if (target && !this.maintenanceTarget) this.maintenanceTarget = target;
    if (this.helperShutdownUnconfirmed) return Promise.resolve({ ok: false, reason: 'helper-shutdown-unconfirmed' });
    if (this.maintaining) return Promise.resolve({ ok: false, reason: 'maintenance-busy' });
    this.maintaining = true;
    return this.replaceHelper(settings, revision, originalHelper, originalControls);
  }

  /** 宿主退出先取消当前维护代，迟到的 resolver 或 helper 不能发布。 */
  cancelAuthenticationMaintenance(): void {
    this.authRevision++;
    this.helperConnected = false;
    this.invalidateOriginal();
  }

  private async replaceHelper(settings: HelperSettingsSource, revision: number, originalHelper: HelperProcess | null,
    originalControls: FrozenControlAuthority | null): Promise<{ ok: boolean; reason: string }> {
    try {
      if (originalControls && this.maintenanceTarget) {
        if (!this.maintenanceRevokeId) this.maintenanceRevokeId = randomBytes(16).toString('hex');
        const existing = originalControls.operation(this.maintenanceRevokeId);
        const result = existing
          ? (existing.state === 'revoked' ? existing : await originalControls.reconcile(this.maintenanceRevokeId))
          : await originalControls.revoke({ revokeId: this.maintenanceRevokeId, expectedSenderProcessNonce: this.processNonce,
            target: this.maintenanceTarget });
        const state = result && 'registered' in result ? (result.registered ? result.record.state : null) : result?.state;
        if (state !== 'revoked') return { ok: false, reason: 'original-control-unconfirmed' };
        this.maintenanceTarget = null;
        this.maintenanceRevokeId = null;
      }
      if (revision !== this.authRevision || this.activeMessage !== null || this.messageHold || originalControls?.hasHold) {
        return { ok: false, reason: 'original-operation-held' };
      }
      if (originalHelper) {
        await originalHelper.close();
        if (this.helper === originalHelper) this.helper = null;
      }
      if (revision !== this.authRevision) return { ok: false, reason: 'maintenance-superseded' };
      const resolvedSettings = typeof settings === 'function' ? await settings(revision) : settings;
      if (revision !== this.authRevision) return { ok: false, reason: 'maintenance-superseded' };
      const helper = await (this.deps.launch ?? launchHelper)({ ...resolvedSettings, authContextRevision: revision, onDisconnect: () => {
        if (this.authRevision !== revision) return;
        this.deps.onInvalidated?.();
        this.localRevision++;
        this.authRevision++;
        this.senderGeneration++;
        this.helperConnected = false;
        const target = this.controls?.beginMaintenance();
        if (target && !this.maintenanceTarget) this.maintenanceTarget = target;
      } });
      if (!helper.recoveryVerified) {
        await helper.close();
        return { ok: false, reason: 'helper-capability-unavailable' };
      }
      if (revision !== this.authRevision) {
        await helper.close();
        return { ok: false, reason: 'maintenance-superseded' };
      }
      this.helper = helper;
      this.helperConnected = true;
      this.senderGeneration++;
      this.controls = new FrozenControlAuthority(this.processNonce, helper, (proposal) => this.proposalCurrent(proposal),
        () => this.clock.wall(), 1024, () => this.rawReady());
      return { ok: true, reason: 'ready' };
    } catch (error) {
      if (error instanceof HelperShutdownUnconfirmedError) this.helperShutdownUnconfirmed = true;
      return { ok: false, reason: 'helper-unavailable' };
    } finally {
      this.maintaining = false;
    }
  }

  private currentProof(): RoomBindingProof | null {
    const proof = this.raw?.tracker?.current(this.clock.wall()) ?? null;
    if (!proof && this.controls?.active) this.invalidateOriginal();
    return proof;
  }

  private rawReady(): boolean {
    return this.raw !== null && this.liveEpoch !== null && this.liveEpochStartedAtMs > 0 && this.currentProof() !== null;
  }

  private proposalCurrent(proposal: FrozenGrantProposal): boolean {
    const proof = this.currentProof();
    const identity = this.helper?.identity;
    const deployment = this.deps.deployment;
    return !!proof && !!identity && this.raw !== null && this.helperConnected && !this.maintaining &&
      proposal.buildDigest === deployment.buildDigest && proposal.instanceId === deployment.instanceId &&
      proposal.accountRecordId === deployment.accountRecordId && proposal.principalUid === deployment.expectedPrincipalUid &&
      proposal.roomId === deployment.roomId && proposal.platformRoomId === proof.platformRoomId &&
      proposal.senderProcessNonce === this.processNonce && proposal.senderConnectionGeneration === this.senderGeneration &&
      proposal.helperProcessNonce === identity.helperNonce && proposal.authContextId === identity.authContextId &&
      proposal.authContextRevision === identity.authContextRevision && proposal.materialDigest === identity.materialDigest &&
      proposal.rawSourceSessionId === this.raw.sessionId && proposal.rawSourceConnectionGeneration === this.raw.generation &&
      proposal.rawBrowserContextId === this.raw.contextId && proposal.roomBindingProofDigest === proof.digest &&
      proposal.inputConnectionGeneration === this.inputGeneration && proposal.liveEpoch === this.liveEpoch &&
      proposal.liveEpochStartedAtMs === this.liveEpochStartedAtMs;
  }

  private invalidateOriginal(context?: { recoveryControlId: string; recoveryPayloadHash: string }): void {
    this.deps.onInvalidated?.(context);
    this.localRevision++;
    const target = this.controls?.beginMaintenance() ?? null;
    if (!target || !this.controls) return;
    const controls = this.controls;
    const revokeId = randomBytes(16).toString('hex');
    this.maintenanceTarget = target;
    this.maintenanceRevokeId = revokeId;
    void controls.revoke({ revokeId, expectedSenderProcessNonce: this.processNonce, target });
  }

  setInputAndLive(inputGeneration: number, liveEpoch: string | null, startedAtMs: number): void {
    if (!Number.isSafeInteger(inputGeneration) || inputGeneration < 0 ||
      (liveEpoch !== null && (!boundedString(liveEpoch, 128) || !Number.isSafeInteger(startedAtMs) || startedAtMs <= 0))) {
      throw new Error('invalid input generation or live epoch');
    }
    if (inputGeneration === this.inputGeneration && liveEpoch === this.liveEpoch && startedAtMs === this.liveEpochStartedAtMs) return;
    this.invalidateOriginal();
    this.inputGeneration = inputGeneration;
    this.liveEpoch = liveEpoch;
    this.liveEpochStartedAtMs = liveEpoch ? startedAtMs : 0;
    if (this.raw) this.installRawTracker(this.raw);
  }

  private installRawTracker(session: RawSession): void {
    if (!this.liveEpoch) { session.tracker = null; return; }
    session.tracker = new RoomBindingTracker({ webRoomId: this.deps.deployment.roomId, rawSourceSessionId: session.sessionId,
      rawSourceConnectionGeneration: session.generation, rawBrowserContextId: session.contextId, liveEpoch: this.liveEpoch,
      currentPageUrl: () => session.page.url(), onInvalidated: () => {
        if (this.raw === session) {
          this.invalidateOriginal();
          session.generation = ++this.rawGeneration;
          session.tracker = null;
        }
      } });
  }

  /** Bound by the fixed-D collector to the original Page and CDP session. */
  createRawEvidenceObserver(roomId: string, page: RawPage, cdp: object): {
    socketCreated(id: string, url: string): void;
    socketClosed(id: string): void;
    rawMessage(id: string, message: RawMessage): void;
  } {
    if (roomId !== this.deps.deployment.roomId || !page || !cdp) throw new Error('unexpected raw session');
    if (this.raw) this.invalidateOriginal();
    const context = page.context();
    let contextId = this.contextIds.get(context);
    if (!contextId) { contextId = randomBytes(16).toString('hex'); this.contextIds.set(context, contextId); }
    const session: RawSession = { page, sessionId: randomBytes(16).toString('hex'), contextId,
      generation: ++this.rawGeneration, tracker: null };
    this.raw = session;
    this.installRawTracker(session);
    return {
      socketCreated: (id, url) => {
        if (this.raw !== session) return;
        if (!session.tracker) this.installRawTracker(session);
        session.tracker?.socketCreated(id, url);
      },
      socketClosed: (id) => { if (this.raw === session) session.tracker?.socketClosed(id); },
      rawMessage: (id, message) => {
        if (this.raw !== session || !session.tracker) return;
        let decoded: ReturnType<typeof this.deps.decodeRaw>;
        try { decoded = this.deps.decodeRaw(message); } catch { return; }
        const proof = session.tracker.rawMessage(id, decoded?.common?.roomId, this.clock.wall());
        if (!proof) return;
        const candidate = this.controls?.active;
        const grant = candidate && this.proposalCurrent(candidate) ? candidate : null;
        const receivedAt = this.clock.wall();
        const captured = this.rawProofs.capture({ rawId: message.msgId, rawType: message.method, roomId: this.deps.deployment.roomId,
          senderConnectionGeneration: session.generation, grantId: grant?.grantId ?? null,
          rawCreateTime: decoded?.common?.createTime, receivedAt });
        const platformTime = toPlatformEpochMs(decoded?.common?.createTime);
        if (captured.trusted && platformTime.trusted && grant) {
          try {
            this.deps.onRawObserved?.({ rawId: message.msgId, rawType: message.method, grantId: grant.grantId,
              roomId: grant.roomId, liveEpoch: grant.liveEpoch, rawSourceSessionId: session.sessionId,
              rawSourceConnectionGeneration: session.generation, platformTsMs: platformTime.ms, receivedAt });
          } catch {
            // A host consumer cannot disturb the sender's raw capture.
          }
        }
      },
    };
  }

  async captureQualification(captureId: string, expectedNonce: string) {
    if (!this.helperConnected || !this.controls || this.messageHold || this.activeMessage || !this.rawReady()) return null;
    if (this.recovery.operation(captureId) || this.operations.has(captureId)) return null;
    if (expectedNonce !== this.processNonce) return null;
    const previous = this.controls.captureOperation(captureId);
    if (previous) return previous;
    if (this.operations.size + this.recovery.size + this.controls.size >= 1024) return null;
    return this.controls.capture(captureId, expectedNonce, this.deps.deployment.expectedPrincipalUid,
      ++this.qualificationRevision, ++this.identityEpoch);
  }

  state() {
    return {
      protocol: 'dsh-public-chat-v1',
      privateProtocol: 'dsh-public-chat-http-v1',
      buildDigest: this.deps.deployment.buildDigest,
      instanceId: this.deps.deployment.instanceId,
      processNonce: this.processNonce,
      senderConnectionGeneration: this.senderGeneration,
      capabilities: this.helperConnected && this.helper && this.controls && !this.maintaining
        ? ['explicit-grant-snapshot-v1', 'frozen-http-auth-v1', 'no-replay-http1-v1', 'unknown-recovery-v1'] : [],
      helper: this.helper?.identity ?? null,
      qualification: this.controls?.currentQualification ?? null,
      activeAuthorizationId: this.controls?.active?.authorizationId ?? null,
      raw: this.raw ? { sessionId: this.raw.sessionId, contextId: this.raw.contextId, generation: this.raw.generation,
        proof: this.currentProof() } : null,
      hold: this.helperShutdownUnconfirmed || this.messageHold || this.activeMessage !== null || (this.controls?.hasHold ?? false),
    };
  }

  authorizeGrant(request: FrozenAuthorizationRequest) {
    if (!this.controls || this.messageHold || this.activeMessage || this.recovery.operation(request.authorizationId) ||
      this.operations.has(request.authorizationId)) return Promise.resolve({ registered: false as const, reason: 'busy' as const });
    if (!this.controls.operation(request.authorizationId) &&
      this.operations.size + this.recovery.size + this.controls.size >= 1024) {
      return Promise.resolve({ registered: false as const, reason: 'capacity' as const });
    }
    return this.controls.authorize(request);
  }

  revokeControl(request: FrozenRevokeRequest) {
    if (!this.controls || this.recovery.operation(request.revokeId) || this.operations.has(request.revokeId)) {
      return Promise.resolve({ registered: false as const, reason: 'invalid' as const });
    }
    if (!this.controls.operation(request.revokeId) && this.operations.size + this.recovery.size + this.controls.size >= 1024) {
      return Promise.resolve({ registered: false as const, reason: 'capacity' as const });
    }
    return this.controls.revoke(request);
  }

  controlOperation(id: string) { return this.controls?.operation(id) ?? null; }

  async reconcileControlOperation(id: string) {
    if (this.recovery.operation(id)) return this.recovery.query(id);
    if (!this.controls) return null;
    await this.controls.reconcile(id);
    return this.controls.operation(id);
  }

  reconcileMessage(request: MessageReconcileRequest) { return this.recovery.start(request); }

  operation(id: string): RuntimeOperation | null {
    const original = this.operations.get(id);
    return original ? structuredClone({ ...original, ...this.recovery.view(id) }) : null;
  }

  async reconcileOperation(id: string): Promise<RuntimeOperation | null> {
    const original = this.operations.get(id);
    const helper = this.helper;
    if (!original || original.state !== 'unknown' || !helper || !this.helperConnected ||
      helper.identity.helperNonce !== original.grant.helperProcessNonce ||
      helper.identity.authContextId !== original.grant.authContextId ||
      helper.identity.authContextRevision !== original.grant.authContextRevision ||
      helper.identity.materialDigest !== original.grant.materialDigest) return null;
    try {
      const reply = await helper.request('query', id, {});
      const view = reply.payload;
      if (this.operations.get(id) !== original || !view || typeof view !== 'object' || Array.isArray(view)) return null;
      const record = view as Record<string, unknown>;
      const message = record.message;
      if (record.kind !== 'send' || record.payloadHash !== original.helperPayloadHash || record.state !== reply.status ||
        !message || typeof message !== 'object' || Array.isArray(message)) return null;
      const fields = message as Record<string, unknown>;
      const httpResponse = helperHttpResponse(fields);
      if (fields.requestId !== id || fields.sourceKey !== original.sourceKey ||
        controlPayloadHash(fields.grant) !== controlPayloadHash(original.grant) ||
        fields.requestHash !== original.hash || fields.textDigest !== original.textDigest ||
        !safeInteger(fields.acceptedAtMs) || fields.acceptedAtMs < original.grant.authorizedAtMs ||
        (fields.firstWriteAttemptAtMs !== null && (!safeInteger(fields.firstWriteAttemptAtMs) || fields.firstWriteAttemptAtMs < fields.acceptedAtMs)) ||
        typeof fields.executionEnded !== 'boolean' || typeof fields.writeAttempted !== 'boolean' ||
        (fields.writeAttempted !== (fields.firstWriteAttemptAtMs !== null)) ||
        (fields.executionEnded && (!boundedString(fields.joinedWitnessId, 128) || !safeInteger(fields.joinedAtMs) ||
          fields.joinedAtMs < fields.acceptedAtMs || (typeof fields.firstWriteAttemptAtMs === 'number' && fields.joinedAtMs < fields.firstWriteAttemptAtMs))) ||
        (!fields.executionEnded && (fields.joinedWitnessId !== '' || fields.joinedAtMs !== 0)) ||
        (original.executionEnded && !fields.executionEnded) || (original.writeAttempted && !fields.writeAttempted) ||
        httpResponse === undefined || (original.httpResponse !== null &&
          controlPayloadHash(original.httpResponse) !== controlPayloadHash(httpResponse))) return null;
      // A boolean alone is not the schema 4 joined witness. Keep this held
      // until the original helper supplies verifiable termination evidence.
      const updated: RuntimeOperation = { ...original, state: 'unknown',
        executionEnded: fields.executionEnded, writeAttempted: fields.writeAttempted,
        acceptedAtMs: fields.acceptedAtMs, firstWriteAttemptAtMs: fields.firstWriteAttemptAtMs as number | null,
        joinedWitnessId: fields.executionEnded ? fields.joinedWitnessId as string : null,
        joinedAtMs: fields.executionEnded ? fields.joinedAtMs as number : null, httpResponse };
      this.operations.set(id, updated);
      if (fields.executionEnded && this.activeMessage === id) this.activeMessage = null;
      return this.operation(id);
    } catch {
      return null;
    }
  }

  async send(input: FrozenSendInput): Promise<RuntimeOperation | null> {
    const request = structuredClone(input);
    if (!boundedString(request.requestId, 128) || !boundedString(request.sourceKey, 128) || !validatePublicText(request.text).ok) return null;
    const hash = controlPayloadHash(request);
    const existing = this.operations.get(request.requestId);
    if (existing) return existing.hash === hash ? structuredClone(existing) : null;
    const active = this.controls?.active;
    if (!this.helperConnected || !this.helper || !this.controls || this.controls.hasHold || this.messageHold || this.activeMessage || !active ||
      !this.proposalCurrent(active) || controlPayloadHash(active) !== controlPayloadHash(request.grant) ||
      this.operations.size + this.recovery.size + this.controls.size >= 1024 || this.sourceOperations.has(request.sourceKey) ||
      this.recovery.operation(request.requestId) || this.controls.operation(request.requestId) ||
      this.controls.captureOperation(request.requestId) || !this.raw) return null;
    if (request.autoEvent) {
      const proof = this.rawProofs.take(request.autoEvent.rawId, { rawType: request.autoEvent.rawType,
        senderConnectionGeneration: this.raw.generation, roomId: active.roomId, now: this.clock.wall(),
        authBoundaryMs: Math.max(active.authorizedAtMs, active.liveEpochStartedAtMs), grantId: active.grantId });
      if (!proof.ok) return null;
    }
    const payload = { requestId: request.requestId, sourceKey: request.sourceKey, requestHash: hash, sourceKind: request.autoEvent ? 'auto' : 'manual',
      grant: active, text: request.text };
    const original: RuntimeOperation = { requestId: request.requestId, sourceKey: request.sourceKey, hash,
      helperPayloadHash: controlPayloadHash(payload), textDigest: createHash('sha256').update(request.text, 'utf8').digest('hex'),
      acceptedAtMs: null, firstWriteAttemptAtMs: null, joinedWitnessId: null, joinedAtMs: null,
      factsRevision: 0, factsDigest: controlPayloadHash([]), recoveryControlId: null, recoveryReceipt: null,
      httpResponse: null, grant: active, state: 'dispatching', executionEnded: false, writeAttempted: false };
    this.operations.set(request.requestId, original);
    this.sourceOperations.set(request.sourceKey, request.requestId);
    this.activeMessage = request.requestId;
    const revision = this.localRevision;
    const helper = this.helper;
    try {
      const reply = await helper.request('send', request.requestId, payload,
        () => this.localRevision === revision && this.helper === helper && this.controls?.active === active && this.proposalCurrent(active));
      const record = reply.payload;
      if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('invalid original message record');
      const view = record as Record<string, unknown>;
      const message = view.message;
      if (view.kind !== 'send' || view.payloadHash !== original.helperPayloadHash || view.state !== reply.status ||
        !message || typeof message !== 'object' || Array.isArray(message)) throw new Error('invalid original message record');
      const fields = message as Record<string, unknown>;
      const httpResponse = helperHttpResponse(fields);
      if (fields.requestId !== request.requestId || fields.sourceKey !== request.sourceKey ||
        controlPayloadHash(fields.grant) !== controlPayloadHash(active) || typeof fields.writeAttempted !== 'boolean' ||
        typeof fields.executionEnded !== 'boolean' || fields.requestHash !== hash || fields.textDigest !== original.textDigest ||
        !safeInteger(fields.acceptedAtMs) || fields.acceptedAtMs < active.authorizedAtMs ||
        (fields.firstWriteAttemptAtMs !== null && (!safeInteger(fields.firstWriteAttemptAtMs) || fields.firstWriteAttemptAtMs < fields.acceptedAtMs)) ||
        (fields.writeAttempted !== (fields.firstWriteAttemptAtMs !== null)) ||
        (fields.executionEnded && (!boundedString(fields.joinedWitnessId, 128) || !safeInteger(fields.joinedAtMs) ||
          fields.joinedAtMs < fields.acceptedAtMs || (typeof fields.firstWriteAttemptAtMs === 'number' && fields.joinedAtMs < fields.firstWriteAttemptAtMs))) ||
        (!fields.executionEnded && (fields.joinedWitnessId !== '' || fields.joinedAtMs !== 0)) || httpResponse === undefined) {
        throw new Error('original message binding mismatch');
      }
      let state: RuntimeOperationState = 'unknown';
      if (reply.status === 'api_reported_success' && httpResponse?.status === 200) state = 'api_reported_success';
      const updated: RuntimeOperation = { ...original, state, executionEnded: fields.executionEnded, writeAttempted: fields.writeAttempted,
        acceptedAtMs: fields.acceptedAtMs, firstWriteAttemptAtMs: fields.firstWriteAttemptAtMs as number | null,
        joinedWitnessId: fields.executionEnded ? fields.joinedWitnessId as string : null,
        joinedAtMs: fields.executionEnded ? fields.joinedAtMs as number : null, httpResponse };
      this.operations.set(request.requestId, updated);
      if (fields.executionEnded) this.activeMessage = null;
      return structuredClone(updated);
    } catch {
      const unknown: RuntimeOperation = { ...original, state: 'unknown' };
      this.operations.set(request.requestId, unknown);
      return structuredClone(unknown);
    }
  }
}

export type FrozenSenderState = ReturnType<FrozenSenderRuntime['state']>;
