import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('changed-code coverage guard', () => {
  let dir: string;
  const script = resolve('test/coverage-diff.mjs');
  const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: 'utf8' });

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-coverage-guard-'));
    execFileSync('git', ['init', '-q', dir]);
    execFileSync('git', ['-C', dir, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', 'baseline']);
    const coverageDir = join(dir, 'packages/dsh-livestream/coverage/feat-001');
    mkdirSync(coverageDir, { recursive: true });
    writeFileSync(join(coverageDir, 'coverage-final.json'), '{}');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('rejects a missing baseline, an invalid baseline, and an empty coverage range', () => {
    const missing = run();
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain('baseline-commit');
    expect(run('not-a-real-commit').status).not.toBe(0);
    expect(run('--stat').status).not.toBe(0);
    const empty = run('HEAD');
    expect(empty.status).not.toBe(0);
    expect(empty.stderr).toContain('No instrumented changed lines or branches');
  });
});
