import { controlPayloadHash } from './grantAuthority';
import type { HelperProcess, HelperReply } from './helperLauncher';
import { isObject } from './protocol';
import { helperReconcilePayload, messageReconcileHash, validMessageReconcileRequest, validateRecoveryReceipt,
  type MessageReconcileRequest, type RecoveryReceipt } from './recoveryProtocol';
import type { RecoveryFact } from './recoveryFacts';
import type { RuntimeOperation } from './frozenSenderRuntime';

export interface FrozenRecoveryControl {
  kind: 'message_reconcile';
  id: string;
  senderProcessNonce: string;
  payloadHash: string;
  helperPayloadHash: string;
  state: 'pending' | 'pending_join' | 'recovery_unknown' | 'held' | 'committed' | 'superseded' | 'rejected';
  request: MessageReconcileRequest;
  receipt: RecoveryReceipt | null;
  published: boolean;
}

type FactHead = { facts: RecoveryFact[]; digest: string; pendingId: string | null; latestId: string | null;
  released: boolean; conflict: boolean };

/** Sender-owned historical reconciliation; the helper remains the joined authority. */
export class FrozenRecoveryAuthority {
  private readonly controls = new Map<string, FrozenRecoveryControl>();
  private readonly heads = new Map<string, FactHead>();
  private readonly generations = new Map<string, number>();

  constructor(private readonly deps: {
    senderNonce: string;
    original: (id: string) => RuntimeOperation | null;
    helper: () => HelperProcess | null;
    idTaken: (id: string) => boolean;
    countOtherRecords: () => number;
    invalidate: (recoveryControlId: string, recoveryPayloadHash: string) => void;
    revision: () => number;
    now: () => number;
    onCommitted: (requestId: string, receipt: RecoveryReceipt) => void;
  }) {}

  get size(): number { return this.controls.size; }

  isReleased(original: RuntimeOperation): boolean {
    const head = this.heads.get(original.requestId);
    return !!head && head.released && !head.conflict && head.pendingId === null;
  }

  blocks(original: RuntimeOperation): boolean {
    const head = this.heads.get(original.requestId);
    return !!head && (head.conflict || head.pendingId !== null);
  }

  view(requestId: string): { factsRevision: number; factsDigest: string; recoveryControlId: string | null; recoveryReceipt: RecoveryReceipt | null } {
    const head = this.heads.get(requestId);
    const latest = head?.latestId ? this.controls.get(head.latestId) : null;
    return { factsRevision: head?.facts.length ?? 0, factsDigest: head?.digest ?? controlPayloadHash([]),
      recoveryControlId: head?.latestId ?? null, recoveryReceipt: head?.released && latest?.published && latest.receipt
        ? structuredClone(latest.receipt) : null };
  }

  operation(id: string): FrozenRecoveryControl | null {
    const value = this.controls.get(id);
    return value ? structuredClone(value) : null;
  }

  private referenceMatches(request: MessageReconcileRequest, original: RuntimeOperation): boolean {
    return request.ref.requestId === original.requestId && request.ref.sourceKey === original.sourceKey &&
      request.ref.requestHash === original.hash && request.ref.helperPayloadHash === original.helperPayloadHash &&
      request.ref.textDigest === original.textDigest && controlPayloadHash(request.ref.grant) === controlPayloadHash(original.grant);
  }

  async start(input: MessageReconcileRequest): Promise<FrozenRecoveryControl | null> {
    if (!validMessageReconcileRequest(input) || input.expectedSenderProcessNonce !== this.deps.senderNonce) return null;
    const request = structuredClone(input);
    const hash = messageReconcileHash(request);
    const existing = this.controls.get(request.controlId);
    if (existing) return existing.payloadHash === hash ? structuredClone(existing) : null;
    if (this.deps.idTaken(request.controlId) || this.controls.size + this.deps.countOtherRecords() >= 1024) return null;
    const original = this.deps.original(request.ref.requestId);
    const helper = this.deps.helper();
    if (!original || !['dispatching', 'unknown', 'terminal_not_dispatched'].includes(original.state) ||
      !this.referenceMatches(request, original) || !helper ||
      helper.identity.helperNonce !== request.ref.grant.helperProcessNonce ||
      helper.identity.authContextId !== request.ref.grant.authContextId ||
      helper.identity.authContextRevision !== request.ref.grant.authContextRevision ||
      helper.identity.materialDigest !== request.ref.grant.materialDigest) return null;
    let head = this.heads.get(original.requestId);
    if (head?.pendingId) return null;
    if (head && head.latestId && request.factsRevision === head.facts.length && request.factsDigest === head.digest &&
      this.controls.get(head.latestId)?.state !== 'held') return null;
    const helperPayloadHash = controlPayloadHash(helperReconcilePayload(request));
    const record: FrozenRecoveryControl = { kind: 'message_reconcile', id: request.controlId,
      senderProcessNonce: this.deps.senderNonce, payloadHash: hash, helperPayloadHash, state: 'pending', request, receipt: null, published: false };
    if (head && request.factsRevision < head.facts.length) {
      record.state = 'superseded';
      this.controls.set(record.id, record);
      return structuredClone(record);
    }
    if (head && head.facts.some((fact, index) => controlPayloadHash(fact) !== controlPayloadHash(request.facts[index]))) {
      head.conflict = true;
      head.released = false;
      this.deps.invalidate(request.controlId, hash);
      record.state = 'held';
      this.controls.set(record.id, record);
      return structuredClone(record);
    }
    if (!head) {
      head = { facts: [], digest: controlPayloadHash([]), pendingId: null, latestId: null, released: false, conflict: false };
      this.heads.set(original.requestId, head);
    }
    if (head.conflict) {
      record.state = 'held';
      this.controls.set(record.id, record);
      return structuredClone(record);
    }
    if (request.factsRevision > head.facts.length) {
      head.released = false;
    }
    this.deps.invalidate(request.controlId, hash);
    head.facts = structuredClone(request.facts);
    head.digest = request.factsDigest;
    head.pendingId = record.id;
    head.latestId = record.id;
    this.controls.set(record.id, record);
    this.generations.set(record.id, this.deps.revision());
    return this.callHelper(record, helper, false);
  }

