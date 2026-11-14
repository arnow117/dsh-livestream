import { randomBytes } from 'node:crypto';
import { controlPayloadHash } from './grantAuthority';
import { validateCommittedGrant, validateFrozenProposal, type FrozenGrantProposal, type FrozenGrantSnapshot } from './frozenGrant';
import type { HelperProcess, HelperReply } from './helperLauncher';
import { boundedString, isObject } from './protocol';

export interface FrozenQualification {
  captureId: string;
  qualificationToken: string;
  qualificationDigest: string;
  qualificationRevision: number;
  identityEpoch: number;
  principalUid: string;
  capturedAtMs: number;
}

export interface FrozenAuthorizationRequest {
  authorizationId: string;
  expectedSenderProcessNonce: string;
  qualificationToken: string;
  localRevision: string;
  target: FrozenGrantProposal;
}

export type FrozenRevokeTarget =
  | { kind: 'authorization'; authorizationId: string; grantId?: string; snapshot?: FrozenGrantSnapshot }
  | { kind: 'capture'; captureId: string };

export interface FrozenRevokeRequest {
  revokeId: string;
  expectedSenderProcessNonce: string;
  target: FrozenRevokeTarget;
}

type AuthorizationRecord = {
  kind: 'authorize';
  id: string;
  payloadHash: string;
  helperPayloadHash: string;
  senderProcessNonce: string;
  state: 'authorizing' | 'authorizing_unknown' | 'revoking_unknown' | 'authorized' | 'rejected' | 'revoked';
  target: FrozenGrantProposal;
  grant?: FrozenGrantSnapshot;
};

type RevokeRecord = {
  kind: 'revoke';
  id: string;
  payloadHash: string;
  helperPayloadHash: string;
  senderProcessNonce: string;
  state: 'revoking' | 'revoking_unknown' | 'revoked';
  target: FrozenRevokeTarget;
};

export type FrozenControlRecord = AuthorizationRecord | RevokeRecord;
export type FrozenControlResult =
  | { registered: true; record: FrozenControlRecord }
  | { registered: false; reason: 'invalid' | 'wrong-nonce' | 'conflict' | 'busy' | 'capacity' };

export type FrozenCaptureRecord = {
  id: string;
  senderProcessNonce: string;
  requestHash: string;
  helperPayloadHash: string;
  state: 'capturing' | 'capture_unknown' | 'revoking_unknown' | 'qualified' | 'rejected' | 'revoked';
  qualification?: FrozenQualification;
};

type HelperPort = Pick<HelperProcess, 'identity' | 'request'>;

/**
 * Sender control records own one helper authorization slot. The trusted
 * runtime supplies the current-revision predicate; no HTTP caller can install
 * a qualification or decide whether a room proof is current.
 */
export class FrozenControlAuthority {
  private readonly records = new Map<string, FrozenControlRecord>();
  private readonly revokedAuthorizations = new Set<string>();
  private readonly revokedCaptures = new Set<string>();
  private readonly confirmedAuthorizations = new Set<string>();
  private readonly confirmedCaptures = new Set<string>();
  private readonly captureIds = new Set<string>();
  private readonly captures = new Map<string, FrozenCaptureRecord>();
  private slot: { id: string; captureId: string; grant: FrozenGrantSnapshot | null } | null = null;
  private qualification: FrozenQualification | null = null;
  private pendingMaintenance: FrozenRevokeTarget | null = null;
  private hold = false;

  constructor(
    private readonly senderNonce: string,
    private readonly helper: HelperPort,
    private readonly isCurrent: (proposal: FrozenGrantProposal) => boolean,
    private readonly now: () => number = Date.now,
    private readonly capacity = 1024,
    private readonly isCaptureCurrent: () => boolean = () => false,
  ) {}

  get active(): FrozenGrantSnapshot | null {
    return this.slot?.grant ?? null;
  }

  get hasHold(): boolean { return this.hold; }

  get size(): number { return this.records.size + this.captures.size; }

  get currentQualification(): FrozenQualification | null {
    return this.qualification ? structuredClone(this.qualification) : null;
  }

