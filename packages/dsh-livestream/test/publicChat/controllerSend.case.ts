/** Frozen HTTP controller dispatch, queue and journal boundaries. */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { PublicChatSendController } from '../../src/publicChat/controller';
import { FrozenPublicChatOperationJournal } from '../../src/publicChat/frozenJournal';
import { applySettingsPatch, DEFAULT_PUBLIC_CHAT_SETTINGS } from '../../src/publicChat/settings';
import { registerSourceEventMetadata } from '../../src/publicChat/eventRef';
import { controlPayloadHash } from '../../src/publicChat/grantAuthority';
import { makeFrozenTestGateway, FROZEN_TEST_DEPLOYMENT, successfulOperation } from './frozenTestGateway';
import { makeTempDir, TEST_LIVE_EPOCH, TEST_PRINCIPAL_UID, TEST_ROOM_ID, digestOf, waitFor } from './test-helpers';

const BOUNDS = { queueLimit: 10, queueWaitMs: 5_000, dispatchIntervalMs: 5, httpTimeoutMs: 1_000 };

type Fixture = ReturnType<typeof makeFrozenTestGateway>;
const ownedDirectories: Array<{ cleanup(): void }> = [];
const journalDirectories = new WeakMap<FrozenPublicChatOperationJournal, string>();

function testJournal(prefix: string): FrozenPublicChatOperationJournal {
  const directory = makeTempDir(prefix);
  ownedDirectories.push(directory);
  const journal = new FrozenPublicChatOperationJournal(directory.directory);
  journalDirectories.set(journal, directory.directory);
  return journal;
}

afterEach(() => {
  for (const directory of ownedDirectories.splice(0)) directory.cleanup();
});

async function makeReadyController(fixture: Fixture, startedAt: number, bounds = BOUNDS,
  journal = testJournal('frozen-controller')) {
  const controller = new PublicChatSendController({ deployment: FROZEN_TEST_DEPLOYMENT, gateway: fixture.gateway, journal, bounds });
  controller.advanceInputConnection();
  controller.setLiveEpoch(TEST_LIVE_EPOCH, startedAt);
  expect((await controller.refreshQualification()).ok).toBe(true);
  expect((await controller.authorize()).ok).toBe(true);
  return { controller, journal };
}

function fixture() {
  const startedAt = Date.now() - 1000;
  return { startedAt, gateway: makeFrozenTestGateway(startedAt) };
}

