import { createHash, randomBytes } from 'node:crypto';
import { controlPayloadHash } from './grantAuthority';
import type { FrozenAuthorizationRequest, FrozenControlRecord, FrozenQualification, FrozenRevokeRequest, FrozenRevokeTarget } from './frozenControl';
import { validateCommittedGrant, type FrozenGrantProposal, type FrozenGrantSnapshot } from './frozenGrant';
import { FrozenPublicChatOperationJournal, messageReference, terminalEvidenceFromReceipt,
  type FrozenJournalControl, type FrozenJournalMessage } from './frozenJournal';
import type { FrozenSendInput, FrozenSenderState } from './frozenSenderRuntime';
import type { SenderClient } from './senderClient';
import { deriveSourceKey, validateAutoEvent } from './eventRef';
import { defaultClock, isObject, type Clock } from './protocol';
import { validatePublicText } from './textPolicy';
import { appendRecoveryFact, messageRefDigest, validateMessageRef, type MessageRef } from './recoveryFacts';
import { messageReconcileHash, type MessageReconcileRequest } from './recoveryProtocol';
import type { FrozenRecoveryControl } from './frozenRecovery';
import { validateFrozenRecoveryControl } from './senderClient';
import { validControlEvidence } from './frozenControlEvidence';
import { isHttpResponseEvidence } from './httpResponse';

type Gateway = Pick<SenderClient, 'frozenState' | 'frozenCapture' | 'frozenAuthorize' | 'frozenRevoke' | 'frozenControlOperation' |
  'frozenSend' | 'frozenOperation' | 'frozenReconcileMessage' | 'frozenRecoveryOperation'>;
interface Deployment { buildDigest: string; instanceId: string; accountRecordId: string; expectedPrincipalUid: string; roomId: string }
interface QueueItem { request: FrozenSendInput; revision: string; deadline: number; event: object | null }
type SubmitResult = { status: 'accepted'; requestId: string } | { status: 'rejected'; reason: string } |
  { status: 'duplicate'; requestId: string; outcome: string | null };

/** L-side frozen grant/journal implementation. No grant is restored on restart. */
export class FrozenControllerCore {
  private readonly processId = randomBytes(16).toString('hex');
  private counter = 0;
  private readonly clock: Clock;
  private active: FrozenGrantSnapshot | null = null;
  private qualification: FrozenQualification | null = null;
  private capture: { id: string; nonce: string } | null = null;
  private captureState: FrozenSenderState | null = null;
  private liveEpoch: string | null = null;
  private liveStartedAtMs = 0;
  private inputGeneration = 0;
  private sourceConnectionToken = '';
  private queue: QueueItem[] = [];
  private pumping = false;
  private lastDispatch = -Infinity;
  private degraded = false;
  private readonly adoptedRecoveries = new Map<string, string>();
  private readonly adoptedControls = new Map<string, string>();

  constructor(private readonly deps: { deployment: Deployment; gateway: Gateway; journal: FrozenPublicChatOperationJournal;
    clock?: Clock; queueLimit?: number; queueWaitMs?: number; dispatchIntervalMs?: number }) {
    this.clock = deps.clock ?? defaultClock();
  }

  get revision(): string { return `${this.processId}:${this.counter}`; }

  /** 内部接线只读取当前实例已发布的授权；不会从 journal 恢复。 */
  currentGrant(): Readonly<FrozenGrantSnapshot> | null {
    return this.active;
  }

  /** The sender is acknowledging the exact recovery that already revoked this controller. */
  ownsPendingRecoveryInvalidation(controlId: string, payloadHash: string): boolean {
    if (this.active || this.qualification || this.capture || this.queue.length !== 0) return false;
    const control = this.deps.journal.controls.find((entry) => entry.kind === 'message_reconcile' && entry.id === controlId);
    if (!control || control.kind !== 'message_reconcile' || control.state !== 'pending' ||
      control.payloadHash !== payloadHash || control.request.localFactsToken !== this.revision) return false;
    const original = this.deps.journal.records.find((record) => record.requestId === control.request.ref.requestId);
    return !!original && original.conflicts.length === 0 && original.recovery.state === 'pending' && original.recovery.controlId === controlId &&
      original.factsRevision === control.request.factsRevision && original.factsDigest === control.request.factsDigest &&
      controlPayloadHash(messageReference(original)) === controlPayloadHash(control.request.ref);
  }

  private get queueBlocked(): boolean {
    const activeId = this.active?.authorizationId;
    return this.degraded || this.deps.journal.corrupt || this.deps.journal.records.some((record) =>
      (['unknown', 'terminal_not_dispatched'].includes(record.state) && !this.isRecoveryAdopted(record)) ||
      record.conflicts.length > 0) ||
      this.deps.journal.controls.some((control) => control.kind === 'capture'
        ? !(control.state === 'qualified' && control.id === this.capture?.id) && !this.isControlAdopted(control)
        : control.kind === 'authorize'
          ? !(control.state === 'active' && control.id === activeId) && !this.isControlAdopted(control)
          : control.kind === 'revoke' ? !this.isControlAdopted(control) : ['pending', 'recovery_unknown'].includes(control.state));
  }

  get hold(): boolean {
    return this.queueBlocked || this.deps.journal.records.some((record) => record.state === 'dispatching');
  }

  reconciliationState(): { safeToResume: boolean; blockingRequestIds: string[] } {
    const blockingRequestIds = this.deps.journal.records
      .filter((record) => (['unknown', 'terminal_not_dispatched'].includes(record.state) && !this.isRecoveryAdopted(record)) ||
        record.state === 'dispatching' || record.conflicts.length > 0)
      .map((record) => record.requestId);
    return { safeToResume: !this.hold, blockingRequestIds };
  }

