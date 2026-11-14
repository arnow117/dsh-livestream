/**
 * 机器人联动运行时（FEAT-DSH-004，修正批次）：用替身 robot 模块覆盖
 * F1 同步撤销与代次隔离、F2 生命周期失效与迟到 receipt 丢弃、F3 既有会话补装/重装、
 * F4 身份来源与聚合拒绝、F5 非 chat 来源与规则只对 chat、F6 真实 revision 停用。
 * robot 模块本身的真实行为由组合验收（composition）覆盖；这里证明直播侧按合同消费、不破坏直播。
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LiveEvent } from '../src/core/live';
import { registerPickComposition, type ChatPick, type Topic } from '../src/core/attention/topics';

interface StubReceipt {
  receiptId: string;
  sourceKey: string;
  receivedAtHostMs: number;
  sourceDispatchMs: number;
  capturedConfigRevision: number;
  taskId: string | null;
  chatText: string | null;
}

interface StubOptions {
  policy?: { configRevision: number; enabled: boolean; cooldownMs: number; hasAccepted: boolean } | null;
  attachError?: string;
  /** capture 返回的 receipt 延迟毫秒（默认 0）：验证迟到 receipt 在撤销后被丢弃 */
  captureDelayMs?: number;
  /** readPolicy 延迟毫秒：验证被新一代取代的装配在 await 后被丢弃 */
  policyDelayMs?: number;
  /** attach 门控：装配停在 attachRobotLiveBinding 上，直到 release() 才返回句柄（R1 在途装配失效用） */
  attachHold?: { promise: Promise<void>; release(): void };
}

function createStubModule(options: StubOptions = {}) {
  const calls = {
    order: [] as string[],
    readPolicy: [] as string[],
    attachBinding: [] as Array<{ config: unknown; expectedRevision: number }>,
    attachRule: [] as unknown[],
    bindMessage: [] as Array<{ messageId: string; receipt: StubReceipt; agent: object }>,
    attachCaller: [] as Array<{ allowedActions: readonly string[] }>,
    callerDisposed: 0,
    capture: [] as Array<{ input: Record<string, unknown> }>,
    evaluate: [] as unknown[],
  };
  let bindingDisposed = false;
  let receiptSeq = 0;
  const module = {
    async readRobotLivePolicy(_ctx: unknown, bindingId: string) {
      calls.order.push(`policy:${bindingId}`);
      calls.readPolicy.push(bindingId);
      if (options.policyDelayMs) await new Promise((resolve) => setTimeout(resolve, options.policyDelayMs));
      return options.policy ?? null;
    },
    async attachRobotLiveBinding(_ctx: unknown, config: unknown, expectedRevision: number) {
      calls.order.push(`attach:${expectedRevision}`);
      calls.attachBinding.push({ config, expectedRevision });
      if (options.attachError) throw new Error(options.attachError);
      if (options.attachHold) await options.attachHold.promise;
      bindingDisposed = false;
      return {
        description: { version: 'robot-live/1', journalSchemaVersion: 2, configRevision: (options.policy?.configRevision ?? 0) + 1 },
        async capture(input: Record<string, unknown>) {
          calls.capture.push({ input });
          if (options.captureDelayMs) await new Promise((resolve) => setTimeout(resolve, options.captureDelayMs));
          const receipt: StubReceipt = {
            receiptId: `receipt-${++receiptSeq}`,
            sourceKey: `key-${receiptSeq}`,
            receivedAtHostMs: 1000 + receiptSeq,
            sourceDispatchMs: 30000,
            capturedConfigRevision: (options.policy?.configRevision ?? 0) + 1,
            taskId: null,
            chatText: typeof input.event === 'object' && input.event !== null ? String((input.event as { chatText?: string }).chatText ?? '') : null,
          };
          return receipt;
        },
        dispose() {
          calls.order.push('binding-dispose');
          bindingDisposed = true;
        },
      };
    },
    attachRobotLiveRule(_ctx: unknown, _handle: unknown) {
      calls.attachRule.push(_handle);
      return {
        async evaluate(receipt: unknown) {
          calls.order.push('evaluate');
          calls.evaluate.push(receipt);
          const value = receipt as StubReceipt;
          return {
            version: 'robot-live/1',
            bindingId: 'binding-1',
            configRevision: value.capturedConfigRevision,
            sourceKey: value.sourceKey,
            result: {
              kind: 'task' as const,
              submission: {
                outcome: 'accepted' as const,
                task: { taskId: `task-${value.receiptId}`, sourceKind: 'live_rule', phase: 'accepted', job: 'none', reason: null, cancelRequested: false },
              },
            },
          };
        },
        async get(taskId: string) {
          return { taskId, sourceKind: 'live_rule', phase: 'accepted', job: 'idle', reason: null, cancelRequested: false, operations: [] };
        },
        cancel(taskId: string) {
          return { taskId, sourceKind: 'live_rule', phase: 'accepted', job: 'cancel_requested', reason: null, cancelRequested: true, operations: [] };
        },
        dispose() {
          calls.order.push('rule-dispose');
        },
      };
    },
    bindRobotLiveMessage(_handle: unknown, agent: object, message: { id: string }, receipt: unknown) {
      calls.order.push(`bind:${message.id}`);
      calls.bindMessage.push({ messageId: message.id, receipt: receipt as StubReceipt, agent });
    },
    attachRobotLiveCaller(_ctx: unknown, _agent: object, allowedActions: readonly string[], _currentInteraction: unknown) {
      calls.order.push('caller-attach');
      calls.attachCaller.push({ allowedActions: [...allowedActions] });
      return () => {
        calls.order.push('caller-dispose');
        calls.callerDisposed += 1;
      };
    },
  };
  return { module, calls, bindingDisposed: () => bindingDisposed };
}