  private refreshHold(): void {
    this.hold = this.pendingMaintenance !== null || [...this.records.values()].some((entry) => entry.state === 'authorizing_unknown' ||
      entry.state === 'revoking_unknown' || entry.state === 'revoking') ||
      [...this.captures.values()].some((entry) => entry.state === 'capture_unknown' || entry.state === 'revoking_unknown');
  }

  private settleMaintenance(target: FrozenRevokeTarget): void {
    const pending = this.pendingMaintenance;
    if (pending?.kind === 'authorization' && target.kind === 'authorization' && pending.authorizationId === target.authorizationId) {
      this.pendingMaintenance = null;
    } else if (pending?.kind === 'capture' && target.kind === 'capture' && pending.captureId === target.captureId) {
      this.pendingMaintenance = null;
    }
  }

  operation(id: string): FrozenControlRecord | null {
    const record = this.records.get(id);
    return record ? structuredClone(record) : null;
  }

  captureOperation(id: string): FrozenCaptureRecord | null {
    const record = this.captures.get(id);
    return record ? structuredClone(record) : null;
  }

  /**
   * Called synchronously before maintenance reads files or starts a helper.
   * It returns the original target for the caller's targeted revoke. It does
   * not treat local invalidation as a remote terminal acknowledgement.
   */
  beginMaintenance(): FrozenRevokeTarget | null {
    if (this.slot) {
      const original = this.records.get(this.slot.id);
      const target: FrozenRevokeTarget = { kind: 'authorization', authorizationId: this.slot.id,
        ...(this.slot.grant ? { grantId: this.slot.grant.grantId, snapshot: this.slot.grant } : {}) };
      this.revokedAuthorizations.add(this.slot.id);
      if (original?.kind === 'authorize') this.records.set(original.id, { ...original, state: 'revoking_unknown' });
      this.slot = null;
      this.qualification = null;
      this.pendingMaintenance = target;
      this.hold = true;
      return structuredClone(target);
    }
    if (this.qualification) {
      const captureId = this.qualification.captureId;
      this.revokedCaptures.add(captureId);
      this.qualification = null;
      this.pendingMaintenance = { kind: 'capture', captureId };
      this.hold = true;
      return { kind: 'capture', captureId };
    }
    const capturing = [...this.captures.values()].find((entry) => entry.state === 'capturing');
    if (capturing) {
      this.revokedCaptures.add(capturing.id);
      this.captures.set(capturing.id, { ...capturing, state: 'revoking_unknown' });
      this.pendingMaintenance = { kind: 'capture', captureId: capturing.id };
      this.hold = true;
      return { kind: 'capture', captureId: capturing.id };
    }
    return null;
  }