  recordFact(ref: unknown, factId: unknown, input: unknown,
    observationSource?: { source: 'owner' | 'designated-viewer'; observerRef: string | null }):
    { ok: true; duplicate: boolean; factsRevision: number } | { ok: false; error: string } {
    if (this.degraded || this.deps.journal.corrupt) return { ok: false, error: 'journal-unavailable' };
    if (!validateMessageRef(ref) || typeof factId !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(factId) || !isObject(input)) {
      return { ok: false, error: 'invalid fact input' };
    }
    const original = this.deps.journal.records.find((entry) => entry.requestId === ref.requestId);
    if (!original || controlPayloadHash(messageReference(original)) !== controlPayloadHash(ref)) {
      return { ok: false, error: 'original message reference mismatch' };
    }
    const prior = original.facts.find((fact) => fact.factId === factId);
    const common = { factId, seq: prior?.seq ?? original.facts.length + 1, refDigest: messageRefDigest(ref),
      hostRecordedAtMs: prior?.hostRecordedAtMs ?? this.clock.wall() };
    if (!prior && common.hostRecordedAtMs < original.createdAtMs) {
      this.revoke();
      original.conflicts.push({ reason: 'fact-clock-rollback', factId, controlId: original.recovery.controlId });
      this.persist();
      return { ok: false, error: 'fact-clock-rollback' };
    }
    let candidate: unknown;
    if (input.kind === 'note' && Object.keys(input).length === 2 && Object.hasOwn(input, 'note')) {
      candidate = { ...common, kind: 'note', note: input.note };
    } else if (input.kind === 'positive_observation' && observationSource &&
      Object.keys(input).length === 7 && ['attributionStrength', 'observedAtMs', 'textDigest', 'principalUid', 'roomId', 'platformRoomId']
        .every((key) => Object.hasOwn(input, key))) {
      candidate = { ...common, kind: 'positive_observation', source: observationSource.source,
        observerRef: observationSource.observerRef, attributionStrength: input.attributionStrength,
        observedAtMs: input.observedAtMs, textDigest: input.textDigest, principalUid: input.principalUid,
        roomId: input.roomId, platformRoomId: input.platformRoomId };
    } else {
      return { ok: false, error: 'unsupported or invalid fact' };
    }
    const next = appendRecoveryFact(ref as MessageRef, original.facts, candidate);
    if (!next.ok) {
      if (next.conflict) {
        this.revoke();
        if (!original.conflicts.some((item) => item.reason === next.reason && item.factId === factId)) {
          original.conflicts.push({ reason: next.reason, factId, controlId: null });
        }
        this.persist();
      }
      return { ok: false, error: next.reason };
    }
    if (next.duplicate) return { ok: true, duplicate: true, factsRevision: next.revision };
    this.revoke();
    original.facts = next.facts;
    original.factsRevision = next.revision;
    original.factsDigest = next.digest;
    if (original.terminalEvidence && !original.terminalEvidence.writeAttempted &&
      next.facts[next.facts.length - 1]?.kind === 'positive_observation') {
      original.conflicts.push({ reason: 'never-written-observed', factId, controlId: original.recovery.controlId });
    }
    original.recovery = { state: original.recovery.controlId ? 'invalidated' : 'blocked', factsRevision: next.revision,
      factsDigest: next.digest, controlId: original.recovery.controlId, receipt: null };
    if (!this.persist()) return { ok: false, error: 'journal-write-failed' };
    return { ok: true, duplicate: false, factsRevision: next.revision };
  }

  async reconcileMessage(id: string): Promise<{ ok: boolean; reason: string }> {
    const original = this.deps.journal.records.find((record) => record.requestId === id);
    if (!original || original.state !== 'unknown') return { ok: false, reason: 'original-operation-unavailable' };
    const reference = { requestId: original.requestId, sourceKey: original.sourceKey, hash: original.requestHash,
      helperPayloadHash: original.helperPayloadHash, textDigest: original.textDigest, grant: original.grant };
    const result = await this.deps.gateway.frozenOperation(reference);
    if (!result.ok || this.deps.journal.records.find((record) => record.requestId === id) !== original || original.state !== 'unknown') {
      return { ok: false, reason: 'original-operation-unresolved' };
    }
    const wire = result.value;
    if (wire.requestId !== reference.requestId || wire.sourceKey !== reference.sourceKey || wire.hash !== reference.hash ||
      wire.helperPayloadHash !== reference.helperPayloadHash || wire.textDigest !== reference.textDigest ||
      controlPayloadHash(wire.grant) !== controlPayloadHash(reference.grant) ||
      typeof wire.executionEnded !== 'boolean' || typeof wire.writeAttempted !== 'boolean' ||
      !['dispatching', 'unknown', 'terminal_not_dispatched', 'api_reported_success'].includes(wire.state) ||
      (wire.state === 'terminal_not_dispatched' && (!wire.executionEnded || wire.writeAttempted)) ||
      (wire.httpResponse !== null && (!isHttpResponseEvidence(wire.httpResponse) || !wire.executionEnded || !wire.writeAttempted)) ||
      (original.executionEnded && !wire.executionEnded) || (original.writeAttempted && !wire.writeAttempted)) {
      return { ok: false, reason: 'original-operation-mismatch' };
    }
    if (original.httpResponse !== null && controlPayloadHash(original.httpResponse) !== controlPayloadHash(wire.httpResponse)) {
      return { ok: false, reason: 'original-response-mismatch' };
    }
    original.executionEnded = wire.executionEnded;
    original.writeAttempted = wire.writeAttempted;
    original.httpResponse = wire.httpResponse;
    // Schema 4 also needs the original joined witness and its complete
    // reference. Until that evidence is available, retain the unknown state.
    if (!this.persist()) return { ok: false, reason: 'journal-write-failed' };
    return { ok: true, reason: 'recorded' };
  }

  private advance(): string { this.counter++; return this.revision; }

  advanceRevision(): string { return this.advance(); }

  private persist(): boolean {
    try {
      this.deps.journal.write();
      return true;
    } catch {
      this.degraded = true;
      this.adoptedRecoveries.clear();
      this.adoptedControls.clear();
      return false;
    }
  }

