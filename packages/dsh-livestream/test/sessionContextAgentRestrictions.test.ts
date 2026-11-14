import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * FEAT-006 评审修正（MEDIUM-1 + 主 Agent 边界 + 二轮 7 项）：限制名单刷新不得依赖 restriction-aware 的 tools.get 可见性；
 * 平台工具 bilibili→douyin→bilibili 往返注销/重注册后，allow 名单必须完整恢复；
 * restrict 失败（并发注销窗口）按 fail-closed 处理并记录诊断，不得静默跳过。
 * 首次限制安装失败必须抛出受控错误（agent/created 串行 listener 内抛出让原生创建/恢复回滚），
 * 不允许「绑定成功但没有限制」的结果。刷新失败后会话本场永久锁定：每步 reject、绑定持续非 ready、
 * 后续刷新不清除标记；旧 allow 名称对应的 preset 工具消失并露出同名 global 时执行次数恒零。
 * preset 可信注册按实例隔离：A 实例卸载不得影响 B 实例同名的可信注册；近 scope 覆盖远 scope
 * （同名 global 被 preset 注册遮蔽），preset 注册注销后同名 global 不获准。
 * pre-step 每步真实调用当前 loader 组合检查（不读创建时缓存），不支持的全局组件启用后拒绝该步。
 *
 * 假 registry 按 installed dsh-tools 0.2.2-rc.1 的可见性语义建模（含真实 global 层与双 preset scope）：
 * view(scope) 返回与限制无关的 restrictableNames 和 restriction-aware 的 visible；
 * inherited（global/祖先 scope）工具受作用域链上所有限制层约束，own scope 注册始终可见；
 * 近 scope 注册遮蔽远 scope 同名注册（nearest-wins）。
 */

interface FakeLayer {
  tools: Map<string, any>;
  restrictions: Array<{ allow?: Set<string>; deny?: Set<string> }>;
}

function createScopedRegistry() {
  const scopes = new Map<string, FakeLayer>([
    ['global', { tools: new Map(), restrictions: [] }],
    ['pluginA', { tools: new Map(), restrictions: [] }],
    ['pluginB', { tools: new Map(), restrictions: [] }],
    ['pluginC', { tools: new Map(), restrictions: [] }],
    ['agent', { tools: new Map(), restrictions: [] }],
  ]);
  const parentOf = new Map<string, string | null>([
    ['global', null],
    ['pluginA', 'global'],
    ['pluginB', 'global'],
    ['pluginC', 'global'],
    ['agent', 'global'],
  ]);
  /** agent 所在的 preset scope：双 preset 共存场景切换归属（真实 cordis 里 scope 链按 preset 实例分叉） */
  let agentParent: 'pluginA' | 'pluginB' = 'pluginA';
  const chain = (scope: string): FakeLayer[] => {
    const out: FakeLayer[] = [];
    let current: string | null = scope === 'agent' ? agentParent : scope;
    if (scope === 'agent') out.unshift(scopes.get('agent')!);
    while (current) {
      out.unshift(scopes.get(current)!);
      current = parentOf.get(current) ?? null;
    }
    return out;
  };
  const admits = (layer: FakeLayer, name: string) => layer.restrictions
    .every((rule) => (rule.allow === undefined || rule.allow.has(name)) && !(rule.deny?.has(name)));

  const registry = {
    /** 模拟并发注销窗口：restrict 主动抛错（installed dsh-tools 对未知名称抛错） */
    throwOnRestrict: null as string | null,
    register(name: string, definition: any, scope = 'pluginA') {
      // 与 installed dsh-tools 一致：层内保存 registration 对象（{definition}），identity 核对读取它
      const registration = { definition };
      scopes.get(scope)!.tools.set(name, registration);
      return () => {
        const layer = scopes.get(scope)!;
        // 只删自己注册的那份 registration（同层重复注册以最后一份为准）
        if (layer.tools.get(name) === registration) layer.tools.delete(name);
      };
    },
    setAgentParent(parent: 'pluginA' | 'pluginB') {
      agentParent = parent;
    },
    /** 与 installed dsh-tools 相同的层链服务：global 层 + 不含 global 的 scope 链（最远祖先在前，含自身层） */
    layers: {
      global: scopes.get('global')!,
      chainLayers(scope: string): FakeLayer[] {
        return chain(scope).filter((layer) => layer !== scopes.get('global')!);
      },
      /** 与 installed dsh-tools 一致：peek(scope) 返回该 scope 自身层对象（chainLayers 含同一实例） */
      peek(scope: string): FakeLayer {
        return scopes.get(scope)!;
      },
    },
    view(scope: string) {
      const layers = chain(scope);
      const own = scopes.get(scope)!;
      // inherited 按「从远到近」顺序覆盖：近 scope 遮蔽远 scope 同名注册（与 installed view 一致）
      const inherited = new Map<string, any>();
      for (const layer of layers) {
        if (layer === own) continue;
        for (const [name, registration] of layer.tools) inherited.set(name, registration);
      }
      const visible = new Map<string, any>();
      const knownNames = new Set<string>();
      const restrictableNames = new Set<string>();
      for (const [name, registration] of inherited) {
        knownNames.add(name);
        restrictableNames.add(name);
        if (layers.every((layer) => admits(layer, name))) visible.set(name, registration.definition);
      }
      for (const [name, registration] of own.tools) {
        knownNames.add(name);
        visible.set(name, registration.definition);
      }
      return { visible, knownNames, restrictableNames };
    },
    get(name: string, scope: string) {
      return registry.view(scope).visible.get(name);
    },
    restrict(filter: { allow?: string[]; deny?: string[] }, scope = 'agent') {
      if (registry.throwOnRestrict) throw new Error(registry.throwOnRestrict);
      const known = registry.view(scope).restrictableNames;
      const unknown = [...filter.allow ?? [], ...filter.deny ?? []].filter((name) => !known.has(name));
      if (unknown.length > 0) throw new Error(`tools.restrict() names unknown global tools ${unknown.map((n) => `"${n}"`).join(', ')}`);
      const layer = scopes.get(scope)!;
      const compiled = {
        ...(filter.allow !== undefined ? { allow: new Set(filter.allow) } : {}),
        ...(filter.deny !== undefined ? { deny: new Set(filter.deny) } : {}),
      };
      layer.restrictions.push(compiled);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        const index = layer.restrictions.indexOf(compiled);
        if (index >= 0) layer.restrictions.splice(index, 1);
      };
    },
  };
  return { registry, scopes };
}

