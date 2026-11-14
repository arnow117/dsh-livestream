import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { loadVerifiedSender } from '../../src/publicChat/dyhub/verified_sender_loader.mjs';
import { openTrustedHistory, startTrustedSender } from '../../src/publicChat/trustedSender';

const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

describe('direct source sender build and trusted history', () => {
  it('verifies an actual source-built sender before opening history and rejects altered identity', async () => {
    const root = process.env.DSH_PUBLIC_CHAT_FIXTURE_ROOT;
    const fixed = process.env.DSH_PUBLIC_CHAT_RAW_EXPORT;
    if (!root || !fixed) throw new Error('task-owned fixture and fixed export required');
    const work = mkdtempSync(join(root, 'direct-source-'));
    const bundle = join(work, 'sender.mjs');
    const manifest = join(work, 'sender.manifest.json');
    const buildFile = join(work, 'build-deployment.json');
    const deployment = join(work, 'sender-deployment.json');
    const data = join(work, 'data');
    const previous = process.argv;
    try {
      process.argv = [process.execPath, 'build_raw.mjs', '--fixed-d', fixed,
        '--export-sha256', '832cbc54ed74bbe3b4467ee39aafbd3000ac9d089529ef7b8ae35cb3a400ccb1',
        '--output', bundle, '--manifest', manifest];
      try {
        await import('../../src/publicChat/dyhub/build_raw.mjs');
        await vi.waitFor(() => {
          expect(existsSync(manifest)).toBe(true);
          expect(JSON.parse(readFileSync(manifest, 'utf8')).bundleSha256).toBe(sha(readFileSync(bundle)));
        }, { timeout: 15_000, interval: 10 });
      } finally { process.argv = previous; }
      const buildDigest = sha(readFileSync(manifest));
      const buildRef = { bundlePath: bundle, exportPath: fixed, manifestPath: manifest, manifestSha256: buildDigest };
      writeFileSync(buildFile, JSON.stringify(buildRef), { mode: 0o600 });
      const loaded = await loadVerifiedSender(buildFile);
      expect(loaded.buildDigest).toBe(buildDigest);
      mkdirSync(data, { mode: 0o700 });
      const reservation = createServer();
      await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
      const address = reservation.address();
      if (!address || typeof address === 'string') throw new Error('fixture port unavailable');
      await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
      writeFileSync(deployment, JSON.stringify({ schemaVersion: 1, listenUrl: `http://127.0.0.1:${address.port}`,
        token: 'fixture-token', expectedPrincipalUid: '42', roomId: '101', accountRecordId: 'fixture-record',
        buildDigest, instanceId: 'fixture-instance', profileOrigin: 'https://www.douyin.com', dataDir: data }), { mode: 0o600 });
      const refs = { senderBuildDeploymentFile: buildFile, senderDeploymentFile: deployment };
      const history = await openTrustedHistory(refs);
      expect(history.identity()).toMatchObject({ buildDigest, roomId: '101', accountRecordId: 'fixture-record' });
      expect(history.journal.corrupt).toBe(false);
      expect(history.controller.currentFrozenGrant()).toBeNull();
      expect((await history.controller.refreshQualification()).ok).toBe(false);
      const helperReferences = vi.fn(async () => { throw new Error('must not read material'); });
      await expect(startTrustedSender({ ...refs, browserExecutable: '/fixture/browser', helperReferences }, '102', history))
        .rejects.toThrow('房间不匹配');
      expect(helperReferences).not.toHaveBeenCalled();
      await expect(openTrustedHistory(refs, () => false)).rejects.toThrow('host closed');
      chmodSync(buildFile, 0o644);
      await expect(loadVerifiedSender(buildFile)).rejects.toThrow();
      chmodSync(buildFile, 0o600);
      writeFileSync(buildFile, JSON.stringify({ ...buildRef, manifestSha256: '0'.repeat(64) }), { mode: 0o600 });
      await expect(loadVerifiedSender(buildFile)).rejects.toThrow('sender manifest mismatch');
      writeFileSync(buildFile, JSON.stringify(buildRef), { mode: 0o600 });
      const bytes = readFileSync(bundle);
      writeFileSync(bundle, Buffer.concat([Buffer.from('globalThis.__unexpectedSender = 1;\n'), bytes]), { mode: 0o600 });
      await expect(loadVerifiedSender(buildFile)).rejects.toThrow('sender bundle mismatch');
      expect((globalThis as typeof globalThis & { __unexpectedSender?: number }).__unexpectedSender).toBeUndefined();
    } finally {
      process.argv = previous;
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);
});