  /** Capture uses the helper's frozen context and retains the original ID. */
  async capture(captureId: string, expectedNonce: string, expectedUid: string,
    qualificationRevision: number, identityEpoch: number): Promise<FrozenCaptureRecord | null> {
    if (!boundedString(captureId, 128) || expectedNonce !== this.senderNonce || !/^[1-9][0-9]{0,19}$/.test(expectedUid) ||
      !Number.isSafeInteger(qualificationRevision) || qualificationRevision < 0 || !Number.isSafeInteger(identityEpoch) || identityEpoch < 0) return null;
    const requestHash = controlPayloadHash({ captureId, expectedNonce, expectedUid, qualificationRevision, identityEpoch });
    const previous = this.captures.get(captureId);
    if (previous) return previous.requestHash === requestHash ? structuredClone(previous) : null;
    if (this.records.has(captureId) || this.captureIds.has(captureId) || this.captureIds.size + this.records.size >= this.capacity) return null;
    const helperPayload = { captureId, helperNonce: this.helper.identity.helperNonce, qualificationRevision, identityEpoch };
    if (this.confirmedCaptures.has(captureId)) {
      const revoked: FrozenCaptureRecord = { id: captureId, senderProcessNonce: this.senderNonce, requestHash,
        helperPayloadHash: controlPayloadHash(helperPayload), state: 'revoked' };
      this.captureIds.add(captureId);
      this.captures.set(captureId, revoked);
      return structuredClone(revoked);
    }
    if (this.hold ||
      [...this.captures.values()].some((entry) => entry.state === 'capturing')) return null;
    const previousTarget = this.beginMaintenance();
    const pending: FrozenCaptureRecord = { id: captureId, senderProcessNonce: this.senderNonce, requestHash,
      helperPayloadHash: controlPayloadHash(helperPayload), state: 'capturing' };
    this.captureIds.add(captureId);
    this.captures.set(captureId, pending);
    if (previousTarget) {
      const revoked = await this.revoke({ revokeId: randomBytes(16).toString('hex'), expectedSenderProcessNonce: this.senderNonce, target: previousTarget });
      if (!revoked.registered || revoked.record.state !== 'revoked') {
        const latest = this.captures.get(captureId);
        if (latest?.state !== 'capturing') return latest ? structuredClone(latest) : null;
        const rejected = { ...pending, state: 'rejected' as const };
        this.captures.set(captureId, rejected);
        this.refreshHold();
        return structuredClone(rejected);
      }
    }
    if (this.revokedCaptures.has(captureId) || this.captures.get(captureId)?.state !== 'capturing') {
      return this.captureOperation(captureId);
    }
    let current = false;
    try { current = this.isCaptureCurrent(); } catch { current = false; }
    if (!current) {
      const rejected = { ...pending, state: 'rejected' as const };
      this.captures.set(captureId, rejected);
      return structuredClone(rejected);
    }
    try {
      const reply = await this.helper.request('profile', captureId, helperPayload,
        () => this.captures.get(captureId)?.state === 'capturing' && !this.revokedCaptures.has(captureId) && this.isCaptureCurrent());
      const latest = this.captures.get(captureId);
      if (latest?.state !== 'capturing') return latest ? structuredClone(latest) : null;
      const payload = reply.payload;
      if (!isObject(payload) || payload.kind !== 'profile' || payload.payloadHash !== pending.helperPayloadHash ||
        payload.targetId !== captureId || payload.state !== reply.status) throw new Error('untrusted profile');
      if (reply.status === 'rejected' || reply.status === 'revoked') {
        const terminal = { ...pending, state: reply.status } as FrozenCaptureRecord;
        this.captures.set(captureId, terminal);
        return structuredClone(terminal);
      }
      const proof = payload.qualification;
      const now = this.now();
      if (reply.status !== 'qualified' || !isObject(proof) || proof.captureId !== captureId || proof.principalUid !== expectedUid ||
        proof.revision !== qualificationRevision || proof.identityEpoch !== identityEpoch ||
        typeof proof.digest !== 'string' || !/^[a-f0-9]{64}$/.test(proof.digest) ||
        !Number.isSafeInteger(proof.capturedAtMs) || typeof proof.capturedAtMs !== 'number' || proof.capturedAtMs <= 0 ||
        !Number.isSafeInteger(now) || proof.capturedAtMs > now + 5000 || now - proof.capturedAtMs > 60_000 ||
        this.revokedCaptures.has(captureId) || !this.isCaptureCurrent()) throw new Error('stale profile');
      const qualification: FrozenQualification = Object.freeze({ captureId, principalUid: expectedUid,
        qualificationToken: randomBytes(16).toString('hex'), qualificationDigest: proof.digest,
        qualificationRevision, identityEpoch, capturedAtMs: proof.capturedAtMs });
      this.qualification = qualification;
      const qualified = { ...pending, state: 'qualified' as const, qualification };
      this.captures.set(captureId, qualified);
      return structuredClone(qualified);
    } catch {
      const latest = this.captures.get(captureId);
      if (latest?.state !== 'capturing') return latest ? structuredClone(latest) : null;
      const unknown = { ...pending, state: 'capture_unknown' as const };
      this.captures.set(captureId, unknown);
      this.hold = true;
      return structuredClone(unknown);
    }
  }

  private isOriginalCurrent(proposal: FrozenGrantProposal, qualification: FrozenQualification): boolean {
    const identity = this.helper.identity;
    const now = this.now();
    let current = false;
    try { current = this.isCurrent(proposal); } catch { current = false; }
    return this.qualification === qualification && !this.revokedCaptures.has(proposal.captureId) &&
      !this.revokedAuthorizations.has(proposal.authorizationId) && proposal.senderProcessNonce === this.senderNonce &&
      Number.isSafeInteger(now) && now >= qualification.capturedAtMs && now - qualification.capturedAtMs <= 60_000 &&
      proposal.captureId === qualification.captureId && proposal.principalUid === qualification.principalUid &&
      proposal.qualificationDigest === qualification.qualificationDigest && proposal.qualificationRevision === qualification.qualificationRevision &&
      proposal.identityEpoch === qualification.identityEpoch && proposal.helperProcessNonce === identity.helperNonce &&
      proposal.authContextId === identity.authContextId && proposal.authContextRevision === identity.authContextRevision &&
      proposal.materialDigest === identity.materialDigest && current;
  }