describe('frozen HTTP submit and dispatch', () => {
  it('persists dispatching and the complete original binding before the sender call', async () => {
    const { startedAt, gateway } = fixture();
    const { controller, journal } = await makeReadyController(gateway, startedAt);
    const directory = journalDirectories.get(journal)!;
    gateway.setSend(async (request) => {
      const disk = JSON.parse(fs.readFileSync(join(directory, 'public-chat-operations.json'), 'utf8'));
      expect(disk.records.find((record: { requestId: string }) => record.requestId === request.requestId).state).toBe('dispatching');
      expect(request.grant.principalUid).toBe(TEST_PRINCIPAL_UID);
      expect(request.grant.roomId).toBe(TEST_ROOM_ID);
      expect(request.grant.senderConnectionGeneration).toBe(4);
      expect(request.text).toBe('大家好');
      return { ok: true, value: successfulOperation(request) };
    });
    expect((await controller.submit({ requestId: 'req-1', sourceKey: 'sk-1', text: '大家好' })).status).toBe('accepted');
    await waitFor(() => controller.frozenOperationView('req-1')?.state === 'api_reported_success');
    expect(controller.frozenOperationView('req-1')?.textDigest).toBe(digestOf('大家好'));
    expect(fs.readFileSync(join(directory, 'public-chat-operations.json'), 'utf8')).not.toContain('大家好');
  });

  it('keeps a written unknown on hold and rejects a new action', async () => {
    const { startedAt, gateway } = fixture();
    gateway.setSend(async (request) => ({ ok: true, value: { ...successfulOperation(request), state: 'unknown' } }));
    const { controller } = await makeReadyController(gateway, startedAt);
    await controller.submit({ requestId: 'req-1', sourceKey: null, text: '大家好' });
    await waitFor(() => controller.frozenOperationView('req-1')?.state === 'unknown');
    expect(controller.hold).toBe(true);
    expect((await controller.submit({ requestId: 'req-2', sourceKey: null, text: '第二条' })).status).toBe('rejected');
  });

  it('does not treat an untrusted sender failure as proof of never writing', async () => {
    const { startedAt, gateway } = fixture();
    gateway.setSend(async () => ({ ok: false, error: 'untrusted terminal', untrusted: true }));
    const { controller } = await makeReadyController(gateway, startedAt);
    await controller.submit({ requestId: 'req-1', sourceKey: null, text: '第一条' });
    await waitFor(() => controller.frozenOperationView('req-1')?.state === 'unknown');
    expect(controller.hold).toBe(true);
    expect(controller.frozenOperationView('req-1')?.terminalEvidence).toBeNull();
  });

  it('retains the original request and source when the transport fails', async () => {
    const { startedAt, gateway } = fixture();
    gateway.setSend(async () => ({ ok: false, error: 'timeout', untrusted: false }));
    const { controller } = await makeReadyController(gateway, startedAt);
    await controller.submit({ requestId: 'req-1', sourceKey: 'sk-1', text: '第一条' });
    await waitFor(() => controller.frozenOperationView('req-1')?.state === 'unknown');
    expect((await controller.submit({ requestId: 'req-1', sourceKey: null, text: '第一条' })).status).toBe('duplicate');
    expect((await controller.submit({ requestId: 'req-9', sourceKey: 'sk-1', text: '另一条' })).status).toBe('duplicate');
    expect(gateway.calls.sends).toHaveLength(1);
  });

  it('accepts at most ten queued or in-flight operations', async () => {
    const { startedAt, gateway } = fixture();
    let release!: () => void;
    gateway.setSend(async (request) => {
      await new Promise<void>((done) => { release = done; });
      return { ok: true, value: { ...successfulOperation(request), state: 'unknown' } };
    });
    const { controller } = await makeReadyController(gateway, startedAt);
    for (let index = 0; index < 10; index++) {
      expect((await controller.submit({ requestId: `req-${index}`, sourceKey: null, text: `第${index}条` })).status).toBe('accepted');
    }
    expect(await controller.submit({ requestId: 'overflow', sourceKey: null, text: '溢出' })).toMatchObject({ status: 'rejected', reason: 'queue-full' });
    release();
    await waitFor(() => controller.frozenOperationView('req-0')?.state === 'unknown');
    expect(gateway.calls.sends).toHaveLength(1);
  });

  it('cancels an expired queued operation without dispatch', async () => {
    const { startedAt, gateway } = fixture();
    gateway.setSend(async (request) => {
      await new Promise((done) => setTimeout(done, 120));
      return { ok: true, value: successfulOperation(request) };
    });
    const { controller } = await makeReadyController(gateway, startedAt, { ...BOUNDS, queueWaitMs: 40 });
    await controller.submit({ requestId: 'first', sourceKey: null, text: '第一条' });
    await controller.submit({ requestId: 'expired', sourceKey: null, text: '第二条' });
    await waitFor(() => controller.frozenOperationView('expired')?.state === 'cancelled_before_dispatch');
    expect(gateway.calls.sends).toHaveLength(1);
  });

  it('serializes sends and respects the dispatch interval', async () => {
    const { startedAt, gateway } = fixture();
    const times: number[] = [];
    let active = 0;
    gateway.setSend(async (request) => {
      expect(active++).toBe(0);
      times.push(Date.now());
      await new Promise((done) => setTimeout(done, 10));
      active--;
      return { ok: true, value: successfulOperation(request) };
    });
    const { controller } = await makeReadyController(gateway, startedAt, { ...BOUNDS, dispatchIntervalMs: 100 });
    await controller.submit({ requestId: 'first', sourceKey: null, text: '第一条' });
    await controller.submit({ requestId: 'second', sourceKey: null, text: '第二条' });
    await waitFor(() => times.length === 2);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(90);
    await waitFor(() => controller.frozenOperationView('second')?.state === 'api_reported_success');
  });

  it('revocation cancels a queued original without sending it', async () => {
    const { startedAt, gateway } = fixture();
    let release!: () => void;
    gateway.setSend(async (request) => {
      await new Promise<void>((done) => { release = done; });
      return { ok: true, value: successfulOperation(request) };
    });
    const { controller } = await makeReadyController(gateway, startedAt);
    await controller.submit({ requestId: 'first', sourceKey: null, text: '第一条' });
    await controller.submit({ requestId: 'second', sourceKey: null, text: '第二条' });
    controller.revokeGrant('owner-revoke');
    release();
    await waitFor(() => controller.frozenOperationView('second')?.state === 'cancelled_before_dispatch');
    await waitFor(() => controller.frozenOperationView('first')?.state === 'api_reported_success');
    expect(gateway.calls.sends).toHaveLength(1);
  });

  it('adopts the original authorization and capture revocations explicitly after restart', async () => {
    const { startedAt, gateway } = fixture();
    const { controller, journal } = await makeReadyController(gateway, startedAt);
    const directory = journalDirectories.get(journal)!;
    controller.revokeGrant('owner-revoke');
    await waitFor(() => journal.controls.filter((entry) => entry.kind === 'revoke' && entry.state === 'revoked').length === 2);
    expect(controller.hold).toBe(false);
    const restored = new FrozenPublicChatOperationJournal(directory);
    expect(restored.corrupt).toBe(false);
    const restarted = new PublicChatSendController({ deployment: FROZEN_TEST_DEPLOYMENT, gateway: gateway.gateway, journal: restored, bounds: BOUNDS });
    expect(restarted.hold).toBe(true);
    const terminalIds = restored.controls.filter((entry) => entry.kind !== 'message_reconcile').map((entry) => entry.id);
    for (const [index, id] of terminalIds.entries()) {
      expect((await restarted.reconcileControl(id)).ok).toBe(true);
      expect(restarted.hold).toBe(index !== terminalIds.length - 1);
    }
    expect(gateway.calls.sends).toHaveLength(0);
    expect(gateway.calls.revocations).toHaveLength(2);
  });

  it.each(['write', 'rename', 'fsync', 'close'] as const)(
    'keeps control adoption held across restart after %s fails', async (failure) => {
      const { startedAt, gateway } = fixture();
      const { controller, journal } = await makeReadyController(gateway, startedAt);
      const directory = journalDirectories.get(journal)!;
      controller.revokeGrant('owner-revoke');
      await waitFor(() => journal.controls.filter((entry) => entry.kind === 'revoke' && entry.state === 'revoked').length === 2);
      let inject = false;
      let renamed = false;
      const io = new Proxy(fs, { get(target, key) {
        if (key === 'writeFileSync') return (...args: Parameters<typeof fs.writeFileSync>) => {
          if (inject && failure === 'write') throw new Error('fixture write failure');
          return fs.writeFileSync(...args);
        };
        if (key === 'renameSync') return (...args: Parameters<typeof fs.renameSync>) => {
          if (inject && failure === 'rename') throw new Error('fixture rename failure');
          fs.renameSync(...args);
          if (inject) renamed = true;
        };
        if (key === 'fsyncSync') return (fd: number) => {
          if (inject && renamed && failure === 'fsync' && fs.fstatSync(fd).isDirectory()) throw new Error('fixture fsync failure');
          return fs.fsyncSync(fd);
        };
        if (key === 'closeSync') return (fd: number) => {
          const fail = inject && renamed && failure === 'close' && fs.fstatSync(fd).isDirectory();
          fs.closeSync(fd);
          if (fail) throw new Error('fixture close failure');
        };
        return Reflect.get(target, key);
      } }) as typeof fs;
      const failingJournal = new FrozenPublicChatOperationJournal(directory, io);
      const failing = new PublicChatSendController({ deployment: FROZEN_TEST_DEPLOYMENT, gateway: gateway.gateway, journal: failingJournal, bounds: BOUNDS });
      const id = failingJournal.controls.find((entry) => entry.kind === 'revoke' && entry.target.kind === 'capture')?.id;
      if (!id) throw new Error('capture revoke missing');
      inject = true;
      expect((await failing.reconcileControl(id)).ok).toBe(false);
      expect(failing.hold).toBe(true);
      const restored = new FrozenPublicChatOperationJournal(directory);
      expect(restored.corrupt).toBe(false);
      const restarted = new PublicChatSendController({ deployment: FROZEN_TEST_DEPLOYMENT, gateway: gateway.gateway, journal: restored, bounds: BOUNDS });
      expect(restarted.hold).toBe(true);
      for (const control of restored.controls) expect((await restarted.reconcileControl(control.id)).ok).toBe(true);
      expect(restarted.hold).toBe(false);
      expect(gateway.calls.sends).toHaveLength(0);
    },
  );

  it('holds after a revoke ACK rename succeeds but directory fsync fails', async () => {
    const { startedAt, gateway } = fixture();
    const directory = makeTempDir('frozen-revoke-ack-failure');
    ownedDirectories.push(directory);
    let inject = false;
    let renamed = false;
    let failed = false;
    const io = new Proxy(fs, { get(target, key) {
      if (key === 'renameSync') return (...args: Parameters<typeof fs.renameSync>) => {
        fs.renameSync(...args);
        if (inject) renamed = true;
      };
      if (key === 'fsyncSync') return (fd: number) => {
        if (inject && renamed && !failed && fs.fstatSync(fd).isDirectory()) {
          failed = true;
          throw new Error('fixture revoke ACK fsync failure');
        }
        return fs.fsyncSync(fd);
      };
      return Reflect.get(target, key);
    } }) as typeof fs;
    const journal = new FrozenPublicChatOperationJournal(directory.directory, io);
    const { controller } = await makeReadyController(gateway, startedAt, BOUNDS, journal);
    const originalRevoke = gateway.gateway.frozenRevoke.bind(gateway.gateway);
    const releases: Array<() => void> = [];
    gateway.gateway.frozenRevoke = async (request) => {
      const result = await originalRevoke(request);
      await new Promise<void>((done) => releases.push(done));
      return result;
    };
    controller.revokeGrant('owner-revoke');
    await waitFor(() => releases.length === 2);
    inject = true;
    releases[0]();
    await waitFor(() => failed);
    expect(controller.hold).toBe(true);
    releases[1]();
    await waitFor(() => journal.controls.filter((entry) => entry.kind === 'revoke' &&
      ['revoked', 'revoking_unknown'].includes(entry.state)).length === 2);
    const restored = new FrozenPublicChatOperationJournal(directory.directory);
    expect(restored.corrupt).toBe(false);
    const restarted = new PublicChatSendController({ deployment: FROZEN_TEST_DEPLOYMENT, gateway: gateway.gateway, journal: restored, bounds: BOUNDS });
    expect(restarted.hold).toBe(true);
    expect(gateway.calls.sends).toHaveLength(0);
  });

  it.each(['missing-ack', 'sender-nonce', 'helper-hash', 'holder'] as const)(
    'rejects persisted terminal control evidence with %s mismatch', async (tamper) => {
      const { startedAt, gateway } = fixture();
      const { controller, journal } = await makeReadyController(gateway, startedAt);
      const directory = journalDirectories.get(journal)!;
      controller.revokeGrant('owner-revoke');
      await waitFor(() => journal.controls.filter((entry) => entry.kind === 'revoke' && entry.state === 'revoked').length === 2);
      const file = join(directory, 'public-chat-operations.json');
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const capture = data.controls.find((entry: { kind: string }) => entry.kind === 'capture');
      const revoke = data.controls.find((entry: { kind: string; target?: { kind: string } }) =>
        entry.kind === 'revoke' && entry.target?.kind === 'capture');
      if (tamper === 'missing-ack') revoke.ack = null;
      if (tamper === 'sender-nonce') revoke.ack.senderProcessNonce = 'different-sender';
      if (tamper === 'helper-hash') revoke.ack.helperPayloadHash = '0'.repeat(64);
      if (tamper === 'holder') capture.helperNonce = 'different-helper';
      const bytes = Buffer.from(JSON.stringify(data));
      fs.writeFileSync(file, bytes);
      const restored = new FrozenPublicChatOperationJournal(directory);
      expect(restored.corrupt).toBe(true);
      expect(fs.readFileSync(file)).toEqual(bytes);
      const restarted = new PublicChatSendController({ deployment: FROZEN_TEST_DEPLOYMENT, gateway: gateway.gateway, journal: restored, bounds: BOUNDS });
      expect(restarted.hold).toBe(true);
      expect(gateway.calls.sends).toHaveLength(0);
    },
  );

  it('keeps a journal failure on hold and makes no sender call', async () => {
    const { startedAt, gateway } = fixture();
    const journal = testJournal('frozen-write-fail');
    const { controller } = await makeReadyController(gateway, startedAt, BOUNDS, journal);
    const originalWrite = journal.write.bind(journal);
    journal.write = () => {
      if (journal.records.some((record) => record.state === 'dispatching')) throw new Error('fixture disk failure');
      originalWrite();
    };
    expect((await controller.submit({ requestId: 'req-1', sourceKey: null, text: '第一条' })).status).toBe('accepted');
    expect(controller.hold).toBe(true);
    expect(gateway.calls.sends).toHaveLength(0);
  });
});