  private controlAdoptionDigest(control: Exclude<FrozenJournalControl, { kind: 'message_reconcile' }>): string | null {
    if (!['rejected', 'revoked'].includes(control.state) || !validControlEvidence(control, this.deps.journal.controls)) return null;
    const referenced = control.kind === 'revoke' ? this.deps.journal.controls.find((entry) =>
      control.target.kind === 'capture'
        ? entry.kind === 'capture' && entry.id === control.target.captureId
        : entry.kind === 'authorize' && entry.id === control.target.authorizationId) : control;
    if (!referenced || referenced.kind === 'message_reconcile' || referenced.kind === 'revoke') return null;
    if (referenced.kind === 'capture' && (referenced.buildDigest !== this.deps.deployment.buildDigest ||
      referenced.instanceId !== this.deps.deployment.instanceId)) return null;
    if (referenced.kind === 'authorize' && (referenced.target.buildDigest !== this.deps.deployment.buildDigest ||
      referenced.target.instanceId !== this.deps.deployment.instanceId ||
      referenced.target.accountRecordId !== this.deps.deployment.accountRecordId ||
      referenced.target.principalUid !== this.deps.deployment.expectedPrincipalUid ||
      referenced.target.roomId !== this.deps.deployment.roomId)) return null;
    return controlPayloadHash({ processId: this.processId, id: control.id, kind: control.kind,
      payloadHash: control.payloadHash, acknowledgement: control.ack, holder: referenced });
  }

  private isControlAdopted(control: Exclude<FrozenJournalControl, { kind: 'message_reconcile' }>): boolean {
    const digest = this.controlAdoptionDigest(control);
    return digest !== null && this.adoptedControls.get(control.id) === digest;
  }

  private adoptPersistedControl(control: Exclude<FrozenJournalControl, { kind: 'message_reconcile' }>): boolean {
    const digest = this.controlAdoptionDigest(control);
    if (!digest || !this.persist() || !this.deps.journal.controls.includes(control) ||
      this.controlAdoptionDigest(control) !== digest) return false;
    this.adoptedControls.set(control.id, digest);
    return true;
  }

  private acceptRevokeAck(control: Extract<FrozenJournalControl, { kind: 'revoke' }>, ack: FrozenControlRecord): boolean {
    if (ack.kind !== 'revoke' || ack.state !== 'revoked' || ack.id !== control.id ||
      ack.payloadHash !== control.payloadHash || ack.senderProcessNonce !== control.senderProcessNonce ||
      controlPayloadHash(ack.target) !== controlPayloadHash(control.target)) return false;
    const index = this.deps.journal.controls.indexOf(control);
    if (index < 0) return false;
    const terminal = { ...control, state: 'revoked' as const, ack };
    this.deps.journal.controls[index] = terminal;
    const targetIndex = this.deps.journal.controls.findIndex((entry) =>
      control.target.kind === 'authorization'
        ? entry.kind === 'authorize' && entry.id === control.target.authorizationId
        : entry.kind === 'capture' && entry.id === control.target.captureId);
    const target = this.deps.journal.controls[targetIndex];
    if (!target || (target.kind !== 'authorize' && target.kind !== 'capture')) return false;
    const terminalTarget = { ...target, state: 'revoked' as const, ack };
    this.deps.journal.controls[targetIndex] = terminalTarget;
    const terminalDigest = this.controlAdoptionDigest(terminal);
    const targetDigest = this.controlAdoptionDigest(terminalTarget);
    if (!terminalDigest || !targetDigest || !this.persist()) return false;
    if (this.deps.journal.controls[index] !== terminal || this.deps.journal.controls[targetIndex] !== terminalTarget ||
      this.controlAdoptionDigest(terminal) !== terminalDigest || this.controlAdoptionDigest(terminalTarget) !== targetDigest) return false;
    this.adoptedControls.set(terminal.id, terminalDigest);
    this.adoptedControls.set(terminalTarget.id, targetDigest);
    return true;
  }

  private recoveryAdoptionDigest(original: FrozenJournalMessage,
    control: Extract<FrozenJournalControl, { kind: 'message_reconcile' }>): string | null {
    const { deployment } = this.deps;
    const ack = control.ack;
    if (original.recovery.state !== 'committed' || original.recovery.controlId !== control.id ||
      control.state !== 'committed' || !ack || !ack.published || !ack.receipt ||
      !validateFrozenRecoveryControl(ack, control.request).ok || original.conflicts.length !== 0 ||
      original.factsRevision !== control.request.factsRevision || original.factsDigest !== control.request.factsDigest ||
      controlPayloadHash(original.facts) !== controlPayloadHash(control.request.facts) ||
      controlPayloadHash(messageReference(original)) !== controlPayloadHash(control.request.ref) ||
      controlPayloadHash(original.recovery.receipt) !== controlPayloadHash(ack.receipt) ||
      controlPayloadHash(original.terminalEvidence) !== controlPayloadHash(terminalEvidenceFromReceipt(ack.receipt)) ||
      !original.executionEnded || original.writeAttempted !== ack.receipt.writeAttempted ||
      (ack.receipt.writeAttempted ? original.state !== 'unknown' : original.state !== 'terminal_not_dispatched') ||
      control.request.ref.grant.buildDigest !== deployment.buildDigest ||
      control.request.ref.grant.instanceId !== deployment.instanceId ||
      control.request.ref.grant.accountRecordId !== deployment.accountRecordId ||
      control.request.ref.grant.principalUid !== deployment.expectedPrincipalUid ||
      control.request.ref.grant.roomId !== deployment.roomId) return null;
    return controlPayloadHash({ processId: this.processId, id: control.id, kind: control.kind,
      payloadHash: control.payloadHash, ack, ref: messageReference(original),
      factsRevision: original.factsRevision, factsDigest: original.factsDigest });
  }

  private isRecoveryAdopted(original: FrozenJournalMessage): boolean {
    const control = this.deps.journal.controls.find((entry) => entry.kind === 'message_reconcile' &&
      entry.id === original.recovery.controlId);
    if (!control || control.kind !== 'message_reconcile') return false;
    const digest = this.recoveryAdoptionDigest(original, control);
    return digest !== null && this.adoptedRecoveries.get(control.id) === digest;
  }

  setSourceConnectionToken(token: string): void { this.sourceConnectionToken = token; }