describe('managed session tool restrictions', () => {
  let dir: string;
  let runtime: typeof import('../src/dsh/runtime');
  let sessionContext: typeof import('../src/dsh/sessionContext');
  let agent: typeof import('../src/dsh/agent');
  const { registry, scopes } = createScopedRegistry();
  const loggerWarn = vi.fn();
  const previous = { ...process.env };
  /** 插件注册的事件监听（pre-step 等）：按事件名记录，供组合核对/manifest 注入的直接调用 */
  const pluginListeners = new Map<string, (payload: any, next: () => Promise<any>) => Promise<any>>();
  /** agent ctx 可取到的 loader 假件：entries 可切换/计数，供每步真实组合复核断言 */
  const loaderBox: { current: { entries: () => Iterator<unknown> }; calls: number } = {
    current: { entries: () => [][Symbol.iterator]() },
    calls: 0,
  };
  const loaderWith = (entries: Array<unknown>) => ({
    entries: () => {
      loaderBox.calls += 1;
      return entries[Symbol.iterator]();
    },
  });

  const makePluginCtx = (scope: 'pluginA' | 'pluginB' | 'pluginC') => {
    const ownDisposers: Array<() => void> = [];
    const ctx = {
      effect(effect: () => () => void) {
        const dispose = effect();
        if (typeof dispose === 'function') ownDisposers.push(dispose);
        return dispose;
      },
      get(name: string) {
        return name === 'credentials' ? { resolve: async () => ({ value: '' }), set: async () => {} } : undefined;
      },
      on: (event: string, handler: (payload: any, next: () => Promise<any>) => Promise<any>) => {
        pluginListeners.set(event, handler);
        return () => pluginListeners.delete(event);
      },
      tools: { register: (definition: any, _options?: any) => registry.register(definition.name, definition, scope) },
      logger: { info: () => {}, warn: (...args: unknown[]) => loggerWarn(...args) },
    };
    return {
      ctx,
      /** 卸载该 preset 实例：按注册逆序释放其全部 effect（含工具注册的 trusted 记录） */
      unload: () => {
        for (const dispose of ownDisposers.splice(0).reverse()) dispose();
      },
    };
  };
  const pluginScopeCtx = makePluginCtx('pluginA');

  /** 绑定用的 agent 假件：own scope = agent 层；effect 清理函数可回收以便解绑；cancel 记录刷新失败时的工作取消 */
  const agentCtxFor = (sessionId: string, sink?: Array<() => void>) => ({
    session: { id: sessionId },
    cancels: [] as Array<unknown>,
    cancel(cause: unknown) {
      this.cancels.push(cause);
    },
    ctx: {
      effect(effect: () => () => void) {
        const dispose = effect();
        sink?.push(dispose);
        return dispose;
      },
      get: (name: string) => (name === 'loader' ? loaderBox.current : undefined),
      tools: {
        register: (definition: any) => registry.register(definition.name, definition, 'agent'),
        restrict: (filter: { allow?: string[]; deny?: string[] }) => registry.restrict(filter, 'agent'),
        get: (name: string) => registry.get(name, 'agent'),
        view: () => registry.view('agent'),
        // 与 installed dsh-tools 相同的层链服务（身份核对的数据源，不受限制影响）
        layers: {
          global: scopes.get('global')!,
          chainLayers: () => registry.layers.chainLayers('agent'),
          peek: () => registry.layers.peek('agent'),
        },
      },
    },
  });

  const presetNames = () => [...scopes.get('pluginA')!.tools.keys()].sort();

  const makeSnapshot = (sessionId: string) => ({
    schemaVersion: 1 as const,
    sessionId,
    revision: 1,
    platform: 'bilibili',
    presetId: 'dsh-livestream',
    effectiveCwd: '',
    cwdBinding: null,
    rootBindings: [],
    skills: [],
    issues: [],
    createdAt: Date.now(),
  });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-session-restrict-'));
    process.env.DSH_HOME = dir;
    runtime = await import('../src/dsh/runtime');
    sessionContext = await import('../src/dsh/sessionContext');
    agent = await import('../src/dsh/agent');
    runtime.settings.livePlatform = 'bilibili';
    agent.apply(pluginScopeCtx.ctx as any);
  });

  afterAll(async () => {
    agent.resetSessionBindingStateForTest();
    pluginScopeCtx.unload();
    process.env = previous;
    await rm(dir, { recursive: true, force: true });
  });

  it('starts with a restriction covering every preset tool of the live preset', () => {
    expect(presetNames().length).toBeGreaterThan(20);
    expect(presetNames()).toContain('weather_lookup');
    expect(presetNames()).toContain('view_profile');
  });

  it('restores the full allow list after a bilibili→douyin→bilibili platform roundtrip', async () => {
    const sessionId = 'restrict-roundtrip';
    sessionContext.registerActiveSession(makeSnapshot(sessionId) as any, { ok: true });
    sessionContext.registerObservationSession(sessionId);
    const unbind: Array<() => void> = [];
    await runtime.sessionTools.onCreated!({ agent: agentCtxFor(sessionId, unbind), source: 'create' });
    // 初始限制：allow 覆盖本 preset 当前注册的全部工具，且都真实可见
    const initial = scopes.get('agent')!.restrictions;
    expect(initial).toHaveLength(1);
    expect([...initial[0].allow!].sort()).toEqual(presetNames());
    expect(registry.get('view_profile', 'agent')).toBeDefined();
    expect(registry.get('mute', 'agent')).toBeDefined();
    // 切到抖音：平台工具注销，allow 收缩为常驻工具
    runtime.updateSettings({ livePlatform: 'douyin' });
    expect(registry.get('view_profile', 'agent')).toBeUndefined();
    expect([...scopes.get('agent')!.restrictions[0].allow!]).not.toContain('view_profile');
    expect([...scopes.get('agent')!.restrictions[0].allow!]).toContain('weather_lookup');
    // 切回 B 站：平台工具重注册，allow 名单必须完整恢复（旧实现在这里永久丢失平台工具）
    runtime.updateSettings({ livePlatform: 'bilibili' });
    const restored = [...scopes.get('agent')!.restrictions[0].allow!].sort();
    expect(restored).toEqual(presetNames());
    expect(restored).toContain('view_profile');
    expect(restored).toContain('mute');
    expect(restored).toContain('look');
    expect(restored).toContain('send_dm');
    expect(restored).toContain('game_side');
    expect(registry.get('view_profile', 'agent')).toBeDefined();
    expect(registry.get('mute', 'agent')).toBeDefined();
    // 解除绑定：限制解除、新增工具卸下
    for (const dispose of unbind.splice(0).reverse()) dispose();
    expect(scopes.get('agent')!.restrictions).toHaveLength(0);
    expect(scopes.get('agent')!.tools.has('load_livestream_skill')).toBe(false);
  });

  it('fails closed with diagnostics when restrict rejects during a concurrent unregister window', async () => {
    const sessionId = 'restrict-failclosed';
    sessionContext.registerActiveSession(makeSnapshot(sessionId) as any, { ok: true });
    sessionContext.registerObservationSession(sessionId);
    const unbind: Array<() => void> = [];
    const instance = agentCtxFor(sessionId, unbind);
    await runtime.sessionTools.onCreated!({ agent: instance, source: 'create' });
    expect(scopes.get('agent')!.tools.has('load_livestream_skill')).toBe(true);
    expect(scopes.get('agent')!.restrictions).toHaveLength(1);
    loggerWarn.mockClear();
    // 并发注销窗口：restrict 抛错（installed dsh-tools 对未知名称抛错）
    registry.throwOnRestrict = 'tools.restrict() names unknown global tool "view_profile"';
    try {
      runtime.updateSettings({ livePlatform: 'douyin' });
    } finally {
      registry.throwOnRestrict = null;
    }
    // fail-closed：该会话的两个新增工具不可用（已卸下）
    expect(scopes.get('agent')!.tools.has('load_livestream_skill')).toBe(false);
    expect(scopes.get('agent')!.tools.has('read_livestream_material')).toBe(false);
    // 不暴露未限制的全局面：旧限制保留（未 lift，也未叠加新层）
    expect(scopes.get('agent')!.restrictions).toHaveLength(1);
    expect([...scopes.get('agent')!.restrictions[0].allow!]).toContain('view_profile');
    // 有诊断
    const notes = loggerWarn.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
    expect(notes).toContain('限制');
    expect(notes).toContain(sessionId);
    // 刷新失败：保留旧安全限制之外，还要取消该会话当前工作并锁定不可用
    expect(instance.cancels.length).toBeGreaterThan(0);
    expect(runtime.sessionTools.verify?.(sessionId)?.bound).toBe(false);
    // 平台恢复后刷新成功：限制恢复，但 fail-closed 的工具保持不可用（本场不回装）
    runtime.updateSettings({ livePlatform: 'bilibili' });
    expect(scopes.get('agent')!.tools.has('load_livestream_skill')).toBe(false);
    expect(scopes.get('agent')!.restrictions[0].allow).toContain('view_profile');
    for (const dispose of unbind.splice(0).reverse()) dispose();
    expect(scopes.get('agent')!.restrictions).toHaveLength(0);
  });

  it('rejects creation when the very first restriction install fails, leaving no unrestricted binding', async () => {
    const sessionId = 'restrict-firstfail';
    sessionContext.registerActiveSession(makeSnapshot(sessionId) as any, { ok: true });
    sessionContext.registerObservationSession(sessionId);
    loggerWarn.mockClear();
    registry.throwOnRestrict = 'tools.restrict() requires a scoped context';
    const bound = agentCtxFor(sessionId);
    let rejection: unknown = null;
    try {
      // 首装失败：agent/created 处理器抛出受控错误，原生创建/恢复据此回滚；不得返回绑定成功
      await runtime.sessionTools.onCreated!({ agent: bound, source: 'create' });
    } catch (error) {
      rejection = error;
    } finally {
      registry.throwOnRestrict = null;
    }
    expect(rejection, 'first-install failure must reject the managed session binding').toBeInstanceOf(Error);
    expect((rejection as Error).message).toContain(sessionId);
    // 两个新增工具不可用、无限制层残留、有诊断
    expect(scopes.get('agent')!.tools.has('load_livestream_skill')).toBe(false);
    expect(scopes.get('agent')!.tools.has('read_livestream_material')).toBe(false);
    expect(scopes.get('agent')!.restrictions).toHaveLength(0);
    const notes = loggerWarn.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
    expect(notes).toContain('限制');
    // 绑定状态核对为未绑定；fail-closed 保持：该会话不再重试绑定
    expect(runtime.sessionTools.verify?.(sessionId)?.bound).toBe(false);
    await expect(runtime.sessionTools.onCreated!({ agent: bound, source: 'create' })).rejects.toThrow();
    expect(scopes.get('agent')!.tools.has('load_livestream_skill')).toBe(false);
  });

  it('treats a session without any snapshot as legacy and installs no restrictions', async () => {
    const sessionId = 'restrict-legacy-session';
    const instance = agentCtxFor(sessionId);
    await expect(runtime.sessionTools.onCreated!({ agent: instance, source: 'create' })).resolves.toBeUndefined();
    expect(scopes.get('agent')!.tools.has('load_livestream_skill')).toBe(false);
    expect(scopes.get('agent')!.restrictions).toHaveLength(0);
    expect(runtime.sessionTools.verify?.(sessionId)?.bound).toBe(false);
  });

  // ── FEAT-006 修正：pre-step 只做有效性/宿主组合核对、预算重置与 manifest 注入，不做首次安全安装 ──

  const preStep = async (payload: { session: { id: string }; turn: number }, nextResult: any) => {
    const handler = pluginListeners.get('agent/pre-step');
    expect(handler, 'plugin should have registered an agent/pre-step listener').toBeTypeOf('function');
    let nextCalled = false;
    const decision = await handler!({
      // pre-step 每步经 agent.ctx 取当前 loader 做真实组合复核
      agent: { session: payload.session, ctx: { get: (name: string) => (name === 'loader' ? loaderBox.current : undefined) } },
      turn: payload.turn,
    }, async () => {
      nextCalled = true;
      return nextResult;
    });
    return { decision, nextCalled: () => nextCalled };
  };

  it('rejects the whole step when the live loader has a loading global component (cannot confirm isolation)', async () => {
    const sessionId = 'prestep-loading-composition';
    sessionContext.registerActiveSession(makeSnapshot(sessionId) as any, { ok: true });
    // 全局组件仍在加载（fiber 未激活）：无法确认隔离 → 拒绝该步
    loaderBox.current = loaderWith([{ options: { name: '@deepseek-ai/dsh-tool-skill' }, disabled: false, fiber: { isActive: false } }]);
    const { decision, nextCalled } = await preStep({ session: { id: sessionId }, turn: 1 }, { kind: 'enter', messages: [] });
    expect(decision).toEqual({ kind: 'reject' });
    expect(nextCalled()).toBe(false);
    // 恢复干净 loader，不向后续用例泄漏
    loaderBox.current = { entries: () => [][Symbol.iterator]() };
    sessionContext.clearActiveSessionsForTest();
    agent.resetSessionBindingStateForTest();
  });

  it('injects the capability manifest once for a healthy managed session', async () => {
    const sessionId = 'prestep-manifest';
    sessionContext.registerActiveSession(makeSnapshot(sessionId) as any, { ok: true });
    const nextResult = { kind: 'enter', messages: [{ id: 'base', role: 'user', content: [{ type: 'text', text: '开场' }] }] };
    const first = await preStep({ session: { id: sessionId }, turn: 1 }, nextResult);
    expect(first.nextCalled()).toBe(true);
    expect(first.decision?.kind).toBe('enter');
    const injected = first.decision.messages.at(-1);
    expect(injected?.source?.kind).toBe('dsh-livestream');
    // manifest 以插件自有 source 注入（不冒充 owner/user），正文列出本场能力边界
    expect(JSON.stringify(injected?.content)).toContain('主人为本场直播启用了会话资料能力');
    // 同一会话第二次步骤不再重复注入
    const second = await preStep({ session: { id: sessionId }, turn: 2 }, nextResult);
    expect(second.decision).toEqual(nextResult);
    sessionContext.clearActiveSessionsForTest();
    agent.resetSessionBindingStateForTest();
  });

  it('locks the session permanently after a failed refresh: steps reject, marker survives later refreshes', async () => {
    const sessionId = 'prestep-failclosed';
    sessionContext.registerActiveSession(makeSnapshot(sessionId) as any, { ok: true });
    sessionContext.registerObservationSession(sessionId);
    const unbind: Array<() => void> = [];
    const instance = agentCtxFor(sessionId, unbind);
    await runtime.sessionTools.onCreated!({ agent: instance, source: 'create' });
    // 旧 allow 里有 public_search：refresh 失败后在 global 层放一个同名 impostor，记录其执行次数
    let impostorExecutions = 0;
    const impostor = { name: 'public_search', execute: async () => { impostorExecutions += 1; return 'IMPOSTOR'; } };
    registry.register('public_search', impostor, 'global');
    const restrictionsBeforeFailure = scopes.get('agent')!.restrictions.length;
    // 触发刷新失败（fail-closed：工具卸下、取消工作、本场锁定）
    registry.throwOnRestrict = 'tools.restrict() names unknown global tool "view_profile"';
    try {
      runtime.updateSettings({ livePlatform: 'douyin' });
    } finally {
      registry.throwOnRestrict = null;
    }
    expect(instance.cancels.length).toBeGreaterThan(0);
    expect(runtime.sessionTools.verify?.(sessionId)?.bound).toBe(false);
    // 刷新失败后的每一步必须整体拒绝：不调用 next（下游 skill 监听器不得继续），不注入任何能力
    const nextResult = { kind: 'enter', messages: [{ id: 'base', role: 'user', content: [] }] };
    const outcome = await preStep({ session: { id: sessionId }, turn: 3 }, nextResult);
    expect(outcome.decision).toEqual({ kind: 'reject' });
    expect(outcome.nextCalled()).toBe(false);
    expect(JSON.stringify(outcome.decision)).not.toContain('load_livestream_skill');
    // 故障链下同名 global 执行次数恒零（步骤被拒绝，模型永远走不到工具执行）
    expect(impostorExecutions).toBe(0);
    // 平台恢复后的后续刷新不得清除标记、不得自动恢复、不得宣称绑定成功
    runtime.updateSettings({ livePlatform: 'bilibili' });
    expect(runtime.sessionTools.verify?.(sessionId)?.bound).toBe(false);
    expect(scopes.get('agent')!.tools.has('load_livestream_skill')).toBe(false);
    expect(scopes.get('agent')!.restrictions).toHaveLength(restrictionsBeforeFailure);
    // 锁定会话的每一步继续拒绝
    const still = await preStep({ session: { id: sessionId }, turn: 4 }, nextResult);
    expect(still.decision).toEqual({ kind: 'reject' });
    expect(still.nextCalled()).toBe(false);
    for (const dispose of unbind.splice(0).reverse()) dispose();
    sessionContext.clearActiveSessionsForTest();
    agent.resetSessionBindingStateForTest();
    scopes.get('global')!.tools.delete('public_search');
  });

  it('re-checks the live loader composition every pre-step instead of the create-time cache', async () => {
    const sessionId = 'prestep-live-composition';
    sessionContext.registerActiveSession(makeSnapshot(sessionId) as any, { ok: true });
    loaderBox.current = loaderWith([]);
    loaderBox.calls = 0;
    const nextResult = { kind: 'enter', messages: [] };
    const first = await preStep({ session: { id: sessionId }, turn: 1 }, nextResult);
    expect(first.nextCalled()).toBe(true);
    // 第一步真实调用了当前 loader（不是创建时缓存）
    const callsAfterFirst = loaderBox.calls;
    expect(callsAfterFirst).toBeGreaterThan(0);
    // 安全创建后宿主启用全局 tool-skill：下一步必须拒绝且不调用 next / 下游监听器
    loaderBox.current = loaderWith([{ options: { name: '@deepseek-ai/dsh-tool-skill' }, disabled: false, fiber: { isActive: true } }]);
    const second = await preStep({ session: { id: sessionId }, turn: 2 }, nextResult);
    expect(second.decision).toEqual({ kind: 'reject' });
    expect(second.nextCalled()).toBe(false);
    expect(loaderBox.calls).toBeGreaterThan(callsAfterFirst);
    // loader 不可检查（缺失）同样拒绝：无法确认隔离不继续
    loaderBox.current = undefined as unknown as typeof loaderBox.current;
    const third = await preStep({ session: { id: sessionId }, turn: 3 }, nextResult);
    expect(third.decision).toEqual({ kind: 'reject' });
    expect(third.nextCalled()).toBe(false);
    // 恢复干净 loader，不向后续用例泄漏
    loaderBox.current = { entries: () => [][Symbol.iterator]() };
    sessionContext.clearActiveSessionsForTest();
    agent.resetSessionBindingStateForTest();
  });

  it('computes the allow list from per-instance trusted registrations (preset A unload keeps preset B tools)', async () => {
    // 双 preset 实例共存（同一插件在两个 preset 各 apply 一次，注册同名工具到各自 scope）：
    // 真实 cordis 里 agent 的 scope 链只经过自己 preset 的实例；A 卸载不得影响 B 的可信注册。
    // 第三个实例 C 只充当平台切换触发器（两个主角先后卸载后刷新仍要能发生）。
    const presetB = makePluginCtx('pluginB');
    agent.apply(presetB.ctx as any);
    registry.setAgentParent('pluginB');
    const sessionId = 'restrict-two-presets';
    sessionContext.registerActiveSession(makeSnapshot(sessionId) as any, { ok: true });
    sessionContext.registerObservationSession(sessionId);
    const unbind: Array<() => void> = [];
    await runtime.sessionTools.onCreated!({ agent: agentCtxFor(sessionId, unbind), source: 'create' });
    const allowBefore = [...scopes.get('agent')!.restrictions[0].allow!].sort();
    expect(allowBefore).toContain('show_stats');
    expect(allowBefore).toContain('weather_lookup');
    // C 实例随后 apply：只提供 platform change 的刷新触发；会话的 owner 仍是 B
    const presetC = makePluginCtx('pluginC');
    agent.apply(presetC.ctx as any);
    // 同名 global 放在绑定之后：近 scope 遮蔽远 scope，可见的必须是 preset 注册的 definition
    const impostor = { name: 'show_stats', execute: async () => 'IMPOSTOR' };
    registry.register('show_stats', impostor, 'global');
    expect(registry.get('show_stats', 'agent')).not.toBe(impostor);
    // A 实例卸载（经过它自己的注册 disposer：trusted 记录 + registry 一并释放），B 仍活着 → 刷新由 B 触发
    pluginScopeCtx.unload();
    runtime.updateSettings({ livePlatform: 'douyin' });
    const allowAfter = [...scopes.get('agent')!.restrictions.at(-1)!.allow!].sort();
    // B 的可信注册不受 A 卸载影响：allow 完整保留
    expect(allowAfter).toContain('show_stats');
    expect(allowAfter).toContain('weather_lookup');
    expect(registry.get('show_stats', 'agent')).not.toBe(impostor);
    expect(registry.get('show_stats', 'agent')).toBeDefined();
    // B 也卸载同名工具后（刷新由 C 触发）：allow 收缩，同名 global 不获准（不凭名称放行未经本实例注册的工具）
    presetB.unload();
    runtime.updateSettings({ livePlatform: 'bilibili' });
    const afterRemoval = scopes.get('agent')!.restrictions.at(-1)!;
    expect(afterRemoval.allow).not.toContain('show_stats');
    expect(registry.get('show_stats', 'agent')).toBeUndefined();
    for (const dispose of unbind.splice(0).reverse()) dispose();
    sessionContext.clearActiveSessionsForTest();
    agent.resetSessionBindingStateForTest();
    registry.setAgentParent('pluginA');
    scopes.get('global')!.tools.delete('show_stats');
    scopes.get('pluginB')!.tools.clear();
    scopes.get('pluginA')!.tools.clear();
    scopes.get('pluginC')!.tools.clear();
    presetC.unload();
  });

  // ── 三轮（A）：名单按可信注册的真实 definition 身份核对，不凭名称 ──

  it('excludes a trusted name whose chain registration no longer matches the registered definition', async () => {
    // 前面的双 preset 用例卸载了各实例：重新 apply 一个健康实例作为本组身份核对的可信注册来源
    agent.apply(pluginScopeCtx.ctx as any);
    const sessionId = 'restrict-identity-takeover';
    sessionContext.registerActiveSession(makeSnapshot(sessionId) as any, { ok: true });
    sessionContext.registerObservationSession(sessionId);
    const unbind: Array<() => void> = [];
    await runtime.sessionTools.onCreated!({ agent: agentCtxFor(sessionId, unbind), source: 'create' });
    expect(scopes.get('agent')!.restrictions[0].allow).toContain('show_stats');
    // 记下本实例注册的原 definition；随后同层被另一份不同 definition 的注册替换（如同 scope 重挂载/再注册）
    const trustedShowStats = scopes.get('pluginA')!.tools.get('show_stats')!.definition;
    const impostor = { name: 'show_stats', execute: async () => 'IMPOSTOR' };
    scopes.get('pluginA')!.tools.set('show_stats', { definition: impostor });
    // 同名 global 也同时存在：身份不符时不得借名获准（无论近层替换还是远层同名）
    registry.register('show_stats', impostor, 'global');
    runtime.updateSettings({ livePlatform: 'douyin' });
    const refreshed = scopes.get('agent')!.restrictions.at(-1)!;
    expect(refreshed.allow, 'identity mismatch must drop the name from the allow list').not.toContain('show_stats');
    // 被限制排除：替换定义与同名 global 都不可见
    expect(registry.get('show_stats', 'agent')).toBeUndefined();
    // 恢复本实例的原 definition 注册后刷新：名单按身份恢复
    scopes.get('pluginA')!.tools.set('show_stats', { definition: trustedShowStats });
    runtime.updateSettings({ livePlatform: 'bilibili' });
    expect(scopes.get('agent')!.restrictions.at(-1)!.allow).toContain('show_stats');
    expect(registry.get('show_stats', 'agent')).not.toBe(impostor);
    for (const dispose of unbind.splice(0).reverse()) dispose();
    sessionContext.clearActiveSessionsForTest();
    agent.resetSessionBindingStateForTest();
    scopes.get('global')!.tools.delete('show_stats');
  });

  it('fails the first install closed when the registry chain cannot be inspected (no name-only fallback)', async () => {
    const sessionId = 'restrict-no-chain';
    sessionContext.registerActiveSession(makeSnapshot(sessionId) as any, { ok: true });
    sessionContext.registerObservationSession(sessionId);
    loggerWarn.mockClear();
    // agent 假件缺 layers 层链服务：身份无法核实 → 首装必须失败，不产生「仅凭名称」的名单
    const noChain = agentCtxFor(sessionId);
    delete (noChain as any).ctx.tools.layers;
    await expect(runtime.sessionTools.onCreated!({ agent: noChain, source: 'create' })).rejects.toThrow(/身份|限制名单安装失败/);
    expect(scopes.get('agent')!.tools.has('load_livestream_skill')).toBe(false);
    expect(scopes.get('agent')!.tools.has('read_livestream_material')).toBe(false);
    expect(scopes.get('agent')!.restrictions).toHaveLength(0);
    const notes = loggerWarn.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
    expect(notes).toContain('限制');
    expect(runtime.sessionTools.verify?.(sessionId)?.bound).toBe(false);
    sessionContext.clearActiveSessionsForTest();
    agent.resetSessionBindingStateForTest();
  });

  it('R3: a managed session with robot enabled creates/reconfigures via the inherited-only allow; revoke never borrows a same-name global', async () => {
    const robotLive = await import('../src/dsh/robotLive');
    robotLive.resetRobotLiveStateForTest();
    const robotConfig = { version: 'robot-live/1', enabled: true, liveSessionId: 'robot-managed', bindingId: 'binding-1', allowedActions: ['greeting'], rules: [], cooldownMs: 1000 };
    // robot 替身：caller 在 agent 自身 scope 注册四个工具（与 Q caller 相同的 own-scope 语义）
    let ownRegistered = 0;
    // 镜像 Q caller 的真实撤销语义：caller 的 own-scope 注册挂在 binding 的 grants 上，
    // binding.dispose 时一并撤销（fixture.ts disposeLiveBinding 遍历 host.grants）
    let grantCallerDisposers: Array<() => void> = [];
    const robotStub = {
      async readRobotLivePolicy() { return { configRevision: 5, enabled: true, cooldownMs: 10000, authoritySha: '0'.repeat(64), hasAccepted: true }; },
      async attachRobotLiveBinding() {
        const handle = {
          description: { version: 'robot-live/1', journalSchemaVersion: 2, configRevision: 6 },
          async capture() { return { receiptId: 'r1' }; },
          dispose() {
            // Q disposeLiveBinding：撤销全部 grants（caller 的 own-scope 注册随撤销移除）
            for (const dispose of grantCallerDisposers.splice(0)) dispose();
          },
        };
        return handle;
      },
      attachRobotLiveRule() {
        return { async evaluate() { return null; }, async get() { return null; }, cancel() { return null; }, dispose() {} };
      },
      bindRobotLiveMessage() {},
      attachRobotLiveCaller(agentCtx: { tools: { register(definition: any): () => void } }) {
        const disposers = ['robot_task_capabilities', 'robot_task_submit', 'robot_task_get', 'robot_task_cancel'].map((name) =>
          agentCtx.tools.register({ name, execute: async () => 'unused' }),
        );
        ownRegistered += disposers.length;
        grantCallerDisposers.push(...disposers);
        return () => {
          for (const dispose of disposers) dispose();
          grantCallerDisposers = grantCallerDisposers.filter((entry) => !disposers.includes(entry));
        };
      },
    };
    robotLive.setRobotModuleOverrideForTest(robotStub as never);
    runtime.settings.robotLive = robotConfig;
    // 传入宿主 ctx（生产由插件 effect 传入；缺 ctx 时装配会因 hostContext 为空而跳过）
    await robotLive.applyRobotLiveSettings({} as never);
    // 受管会话创建（robot 已启用、own 工具已随 agent/created 注册）：initial restriction 必须成功——
    // 修复前 allow 混入 own 名称，实际 SDK 的 restrict 会抛 unknown-global-tool 并回滚创建
    const sessionId = 'robot-managed';
    sessionContext.registerActiveSession(makeSnapshot(sessionId) as never, { ok: true });
    sessionContext.registerObservationSession(sessionId);
    const unbind: Array<() => void> = [];
    await runtime.sessionTools.onCreated!({ agent: agentCtxFor(sessionId, unbind), source: 'create' });
    expect(ownRegistered).toBe(4);
    // allow 只含继承层 preset 工具；robot 工具以 own scope 豁免限制可见
    const restriction = scopes.get('agent')!.restrictions;
    expect(restriction).toHaveLength(1);
    expect([...restriction[0].allow!].sort()).toEqual(presetNames());
    expect([...restriction[0].allow!]).not.toContain('robot_task_submit');
    expect(registry.get('robot_task_submit', 'agent')).toBeDefined();
    expect(runtime.sessionTools.verify?.(sessionId)?.bound).toBe(true);
    // 重配：刷新路径成功且不锁定（修复前同一路径抛错并进入 refreshLockedSessions）
    runtime.settings.robotLive = { ...robotConfig, cooldownMs: 2000 };
    await robotLive.applyRobotLiveSettings();
    expect(runtime.sessionTools.verify?.(sessionId)).toEqual({ bound: true });
    expect(ownRegistered).toBe(8); // 重装路径先撤旧 caller 再装新（注册数翻倍）
    expect(registry.get('robot_task_submit', 'agent')).toBeDefined();
    // 停用：own 注册随撤销移除；之后出现的同名 global 不借 allow 获准
    runtime.settings.robotLive = { ...robotConfig, enabled: false, bindingId: null, liveSessionId: null, allowedActions: [], rules: [] };
    await robotLive.applyRobotLiveSettings();
    // 停用撤销 binding 时 grants 一并撤销（Q disposeLiveBinding 语义）：own 注册随之移除
    expect(registry.get('robot_task_submit', 'agent')).toBeUndefined();
    registry.register('robot_task_submit', { name: 'robot_task_submit', execute: async () => 'global' }, 'global');
    expect(registry.get('robot_task_submit', 'agent')).toBeUndefined();
    // 清理：移除同名 global，恢复无 robot 状态，不影响其他用例
    scopes.get('global')!.tools.delete('robot_task_submit');
    runtime.settings.robotLive = undefined;
    robotLive.setRobotModuleOverrideForTest(null);
    robotLive.resetRobotLiveStateForTest();
    for (const dispose of unbind.splice(0).reverse()) dispose();
    sessionContext.clearActiveSessionsForTest();
    agent.resetSessionBindingStateForTest();
  });
});
