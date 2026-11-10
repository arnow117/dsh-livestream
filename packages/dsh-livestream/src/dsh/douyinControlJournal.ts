import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { normalizeDouyinBridgeUrl } from '../core/platforms/douyin/douyinSource';

export interface AdmittedMarker {
  schemaVersion: 1;
  opId: string;
  type: 'account' | 'connect' | 'stop';
  phase: 'account' | 'http' | 'ws' | 'stop';
  settled: boolean;
  roomId: string;
  revision: string;
  origin: string;
  admittedAt: number;
  dispatchNotAfter: number;
  activeUntil: number;
  preflightStartedAt: number | null;
  preflightMissing: boolean;
  bridgeVersion: string;
  bridgeRequestStart: number | null;
  bridgeResponseEnd: number | null;
  bridgeUptimeSec: number | null;
  bridgeStartMin: number | null;
  bridgeStartMax: number | null;
  hostBootTime: number | null;
  accountName: string | null;
  accountIds: string[];
}

const MAX_JOURNAL_BYTES = 32 * 1024;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const boundedString = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;

function validMarker(value: unknown): value is AdmittedMarker {
  if (!object(value) || value.schemaVersion !== 1 || !['account', 'connect', 'stop'].includes(String(value.type))) return false;
  const keys = ['schemaVersion', 'opId', 'type', 'phase', 'settled', 'roomId', 'revision', 'origin', 'admittedAt', 'dispatchNotAfter', 'activeUntil', 'preflightStartedAt', 'preflightMissing', 'bridgeVersion', 'bridgeRequestStart', 'bridgeResponseEnd', 'bridgeUptimeSec', 'bridgeStartMin', 'bridgeStartMax', 'hostBootTime', 'accountName', 'accountIds'];
  if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) return false;
  if (!['account', 'http', 'ws', 'stop'].includes(String(value.phase)) || typeof value.preflightMissing !== 'boolean' || typeof value.settled !== 'boolean') return false;
  if ((value.type === 'account' && value.phase !== 'account') || (value.type === 'stop' && value.phase !== 'stop')
    || (value.type === 'connect' && value.phase !== 'http' && value.phase !== 'ws')) return false;
  if (value.bridgeVersion !== 'dyhub-0.3.1-3a79c57d85c59289db3b77211b3ec01fae47d42c') return false;
  const observations = [value.bridgeRequestStart, value.bridgeResponseEnd, value.bridgeUptimeSec, value.bridgeStartMin, value.bridgeStartMax, value.hostBootTime];
  if (!observations.every((time) => time === null || (typeof time === 'number' && Number.isSafeInteger(time)))) return false;
  if (!observations.every((time) => time === null) && !observations.every((time) => time !== null)) return false;
  if (value.bridgeUptimeSec !== null && (value.bridgeUptimeSec as number) < 0) return false;
  if (value.bridgeRequestStart !== null && (value.bridgeRequestStart as number) > (value.bridgeResponseEnd as number)) return false;
  if (value.bridgeStartMin !== null && (value.bridgeStartMin as number) > (value.bridgeStartMax as number)) return false;
  if (!boundedString(value.opId, 128) || !boundedString(value.revision, 128) || !boundedString(value.origin, 100)
    || typeof value.roomId !== 'string' || !/^\d{1,64}$/.test(value.roomId)) return false;
  try {
    if (normalizeDouyinBridgeUrl(value.origin) !== value.origin) return false;
  } catch {
    return false;
  }
  if (![value.admittedAt, value.dispatchNotAfter, value.activeUntil].every((time) => typeof time === 'number' && Number.isSafeInteger(time) && time > 0)) return false;
  if ((value.dispatchNotAfter as number) < (value.admittedAt as number) || (value.activeUntil as number) < (value.dispatchNotAfter as number)) return false;
  if (value.preflightStartedAt !== null && (typeof value.preflightStartedAt !== 'number' || !Number.isSafeInteger(value.preflightStartedAt))) return false;
  if (value.accountName !== null && !boundedString(value.accountName, 128)) return false;
  return Array.isArray(value.accountIds) && value.accountIds.length <= 256 && value.accountIds.every((id) => boundedString(id, 128));
}

/** Fixed, private, durable marker. An unreadable marker is never treated as empty. */
export class DouyinControlJournal {
  private readonly directory: string;
  private readonly file: string;
  marker: AdmittedMarker | null = null;
  corrupt = false;

  constructor(directory: string, private readonly io: typeof fs = fs) {
    let resolved = resolve(directory);
    let setupFailed = false;
    try {
      this.io.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const stat = this.io.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('invalid journal directory');
      resolved = this.io.realpathSync(directory);
    } catch {
      setupFailed = true;
    }
    this.directory = resolved;
    this.file = join(this.directory, 'douyin-control.json');
    if (setupFailed) {
      this.corrupt = true;
      return;
    }
    try {
      const existing = this.io.lstatSync(this.file);
      if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1 || existing.size > MAX_JOURNAL_BYTES) throw new Error('invalid journal file');
      const raw = this.io.readFileSync(this.file);
      if (raw.byteLength > MAX_JOURNAL_BYTES) throw new Error('journal too large');
      const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
      if (!validMarker(parsed)) throw new Error('invalid journal');
      this.marker = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.corrupt = true;
    }
  }

  private syncDirectory(path = this.directory): void {
    const descriptor = this.io.openSync(path, 'r');
    try { this.io.fsyncSync(descriptor); } finally { this.io.closeSync(descriptor); }
  }

  write(marker: AdmittedMarker): void {
    if (this.corrupt || !validMarker(marker)) throw new Error('采集操作日志不可用');
    const data = JSON.stringify(marker);
    if (Buffer.byteLength(data) > MAX_JOURNAL_BYTES) throw new Error('采集操作日志过大');
    const temporary = join(this.directory, `.douyin-control-${randomBytes(16).toString('hex')}.tmp`);
    if (resolve(temporary) === resolve(this.file)) throw new Error('采集操作日志路径无效');
    let created = false;
    try {
      // Ensure the plugin directory entry itself is durable before a marker can
      // authorize any external mutation.
      this.syncDirectory(dirname(this.directory));
      const descriptor = this.io.openSync(temporary, 'wx', 0o600);
      created = true;
      try {
        this.io.writeFileSync(descriptor, data);
        this.io.fsyncSync(descriptor);
      } finally { this.io.closeSync(descriptor); }
      try {
        const existing = this.io.lstatSync(this.file);
        if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) throw new Error('invalid journal file');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      this.io.renameSync(temporary, this.file);
      created = false;
      this.marker = marker;
      this.syncDirectory();
    } catch (error) {
      if (this.marker === marker) this.corrupt = true;
      throw error;
    } finally {
      if (created) {
        try { this.io.unlinkSync(temporary); } catch { /* Only this operation's temp file is eligible for cleanup. */ }
      }
    }
  }

  clear(): void {
    if (this.corrupt || !this.marker) throw new Error('采集操作日志不可用');
    const marker = this.marker;
    try {
      // Persist the fact that the external operation settled before unlinking.
      // A crash during removal can then expose either a locked marker or no marker,
      // but never erase the only durable record of an unsettled operation.
      this.write({ ...marker, settled: true });
      const stat = this.io.lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('invalid journal file');
      this.io.unlinkSync(this.file);
      this.syncDirectory();
      this.marker = null;
    } catch (error) {
      // Preserve the in-memory lock and attempt to restore the marker if deletion was uncertain.
      try { this.write(marker); } catch { this.corrupt = true; }
      throw error;
    }
  }
}