  setLiveEpoch(epoch: string, startedAtMs?: number): void {
    const start = Number.isSafeInteger(startedAtMs) && (startedAtMs ?? 0) > 0 ? startedAtMs! : 0;
    if (this.liveEpoch !== epoch || this.liveStartedAtMs !== start) this.revoke();
    this.liveEpoch = epoch;
    this.liveStartedAtMs = start;
  }

  advanceInputConnection(): string {
    this.revoke();
    this.inputGeneration++;
    this.sourceConnectionToken = `${this.processId}:${this.inputGeneration}`;
    return this.sourceConnectionToken;
  }

  async refreshQualification(): Promise<{ ok: boolean; reason: string }> {
    if (this.active || this.qualification || this.capture) {
      this.revoke();
      return { ok: false, reason: 'prior-control-revocation-pending' };
    }
    if (this.hold) return { ok: false, reason: 'control-or-message-hold' };
    const revision = this.advance();
    const state = await this.deps.gateway.frozenState();
    if (this.revision !== revision || !state.ok) return { ok: false, reason: 'sender-unavailable' };
    const { deployment } = this.deps;
    const snapshot = state.value;
    if (snapshot.buildDigest !== deployment.buildDigest || snapshot.instanceId !== deployment.instanceId || snapshot.hold ||
      !snapshot.helper || !snapshot.raw?.proof || snapshot.raw.proof.webRoomId !== deployment.roomId ||
      snapshot.raw.proof.liveEpoch !== this.liveEpoch || !this.liveEpoch || !this.liveStartedAtMs) {
      return { ok: false, reason: 'raw-or-sender-unavailable' };
    }
    const captureId = randomBytes(16).toString('hex');
    this.capture = { id: captureId, nonce: snapshot.processNonce };
    const captureControl: FrozenJournalControl = { kind: 'capture', id: captureId,
      payloadHash: controlPayloadHash({ captureId, expectedSenderProcessNonce: snapshot.processNonce }),
      senderProcessNonce: snapshot.processNonce, helperNonce: snapshot.helper.helperNonce,
      authContextId: snapshot.helper.authContextId, authContextRevision: snapshot.helper.authContextRevision,
      materialDigest: snapshot.helper.materialDigest, buildDigest: snapshot.buildDigest, instanceId: snapshot.instanceId,
      state: 'capturing', ack: null };
    this.deps.journal.controls.push(captureControl);
    if (!this.persist()) return { ok: false, reason: 'journal-write-failed' };
    const result = await this.deps.gateway.frozenCapture(captureId, snapshot.processNonce);
    if (this.revision !== revision || this.capture?.id !== captureId) return { ok: false, reason: 'stale-response' };
    const controlIndex = this.deps.journal.controls.findIndex((entry) => entry.kind === 'capture' && entry.id === captureId);
    const original = this.deps.journal.controls[controlIndex];
    if (!original || original.kind !== 'capture' || original.state === 'revoked') return { ok: false, reason: 'capture-revoked' };
    if (!result.ok || result.value.record.state !== 'qualified' || !result.value.record.qualification ||
      result.value.record.qualification.principalUid !== deployment.expectedPrincipalUid ||
      result.value.senderConnectionGeneration !== snapshot.senderConnectionGeneration ||
      controlPayloadHash(result.value.helper) !== controlPayloadHash(snapshot.helper) ||
      controlPayloadHash(result.value.raw) !== controlPayloadHash(snapshot.raw)) {
      this.deps.journal.controls[controlIndex] = { ...original, state: 'capture_unknown' };
      this.persist();
      this.revoke();
      return { ok: false, reason: 'identity-unverified' };
    }
    this.deps.journal.controls[controlIndex] = { ...original, state: 'qualified' };
    if (!this.persist()) return { ok: false, reason: 'journal-write-failed' };
    this.qualification = result.value.record.qualification;
    this.captureState = snapshot;
    return { ok: true, reason: 'ok' };
  }

