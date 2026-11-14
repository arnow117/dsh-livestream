/** Sender-only v1 routing over real loopback HTTP. The private helper is substituted in this file. */
import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FrozenSenderRuntime } from '../../src/publicChat/frozenSenderRuntime';
import { FrozenPublicChatOperationJournal } from '../../src/publicChat/frozenJournal';
import { PublicChatSendController } from '../../src/publicChat/controller';
import { SenderService } from '../../src/publicChat/senderService';
import { SenderClient, readSenderDeploymentFile } from '../../src/publicChat/senderClient';
import type { SenderDeploymentFile } from '../../src/publicChat/protocol';
import { makeFrozenTestHelper } from './frozenTestHelper';
import { TEST_BUILD_DIGEST, TEST_INSTANCE_ID, TEST_PRINCIPAL_UID, TEST_ROOM_ID, TEST_ACCOUNT_RECORD_ID, waitFor } from './test-helpers';

const cleanupDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pubchat-sender-'));
  cleanupDirs.push(dir);
  return dir;
}
afterEach(() => { for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const DEPLOYMENT: SenderDeploymentFile = { schemaVersion: 1, listenUrl: 'http://127.0.0.1:0',
  token: 'test-sender-token-abcdef', expectedPrincipalUid: TEST_PRINCIPAL_UID, roomId: TEST_ROOM_ID,
  accountRecordId: TEST_ACCOUNT_RECORD_ID, buildDigest: TEST_BUILD_DIGEST, instanceId: TEST_INSTANCE_ID,
  profileOrigin: 'https://www.douyin.com', dataDir: '/nonexistent-for-test' };
const runtimeDeployment = { buildDigest: TEST_BUILD_DIGEST, instanceId: TEST_INSTANCE_ID,
  expectedPrincipalUid: TEST_PRINCIPAL_UID, roomId: TEST_ROOM_ID, accountRecordId: TEST_ACCOUNT_RECORD_ID };

async function makeService(rejectProfile = false) {
  const mock = makeFrozenTestHelper(TEST_PRINCIPAL_UID);
  if (rejectProfile) mock.rejectProfile();
  const startedAt = Date.now() - 1000;
  const runtime = new FrozenSenderRuntime({ deployment: runtimeDeployment,
    decodeRaw: () => ({ common: { roomId: '202', createTime: Date.now() } }), launch: async () => mock.helper });
  runtime.setInputAndLive(1, 'epoch-1', startedAt);
  const observer = runtime.createRawEvidenceObserver(TEST_ROOM_ID,
    { url: () => `https://live.douyin.com/${TEST_ROOM_ID}`, context: () => ({}) }, {});
  observer.socketCreated('socket', 'wss://webcast100-ws-web-lq.douyin.com/webcast/im/push/v2/?room_id=202');
  observer.rawMessage('socket', { method: 'WebcastChatMessage', msgId: 'raw', payload: new Uint8Array() });
  const maintenance = await runtime.beginAuthenticationMaintenance({ manifestPath: '/fixture', manifestSha256: 'a'.repeat(64),
    sourceDirectory: '/fixture', materialPath: '/fixture', deploymentPath: '/fixture', deploymentSha256: 'a'.repeat(64), dataDirectory: '/fixture' });
  if (!maintenance.ok) throw new Error('fixture helper unavailable');
  const service = new SenderService({ runtime, deployment: DEPLOYMENT, token: DEPLOYMENT.token });
  return { runtime, service, observer, mock, startedAt };
}

async function withService(run: (origin: string, fixture: Awaited<ReturnType<typeof makeService>>) => Promise<void>, rejectProfile = false) {
  const fixture = await makeService(rejectProfile);
  const origin = await fixture.service.start();
  console.info(`owned-http-listener pid=${process.pid} port=${new URL(origin).port}`);
  try { await run(origin, fixture); } finally { await fixture.service.close(); }
}

function client(origin: string) {
  return new SenderClient({ url: origin, token: DEPLOYMENT.token,
    expected: { buildDigest: TEST_BUILD_DIGEST, instanceId: TEST_INSTANCE_ID }, timeoutMs: 1500 });
}

async function authorizedController(origin: string, startedAt: number) {
  const sender = client(origin);
  const journal = new FrozenPublicChatOperationJournal(tempDir());
  const controller = new PublicChatSendController({ deployment: runtimeDeployment, gateway: sender, journal,
    bounds: { dispatchIntervalMs: 0 } });
  controller.advanceInputConnection();
  controller.setLiveEpoch('epoch-1', startedAt);
  expect((await controller.refreshQualification()).ok).toBe(true);
  expect((await controller.authorize()).ok).toBe(true);
  return { sender, controller };
}

describe('routing and credentials over actual HTTP', () => {
  it('returns the fixed sender instance, build and nonce to an authorized client', async () => {
    await withService(async (origin) => {
      const result = await client(origin).frozenState();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.protocol).toBe('dsh-public-chat-v1');
        expect(result.value.buildDigest).toBe(TEST_BUILD_DIGEST);
        expect(result.value.instanceId).toBe(TEST_INSTANCE_ID);
        expect(result.value.processNonce).not.toBe('');
        expect(result.value.raw?.proof?.webRoomId).toBe(TEST_ROOM_ID);
      }
    });
  });

  it('rejects absent credentials, non-JSON and legacy routes without side effects', async () => {
    await withService(async (origin, { runtime, mock }) => {
      expect((await fetch(new URL('/v1/state', origin))).status).toBe(401);
      expect((await fetch(new URL('/v1/state', origin), { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
      expect((await fetch(new URL('/v1/send', origin), { method: 'POST',
        headers: { authorization: `Bearer ${DEPLOYMENT.token}`, 'content-type': 'text/plain' }, body: 'hello' })).status).toBe(400);
      for (const path of [`/api/rooms/${TEST_ROOM_ID}/chat`, '/api/rooms/connect', '/api/accounts',
        '/api/accounts/acc-1/cookie', '/api/accounts/acc-1/login']) {
        for (const method of ['GET', 'POST', 'DELETE']) {
          const response = await fetch(new URL(path, origin), { method,
            headers: { authorization: `Bearer ${DEPLOYMENT.token}`, 'content-type': 'application/json' },
            body: method === 'GET' ? undefined : '{}' });
          expect(response.status).toBe(404);
        }
      }
      expect(runtime.state().qualification).toBeNull();
      expect(runtime.operation('any-request')).toBeNull();
      expect(mock.calls).toHaveLength(0);
      const cors = await fetch(new URL('/v1/state', origin), { method: 'OPTIONS' });
      expect(cors.status).toBe(405);
      expect(cors.headers.get('access-control-allow-origin')).toBeNull();
    });
  });

  it('holds a failed qualification and refuses sending without an authorization', async () => {
    await withService(async (origin, fixture) => {
      const sender = client(origin);
      const state = await sender.frozenState();
      if (!state.ok) throw new Error('state unavailable');
      const capture = await sender.frozenCapture('capture-failed', state.value.processNonce);
      expect(capture.ok).toBe(true);
      if (capture.ok) expect(capture.value.record.state).not.toBe('qualified');
      const response = await fetch(new URL('/v1/send', origin), { method: 'POST',
        headers: { authorization: `Bearer ${DEPLOYMENT.token}`, 'content-type': 'application/json' }, body: '{}' });
      expect(response.status).toBeGreaterThanOrEqual(400);
      const revoke = await sender.frozenRevoke({ revokeId: 'revoke-failed-capture',
        expectedSenderProcessNonce: state.value.processNonce, target: { kind: 'capture', captureId: 'capture-failed' } });
      expect(revoke.ok).toBe(true);
      expect(fixture.mock.calls.filter((kind) => kind === 'send')).toHaveLength(0);
    }, true);
  });

  it('dispatches an authorized original once and does not replay the request ID', async () => {
    await withService(async (origin, fixture) => {
      const { sender, controller } = await authorizedController(origin, fixture.startedAt);
      expect((await controller.submit({ requestId: 'req-live', sourceKey: 'sk-1', text: '大家好' })).status).toBe('accepted');
      await waitFor(() => controller.frozenOperationView('req-live')?.state === 'api_reported_success');
      const original = controller.frozenOperationView('req-live')!;
      const duplicate = await sender.frozenSend({ requestId: 'req-live', sourceKey: 'sk-1', grant: original.grant,
        text: '大家好', autoEvent: null });
      expect(duplicate.ok).toBe(true);
      expect(fixture.mock.calls.filter((kind) => kind === 'send')).toHaveLength(1);
    });
  });

  it('invalidates the old grant after the original raw connection closes', async () => {
    await withService(async (origin, fixture) => {
      const { sender, controller } = await authorizedController(origin, fixture.startedAt);
      await controller.submit({ requestId: 'original', sourceKey: 'original', text: '大家好' });
      await waitFor(() => controller.frozenOperationView('original')?.state === 'api_reported_success');
      const original = controller.frozenOperationView('original')!;
      fixture.observer.socketClosed('socket');
      const stale = await sender.frozenSend({ requestId: 'stale', sourceKey: 'stale', grant: original.grant,
        text: '旧授权', autoEvent: null });
      expect(stale.ok).toBe(false);
      expect(fixture.mock.calls.filter((kind) => kind === 'send')).toHaveLength(1);
    });
  });
});

describe('deployment and identity boundaries', () => {
  it('rejects missing token, invalid listen address and missing runtime', () => {
    const runtime = new FrozenSenderRuntime({ deployment: runtimeDeployment, decodeRaw: () => null });
    expect(() => new SenderService({ runtime, deployment: DEPLOYMENT, token: '' })).toThrow();
    expect(() => new SenderService({ runtime, deployment: { ...DEPLOYMENT, listenUrl: 'http://0.0.0.0:9000' }, token: DEPLOYMENT.token })).toThrow();
    expect(() => new SenderService({ runtime, deployment: { ...DEPLOYMENT, listenUrl: 'http://127.0.0.1:abc' }, token: DEPLOYMENT.token })).toThrow();
    expect(() => new SenderService({ runtime: null as unknown as FrozenSenderRuntime, deployment: DEPLOYMENT, token: DEPLOYMENT.token })).toThrow();
  });

  it('accepts only an owned 0600 regular deployment file without a symlink', () => {
    const dir = tempDir();
    const path = join(dir, 'sender-deploy.json');
    const body = JSON.stringify({ ...DEPLOYMENT, listenUrl: 'http://127.0.0.1:19743' });
    writeFileSync(path, body, { mode: 0o644 });
    expect(() => readSenderDeploymentFile(path)).toThrow();
    chmodSync(path, 0o600);
    const config = readSenderDeploymentFile(path);
    expect(config.expectedPrincipalUid).toBe(TEST_PRINCIPAL_UID);
    expect(config.roomId).toBe(TEST_ROOM_ID);
    expect(typeof config.token).toBe('string');
    const link = join(dir, 'linked.json');
    symlinkSync(path, link);
    expect(() => readSenderDeploymentFile(link)).toThrow();
  });

  it('rejects non-loopback listening addresses', () => {
    const runtime = new FrozenSenderRuntime({ deployment: runtimeDeployment, decodeRaw: () => null });
    expect(() => new SenderService({ runtime, deployment: { ...DEPLOYMENT, listenUrl: 'http://192.168.1.5:9000' },
      token: DEPLOYMENT.token })).toThrow();
  });

  it('does not perform profile capture before a raw session is available', async () => {
    const mock = makeFrozenTestHelper(TEST_PRINCIPAL_UID);
    const runtime = new FrozenSenderRuntime({ deployment: runtimeDeployment, decodeRaw: () => null, launch: async () => mock.helper });
    await runtime.beginAuthenticationMaintenance({ manifestPath: '/fixture', manifestSha256: 'a'.repeat(64), sourceDirectory: '/fixture',
      materialPath: '/fixture', deploymentPath: '/fixture', deploymentSha256: 'a'.repeat(64), dataDirectory: '/fixture' });
    expect(await runtime.captureQualification('before-raw', runtime.processNonce)).toBeNull();
    expect(mock.calls.filter((kind) => kind === 'profile')).toHaveLength(0);
  });
});
