import { controlPayloadHash } from './grantAuthority';
import type { FrozenJournalControl } from './frozenJournal';
import { hexDigest64, isObject } from './protocol';

type HistoricalControl = Exclude<FrozenJournalControl, { kind: 'message_reconcile' }>;

/** Validate the original sender record and the helper operation it represents. */
export function validControlEvidence(control: HistoricalControl, controls: FrozenJournalControl[]): boolean {
  const ack = control.ack;
  if (!isObject(ack) || ack.senderProcessNonce !== control.senderProcessNonce || !hexDigest64(ack.helperPayloadHash)) return false;
  const baseKeys = ['kind', 'id', 'payloadHash', 'helperPayloadHash', 'senderProcessNonce', 'state', 'target'];
  const keys = Object.hasOwn(ack, 'grant') ? [...baseKeys, 'grant'] : baseKeys;
  if (Object.keys(ack).length !== keys.length || keys.some((key) => !Object.hasOwn(ack, key))) return false;
  if (ack.kind === 'authorize') {
    if (control.kind !== 'authorize' || ack.id !== control.id || ack.payloadHash !== control.payloadHash ||
      controlPayloadHash(ack.target) !== controlPayloadHash(control.target) ||
      ack.helperPayloadHash !== controlPayloadHash(control.target)) return false;
    if (control.state === 'active') {
      return ack.state === 'authorized' && control.grant !== null &&
        controlPayloadHash(ack.grant) === controlPayloadHash(control.grant);
    }
    if (control.state === 'rejected' && control.grant !== null) return false;
    return (control.state === 'rejected' || control.state === 'revoked') && ack.state === control.state;
  }
  if (ack.kind !== 'revoke' || ack.state !== 'revoked' || !isObject(ack.target) ||
    typeof ack.id !== 'string' || typeof ack.payloadHash !== 'string') return false;
  const target = ack.target;
  const original = controls.find((entry) => entry.kind === 'revoke' && entry.id === ack.id);
  if (!original || original.kind !== 'revoke' || original.senderProcessNonce !== control.senderProcessNonce ||
    original.payloadHash !== ack.payloadHash || controlPayloadHash(original.target) !== controlPayloadHash(target) ||
    controlPayloadHash({ revokeId: ack.id, expectedSenderProcessNonce: ack.senderProcessNonce, target }) !== ack.payloadHash) return false;
  let helperNonce: string;
  let targetId: string;
  if (target.kind === 'capture' && typeof target.captureId === 'string') {
    const capture = controls.find((entry) => entry.kind === 'capture' && entry.id === target.captureId);
    if (!capture || capture.kind !== 'capture' || capture.senderProcessNonce !== control.senderProcessNonce) return false;
    if (control.kind === 'capture' && (control.id !== capture.id || control.state !== 'revoked')) return false;
    if (control.kind === 'authorize') return false;
    helperNonce = capture.helperNonce;
    targetId = capture.id;
  } else if (target.kind === 'authorization' && typeof target.authorizationId === 'string') {
    const authorization = controls.find((entry) => entry.kind === 'authorize' && entry.id === target.authorizationId);
    if (!authorization || authorization.kind !== 'authorize' || authorization.senderProcessNonce !== control.senderProcessNonce) return false;
    if (control.kind === 'authorize' && (control.id !== authorization.id || control.state !== 'revoked')) return false;
    if (control.kind === 'capture') return false;
    if (target.grantId !== undefined && target.grantId !== authorization.grant?.grantId) return false;
    if (target.snapshot !== undefined && controlPayloadHash(target.snapshot) !== controlPayloadHash(authorization.grant)) return false;
    helperNonce = authorization.target.helperProcessNonce;
    targetId = authorization.id;
  } else return false;
  if (control.kind === 'revoke' && (control.id !== ack.id || control.state !== 'revoked')) return false;
  const grantId = target.kind === 'authorization' ? target.grantId ?? (isObject(target.snapshot) ? target.snapshot.grantId : undefined) : undefined;
  const helperPayload = { id: ack.id, helperNonce, kind: target.kind, targetId,
    ...(grantId === undefined ? {} : { grantId }) };
  return controlPayloadHash(helperPayload) === ack.helperPayloadHash;
}