  async authorize(): Promise<{ ok: boolean; reason: string; grantId?: string }> {
    if (this.hold || !this.qualification || !this.capture || !this.captureState || !this.liveEpoch || !this.liveStartedAtMs) {
      return { ok: false, reason: 'authorization-prerequisite-missing' };
    }
    const qualification = this.qualification;
    const state = this.captureState;
    const raw = state.raw;
    const helper = state.helper;
    if (!raw?.proof || !helper) return { ok: false, reason: 'raw-proof-missing' };
    const authorizationId = randomBytes(16).toString('hex');
    const revision = this.revision;
    const target: FrozenGrantProposal = { version: 'dsh-public-chat-v1', transportKind: 'frozen_http',
      buildDigest: this.deps.deployment.buildDigest, instanceId: this.deps.deployment.instanceId,
      senderProcessNonce: state.processNonce, senderConnectionGeneration: state.senderConnectionGeneration,
      authorizationId, captureId: this.capture.id, qualificationDigest: qualification.qualificationDigest,
      qualificationRevision: qualification.qualificationRevision, identityEpoch: qualification.identityEpoch,
      accountRecordId: this.deps.deployment.accountRecordId, principalUid: qualification.principalUid,
      roomId: this.deps.deployment.roomId, platformRoomId: raw.proof.platformRoomId,
      helperProcessNonce: helper.helperNonce, authContextId: helper.authContextId, authContextRevision: helper.authContextRevision,
      materialDigest: helper.materialDigest, rawSourceSessionId: raw.sessionId, rawSourceConnectionGeneration: raw.generation,
      rawBrowserContextId: raw.contextId, roomBindingProofDigest: raw.proof.digest, inputConnectionGeneration: this.inputGeneration,
      liveEpoch: this.liveEpoch, liveEpochStartedAtMs: this.liveStartedAtMs };
    const request: FrozenAuthorizationRequest = { authorizationId, expectedSenderProcessNonce: state.processNonce,
      qualificationToken: qualification.qualificationToken, localRevision: revision, target };
    const control: FrozenJournalControl = { kind: 'authorize', id: authorizationId, payloadHash: controlPayloadHash(request),
      senderProcessNonce: state.processNonce, target, qualificationTokenDigest: createHash('sha256').update(qualification.qualificationToken).digest('hex'),
      localRevision: revision, state: 'authorizing', grant: null, ack: null };
    this.deps.journal.controls.push(control);
    if (!this.persist()) return { ok: false, reason: 'journal-write-failed' };
    const result = await this.deps.gateway.frozenAuthorize(request, qualification.capturedAtMs);
    const index = this.deps.journal.controls.findIndex((entry) => entry.id === authorizationId);
    const original = this.deps.journal.controls[index];
    if (!original || original.kind !== 'authorize') return { ok: false, reason: 'authorization-revoked' };
    if (original.state === 'revoked') {
      if (result.ok && result.value.kind === 'authorize' && result.value.state === 'authorized' &&
        validateCommittedGrant(result.value.grant, target, qualification.qualificationToken, qualification.capturedAtMs, this.clock.wall())) {
        this.deps.journal.controls[index] = { ...original, grant: Object.freeze({ ...result.value.grant }) };
        this.persist();
      }
      return { ok: false, reason: 'authorization-revoked' };
    }
    if (result.ok && result.value.kind === 'authorize' && ['rejected', 'revoked'].includes(result.value.state)) {
      const terminal = { ...original, state: result.value.state as 'rejected' | 'revoked', ack: result.value };
      this.deps.journal.controls[index] = terminal;
      return this.adoptPersistedControl(terminal)
        ? { ok: false, reason: terminal.state }
        : { ok: false, reason: 'journal-write-failed' };
    }
    if (!result.ok || result.value.kind !== 'authorize' || result.value.state !== 'authorized' ||
      !validateCommittedGrant(result.value.grant, target, qualification.qualificationToken, qualification.capturedAtMs, this.clock.wall())) {
      this.deps.journal.controls[index] = { ...original, state: 'authorizing_unknown' };
      this.persist();
      return { ok: false, reason: 'authorizing-unknown' };
    }
    const grant = Object.freeze({ ...result.value.grant });
    if (this.revision !== revision || this.qualification !== qualification) {
      this.deps.journal.controls[index] = { ...original, state: 'authorizing_unknown', grant, ack: result.value };
      this.persist();
      return { ok: false, reason: 'authorizing-unknown' };
    }
    this.deps.journal.controls[index] = { ...original, state: 'active', grant, ack: result.value };
    if (!this.persist()) return { ok: false, reason: 'journal-write-failed' };
    this.active = grant;
    return { ok: true, reason: 'ok', grantId: grant.grantId };
  }

  private clearLocal(): void {
    this.advance();
    this.active = null;
    this.qualification = null;
    this.capture = null;
    for (const item of this.queue.splice(0)) {
      const record = this.deps.journal.records.find((entry) => entry.requestId === item.request.requestId);
      if (record?.state === 'queued') record.state = 'cancelled_before_dispatch';
    }
  }

  /** 保存设置时只同步停止本地动作；原控制保持 hold，等待显式撤权或核对。 */
  suspendLocally(): void {
    this.clearLocal();
    this.captureState = null;
    this.persist();
  }

  revoke(): void {
    const capture = this.capture;
    this.clearLocal();
    const original = [...this.deps.journal.controls].reverse().find((control) => control.kind === 'authorize' && !['rejected', 'revoked'].includes(control.state));
    const captureControl = [...this.deps.journal.controls].reverse().find((control) => control.kind === 'capture' && control.state !== 'revoked');
    const targets: Array<{ target: FrozenRevokeTarget; nonce: string }> = [];
    if (original?.kind === 'authorize') targets.push({ target: { kind: 'authorization', authorizationId: original.id,
      ...(original.grant ? { grantId: original.grant.grantId, snapshot: original.grant } : {}) }, nonce: original.senderProcessNonce });
    if (captureControl?.kind === 'capture') targets.push({ target: { kind: 'capture', captureId: captureControl.id }, nonce: captureControl.senderProcessNonce });
    else if (capture) targets.push({ target: { kind: 'capture', captureId: capture.id }, nonce: capture.nonce });
    const requests: FrozenRevokeRequest[] = [];
    for (const item of targets) {
      const alreadyPending = this.deps.journal.controls.some((entry) => entry.kind === 'revoke' && entry.state !== 'revoked' &&
        entry.senderProcessNonce === item.nonce && controlPayloadHash(entry.target) === controlPayloadHash(item.target));
      if (alreadyPending) continue;
      const request: FrozenRevokeRequest = { revokeId: randomBytes(16).toString('hex'), expectedSenderProcessNonce: item.nonce, target: item.target };
      this.deps.journal.controls.push({ kind: 'revoke', id: request.revokeId, payloadHash: controlPayloadHash(request),
        senderProcessNonce: item.nonce, target: item.target, state: 'revoking', ack: null });
      requests.push(request);
    }
    if (!this.persist()) return;
    for (const request of requests) void this.deps.gateway.frozenRevoke(request).then((result) => {
      const index = this.deps.journal.controls.findIndex((entry) => entry.id === request.revokeId);
      const current = this.deps.journal.controls[index];
      if (!current || current.kind !== 'revoke') return;
      if (!result.ok || !this.acceptRevokeAck(current, result.value)) {
        this.deps.journal.controls[index] = { ...current, state: 'revoking_unknown' };
        this.persist();
      }
    }).catch(() => { this.degraded = true; });
  }