describe('qualification and event revisions', () => {
  it('persists a rejected authorization and requires original-ID adoption after restart', async () => {
    const { startedAt, gateway } = fixture();
    gateway.gateway.frozenAuthorize = async (request) => ({ ok: true, value: {
      kind: 'authorize', id: request.authorizationId, senderProcessNonce: request.expectedSenderProcessNonce,
      payloadHash: controlPayloadHash(request), helperPayloadHash: controlPayloadHash(request.target),
      state: 'rejected', target: request.target,
    } });
    const journal = testJournal('frozen-rejected');
    const directory = journalDirectories.get(journal)!;
    const controller = new PublicChatSendController({ deployment: FROZEN_TEST_DEPLOYMENT, gateway: gateway.gateway, journal, bounds: BOUNDS });
    controller.advanceInputConnection();
    controller.setLiveEpoch(TEST_LIVE_EPOCH, startedAt);
    expect((await controller.refreshQualification()).ok).toBe(true);
    expect(await controller.authorize()).toMatchObject({ ok: false, reason: 'rejected' });
    controller.revokeGrant('owner-revoke');
    await waitFor(() => journal.controls.some((entry) => entry.kind === 'revoke' && entry.state === 'revoked'));
    expect(controller.hold).toBe(false);
    const restored = new FrozenPublicChatOperationJournal(directory);
    expect(restored.corrupt).toBe(false);
    const restarted = new PublicChatSendController({ deployment: FROZEN_TEST_DEPLOYMENT, gateway: gateway.gateway, journal: restored, bounds: BOUNDS });
    expect(restarted.hold).toBe(true);
    for (const control of restored.controls) expect((await restarted.reconcileControl(control.id)).ok).toBe(true);
    expect(restarted.hold).toBe(false);
    expect(gateway.calls.sends).toHaveLength(0);
  });

  it('does not publish a qualification after the local revision changed', async () => {
    const { startedAt, gateway } = fixture();
    const original = gateway.gateway.frozenCapture.bind(gateway.gateway);
    let release!: () => void;
    gateway.gateway.frozenCapture = async (...args) => {
      await new Promise<void>((done) => { release = done; });
      return original(...args);
    };
    const journal = testJournal('frozen-stale');
    const controller = new PublicChatSendController({ deployment: FROZEN_TEST_DEPLOYMENT, gateway: gateway.gateway, journal, bounds: BOUNDS });
    controller.advanceInputConnection();
    controller.setLiveEpoch(TEST_LIVE_EPOCH, startedAt);
    const pending = controller.refreshQualification();
    await waitFor(() => typeof release === 'function');
    controller.advanceRevision();
    release();
    expect(await pending).toMatchObject({ ok: false, reason: 'stale-response' });
    expect((await controller.authorize()).ok).toBe(false);
  });

  it('rejects simulated events and permits only current source metadata', async () => {
    const { startedAt, gateway } = fixture();
    const { controller } = await makeReadyController(gateway, startedAt);
    expect(await controller.submit({ requestId: 'simulated', sourceKey: null, text: '自动回复',
      autoEvent: { event: {}, rawId: 'raw-1', rawType: 'chat' } })).toMatchObject({ status: 'rejected', reason: 'unavailable:no-metadata' });
    const event = {};
    controller.setCurrentSourceConnectionToken('current');
    registerSourceEventMetadata(event, { rawId: 'raw-1', rawType: 'chat', rawFrameTsUntrusted: null, receivedAt: Date.now(),
      sourceConnectionToken: 'current', roomId: TEST_ROOM_ID, liveEpoch: TEST_LIVE_EPOCH });
    expect((await controller.submit({ requestId: 'real', sourceKey: null, text: '自动回复',
      autoEvent: { event, rawId: 'raw-1', rawType: 'chat' } })).status).toBe('accepted');
    await waitFor(() => gateway.calls.sends.length === 1);
  });
});

describe('settings patch boundary', () => {
  it('defaults to disabled and rejects account, room and URL fields', () => {
    expect(DEFAULT_PUBLIC_CHAT_SETTINGS.enabled).toBe(false);
    expect(applySettingsPatch(DEFAULT_PUBLIC_CHAT_SETTINGS, { principalUid: TEST_PRINCIPAL_UID }).ok).toBe(false);
    expect(applySettingsPatch(DEFAULT_PUBLIC_CHAT_SETTINGS, { senderUrl: 'http://127.0.0.1:9' }).ok).toBe(false);
    expect(applySettingsPatch(DEFAULT_PUBLIC_CHAT_SETTINGS, { douyinRoomId: TEST_ROOM_ID }).ok).toBe(false);
    const valid = applySettingsPatch(DEFAULT_PUBLIC_CHAT_SETTINGS, { enabled: true, drafts: { manual: '普通文字' } });
    expect(valid.ok).toBe(true);
    if (valid.ok) expect(valid.next.drafts.manual).toBe('普通文字');
  });
});
