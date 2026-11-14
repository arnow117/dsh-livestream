/** journal 持久化安全边界（FEAT-008 API-7）。 */
import { describe, expect, it, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { PublicChatOperationJournal } from '../../src/publicChat/journal';
import { validateOperationRecord, type OriginalOperation } from '../../src/publicChat/operations';
import { makeTempDir, testGrantSnapshot, digestOf } from './test-helpers';

const cleanupDirs: string[] = [];
function tempDir(): string {
  const dir = makeTempDir('pubchat-journal').directory;
  cleanupDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function sampleRecord(): OriginalOperation {
  return {
    schemaVersion: 1,
    requestId: 'req-1',
    sourceKey: 'sk-1',
    binding: {
      principalUid: '4400889900112233445',
      roomId: '708764876300',
      grantId: 'grant-1',
      liveEpoch: 'epoch-1',
      senderSessionId: 'session-1',
      senderProcessNonce: 'sender-nonce-1',
      inputConnectionGeneration: 1,
      identityGeneration: 3,
      snapshot: testGrantSnapshot({ liveEpoch: 'epoch-1' }),
    },
    textDigest: digestOf('第一条'),
    textLength: 3,
    phase: 'queued',
    outcome: null,
    outcomeReason: null,
    enterAttempted: false,
    pageSubmitted: false,
    senderProofApplied: false,
    conflictOpen: false,
    facts: [],
    createdAt: 1_000,
    updatedAt: 1_000,
    tombstone: true,
  };
}

describe('常规写入与回读', () => {
  it('写入 0600 权限文件；独占临时文件被清理；回读记录一致', () => {
    const dir = tempDir();
    const journal = new PublicChatOperationJournal(dir);
    expect(journal.available).toBe(true);
    journal.records = [sampleRecord()];
    journal.write();
    const stat = fs.lstatSync(join(dir, 'public-chat-operations.json'));
    expect(stat.isFile()).toBe(true);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.mode & 0o777).toBe(0o600);
    const leftovers = fs.readdirSync(dir).filter((name) => name.startsWith('.public-chat-'));
    expect(leftovers).toEqual([]);
    const reloaded = new PublicChatOperationJournal(dir);
    expect(reloaded.records.length).toBe(1);
    expect(reloaded.records[0].requestId).toBe('req-1');
  });

  it('记录校验拒绝未知字段与坏值（只保留最小元数据）', () => {
    const good = sampleRecord();
    expect(validateOperationRecord(good).ok).toBe(true);
    const extra = { ...good, cookie: 'should-not-persist' };
    expect(validateOperationRecord(extra).ok).toBe(false);
    const badDigest = { ...good, textDigest: 'not-a-digest' };
    expect(validateOperationRecord(badDigest).ok).toBe(false);
    const badPhase = { ...good, phase: 'flying' };
    expect(validateOperationRecord(badPhase).ok).toBe(false);
  });
});

describe('不安全路径与损坏', () => {
  it('journal 文件是 symlink 时判定损坏，不当空表', () => {
    const dir = tempDir();
    const targetDir = tempDir();
    fs.writeFileSync(join(targetDir, 'real.json'), '{}', { mode: 0o600 });
    fs.symlinkSync(join(targetDir, 'real.json'), join(dir, 'public-chat-operations.json'));
    const journal = new PublicChatOperationJournal(dir);
    expect(journal.corrupt).toBe(true);
  });

  it('journal 文件损坏（坏 JSON/坏记录）时发送不可用', () => {
    const dir = tempDir();
    fs.writeFileSync(join(dir, 'public-chat-operations.json'), 'not json', { mode: 0o600 });
    expect(new PublicChatOperationJournal(dir).corrupt).toBe(true);

    const dir2 = tempDir();
    const record = sampleRecord() as unknown as Record<string, unknown>;
    record.textDigest = 'bad';
    fs.writeFileSync(join(dir2, 'public-chat-operations.json'), JSON.stringify({ schemaVersion: 1, records: [record] }), { mode: 0o600 });
    expect(new PublicChatOperationJournal(dir2).corrupt).toBe(true);
  });

  it('数据目录是 symlink 时拒绝', () => {
    const real = tempDir();
    const link = tempDir();
    const alias = join(link, 'alias');
    fs.symlinkSync(real, alias);
    const journal = new PublicChatOperationJournal(alias);
    expect(journal.corrupt).toBe(true);
  });

  it('损坏后 write 抛错，不产生新文件', () => {
    const dir = tempDir();
    fs.writeFileSync(join(dir, 'public-chat-operations.json'), '{', { mode: 0o600 });
    const journal = new PublicChatOperationJournal(dir);
    journal.records = [sampleRecord()];
    expect(() => journal.write()).toThrow();
    expect(fs.readFileSync(join(dir, 'public-chat-operations.json'), 'utf8')).toBe('{');
  });
});

describe('容量与不驱逐', () => {
  it('超过本地容量上限时写失败（不驱逐 unknown/tombstone），原文件字节不变', () => {
    const dir = tempDir();
    const journal = new PublicChatOperationJournal(dir, fs, { maxBytes: 20 });
    const record = sampleRecord();
    journal.records = [record];
    // 单条记录序列化必然超过 20 字节：写失败且不产生任何文件。
    expect(() => journal.write()).toThrow();
    expect(fs.existsSync(join(dir, 'public-chat-operations.json'))).toBe(false);
    expect(fs.readdirSync(dir).filter((name) => name.startsWith('.public-chat-'))).toEqual([]);

    // 已有合法文件时，下一次写超限：原文件字节不变（没有驱逐也没有半写）。
    const dir2 = tempDir();
    const journal2 = new PublicChatOperationJournal(dir2, fs, { maxBytes: 1024 * 1024 });
    journal2.records = [record];
    journal2.write();
    const sizeAfterWrite = fs.lstatSync(join(dir2, 'public-chat-operations.json')).size;
    const tight = new PublicChatOperationJournal(dir2, fs, { maxBytes: Math.max(sizeAfterWrite - 1, 10) });
    tight.records = [record];
    expect(() => tight.write()).toThrow();
    expect(fs.lstatSync(join(dir2, 'public-chat-operations.json')).size).toBe(sizeAfterWrite);
    // journal 不提供任何删除/驱逐 API：unknown/tombstone 永不因 TTL/容量删除。
    const prototypeMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(journal));
    expect(prototypeMethods).not.toContain('delete');
    expect(prototypeMethods).not.toContain('clear');
    expect(prototypeMethods).not.toContain('evict');
  });
});

describe('corrupt persisted evidence', () => {
  it('refuses malformed facts without rewriting the journal', () => {
    const dir = tempDir();
    const journal = new PublicChatOperationJournal(dir);
    journal.records = [sampleRecord()];
    journal.write();
    const file = join(dir, 'public-chat-operations.json');
    const payload = JSON.parse(fs.readFileSync(file, 'utf8')) as { records: { facts: unknown[] }[] };
    payload.records[0].facts = [null];
    const corrupt = JSON.stringify(payload);
    fs.writeFileSync(file, corrupt);
    const reloaded = new PublicChatOperationJournal(dir);
    expect(reloaded.corrupt).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe(corrupt);
  });
});