  async reconcileControl(id: string): Promise<{ ok: boolean; reason: string }> {
    const index = this.deps.journal.controls.findIndex((entry) => entry.id === id);
    const original = this.deps.journal.controls[index];
    if (!original) return { ok: false, reason: 'control-unavailable' };
    if (original.kind === 'message_reconcile') return this.reconcileRecoveryControl(original);
    if (this.degraded || this.deps.journal.corrupt) return { ok: false, reason: 'journal-unavailable' };
    if (['rejected', 'revoked'].includes(original.state)) {
      return this.adoptPersistedControl(original)
        ? { ok: true, reason: 'control-terminal-recorded' }
        : { ok: false, reason: 'control-evidence-unavailable' };
    }
    if (original.kind === 'capture') {
      this.revoke();
      return { ok: false, reason: 'targeted-revoke-started' };
    }
    const result = await this.deps.gateway.frozenControlOperation(original.id, original.kind, original.senderProcessNonce,
      original.payloadHash, original.target);
    if (this.deps.journal.controls[index] !== original || !result.ok || result.value.kind !== original.kind) {
      return { ok: false, reason: 'control-unresolved' };
    }
    if (original.kind === 'authorize' && result.value.kind === 'authorize') {
      if (result.value.state === 'rejected' || result.value.state === 'revoked') {
        const terminal = { ...original, state: result.value.state, ack: result.value };
        this.deps.journal.controls[index] = terminal;
        return this.adoptPersistedControl(terminal)
          ? { ok: true, reason: 'control-terminal-recorded' }
          : { ok: false, reason: 'control-evidence-unavailable' };
      } else if (result.value.state === 'authorized') {
        const grant = result.value.grant;
        if (!grant) return { ok: false, reason: 'control-grant-missing' };
        const { grantId, authorizedAtMs, ...target } = grant;
        if (controlPayloadHash(target) !== controlPayloadHash(original.target) ||
          createHash('sha256').update(grantId).digest('hex') === original.qualificationTokenDigest ||
          !Number.isSafeInteger(authorizedAtMs) || authorizedAtMs < original.target.liveEpochStartedAtMs) {
          return { ok: false, reason: 'control-grant-mismatch' };
        }
        this.deps.journal.controls[index] = { ...original, state: 'authorizing_unknown', grant, ack: result.value };
        if (!this.persist()) return { ok: false, reason: 'journal-write-failed' };
        this.revoke();
        return { ok: false, reason: 'targeted-revoke-started' };
      } else return { ok: false, reason: 'control-pending' };
    } else if (original.kind === 'revoke' && result.value.kind === 'revoke' && result.value.state === 'revoked') {
      return this.acceptRevokeAck(original, result.value)
        ? { ok: true, reason: 'control-terminal-recorded' }
        : { ok: false, reason: 'control-evidence-unavailable' };
    } else return { ok: false, reason: 'control-pending' };
  }

  async startRecovery(requestId: string): Promise<{ ok: boolean; reason: string; controlId?: string }> {
    const original = this.deps.journal.records.find((record) => record.requestId === requestId);
    if (!original || original.state !== 'unknown' || original.conflicts.length || this.degraded || this.deps.journal.corrupt) {
      return { ok: false, reason: 'original-recovery-unavailable' };
    }
    if (this.deps.journal.controls.some((control) => control.kind === 'message_reconcile' &&
      control.request.ref.requestId === requestId && ['pending', 'recovery_unknown'].includes(control.state))) {
      return { ok: false, reason: 'original-recovery-pending' };
    }
    const lastHeadControl = [...this.deps.journal.controls].reverse().find((control) => control.kind === 'message_reconcile' &&
      control.request.ref.requestId === requestId && control.request.factsRevision === original.factsRevision &&
      control.request.factsDigest === original.factsDigest);
    if (lastHeadControl?.kind === 'message_reconcile' && lastHeadControl.state !== 'held') {
      return { ok: false, reason: 'fact-head-already-reconciled' };
    }
    this.revoke();
    const token = this.revision;
    const controlId = randomBytes(16).toString('hex');
    const request: MessageReconcileRequest = { controlId, expectedSenderProcessNonce: original.senderProcessNonce,
      ref: messageReference(original), factsRevision: original.factsRevision, factsDigest: original.factsDigest,
      facts: structuredClone(original.facts), localFactsToken: token };
    const control: FrozenJournalControl = { kind: 'message_reconcile', id: controlId, payloadHash: messageReconcileHash(request),
      senderProcessNonce: original.senderProcessNonce, request, state: 'pending', ack: null };
    this.deps.journal.controls.push(control);
    original.recovery = { state: 'pending', factsRevision: original.factsRevision, factsDigest: original.factsDigest,
      controlId, receipt: null };
    if (!this.persist()) return { ok: false, reason: 'journal-write-failed', controlId };
    const result = await this.deps.gateway.frozenReconcileMessage(request);
    return this.finishRecoveryControl(control, original, token, result, controlId);
  }

  private async reconcileRecoveryControl(control: Extract<FrozenJournalControl, { kind: 'message_reconcile' }> ):
    Promise<{ ok: boolean; reason: string; controlId?: string }> {
    const original = this.deps.journal.records.find((record) => record.requestId === control.request.ref.requestId);
    if (!original) return { ok: false, reason: 'original-operation-unavailable', controlId: control.id };
    if (this.degraded || this.deps.journal.corrupt) return { ok: false, reason: 'journal-unavailable', controlId: control.id };
    if (control.state === 'committed') {
      const digest = this.recoveryAdoptionDigest(original, control);
      if (!digest) return { ok: false, reason: 'recovery-evidence-unavailable', controlId: control.id };
      if (!this.persist()) return { ok: false, reason: 'journal-write-failed', controlId: control.id };
      if (!this.deps.journal.controls.includes(control) || !this.deps.journal.records.includes(original) ||
        this.recoveryAdoptionDigest(original, control) !== digest) {
        return { ok: false, reason: 'recovery-superseded', controlId: control.id };
      }
      this.adoptedRecoveries.set(control.id, digest);
      return { ok: true, reason: 'committed', controlId: control.id };
    }
    if (!['pending', 'recovery_unknown'].includes(control.state)) {
      return { ok: true, reason: 'control-terminal-recorded', controlId: control.id };
    }
    const token = this.revision;
    if (control.ack?.state === 'committed' && control.ack.published) {
      return this.finishRecoveryControl(control, original, token, { ok: true, value: control.ack }, control.id);
    }
    const result = await this.deps.gateway.frozenRecoveryOperation(control.request);
    return this.finishRecoveryControl(control, original, token, result, control.id);
  }