  async query(id: string): Promise<FrozenRecoveryControl | null> {
    const record = this.controls.get(id);
    if (!record) return null;
    if (record.state !== 'pending_join' && record.state !== 'recovery_unknown' && record.state !== 'pending') return structuredClone(record);
    const helper = this.deps.helper();
    if (!helper || helper.identity.helperNonce !== record.request.ref.grant.helperProcessNonce ||
      helper.identity.authContextId !== record.request.ref.grant.authContextId ||
      helper.identity.authContextRevision !== record.request.ref.grant.authContextRevision ||
      helper.identity.materialDigest !== record.request.ref.grant.materialDigest) return structuredClone(record);
    return this.callHelper(record, helper, true);
  }

  private async callHelper(record: FrozenRecoveryControl, helper: HelperProcess, query: boolean): Promise<FrozenRecoveryControl> {
    try {
      const reply = await helper.request(query ? 'query' : 'reconcileMessage', record.id,
        query ? {} : helperReconcilePayload(record.request));
      return this.acceptReply(record, helper, reply);
    } catch {
      if (this.controls.get(record.id) === record && ['pending', 'pending_join', 'recovery_unknown'].includes(record.state)) {
        record.state = 'recovery_unknown';
      }
      return structuredClone(record);
    }
  }

  private acceptReply(record: FrozenRecoveryControl, helper: HelperProcess, reply: HelperReply): FrozenRecoveryControl {
    if (['held', 'committed', 'superseded', 'rejected'].includes(record.state)) return structuredClone(record);
    const view = reply.payload;
    if (this.controls.get(record.id) !== record || !isObject(view) || view.kind !== 'message_reconcile' ||
      view.payloadHash !== record.helperPayloadHash || view.state !== reply.status || !isObject(view.reconcile) ||
      controlPayloadHash(view.reconcile.request) !== controlPayloadHash(helperReconcilePayload(record.request)) ||
      !['pending_join', 'held', 'committed', 'superseded', 'rejected'].includes(reply.status)) throw new Error('invalid original recovery record');
    if (reply.status === 'committed') {
      if (!validateRecoveryReceipt(view.reconcile.receipt, record.request, this.deps.now())) throw new Error('invalid recovery receipt');
      const receipt = view.reconcile.receipt;
      const original = this.deps.original(record.request.ref.requestId);
      if (!original || !this.referenceMatches(record.request, original) ||
        (original.writeAttempted && !receipt.writeAttempted) ||
        (original.acceptedAtMs !== null && original.acceptedAtMs !== receipt.acceptedAtMs) ||
        (original.firstWriteAttemptAtMs !== null && original.firstWriteAttemptAtMs !== receipt.firstWriteAttemptAtMs) ||
        (original.joinedWitnessId !== null && original.joinedWitnessId !== receipt.joinedWitnessId) ||
        (original.joinedAtMs !== null && original.joinedAtMs !== receipt.joinedAtMs)) {
        throw new Error('original execution facts mismatch');
      }
      record.receipt = structuredClone(receipt);
    } else if (view.reconcile.receipt !== null) {
      throw new Error('unexpected recovery receipt');
    }
    record.state = reply.status as FrozenRecoveryControl['state'];
    const head = this.heads.get(record.request.ref.requestId);
    if (head?.pendingId === record.id && record.state !== 'pending_join') {
      head.pendingId = null;
      if (record.state === 'committed' && this.deps.helper() === helper && !head.conflict &&
        this.generations.get(record.id) === this.deps.revision() && head.digest === record.request.factsDigest &&
        head.facts.length === record.request.factsRevision) {
        head.released = true;
        record.published = true;
        if (record.receipt) this.deps.onCommitted(record.request.ref.requestId, record.receipt);
      }
    }
    return structuredClone(record);
  }
}
