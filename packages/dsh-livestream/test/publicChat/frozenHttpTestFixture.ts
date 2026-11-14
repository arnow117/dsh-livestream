import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PublicChatSendController } from '../../src/publicChat/controller';
import { FrozenPublicChatOperationJournal } from '../../src/publicChat/frozenJournal';
import { FrozenSenderRuntime } from '../../src/publicChat/frozenSenderRuntime';
import { SenderClient } from '../../src/publicChat/senderClient';
import { SenderService } from '../../src/publicChat/senderService';
import { makeFrozenTestHelper } from './frozenTestHelper';
import { TEST_ACCOUNT_RECORD_ID, TEST_BUILD_DIGEST, TEST_INSTANCE_ID, TEST_LIVE_EPOCH, TEST_PRINCIPAL_UID, TEST_ROOM_ID } from './test-helpers';

const deployment = { buildDigest: TEST_BUILD_DIGEST, instanceId: TEST_INSTANCE_ID, accountRecordId: TEST_ACCOUNT_RECORD_ID,
  expectedPrincipalUid: TEST_PRINCIPAL_UID, roomId: TEST_ROOM_ID };
const token = 'fixture-token';

/** Real Controller/HTTP/Runtime with a helper substitute, confined to an owned loopback listener. */
export async function startFrozenHttpFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'frozen-http-fixture-'));
  const startedAt = Date.now() - 1000;
  const mock = makeFrozenTestHelper(TEST_PRINCIPAL_UID);
  const runtime = new FrozenSenderRuntime({ deployment, decodeRaw: () => ({ common: { roomId: '202', createTime: Date.now() } }),
    launch: async () => mock.helper });
  runtime.setInputAndLive(1, TEST_LIVE_EPOCH, startedAt);
  const observer = runtime.createRawEvidenceObserver(TEST_ROOM_ID,
    { url: () => `https://live.douyin.com/${TEST_ROOM_ID}`, context: () => ({}) }, {});
  const openRaw = () => {
    observer.socketCreated('socket', 'wss://webcast100-ws-web-lq.douyin.com/webcast/im/push/v2/?room_id=202');
    observer.rawMessage('socket', { method: 'WebcastChatMessage', msgId: 'raw', payload: new Uint8Array() });
  };
  openRaw();
  const maintenance = await runtime.beginAuthenticationMaintenance({ manifestPath: '/fixture', manifestSha256: 'a'.repeat(64),
    sourceDirectory: '/fixture', materialPath: '/fixture', deploymentPath: '/fixture', deploymentSha256: 'a'.repeat(64), dataDirectory: '/fixture' });
  if (!maintenance.ok) throw new Error('fixture helper unavailable');
  const service = new SenderService({ runtime, token, deployment: { ...deployment, schemaVersion: 1,
    listenUrl: 'http://127.0.0.1:0', token, profileOrigin: 'https://www.douyin.com', dataDir: directory } });
  const origin = await service.start();
  console.info(`owned-http-listener pid=${process.pid} port=${new URL(origin).port}`);
  const sender = new SenderClient({ url: origin, token, expected: { buildDigest: TEST_BUILD_DIGEST, instanceId: TEST_INSTANCE_ID } });
  const journal = new FrozenPublicChatOperationJournal(directory);
  const controller = new PublicChatSendController({ deployment, gateway: sender, journal, bounds: { dispatchIntervalMs: 0 } });
  controller.advanceInputConnection();
  controller.setLiveEpoch(TEST_LIVE_EPOCH, startedAt);
  const close = async () => { await service.close(); rmSync(directory, { recursive: true, force: true }); };
  return { runtime, observer, openRaw, mock, origin, sender, journal, controller, directory, close };
}
