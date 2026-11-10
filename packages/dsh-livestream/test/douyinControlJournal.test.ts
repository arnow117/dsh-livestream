import * as fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DouyinControlJournal, type AdmittedMarker } from '../src/dsh/douyinControlJournal';

const dirs: string[] = [];
const makeDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'douyin-journal-'));
  dirs.push(dir);
  return dir;
};
const marker: AdmittedMarker = {
  schemaVersion: 1, opId: 'operation', type: 'connect', phase: 'http', settled: false,
  roomId: '123', revision: 'revision', origin: 'http://127.0.0.1:1234', admittedAt: 100,
  dispatchNotAfter: 200, activeUntil: 300, preflightStartedAt: null, preflightMissing: true,
  bridgeVersion: 'dyhub-0.3.1-3a79c57d85c59289db3b77211b3ec01fae47d42c', bridgeRequestStart: null,
  bridgeResponseEnd: null, bridgeUptimeSec: null, bridgeStartMin: null, bridgeStartMax: null, hostBootTime: null,
  accountName: null, accountIds: ['anonymous'],
};
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe('durable collector operation journal', () => {
  it('restores an admitted marker and removes it only after a settled record', async () => {
    const dir = await makeDir();
    const journal = new DouyinControlJournal(dir);
    journal.write(marker);
    expect(fs.statSync(join(dir, 'douyin-control.json')).mode & 0o777).toBe(0o600);
    expect(new DouyinControlJournal(dir).marker).toEqual(marker);
    journal.clear();
    expect(new DouyinControlJournal(dir).marker).toBeNull();
  });

  it('fails closed for corrupt JSON and symlinks', async () => {
    const dir = await makeDir();
    const file = join(dir, 'douyin-control.json');
    fs.writeFileSync(file, '{broken');
    expect(new DouyinControlJournal(dir).corrupt).toBe(true);
    fs.unlinkSync(file);
    fs.symlinkSync('/dev/null', file);
    expect(new DouyinControlJournal(dir).corrupt).toBe(true);
  });

  it.each(['writeFileSync', 'fsyncSync', 'renameSync'] as const)('does not admit a marker after %s failure', async (method) => {
    const dir = await makeDir();
    const io = { ...fs, [method]: () => { throw new Error(`failed ${method}`); } } as typeof fs;
    const journal = new DouyinControlJournal(dir, io);
    expect(() => journal.write(marker)).toThrow();
    expect(new DouyinControlJournal(dir).marker).toBeNull();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('retains a durable lock when cleanup fails', async () => {
    const dir = await makeDir();
    const io = { ...fs, unlinkSync: () => { throw new Error('unlink failed'); } } as typeof fs;
    const journal = new DouyinControlJournal(dir, io);
    journal.write(marker);
    expect(() => journal.clear()).toThrow();
    expect(journal.marker).not.toBeNull();
    expect(new DouyinControlJournal(dir).marker).not.toBeNull();
  });

  it('fails closed if directory fsync fails after the marker was renamed', async () => {
    const dir = await makeDir();
    let syncs = 0;
    const io = {
      ...fs,
      fsyncSync(descriptor: number) {
        syncs++;
        if (syncs === 3) throw new Error('directory sync failed');
        fs.fsyncSync(descriptor);
      },
    } as typeof fs;
    const journal = new DouyinControlJournal(dir, io);
    expect(() => journal.write(marker)).toThrow('directory sync failed');
    expect(journal.corrupt).toBe(true);
    expect(new DouyinControlJournal(dir).marker).toEqual(marker);
    expect(() => journal.write(marker)).toThrow('日志不可用');
  });
});
