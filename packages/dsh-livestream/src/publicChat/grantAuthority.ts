/** Sender-side explicit authorization operations. No grant is restored on restart. */
import { createHash, randomBytes } from 'node:crypto';
import { PUBLIC_CHAT_PROTOCOL, boundedString, hexDigest64, safeInteger } from './protocol';
import { isValidPrincipalUid, isValidRoomId } from './binding';

export interface GrantTarget {
  version: string;
  buildDigest: string;
  instanceId: string;
  senderProcessNonce: string;
  captureId: string;
  qualificationDigest: string;
  qualificationRevision: number;
  accountRecordId: string;
  principalUid: string;
  roomId: string;
  browserContextId: string;
  senderSessionId: string;
  senderConnectionGeneration: number;
  identityEpoch: number;
  authCookieGeneration: number;
  liveEpoch: string;
  liveEpochStartedAtMs: number;
  inputConnectionGeneration: number;
}

export interface AuthorizeRequest {
  authorizationId: string;
  expectedSenderProcessNonce: string;
  qualificationToken: string;
  target: GrantTarget;
  localRevision: string;
}

export interface GrantSnapshot extends GrantTarget {
  authorizationId: string;
  grantId: string;
  authorizedAtMs: number;
}

export type RevokeTarget =
  | { kind: 'authorization'; authorizationId: string; grantId?: string; snapshot?: GrantSnapshot }
  | { kind: 'capture'; captureId: string };

export interface RevokeRequest {
  revokeId: string;
  expectedSenderProcessNonce: string;
  target: RevokeTarget;
}

export type ControlRecord =
  | { kind: 'authorize'; id: string; payloadHash: string; senderProcessNonce: string; state: 'authorizing' | 'rejected' | 'revoked'; target: GrantTarget; grant?: GrantSnapshot }
  | { kind: 'authorize'; id: string; payloadHash: string; senderProcessNonce: string; state: 'authorized'; target: GrantTarget; grant: GrantSnapshot }
  | { kind: 'revoke'; id: string; payloadHash: string; senderProcessNonce: string; state: 'revoked'; target: RevokeTarget };

export type ControlResult =
  | { registered: true; record: ControlRecord }
  | { registered: false; reason: 'invalid' | 'wrong-nonce' | 'conflict' | 'busy' | 'capacity' };

