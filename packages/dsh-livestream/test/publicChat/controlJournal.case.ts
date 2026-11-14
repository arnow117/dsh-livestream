import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PublicChatOperationJournal } from '../../src/publicChat/journal';
import { FrozenPublicChatOperationJournal } from '../../src/publicChat/frozenJournal';
import { PublicChatSendController } from '../../src/publicChat/controller';
import type { SenderClient } from '../../src/publicChat/senderClient';
import { makeFakeGateway, TEST_ACCOUNT_RECORD_ID, TEST_BUILD_DIGEST, TEST_INSTANCE_ID, TEST_PRINCIPAL_UID, TEST_ROOM_ID } from './test-helpers';

describe('control journal recovery', () => {
  it('rejects the old schema while preserving its bytes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'public-chat-old-schema-'));
    try {
      const file = join(dir, 'public-chat-operations.json');
      const original = '{"schemaVersion":1,"records":[]}';
      writeFileSync(file, original, { mode: 0o600 });
      const journal = new PublicChatOperationJournal(dir);
      expect(journal.corrupt).toBe(true);
      expect(readFileSync(file, 'utf8')).toBe(original);
    } finally { rmSync(dir, { recursive: true, force: false }); }
  });

  it('holds a persisted unresolved authorization after restart without restoring a grant', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'public-chat-control-restart-'));
    try {
      const journal = new PublicChatOperationJournal(dir);
      journal.controls.push({ kind: 'authorize', id: 'auth-original', payloadHash: 'c'.repeat(64), senderProcessNonce: 'sender-nonce-1', localRevision: 'l-original', state: 'authorizing_unknown', grant: null,
        target: { version: 'dsh-public-chat-v1', buildDigest: TEST_BUILD_DIGEST, instanceId: TEST_INSTANCE_ID, senderProcessNonce: 'sender-nonce-1', captureId: 'capture', qualificationDigest: 'd'.repeat(64), qualificationRevision: 7, accountRecordId: TEST_ACCOUNT_RECORD_ID, principalUid: TEST_PRINCIPAL_UID, roomId: TEST_ROOM_ID, browserContextId: 'context', senderSessionId: 'session', senderConnectionGeneration: 4, identityEpoch: 7, authCookieGeneration: 3, liveEpoch: 'live', liveEpochStartedAtMs: 1000, inputConnectionGeneration: 1 } });
      journal.write();
      const restored = new PublicChatOperationJournal(dir);
      expect(restored.corrupt).toBe(false);
      const controller = new PublicChatSendController({ deployment: { buildDigest: TEST_BUILD_DIGEST, instanceId: TEST_INSTANCE_ID, expectedPrincipalUid: TEST_PRINCIPAL_UID, roomId: TEST_ROOM_ID, accountRecordId: TEST_ACCOUNT_RECORD_ID }, gateway: makeFakeGateway({ sendResults: [] }), journal: restored });
      expect(controller.hold).toBe(true);
      expect(controller.grants.active).toBeNull();
      expect((await controller.refreshQualification()).ok).toBe(false);
      expect((await controller.submit({ requestId: 'new', sourceKey: null, text: '大家好' })).status).toBe('rejected');
    } finally { rmSync(dir, { recursive: true, force: false }); }
  });
});

describe('unregistered control responses', () => {
  it.each([400, 409, 503])('keeps authorization held after HTTP %i and not_found', async (status) => {
    const { SenderClient } = await import('../../src/publicChat/senderClient');
    const dir = mkdtempSync(join(tmpdir(), 'public-chat-control-http-'));
    try {
      const client = new SenderClient({ url: 'http://127.0.0.1:19999', token: 'fixture-token', expected: { buildDigest: TEST_BUILD_DIGEST, instanceId: TEST_INSTANCE_ID }, fetcher: async (_input, init) => {
        const body = init?.method === 'GET'
          ? { protocol: 'dsh-public-chat-v1', buildDigest: TEST_BUILD_DIGEST, instanceId: TEST_INSTANCE_ID, found: false }
          : { protocol: 'dsh-public-chat-v1', buildDigest: TEST_BUILD_DIGEST, instanceId: TEST_INSTANCE_ID, error: 'fixture rejected without registration' };
        return new Response(JSON.stringify(body), { status: init?.method === 'GET' ? 200 : status, headers: { 'content-type': 'application/json' } });
      } });
      const startedAt = Date.now() - 1000;
      const helper = { helperNonce: 'helper', authContextId: 'context', authContextRevision: 1, materialDigest: 'a'.repeat(64) };
      const raw = { sessionId: 'session', contextId: 'raw-context', generation: 1,
        proof: { webRoomId: TEST_ROOM_ID, platformRoomId: '202', liveEpoch: 'live', digest: 'b'.repeat(64) } };
      const state = { buildDigest: TEST_BUILD_DIGEST, instanceId: TEST_INSTANCE_ID, processNonce: 'sender',
        senderConnectionGeneration: 1, hold: false, helper, raw };
      const gateway = {
        frozenState: async () => ({ ok: true as const, value: state }),
        frozenCapture: async (captureId: string) => ({ ok: true as const, value: {
          senderConnectionGeneration: 1, helper, raw,
          record: { state: 'qualified', qualification: { captureId, qualificationToken: 'qualification',
            qualificationDigest: 'c'.repeat(64), qualificationRevision: 1, identityEpoch: 1,
            principalUid: TEST_PRINCIPAL_UID, capturedAtMs: Date.now() } },
        } }),
        frozenAuthorize: client.frozenAuthorize.bind(client),
        frozenControlOperation: client.frozenControlOperation.bind(client),
        frozenRevoke: async () => ({ ok: false as const, error: 'unused', untrusted: true }),
        frozenSend: async () => ({ ok: false as const, error: 'unused', untrusted: true }),
        frozenOperation: async () => ({ ok: false as const, error: 'unused', untrusted: true }),
        frozenReconcileMessage: async () => ({ ok: false as const, error: 'unused', untrusted: true }),
        frozenRecoveryOperation: async () => ({ ok: false as const, error: 'unused', untrusted: true }),
      } as unknown as SenderClient;
      const journal = new FrozenPublicChatOperationJournal(dir);
      const controller = new PublicChatSendController({ deployment: { buildDigest: TEST_BUILD_DIGEST, instanceId: TEST_INSTANCE_ID, expectedPrincipalUid: TEST_PRINCIPAL_UID, roomId: TEST_ROOM_ID, accountRecordId: TEST_ACCOUNT_RECORD_ID }, gateway, journal });
      controller.advanceInputConnection();
      controller.setLiveEpoch('live', startedAt);
      expect((await controller.refreshQualification()).ok).toBe(true);
      expect((await controller.authorize()).reason).toBe('authorizing-unknown');
      const original = journal.controls.find((item) => item.kind === 'authorize');
      if (!original) throw new Error('missing control');
      expect((await controller.reconcileControl(original.id)).ok).toBe(false);
      expect(controller.hold).toBe(true);
      expect((await controller.authorize()).ok).toBe(false);
      expect(journal.controls.filter((item) => item.kind === 'authorize')).toHaveLength(1);
    } finally { rmSync(dir, { recursive: true, force: false }); }
  });
});
