/**
 * 公屏原操作持久化 journal（FEAT-008 API-7）。
 *
 * 只保留最小元数据与文本摘要；mode 0600、独占临时文件 + fsync + 原子
 * rename，拒绝 symlink/非独占文件别名。损坏/超限/不安全路径使发送不可用。
 * 未知/未终止/tombstone 记录不因 TTL、容量或保存配置删除；超限保守拒绝
 * 写入，由上层 hold，绝不静默驱逐记录。
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { validateOperationRecord, type OriginalOperation } from './operations';
import { isObject, boundedString, hexDigest64 } from './protocol';
import { isValidGrantTarget, controlPayloadHash, type GrantTarget, type GrantSnapshot, type RevokeTarget } from './grantAuthority';

export const MAX_JOURNAL_BYTES = 1024 * 1024;
const SCHEMA_VERSION = 2;

export type JournalControl =
  | { kind: 'authorize'; id: string; payloadHash: string; senderProcessNonce: string; target: GrantTarget; localRevision: string; state: 'authorizing' | 'authorizing_unknown' | 'active' | 'rejected' | 'revoked'; grant: GrantSnapshot | null }
  | { kind: 'revoke'; id: string; payloadHash: string; senderProcessNonce: string; target: RevokeTarget; state: 'revoking' | 'revoking_unknown' | 'revoked' };

interface JournalPayload {
  schemaVersion: 2;
  records: OriginalOperation[];
  controls: JournalControl[];
}

function validateControl(value: unknown): JournalControl {
  if (!isObject(value) || !boundedString(value.id, 128) || !hexDigest64(value.payloadHash)
    || !boundedString(value.senderProcessNonce, 128) || !isObject(value.target)) throw new Error('invalid control record');
  if (value.kind === 'authorize') {
    const keys = ['kind', 'id', 'payloadHash', 'senderProcessNonce', 'target', 'localRevision', 'state', 'grant'];
    if (Object.keys(value).length !== keys.length || keys.some((key) => !(key in value))) throw new Error('invalid authorization fields');
    if (!isValidGrantTarget(value.target as unknown as GrantTarget) || !boundedString(value.localRevision, 128)
      || !['authorizing', 'authorizing_unknown', 'active', 'rejected', 'revoked'].includes(String(value.state))) throw new Error('invalid authorization record');
    if (value.target.senderProcessNonce !== value.senderProcessNonce) throw new Error('authorization nonce mismatch');
    if (value.grant !== null) {
      if (!isObject(value.grant) || !boundedString(value.grant.grantId, 128) || value.grant.authorizationId !== value.id
        || typeof value.grant.authorizedAtMs !== 'number' || !Number.isSafeInteger(value.grant.authorizedAtMs) || value.grant.authorizedAtMs <= 0) throw new Error('invalid grant record');
      const { authorizationId, grantId, authorizedAtMs, ...target } = value.grant;
      if (controlPayloadHash(target) !== controlPayloadHash(value.target)) throw new Error('grant target mismatch');
    }
    if (value.state === 'active' && value.grant === null) throw new Error('active grant missing');
  } else if (value.kind === 'revoke') {
    const keys = ['kind', 'id', 'payloadHash', 'senderProcessNonce', 'target', 'state'];
    if (Object.keys(value).length !== keys.length || keys.some((key) => !(key in value))) throw new Error('invalid revoke fields');
    if (!['revoking', 'revoking_unknown', 'revoked'].includes(String(value.state))) throw new Error('invalid revoke state');
    const target = value.target;
    if (!((target.kind === 'capture' && boundedString(target.captureId, 128)) || (target.kind === 'authorization' && boundedString(target.authorizationId, 128)))) throw new Error('invalid revoke target');
    const targetKeys = Object.keys(target);
    if ((target.kind === 'capture' && (targetKeys.length !== 2 || targetKeys.some((key) => !['kind', 'captureId'].includes(key))))
      || (target.kind === 'authorization' && targetKeys.some((key) => !['kind', 'authorizationId', 'grantId', 'snapshot'].includes(key)))) throw new Error('invalid revoke target fields');
    if (controlPayloadHash({ revokeId: value.id, expectedSenderProcessNonce: value.senderProcessNonce, target }) !== value.payloadHash) throw new Error('revoke payload mismatch');
  } else throw new Error('invalid control kind');
  return value as unknown as JournalControl;
}


export class PublicChatOperationJournal {
  private readonly directory: string;
  private readonly file: string;
  private readonly maxBytes: number;
  records: OriginalOperation[] = [];
  controls: JournalControl[] = [];
  corrupt = false;
  corruptReason: string | null = null;

  constructor(dataDir: string, private readonly io: typeof fs = fs, options: { maxBytes?: number } = {}) {
    this.maxBytes = options.maxBytes ?? MAX_JOURNAL_BYTES;
    let resolved = resolve(dataDir);
    let setupFailed: string | null = null;
    try {
      this.io.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      const stat = this.io.lstatSync(dataDir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('invalid journal directory');
      resolved = this.io.realpathSync(dataDir);
    } catch (error) {
      setupFailed = error instanceof Error ? error.message : 'journal directory unavailable';
    }
    this.directory = resolved;
    this.file = join(this.directory, 'public-chat-operations.json');
    if (setupFailed !== null) {
      this.markCorrupt(setupFailed);
      return;
    }
    try {
      const existing = this.io.lstatSync(this.file);
      if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1 || existing.size > this.maxBytes) {
        throw new Error('invalid journal file');
      }
      const raw = this.io.readFileSync(this.file);
      const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
      const payload = this.parsePayload(parsed);
      this.records = payload.records;
      this.controls = payload.controls;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.markCorrupt(error instanceof Error ? error.message : 'invalid journal');
      }
    }
  }

  /** 损坏后绝不当作空表：发送整体不可用，等待人工修复。 */
  private markCorrupt(reason: string): void {
    this.corrupt = true;
    this.corruptReason = reason;
    this.records = [];
    this.controls = [];
  }

  private parsePayload(parsed: unknown): { records: OriginalOperation[]; controls: JournalControl[] } {
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('journal payload invalid');
    const payload = parsed as { schemaVersion?: unknown; records?: unknown; controls?: unknown };
    if (payload.schemaVersion !== SCHEMA_VERSION || !Array.isArray(payload.records) || !Array.isArray(payload.controls)) throw new Error('journal payload invalid or unsupported schema');
    const records: OriginalOperation[] = [];
    for (const entry of payload.records) {
      const result = validateOperationRecord(entry);
      if (!result.ok) throw new Error(`journal record invalid: ${result.error}`);
      const snapshot = result.value.binding.snapshot;
      if (!snapshot) throw new Error('message grant snapshot missing');
      const { authorizationId, grantId, authorizedAtMs, ...target } = snapshot;
      if (!boundedString(authorizationId, 128) || !boundedString(grantId, 128) || !Number.isSafeInteger(authorizedAtMs)
        || !isValidGrantTarget(target) || snapshot.senderProcessNonce !== result.value.binding.senderProcessNonce
        || grantId !== result.value.binding.grantId || snapshot.principalUid !== result.value.binding.principalUid
        || snapshot.roomId !== result.value.binding.roomId || snapshot.senderSessionId !== result.value.binding.senderSessionId
        || snapshot.liveEpoch !== result.value.binding.liveEpoch || snapshot.inputConnectionGeneration !== result.value.binding.inputConnectionGeneration
        || snapshot.identityEpoch !== result.value.binding.identityGeneration) throw new Error('message grant snapshot mismatch');
      records.push(result.value);
    }
    const controls = payload.controls.map(validateControl);
    if (new Set(controls.map((control) => control.id)).size !== controls.length) throw new Error('duplicate control ID');
    return { records, controls };
  }

  get available(): boolean {
    return !this.corrupt;
  }

  /** 全量原子重写。任何失败都抛错且不改变本内存视图之外的既有文件语义。 */
  write(): void {
    if (this.corrupt) throw new Error('公屏操作日志不可用');
    const payload: JournalPayload = { schemaVersion: SCHEMA_VERSION, records: this.records, controls: this.controls };
    const data = JSON.stringify(payload);
    if (Buffer.byteLength(data) > this.maxBytes) {
      // 超限：不驱逐任何记录（unknown/tombstone 永不删除），发送保守不可用。
      throw new Error('公屏操作日志超过本地容量上限');
    }
    const temporary = join(this.directory, `.public-chat-${randomBytes(16).toString('hex')}.tmp`);
    if (resolve(temporary) === resolve(this.file)) throw new Error('公屏操作日志路径无效');
    let created = false;
    try {
      this.syncDirectory(dirname(this.directory));
      const descriptor = this.io.openSync(temporary, 'wx', 0o600);
      created = true;
      try {
        this.io.writeFileSync(descriptor, data);
        this.io.fsyncSync(descriptor);
      } finally {
        this.io.closeSync(descriptor);
      }
      // rename 前确认目标未被别名替换。
      try {
        const existing = this.io.lstatSync(this.file);
        if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) throw new Error('invalid journal file');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      this.io.renameSync(temporary, this.file);
      created = false;
      this.syncDirectory();
    } finally {
      if (created) {
        try {
          this.io.unlinkSync(temporary);
        } catch {
          /* 只清理本次操作的临时文件。 */
        }
      }
    }
  }

  private syncDirectory(path: string = this.directory): void {
    const descriptor = this.io.openSync(path, 'r');
    try {
      this.io.fsyncSync(descriptor);
    } finally {
      this.io.closeSync(descriptor);
    }
  }
}
