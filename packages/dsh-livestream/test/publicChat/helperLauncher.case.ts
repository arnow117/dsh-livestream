import { createHash, generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { launchHelper } from '../../src/publicChat/helperLauncher';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

describe('verified private helper launcher', () => {
  it('passes read-only FDs to the verified real helper and reaps its own process', async () => {
    const outputRoot = process.env.DSH_PUBLIC_CHAT_FIXTURE_ROOT;
    const binary = process.env.DSH_HELPER_FIXTURE_BINARY;
    if (!outputRoot || !binary) throw new Error('isolated helper fixture paths required');
    const root = await realpath(await mkdtemp(join(outputRoot, 'launcher-')));
    const sourceDirectory = await realpath(process.env.DSH_HELPER_FIXTURE_SOURCE ??
      resolve(fileURLToPath(new URL('../../src/publicChat/httpHelper/', import.meta.url))));
    let processId = 0;
    let disconnects = 0;
    try {
      const now = Date.now();
      const key = generateKeyPairSync('ec', {
        namedCurve: 'prime256v1',
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
      });
      const material = {
        cookies: [{ name: 'fixture', value: 'synthetic', domain: '.douyin.com', path: '/', secure: true,
          httpOnly: true, sameSite: 'Lax', expiresAtMs: now + 60_000, hostOnly: false, partitioned: false }],
        userAgent: 'fixture', browserName: 'fixture', browserVersion: '1', browserLanguage: 'fixture',
        engineName: 'fixture', engineVersion: '1', osName: 'fixture', osVersion: '1', cpuCoreNum: '1', deviceMemory: '1',
        platform: 'fixture', screenWidth: 1, screenHeight: 1, geo: [1, 2, 3, 4, 5, 6, 7, 8],
        msToken: 'fixture', webId: 'fixture', verifyFp: 'fixture', uifid: 'fixture', ticket: 'fixture', tsSign: 'fixture',
        privateKey: key.privateKey, serverCert: '', bdMode: 'ecdsa', csrfToken: 'fixture',
        csrfOrigin: 'https://live.douyin.com', csrfPath: '/webcast/room/chat/', csrfExpiresMs: now + 60_000, expiresAtMs: now + 60_000,
      };
      const deployment = { buildDigest: 'a'.repeat(64), instanceId: 'fixture', senderProcessNonce: 'sender',
        accountRecordId: 'record', principalUid: '42', roomId: '101', authContextRevision: 1 };
      const materialPath = join(root, 'material.json');
      const deploymentPath = join(root, 'deployment.json');
      const deploymentBytes = Buffer.from(JSON.stringify(deployment));
      await writeFile(materialPath, JSON.stringify(material), { flag: 'wx', mode: 0o600 });
      await writeFile(deploymentPath, deploymentBytes, { flag: 'wx', mode: 0o600 });
      const names = (await readdir(sourceDirectory)).filter((name) => !name.endsWith('_test.go')).sort();
      const sourceFiles: Record<string, string> = {};
      for (const name of names) sourceFiles[name] = hash(await readFile(join(sourceDirectory, name)));
      const manifest = { schemaVersion: 1, binaryPath: await realpath(binary), binarySha256: hash(await readFile(binary)), sourceFiles };
      const manifestBytes = Buffer.from(JSON.stringify(manifest));
      const manifestPath = join(root, 'manifest.json');
      await writeFile(manifestPath, manifestBytes, { flag: 'wx', mode: 0o600 });
      const options = { manifestPath, manifestSha256: hash(manifestBytes), sourceDirectory,
        materialPath, deploymentPath, deploymentSha256: hash(deploymentBytes), dataDirectory: root, authContextRevision: 1,
        onDisconnect: () => { disconnects++; } };
      await expect(launchHelper({ ...options, manifestSha256: '0'.repeat(64) })).rejects.toThrow();
      await expect(launchHelper({ ...options, deploymentSha256: '0'.repeat(64) })).rejects.toThrow();
      const linkedMaterial = join(root, 'linked-material.json');
      await symlink(materialPath, linkedMaterial);
      await expect(launchHelper({ ...options, materialPath: linkedMaterial })).rejects.toThrow();
      const alteredManifest = { ...manifest, sourceFiles: { ...sourceFiles, 'main.go': '0'.repeat(64) } };
      const alteredBytes = Buffer.from(JSON.stringify(alteredManifest));
      const alteredPath = join(root, 'altered-manifest.json');
      await writeFile(alteredPath, alteredBytes, { flag: 'wx', mode: 0o600 });
      await expect(launchHelper({ ...options, manifestPath: alteredPath, manifestSha256: hash(alteredBytes) })).rejects.toThrow();
      expect(disconnects).toBe(0);
      const helper = await launchHelper(options);
      processId = helper.pid;
      try {
        expect(helper.identity.helperNonce).toBeTruthy();
        expect((await helper.request('query', 'missing', {})).status).toBe('not_found');
      } finally {
        await helper.close();
      }
      expect(disconnects).toBe(1);
      expect(() => process.kill(processId, 0)).toThrow();
      console.info(`owned-helper-pid=${processId} reaped`);

      const delayedSource = join(root, 'delayed-source');
      const productionSource = resolve(fileURLToPath(new URL('../../src/publicChat/httpHelper/', import.meta.url)));
      await cp(productionSource, delayedSource, { recursive: true });
      const mainFile = join(delayedSource, 'main.go');
      const main = await readFile(mainFile, 'utf8');
      const originalPreparation = 'targets, err := prepareFixedTargets(nil)';
      if (main.split(originalPreparation).length !== 2) throw new Error('fixture preparation source mismatch');
      await writeFile(mainFile, main.replace(originalPreparation, 'targets, err := delayedFixtureTargets()'));
      const pidFile = join(root, 'delayed-pid');
      const delayedGo = `package main\nimport ("errors"; "os"; "strconv"; "time")\n` +
        `func delayedFixtureTargets() (map[string]tlsTarget, error) {\n` +
        `  _ = os.WriteFile(${JSON.stringify(pidFile)}, []byte(strconv.Itoa(os.Getpid())), 0600)\n` +
        `  time.Sleep(30 * time.Second)\n  return nil, errors.New("fixture resolution unavailable")\n}\n`;
      await writeFile(join(delayedSource, 'delayed_fixture.go'), delayedGo);
      for (const name of ['gomodcache', 'gocache', 'gotmp']) await mkdir(join(root, name));
      const delayedBinary = join(root, 'delayed-helper');
      execFileSync('go', ['build', '-mod=readonly', '-trimpath', '-buildvcs=false', '-o', delayedBinary, '.'], {
        cwd: delayedSource, env: { ...process.env, GOTOOLCHAIN: 'local', GOWORK: 'off', GOPROXY: 'off',
          GOMODCACHE: join(root, 'gomodcache'), GOCACHE: join(root, 'gocache'), GOTMPDIR: join(root, 'gotmp') }, stdio: 'pipe',
      });
      const delayedSources: Record<string, string> = {};
      for (const name of (await readdir(delayedSource)).filter((entry) => !entry.endsWith('_test.go')).sort()) {
        delayedSources[name] = hash(await readFile(join(delayedSource, name)));
      }
      const delayedManifest = Buffer.from(JSON.stringify({ schemaVersion: 1, binaryPath: delayedBinary,
        binarySha256: hash(await readFile(delayedBinary)), sourceFiles: delayedSources }));
      const delayedManifestPath = join(root, 'delayed-manifest.json');
      await writeFile(delayedManifestPath, delayedManifest, { flag: 'wx', mode: 0o600 });
      await expect(launchHelper({ ...options, sourceDirectory: delayedSource, manifestPath: delayedManifestPath,
        manifestSha256: hash(delayedManifest) })).rejects.toThrow();
      const delayedPid = Number(await readFile(pidFile, 'utf8'));
      expect(Number.isSafeInteger(delayedPid) && delayedPid > 0).toBe(true);
      expect(() => process.kill(delayedPid, 0)).toThrow();
      console.info(`owned-unready-helper-pid=${delayedPid} reaped`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
