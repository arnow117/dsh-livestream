import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PublicChatSendController } from '../../src/publicChat/controller';
import { registerSourceEventMetadata } from '../../src/publicChat/eventRef';
import { FrozenPublicChatOperationJournal } from '../../src/publicChat/frozenJournal';
import { PublicChatHost } from '../../src/publicChat/publicChatHost';
import { FROZEN_TEST_DEPLOYMENT, makeFrozenTestGateway, successfulOperation } from './frozenTestGateway';
import { makeTempDir, TEST_LIVE_EPOCH, TEST_ROOM_ID, waitFor } from './test-helpers';

afterEach(() => vi.restoreAllMocks());

describe('channel permission while saving real settings', () => {
  it('invalidates queued reply, welcome and thanks across off/on while keeping a manual queue item', async () => {
    const home = process.env.DSH_HOME;
    if (!home) throw new Error('isolated DSH_HOME required');
    const dataDir = join(home, 'dsh-livestream');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ stagePort: 0 }), { mode: 0o600 });
    let host: PublicChatHost | undefined;
    const originalInvalidate = PublicChatHost.prototype.invalidateReplies;
    vi.spyOn(PublicChatHost.prototype, 'invalidateReplies').mockImplementation(function () {
      host = this;
      return originalInvalidate.call(this);
    });
    let settingsHandler: ((request: Request) => Promise<Response>) | undefined;
    const context = {
      effect(effect: () => unknown, label?: string) {
        if (label === 'settings') return effect();
      },
      get() { return undefined; },
      provide() {},
      connection: { fetch: { register(route: { path: string; fetch: (request: Request) => Promise<Response> }) {
        if (route.path === '/api/dsh-livestream/settings') settingsHandler = route.fetch;
        return () => {};
      } } },
    };
    const runtime = await import('../../src/dsh/runtime');
    const entry = await import('../../src/dsh/index');
    const temp = makeTempDir('channel-permission');
    try {
      entry.apply(context as any);
      const save = async (publicChat: Record<string, boolean>) => {
        if (!settingsHandler) throw new Error('settings route unavailable');
        const response = await settingsHandler(new Request('http://127.0.0.1:49123/api/dsh-livestream/settings', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publicChat }),
        }));
        expect(response.status).toBe(200);
      };
      await save({ enabled: true, reply: false, welcome: true, thanks: true });
      expect(host).toBeDefined();
      await save({ reply: true });
      const start = Date.now() - 1000;
      const fixture = makeFrozenTestGateway(start);
      let release!: () => void;
      let blocked = new Promise<void>((resolve) => { release = resolve; });
      fixture.setSend(async (request) => {
        if (request.requestId === 'first' || request.requestId.startsWith('hold-')) await blocked;
        return { ok: true, value: successfulOperation(request) };
      });
      const controller = new PublicChatSendController({ deployment: FROZEN_TEST_DEPLOYMENT, gateway: fixture.gateway,
        journal: new FrozenPublicChatOperationJournal(temp.directory), bounds: { dispatchIntervalMs: 0 } });
      const token = controller.advanceInputConnection();
      controller.setLiveEpoch(TEST_LIVE_EPOCH, start);
      expect((await controller.refreshQualification()).ok).toBe(true);
      expect((await controller.authorize()).ok).toBe(true);
      Object.assign(host!, { sender: { controller } });
      expect((await controller.submit({ requestId: 'first', sourceKey: null, text: '首条' })).status).toBe('accepted');
      expect(fixture.calls.sends.map((request) => request.requestId)).toEqual(['first']);
      const channels = ['reply', 'welcome', 'thanks'] as const;
      const requests = channels.map((channel) => {
        const event = {};
        const rawType = channel === 'reply' ? 'WebcastChatMessage' : channel === 'welcome' ? 'WebcastMemberMessage' : 'WebcastGiftMessage';
        registerSourceEventMetadata(event, { rawId: channel, rawType, rawFrameTsUntrusted: null, receivedAt: Date.now(),
          sourceConnectionToken: token, roomId: TEST_ROOM_ID, liveEpoch: TEST_LIVE_EPOCH });
        return { requestId: channel, sourceKey: null, text: '自动内容', autoEvent: { event, rawId: channel, rawType } };
      });
      for (let index = 0; index < channels.length; index++) {
        expect((await (controller.submit as any)(requests[index], channels[index])).status).toBe('accepted');
      }
      expect((await controller.submit({ requestId: 'manual', sourceKey: null, text: '手动内容' })).status).toBe('accepted');
      for (const channel of channels) {
        await save({ [channel]: false });
        await save({ [channel]: true });
        expect(fixture.calls.sends.map((request) => request.requestId)).toEqual(['first']);
      }
      expect(controller.currentFrozenGrant()).not.toBeNull();
      release();
      await waitFor(() => fixture.calls.sends.some((request) => request.requestId === 'manual'));
      expect(fixture.calls.sends.map((request) => request.requestId)).toEqual(['first', 'manual']);
      for (const request of requests) {
        expect(controller.frozenOperationView(request.requestId)?.state).toBe('cancelled_before_dispatch');
        expect((await (controller.submit as any)({ ...request, requestId: `again-${request.requestId}` }, request.requestId)).status).toBe('duplicate');
      }

      await waitFor(() => controller.frozenOperationView('manual')?.state === 'api_reported_success');
      for (const disabled of channels) {
        blocked = new Promise<void>((resolve) => { release = resolve; });
        const holdId = `hold-${disabled}`;
        const manualId = `manual-${disabled}`;
        const before = fixture.calls.sends.map((request) => request.requestId);
        expect((await controller.submit({ requestId: holdId, sourceKey: null, text: '另一条' })).status).toBe('accepted');
        await waitFor(() => fixture.calls.sends.some((request) => request.requestId === holdId));
        const nextRequests = channels.map((channel) => {
          const event = {};
          const rawId = `next-${disabled}-${channel}`;
          const rawType = channel === 'reply' ? 'WebcastChatMessage' : channel === 'welcome' ? 'WebcastMemberMessage' : 'WebcastGiftMessage';
          registerSourceEventMetadata(event, { rawId, rawType, rawFrameTsUntrusted: null, receivedAt: Date.now(),
            sourceConnectionToken: token, roomId: TEST_ROOM_ID, liveEpoch: TEST_LIVE_EPOCH });
          return { requestId: rawId, sourceKey: null, text: '新事件', autoEvent: { event, rawId, rawType } };
        });
        for (let index = 0; index < channels.length; index++) {
          expect((await (controller.submit as any)(nextRequests[index], channels[index])).status).toBe('accepted');
        }
        expect((await controller.submit({ requestId: manualId, sourceKey: null, text: '手动消息' })).status).toBe('accepted');
        await save({ [disabled]: false });
        await save({ [disabled]: true });
        expect(fixture.calls.sends.map((request) => request.requestId)).toEqual([...before, holdId]);
        release();
        await waitFor(() => controller.frozenOperationView(manualId)?.state === 'api_reported_success');
        expect(fixture.calls.sends.map((request) => request.requestId)).toEqual([
          ...before, holdId, ...nextRequests.filter((_, index) => channels[index] !== disabled).map((request) => request.requestId), manualId,
        ]);
        expect(controller.frozenOperationView(`next-${disabled}-${disabled}`)?.state).toBe('cancelled_before_dispatch');
        expect(controller.currentFrozenGrant()).not.toBeNull();
      }

      blocked = new Promise<void>((resolve) => { release = resolve; });
      fixture.setSend(async () => {
        await blocked;
        return { ok: false, error: 'fixture response lost', untrusted: false };
      });
      expect((await controller.submit({ requestId: 'unknown', sourceKey: null, text: '已派发内容' })).status).toBe('accepted');
      await waitFor(() => fixture.calls.sends.some((request) => request.requestId === 'unknown'));
      await save({ reply: false });
      await save({ reply: true });
      expect(controller.hold).toBe(true);
      release();
      await waitFor(() => controller.frozenOperationView('unknown')?.state === 'unknown');
      expect(controller.hold).toBe(true);
      expect(fixture.calls.sends.filter((request) => request.requestId === 'unknown')).toHaveLength(1);
    } finally {
      if (host) Object.assign(host, { sender: null });
      runtime.show.dispose();
      temp.cleanup();
    }
  });
});
