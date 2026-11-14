import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parseStrictJSON } from './helperProtocol';
import { controlPayloadHash } from './grantAuthority';
import { validateFrozenProposal, type FrozenGrantProposal, type FrozenGrantSnapshot } from './frozenGrant';
import type { FrozenControlRecord, FrozenRevokeTarget } from './frozenControl';
import { boundedString, hexDigest64, isObject, safeInteger } from './protocol';
import { appendRecoveryFact, type MessageRef, type RecoveryFact } from './recoveryFacts';
import { messageReconcileHash, validMessageReconcileRequest, validateRecoveryReceipt,
  type MessageReconcileRequest, type RecoveryReceipt } from './recoveryProtocol';
import { validateFrozenRecoveryControl } from './senderClient';
import type { FrozenRecoveryControl } from './frozenRecovery';
import { isHttpResponseEvidence, type HttpResponseEvidence } from './httpResponse';
import { validControlEvidence } from './frozenControlEvidence';

const SCHEMA_VERSION = 4;
const MAX_BYTES = 1024 * 1024;
const MAX_RECORDS = 1024;

export type FrozenJournalControl =
  | { kind: 'capture'; id: string; payloadHash: string; senderProcessNonce: string;
      helperNonce: string; authContextId: string; authContextRevision: number; materialDigest: string;
      buildDigest: string; instanceId: string; state: 'capturing' | 'capture_unknown' | 'qualified' | 'revoked'; ack: FrozenControlRecord | null }
  | { kind: 'authorize'; id: string; payloadHash: string; senderProcessNonce: string; target: FrozenGrantProposal;
      qualificationTokenDigest: string; localRevision: string; state: 'authorizing' | 'authorizing_unknown' | 'active' | 'rejected' | 'revoked';
      grant: FrozenGrantSnapshot | null; ack: FrozenControlRecord | null }
  | { kind: 'revoke'; id: string; payloadHash: string; senderProcessNonce: string; target: FrozenRevokeTarget;
      state: 'revoking' | 'revoking_unknown' | 'revoked'; ack: FrozenControlRecord | null }
  | { kind: 'message_reconcile'; id: string; payloadHash: string; senderProcessNonce: string; request: MessageReconcileRequest;
      state: 'pending' | 'recovery_unknown' | 'held' | 'committed' | 'superseded' | 'rejected'; ack: FrozenRecoveryControl | null };

export interface FrozenJournalMessage {
  requestId: string;
  sourceKey: string;
  senderProcessNonce: string;
  grant: FrozenGrantSnapshot;
  requestHash: string;
  helperPayloadHash: string;
  textDigest: string;
  autoEvent: { rawId: string; rawType: string } | null;
  state: 'queued' | 'cancelled_before_dispatch' | 'dispatching' | 'unknown' | 'terminal_not_dispatched' | 'api_reported_success';
  executionEnded: boolean;
  writeAttempted: boolean;
  httpResponse: HttpResponseEvidence | null;
  createdAtMs: number;
  facts: RecoveryFact[];
  factsRevision: number;
  factsDigest: string;
  conflicts: Array<{ reason: string; factId: string | null; controlId: string | null }>;
  terminalEvidence: FrozenTerminalEvidence | null;
  recovery: { state: 'blocked' | 'pending' | 'recovery_unknown' | 'committed' | 'invalidated';
    factsRevision: number; factsDigest: string; controlId: string | null; receipt: RecoveryReceipt | null };
}

export interface FrozenTerminalEvidence {
  ref: MessageRef;
  refDigest: string;
  senderProcessNonce: string;
  helperNonce: string;
  authContextId: string;
  authContextRevision: number;
  materialDigest: string;
  joinedWitnessId: string;
  acceptedAtMs: number;
  firstWriteAttemptAtMs: number | null;
  joinedAtMs: number;
  writeAttempted: boolean;
}

export function terminalEvidenceFromReceipt(receipt: RecoveryReceipt): FrozenTerminalEvidence {
  return { ref: receipt.ref, refDigest: receipt.refDigest, senderProcessNonce: receipt.senderProcessNonce,
    helperNonce: receipt.helperNonce, authContextId: receipt.authContextId, authContextRevision: receipt.authContextRevision,
    materialDigest: receipt.materialDigest, joinedWitnessId: receipt.joinedWitnessId, acceptedAtMs: receipt.acceptedAtMs,
    firstWriteAttemptAtMs: receipt.firstWriteAttemptAtMs, joinedAtMs: receipt.joinedAtMs, writeAttempted: receipt.writeAttempted };
}

