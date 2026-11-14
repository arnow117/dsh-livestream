/** 输出专用 WeakMap 元数据、sourceKey 与受限 Agent 回复工具（FEAT-008 / P2-01）。 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  registerSourceEventMetadata, readSourceEventMetadata, deriveSourceKey, validateAutoEvent,
} from '../../src/publicChat/eventRef';
import { createPublicChatReplyTool, type AgentReplyTurnContext } from '../../src/publicChat/agentReplyTool';
import { PublicChatSendController } from '../../src/publicChat/controller';
import { FrozenPublicChatOperationJournal } from '../../src/publicChat/frozenJournal';
import { makeFrozenTestGateway } from './frozenTestGateway';
import { makeTempDir, TEST_BUILD_DIGEST, TEST_INSTANCE_ID, TEST_ROOM_ID, TEST_ACCOUNT_RECORD_ID, TEST_PRINCIPAL_UID, TEST_LIVE_EPOCH, waitFor } from './test-helpers';

const DEPLOYMENT = {
  expectedPrincipalUid: TEST_PRINCIPAL_UID,
  roomId: TEST_ROOM_ID,
  accountRecordId: TEST_ACCOUNT_RECORD_ID,
  buildDigest: TEST_BUILD_DIGEST,
  instanceId: TEST_INSTANCE_ID,
};

const BOUNDS = { queueLimit: 10, queueWaitMs: 5_000, dispatchIntervalMs: 5, httpTimeoutMs: 1_000 };

describe('来源元数据 WeakMap', () => {
  it('登记后可读；重复登记不覆盖；未登记事件返回 null', () => {
    const event = { id: 'evt-1' };
    registerSourceEventMetadata(event, {
      rawId: 'raw-1', rawType: 'chat', rawFrameTsUntrusted: 123, receivedAt: 456,
      sourceConnectionToken: 'token-1', roomId: TEST_ROOM_ID, liveEpoch: TEST_LIVE_EPOCH,
    });
    const metadata = readSourceEventMetadata(event);
    expect(metadata?.rawId).toBe('raw-1');
    registerSourceEventMetadata(event, {
      rawId: 'raw-2', rawType: 'gift', rawFrameTsUntrusted: 0, receivedAt: 0,
      sourceConnectionToken: 'token-2', roomId: 'x', liveEpoch: 'y',
    });
    expect(readSourceEventMetadata(event)?.rawId).toBe('raw-1');
    expect(readSourceEventMetadata({ other: true })).toBeNull();
    // 序列化副本不继承资格。
    const clone = JSON.parse(JSON.stringify(event)) as object;
    expect(readSourceEventMetadata(clone)).toBeNull();
  });

  it('auto 事件校验：类型/rawId/输入代次/epoch 全部精确匹配', () => {
    const event = {};
    registerSourceEventMetadata(event, {
      rawId: 'raw-1', rawType: 'chat', rawFrameTsUntrusted: null, receivedAt: 1,
      sourceConnectionToken: 'token-current', roomId: TEST_ROOM_ID, liveEpoch: TEST_LIVE_EPOCH,
    });
    expect(validateAutoEvent(event, { rawId: 'raw-1', rawType: 'chat' }, { liveEpoch: TEST_LIVE_EPOCH, sourceConnectionToken: 'token-current' }).ok).toBe(true);
    expect(validateAutoEvent(event, { rawId: 'raw-1', rawType: 'gift' }, { liveEpoch: TEST_LIVE_EPOCH, sourceConnectionToken: 'token-current' }).ok).toBe(false);
    expect(validateAutoEvent(event, { rawId: 'raw-9', rawType: 'chat' }, { liveEpoch: TEST_LIVE_EPOCH, sourceConnectionToken: 'token-current' }).ok).toBe(false);
    const staleToken = validateAutoEvent(event, { rawId: 'raw-1', rawType: 'chat' }, { liveEpoch: TEST_LIVE_EPOCH, sourceConnectionToken: 'token-old' });
    expect(staleToken.ok).toBe(false);
    if (!staleToken.ok) expect(staleToken.reason).toBe('unavailable:stale-input-generation');
    const staleEpoch = validateAutoEvent(event, { rawId: 'raw-1', rawType: 'chat' }, { liveEpoch: 'epoch-old', sourceConnectionToken: 'token-current' });
    expect(staleEpoch.ok).toBe(false);
    if (!staleEpoch.ok) expect(staleEpoch.reason).toBe('unavailable:stale-epoch');
  });

  it('sourceKey 确定性：同事件稳定，换事件/代次/epoch 必不同', () => {
    const base = { liveEpoch: TEST_LIVE_EPOCH, inputConnectionGeneration: 3, rawType: 'chat', rawId: 'raw-1' };
    expect(deriveSourceKey(base)).toBe(deriveSourceKey({ ...base }));
    expect(deriveSourceKey(base)).not.toBe(deriveSourceKey({ ...base, rawId: 'raw-2' }));
    expect(deriveSourceKey(base)).not.toBe(deriveSourceKey({ ...base, inputConnectionGeneration: 4 }));
    expect(deriveSourceKey(base)).not.toBe(deriveSourceKey({ ...base, liveEpoch: 'epoch-2' }));
  });
});

describe('受限 Agent 回复工具', () => {
  const ownedDirectories: Array<{ cleanup(): void }> = [];
  afterEach(() => { for (const directory of ownedDirectories.splice(0)) directory.cleanup(); });
  async function readyController(gw: ReturnType<typeof makeFrozenTestGateway>) {
    const dir = makeTempDir('pubchat-agent');
    ownedDirectories.push(dir);
    const controller = new PublicChatSendController({
      deployment: DEPLOYMENT, gateway: gw.gateway, journal: new FrozenPublicChatOperationJournal(dir.directory), bounds: BOUNDS,
    });
    controller.advanceInputConnection();
    controller.setLiveEpoch(TEST_LIVE_EPOCH, Date.now() - 1000);
    expect((await controller.refreshQualification()).ok).toBe(true);
    expect((await controller.authorize()).ok).toBe(true);
    controller.setCurrentSourceConnectionToken('token-current');
    return controller;
  }

  function makeContext(event: object): AgentReplyTurnContext {
    return {
      sessionId: 'managed-session-1',
      turnId: 'turn-1',
      sourceEvent: event,
      rawId: 'raw-1',
      rawType: 'chat',
      inputConnectionGeneration: 1,
    };
  }

  it('无受管回合关联 → unavailable；模拟事件（无元数据）拒绝', async () => {
    const controller = await readyController(makeFrozenTestGateway(Date.now() - 1000));
    const tool = createPublicChatReplyTool({
      controller,
      getTurnContext: () => null,
      liveEpoch: () => TEST_LIVE_EPOCH,
      sourceConnectionToken: () => 'token-current',
    });
    const noContext = await tool.execute({ text: '回复内容' });
    expect(noContext.status).toBe('rejected');
    if (noContext.status === 'rejected') expect(noContext.reason).toBe('unavailable:no-real-event');

    const simulated = { fake: true };
    const toolWithSimulated = createPublicChatReplyTool({
      controller,
      getTurnContext: () => makeContext(simulated),
      liveEpoch: () => TEST_LIVE_EPOCH,
      sourceConnectionToken: () => 'token-current',
    });
    const simulatedResult = await toolWithSimulated.execute({ text: '回复内容' });
    expect(simulatedResult.status).toBe('rejected');
    if (simulatedResult.status === 'rejected') expect(simulatedResult.reason).toBe('unavailable:no-metadata');
  });

  it('真实关联可提交一次；同回合重复被拒；不接受 eventId 自证参数', async () => {
    const gw = makeFrozenTestGateway(Date.now() - 1000);
    const controller = await readyController(gw);
    const real = {};
    registerSourceEventMetadata(real, {
      rawId: 'raw-1', rawType: 'chat', rawFrameTsUntrusted: null, receivedAt: Date.now(),
      sourceConnectionToken: 'token-current', roomId: TEST_ROOM_ID, liveEpoch: TEST_LIVE_EPOCH,
    });
    const tool = createPublicChatReplyTool({
      controller,
      getTurnContext: () => makeContext(real),
      liveEpoch: () => TEST_LIVE_EPOCH,
      sourceConnectionToken: () => 'token-current',
    });
    const first = await tool.execute({ text: '回复内容' });
    expect(first).toMatchObject({ status: 'submitted' });
    await waitFor(() => gw.calls.sends.length === 1);
    const second = await tool.execute({ text: '再回一条' });
    expect(second.status).toBe('rejected');
    if (second.status === 'rejected') expect(second.reason).toBe('already-replied-this-turn');
    const smuggled = await tool.execute({ text: '回复内容', eventId: 'raw-9' } as Record<string, unknown>);
    expect(smuggled.status).toBe('rejected');
    if (smuggled.status === 'rejected') expect(smuggled.reason).toBe('unknown-args');
    // sourceKey 固定：相同事件在宿主重放中只会命中同一原操作（不换 ID 重发）。
    expect(gw.calls.sends.length).toBe(1);
  });

  it('敏感文字被文字校验拒绝', async () => {
    const controller = await readyController(makeFrozenTestGateway(Date.now() - 1000));
    const real = {};
    registerSourceEventMetadata(real, {
      rawId: 'raw-1', rawType: 'chat', rawFrameTsUntrusted: null, receivedAt: Date.now(),
      sourceConnectionToken: 'token-current', roomId: TEST_ROOM_ID, liveEpoch: TEST_LIVE_EPOCH,
    });
    const tool = createPublicChatReplyTool({
      controller,
      getTurnContext: () => makeContext(real),
      liveEpoch: () => TEST_LIVE_EPOCH,
      sourceConnectionToken: () => 'token-current',
    });
    const result = await tool.execute({ text: '加我微信 abc123' });
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') expect(result.reason).toContain('text-invalid');
  });
});