  private finishRecoveryControl(control: Extract<FrozenJournalControl, { kind: 'message_reconcile' }>, original: FrozenJournalMessage,
    token: string, result: { ok: true; value: FrozenRecoveryControl } | { ok: false }, controlId: string):
    { ok: boolean; reason: string; controlId: string } {
    if (!this.deps.journal.controls.includes(control)) return { ok: false, reason: 'control-superseded', controlId };
    const current = this.revision === token && original.factsRevision === control.request.factsRevision &&
      original.factsDigest === control.request.factsDigest && original.conflicts.length === 0 &&
      controlPayloadHash(messageReference(original)) === controlPayloadHash(control.request.ref);
    if (!result.ok) {
      control.state = 'recovery_unknown';
      if (current) original.recovery = { state: 'recovery_unknown', factsRevision: original.factsRevision,
        factsDigest: original.factsDigest, controlId, receipt: null };
      this.persist();
      return { ok: false, reason: 'recovery-unknown', controlId };
    }
    const ack = result.value;
    if (!validateFrozenRecoveryControl(ack, control.request).ok) {
      control.state = 'recovery_unknown';
      if (current) original.recovery = { state: 'recovery_unknown', factsRevision: original.factsRevision,
        factsDigest: original.factsDigest, controlId, receipt: null };
      this.persist();
      return { ok: false, reason: 'recovery-unknown', controlId };
    }
    if (ack.state === 'committed' && ack.receipt &&
      ((original.writeAttempted && !ack.receipt.writeAttempted) ||
        (original.executionEnded && original.writeAttempted !== ack.receipt.writeAttempted))) {
      control.state = 'recovery_unknown';
      control.ack = ack;
      if (!original.conflicts.some((conflict) => conflict.reason === 'execution-facts-conflict' && conflict.controlId === controlId)) {
        original.conflicts.push({ reason: 'execution-facts-conflict', factId: null, controlId });
      }
      if (current) original.recovery = { state: 'blocked', factsRevision: original.factsRevision,
        factsDigest: original.factsDigest, controlId, receipt: null };
      this.persist();
      return { ok: false, reason: 'execution-facts-conflict', controlId };
    }
    control.ack = ack;
    if (ack.state === 'committed' && ack.published && ack.receipt) {
      if (current) {
        // First persist the verified ACK while the message remains held. A
        // later committed record can then only be written after this write
        // returned successfully, including the directory fsync.
        control.state = 'recovery_unknown';
        original.recovery = { state: 'recovery_unknown', factsRevision: original.factsRevision,
          factsDigest: original.factsDigest, controlId, receipt: null };
        if (!this.persist()) return { ok: false, reason: 'journal-write-failed', controlId };
        const previousState = original.state;
        const previousTerminal = original.terminalEvidence;
        const previousEnded = original.executionEnded;
        const previousAttempted = original.writeAttempted;
        control.state = 'committed';
        original.recovery = { state: 'committed', factsRevision: original.factsRevision,
          factsDigest: original.factsDigest, controlId, receipt: ack.receipt };
        original.terminalEvidence = terminalEvidenceFromReceipt(ack.receipt);
        original.executionEnded = true;
        original.writeAttempted = ack.receipt.writeAttempted;
        if (ack.receipt.decision === 'never_written_released') original.state = 'terminal_not_dispatched';
        if (!this.persist()) {
          control.state = 'recovery_unknown';
          original.state = previousState;
          original.terminalEvidence = previousTerminal;
          original.executionEnded = previousEnded;
          original.writeAttempted = previousAttempted;
          original.recovery = { state: 'recovery_unknown', factsRevision: original.factsRevision,
            factsDigest: original.factsDigest, controlId, receipt: null };
          return { ok: false, reason: 'journal-write-failed', controlId };
        }
        const digest = this.recoveryAdoptionDigest(original, control);
        if (!digest || this.revision !== token || !this.deps.journal.controls.includes(control)) {
          return { ok: false, reason: 'recovery-superseded', controlId };
        }
        this.adoptedRecoveries.set(control.id, digest);
        return { ok: true, reason: 'committed', controlId };
      }
      control.state = 'committed';
    } else if (ack.state === 'committed' && !ack.published && ack.receipt) {
      control.state = 'superseded';
      if (current) original.recovery = { state: 'blocked', factsRevision: original.factsRevision,
        factsDigest: original.factsDigest, controlId, receipt: null };
    } else if (['held', 'superseded', 'rejected'].includes(ack.state)) {
      control.state = ack.state as 'held' | 'superseded' | 'rejected';
      if (current) original.recovery = { state: 'blocked', factsRevision: original.factsRevision,
        factsDigest: original.factsDigest, controlId, receipt: null };
    } else {
      control.state = 'recovery_unknown';
      if (current) original.recovery = { state: 'recovery_unknown', factsRevision: original.factsRevision,
        factsDigest: original.factsDigest, controlId, receipt: null };
    }
    if (!this.persist()) return { ok: false, reason: 'journal-write-failed', controlId };
    return { ok: current && control.state === 'committed', reason: current ? control.state : 'historical-ack', controlId };
  }

  async retryRevokeControl(id: string): Promise<{ ok: boolean; reason: string }> {
    const original = this.deps.journal.controls.find((entry) => entry.id === id);
    if (!original || original.kind !== 'revoke') return { ok: false, reason: 'revoke-unavailable' };
    return this.reconcileControl(id);
  }