export function messageReference(message: FrozenJournalMessage): MessageRef {
  return { requestId: message.requestId, sourceKey: message.sourceKey, requestHash: message.requestHash,
    helperPayloadHash: message.helperPayloadHash, textDigest: message.textDigest, grant: message.grant };
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function validGrant(value: unknown): value is FrozenGrantSnapshot {
  if (!isObject(value)) return false;
  const { grantId, authorizedAtMs, ...proposal } = value;
  return validateFrozenProposal(proposal) && boundedString(grantId, 128) && safeInteger(authorizedAtMs) &&
    authorizedAtMs >= proposal.liveEpochStartedAtMs;
}

function validRevokeTarget(value: unknown): value is FrozenRevokeTarget {
  if (!isObject(value)) return false;
  if (value.kind === 'capture') return exactKeys(value, ['kind', 'captureId']) && boundedString(value.captureId, 128);
  if (value.kind !== 'authorization' || !boundedString(value.authorizationId, 128) ||
    Object.keys(value).some((key) => !['kind', 'authorizationId', 'grantId', 'snapshot'].includes(key))) return false;
  if (Object.hasOwn(value, 'grantId') && !boundedString(value.grantId, 128)) return false;
  if (Object.hasOwn(value, 'snapshot')) {
    if (!validGrant(value.snapshot) || value.snapshot.authorizationId !== value.authorizationId ||
      (value.grantId !== undefined && value.snapshot.grantId !== value.grantId)) return false;
  }
  return true;
}

function parseControl(value: unknown): FrozenJournalControl {
  if (!isObject(value) || !boundedString(value.id, 128) || !hexDigest64(value.payloadHash) || !boundedString(value.senderProcessNonce, 128)) {
    throw new Error('invalid control record');
  }
  if (value.kind === 'capture') {
    if (!exactKeys(value, ['kind', 'id', 'payloadHash', 'senderProcessNonce', 'helperNonce', 'authContextId',
      'authContextRevision', 'materialDigest', 'buildDigest', 'instanceId', 'state', 'ack']) ||
      !boundedString(value.helperNonce, 128) || !boundedString(value.authContextId, 128) ||
      !safeInteger(value.authContextRevision) || !hexDigest64(value.materialDigest) ||
      !hexDigest64(value.buildDigest) || !boundedString(value.instanceId, 128) ||
      !['capturing', 'capture_unknown', 'qualified', 'revoked'].includes(String(value.state)) ||
      controlPayloadHash({ captureId: value.id, expectedSenderProcessNonce: value.senderProcessNonce }) !== value.payloadHash) {
      throw new Error('invalid capture record');
    }
  } else if (value.kind === 'authorize') {
    if (!exactKeys(value, ['kind', 'id', 'payloadHash', 'senderProcessNonce', 'target', 'qualificationTokenDigest', 'localRevision', 'state', 'grant', 'ack']) ||
      !validateFrozenProposal(value.target) || value.target.authorizationId !== value.id || value.target.senderProcessNonce !== value.senderProcessNonce ||
      !hexDigest64(value.qualificationTokenDigest) || !boundedString(value.localRevision, 128) ||
      !['authorizing', 'authorizing_unknown', 'active', 'rejected', 'revoked'].includes(String(value.state))) throw new Error('invalid authorization record');
    if (value.grant !== null) {
      if (!validGrant(value.grant)) throw new Error('invalid original grant');
      const { grantId, authorizedAtMs, ...proposal } = value.grant;
      if (controlPayloadHash(proposal) !== controlPayloadHash(value.target)) throw new Error('grant proposal mismatch');
    }
    if (value.state === 'active' && value.grant === null) throw new Error('active grant missing');
  } else if (value.kind === 'revoke') {
    if (!exactKeys(value, ['kind', 'id', 'payloadHash', 'senderProcessNonce', 'target', 'state', 'ack']) || !validRevokeTarget(value.target) ||
      !['revoking', 'revoking_unknown', 'revoked'].includes(String(value.state)) ||
      controlPayloadHash({ revokeId: value.id, expectedSenderProcessNonce: value.senderProcessNonce, target: value.target }) !== value.payloadHash) {
      throw new Error('invalid revoke record');
    }
  } else if (value.kind === 'message_reconcile') {
    if (!exactKeys(value, ['kind', 'id', 'payloadHash', 'senderProcessNonce', 'request', 'state', 'ack']) ||
      !validMessageReconcileRequest(value.request) || value.request.controlId !== value.id ||
      value.request.expectedSenderProcessNonce !== value.senderProcessNonce || messageReconcileHash(value.request) !== value.payloadHash ||
      !['pending', 'recovery_unknown', 'held', 'committed', 'superseded', 'rejected'].includes(String(value.state))) {
      throw new Error('invalid recovery control');
    }
    if (value.ack !== null && !validateFrozenRecoveryControl(value.ack, value.request).ok) throw new Error('invalid recovery acknowledgement');
    if (value.state === 'committed' && (!isObject(value.ack) || value.ack.state !== 'committed' || value.ack.published !== true)) {
      throw new Error('recovery publication missing');
    }
  } else throw new Error('invalid control kind');
  return value as unknown as FrozenJournalControl;
}

function parseMessage(value: unknown): FrozenJournalMessage {
  if (!isObject(value) || !exactKeys(value, ['requestId', 'sourceKey', 'senderProcessNonce', 'grant', 'requestHash', 'helperPayloadHash',
    'textDigest', 'autoEvent', 'state', 'executionEnded', 'writeAttempted', 'httpResponse', 'createdAtMs', 'facts', 'factsRevision',
    'factsDigest', 'conflicts', 'terminalEvidence', 'recovery']) || !boundedString(value.requestId, 128) ||
    !boundedString(value.sourceKey, 128) || !boundedString(value.senderProcessNonce, 128) || !validGrant(value.grant) ||
    value.senderProcessNonce !== value.grant.senderProcessNonce || !hexDigest64(value.requestHash) || !hexDigest64(value.helperPayloadHash) ||
    !hexDigest64(value.textDigest) || !['queued', 'cancelled_before_dispatch', 'dispatching', 'unknown', 'terminal_not_dispatched', 'api_reported_success'].includes(String(value.state)) ||
    typeof value.executionEnded !== 'boolean' || typeof value.writeAttempted !== 'boolean') throw new Error('invalid original message');
  if (value.autoEvent !== null && (!isObject(value.autoEvent) || !exactKeys(value.autoEvent, ['rawId', 'rawType']) ||
    !boundedString(value.autoEvent.rawId, 128) || !boundedString(value.autoEvent.rawType, 64))) throw new Error('invalid raw reference');
  if (!safeInteger(value.createdAtMs) || value.createdAtMs < value.grant.authorizedAtMs || !Array.isArray(value.facts) ||
    value.facts.length > 32 || value.factsRevision !== value.facts.length || !hexDigest64(value.factsDigest) ||
    !Array.isArray(value.conflicts) || (value.terminalEvidence !== null && !isObject(value.terminalEvidence)) || !isObject(value.recovery) ||
    !exactKeys(value.recovery, ['state', 'factsRevision', 'factsDigest', 'controlId', 'receipt']) ||
    !['blocked', 'pending', 'recovery_unknown', 'committed', 'invalidated'].includes(String(value.recovery.state)) ||
    value.recovery.factsRevision !== value.factsRevision || value.recovery.factsDigest !== value.factsDigest ||
    (value.recovery.controlId !== null && !boundedString(value.recovery.controlId, 128)) ||
    ((value.recovery.state === 'pending' || value.recovery.state === 'recovery_unknown' || value.recovery.state === 'committed') &&
      value.recovery.controlId === null) ||
    (value.recovery.state !== 'committed' && value.recovery.receipt !== null)) {
    throw new Error('invalid recovery state');
  }
  const reference = messageReference(value as unknown as FrozenJournalMessage);
  let accepted: RecoveryFact[] = [];
  for (const fact of value.facts) {
    const next = appendRecoveryFact(reference, accepted, fact);
    if (!next.ok || next.duplicate || next.facts[next.facts.length - 1].hostRecordedAtMs < value.createdAtMs) {
      throw new Error('invalid fact head');
    }
    accepted = next.facts;
  }
  if (controlPayloadHash(accepted) !== value.factsDigest || !value.conflicts.every((conflict) =>
    isObject(conflict) && exactKeys(conflict, ['reason', 'factId', 'controlId']) && boundedString(conflict.reason, 128) &&
    (conflict.factId === null || boundedString(conflict.factId, 128)) &&
    (conflict.controlId === null || boundedString(conflict.controlId, 128)))) throw new Error('invalid recovery facts');
  if ((value.state === 'terminal_not_dispatched' && (!value.executionEnded || value.writeAttempted)) ||
    (value.httpResponse !== null && (!isHttpResponseEvidence(value.httpResponse) || !value.executionEnded || !value.writeAttempted)) ||
    (value.state === 'api_reported_success' && (!isHttpResponseEvidence(value.httpResponse) || value.httpResponse.status !== 200)) ||
    (['queued', 'cancelled_before_dispatch'].includes(String(value.state)) && (value.executionEnded || value.writeAttempted))) {
    throw new Error('invalid message terminal');
  }
  return value as unknown as FrozenJournalMessage;
}

/** Version 4 uses the same single journal file and never migrates older schemas. */
export class FrozenPublicChatOperationJournal {
  private readonly directory: string;
  private readonly file: string;
  private directoryIdentity: { dev: number; ino: number } | null = null;
  records: FrozenJournalMessage[] = [];
  controls: FrozenJournalControl[] = [];
  corrupt = false;

  constructor(dataDir: string, private readonly io: typeof fs = fs) {
    this.directory = resolve(dataDir);
    this.file = join(this.directory, 'public-chat-operations.json');
    try {
      if (!isAbsolute(dataDir) || dataDir !== this.directory || this.io.realpathSync(dirname(this.directory)) !== dirname(this.directory)) {
        throw new Error('unsafe journal parent');
      }
      try { this.io.mkdirSync(this.directory, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const directory = this.io.lstatSync(this.directory);
      if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0 ||
        this.io.realpathSync(this.directory) !== this.directory ||
        (typeof process.getuid === 'function' && directory.uid !== process.getuid())) throw new Error('unsafe journal directory');
      this.directoryIdentity = { dev: directory.dev, ino: directory.ino };
      try {
        const existing = this.io.lstatSync(this.file);
        if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1 || existing.size > MAX_BYTES ||
          (existing.mode & 0o777) !== 0o600 || (typeof process.getuid === 'function' && existing.uid !== process.getuid())) throw new Error('unsafe journal file');
        const descriptor = this.io.openSync(this.file, this.io.constants.O_RDONLY | this.io.constants.O_NOFOLLOW);
        try {
          const opened = this.io.fstatSync(descriptor);
          if (opened.dev !== existing.dev || opened.ino !== existing.ino || opened.nlink !== 1 || opened.size !== existing.size) throw new Error('journal changed');
          const bytes = Buffer.alloc(MAX_BYTES + 1);
          let length = 0;
          while (length < bytes.length) {
            const count = this.io.readSync(descriptor, bytes, length, bytes.length - length, length);
            if (count === 0) break;
            length += count;
          }
          const after = this.io.fstatSync(descriptor);
          if (length > MAX_BYTES || length !== existing.size || after.dev !== existing.dev || after.ino !== existing.ino ||
            after.size !== existing.size || after.mtimeMs !== existing.mtimeMs) throw new Error('journal changed');
          const payload = parseStrictJSON(bytes.subarray(0, length), MAX_BYTES);
          const parsed = this.parsePayload(payload);
          this.records = parsed.records.map((record) => ({ ...record,
            state: record.state === 'dispatching' ? 'unknown' : record.state === 'queued' ? 'cancelled_before_dispatch' : record.state,
            recovery: record.recovery.state === 'pending' ? { ...record.recovery, state: 'recovery_unknown' } : record.recovery }));
          this.controls = parsed.controls.map((control) => control.kind === 'capture' && ['capturing', 'qualified'].includes(control.state)
            ? { ...control, state: 'capture_unknown' } : control.kind === 'authorize' && ['authorizing', 'active'].includes(control.state)
            ? { ...control, state: 'authorizing_unknown' } : control.kind === 'revoke' && control.state === 'revoking'
              ? { ...control, state: 'revoking_unknown' } : control.kind === 'message_reconcile' && control.state === 'pending'
                ? { ...control, state: 'recovery_unknown' } : control);
        } finally { this.io.closeSync(descriptor); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    } catch {
      this.corrupt = true;
      this.records = [];
      this.controls = [];
    }
  }

  private parsePayload(value: unknown): { records: FrozenJournalMessage[]; controls: FrozenJournalControl[] } {
    if (!isObject(value) || !exactKeys(value, ['schemaVersion', 'records', 'controls']) || value.schemaVersion !== SCHEMA_VERSION ||
      !Array.isArray(value.records) || !Array.isArray(value.controls)) throw new Error('unsupported journal schema');
    if (value.records.length + value.controls.length > MAX_RECORDS) throw new Error('journal record capacity exceeded');
    const records = value.records.map(parseMessage);
    const controls = value.controls.map(parseControl);
    if (new Set(records.map((entry) => entry.requestId)).size !== records.length ||
      new Set(records.map((entry) => entry.sourceKey)).size !== records.length ||
      new Set(controls.map((entry) => entry.id)).size !== controls.length ||
      new Set([...records.map((entry) => entry.requestId), ...controls.map((entry) => entry.id)]).size !== records.length + controls.length) {
      throw new Error('duplicate original ID');
    }
    for (const control of controls) {
      if (control.kind !== 'message_reconcile' &&
        (control.state === 'revoked' || control.state === 'rejected' || control.state === 'active') &&
        !validControlEvidence(control, controls)) throw new Error('control acknowledgement missing or invalid');
    }
    for (const message of records) {
      const original = controls.find((entry) => entry.kind === 'authorize' && entry.id === message.grant.authorizationId);
      if (!original || original.kind !== 'authorize' || !original.grant || original.senderProcessNonce !== message.senderProcessNonce ||
        controlPayloadHash(original.grant) !== controlPayloadHash(message.grant)) throw new Error('message authorization mismatch');
      if (message.recovery.state === 'committed') {
        const control = controls.find((entry) => entry.kind === 'message_reconcile' && entry.id === message.recovery.controlId);
        if (!control || control.kind !== 'message_reconcile' || control.state !== 'committed' || !control.ack?.published ||
          message.conflicts.length !== 0 || control.request.factsRevision !== message.factsRevision ||
          control.request.factsDigest !== message.factsDigest ||
          controlPayloadHash(control.request.ref) !== controlPayloadHash(messageReference(message)) ||
          !validateRecoveryReceipt(message.recovery.receipt, control.request) ||
          controlPayloadHash(control.ack.receipt) !== controlPayloadHash(message.recovery.receipt) ||
          !message.executionEnded || message.writeAttempted !== message.recovery.receipt.writeAttempted ||
          (message.writeAttempted ? message.state !== 'unknown' : message.state !== 'terminal_not_dispatched')) {
          throw new Error('unverified stored recovery');
        }
        if (message.terminalEvidence !== null && controlPayloadHash(message.terminalEvidence) !==
          controlPayloadHash(terminalEvidenceFromReceipt(message.recovery.receipt))) throw new Error('terminal evidence mismatch');
      }
      if (message.terminalEvidence !== null) {
        const source = controls.find((entry) => entry.kind === 'message_reconcile' && entry.ack?.published && entry.ack.receipt &&
          controlPayloadHash(terminalEvidenceFromReceipt(entry.ack.receipt)) === controlPayloadHash(message.terminalEvidence));
        if (!source || source.kind !== 'message_reconcile' || !source.ack?.receipt ||
          controlPayloadHash(source.request.ref) !== controlPayloadHash(messageReference(message)) ||
          !validateRecoveryReceipt(source.ack.receipt, source.request)) throw new Error('terminal evidence source unavailable');
      }
      if (message.state === 'terminal_not_dispatched' &&
        (message.terminalEvidence === null || message.terminalEvidence.writeAttempted)) throw new Error('terminal evidence missing');
    }
    return { records, controls };
  }

  write(): void {
    if (this.corrupt) throw new Error('journal unavailable');
    const directory = this.io.lstatSync(this.directory);
    if (!directory.isDirectory() || directory.isSymbolicLink() || !this.directoryIdentity ||
      directory.dev !== this.directoryIdentity.dev || directory.ino !== this.directoryIdentity.ino ||
      this.io.realpathSync(this.directory) !== this.directory || (directory.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && directory.uid !== process.getuid())) throw new Error('unsafe journal directory');
    const payload = { schemaVersion: SCHEMA_VERSION, records: this.records, controls: this.controls };
    this.parsePayload(payload);
    const data = Buffer.from(JSON.stringify(payload), 'utf8');
    if (data.length > MAX_BYTES) throw new Error('journal capacity exceeded');
    this.parsePayload(parseStrictJSON(data, MAX_BYTES));
    const temporary = join(this.directory, `.public-chat-${randomBytes(16).toString('hex')}.tmp`);
    let created = false;
    try {
      this.syncDirectory(dirname(this.directory));
      const descriptor = this.io.openSync(temporary, 'wx', 0o600);
      created = true;
      try { this.io.writeFileSync(descriptor, data); this.io.fsyncSync(descriptor); }
      finally { this.io.closeSync(descriptor); }
      try {
        const existing = this.io.lstatSync(this.file);
        if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1 || (existing.mode & 0o777) !== 0o600 ||
          (typeof process.getuid === 'function' && existing.uid !== process.getuid())) {
          throw new Error('unsafe journal file');
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      this.io.renameSync(temporary, this.file);
      created = false;
      this.syncDirectory(this.directory);
    } finally {
      if (created) { try { this.io.unlinkSync(temporary); } catch { /* only our exclusive temporary */ } }
    }
  }

  private syncDirectory(path: string): void {
    const descriptor = this.io.openSync(path, 'r');
    try { this.io.fsyncSync(descriptor); } finally { this.io.closeSync(descriptor); }
  }
}
