import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FrozenSenderRuntime } from '../../src/publicChat/frozenSenderRuntime';
import { SenderService } from '../../src/publicChat/senderService';
import { SenderClient } from '../../src/publicChat/senderClient';
import { PublicChatSendController } from '../../src/publicChat/controller';
import { FrozenPublicChatOperationJournal } from '../../src/publicChat/frozenJournal';
import { PublicChatInputBinding } from '../../src/publicChat/inputBinding';
import { createPublicChatReplyTool } from '../../src/publicChat/agentReplyTool';
import { HelperProcess } from '../../src/publicChat/helperLauncher';

function varint(input: bigint): number[] {
  const bytes: number[] = [];
  let value = input;
  do {
    const low = Number(value & 127n);
    value >>= 7n;
    bytes.push(low | (value ? 128 : 0));
  } while (value);
  return bytes;
}

function chatPayload(room: bigint, when: number): Uint8Array {
  const common = [0x18, ...varint(room), 0x20, ...varint(BigInt(when))];
  return Uint8Array.from([0x0a, ...varint(BigInt(common.length)), ...common, 0x1a, 0x02, 0x68, 0x69]);
}

async function until<T>(get: () => Promise<T>, accept: (value: T) => boolean, limitMs = 8000): Promise<T> {
  const end = Date.now() + limitMs;
  for (;;) {
    const value = await get();
    if (accept(value)) return value;
    if (Date.now() > end) throw new Error('fixture condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

describe('session composition with Go test fixture', () => {
  it.each(['success', 'lost-response'] as const)('retains a single controlled HTTP write: %s', async (scenario) => {
    const binary = process.env.DSH_SESSION_FIXTURE_BINARY;
    const qr = process.env.DSH_QR_FIXTURE;
    const bundle = process.env.DSH_SENDER_FIXTURE_BUNDLE;
    const testRoot = process.env.DSH_HOME;
    if (!binary || !qr || !bundle || !testRoot) throw new Error('task-owned fixture paths required');
    const { decodeFixedRaw } = await import(/* @vite-ignore */ pathToFileURL(bundle).href) as { decodeFixedRaw: (message: unknown) => any };
    const directory = mkdtempSync(join(testRoot, 'session-composition-'));
    const countPath = join(directory, 'chat-count.json');
    const deployment = { buildDigest: 'a'.repeat(64), instanceId: 'fixture-instance', accountRecordId: 'fixture-account',
      expectedPrincipalUid: null as string | null, transportKind: 'session_http' as const, roomId: '12345' };
    let helper: HelperProcess | null = null;
    let controller: PublicChatSendController | null = null;
    let runtime!: FrozenSenderRuntime;
    runtime = new FrozenSenderRuntime({ deployment, decodeRaw: decodeFixedRaw,
      onInvalidated: () => controller?.revokeGrant('sender-connection-change'),
      launch: async () => {
        const child = spawn(binary, ['-test.run=^TestSessionFixtureServer$', '-test.timeout=30s'], {
          cwd: directory, env: { DSH_SESSION_FIXTURE:'1', DSH_QR_FIXTURE:qr, DSH_CHAT_COUNT_FILE:countPath,
            DSH_DROP_SYNTHETIC_RESPONSE: scenario === 'lost-response' ? '1' : '0',
            DSH_SENDER_NONCE:runtime.processNonce, TMPDIR:process.env.TMPDIR ?? directory },
          stdio:['pipe','pipe','pipe'], shell:false,
        });
        helper = new HelperProcess(child, 1, () => {}, 'session_http');
        await helper.initialize();
        const request = helper.request.bind(helper);
        helper.request = async (...args) => {
          try {
            const reply = await request(...args);
            if (args[0] === 'send') console.info('synthetic helper send status', reply.status, reply.payload === null ? 'no-record' : 'record');
            if (scenario === 'lost-response' && ['revoke', 'login-cancel'].includes(args[0])) console.info('synthetic helper control', args[0], reply.status);
            return reply;
          } catch (error) {
            if (args[0] === 'send') console.info('synthetic helper send failed', error instanceof Error ? error.message : 'unknown');
            if (scenario === 'lost-response' && ['revoke', 'login-cancel'].includes(args[0])) console.info('synthetic helper control failed', args[0], error instanceof Error ? error.message : 'unknown');
            throw error;
          }
        };
        console.info(`owned-go-test-fixture pid=${helper.pid}`);
        return helper;
      } });
    let service: SenderService | null = null;
    try {
      const maintained = await runtime.beginAuthenticationMaintenance({ manifestPath:'/fixture', manifestSha256:'a'.repeat(64),
        sourceDirectory:'/fixture', transportKind:'session_http', deploymentPath:'/fixture', deploymentSha256:'a'.repeat(64), dataDirectory:'/fixture' });
      expect(maintained.ok).toBe(true);
      expect((await runtime.sessionLoginStart()).ok).toBe(true);
      const waiting = await until(() => runtime.sessionLoginStatus(), (value) => value?.state === 'waiting');
      expect(waiting?.qrDataUrl).toMatch(/^data:image\/png;base64,/);
      const confirmation = await until(() => runtime.sessionLoginStatus(), (value) => value?.state === 'confirmation_required');
      expect(confirmation?.principalUid).toBe('18446744073709551615');
      expect(runtime.state().qualification).toBeNull();
      expect((await runtime.sessionConfirm(confirmation!.bindingRef!)).ok).toBe(true);
      expect(deployment.expectedPrincipalUid).toBe('18446744073709551615');
      service = new SenderService({ runtime, token:'fixture-token', deployment:{ schemaVersion:2, transportKind:'session_http',
        listenUrl:'http://127.0.0.1:0', token:'fixture-token', roomId:'12345', accountRecordId:'fixture-account',
        buildDigest:'a'.repeat(64), instanceId:'fixture-instance', dataDir:directory } });
      const origin = await service.start();
      console.info(`owned-node-http-listener pid=${process.pid} port=${new URL(origin).port}`);
      const gateway = new SenderClient({ url:origin, token:'fixture-token', expected:{ buildDigest:'a'.repeat(64), instanceId:'fixture-instance', transportKind:'session_http' } });
      const journal = new FrozenPublicChatOperationJournal(directory);
      controller = new PublicChatSendController({ deployment, gateway, journal, bounds:{ dispatchIntervalMs:0 } });
      const input = new PublicChatInputBinding(controller, runtime);
      const started = Date.now() - 1000;
      input.setLive({ roomId:'12345', epoch:'synthetic-live', startedAtMs:started });
      input.inputStateChanged('connected','idle');
      const pageContext = {};
      const observer = runtime.createRawEvidenceObserver('12345', { url:() => 'https://live.douyin.com/12345', context:() => pageContext }, {});
      observer.socketCreated('socket', 'wss://webcast100-ws-web-lq.douyin.com/webcast/im/push/v2/?room_id=987654321');
      const payload = chatPayload(987654321n, Date.now());
      observer.rawMessage('socket', { method:'WebcastChatMessage', msgId:'proof', payload });
      expect(runtime.state().raw?.proof?.platformRoomId).toBe('987654321');
      expect((await controller.refreshQualification()).ok).toBe(true);
      expect((await controller.authorize()).ok).toBe(true);
      const eventTime = Date.now();
      expect(eventTime).toBeGreaterThanOrEqual(controller.currentFrozenGrant()!.authorizedAtMs);
      const eventPayload = chatPayload(987654321n, eventTime);
      observer.rawMessage('socket', { method:'WebcastChatMessage', msgId:'raw-1', payload:eventPayload });
      const event = { type:'chat', text:'synthetic viewer' };
      expect(input.bindOriginal(event as never, { rawId:'raw-1', rawType:'WebcastChatMessage', roomId:'12345', frameTimeUntrusted:0, receivedAt:Date.now() })).toBe(true);
      const ref = input.reference(event);
      if (!ref) throw new Error('event reference unavailable');
      const tool = createPublicChatReplyTool({ controller, getTurnContext:() => ({ sessionId:'synthetic-session', turnId:'turn-1',
        sourceEvent:event, rawId:ref.rawId, rawType:ref.rawType, inputConnectionGeneration:ref.inputConnectionGeneration }),
        liveEpoch:() => ref.liveEpoch, sourceConnectionToken:() => ref.sourceConnectionToken });
      const first = await tool.execute({ text:'synthetic reply' });
      expect(first.status).toBe('submitted');
      if (first.status !== 'submitted') throw new Error('reply not submitted');
      const outcome = await until(async () => controller!.frozenOperationView(first.requestId), (value) => !!value && !['queued', 'dispatching'].includes(value.state));
      console.info('synthetic original outcome', outcome?.state, 'runtime', runtime.operation(first.requestId)?.state ?? 'not-registered');
      expect(outcome?.state).toBe(scenario === 'success' ? 'api_reported_success' : 'unknown');
      expect(await tool.execute({ text:'synthetic reply' })).toMatchObject({ status:'rejected' });
      expect(JSON.parse(readFileSync(countPath, 'utf8'))).toEqual({ chatCount:1, valid:true });
      if (scenario === 'lost-response') {
        const status = await runtime.sessionLoginStatus();
        expect(status?.attemptId).toBeTruthy();
        expect((await runtime.sessionLoginCancel(status!.attemptId!, status!.revision)).ok).toBe(true);
        expect((await runtime.sessionLoginStart()).ok).toBe(false);
        for (const mode of ['session_http', 'frozen_http'] as const) {
          const reopened = new FrozenPublicChatOperationJournal(directory);
          const restarted = new PublicChatSendController({ deployment: { ...deployment, transportKind: mode,
            expectedPrincipalUid: mode === 'frozen_http' ? '43' : null }, gateway, journal: reopened });
          expect(restarted.hold).toBe(true);
          expect((await restarted.refreshQualification()).ok).toBe(false);
          expect((await restarted.submit({ requestId:'new-after-restart', sourceKey:'new-source', text:'synthetic reply' })).status).toBe('rejected');
          expect((await restarted.submit({ requestId:first.requestId, sourceKey:ref.rawId, text:'synthetic reply' })).status).not.toBe('submitted');
        }
        runtime.cancelAuthenticationMaintenance();
        if (helper) await (helper as HelperProcess).close();
        helper = null;
        if (service) await service.close();
        service = null;
        const nextDeployment = { ...deployment, expectedPrincipalUid: null as string | null };
        let nextHelper: HelperProcess | null = null;
        let nextService: SenderService | null = null;
        const nextRuntime = new FrozenSenderRuntime({ deployment: nextDeployment, decodeRaw: decodeFixedRaw,
          launch: async () => {
            const child = spawn(binary, ['-test.run=^TestSessionFixtureServer$', '-test.timeout=30s'], {
              cwd: directory, env: { DSH_SESSION_FIXTURE:'1', DSH_QR_FIXTURE:qr, DSH_CHAT_COUNT_FILE:countPath,
                DSH_SYNTHETIC_UID:'43', DSH_SENDER_NONCE:nextRuntime.processNonce, TMPDIR:process.env.TMPDIR ?? directory },
              stdio:['pipe','pipe','pipe'], shell:false,
            });
            nextHelper = new HelperProcess(child, 1, () => {}, 'session_http');
            console.info(`owned-go-restart-fixture pid=${nextHelper.pid}`);
            await nextHelper.initialize();
            return nextHelper;
          } });
        try {
          expect((await nextRuntime.beginAuthenticationMaintenance({ manifestPath:'/fixture', manifestSha256:'a'.repeat(64),
            sourceDirectory:'/fixture', transportKind:'session_http', deploymentPath:'/fixture', deploymentSha256:'a'.repeat(64), dataDirectory:'/fixture' })).ok).toBe(true);
          expect((await nextRuntime.sessionLoginStart()).ok).toBe(true);
          const nextLogin = await until(() => nextRuntime.sessionLoginStatus(), (value) => value?.state === 'confirmation_required');
          expect(nextLogin?.principalUid).toBe('43');
          expect((await nextRuntime.sessionConfirm(nextLogin!.bindingRef!)).ok).toBe(true);
          nextService = new SenderService({ runtime:nextRuntime, token:'fixture-token', deployment:{ schemaVersion:2,
            transportKind:'session_http', listenUrl:'http://127.0.0.1:0', token:'fixture-token', roomId:'12345',
            accountRecordId:'fixture-account', buildDigest:'a'.repeat(64), instanceId:'fixture-instance', dataDir:directory } });
          const nextOrigin = await nextService.start();
          console.info(`owned-node-restart-listener pid=${process.pid} port=${new URL(nextOrigin).port}`);
          const nextGateway = new SenderClient({ url:nextOrigin, token:'fixture-token', expected:{ buildDigest:'a'.repeat(64),
            instanceId:'fixture-instance', transportKind:'session_http' } });
          const nextController = new PublicChatSendController({ deployment:nextDeployment, gateway:nextGateway,
            journal:new FrozenPublicChatOperationJournal(directory) });
          expect(nextController.hold).toBe(true);
          expect((await nextController.refreshQualification()).ok).toBe(false);
          expect((await nextController.submit({ requestId:'new-account-request', sourceKey:'new-account-source', text:'synthetic reply' })).status).toBe('rejected');
        } finally {
          nextRuntime.cancelAuthenticationMaintenance();
          if (nextHelper) await (nextHelper as HelperProcess).close();
          if (nextService) await nextService.close();
        }
        expect(JSON.parse(readFileSync(countPath, 'utf8')).chatCount).toBe(1);
      }
    } finally {
      runtime.cancelAuthenticationMaintenance();
      if (helper) await (helper as HelperProcess).close();
      if (service) await service.close();
    }
  }, 30000);
});