  async submit(input: { requestId: string; sourceKey: string | null; text: string;
    autoEvent?: { event: object; rawId: string; rawType: string } }): Promise<SubmitResult> {
    if (!/^[!-~]{1,128}$/.test(input.requestId)) return { status: 'rejected', reason: 'invalid-request-id' };
    const existing = this.deps.journal.records.find((record) => record.requestId === input.requestId);
    if (existing) return { status: 'duplicate', requestId: existing.requestId, outcome: existing.state };
    if (input.sourceKey !== null) {
      const existingSource = this.deps.journal.records.find((record) => record.sourceKey === input.sourceKey);
      if (existingSource) return { status: 'duplicate', requestId: existingSource.requestId, outcome: existingSource.state };
    }
    if (this.queueBlocked || !this.active || !this.liveEpoch || !this.liveStartedAtMs) return { status: 'rejected', reason: 'grant-unavailable' };
    if (!validatePublicText(input.text).ok) return { status: 'rejected', reason: 'text-invalid' };
    if (this.queue.length + (this.pumping ? 1 : 0) >= (this.deps.queueLimit ?? 10)) return { status: 'rejected', reason: 'queue-full' };
    let sourceKey = `manual:${createHash('sha256').update(input.requestId).digest('hex')}`;
    if (input.autoEvent) {
      const checked = validateAutoEvent(input.autoEvent.event, input.autoEvent, { liveEpoch: this.liveEpoch, sourceConnectionToken: this.sourceConnectionToken });
      if (!checked.ok) return { status: 'rejected', reason: checked.reason };
      const derived = deriveSourceKey({ liveEpoch: this.liveEpoch, inputConnectionGeneration: this.inputGeneration,
        rawId: input.autoEvent.rawId, rawType: input.autoEvent.rawType });
      sourceKey = `auto:${createHash('sha256').update(derived).digest('hex')}`;
      if (input.sourceKey !== null && input.sourceKey !== sourceKey) return { status: 'rejected', reason: 'source-key-mismatch' };
    } else if (input.sourceKey !== null) {
      sourceKey = input.sourceKey;
    }
    if (!/^[!-~]{1,128}$/.test(sourceKey)) return { status: 'rejected', reason: 'invalid-source-key' };
    const duplicate = this.deps.journal.records.find((record) => record.sourceKey === sourceKey);
    if (duplicate) return { status: 'duplicate', requestId: duplicate.requestId, outcome: duplicate.state };
    const request: FrozenSendInput = { requestId: input.requestId, sourceKey, grant: this.active, text: input.text,
      autoEvent: input.autoEvent ? { rawId: input.autoEvent.rawId, rawType: input.autoEvent.rawType } : null };
    const requestHash = controlPayloadHash(request);
    const helperPayload = { requestId: request.requestId, sourceKey, requestHash, sourceKind: request.autoEvent ? 'auto' : 'manual', grant: request.grant, text: request.text };
    const record: FrozenJournalMessage = { requestId: request.requestId, sourceKey, senderProcessNonce: request.grant.senderProcessNonce,
      grant: request.grant, requestHash, helperPayloadHash: controlPayloadHash(helperPayload),
      textDigest: createHash('sha256').update(request.text, 'utf8').digest('hex'), autoEvent: request.autoEvent,
      state: 'queued', executionEnded: false, writeAttempted: false, httpResponse: null, createdAtMs: this.clock.wall(),
      facts: [], factsRevision: 0, factsDigest: controlPayloadHash([]), conflicts: [], terminalEvidence: null,
      recovery: { state: 'blocked', factsRevision: 0, factsDigest: controlPayloadHash([]), controlId: null, receipt: null } };
    this.deps.journal.records.push(record);
    if (!this.persist()) return { status: 'rejected', reason: 'journal-write-failed' };
    this.queue.push({ request, revision: this.revision, deadline: this.clock.wall() + (this.deps.queueWaitMs ?? 30_000), event: input.autoEvent?.event ?? null });
    void this.pump();
    return { status: 'accepted', requestId: request.requestId };
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length) {
        const item = this.queue.shift()!;
        const record = this.deps.journal.records.find((entry) => entry.requestId === item.request.requestId);
        if (!record || record.state !== 'queued') continue;
        const delay = Math.max(0, this.lastDispatch + (this.deps.dispatchIntervalMs ?? 3000) - this.clock.wall());
        if (delay) await new Promise<void>((resolve) => setTimeout(resolve, delay));
        if (this.hold || this.revision !== item.revision || this.active !== item.request.grant || this.clock.wall() > item.deadline) {
          record.state = 'cancelled_before_dispatch';
          this.persist();
          continue;
        }
        if (item.event && item.request.autoEvent) {
          const checked = validateAutoEvent(item.event, item.request.autoEvent, { liveEpoch: item.request.grant.liveEpoch, sourceConnectionToken: this.sourceConnectionToken });
          if (!checked.ok) { record.state = 'cancelled_before_dispatch'; this.persist(); continue; }
        }
        record.state = 'dispatching';
        if (!this.persist()) return;
        this.lastDispatch = this.clock.wall();
        const result = await this.deps.gateway.frozenSend(item.request);
        if (!result.ok || result.value.state === 'unknown' || result.value.state === 'dispatching') {
          record.state = 'unknown';
          if (result.ok) { record.executionEnded = result.value.executionEnded; record.writeAttempted = result.value.writeAttempted; }
        } else {
          record.state = result.value.state;
          record.executionEnded = result.value.executionEnded;
          record.writeAttempted = result.value.writeAttempted;
        }
        if (result.ok) record.httpResponse = result.value.httpResponse;
        if (!this.persist() || record.state === 'unknown') { this.revoke(); return; }
      }
    } finally { this.pumping = false; }
  }

  operation(id: string): FrozenJournalMessage | null {
    const original = this.deps.journal.records.find((record) => record.requestId === id);
    if (!original) return null;
    const view = structuredClone(original);
    if (view.recovery.state === 'committed' && !this.isRecoveryAdopted(original)) {
      view.recovery = { ...view.recovery, state: 'recovery_unknown', receipt: null };
    }
    return view;
  }

  operations(): FrozenJournalMessage[] {
    return this.deps.journal.records.map((record) => this.operation(record.requestId)!).filter(Boolean);
  }

  controls(): Array<{ id: string; kind: FrozenJournalControl['kind']; historicalState: string; adoptedInCurrentInstance: boolean }> {
    return this.deps.journal.controls.map((control) => {
      const message = control.kind === 'message_reconcile'
        ? this.deps.journal.records.find((record) => record.recovery.controlId === control.id)
        : undefined;
      return {
        id: control.id,
        kind: control.kind,
        historicalState: control.state,
        adoptedInCurrentInstance: control.kind === 'message_reconcile'
          ? !!message && this.isRecoveryAdopted(message)
          : this.isControlAdopted(control),
      };
    });
  }
}