  async authorize(input: FrozenAuthorizationRequest): Promise<FrozenControlResult> {
    const request = structuredClone(input);
    if (!request || Object.keys(request).length !== 5 || !boundedString(request.authorizationId, 128) ||
      !boundedString(request.qualificationToken, 128) || !boundedString(request.localRevision, 128) ||
      !validateFrozenProposal(request.target) || request.target.authorizationId !== request.authorizationId) {
      return { registered: false, reason: 'invalid' };
    }
    if (request.expectedSenderProcessNonce !== this.senderNonce || request.target.senderProcessNonce !== this.senderNonce) {
      return { registered: false, reason: 'wrong-nonce' };
    }
    const payloadHash = controlPayloadHash(request);
    const previous = this.records.get(request.authorizationId);
    if (previous) return previous.kind === 'authorize' && previous.payloadHash === payloadHash
      ? { registered: true, record: structuredClone(previous) }
      : { registered: false, reason: 'conflict' };
    if (this.records.size + this.captureIds.size >= this.capacity) return { registered: false, reason: 'capacity' };
    if (this.captureIds.has(request.authorizationId)) return { registered: false, reason: 'conflict' };
    if (this.confirmedAuthorizations.has(request.authorizationId) || this.confirmedCaptures.has(request.target.captureId)) {
      const revoked: AuthorizationRecord = { kind: 'authorize', id: request.authorizationId, payloadHash,
        helperPayloadHash: controlPayloadHash(request.target), senderProcessNonce: this.senderNonce,
        state: 'revoked', target: Object.freeze({ ...request.target }) };
      this.records.set(request.authorizationId, revoked);
      return { registered: true, record: structuredClone(revoked) };
    }
    if (this.hold || this.slot) return { registered: false, reason: 'busy' };
    const qualification = this.qualification;
    if (!qualification || request.qualificationToken !== qualification.qualificationToken ||
      !this.isOriginalCurrent(request.target, qualification)) return { registered: false, reason: 'invalid' };

    const target = Object.freeze({ ...request.target });
    const helperPayloadHash = controlPayloadHash(target);
    const pending: AuthorizationRecord = { kind: 'authorize', id: request.authorizationId, payloadHash,
      helperPayloadHash, senderProcessNonce: this.senderNonce, state: 'authorizing', target };
    const slot = { id: request.authorizationId, captureId: target.captureId, grant: null as FrozenGrantSnapshot | null };
    this.records.set(request.authorizationId, pending);
    this.slot = slot;
    let reply: HelperReply;
    try {
      reply = await this.helper.request('bindGrant', request.authorizationId, target,
        () => this.slot === slot && this.isOriginalCurrent(target, qualification));
    } catch {
      const current = this.records.get(request.authorizationId);
      if (current?.kind === 'authorize' && (current.state === 'revoked' || current.state === 'revoking_unknown')) {
        return { registered: true, record: structuredClone(current) };
      }
      const unknown = { ...pending, state: 'authorizing_unknown' as const };
      this.records.set(request.authorizationId, unknown);
      this.hold = true;
      return { registered: true, record: structuredClone(unknown) };
    }
    const original = this.records.get(request.authorizationId);
    if (original?.kind === 'authorize' && (original.state === 'revoked' || original.state === 'revoking_unknown')) {
      const late = reply.payload;
      if (reply.status === 'authorized' && isObject(late) && late.kind === 'authorize' && late.state === 'authorized' &&
        late.payloadHash === helperPayloadHash &&
        validateCommittedGrant(late.grant, target, qualification.qualificationToken, qualification.capturedAtMs, this.now())) {
        const recorded = { ...original, grant: Object.freeze({ ...late.grant }) };
        this.records.set(original.id, recorded);
        return { registered: true, record: structuredClone(recorded) };
      }
      return { registered: true, record: structuredClone(original) };
    }
    const payload = reply.payload;
    const validRecord = isObject(payload) && payload.kind === 'authorize' && payload.payloadHash === helperPayloadHash && payload.state === reply.status;
    if (validRecord && (reply.status === 'rejected' || reply.status === 'revoked')) {
      const terminal = { ...pending, state: reply.status } as AuthorizationRecord;
      this.records.set(request.authorizationId, terminal);
      if (this.slot === slot) this.slot = null;
      return { registered: true, record: structuredClone(terminal) };
    }
    if (!validRecord || reply.status !== 'authorized' || !isObject(payload) ||
      !validateCommittedGrant(payload.grant, target, qualification.qualificationToken, qualification.capturedAtMs, this.now()) ||
      this.slot !== slot || !this.isOriginalCurrent(target, qualification)) {
      const unknown = { ...pending, state: 'authorizing_unknown' as const };
      this.records.set(request.authorizationId, unknown);
      this.hold = true;
      return { registered: true, record: structuredClone(unknown) };
    }
    const grant = Object.freeze({ ...payload.grant });
    slot.grant = grant;
    const authorized: AuthorizationRecord = { ...pending, state: 'authorized', grant };
    this.records.set(request.authorizationId, authorized);
    return { registered: true, record: structuredClone(authorized) };
  }

