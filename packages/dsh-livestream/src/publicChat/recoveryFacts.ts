import { controlPayloadHash } from './grantAuthority';
import { validateFrozenProposal, type FrozenGrantSnapshot } from './frozenGrant';
import { boundedString, hexDigest64, isObject, safeInteger } from './protocol';
import { isWellFormedUnicode } from './textPolicy';

/** An immutable reference to one original operation, never a current grant. */
export interface MessageRef {
  requestId: string;
  sourceKey: string;
  requestHash: string;
  helperPayloadHash: string;
  textDigest: string;
  grant: FrozenGrantSnapshot;
}

interface FactBase {
  factId: string;
  seq: number;
  refDigest: string;
  hostRecordedAtMs: number;
}

export type RecoveryFact =
  | (FactBase & { kind: 'note'; note: string })
  | (FactBase & {
    kind: 'positive_observation';
    source: 'owner' | 'designated-viewer';
    attributionStrength: 'direct' | 'indirect';
    observedAtMs: number;
    textDigest: string;
    principalUid: string;
    roomId: string;
    platformRoomId: string;
    observerRef: string | null;
  });

const printableId = (value: unknown): value is string =>
  boundedString(value, 128) && /^[\x21-\x7e]+$/.test(value);

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function validateMessageRef(value: unknown): value is MessageRef {
  if (!isObject(value) || !exactKeys(value, ['requestId', 'sourceKey', 'requestHash', 'helperPayloadHash', 'textDigest', 'grant']) ||
    !printableId(value.requestId) || !printableId(value.sourceKey) || !hexDigest64(value.requestHash) ||
    !hexDigest64(value.helperPayloadHash) || !hexDigest64(value.textDigest) || !isObject(value.grant)) return false;
  const { grantId, authorizedAtMs, ...proposal } = value.grant;
  return printableId(grantId) && safeInteger(authorizedAtMs) && validateFrozenProposal(proposal) &&
    authorizedAtMs >= proposal.liveEpochStartedAtMs;
}

export function messageRefDigest(ref: MessageRef): string {
  if (!validateMessageRef(ref)) throw new Error('invalid original message reference');
  return controlPayloadHash(ref);
}

function validFact(ref: MessageRef, value: unknown): value is RecoveryFact {
  if (!isObject(value) || !printableId(value.factId) || !safeInteger(value.seq) || value.seq < 1 ||
    value.refDigest !== messageRefDigest(ref) || !safeInteger(value.hostRecordedAtMs) || value.hostRecordedAtMs <= 0 ||
    value.hostRecordedAtMs > Number.MAX_SAFE_INTEGER - 5000) return false;
  const common = ['kind', 'factId', 'seq', 'refDigest', 'hostRecordedAtMs'];
  if (value.kind === 'note') {
    return exactKeys(value, [...common, 'note']) && boundedString(value.note, 500) && isWellFormedUnicode(value.note);
  }
  if (value.kind !== 'positive_observation' || !exactKeys(value, [...common, 'source', 'attributionStrength',
    'observedAtMs', 'textDigest', 'principalUid', 'roomId', 'platformRoomId', 'observerRef'])) return false;
  return (value.source === 'owner' || value.source === 'designated-viewer') &&
    (value.attributionStrength === 'direct' || value.attributionStrength === 'indirect') &&
    safeInteger(value.observedAtMs) && value.observedAtMs > 0 && value.observedAtMs <= value.hostRecordedAtMs + 5000 &&
    value.textDigest === ref.textDigest && value.principalUid === ref.grant.principalUid &&
    value.roomId === ref.grant.roomId && value.platformRoomId === ref.grant.platformRoomId &&
    (value.source === 'owner' ? value.observerRef === null : printableId(value.observerRef));
}

export type AppendRecoveryFactResult =
  | { ok: true; duplicate: boolean; facts: RecoveryFact[]; revision: number; digest: string }
  | { ok: false; conflict: boolean; reason: string };

/** Validates an append-only head. Persistence and invalidation remain the caller's responsibility. */
export function appendRecoveryFact(ref: MessageRef, facts: readonly RecoveryFact[], input: unknown): AppendRecoveryFactResult {
  if (!validateMessageRef(ref) || !Array.isArray(facts) || facts.length > 32) return { ok: false, conflict: false, reason: 'invalid-head' };
  const ids = new Set<string>();
  for (let index = 0; index < facts.length; index++) {
    const fact = facts[index];
    if (!validFact(ref, fact) || fact.seq !== index + 1 || ids.has(fact.factId)) {
      return { ok: false, conflict: true, reason: 'invalid-existing-head' };
    }
    ids.add(fact.factId);
  }
  if (!validFact(ref, input)) return { ok: false, conflict: false, reason: 'invalid-fact' };
  const previous = facts.find((fact) => fact.factId === input.factId);
  if (previous) {
    if (controlPayloadHash(previous) !== controlPayloadHash(input)) return { ok: false, conflict: true, reason: 'fact-id-conflict' };
    const copy = structuredClone(facts) as RecoveryFact[];
    return { ok: true, duplicate: true, facts: copy, revision: copy.length, digest: controlPayloadHash(copy) };
  }
  if (facts.length > 0 && input.hostRecordedAtMs < facts[facts.length - 1].hostRecordedAtMs) {
    return { ok: false, conflict: true, reason: 'fact-clock-rollback' };
  }
  if (facts.length >= 32 || input.seq !== facts.length + 1) return { ok: false, conflict: false, reason: 'fact-capacity-or-sequence' };
  const copy = structuredClone([...facts, input]);
  return { ok: true, duplicate: false, facts: copy, revision: copy.length, digest: controlPayloadHash(copy) };
}

/** Observation matching alone does not establish that the original worker joined. */
export function isQualifyingObservation(ref: MessageRef, fact: RecoveryFact, acceptedAtMs: number,
  firstWriteAttemptAtMs: number | null): boolean {
  if (!validateMessageRef(ref) || !validFact(ref, fact) || fact.kind !== 'positive_observation' ||
    fact.attributionStrength !== 'direct' || !safeInteger(acceptedAtMs) || acceptedAtMs <= 0 ||
    firstWriteAttemptAtMs === null || !safeInteger(firstWriteAttemptAtMs) || firstWriteAttemptAtMs < acceptedAtMs) return false;
  return fact.observedAtMs >= firstWriteAttemptAtMs;
}
