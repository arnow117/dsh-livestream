import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { FrozenSenderRuntime } from '../../src/publicChat/frozenSenderRuntime';
import { FrozenPublicChatOperationJournal } from '../../src/publicChat/frozenJournal';
import { PublicChatSendController } from '../../src/publicChat/controller';
import { PublicChatInputBinding } from '../../src/publicChat/inputBinding';
import { createPublicChatReplyTool } from '../../src/publicChat/agentReplyTool';
import { SenderService } from '../../src/publicChat/senderService';
import { SenderClient } from '../../src/publicChat/senderClient';
import { HelperProcess } from '../../src/publicChat/helperLauncher';

const fixtures = vi.hoisted(() => ({ session: null as any }));
vi.mock('../../src/publicChat/trustedReferences', () => ({
  trustedHistoryReferencesFromEnvironment: () => ({ senderBuildDeploymentFile: '/fixture/build', senderDeploymentFile: '/fixture/deployment' }),
  trustedReferencesFromEnvironment: () => ({ senderBuildDeploymentFile: '/fixture/build', senderDeploymentFile: '/fixture/deployment' }),
}));
vi.mock('../../src/publicChat/trustedSender', async (original) => {
  const actual = await original<typeof import('../../src/publicChat/trustedSender')>();
  return { ...actual, openTrustedHistory: async () => { throw new Error('synthetic history unavailable'); },
    inspectTrustedSession: async () => fixtures.session };
});

async function until<T>(read: () => Promise<T>, matches: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 12000;
  for (;;) {
    const result = await read();
    if (matches(result)) return result;
    if (Date.now() > deadline) throw new Error('synthetic session timed out');
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

describe('session authentication with unavailable history', () => {
  it('shows and cancels login, then attaches the same helper after history is repaired', async () => {
    const root = process.env.DSH_HOME;
    const binary = process.env.DSH_SESSION_FIXTURE_BINARY;
    const qr = process.env.DSH_QR_FIXTURE;
    if (!root || !binary || !qr) throw new Error('task-owned synthetic fixture required');
    const directory = mkdtempSync(join(root, 'history-unavailable-'));
    const historyPath = join(directory, 'public-chat-operations.json');
    const countPath = join(directory, 'chat-count.json');
    const corrupt = Buffer.from('{synthetic-invalid');
    const probe = createServer();
    await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
    const address = probe.address();
    if (!address || typeof address === 'string') throw new Error('synthetic port unavailable');
    const port = address.port;
    await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
    const deployment = { schemaVersion: 2 as const, transportKind: 'session_http' as const, listenUrl: `http://127.0.0.1:${port}`,
      token: 'synthetic-token', roomId: '12345', accountRecordId: 'fixture-account', buildDigest: 'a'.repeat(64),
      instanceId: 'fixture-instance', dataDir: directory };
    let runtimeNonce = '';
    const refs = { senderBuildDeploymentFile: '/fixture/build', senderDeploymentFile: '/fixture/deployment', browserExecutable: '',
      helperReferences: async (nonce: string) => {
        runtimeNonce = nonce;
        return { manifestPath: '/fixture', manifestSha256: 'a'.repeat(64), sourceDirectory: '/fixture',
          transportKind: 'session_http' as const, deploymentPath: '/fixture', deploymentSha256: 'a'.repeat(64), dataDirectory: directory };
      } };
    let launches = 0;
    let rawStarts = 0;
    let helperPid = 0;
    class FixtureRuntime extends FrozenSenderRuntime {
      constructor(options: any) { super({ ...options, decodeRaw: () => null }); }
    }
    const loaded = { buildDigest: deployment.buildDigest, readSenderDeploymentFile: () => deployment,
      FrozenSenderRuntime: FixtureRuntime, FrozenPublicChatOperationJournal, PublicChatSendController, PublicChatInputBinding,
      SenderService, SenderClient, createPublicChatReplyTool,
      createFixedRawSession: () => ({ start: async () => { rawStarts++; }, stop: async () => {} }),
      launchHelper: async (options: any) => {
        launches++;
        const child = spawn(binary, ['-test.run=^TestSessionFixtureServer$', '-test.timeout=45s'], {
          cwd: directory, env: { DSH_SESSION_FIXTURE: '1', DSH_QR_FIXTURE: qr, DSH_CHAT_COUNT_FILE: countPath,
            DSH_SENDER_NONCE: runtimeNonce, TMPDIR: process.env.TMPDIR ?? directory }, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
        });
        const helper = new HelperProcess(child, options.authContextRevision, options.onDisconnect, 'session_http');
        helperPid = helper.pid;
        console.info(`owned-go-history-fixture pid=${helperPid}`);
        await helper.initialize();
        return helper;
      } };
    const { TrustedSessionAuthentication } = await import('../../src/publicChat/trustedSender');
    fixtures.session = new TrustedSessionAuthentication(refs, loaded as any, deployment, () => true);
    const { PublicChatHost } = await import('../../src/publicChat/publicChatHost');
    const host = new PublicChatHost(() => true, () => true, () => 'synthetic-session', () => false, () => '12345');
    try {
      const initial = await host.view();
      expect(initial).toMatchObject({ historyAvailable: false, hold: true, transportKind: 'session_http', login: { state: 'idle' } });
      expect((await host.view()).historyAvailable).toBe(false);
      expect(existsSync(historyPath)).toBe(false);
      writeFileSync(historyPath, corrupt, { mode: 0o600 });
      expect(launches).toBe(0);
      expect((await host.loginStart()).ok).toBe(true);
      const waiting = await until(() => host.view(), (v) => v.login?.state === 'waiting');
      const competing = new TrustedSessionAuthentication(refs, loaded as any, deployment, () => true);
      await expect(competing.start()).rejects.toThrow();
      expect(launches).toBe(1);
      expect(waiting.login?.qrDataUrl).toMatch(/^data:image\/png;base64,/);
      expect((await host.qualify()).ok).toBe(false);
      expect((await host.authorize()).ok).toBe(false);
      expect((await host.sendManual({ text: 'synthetic' })).status).toBe('rejected');
      expect(readFileSync(historyPath)).toEqual(corrupt);
      expect((await host.loginCancel({ attemptId: waiting.login!.attemptId, revision: waiting.login!.revision })).ok).toBe(true);
      expect((await host.view()).login?.state).toBe('cancelled');
      expect((await host.loginStart()).ok).toBe(true);
      const confirmation = await until(() => host.view(), (v) => v.login?.state === 'confirmation_required');
      expect((await host.confirmSession({ bindingRef: confirmation.login!.bindingRef })).ok).toBe(true);
      expect(readFileSync(historyPath)).toEqual(corrupt);
      writeFileSync(historyPath, JSON.stringify({ schemaVersion: 4, records: [], controls: [] }), { mode: 0o600 });
      expect((await host.view()).historyAvailable).toBe(true);
      host.setLive({ roomId: '12345', epoch: 'synthetic-live', startedAtMs: Date.now() });
      host.inputChanged('connected', 'idle');
      expect((await host.maintain()).ok).toBe(true);
      expect(launches).toBe(1);
      expect(helperPid).toBeGreaterThan(0);
      expect(rawStarts).toBe(1);
      expect(existsSync(countPath)).toBe(false);
    } finally {
      await host.close();
      fixtures.session = null;
    }
  }, 30000);
});