const chatEvent = (id: string, uid: string, text: string): LiveEvent => ({
  id, platform: 'bilibili', ts: Date.now(), kind: 'chat', text, user: { id: uid, name: `观众${uid}` },
});

/**
 * 带私有组成登记的 chat 话题（与 attention 生产路径同形）：必须传入真实收进的原事件对象，
 * 因为来源解析只认「对象引用 + 进入标记 + 当次登记」，不认可复制的公开 {id,live}。
 */
const chatTopicFrom = (event: LiveEvent, text = String((event as { text?: string }).text ?? '')): Topic => {
  const pick: ChatPick = {
    event: event as never,
    text,
    sources: [{ id: event.id, live: true }],
    tags: [],
    score: 1,
  };
  registerPickComposition(pick, [event]);
  return { id: event.id, priority: 80, heat: 'normal', createdAt: Date.now(), kind: 'chat', picks: [pick] };
};

/** 伪造话题：手工构造的 pick，不带私有组成登记（生产里不存在这种来源）。 */
const forgedChatTopic = (id: string, uid: string, text: string, sources?: Array<{ id: string; live: boolean }>): Topic => ({
  id, priority: 80, heat: 'normal', createdAt: Date.now(),
  kind: 'chat',
  picks: [{ event: chatEvent(id, uid, text), text, sources: sources ?? [{ id, live: true }], tags: [], score: 1 }],
});

const superchatEvent = (id: string, uid: string, text: string): LiveEvent => ({
  id, platform: 'bilibili', ts: Date.now(), kind: 'superchat', text, valueYuan: 30, user: { id: uid, name: `观众${uid}` },
});

const giftEvent = (id: string, uid: string): LiveEvent => ({
  id, platform: 'bilibili', ts: Date.now(), kind: 'gift', giftName: '小花花', count: 1, valueYuan: 1, user: { id: uid, name: `观众${uid}` },
});

