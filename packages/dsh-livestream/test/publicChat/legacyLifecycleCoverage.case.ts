/** Legacy sender/controller compatibility checks; this fixture is not the production helper. */
import { describe, expect, it } from 'vitest';
import { PublicChatSendController, type SenderGateway } from '../../src/publicChat/controller';
import { PublicChatOperationJournal } from '../../src/publicChat/journal';
import { SenderRuntime, type SenderRuntimePort } from '../../src/publicChat/senderRuntime';
import type { ChatSessionPort } from '../../src/publicChat/guardedSend';
import type { SendRequestWire } from '../../src/publicChat/protocol';
import { TEST_ACCOUNT_RECORD_ID, TEST_BUILD_DIGEST, TEST_COOKIE_DIGEST, TEST_INSTANCE_ID,
  TEST_LIVE_EPOCH, TEST_PRINCIPAL_UID, TEST_ROOM_ID, makeTempDir, waitFor } from './test-helpers';

const deployment = {
  buildDigest: TEST_BUILD_DIGEST, instanceId: TEST_INSTANCE_ID,
  expectedPrincipalUid: TEST_PRINCIPAL_UID, roomId: TEST_ROOM_ID,
  accountRecordId: TEST_ACCOUNT_RECORD_ID, profileOrigin: 'https://www.douyin.com',
};

function setup(mode: 'success' | 'before-enter' | 'after-enter' | 'revoke' | 'residual' | 'no-port' | 'no-queue' = 'success') {
  const dir = makeTempDir('legacy-lifecycle');
  const calls: string[] = [];
  const requests: SendRequestWire[] = [];
  let runtime: SenderRuntime;
  const page: ChatSessionPort = {
    wait: async () => {},
    waitForInput: async () => { if (mode === 'before-enter') throw new Error('input unavailable'); },
    clickInput: async () => {},
    clearInput: async () => {},
    insertText: async () => { if (mode === 'revoke') runtime.revoke('owner-revoke'); },
    pressEnter: async () => {
      calls.push('enter');
      if (mode === 'after-enter') throw new Error('lost response');
    },
    readInputText: async () => mode === 'residual' ? 'unsent text' : '',
  };
  const port: SenderRuntimePort = {
    currentSession: () => ({ sessionId: 'session-1', contextId: 'ctx-1', roomId: TEST_ROOM_ID }),
    currentSessionPageUrl: () => `https://live.douyin.com/${TEST_ROOM_ID}`,
    authCookieDigest: async () => ({ digest: TEST_COOKIE_DIGEST, generation: 3 }),
    captureProfile: async () => ({
      finalUrl: 'https://www.douyin.com/aweme/v1/web/user/profile/self/?aid=6383', httpStatus: 200,
      bodyText: JSON.stringify({ status_code: 0, data: { user: { id_str: TEST_PRINCIPAL_UID } } }),
      pageUrl: `https://live.douyin.com/${TEST_ROOM_ID}`, contextId: 'ctx-1', sessionId: 'session-1',
      authCookieDigest: TEST_COOKIE_DIGEST, authCookieGeneration: 3, capturedAt: Date.now(),
    }),
    sendPort: () => mode === 'no-port' ? null : page,
    enqueueControlledSend: (_session, run) => mode === 'no-queue' ? null : run(),
  };
  runtime = new SenderRuntime({ deployment, port });
  runtime.notifySessionEstablished({ sessionId: 'session-1', contextId: 'ctx-1', roomId: TEST_ROOM_ID });
  runtime.notifyConnectionChange(true);
  const gateway: SenderGateway = {
    state: async () => ({ ok: true, value: { ...runtime.state(), privateProtocol: 'dsh-public-chat-http-v1',
      capabilities: ['explicit-grant-snapshot-v1', 'frozen-http-auth-v1', 'no-replay-http1-v1'] } }),
    qualification: async (id, nonce) => ({ ok: true, value: await runtime.captureQualification(id!, nonce!) }),
    authorizeGrant: async (request) => {
      const result = await runtime.authorizeGrant(request);
      return result.registered ? { ok: true, value: result.record } : { ok: false, error: result.reason, untrusted: false };
    },
    revokeControl: async (request) => {
      const result = runtime.revokeControl(request);
      return result.registered ? { ok: true, value: result.record } : { ok: false, error: result.reason, untrusted: false };
    },
    controlOperation: async (id) => {
      const result = runtime.controlOperation(id);
      return result ? { ok: true, value: result } : { ok: false, error: 'not found', untrusted: false };
    },
    revokeGrant: async (reason) => ({ ok: true, value: runtime.revoke(reason) }),
    send: async (request) => {
      requests.push(request);
      calls.push('send');
      return { ok: true, value: await runtime.send(request) };
    },
    operation: async (id) => ({ ok: true, value: runtime.operation(id) }),
  };
  const journal = new PublicChatOperationJournal(dir.directory);
  const controller = new PublicChatSendController({ deployment, gateway, journal, bounds: { dispatchIntervalMs: 0 } });
  controller.setLiveEpoch(TEST_LIVE_EPOCH, Date.now() - 1000);
  return { controller, runtime, gateway, calls, requests, journal, cleanup: dir.cleanup };
}