/** Stable hash independent of JSON object property order. */
export function controlPayloadHash(value: unknown): string {
  const canonical = (item: unknown): string => {
    if (item === null || typeof item !== 'object') return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(canonical).join(',')}]`;
    const object = item as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
  };
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export function isValidGrantTarget(target: GrantTarget): boolean {
  if (target === null || typeof target !== 'object' || Array.isArray(target)) return false;
  const keys = ['version', 'buildDigest', 'instanceId', 'senderProcessNonce', 'captureId', 'qualificationDigest',
    'qualificationRevision', 'accountRecordId', 'principalUid', 'roomId', 'browserContextId', 'senderSessionId',
    'senderConnectionGeneration', 'identityEpoch', 'authCookieGeneration', 'liveEpoch', 'liveEpochStartedAtMs',
    'inputConnectionGeneration'];
  if (Object.keys(target).length !== keys.length || keys.some((key) => !(key in target))) return false;
  return target !== null && typeof target === 'object'
    && target.version === PUBLIC_CHAT_PROTOCOL
    && hexDigest64(target.buildDigest)
    && boundedString(target.instanceId, 128)
    && boundedString(target.senderProcessNonce, 128)
    && boundedString(target.captureId, 128)
    && hexDigest64(target.qualificationDigest)
    && safeInteger(target.qualificationRevision)
    && boundedString(target.accountRecordId, 128)
    && isValidPrincipalUid(target.principalUid)
    && isValidRoomId(target.roomId)
    && boundedString(target.browserContextId, 128)
    && boundedString(target.senderSessionId, 128)
    && safeInteger(target.senderConnectionGeneration)
    && safeInteger(target.identityEpoch)
    && safeInteger(target.authCookieGeneration)
    && boundedString(target.liveEpoch, 128)
    && safeInteger(target.liveEpochStartedAtMs) && target.liveEpochStartedAtMs > 0
    && safeInteger(target.inputConnectionGeneration);
}

/** Single sender slot with non-evicting operation records and targeted tombstones. */
export class GrantAuthority {
  private readonly records = new Map<string, ControlRecord>();
  private readonly cancelledAuthorizations = new Set<string>();
  private readonly cancelledCaptures = new Set<string>();
  private slot: { id: string; captureId: string; grant: GrantSnapshot | null } | null = null;

  constructor(private readonly nonce: string, private readonly capacity = 1024, private readonly now = () => Date.now()) {}

  get active(): GrantSnapshot | null {
    return this.slot?.grant ?? null;
  }

  get currentAuthorizationId(): string | null {
    return this.slot?.id ?? null;
  }

  authorizationCancelled(id: string): boolean {
    return this.cancelledAuthorizations.has(id);
  }

  captureCancelled(captureId: string): boolean {
    return this.cancelledCaptures.has(captureId);
  }

  operation(id: string): ControlRecord | null {
    return this.records.get(id) ?? null;
  }

  /** Invalidate only the current slot and its recorded authorization. */
  invalidateActive(): void {
    if (this.slot === null) return;
    const original = this.records.get(this.slot.id);
    this.cancelledAuthorizations.add(this.slot.id);
    if (original?.kind === 'authorize') {
      this.records.set(original.id, Object.freeze({ kind: 'authorize', id: original.id, payloadHash: original.payloadHash, senderProcessNonce: original.senderProcessNonce, state: 'revoked', target: original.target, ...(original.state === 'authorized' ? { grant: original.grant } : {}) }));
    }
    this.slot = null;
  }

  async authorize(request: AuthorizeRequest, verify: () => Promise<boolean>, stillValid: () => boolean): Promise<ControlResult> {
    if (!request || !boundedString(request.authorizationId, 128) || !boundedString(request.qualificationToken, 128)
      || Object.keys(request).length !== 5 || !boundedString(request.localRevision, 128)
      || !isValidGrantTarget(request.target)) return { registered: false, reason: 'invalid' };
    if (request.expectedSenderProcessNonce !== this.nonce || request.target.senderProcessNonce !== this.nonce) return { registered: false, reason: 'wrong-nonce' };
    const hash = controlPayloadHash(request);
    const previous = this.records.get(request.authorizationId);
    if (previous) {
      return previous.kind === 'authorize' && previous.payloadHash === hash
        ? { registered: true, record: previous }
        : { registered: false, reason: 'conflict' };
    }
    if (this.records.size >= this.capacity) return { registered: false, reason: 'capacity' };
    const authorizationId = request.authorizationId;
    const target = Object.freeze({ ...request.target });
    const pending: ControlRecord = { kind: 'authorize', id: request.authorizationId, payloadHash: hash, senderProcessNonce: this.nonce, state: 'authorizing', target };
    if (this.cancelledAuthorizations.has(request.authorizationId) || this.cancelledCaptures.has(target.captureId)) {
      const revoked: ControlRecord = { ...pending, state: 'revoked' };
      this.records.set(authorizationId, Object.freeze(revoked));
      return { registered: true, record: revoked };
    }
    if (this.slot !== null) return { registered: false, reason: 'busy' };
    const slot = { id: request.authorizationId, captureId: target.captureId, grant: null as GrantSnapshot | null };
    this.slot = slot;
    this.records.set(authorizationId, Object.freeze(pending));
    let verified = false;
    try { verified = await verify(); } catch { verified = false; }
    const current = this.records.get(authorizationId);
    if (current?.state === 'revoked') return { registered: true, record: current };
    let valid = false;
    try { valid = stillValid(); } catch { valid = false; }
    const eligible = verified && this.slot === slot && valid
      && !this.cancelledAuthorizations.has(authorizationId)
      && !this.cancelledCaptures.has(target.captureId);
    if (!eligible) {
      const rejected: ControlRecord = { ...pending, state: 'rejected' };
      this.records.set(authorizationId, Object.freeze(rejected));
      if (this.slot === slot) this.slot = null;
      return { registered: true, record: rejected };
    }
    const authorizedAtMs = this.now();
    if (!safeInteger(authorizedAtMs) || authorizedAtMs <= 0 || target.liveEpochStartedAtMs > authorizedAtMs) {
      const rejected: ControlRecord = { ...pending, state: 'rejected' };
      this.records.set(authorizationId, Object.freeze(rejected));
      this.slot = null;
      return { registered: true, record: rejected };
    }
    const grant: GrantSnapshot = Object.freeze({ ...target, authorizationId, grantId: randomBytes(16).toString('hex'), authorizedAtMs });
    slot.grant = grant;
    const record: ControlRecord = { ...pending, state: 'authorized', grant };
    this.records.set(authorizationId, Object.freeze(record));
    return { registered: true, record };
  }

  revoke(request: RevokeRequest): ControlResult {
    if (!request || !boundedString(request.revokeId, 128) || !request.target ||
      !((request.target.kind === 'capture' && boundedString(request.target.captureId, 128)) ||
        (request.target.kind === 'authorization' && boundedString(request.target.authorizationId, 128)))) return { registered: false, reason: 'invalid' };
    const keys = Object.keys(request.target);
    if (Object.keys(request).length !== 3 || (request.target.kind === 'capture' && (keys.length !== 2 || keys.some((key) => !['kind', 'captureId'].includes(key))))
      || (request.target.kind === 'authorization' && (keys.some((key) => !['kind', 'authorizationId', 'grantId', 'snapshot'].includes(key))
        || (request.target.grantId !== undefined && !boundedString(request.target.grantId, 128))))) return { registered: false, reason: 'invalid' };
    if (request.expectedSenderProcessNonce !== this.nonce) return { registered: false, reason: 'wrong-nonce' };
    const hash = controlPayloadHash(request);
    const previous = this.records.get(request.revokeId);
    if (previous) {
      return previous.kind === 'revoke' && previous.payloadHash === hash
        ? { registered: true, record: previous }
        : { registered: false, reason: 'conflict' };
    }
    if (this.records.size >= this.capacity) return { registered: false, reason: 'capacity' };
    let target: RevokeTarget = { ...request.target };
    if (target.kind === 'authorization' && (target.grantId !== undefined || target.snapshot !== undefined)) {
      const original = this.records.get(target.authorizationId);
      if (!original || original.kind !== 'authorize' || !original.grant
        || (target.grantId !== undefined && target.grantId !== original.grant.grantId)
        || (target.snapshot !== undefined && controlPayloadHash(target.snapshot) !== controlPayloadHash(original.grant))) {
        return { registered: false, reason: 'conflict' };
      }
      if (target.snapshot !== undefined) target = { ...target, snapshot: original.grant };
    }
    target = Object.freeze(target);
    if (target.kind === 'authorization') this.cancelledAuthorizations.add(target.authorizationId);
    else this.cancelledCaptures.add(target.captureId);
    const matching = this.slot !== null && (target.kind === 'authorization'
      ? this.slot.id === target.authorizationId : this.slot.captureId === target.captureId);
    if (matching && this.slot !== null) {
      const original = this.records.get(this.slot.id);
      if (original?.kind === 'authorize') {
        this.records.set(original.id, Object.freeze({ kind: 'authorize', id: original.id, payloadHash: original.payloadHash, senderProcessNonce: original.senderProcessNonce, state: 'revoked', target: original.target, ...(original.state === 'authorized' ? { grant: original.grant } : {}) }));
      }
      this.slot = null;
    }
    const record: ControlRecord = { kind: 'revoke', id: request.revokeId, payloadHash: hash, senderProcessNonce: this.nonce, state: 'revoked', target };
    this.records.set(request.revokeId, Object.freeze(record));
    return { registered: true, record };
  }
}
