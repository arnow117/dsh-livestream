import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * FEAT-006 评审修正（MEDIUM-2）：持久快照的恢复路径。
 *
 * 重启/手动打开原会话按 id 恢复原定义：磁盘快照校验（深度、绑定形状、大小）通过后重建
 * activeSession 绑定、重装两个受限工具与限制名单、重查路径有效性（失效项在 issues 标记）；
 * verifyManagedOnair 必须识别磁盘上有管理快照的 sessionId——内存未注册但磁盘有快照先恢复再核验，
 * 恢复失败/invalid 拒绝 onair（409 + 可修正提示），不得当作非管理会话放行。
 */

describe('managed session restore from persisted snapshots', () => {
  let dir: string;
  let runtime: typeof import('../src/dsh/runtime');
  let sessionContext: typeof import('../src/dsh/sessionContext');
  let agent: typeof import('../src/dsh/agent');
  let routes: Map<string, (request: Request) => Response | Promise<Response>>;
  const previous = { ...process.env };
  const nativeCreates: Array<Record<string, unknown>> = [];
  const agents = new Map<string, any>();
  const pluginDisposers: Array<() => void> = [];
  /** 注入的首装失败：makeAgent 的 restrict 在非 null 时抛错（模拟首装失败 → 创建整体回滚） */
  let restrictFailure: string | null = null;

  const snapshotDir = () => join(dir, 'dsh-livestream', 'session-context');

  const makeAgent = (sessionId: string, cwd: string | undefined, preset: string | undefined) => {
    const registered: string[] = [];
    const restrictions: Array<{ allow: string[] }> = [];
    const unbind: Array<() => void> = [];
    const instance = {
      session: { id: sessionId, header: { id: sessionId, cwd, agentPreset: preset } },
      registered,
      restrictions,
      unbind,
      cancels: [] as Array<unknown>,
      cancel(cause: unknown) {
        this.cancels.push(cause);
      },
      ctx: {
        effect(effect: () => () => void) {
          const dispose = effect();
          unbind.push(dispose);
          return dispose;
        },
        get: (name: string) => (name === 'loader' ? { entries: () => [][Symbol.iterator]() } : undefined),
        tools: {
          register: (definition: any) => {
            registered.push(definition.name);
            return () => {
              const index = registered.indexOf(definition.name);
              if (index >= 0) registered.splice(index, 1);
            };
          },
          restrict: (filter: { allow?: string[] }) => {
            if (restrictFailure) throw new Error(restrictFailure);
            // lift 移除对应限制层（与 installed dsh-tools 的 layers.effect 语义一致）
            const entry = { allow: [...filter.allow ?? []] };
            restrictions.push(entry);
            return () => {
              const index = restrictions.indexOf(entry);
              if (index >= 0) restrictions.splice(index, 1);
            };
          },
          get: () => undefined,
          view: () => ({ knownNames: new Set(registered), restrictableNames: new Set(['weather_lookup', 'public_search', 'show_stats']) }),
          // 身份核对数据源（与 installed dsh-tools 形状一致；此假件未建模 preset 层注册）
          layers: { global: { tools: new Map() }, chainLayers: () => [] },
        },
      },
    };
    return instance;
  };

  const post = async (path: string, data: unknown) => {
    const response = await routes.get(`/api/dsh-livestream/${path}`)!(new Request('http://localhost/', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data),
    }));
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };

  const save = async (overrides: Record<string, unknown> = {}, expectedRevision?: number) => {
    const current = sessionContext.stateView();
    const revision = expectedRevision ?? current.saved?.revision ?? 0;
    const base = {
      enabled: true,
      cwd: join(dir, 'workdir'),
      skillSources: [{ path: join(dir, 'skills', 'papermorph.md'), enabled: true }],
      readRoots: [{ path: join(dir, 'materials'), enabled: true }],
    };
    return post('settings', { sessionContext: { expectedRevision: revision, config: { ...base, ...overrides } } });
  };

  const createSession = async () => {
    const created = await post('sessions', {});
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    return created.body as { sessionId: string; sessionContext: { skills: Array<{ name: string; contentHash: string | null }> } };
  };

  /** 模拟进程重启：旧进程的工具注册/限制随 dispose 消失，插件进程内的登记与绑定状态全部清空（native 会话仍在） */
  const simulateRestart = () => {
    for (const instance of agents.values()) {
      for (const dispose of instance.unbind.splice(0)) dispose();
    }
    sessionContext.clearActiveSessionsForTest();
    agent.resetSessionBindingStateForTest();
    expect(sessionContext.stateView().active).toBeNull();
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-session-restore-'));
    process.env.DSH_HOME = dir;
    await mkdir(join(dir, 'workdir'), { recursive: true });
    await mkdir(join(dir, 'skills'), { recursive: true });
    await mkdir(join(dir, 'materials', '课件'), { recursive: true });
    await writeFile(join(dir, 'skills', 'papermorph.md'), '---\nname: papermorph\ndescription: 把文章做成可翻页的网页书。\n---\nPapermorph 恢复正文。\n');
    await writeFile(join(dir, 'materials', '课件', 'lesson-1.txt'), '恢复路径资料内容。\n');
    runtime = await import('../src/dsh/runtime');
    sessionContext = await import('../src/dsh/sessionContext');
    agent = await import('../src/dsh/agent');
    // 与生产接线一致：完整应用 agent 子插件（apply 内把 onCreated/verify 放到运行时回调上，并注册 preset-scoped agent/created 监听）
    agent.apply({
      effect(effect: () => () => void) {
        const dispose = effect();
        if (typeof dispose === 'function') pluginDisposers.push(dispose);
      },
      get: () => undefined,
      on: () => () => {},
      tools: { register: () => () => {} },
      logger: { info: () => {}, warn: () => {} },
    } as any);
    const host = await import('../src/dsh/index');
    routes = new Map();
    host.apply({
      effect(effect: () => unknown, label?: string) {
        if (['dsh-livestream credentials', 'state', 'settings', 'session context recheck', 'sessions', 'onair', 'offair'].includes(label ?? '')) effect();
      },
      provide() {},
      get(name: string) {
        if (name === 'credentials') return { resolve: async () => ({ value: '' }), set: async () => {} };
        if (name === 'sessionController') {
          return {
            create: async (request: Record<string, unknown>) => {
              nativeCreates.push(request);
              if (request.cwd !== undefined && request.workspaceId !== undefined) throw new Error('native contract violation');
              const canonicalCwd = request.cwd !== undefined ? await realpath(String(request.cwd)) : `/workspaces/${String(request.workspaceId)}`;
              const instance = makeAgent(String(request.sessionId), canonicalCwd, request.agentPreset === undefined ? undefined : String(request.agentPreset));
              agents.set(String(request.sessionId), instance);
              // 与原生一致：preset-scoped 串行 agent/created 在 create 返回前完成恢复与受限绑定；listener 抛错 → 本次创建被回滚（create 拒绝）
              await runtime.sessionTools.onCreated?.({ agent: instance, source: 'create' });
              return { sessionId: request.sessionId, ...(request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset }) };
            },
          };
        }
        if (name === 'agents') return { get: (id: string) => agents.get(id) };
        if (name === 'workingDirectory') return { get: (session: any) => session?.header?.cwd ?? null };
        if (name === 'loader') return { entries: () => [][Symbol.iterator]() };
        return undefined;
      },
      connection: { fetch: { register(route: { path: string; fetch: (request: Request) => Response }) { routes.set(route.path, route.fetch); return () => {}; } } },
    });
  });

  afterAll(async () => {
    agent.resetSessionBindingStateForTest();
    for (const dispose of pluginDisposers.splice(0).reverse()) dispose();
    process.env = previous;
    await rm(dir, { recursive: true, force: true });
  });

  it('restores a managed session from its disk snapshot after a simulated restart', async () => {
    const saved = await save();
    expect(saved.status).toBe(200);
    const created = await createSession();
    const sessionId = created.sessionId;
    // 冻结正文可用，随后清空内存状态模拟重启
    expect(sessionContext.loadSkill(sessionId, 'papermorph').status).toBe('loaded');
    simulateRestart();
    // 冷恢复走原生 resume 的串行 agent/created：磁盘快照恢复 → 重装工具与限制名单，全部在恢复返回前完成；无手动 bind/restore
    await runtime.sessionTools.onCreated!({ agent: agents.get(sessionId), source: 'resume' });
    const instance = agents.get(sessionId);
    expect(instance.registered).toContain('load_livestream_skill');
    expect(instance.registered).toContain('read_livestream_material');
    expect(instance.restrictions).toHaveLength(1);
    expect(runtime.sessionTools.verify?.(sessionId)?.bound).toBe(true);
    // 恢复后的定义与重启前一致（同一冻结正文）
    const loaded = sessionContext.loadSkill(sessionId, 'papermorph');
    expect(loaded.status).toBe('loaded');
    if (loaded.status === 'loaded') expect(loaded.body).toContain('恢复正文');
    const read = await sessionContext.readMaterial(sessionId, { rootId: 'root-1', path: '课件/lesson-1.txt' });
    expect(read.status).toBe('available');
    // onair 核对通过；owner 活动视图按实际开播状态显示当前直播会话（R7：未开播时 active 为 null）
    expect((await sessionContext.verifyManagedOnair(sessionId)).ok).toBe(true);
    expect(sessionContext.stateView().active).toBeNull();
    runtime.show.goLive(sessionId, undefined);
    expect(sessionContext.stateView().active?.sessionId).toBe(sessionId);
    runtime.show.endLive();
    // 立即收束 90s 道别宽限（finish 是 endLive 之后 onAir 变 false 的原生路径）
    (runtime.show as any).finish();
    expect(sessionContext.stateView().active).toBeNull();
    clearInterval((runtime.show as any).director);
    (runtime.show as any).director = null;
  });

  it('rejects onair with a correctable message when the disk snapshot is corrupted', async () => {
    const saved = await save();
    expect(saved.status).toBe(200);
    const created = await createSession();
    const sessionId = created.sessionId;
    simulateRestart();
    await writeFile(join(snapshotDir(), `${sessionId}.json`), '不是 JSON 的损坏内容');
    const verdict = await sessionContext.verifyManagedOnair(sessionId);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.error).toContain('快照');
    // 路由同样拒绝（409），且不能当作非管理会话放行
    const routed = await post('onair', { sessionId });
    expect(routed.status).toBe(409);
    expect(routed.body.error).toContain('快照');
    // 恢复入口返回 invalid（不降级为未管理），绑定入口拒绝；冷 resume 同样必须拒绝
    const outcome = await sessionContext.restoreManagedSnapshot(sessionId);
    expect(outcome.kind).toBe('invalid');
    await expect(runtime.sessionTools.onCreated!({ agent: agents.get(sessionId), source: 'resume' })).rejects.toThrow(/快照/);
    expect(runtime.show.isOnAir).toBe(false);
  });

  it('never restores or rebinds during onair: an unrestored managed session is rejected with zero goLive calls', async () => {
    const saved = await save();
    expect(saved.status).toBe(200);
    const created = await createSession();
    const sessionId = created.sessionId;
    simulateRestart();
    // 磁盘快照存在但本进程从未恢复（agent/created 没跑过）：onair 只核对，不补绑/不恢复成 ready
    expect(sessionContext.readSnapshot(sessionId).ok).toBe(true);
    const goLive = vi.fn();
    const original = runtime.show.goLive;
    runtime.show.goLive = goLive as unknown as typeof runtime.show.goLive;
    try {
      const routed = await post('onair', { sessionId });
      expect(routed.status).toBe(409);
      expect(routed.body.error).toContain('恢复');
    } finally {
      runtime.show.goLive = original;
    }
    expect(goLive, 'onair must not reach goLive for an unrestored managed session').not.toHaveBeenCalled();
    expect(sessionContext.stateView().active?.sessionId).toBeUndefined();
    // 但真正的恢复路径（冷 resume）依然可用，恢复后 onair 才放行
    await runtime.sessionTools.onCreated!({ agent: agents.get(sessionId), source: 'resume' });
    expect(runtime.sessionTools.verify?.(sessionId)?.bound).toBe(true);
    const routedAgain = await post('onair', { sessionId });
    expect(routedAgain.status).toBe(200);
    // 下播复原（R7：owner active 依赖真实开播状态，不向后续用例泄漏 onAir）；立即收束道别宽限
    await post('offair', {});
    (runtime.show as any).finish();
    expect(runtime.show.isOnAir).toBe(false);
    clearInterval((runtime.show as any).director);
    (runtime.show as any).director = null;
  });

  it('rejects onair when the managed binding is not ready (first-install or refresh failure), without restoring', async () => {
    const saved = await save();
    expect(saved.status).toBe(200);
    const created = await createSession();
    const sessionId = created.sessionId;
    // 绑定已在创建时完成；显式传入非 ready 的核对结果（恢复首装失败/刷新失败共用此口径）：
    // 快照在内存但绑定非 ready → 409，绝不放行
    const notReady = await sessionContext.verifyManagedOnair(sessionId, { bound: false, note: '限制名单首次安装失败' });
    expect(notReady.ok).toBe(false);
    if (!notReady.ok) expect(notReady.error).toContain('限制');
    const locked = await sessionContext.verifyManagedOnair(sessionId, { bound: false, note: '刷新失败，本场锁定' });
    expect(locked.ok).toBe(false);
    // ready 绑定照常放行
    expect((await sessionContext.verifyManagedOnair(sessionId, { bound: true })).ok).toBe(true);
    // 路由用的绑定核对来自运行时回调：此时真实绑定是 ready → 放行（goLive 被调到一次）
    const routed = await post('onair', { sessionId });
    expect(routed.status).toBe(200);
    clearInterval((runtime.show as any).director);
    (runtime.show as any).director = null;
  });

  it('keeps the non-managed onair path when the session is unregistered and has no snapshot', async () => {
    simulateRestart();
    expect((await sessionContext.verifyManagedOnair('never-created-session')).ok).toBe(true);
    expect((await sessionContext.restoreManagedSnapshot('never-created-session')).kind).toBe('none');
    // 冷 resume 无快照：legacy 未管理路径，不装限制、不注册受限工具
    const legacyAgent = makeAgent('never-created-session', undefined, 'dsh-livestream');
    await expect(runtime.sessionTools.onCreated!({ agent: legacyAgent, source: 'resume' })).resolves.toBeUndefined();
    expect(legacyAgent.registered).toHaveLength(0);
    expect(legacyAgent.restrictions).toHaveLength(0);
  });

  it('discards the restore-time active registration when the resume binding fails or the agent disposes', async () => {
    const saved = await save();
    expect(saved.status).toBe(200);
    const created = await createSession();
    const sessionId = created.sessionId;
    simulateRestart();
    // 恢复首装失败：agent/created 抛错（原生回滚），恢复期登记的活动快照必须撤销
    restrictFailure = 'injected resume first-install restriction failure';
    try {
      await expect(runtime.sessionTools.onCreated!({ agent: agents.get(sessionId), source: 'resume' })).rejects.toThrow(/限制/);
    } finally {
      restrictFailure = null;
    }
    expect(sessionContext.stateView().active?.sessionId).toBeUndefined();
    // 原生回滚会 dispose agent：其绑定 effect 清理连带清除 fail-closed 标记（与生产一致）
    for (const dispose of agents.get(sessionId).unbind.splice(0)) dispose();
    // 再次冷恢复：正常绑定成功（R7：恢复本身不改变 owner 活动视图——未开播 active 为 null）
    await runtime.sessionTools.onCreated!({ agent: agents.get(sessionId), source: 'resume' });
    expect(runtime.sessionTools.verify?.(sessionId)?.bound).toBe(true);
    expect(sessionContext.stateView().active).toBeNull();
    // agent 释放（原生回滚/会话关闭路径）：活动登记一并撤销
    for (const dispose of agents.get(sessionId).unbind.splice(0)) dispose();
    expect(runtime.sessionTools.verify?.(sessionId)?.bound).toBe(false);
    expect(sessionContext.stateView().active).toBeNull();
    sessionContext.clearActiveSessionsForTest();
    agent.resetSessionBindingStateForTest();
  });

  it('rejects snapshot files replaced by symlinks instead of following them', async () => {
    const saved = await save();
    expect(saved.status).toBe(200);
    const created = await createSession();
    const sessionId = created.sessionId;
    const file = join(snapshotDir(), `${sessionId}.json`);
    const content = await readFile(file, 'utf8');
    await rm(file);
    try {
      await symlink(join(dir, 'dsh-livestream', 'settings.json'), file);
    } catch {
      // 个别环境不允许 symlink；恢复内容后跳过
      await writeFile(file, content);
      return;
    }
    const result = sessionContext.readSnapshot(sessionId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid');
    simulateRestart();
    expect((await sessionContext.restoreManagedSnapshot(sessionId)).kind).toBe('invalid');
    expect((await sessionContext.verifyManagedOnair(sessionId)).ok).toBe(false);
    expect((await post('onair', { sessionId })).status).toBe(409);
    // 冷 resume 同样拒绝，绝不跟随 symlink 或降级为未管理会话
    await expect(runtime.sessionTools.onCreated!({ agent: agents.get(sessionId), source: 'resume' })).rejects.toThrow();
    await rm(file);
    await writeFile(file, content);
    expect(sessionContext.readSnapshot(sessionId).ok).toBe(true);
  });

  it('rejects onair when a snapshot path is a directory', async () => {
    const sessionId = 'snapshot-is-directory';
    await mkdir(join(snapshotDir(), `${sessionId}.json`), { recursive: true });
    const result = sessionContext.readSnapshot(sessionId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid');
    expect((await sessionContext.verifyManagedOnair(sessionId)).ok).toBe(false);
    expect((await post('onair', { sessionId })).status).toBe(409);
    const directoryAgent = makeAgent(sessionId, undefined, 'dsh-livestream');
    await expect(runtime.sessionTools.onCreated!({ agent: directoryAgent, source: 'resume' })).rejects.toThrow();
  });

  it('fails the whole create and leaves no active binding when the first restriction installation fails', async () => {
    simulateRestart();
    const saved = await save();
    expect(saved.status).toBe(200);
    const before = sessionContext.stateView().active?.sessionId ?? null;
    restrictFailure = 'injected first-install restriction failure';
    try {
      const created = await post('sessions', {});
      // 首装失败：agent/created 抛错 → 原生创建回滚 → 路由整体失败（503），没有「创建成功但无限制」的会话
      expect(created.status).toBe(503);
    } finally {
      restrictFailure = null;
    }
    // 失败的创建不留下活动绑定，也不把预备快照当成活动会话
    expect(sessionContext.stateView().active?.sessionId ?? null).toBe(before);
  });

  it('rejects snapshots exceeding the decode depth budget', async () => {
    let nested: unknown = '底';
    for (let level = 0; level < 20; level++) nested = [nested];
    const snapshot = {
      schemaVersion: 1,
      sessionId: 'depth-case',
      revision: 1,
      platform: 'bilibili',
      presetId: 'dsh-livestream',
      effectiveCwd: '',
      cwdBinding: null,
      rootBindings: [],
      skills: [],
      issues: nested,
      createdAt: Date.now(),
    };
    await mkdir(snapshotDir(), { recursive: true });
    await writeFile(join(snapshotDir(), 'depth-case.json'), JSON.stringify(snapshot));
    const result = sessionContext.readSnapshot('depth-case');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('invalid');
      expect(result.error).toContain('深度');
    }
  });

  it('rejects snapshots with malformed bindings or unknown fields', async () => {
    await mkdir(snapshotDir(), { recursive: true });
    const base = {
      schemaVersion: 1,
      sessionId: 'binding-case',
      revision: 1,
      platform: 'bilibili',
      presetId: 'dsh-livestream',
      effectiveCwd: '/tmp/x',
      cwdBinding: { path: '/tmp/x', dev: 1, ino: 2 },
      rootBindings: [],
      skills: [],
      issues: [],
      createdAt: Date.now(),
    };
    // cwdBinding 缺 ino：绑定形状不合法
    await writeFile(join(snapshotDir(), 'binding-case.json'), JSON.stringify({ ...base, cwdBinding: { path: '/tmp/x', dev: 1 } }));
    const malformed = sessionContext.readSnapshot('binding-case');
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.error).toContain('绑定');
    // 未知字段
    await writeFile(join(snapshotDir(), 'binding-case.json'), JSON.stringify({ ...base, extra: 1 }));
    const unknownField = sessionContext.readSnapshot('binding-case');
    expect(unknownField.ok).toBe(false);
    if (!unknownField.ok) expect(unknownField.error).toContain('未知字段');
    // 哈希格式非法
    await writeFile(join(snapshotDir(), 'binding-case.json'), JSON.stringify({
      ...base,
      skills: [{
        name: 'papermorph',
        description: '示例',
        modelInvocable: true,
        userInvocable: true,
        sourcePath: '/tmp/a.md',
        sourceHash: 'not-a-hash',
        contentHash: 'not-a-hash',
        body: '正文',
      }],
    }));
    const badHash = sessionContext.readSnapshot('binding-case');
    expect(badHash.ok).toBe(false);
    if (!badHash.ok) expect(badHash.error).toContain('哈希');
    // 契约完好的快照通过
    writeFileSync(join(snapshotDir(), 'binding-case.json'), JSON.stringify(base), { encoding: 'utf8' });
    expect(sessionContext.readSnapshot('binding-case').ok).toBe(true);
  });

  it('marks vanished roots in issues during restore while usable roots keep working', async () => {
    const saved = await save({}, undefined);
    expect(saved.status).toBe(200);
    // 先准备第二个根的目录与内容，再保存两根配置
    await mkdir(join(dir, 'materials-2'), { recursive: true });
    await writeFile(join(dir, 'materials-2', 'note.txt'), '第二个根的内容。\n');
    const revision = JSON.parse(await readFile(join(dir, 'dsh-livestream', 'settings.json'), 'utf8')).sessionContext.revision;
    const twoRoots = await post('settings', { sessionContext: {
      expectedRevision: revision,
      config: {
        enabled: true,
        cwd: join(dir, 'workdir'),
        skillSources: [{ path: join(dir, 'skills', 'papermorph.md'), enabled: true }],
        readRoots: [
          { path: join(dir, 'materials'), enabled: true },
          { path: join(dir, 'materials-2'), enabled: true },
        ],
      },
    } });
    expect(twoRoots.status, JSON.stringify(twoRoots.body)).toBe(200);
    const created = await createSession();
    const sessionId = created.sessionId;
    expect((await sessionContext.readMaterial(sessionId, { rootId: 'root-2', path: 'note.txt' })).status).toBe('available');
    await rm(join(dir, 'materials-2'), { recursive: true, force: true });
    simulateRestart();
    const outcome = await sessionContext.restoreManagedSnapshot(sessionId);
    expect(outcome.kind).toBe('snapshot');
    const restored = outcome.kind === 'snapshot' ? outcome.snapshot : null;
    expect(restored?.sessionId).toBe(sessionId);
    // 失效项在 issues 如实标记；可用项照常
    expect(restored?.issues.join('；')).toContain('root-2');
    expect(restored?.issues.join('；')).toContain('已失效');
    const keep = await sessionContext.readMaterial(sessionId, { rootId: 'root-1', path: '课件/lesson-1.txt' });
    expect(keep.status).toBe('available');
    const lost = await sessionContext.readMaterial(sessionId, { rootId: 'root-2', path: 'note.txt' });
    expect(lost.status).toBe('unavailable');
    // cwd 仍有效：onair 核对不受失效资料根影响
    expect((await sessionContext.verifyManagedOnair(sessionId)).ok).toBe(true);
    // 恢复基线（两根的配置保留在 settings，后续用例继续用单根保存）
    await save();
  });

  it('rejects onair for a restored session whose work directory died', async () => {
    const saved = await save();
    expect(saved.status).toBe(200);
    const created = await createSession();
    const sessionId = created.sessionId;
    simulateRestart();
    await rm(join(dir, 'workdir'), { recursive: true, force: true });
    try {
      const outcome = await sessionContext.restoreManagedSnapshot(sessionId);
      expect(outcome.kind).toBe('snapshot');
      const restored = outcome.kind === 'snapshot' ? outcome.snapshot : null;
      expect(restored?.sessionId).toBe(sessionId);
      expect(restored?.issues.join('；')).toContain('工作目录已失效');
      const verdict = await sessionContext.verifyManagedOnair(sessionId);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.error).toContain('工作目录');
      const routed = await post('onair', { sessionId });
      expect(routed.status).toBe(409);
    } finally {
      await mkdir(join(dir, 'workdir'), { recursive: true });
    }
  });

  // ── 修正段二轮（MEDIUM）：冻结正文完整性 —— 非空正文 + 实际 contentHash ──

  const writeSnapshotWithSkill = async (sessionId: string, body: string, contentHash: string) => {
    await mkdir(snapshotDir(), { recursive: true });
    const snapshot = {
      schemaVersion: 1,
      sessionId,
      revision: 1,
      platform: 'bilibili',
      presetId: 'dsh-livestream',
      effectiveCwd: '',
      cwdBinding: null,
      rootBindings: [],
      skills: [{
        name: 'papermorph',
        description: '示例描述。',
        modelInvocable: true,
        userInvocable: true,
        sourcePath: '/tmp/papermorph.md',
        sourceHash: 'a'.repeat(64),
        contentHash,
        body,
      }],
      issues: [],
      createdAt: Date.now(),
    };
    await writeFile(join(snapshotDir(), `${sessionId}.json`), JSON.stringify(snapshot));
  };

  it('marks a snapshot whose body was modified but kept the old contentHash as invalid', async () => {
    const sessionId = 'tampered-body';
    await writeSnapshotWithSkill(sessionId, '被篡改的正文。\n', 'b'.repeat(64));
    const result = sessionContext.readSnapshot(sessionId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('invalid');
      expect(result.error).toContain('哈希');
    }
    // 冷 resume 同样拒绝：原生恢复回滚，不把被篡改正文交给 loader
    const tamperedAgent = makeAgent(sessionId, undefined, 'dsh-livestream');
    await expect(runtime.sessionTools.onCreated!({ agent: tamperedAgent, source: 'resume' })).rejects.toThrow(/哈希|正文/);
  });

  it('marks a snapshot with an empty skill body as invalid', async () => {
    const { createHash } = await import('node:crypto');
    const sessionId = 'empty-body';
    const emptyHash = createHash('sha256').update('', 'utf8').digest('hex');
    await writeSnapshotWithSkill(sessionId, '', emptyHash);
    const result = sessionContext.readSnapshot(sessionId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid');
  });

  it('keeps serving the frozen body after restore even when the source file changed on disk', async () => {
    const saved = await save();
    expect(saved.status).toBe(200);
    const created = await createSession();
    const sessionId = created.sessionId;
    const frozen = sessionContext.loadSkill(sessionId, 'papermorph');
    expect(frozen.status).toBe('loaded');
    const frozenBody = frozen.status === 'loaded' ? frozen.body : '';
    simulateRestart();
    // 来源文件在快照之后被改写：恢复不得重新读取最新来源替代冻结版本
    await writeFile(join(dir, 'skills', 'papermorph.md'), '---\nname: papermorph\ndescription: 把文章做成可翻页的网页书。\n---\n来源已被换成第三版。\n');
    await runtime.sessionTools.onCreated!({ agent: agents.get(sessionId), source: 'resume' });
    const loaded = sessionContext.loadSkill(sessionId, 'papermorph');
    expect(loaded.status).toBe('loaded');
    if (loaded.status === 'loaded') {
      expect(loaded.body).toBe(frozenBody);
      expect(loaded.body).toContain('恢复正文');
      expect(loaded.body).not.toContain('第三版');
    }
    await save();
    simulateRestart();
  });

  // ── 修正段二轮（LOW）：effectiveCwd 与配置一致的 4096 字符预算 ──

  it('saves, creates and cold-restores a work directory longer than 512 characters', async () => {
    simulateRestart();
    // macOS PATH_MAX=1024 字节：用 ASCII 段保证路径在系统限制内仍超过 512 字符（与配置 4096 预算的差额留给系统）
    const segments = Array.from({ length: 9 }, (_item, index) => `level-${index}-${'d'.repeat(62)}`);
    let longCwd = join(dir, 'long-cwd');
    for (const segment of segments) longCwd = join(longCwd, segment);
    expect(longCwd.length).toBeGreaterThan(512);
    await mkdir(longCwd, { recursive: true });
    const saved = await save({ cwd: longCwd });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const created = await createSession();
    expect(created.sessionContext.effectiveCwd).toBe(await realpath(longCwd));
    // 持久快照里的 effectiveCwd 用同一预算：冷恢复原样读回
    const persisted = sessionContext.readSnapshot(created.sessionId);
    expect(persisted.ok).toBe(true);
    simulateRestart();
    await runtime.sessionTools.onCreated!({ agent: agents.get(created.sessionId), source: 'resume' });
    // R7：冷恢复不改变 owner 活动视图；绑定与快照的 effectiveCwd 经绑定状态与恢复结果核对
    expect(runtime.sessionTools.verify?.(created.sessionId)?.bound).toBe(true);
    expect(sessionContext.stateView().active).toBeNull();
    simulateRestart();
    // 回到短 cwd 基线，避免影响后续用例
    await save();
    simulateRestart();
  });
});