describe('robot live integration (corrections)', () => {
  let dir: string;
  let runtime: typeof import('../src/dsh/runtime');
  let robotLive: typeof import('../src/dsh/robotLive');
  let routes: Map<string, (request: Request) => Response | Promise<Response>>;

  const post = async (path: string, data: unknown) => {
    const response = await routes.get(`/api/dsh-livestream/${path}`)!(new Request('http://localhost/', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data),
    }));
    return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, unknown> };
  };

  const robotConfig = (overrides: Record<string, unknown> = {}) => ({
    version: 'robot-live/1',
    enabled: true,
    liveSessionId: 'session-1',
    bindingId: 'binding-1',
    allowedActions: ['greeting', 'sit_down'],
    rules: [{ ruleId: 'r1', text: '坐下', action: 'greeting' }],
    cooldownMs: 10000,
    ...overrides,
  });

  let sessionSeq = 0;
  /** 干净重启绑定会话：先用不同会话走完整 retire（清掉 ending/旧状态），再切回绑定会话 */
  const restartShowSession = () => {
    sessionSeq += 1;
    runtime.show.goLive(`warm-${sessionSeq}`);
    runtime.show.goLive('session-1');
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-robot-live-'));
    process.env.DSH_HOME = dir;
    await mkdir(join(dir, 'dsh-livestream'), { recursive: true });
    await writeFile(join(dir, 'dsh-livestream', 'settings.json'), JSON.stringify({ stageToken: 'test', stagePort: 0 }));
    runtime = await import('../src/dsh/runtime');
    robotLive = await import('../src/dsh/robotLive');
    const host = await import('../src/dsh/index');
    routes = new Map();
    host.apply({
      effect(effect: () => unknown) {
        effect();
      },
      provide() {},
      get() { return undefined; },
      connection: { fetch: { register(route: { path: string; fetch: (request: Request) => Response | Promise<Response> }) { routes.set(route.path, route.fetch); return () => {}; } } },
    });
    runtime.robotBridge.onOriginalEvent = (event) => robotLive.robotOriginalEvent(event);
  });

  afterAll(async () => {
    robotLive.disposeRobotLive();
    await rm(dir, { recursive: true, force: true });
    delete process.env.DSH_HOME;
  });

  it('F1: config change disposes the old rule/binding synchronously before the first await', async () => {
    const stub = createStubModule();
    robotLive.setRobotModuleOverrideForTest(stub.module as never);
    robotLive.resetRobotLiveStateForTest();
    await post('settings', { robotLive: robotConfig() });
    expect(stub.calls.attachBinding).toHaveLength(1);
    // 第二次保存：装配流程从「同步撤销」开始——dispose 必须发生在其后所有 await 之前
    await post('settings', { robotLive: robotConfig({ cooldownMs: 5000 }) });
    const order = stub.calls.order;
    const lastDispose = order.lastIndexOf('binding-dispose');
    const lastRuleDispose = order.lastIndexOf('rule-dispose');
    expect(lastDispose).toBeGreaterThanOrEqual(0);
    expect(lastRuleDispose).toBeGreaterThanOrEqual(0);
    // 最终一轮的 policy 读取与 attach 都在 dispose 之后（同步撤销先于首个 await）
    expect(order.lastIndexOf('policy:binding-1')).toBeGreaterThan(lastDispose);
    expect(order.lastIndexOf('policy:binding-1')).toBeGreaterThan(lastRuleDispose);
    expect(order.lastIndexOf('attach:0')).toBeGreaterThan(lastDispose);
  });

  it('F1: late attach completion of a superseded generation is discarded', async () => {
    const stub = createStubModule({ policyDelayMs: 120 });
    robotLive.setRobotModuleOverrideForTest(stub.module as never);
    robotLive.resetRobotLiveStateForTest();
    // 第一次保存停在 policy await 上；第二次保存随后推进代次并完成装配——
    // 第一代恢复后必须发现自己已过期：不再 attach、不覆盖状态
    const first = post('settings', { robotLive: robotConfig() });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = post('settings', { robotLive: robotConfig({ cooldownMs: 7000 }) });
    await Promise.all([first, second]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const view = robotLive.robotLiveView();
    expect(view.binding).not.toBeNull();
    expect(view.saved?.cooldownMs).toBe(7000);
    // 只有一次 attach（第二代）；第一代在恢复后被丢弃
    expect(stub.calls.attachBinding).toHaveLength(1);
    expect((stub.calls.attachBinding[0].config as { cooldownMs: number }).cooldownMs).toBe(7000);
  });

  it('F2: pending rule submission is dropped when the show ends before the receipt resolves', async () => {
    const stub = createStubModule({ captureDelayMs: 80 });
    robotLive.setRobotModuleOverrideForTest(stub.module as never);
    robotLive.resetRobotLiveStateForTest();
    await post('settings', { robotLive: robotConfig() });
    runtime.show.goLive('session-1');
    runtime.show.inject(chatEvent('late-1', 'u-late', '坐下'));
    // receipt 还没回来就下播：evaluate 不得再发生
    runtime.show.endLive();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(stub.calls.capture).toHaveLength(1);
    expect(stub.calls.evaluate).toHaveLength(0);
    runtime.show.goLive('session-1');
  });

  it('F2/B: offair truly revokes the grant; a resumed show never revives sources until owner re-assembles', async () => {
    const stub = createStubModule();
    robotLive.setRobotModuleOverrideForTest(stub.module as never);
    robotLive.resetRobotLiveStateForTest();
    await post('settings', { robotLive: robotConfig() });
    runtime.show.goLive('session-1');
    // 真正结束这一场（onAir=false）：offair 真失效，撤销原 Host grant
    (runtime.show as unknown as { finish(): void }).finish();
    expect(robotLive.robotLiveView().binding).toBeNull();
    // 旧存档续播没有 robotEpoch：来源被拒（不生成新场次身份），直播照常
    runtime.show.resumeLive({ sessionId: 'session-1', roomId: null, streamId: null, logFile: null, at: Date.now() });
    expect(runtime.show.streamEpochId).toBe('');
    runtime.show.inject(chatEvent('no-epoch', 'u9', '坐下'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stub.calls.capture).toHaveLength(0);
    expect(runtime.show.isOnAir).toBe(true);
    // 恢复正常场次：显式下播再开播才是新场次（新场次身份）
    (runtime.show as unknown as { finish(): void }).finish();
    runtime.show.goLive('session-1');
    expect(runtime.show.streamEpochId).not.toBe('');
    // 真失效后不自动复活：同会话新场次也没有动作资格，必须 owner 重新装配
    const revokedEvent = chatEvent('revoked', 'u10a', '坐下');
    runtime.show.inject(revokedEvent);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stub.calls.capture).toHaveLength(0);
    expect(robotLive.robotLiveView().binding).toBeNull();
    // owner 重新装配（唯一恢复路径）：新事件恢复登记；旧事件身份不会复活
    await post('settings', { robotLive: robotConfig() });
    expect(robotLive.robotLiveView().binding).not.toBeNull();
    runtime.show.inject(chatEvent('with-epoch', 'u10', '坐下'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stub.calls.capture).toHaveLength(1);
    // 下播收尾（道别期）即真失效：撤销后新事件零 capture
    runtime.show.endLive();
    runtime.show.inject(chatEvent('during-ending', 'u11', '坐下'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stub.calls.capture).toHaveLength(1);
    expect(robotLive.robotLiveView().binding).toBeNull();
    restartShowSession();
  });

  it('F3: caller attaches to an existing session when the config is enabled later, and reinstalls on reconfigure', async () => {
    const stub = createStubModule();
    robotLive.setRobotModuleOverrideForTest(stub.module as never);
    robotLive.resetRobotLiveStateForTest();
    const chain = new Map<string, { definition: object }>(['robot_task_submit', 'robot_task_get', 'robot_task_cancel', 'robot_task_capabilities'].map((name) => [name, { definition: { name } }]));
    const agent = { id: 'existing-agent', session: { id: 'session-1' } };
    const agentCtx = { tools: { layers: { global: { tools: new Map() }, chainLayers: () => [{ tools: chain }] } } };
    // 会话先建（robot 未配置）：登记但不装配
    const before = robotLive.attachRobotForSession(agentCtx, agent, 'session-1', () => chain);
    expect(before.size).toBe(0);
    expect(stub.calls.attachCaller).toHaveLength(0);
    // owner 稍后启用：caller 补装到已登记的实际 Agent
    await post('settings', { robotLive: robotConfig() });
    expect(stub.calls.attachCaller).toHaveLength(1);
    expect(robotLive.robotToolDefinitionsFor(agent)?.size).toBe(4);
    // 同代次重复公告不重复装配
    robotLive.attachRobotForSession(agentCtx, agent, 'session-1', () => chain);
    expect(stub.calls.attachCaller).toHaveLength(1);
    // 重配（新代次）：先 dispose 旧 caller，再装新
    await post('settings', { robotLive: robotConfig({ cooldownMs: 3000 }) });
    expect(stub.calls.attachCaller).toHaveLength(2);
    expect(stub.calls.callerDisposed).toBeGreaterThanOrEqual(1);
    const order = stub.calls.order;
    expect(order.lastIndexOf('caller-dispose')).toBeLessThan(order.lastIndexOf('caller-attach'));
  });

  it('F4/D: sources resolve via private composition of the actual live event; forged picks, copied markers, aggregations and consumed sources deny', async () => {
    const stub = createStubModule();
    robotLive.setRobotModuleOverrideForTest(stub.module as never);
    robotLive.resetRobotLiveStateForTest();
    // 先 settled 场次再装配：会话切换本身是真失效，装配必须发生在它之后
    restartShowSession();
    await post('settings', { robotLive: robotConfig() });
    const agent = { ctx: { on: () => () => {} }, session: { id: 'session-1' } };
    // 单一原事件（真实收进对象 + 私有组成登记）：绑定该身份的 receipt
    const e1 = chatEvent('e1', 'u1', '坐下');
    runtime.show.inject(e1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const single = robotLive.robotPushSource(chatTopicFrom(e1));
    expect(single).not.toBeNull();
    await single!.bind(agent, { id: 'm1' });
    expect(stub.calls.bindMessage).toHaveLength(1);
    // 同文新事件不会绑到旧来源：e2 是新身份
    const e2 = chatEvent('e2', 'u1', '坐下');
    runtime.show.inject(e2);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = robotLive.robotPushSource(chatTopicFrom(e2));
    await second!.bind(agent, { id: 'm2' });
    expect(stub.calls.bindMessage).toHaveLength(2);
    expect(stub.calls.bindMessage[0].receipt.receiptId).not.toBe(stub.calls.bindMessage[1].receipt.receiptId);
    // 伪造 pick（复制的 {id,live:true}、无私有组成登记）：拒绝——公开 sources 数组不构成凭据
    expect(robotLive.robotPushSource(forgedChatTopic('forged', 'u1', '坐下'))).toBeNull();
    // 伪造 pick 指向真实已消费来源（e1 已被消费移除）：同样拒绝
    expect(robotLive.robotPushSource(forgedChatTopic('e1', 'u1', '坐下'))).toBeNull();
    // 已消费来源的登记组成再解析：null（不复活旧来源）
    expect(robotLive.robotPushSource(chatTopicFrom(e1))).toBeNull();
    // 聚合（登记了两条原事件的组成）：拒绝并计数
    const a1 = chatEvent('a1', 'u2', '第一条');
    const a2 = chatEvent('a2', 'u2', '第二条');
    runtime.show.inject(a1);
    runtime.show.inject(a2);
    await new Promise((resolve) => setTimeout(resolve, 10));
    // 伪造 pick 指向当前已登记的实时来源（复制的 id+live、无私有组成登记）：拒绝且不消费来源
    expect(robotLive.robotPushSource(forgedChatTopic('a1', 'u2', '第一条'))).toBeNull();
    const aggPick: ChatPick = { event: a2 as never, text: '第一条 第二条', sources: [{ id: 'a1', live: true }, { id: 'a2', live: true }], tags: [], score: 1 };
    registerPickComposition(aggPick, [a1, a2]);
    const aggTopic: Topic = { id: 'agg', priority: 80, heat: 'normal', createdAt: Date.now(), kind: 'chat', picks: [aggPick] };
    expect(robotLive.robotPushSource(aggTopic)).toBeNull();
    expect(robotLive.robotLiveView().ambiguousAggregations).toBe(1);
    restartShowSession();
  });

  it('C: ordinary platform callbacks carry no trusted ingress; only the controlled internal entry grants capture', async () => {
    const stub = createStubModule();
    robotLive.setRobotModuleOverrideForTest(stub.module as never);
    robotLive.resetRobotLiveStateForTest();
    restartShowSession();
    await post('settings', { robotLive: robotConfig() });
    runtime.show.goLive('session-1');
    // 普通平台回调（重连补发/未验证回调经 hub.ingest 直入）：直播照常，机器人零 capture——
    // 平台首次本地接收不是实时资格证明，fail closed
    const platformEvent = chatEvent('plat-1', 'up', '坐下');
    (runtime.show as unknown as { hub: { ingest(event: LiveEvent): void } }).hub.ingest(platformEvent);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stub.calls.capture).toHaveLength(0);
    expect(runtime.show.isOnAir).toBe(true);
    // 控制台模拟观众（受控离线注入的可信入口）：capture 恢复
    runtime.show.inject(chatEvent('trust-1', 'ut', '坐下'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stub.calls.capture).toHaveLength(1);
    restartShowSession();
  });

  it('B: disconnecting the room synchronously revokes the live grant; revival requires re-assembly', async () => {
    const stub = createStubModule();
    robotLive.setRobotModuleOverrideForTest(stub.module as never);
    robotLive.resetRobotLiveStateForTest();
    restartShowSession();
    await post('settings', { robotLive: robotConfig() });
    runtime.show.goLive('session-1');
    // 断订阅真失效：show.disconnect 在同一同步段撤销原 grant
    runtime.show.disconnect();
    expect(robotLive.robotLiveView().binding).toBeNull();
    runtime.show.inject(chatEvent('after-disc', 'ud', '坐下'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stub.calls.capture).toHaveLength(0);
    // 意外断源：走真实 source 状态回调通道（hub.connect 的 state 回调 → 同步通知 → 撤权），
    // 不采用私有字段改动加手动轮询的方式
    await post('settings', { robotLive: robotConfig() });
    runtime.show.goLive('session-1');
    let sourceHandlers: { state(state: string, detail?: unknown): void } | null = null;
    const fakeSource = {
      start(handlers: { state: (state: string, detail?: unknown) => void }) {
        sourceHandlers = handlers;
        handlers.state('connected');
      },
      stop() {},
    };
    const { LiveHub } = await import('../src/core/hub');
    (runtime.show as unknown as { hub: unknown }).hub = new LiveHub(() => fakeSource as never);
    (runtime.show as unknown as { watchHubState(): void }).watchHubState();
    runtime.show.connectTarget({ platform: 'bilibili', roomId: 42, cookie: 't' } as never);
    expect(robotLive.robotLiveView().binding).not.toBeNull();
    // 真实 source 回调离开 connected：同一同步段撤销原 grant
    sourceHandlers!.state('reconnecting');
    expect(robotLive.robotLiveView().binding).toBeNull();
    runtime.show.inject(chatEvent('after-loss', 'ul', '坐下'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stub.calls.capture).toHaveLength(0);
    restartShowSession();
  });

  it('B: replacing the live session revokes the grant bound to the retired session', async () => {
    const stub = createStubModule();
    robotLive.setRobotModuleOverrideForTest(stub.module as never);
    robotLive.resetRobotLiveStateForTest();
    restartShowSession();
    await post('settings', { robotLive: robotConfig() });
    runtime.show.goLive('session-1');
    runtime.show.inject(chatEvent('bound-live', 'ub', '坐下'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stub.calls.capture).toHaveLength(1);
    // 旧绑定会话被替换：session-retired 真失效，同步撤销原 grant
    runtime.show.goLive('other-session');
    expect(robotLive.robotLiveView().binding).toBeNull();
    runtime.show.inject(chatEvent('after-switch', 'us', '坐下'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stub.calls.capture).toHaveLength(1);
    // 切回绑定会话也不自动复活：重新装配是唯一恢复路径
    runtime.show.goLive('session-1');
    runtime.show.inject(chatEvent('back-no-revive', 'ur', '坐下'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stub.calls.capture).toHaveLength(1);
    await post('settings', { robotLive: robotConfig() });
    runtime.show.inject(chatEvent('back-revived', 'uv', '坐下'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stub.calls.capture).toHaveLength(2);
    restartShowSession();
  });

  it('A: a superseded generation cannot overwrite the newer binding or policy; old handles stay revoked and current revoke still works', async () => {
    // 复现主 Agent 发现的装配竞争：某代的「安装后 policy 读取」被挂起，更新的代次完成装配后
    // 才释放旧读取——旧代次不得改写新一代句柄/策略，也不得全局撤销新一代授权。
    let revision = 0;
    let reads = 0;
    const gates: Array<(value: { configRevision: number; enabled: boolean; cooldownMs: number; authoritySha: string; hasAccepted: boolean }) => void> = [];
    const bindingDisposals: number[] = [];
    const ruleDisposals: number[] = [];
    const policy = (configRevision: number) => ({ configRevision, enabled: true, cooldownMs: 10000, authoritySha: '0'.repeat(64), hasAccepted: false });
    const scripted = {
      async readRobotLivePolicy(_ctx: unknown, _bindingId: string) {
        reads += 1;
        // 挂起第 2、6 次读取（分别是第 1、3 代的「安装后读取」），其余立即返回
        if (reads === 2 || reads === 6) {
          return await new Promise((resolve) => { gates.push(resolve as never); });
        }
        return policy(5);
      },
      async attachRobotLiveBinding(_ctx: unknown, _config: unknown, _expectedRevision: number) {
        const id = ++revision;
        return {
          description: { version: 'robot-live/1', journalSchemaVersion: 2, configRevision: id },
          async capture() { return null; },
          dispose() { bindingDisposals.push(id); },
        };
      },
      attachRobotLiveRule(_ctx: unknown, handle: { description: { configRevision: number } }) {
        return {
          async evaluate() { return null; },
          async get() { return null; },
          cancel() { return null; },
          dispose() { ruleDisposals.push(handle.description.configRevision); },
        };
      },
      bindRobotLiveMessage() {},
      attachRobotLiveCaller() { return () => {}; },
    };
    robotLive.setRobotModuleOverrideForTest(scripted as never);
    robotLive.resetRobotLiveStateForTest();
    // 第 1 代：装配停在安装后 policy 读取上（gate 1）
    const first = post('settings', { robotLive: robotConfig() });
    await new Promise((resolve) => setTimeout(resolve, 30));
    // 第 2 代完成装配：旧句柄已同步撤销，当前绑定/策略是第 2 代的
    await post('settings', { robotLive: robotConfig({ cooldownMs: 20000 }) });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(robotLive.robotLiveView().binding?.configRevision).toBe(2);
    expect(robotLive.robotLiveView().policy?.configRevision).toBe(5);
    expect(bindingDisposals).toEqual([1]);
    // 释放第 1 代的迟到读取（携带不同 revision）：不得改写当前 binding/policy，也不得撤销第 2 代句柄
    gates.shift()!(policy(99));
    await first;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(robotLive.robotLiveView().binding?.configRevision).toBe(2);
    expect(robotLive.robotLiveView().policy?.configRevision).toBe(5);
    expect(bindingDisposals).toEqual([1]);
    expect(ruleDisposals).toEqual([1]);
    // 第 3 代装配停在安装后读取（gate 2，不等待它）；第 4 代完成后释放第 3 代的迟到读取同样安全
    const third = post('settings', { robotLive: robotConfig({ cooldownMs: 30000 }) });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await post('settings', { robotLive: robotConfig({ cooldownMs: 40000 }) });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(robotLive.robotLiveView().binding?.configRevision).toBe(4);
    gates.shift()!(policy(88));
    await third;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(robotLive.robotLiveView().binding?.configRevision).toBe(4);
    expect(robotLive.robotLiveView().policy?.configRevision).toBe(5);
    // 被取代的各代句柄恰好各撤销一次；当前（第 4 代）句柄仍活着，迟到读取释放后无新增撤销
    expect(bindingDisposals).toEqual([1, 2, 3]);
    expect(ruleDisposals).toEqual([1, 2, 3]);
    // 当前代次的正常撤销仍然生效（停用覆盖原目标，不猜 0）
    const disabled = await post('settings', { robotLive: robotConfig({ enabled: false, bindingId: null, liveSessionId: null }) });
    expect(disabled.status).toBe(200);
    expect(bindingDisposals.filter((id) => id === 4)).toHaveLength(1);
    expect(robotLive.robotLiveView().binding).not.toBeNull();
    restartShowSession();
  });

  it('F5: superchat and gift capture with chatText null and never trigger rules; single ones bind', async () => {
    const stub = createStubModule();
    robotLive.setRobotModuleOverrideForTest(stub.module as never);
    robotLive.resetRobotLiveStateForTest();
    // 先 settled 场次再装配：会话切换本身是真失效，装配必须发生在它之后
    restartShowSession();
    await post('settings', { robotLive: robotConfig() });
    const agent = { ctx: { on: () => () => {} }, session: { id: 'session-1' } };
    // superchat：来源登记但 chatText 必须为 null，规则不触发（话题携带同一个事件对象）
    const superEvent = superchatEvent('sc1', 'u3', '辛苦了');
    runtime.show.inject(superEvent);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stub.calls.capture).toHaveLength(1);
    expect((stub.calls.capture[0].input as { event: { chatText: string | null } }).event.chatText).toBeNull();
    expect(stub.calls.evaluate).toHaveLength(0);
    const scTopic: Topic = {
      id: 'sc-t', priority: 100, heat: 'normal', createdAt: Date.now(),
      kind: 'superchat', event: superEvent as never,
    };
    const scSource = robotLive.robotPushSource(scTopic);
    expect(scSource).not.toBeNull();
    await scSource!.bind(agent, { id: 'm3' });
    expect(stub.calls.bindMessage).toHaveLength(1);
    // 礼物：同样 chatText null、不触发规则、单一事件可绑定。
    // hub 首次进入会对礼物事件做浅拷贝：注意力/话题持有的正是这份带进入标记的对象，
    // 测试同样从 hub 取回同一引用（真实链路里话题的对象就是它）。
    runtime.show.inject(giftEvent('g1', 'u4'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const hubEvents = (runtime.show as unknown as { hub: { recentEvents(): LiveEvent[] } }).hub.recentEvents();
    const gift1 = hubEvents.find((item) => item.id === 'g1')!;
    expect(gift1).toBeDefined();
    expect(stub.calls.capture).toHaveLength(2);
    expect((stub.calls.capture[1].input as { event: { chatText: string | null } }).event.chatText).toBeNull();
    expect(stub.calls.evaluate).toHaveLength(0);
    const giftTopic: Topic = {
      id: 'g-t', priority: 70, heat: 'normal', createdAt: Date.now(),
      kind: 'gifts', events: [gift1], more: 0,
    };
    const giftSource = robotLive.robotPushSource(giftTopic);
    expect(giftSource).not.toBeNull();
    await giftSource!.bind(agent, { id: 'm4' });
    expect(stub.calls.bindMessage).toHaveLength(2);
    // 合并多条礼物的 gifts 话题：不给来源（gift1 已消费；带标记的新礼物使组成超过一条）
    runtime.show.inject(giftEvent('g2', 'u5'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const gift2 = (runtime.show as unknown as { hub: { recentEvents(): LiveEvent[] } }).hub.recentEvents().find((item) => item.id === 'g2')!;
    expect(gift2).toBeDefined();
    const mergedGifts: Topic = {
      id: 'g-t2', priority: 70, heat: 'normal', createdAt: Date.now(),
      kind: 'gifts', events: [gift2, gift1], more: 0,
    };
    expect(robotLive.robotPushSource(mergedGifts)).toBeNull();
    restartShowSession();
  });

  it('F6: disabling with a null binding uses the installed target real revision, not zero', async () => {
    const stub = createStubModule({ policy: { configRevision: 5, enabled: true, cooldownMs: 10000, hasAccepted: true } });
    robotLive.setRobotModuleOverrideForTest(stub.module as never);
    robotLive.resetRobotLiveStateForTest();
    await post('settings', { robotLive: robotConfig() });
    expect(stub.calls.attachBinding[0].expectedRevision).toBe(5);
    // 停用且 bindingId 为空：读已安装目标的真实 revision（启用 CAS 已推到 6），不是 0
    const disabled = await post('settings', { robotLive: robotConfig({ enabled: false, bindingId: null, liveSessionId: null }) });
    expect(disabled.status).toBe(200);
    const disableAttach = stub.calls.attachBinding[1];
    // 关键点：不是 0（替身 policy 是静态 revision 5；真实 journal 会是启用 CAS 后的 6）
    expect(disableAttach.expectedRevision).toBe(5);
    expect((disableAttach.config as { enabled: boolean }).enabled).toBe(false);
    const view = robotLive.robotLiveView();
    expect(view.status).toBe('saved-disabled');
    expect(view.binding).not.toBeNull();
  });

  it('F7: incompatible binding version is rejected with zero rule attach', async () => {
    const stub = createStubModule();
    robotLive.setRobotModuleOverrideForTest({
      ...(stub.module as object),
      attachRobotLiveBinding: async () => ({
        description: { version: 'robot-live/0', journalSchemaVersion: 1, configRevision: 1 },
        capture: async () => { throw new Error('unused'); },
        dispose() { stub.calls.order.push('binding-dispose'); },
      }),
    } as never);
    robotLive.resetRobotLiveStateForTest();
    await post('settings', { robotLive: robotConfig() });
    const view = robotLive.robotLiveView();
    expect(view.status).toBe('inactive');
    expect(view.statusDetail ?? '').toContain('版本不兼容');
    expect(stub.calls.attachRule).toHaveLength(0);
    expect(stub.calls.order).toContain('binding-dispose');
  });

  it('owner routes still work; live keeps running when module is missing', async () => {
    const stub = createStubModule();
    robotLive.setRobotModuleOverrideForTest(stub.module as never);
    robotLive.resetRobotLiveStateForTest();
    await post('settings', { robotLive: robotConfig() });
    const good = await post('robot/task', { taskId: '01234567-89ab-4cde-8f01-234567890abc' });
    expect(good.status).toBe(200);
    // 缺插件：装配失败但直播不受影响
    robotLive.setRobotModuleOverrideForTest(null);
    robotLive.resetRobotLiveStateForTest();
    await post('settings', { robotLive: robotConfig() });
    const view = robotLive.robotLiveView();
    expect(view.status).toBe('inactive');
    expect(view.statusDetail).toContain('机器人插件不可用');
    runtime.show.goLive('session-1');
    runtime.show.inject(chatEvent('alive', 'u6', '还在直播吗'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runtime.show.isOnAir).toBe(true);
    restartShowSession();
  });

  it('R1: invalidation during a pending assembly fences the late grant; the stale handle disposes only itself; later authorized assembly works', async () => {
    let releaseAttach: (() => void) | null = null;
    const attachHold = {
      promise: new Promise<void>((resolve) => { releaseAttach = resolve; }),
      release() { releaseAttach?.(); },
    };
    const stub = createStubModule({ attachHold });
    robotLive.setRobotModuleOverrideForTest(stub.module as never);
    robotLive.resetRobotLiveStateForTest();
    // 开播中的绑定会话上保存启用：装配停在 attach 上（尚无已发布句柄）
    const first = post('settings', { robotLive: robotConfig() });
    await new Promise((resolve) => setTimeout(resolve, 30));
    runtime.show.goLive('session-1');
    // 断连真失效发生在装配发布之前：代次必须仍然推进（R1 种子），不能等句柄出现
    runtime.show.disconnect();
    expect(robotLive.robotLiveView().binding).toBeNull();
    // 释放 attach：迟到的装配不得复活授权——句柄只 dispose 自己，绑定保持空
    attachHold.release();
    await first;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stub.bindingDisposed()).toBe(true);
    expect(robotLive.robotLiveView().binding).toBeNull();
    runtime.show.inject(chatEvent('late-grant', 'ur1', '坐下'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stub.calls.capture).toHaveLength(0);
    // 后续「当前授权装配」仍然工作：owner 重新保存后动作资格恢复
    await post('settings', { robotLive: robotConfig() });
    expect(robotLive.robotLiveView().binding).not.toBeNull();
    runtime.show.inject(chatEvent('reassembled', 'ur2', '坐下'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stub.calls.capture).toHaveLength(1);
    restartShowSession();
  });
});
