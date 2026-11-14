import { controlPayloadHash } from './grantAuthority';
import { boundedString, hexDigest64, isObject, safeInteger, PUBLIC_CHAT_PROTOCOL } from './protocol';

export interface FrozenGrantProposal {
  version: string;
  transportKind: 'frozen_http';
  buildDigest: string;
  instanceId: string;
  senderProcessNonce: string;
  senderConnectionGeneration: number;
  authorizationId: string;
  captureId: string;
  qualificationDigest: string;
  qualificationRevision: number;
  identityEpoch: number;
  accountRecordId: string;
  principalUid: string;
  roomId: string;
  platformRoomId: string;
  helperProcessNonce: string;
  authContextId: string;
  authContextRevision: number;
  materialDigest: string;
  rawSourceSessionId: string;
  rawSourceConnectionGeneration: number;
  rawBrowserContextId: string;
  roomBindingProofDigest: string;
  inputConnectionGeneration: number;
  liveEpoch: string;
  liveEpochStartedAtMs: number;
}

export interface FrozenGrantSnapshot extends FrozenGrantProposal {
  grantId: string;
  authorizedAtMs: number;
}

const proposalKeys = [
  'version', 'transportKind', 'buildDigest', 'instanceId', 'senderProcessNonce', 'senderConnectionGeneration',
  'authorizationId', 'captureId', 'qualificationDigest', 'qualificationRevision', 'identityEpoch', 'accountRecordId',
  'principalUid', 'roomId', 'platformRoomId', 'helperProcessNonce', 'authContextId', 'authContextRevision',
  'materialDigest', 'rawSourceSessionId', 'rawSourceConnectionGeneration', 'rawBrowserContextId',
  'roomBindingProofDigest', 'inputConnectionGeneration', 'liveEpoch', 'liveEpochStartedAtMs',
] as const;

function canonicalUint64(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,19}$/.test(value)) return false;
  try { return BigInt(value) <= 0xffffffffffffffffn; } catch { return false; }
}

export function validateFrozenProposal(value: unknown): value is FrozenGrantProposal {
  if (!isObject(value) || Object.keys(value).length !== proposalKeys.length || proposalKeys.some((key) => !Object.hasOwn(value, key))) return false;
  if (value.version !== PUBLIC_CHAT_PROTOCOL || value.transportKind !== 'frozen_http') return false;
  for (const key of ['buildDigest', 'qualificationDigest', 'materialDigest', 'roomBindingProofDigest']) {
    if (!hexDigest64(value[key])) return false;
  }
  for (const key of ['instanceId', 'senderProcessNonce', 'authorizationId', 'captureId', 'accountRecordId', 'helperProcessNonce',
    'authContextId', 'rawSourceSessionId', 'rawBrowserContextId', 'liveEpoch']) {
    if (!boundedString(value[key], 128) || !/^[\x21-\x7e]+$/.test(value[key] as string)) return false;
  }
  for (const key of ['senderConnectionGeneration', 'qualificationRevision', 'identityEpoch', 'authContextRevision',
    'rawSourceConnectionGeneration', 'inputConnectionGeneration']) {
    if (!safeInteger(value[key])) return false;
  }
  return canonicalUint64(value.principalUid) && typeof value.roomId === 'string' && /^[0-9]{1,64}$/.test(value.roomId) &&
    canonicalUint64(value.platformRoomId) && safeInteger(value.liveEpochStartedAtMs) && value.liveEpochStartedAtMs > 0;
}

export function validateCommittedGrant(value: unknown, original: FrozenGrantProposal, qualificationToken: string,
  capturedAtMs: number, nowMs: number): value is FrozenGrantSnapshot {
  if (!isObject(value) || Object.keys(value).length !== proposalKeys.length + 2 ||
    !boundedString(value.grantId, 128) || value.grantId === qualificationToken ||
    !safeInteger(value.authorizedAtMs) || !safeInteger(capturedAtMs) || !safeInteger(nowMs) ||
    value.authorizedAtMs < Math.max(original.liveEpochStartedAtMs, capturedAtMs) || value.authorizedAtMs > nowMs + 5_000) return false;
  const { grantId, authorizedAtMs, ...proposal } = value;
  return validateFrozenProposal(proposal) && controlPayloadHash(proposal) === controlPayloadHash(original);
}
