import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

describe('verified Node sender entry', () => {
  it('checks the trusted manifest, sources, export and bundle before importing sender code', async () => {
    const fixtureRoot = process.env.DSH_PUBLIC_CHAT_FIXTURE_ROOT;
    const fixedSource = process.env.DSH_PUBLIC_CHAT_RAW_EXPORT;
    if (!fixtureRoot || !fixedSource) throw new Error('isolated sender fixture required');
    const root = fs.mkdtempSync(join(fixtureRoot, 'sender-identity-'));
    const packageRoot = join(root, 'package');
    const sourceRoot = join(packageRoot, 'src', 'publicChat');
    const fixedRoot = join(root, 'fixed');
    const original = resolve(fileURLToPath(new URL('../../src/publicChat/', import.meta.url)));
    try {
      fs.mkdirSync(join(packageRoot, 'src'), { recursive: true });
      fs.cpSync(original, sourceRoot, { recursive: true });
      fs.cpSync(fixedSource, fixedRoot, { recursive: true });
      fs.symlinkSync(resolve(fileURLToPath(new URL('../../node_modules', import.meta.url))), join(packageRoot, 'node_modules'));
      const output = join(root, 'sender.mjs');
      const manifestPath = join(root, 'sender.manifest.json');
      const exportDigest = sha(fs.readFileSync(join(fixedRoot, 'dsh-raw-export-manifest.json')));
      execFileSync(process.execPath, [join(sourceRoot, 'dyhub', 'build_raw.mjs'), '--fixed-d', fixedRoot,
        '--export-sha256', exportDigest, '--output', output, '--manifest', manifestPath],
      { cwd: packageRoot, env: process.env, stdio: 'pipe' });
      const loaderPath = join(sourceRoot, 'dyhub', 'verified_sender_loader.mjs');
      const loader = await import(/* @vite-ignore */ pathToFileURL(loaderPath).href) as {
        loadVerifiedSender(path: string): Promise<{ buildDigest: string; FrozenSenderRuntime: new (options: unknown) => unknown }>;
      };
      const configPath = join(root, 'deployment.json');
      const config = { bundlePath: output, exportPath: fixedRoot, manifestPath, manifestSha256: sha(fs.readFileSync(manifestPath)) };
      const saveConfig = () => fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
      saveConfig();
      const verified = await loader.loadVerifiedSender(configPath);
      expect(verified.buildDigest).toBe(config.manifestSha256);
      fs.chmodSync(configPath, 0o644);
      await expect(loader.loadVerifiedSender(configPath)).rejects.toThrow();
      fs.chmodSync(configPath, 0o600);
      expect(() => new verified.FrozenSenderRuntime({ deployment: { buildDigest: '0'.repeat(64) } })).toThrow('unverified sender build identity');
      expect(() => new verified.FrozenSenderRuntime({ deployment: { buildDigest: verified.buildDigest }, decodeRaw: () => ({}) }))
        .toThrow('sender decoder is fixed');

      const bundleBytes = fs.readFileSync(output);
      const originalManifest = fs.readFileSync(manifestPath);
      const maliciousBundle = join(root, 'not-executed.mjs');
      fs.writeFileSync(maliciousBundle, Buffer.concat([Buffer.from('globalThis.__senderLoaderSentinel = 1;\n'), bundleBytes]), { mode: 0o600 });
      const altered = JSON.parse(originalManifest.toString('utf8'));
      altered.bundleSha256 = sha(fs.readFileSync(maliciousBundle));
      const alteredManifest = join(root, 'not-executed.manifest.json');
      fs.writeFileSync(alteredManifest, JSON.stringify(altered), { mode: 0o600 });
      config.bundlePath = maliciousBundle;
      config.manifestPath = alteredManifest;
      config.manifestSha256 = sha(fs.readFileSync(alteredManifest));
      saveConfig();
      const watched = globalThis as typeof globalThis & { __senderLoaderSentinel?: number };
      delete watched.__senderLoaderSentinel;
      const changes = [
        join(sourceRoot, 'dyhub', 'sender_entry.mjs'),
        join(sourceRoot, 'dyhub', 'build_raw.mjs'),
        join(sourceRoot, 'dyhub', 'raw-only.patch'),
        join(fixedRoot, 'src', 'collector', 'liveSession.ts'),
        join(fixedRoot, 'dsh-raw-export-manifest.json'),
      ];
      for (const path of changes) {
        const bytes = fs.readFileSync(path);
        fs.appendFileSync(path, '\n/* fixture tamper */\n');
        try {
          await expect(loader.loadVerifiedSender(configPath)).rejects.toThrow();
          expect(watched.__senderLoaderSentinel).toBeUndefined();
        } finally {
          fs.writeFileSync(path, bytes);
        }
      }
      const extraMember = join(fixedRoot, '__proto__');
      fs.writeFileSync(extraMember, 'fixture extra member');
      await expect(loader.loadVerifiedSender(configPath)).rejects.toThrow();
      expect(watched.__senderLoaderSentinel).toBeUndefined();
      fs.unlinkSync(extraMember);
      const changedBundle = fs.readFileSync(maliciousBundle);
      fs.appendFileSync(maliciousBundle, '\n/* fixture tamper */\n');
      await expect(loader.loadVerifiedSender(configPath)).rejects.toThrow();
      expect(watched.__senderLoaderSentinel).toBeUndefined();
      fs.writeFileSync(maliciousBundle, changedBundle);
      const manifestBytes = fs.readFileSync(alteredManifest);
      fs.appendFileSync(alteredManifest, ' ');
      await expect(loader.loadVerifiedSender(configPath)).rejects.toThrow();
      expect(watched.__senderLoaderSentinel).toBeUndefined();
      fs.writeFileSync(alteredManifest, manifestBytes);
      config.manifestSha256 = '0'.repeat(64);
      saveConfig();
      await expect(loader.loadVerifiedSender(configPath)).rejects.toThrow();
      expect(watched.__senderLoaderSentinel).toBeUndefined();
      config.bundlePath = maliciousBundle;
      const wrongEntry = JSON.parse(manifestBytes.toString('utf8'));
      const outputMetadata = Object.values(wrongEntry.metafile.outputs)[0] as { entryPoint: string };
      outputMetadata.entryPoint = 'src/publicChat/other-entry.mjs';
      fs.writeFileSync(alteredManifest, JSON.stringify(wrongEntry));
      config.manifestSha256 = sha(fs.readFileSync(alteredManifest));
      saveConfig();
      await expect(loader.loadVerifiedSender(configPath)).rejects.toThrow();
      expect(watched.__senderLoaderSentinel).toBeUndefined();
      fs.writeFileSync(alteredManifest, manifestBytes);
      const unexpectedField = { ...JSON.parse(manifestBytes.toString('utf8')), unexpected: true };
      fs.writeFileSync(alteredManifest, JSON.stringify(unexpectedField));
      config.manifestSha256 = sha(fs.readFileSync(alteredManifest));
      saveConfig();
      await expect(loader.loadVerifiedSender(configPath)).rejects.toThrow();
      expect(watched.__senderLoaderSentinel).toBeUndefined();
      fs.writeFileSync(alteredManifest, `{"schemaVersion":1,${manifestBytes.toString('utf8').slice(1)}`);
      config.manifestSha256 = sha(fs.readFileSync(alteredManifest));
      saveConfig();
      await expect(loader.loadVerifiedSender(configPath)).rejects.toThrow();
      expect(watched.__senderLoaderSentinel).toBeUndefined();
      fs.writeFileSync(alteredManifest, manifestBytes);
      config.manifestSha256 = sha(fs.readFileSync(alteredManifest));
      const alias = join(root, 'alias.mjs');
      fs.symlinkSync(maliciousBundle, alias);
      config.bundlePath = alias;
      saveConfig();
      await expect(loader.loadVerifiedSender(configPath)).rejects.toThrow();
      expect(watched.__senderLoaderSentinel).toBeUndefined();
      config.bundlePath = maliciousBundle;
      saveConfig();
      await loader.loadVerifiedSender(configPath);
      expect(watched.__senderLoaderSentinel).toBe(1);
    } finally {
      delete (globalThis as typeof globalThis & { __senderLoaderSentinel?: number }).__senderLoaderSentinel;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