  async revoke(input: FrozenRevokeRequest): Promise<FrozenControlResult> {
    const request = structuredClone(input);
    const target = request?.target;
    if (!request || Object.keys(request).length !== 3 || !boundedString(request.revokeId, 128) || !target ||
      !((target.kind === 'authorization' && boundedString(target.authorizationId, 128) &&
        Object.keys(target).every((key) => ['kind', 'authorizationId', 'grantId', 'snapshot'].includes(key)) &&
        (!Object.hasOwn(target, 'grantId') || boundedString(target.grantId, 128)) &&
        (!Object.hasOwn(target, 'snapshot') || isObject(target.snapshot))) ||
        (target.kind === 'capture' && boundedString(target.captureId, 128) && Object.keys(target).length === 2))) {
      return { registered: false, reason: 'invalid' };
    }
    if (request.expectedSenderProcessNonce !== this.senderNonce) return { registered: false, reason: 'wrong-nonce' };
    const payloadHash = controlPayloadHash(request);
    const previous = this.records.get(request.revokeId);
    if (previous) return previous.kind === 'revoke' && previous.payloadHash === payloadHash
      ? { registered: true, record: structuredClone(previous) }
      : { registered: false, reason: 'conflict' };
    if (this.records.size + this.captureIds.size >= this.capacity) return { registered: false, reason: 'capacity' };
    if (this.captureIds.has(request.revokeId)) return { registered: false, reason: 'conflict' };
    if (target.kind === 'authorization' && (target.grantId !== undefined || target.snapshot !== undefined)) {
      const original = this.records.get(target.authorizationId);
      if (original?.kind !== 'authorize' || !original.grant ||
        (target.grantId !== undefined && original.grant.grantId !== target.grantId) ||
        (target.snapshot !== undefined && controlPayloadHash(original.grant) !== controlPayloadHash(target.snapshot))) {
        return { registered: false, reason: 'conflict' };
      }
    }
    const targetId = target.kind === 'authorization' ? target.authorizationId : target.captureId;
    const helperPayload = { id: request.revokeId, helperNonce: this.helper.identity.helperNonce,
      kind: target.kind, targetId, ...(target.kind === 'authorization' && (target.grantId || target.snapshot)
        ? { grantId: target.grantId ?? target.snapshot?.grantId } : {}) };
    const pending: RevokeRecord = { kind: 'revoke', id: request.revokeId, payloadHash,
      helperPayloadHash: controlPayloadHash(helperPayload), senderProcessNonce: this.senderNonce, state: 'revoking', target };
    this.records.set(request.revokeId, pending);
    if (target.kind === 'authorization') this.revokedAuthorizations.add(target.authorizationId);
    else {
      this.revokedCaptures.add(target.captureId);
      const capture = this.captures.get(target.captureId);
      if (capture && capture.state !== 'revoked') this.captures.set(capture.id, { ...capture, state: 'revoking_unknown' });
    }
    if (this.slot && (target.kind === 'authorization' ? this.slot.id === targetId : this.slot.captureId === targetId)) {
      const original = this.records.get(this.slot.id);
      if (original?.kind === 'authorize') this.records.set(original.id, { ...original, state: 'revoking_unknown' });
      this.slot = null;
    }
    if (target.kind === 'capture' && this.qualification?.captureId === targetId) this.qualification = null;
    this.hold = true;
    try {
      const reply = await this.helper.request('revoke', request.revokeId, helperPayload);
      const payload = reply.payload;
      if (reply.status !== 'revoked' || !isObject(payload) || payload.kind !== 'revoke' || payload.state !== 'revoked' ||
        payload.payloadHash !== pending.helperPayloadHash || payload.targetId !== targetId) throw new Error('untrusted revoke');
      const record = { ...pending, state: 'revoked' as const };
      this.records.set(request.revokeId, record);
      if (target.kind === 'authorization') {
        this.confirmedAuthorizations.add(targetId);
        const original = this.records.get(targetId);
        if (original?.kind === 'authorize') this.records.set(targetId, { ...original, state: 'revoked' });
      } else {
        this.confirmedCaptures.add(targetId);
        const capture = this.captures.get(targetId);
        if (capture) this.captures.set(targetId, { ...capture, state: 'revoked' });
        for (const [id, original] of this.records) {
          if (original.kind === 'authorize' && original.target.captureId === targetId && original.state === 'revoking_unknown') {
            this.records.set(id, { ...original, state: 'revoked' });
          }
        }
      }
      this.settleMaintenance(target);
      this.refreshHold();
      return { registered: true, record: structuredClone(record) };
    } catch {
      const unknown = { ...pending, state: 'revoking_unknown' as const };
      this.records.set(request.revokeId, unknown);
      return { registered: true, record: structuredClone(unknown) };
    }
  }