async function authorize(f: ReturnType<typeof setup>) {
  expect(await f.controller.refreshQualification()).toEqual({ ok: true, reason: 'ok' });
  expect((await f.controller.authorize()).ok).toBe(true);
}

describe('legacy sender lifecycle compatibility', () => {
  it('requires authorization and deduplicates original request and source', async () => {
    const f = setup();
    try {
      expect((await f.controller.submit({ requestId: 'early', sourceKey: 'early', text: 'hello' })).status).toBe('rejected');
      expect(f.calls).toEqual([]);
      await authorize(f);
      const input = { requestId: 'first', sourceKey: 'source', text: 'hello' };
      expect((await f.controller.submit(input)).status).toBe('accepted');
      await waitFor(() => f.controller.operationView('first')?.outcome !== null);
      expect(f.controller.operationView('first')).toMatchObject({ outcome: 'unknown', pageSubmitted: true });
      expect(f.controller.hold).toBe(true);
      expect((await f.controller.submit(input)).status).toBe('duplicate');
      expect((await f.controller.submit({ ...input, requestId: 'other' })).status).toBe('duplicate');
      expect(f.calls).toEqual(['send', 'enter']);
    } finally { f.cleanup(); }
  });

  it.each(['before-enter', 'revoke', 'no-port', 'no-queue'] as const)('records a terminated send without Enter after %s', async (mode) => {
    const f = setup(mode);
    try {
      await authorize(f);
      expect((await f.controller.submit({ requestId: 'first', sourceKey: 'source', text: 'hello' })).status).toBe('accepted');
      await waitFor(() => f.controller.operationView('first')?.outcome !== null);
      expect(f.controller.operationView('first')?.outcome).toBe('terminal_not_dispatched');
      expect(f.calls).toEqual(['send']);
      expect(f.runtime.operation('first')).toMatchObject({ found: true, executionTerminated: true, enterNeverCalled: true });
    } finally { f.cleanup(); }
  });

  it('returns the original sender outcome for duplicate requests and rejects conflicting payloads', async () => {
    const f = setup();
    try {
      await authorize(f);
      await f.controller.submit({ requestId: 'first', sourceKey: 'source', text: 'hello' });
      await waitFor(() => f.controller.operationView('first')?.outcome !== null);
      const original = f.requests[0];
      expect(await f.runtime.send(original)).toMatchObject({ status: 'dispatched', pageSubmitted: true });
      expect(await f.runtime.send({ ...original, text: 'different' })).toEqual({ status: 'rejected', reason: 'request-id-conflict' });
      expect(await f.runtime.send({ ...original, requestId: 'another' })).toEqual({ status: 'rejected', reason: 'source-already-used' });
      expect(f.calls).toEqual(['send', 'enter']);
    } finally { f.cleanup(); }
  });

  it('treats remaining page input after Enter as uncertain and refuses further sends', async () => {
    const f = setup('residual');
    try {
      await authorize(f);
      await f.controller.submit({ requestId: 'first', sourceKey: 'source', text: 'hello' });
      await waitFor(() => f.controller.operationView('first')?.outcome !== null);
      expect(f.controller.operationView('first')).toMatchObject({ outcome: 'unknown', pageSubmitted: false });
      expect(f.controller.hold).toBe(true);
      expect((await f.controller.submit({ requestId: 'new', sourceKey: 'new', text: 'hello' })).status).toBe('rejected');
      expect(f.calls).toEqual(['send', 'enter']);
    } finally { f.cleanup(); }
  });

  it('keeps the original result after Enter fails and never sends the duplicate', async () => {
    const f = setup('after-enter');
    try {
      await authorize(f);
      const input = { requestId: 'first', sourceKey: 'source', text: 'hello' };
      await f.controller.submit(input);
      await waitFor(() => f.controller.operationView('first')?.outcome !== null);
      expect(f.runtime.operation('first')).toMatchObject({ found: true, enterAttempted: true, pageSubmitted: false });
      expect((await f.controller.submit(input)).status).toBe('duplicate');
      expect(f.calls).toEqual(['send', 'enter']);
    } finally { f.cleanup(); }
  });
});
