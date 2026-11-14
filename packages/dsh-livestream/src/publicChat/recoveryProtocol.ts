import { controlPayloadHash } from './grantAuthority';
import { appendRecoveryFact, isQualifyingObservation, messageRefDigest, validateMessageRef,
  type MessageRef, type RecoveryFact } from './recoveryFacts';
import { boundedString, hexDigest64, isObject, safeInteger } from './protocol';

export interface MessageReconcileRequest {
  controlId: string;
  expectedSenderProcessNonce: string;
  ref: MessageRef;
  factsRevision: number;
  factsDigest: string;
  facts: RecoveryFact[];
  localFactsToken: string;
}

export interface RecoveryReceipt {
  version: 'dsh-public-chat-recovery-v1';
  controlId: string;
  kind: 'message_reconcile';
  originControlPayloadHash: string;
  helperPayloadHash: string;
  ref: MessageRef;
  refDigest: string;
  factsRevision: number;
  factsDigest: string;
  helperNonce: string;
  senderProcessNonce: string;
  authContextId: string;
  authContextRevision: number;
  materialDigest: string;
  joinedWitnessId: string;
  joinedAtMs: number;
  acceptedAtMs: number;
  firstWriteAttemptAtMs: number | null;
  writeAttempted: boolean;
  recoveryCommitId: string;
  committedAtMs: number;
  decision: 'observed_unknown_released' | 'never_written_released';
}

const identifier = (value: unknown): value is string =>
  boundedString(value, 128) && /^[\x21-\x7e]+$/.test(value);

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function validMessageReconcileRequest(value: unknown): value is MessageReconcileRequest {
  if (!isObject(value) || !exactKeys(value, ['controlId', 'expectedSenderProcessNonce', 'ref', 'factsRevision',
    'factsDigest', 'facts', 'localFactsToken']) || !identifier(value.controlId) ||
    !identifier(value.expectedSenderProcessNonce) || !identifier(value.localFactsToken) || !validateMessageRef(value.ref) ||
    value.expectedSenderProcessNonce !== value.ref.grant.senderProcessNonce || !Array.isArray(value.facts) ||
    value.facts.length > 32 || value.factsRevision !== value.facts.length || !hexDigest64(value.factsDigest)) return false;
  let head: RecoveryFact[] = [];
  for (const fact of value.facts) {
    const next = appendRecoveryFact(value.ref, head, fact);
    if (!next.ok || next.duplicate) return false;
    head = next.facts;
  }
  return controlPayloadHash(head) === value.factsDigest;
}

export function messageReconcileHash(request: MessageReconcileRequest): string {
  return controlPayloadHash({ kind: 'message_reconcile', ...request });
}

export function helperReconcilePayload(request: MessageReconcileRequest) {
  return { controlId: request.controlId, ref: request.ref, factsRevision: request.factsRevision,
    factsDigest: request.factsDigest, facts: request.facts, originControlPayloadHash: messageReconcileHash(request) };
}

/** Validate only data received from the original authenticated helper channel. */
export function validateRecoveryReceipt(value: unknown, request: MessageReconcileRequest, receivedAtMs?: number): value is RecoveryReceipt {
  const keys = ['version', 'controlId', 'kind', 'originControlPayloadHash', 'helperPayloadHash', 'ref', 'refDigest',
    'factsRevision', 'factsDigest', 'helperNonce', 'senderProcessNonce', 'authContextId', 'authContextRevision',
    'materialDigest', 'joinedWitnessId', 'joinedAtMs', 'acceptedAtMs', 'firstWriteAttemptAtMs', 'writeAttempted',
    'recoveryCommitId', 'committedAtMs', 'decision'];
  if (!validMessageReconcileRequest(request) || !isObject(value) || !exactKeys(value, keys) ||
    value.version !== 'dsh-public-chat-recovery-v1' || value.kind !== 'message_reconcile' || value.controlId !== request.controlId ||
    value.originControlPayloadHash !== messageReconcileHash(request) ||
    value.helperPayloadHash !== controlPayloadHash(helperReconcilePayload(request)) ||
    !validateMessageRef(value.ref) || controlPayloadHash(value.ref) !== controlPayloadHash(request.ref) ||
    value.refDigest !== messageRefDigest(request.ref) || value.factsRevision !== request.factsRevision ||
    value.factsDigest !== request.factsDigest || value.helperNonce !== request.ref.grant.helperProcessNonce ||
    value.senderProcessNonce !== request.ref.grant.senderProcessNonce || value.authContextId !== request.ref.grant.authContextId ||
    value.authContextRevision !== request.ref.grant.authContextRevision || value.materialDigest !== request.ref.grant.materialDigest ||
    !identifier(value.joinedWitnessId) || !identifier(value.recoveryCommitId) ||
    !safeInteger(value.acceptedAtMs) || value.acceptedAtMs < request.ref.grant.authorizedAtMs ||
    !safeInteger(value.joinedAtMs) || value.joinedAtMs < value.acceptedAtMs ||
    !safeInteger(value.committedAtMs) || value.committedAtMs < value.joinedAtMs || typeof value.writeAttempted !== 'boolean') return false;
  if (request.facts.some((fact) => fact.hostRecordedAtMs > (value.committedAtMs as number) + 5000)) return false;
  if (receivedAtMs !== undefined && (!safeInteger(receivedAtMs) || receivedAtMs > Number.MAX_SAFE_INTEGER - 5000 ||
    (value.committedAtMs as number) > receivedAtMs + 5000)) return false;
  if (value.writeAttempted) {
    if (!safeInteger(value.firstWriteAttemptAtMs) || value.firstWriteAttemptAtMs < value.acceptedAtMs ||
      value.firstWriteAttemptAtMs > value.joinedAtMs || value.decision !== 'observed_unknown_released') return false;
    return request.facts.some((fact) => isQualifyingObservation(request.ref, fact, value.acceptedAtMs as number,
      value.firstWriteAttemptAtMs as number));
  }
  return value.firstWriteAttemptAtMs === null && value.decision === 'never_written_released' &&
    !request.facts.some((fact) => fact.kind === 'positive_observation');
}