  /** Only a matching, registered original terminal can clear its own hold. */
  async reconcile(id: string): Promise<FrozenControlRecord | null> {
    const original = this.records.get(id);
    if (!original || (original.state !== 'authorizing_unknown' && original.state !== 'revoking_unknown')) return null;
    try {
      const reply = await this.helper.request('query', id, {});
      const current = this.records.get(id);
      const payload = reply.payload;
      if (current !== original || !isObject(payload) || payload.kind !== original.kind ||
        payload.payloadHash !== original.helperPayloadHash || payload.state !== reply.status) return null;
      if (original.kind === 'authorize' && (reply.status === 'rejected' || reply.status === 'revoked')) {
        if (reply.status === 'revoked' && payload.targetId !== original.id) return null;
        const terminal = { ...original, state: reply.status } as AuthorizationRecord;
        this.records.set(id, terminal);
        if (this.slot?.id === id) this.slot = null;
        this.settleMaintenance({ kind: 'authorization', authorizationId: id });
        this.refreshHold();
        return structuredClone(terminal);
      }
      if (original.kind === 'revoke' && reply.status === 'revoked') {
        const targetId = original.target.kind === 'authorization' ? original.target.authorizationId : original.target.captureId;
        if (payload.targetId !== targetId) return null;
        const terminal = { ...original, state: 'revoked' as const };
        this.records.set(id, terminal);
        if (original.target.kind === 'authorization') {
          this.confirmedAuthorizations.add(targetId);
          const auth = this.records.get(targetId);
          if (auth?.kind === 'authorize') this.records.set(targetId, { ...auth, state: 'revoked' });
        } else {
          this.confirmedCaptures.add(targetId);
          const capture = this.captures.get(targetId);
          if (capture) this.captures.set(targetId, { ...capture, state: 'revoked' });
          for (const [authId, auth] of this.records) {
            if (auth.kind === 'authorize' && auth.target.captureId === targetId && auth.state === 'revoking_unknown') {
              this.records.set(authId, { ...auth, state: 'revoked' });
            }
          }
        }
        this.settleMaintenance(original.target);
        this.refreshHold();
        return structuredClone(terminal);
      }
    } catch {
      // A timeout or a new helper's empty table is not terminal evidence.
    }
    return null;
  }
}
