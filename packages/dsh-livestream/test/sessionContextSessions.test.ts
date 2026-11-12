import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * 管理会话创建流程：捕获 → 冻结快照 → native sessionController.create()（契约替身，行为按
 * installed 0.2.2-rc.1 核对：workspaceId/cwd 互斥、返回 {sessionId, agentPreset?}、mkdir(cwd)）。
 * A/B 冻结、onair 绑定核对与宿主组合检查在这里覆盖；真实发行组合证据由独立入口另证。
 */
describe('managed session creation', () => {
  let dir: string;
  let runtime: typeof import('../src/dsh/runtime');
  let sessionContext: typeof import('../src/dsh/sessionContext');
  let sessions: typeof import('../src/dsh/sessionContextSessions');
  let routes: Map<string, (request: Request) => Response | Promise<Response>>;
  const previous = { ...process.env };

  const nativeCreates: Array<Record<string, unknown>> = [];
  const agents = new Map<string, any>();
  /** R7：owner active 不再由登记顺序决定；A/B 交错测试直接跟踪种子会话的 id 与冻结哈希 */
  let seededSessionId = '';
  let seededContentHash = '';
  let nativeFailure: string | null = null;
  let nativeResultOverride: ((request: Record<string, unknown>) => Record<string, unknown>) | null = null;
  /** 契约要求的 barrier：native create 停在创建调用里，用于控制保存/创建的真实并发交错（不靠 sleep） */
  let nativeCreateGate: (() => Promise<void>) | null = null;
  let workspaceMissing = false;
  let workspaceId = 'fixture-workspace';
  let loaderEntries: Array<unknown> = [];
  let compositionChecked = false;

  /** 条件泵：按确定条件推进事件循环，直到条件成立（无定时等待） */
  const until = async (condition: () => boolean, maxTurns = 5000): Promise<void> => {
    for (let turn = 0; turn < maxTurns && !condition(); turn++) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(condition(), 'barrier condition never became true').toBe(true);
  };

  const makeAgent = (sessionId: string, cwd: string | undefined, preset: string | undefined) => ({
    session: { id: sessionId, header: { id: sessionId, cwd, agentPreset: preset } },
    ctx: {
      effect: () => () => {},
      get: () => undefined,
      tools: {
        register: () => () => {},
        restrict: () => () => {},
        get: () => undefined,
        view: () => ({ knownNames: new Set(), restrictableNames: new Set(['weather_lookup', 'public_search', 'show_stats']) }),
        // 身份核对数据源（与 installed dsh-tools 形状一致；此假件未建模 preset 层注册）
        layers: { global: { tools: new Map() }, chainLayers: () => [] },
      },
    },
  });

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

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-session-create-'));
    process.env.DSH_HOME = dir;
    await mkdir(join(dir, 'workdir'), { recursive: true });
    await mkdir(join(dir, 'skills'), { recursive: true });
    await mkdir(join(dir, 'materials', '课件'), { recursive: true });
    await writeFile(join(dir, 'skills', 'papermorph.md'), '---\nname: papermorph\ndescription: 把文章做成可翻页的网页书。\n---\nPapermorph 第一版正文。\n');
    await writeFile(join(dir, 'materials', '课件', 'lesson-1.txt'), '第一课内容。\n');
    runtime = await import('../src/dsh/runtime');
    sessionContext = await import('../src/dsh/sessionContext');
    sessions = await import('../src/dsh/sessionContextSessions');
    // 与生产接线一致：agent 子插件 apply 时把 onCreated/verify 放到运行时回调上（这里直接赋值，避免拉起完整插件）
    const agentPlugin = await import('../src/dsh/agent');
    const runtimeState = await import('../src/dsh/runtime');
    runtimeState.sessionTools.onCreated = agentPlugin.handleAgentCreated;
    runtimeState.sessionTools.verify = agentPlugin.verifySessionBinding;
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
              if (nativeFailure) throw new Error(nativeFailure);
              if (request.cwd !== undefined && request.workspaceId !== undefined) throw new Error('native contract violation: cwd and workspaceId are exclusive');
              const canonicalCwd = request.cwd !== undefined ? await realpath(String(request.cwd)) : `/workspaces/${String(request.workspaceId)}`;
              const agent = makeAgent(String(request.sessionId), canonicalCwd, request.agentPreset === undefined ? undefined : String(request.agentPreset));
              agents.set(String(request.sessionId), agent);
              // 与原生一致：preset-scoped 串行 agent/created 在 create 返回与 gate 之前完成恢复与受限绑定
              await runtime.sessionTools.onCreated?.({ agent, source: 'create' });
              if (nativeCreateGate) await nativeCreateGate();
              if (nativeResultOverride) return nativeResultOverride(request);
              return { sessionId: request.sessionId, ...(request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset }) };
            },
          };
        }
        if (name === 'agents') return { get: (id: string) => agents.get(id) };
        if (name === 'workspaceRegistry') return { get: (id: string) => (workspaceMissing ? undefined : { id, path: `/workspaces/${id}` }) };
        if (name === 'workingDirectory') return { get: (session: any) => session.header?.cwd };
        if (name === 'loader') return { entries: () => { compositionChecked = true; return loaderEntries[Symbol.iterator](); } };
        return undefined;
      },
      connection: { fetch: { register(route: { path: string; fetch: (request: Request) => Response }) { routes.set(route.path, route.fetch); return () => {}; } } },
    });
  });

  afterAll(async () => {
    process.env = previous;
    await rm(dir, { recursive: true, force: true });
  });

  it('rejects managed creation while no config is saved', async () => {
    const result = await post('sessions', { workspaceId });
    expect(result.status).toBe(409);
    expect(result.body.error).toContain('没有已成功保存的会话设置');
    expect(nativeCreates).toHaveLength(0);
  });

  it('creates a managed session through the native contract with explicit cwd', async () => {
    const saved = await save();
    expect(saved.status).toBe(200);
    const result = await post('sessions', { workspaceId });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(compositionChecked).toBe(true);
    expect(nativeCreates).toHaveLength(1);
    const request = nativeCreates[0];
    expect(request.workspaceId).toBeUndefined();
    expect(request.cwd).toBe(await realpath(join(dir, 'workdir')));
    expect(request.agentPreset).toBe('dsh-livestream');
    expect(String(request.sessionId)).toMatch(/^livestream-[0-9a-f-]{36}$/);
    expect(result.body.sessionContext.effectiveCwd).toBe(await realpath(join(dir, 'workdir')));
    expect(result.body.sessionContext.skills[0].name).toBe('papermorph');
    expect(result.body.sessionContext.skills[0].contentHash).toBeNull();
    const loaded = sessionContext.loadSkill(String(request.sessionId), 'papermorph');
    expect(loaded.status).toBe('loaded');
    if (loaded.status === 'loaded') {
      expect(loaded.body).toContain('Papermorph 第一版正文');
      expect(loaded.contentHash).toMatch(/^[0-9a-f]{64}$/);
    }
    const persisted = JSON.parse(await readFile(join(dir, 'dsh-livestream', 'session-context', `${result.body.sessionId}.json`), 'utf8'));
    expect(persisted.sessionId).toBe(result.body.sessionId);
    expect(persisted.skills[0].body).toContain('Papermorph 第一版正文');
    const view = (await (await routes.get('/api/dsh-livestream/state')!(new Request('http://localhost/'))).json()).sessionContext;
    // 正式评审 R7：创建/恢复不改变 owner 活动视图（未开播 active=null）；快照视图经创建响应核对
    expect(view.active).toBeNull();
    expect(result.body.sessionContext.rootIds).toEqual(['root-1']);
    seededSessionId = String(result.body.sessionId);
    seededContentHash = String(persisted.skills[0].contentHash);
  });

  it('freezes the active session definition across a concurrent save controlled by a barrier (A/B semantics)', async () => {
    // 会话 A 的重复加载计入调用预算但不重复注入正文；契约要求用 barrier 控制保存/创建的真实并发交错，不靠 sleep
    const firstSessionId = seededSessionId;
    expect(firstSessionId).toBeTruthy();
    const firstContentHash = seededContentHash;
    const beforeCount = nativeCreates.length;
    let openGate: (() => void) | null = null;
    nativeCreateGate = () => new Promise<void>((resolve) => { openGate = resolve; });
    let created: { status: number; body: any } | null = null;
    try {
      // 会话 C 的捕获点在第一次 await 之前（同步）：拿到的是当前完整已保存版本
      const creating = post('sessions', { workspaceId });
      // barrier：等 native create 真正停在 gate 上（push 之后还有 realpath await，必须等 resolver 就绪）
      await until(() => openGate !== null);
      expect(openGate, 'native create never parked on the barrier').toBeTruthy();
      // C 停在创建调用期间，保存 B（磁盘正文换成第二版）
      await writeFile(join(dir, 'skills', 'papermorph.md'), '---\nname: papermorph\ndescription: 把文章做成可翻页的网页书。\n---\nPapermorph 第二版正文。\n');
      const savedB = await save({}, sessionContext.stateView().saved?.revision ?? 0);
      expect(savedB.status).toBe(200);
      // 放行 C；后续创建不再经过 barrier
      nativeCreateGate = null;
      openGate!();
      created = await creating;
      expect(created.status, JSON.stringify(created.body)).toBe(200);
    } finally {
      // 即使中间断言失败也放行停在 gate 上的创建，避免悬挂路由污染后续用例
      nativeCreateGate = null;
      openGate?.();
    }
    expect(created).toBeTruthy();
    const concurrent = created!;
    expect(nativeCreates).toHaveLength(beforeCount + 1);
    // 会话 A 仍用旧定义（推进到新 turn：R6 的同 turn 不重复注入不影响这里重新取正文）
    sessionContext.noteSessionTurn(firstSessionId!, 101);
    const oldLoaded = sessionContext.loadSkill(firstSessionId!, 'papermorph');
    expect(oldLoaded.status).toBe('loaded');
    if (oldLoaded.status === 'loaded') expect(oldLoaded.body).toContain('第一版正文');
    // 会话 C 取得捕获时的一份完整旧版本（磁盘快照正文与 contentHash 都和 A 的持久快照一致），不是 B 的新正文，也不是混合版本
    const persisted = JSON.parse(await readFile(join(dir, 'dsh-livestream', 'session-context', `${concurrent.body.sessionId}.json`), 'utf8'));
    const firstPersisted = JSON.parse(await readFile(join(dir, 'dsh-livestream', 'session-context', `${firstSessionId}.json`), 'utf8'));
    expect(persisted.skills[0].body).toContain('第一版正文');
    expect(persisted.skills[0].contentHash).toBe(firstContentHash);
    expect(persisted.skills[0].contentHash).toBe(firstPersisted.skills[0].contentHash);
    const concurrentLoaded = sessionContext.loadSkill(concurrent.body.sessionId, 'papermorph');
    expect(concurrentLoaded.status).toBe('loaded');
    if (concurrentLoaded.status === 'loaded') expect(concurrentLoaded.body).toContain('第一版正文');
    // 资料读取按各自快照的根校验
    const firstRead = await sessionContext.readMaterial(firstSessionId!, { rootId: 'root-1', path: '课件/lesson-1.txt' });
    expect(firstRead.status).toBe('available');
    // 重复加载同一名称不重复注入预算
    const again = sessionContext.loadSkill(firstSessionId!, 'papermorph');
    // 正式评审 R6：同 turn 重复加载不再携带正文（本轮已加载提示），预算不重复计费
    expect(again.status).toBe('loaded');
    if (again.status === 'loaded') expect(again.body).toBe('');
    // B 之后创建的新会话取得第二版
    const afterB = await post('sessions', { workspaceId });
    expect(afterB.status).toBe(200);
    const newLoaded = sessionContext.loadSkill(afterB.body.sessionId, 'papermorph');
    expect(newLoaded.status).toBe('loaded');
    if (newLoaded.status === 'loaded') expect(newLoaded.body).toContain('第二版正文');
  });

  it('rejects managed creation before the native call when the fallback workspace is missing from the host registry', async () => {
    const saved = await save({ cwd: '' });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const beforeCount = nativeCreates.length;
    workspaceMissing = true;
    try {
      const result = await post('sessions', { workspaceId });
      // 评审修正：空 cwd 分支在创建前用宿主 workspace 信息核对，缺失时返回可修正错误，不依赖 native 内部报错
      expect(result.status).toBe(409);
      expect(result.body.error).toContain('工作区');
      expect(nativeCreates.length).toBe(beforeCount);
    } finally {
      workspaceMissing = false;
    }
    // 恢复带显式 cwd 的基线配置
    await save();
  });

  it('rejects budget violations for skill loads and material reads per turn', async () => {
    // 新建一个独立会话，从零开始计预算
    const fresh = await post('sessions', { workspaceId });
    expect(fresh.status).toBe(200);
    const sessionId = fresh.body.sessionId as string;
    for (let i = 0; i < 4; i++) {
      const result = sessionContext.loadSkill(sessionId!, 'papermorph');
      expect(result.status).toBe('loaded');
    }
    const fifth = sessionContext.loadSkill(sessionId!, 'papermorph');
    expect(fifth.status).toBe('limit_exceeded');
    const denied = sessionContext.loadSkill(sessionId!, 'unknown-skill');
    expect(denied.status).toBe('unavailable');
    const traversal = await sessionContext.readMaterial(sessionId!, { rootId: 'root-1', path: '../outside.txt' });
    expect(traversal.status).toBe('denied');
    const badRoot = await sessionContext.readMaterial(sessionId!, { rootId: 'root-9', path: '课件/lesson-1.txt' });
    expect(badRoot.status).toBe('denied');
    const badLines = await sessionContext.readMaterial(sessionId!, { rootId: 'root-1', path: '课件/lesson-1.txt', maxLines: 500 });
    expect(badLines.status).toBe('denied');
  });

  it('rejects a native response with a different session id and leaves no active binding', async () => {
    const before = sessionContext.stateView().active?.sessionId;
    nativeResultOverride = () => ({ sessionId: 'someone-elses-session', agentPreset: 'dsh-livestream' });
    try {
      const result = await post('sessions', { workspaceId });
      expect(result.status).toBe(409);
      expect(result.body.error).toContain('会话标识与请求不一致');
    } finally {
      nativeResultOverride = null;
    }
    expect(sessionContext.stateView().active?.sessionId).toBe(before);
  });

  it('maps native create failures to 503 without replacing the active snapshot', async () => {
    const before = sessionContext.stateView().active?.sessionId;
    nativeFailure = 'workspace "x" not found';
    try {
      const result = await post('sessions', { workspaceId: 'x' });
      expect(result.status).toBe(503);
    } finally {
      nativeFailure = null;
    }
    expect(sessionContext.stateView().active?.sessionId).toBe(before);
  });

  it('blocks managed creation when global skill providers are active in the host loader', async () => {
    const createsBefore = nativeCreates.length;
    loaderEntries = [{ options: { name: '@deepseek-ai/dsh-tool-skill' }, disabled: false, fiber: { isActive: true } }];
    try {
      const result = await post('sessions', { workspaceId });
      expect(result.status).toBe(503);
      expect(result.body.error).toContain('宿主组合不支持');
      expect(nativeCreates.length).toBe(createsBefore);
    } finally {
      loaderEntries = [];
    }
  });

  it('blocks managed creation when the cwd binding disappeared before the native call', async () => {
    await rm(join(dir, 'workdir'), { recursive: true, force: true });
    try {
      const result = await post('sessions', { workspaceId });
      expect(result.status).toBe(409);
      expect(result.body.error).toContain('工作目录已失效');
    } finally {
      await mkdir(join(dir, 'workdir'), { recursive: true });
    }
  });

  it('rejects onair for a managed session whose work directory was removed', async () => {
    // 目录在上一用例中被删除重建（新 inode）：显式重新保存以刷新绑定
    const resaved = await save();
    expect(resaved.status).toBe(200);
    const created = await post('sessions', { workspaceId });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const ok = await post('onair', { sessionId: created.body.sessionId });
    expect(ok.status).toBe(200);
    // 下播收束（R7：不向后续用例泄漏 onAir）
    await post('offair', {});
    (runtime.show as any).finish();
    clearInterval((runtime.show as any).director);
    (runtime.show as any).director = null;
    await rm(join(dir, 'workdir'), { recursive: true, force: true });
    try {
      const revoked = await post('onair', { sessionId: created.body.sessionId });
      expect(revoked.status).toBe(409);
    } finally {
      await mkdir(join(dir, 'workdir'), { recursive: true });
    }
  });

  it('validates the snapshot file name and rejects foreign session ids', () => {
    expect(sessionContext.readSnapshot('../escape').ok).toBe(false);
    expect(sessionContext.readSnapshot('missing-session').ok).toBe(false);
  });

  it('exposes the preset mapping per platform without touching the game line', () => {
    expect(sessions.presetForPlatform('bilibili')).toBe('dsh-livestream');
    expect(sessions.presetForPlatform('douyin')).toBe('dsh-livestream-douyin');
  });

  it('skips automatic resume when a session context record exists and tells the owner', async () => {
    // 保存记录存在（上一用例已保存）；写入未完成的 live.json 模拟重启前的在播会话
    const liveFile = join(dir, 'dsh-livestream', 'live.json');
    await writeFile(liveFile, JSON.stringify({ sessionId: 'managed-live-session', platform: 'bilibili', roomId: 1234, at: Date.now(), streamId: null, broadcasting: false }));
    const host = await import('../src/dsh/index');
    host.apply({
      effect(effect: () => unknown, label?: string) {
        if (['dsh-livestream resume'].includes(label ?? '')) effect();
      },
      provide() {},
      get: () => undefined,
      connection: { fetch: { register: () => () => {} } },
    });
    // resumeLive 异步执行：等待它消费 live.json 并写入恢复提示
    for (let i = 0; i < 50; i++) {
      if (sessionContext.stateView().recheck?.includes('手动开始新会话')) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const view = sessionContext.stateView();
    expect(view.recheck).toContain('已恢复直播会话设置，请手动开始新会话');
    // live.json 已被消费：重启分支没有按旧会话自动接回（未使用新增配置的安装保持原行为，由 resume.test.ts 覆盖）
    await expect(readFile(liveFile, 'utf8')).rejects.toThrow();
  });

  // ── 正式评审 R7：owner active 由实际开播状态 + show.currentSession 选择 ──

  it('derives the owner active view from the live state, not the registration order', async () => {
    // 准备两个会话（未开播）：active 必须是 null，不能按 Map 最早/最新登记显示
    await save();
    const createdA = await post('sessions', { workspaceId });
    expect(createdA.status).toBe(200);
    const createdB = await post('sessions', { workspaceId });
    expect(createdB.status).toBe(200);
    expect(sessionContext.stateView().active).toBeNull();
    // A 开播：active 是 A；期间创建的其他快照不改变它
    runtime.show.goLive(createdA.body.sessionId, undefined);
    expect(sessionContext.stateView().active?.sessionId).toBe(createdA.body.sessionId);
    // 切到 B：active 显示 B
    runtime.show.goLive(createdB.body.sessionId, undefined);
    expect(sessionContext.stateView().active?.sessionId).toBe(createdB.body.sessionId);
    // 下播：无活动会话（持久快照与绑定保留）；立即收束道别宽限
    runtime.show.endLive();
    (runtime.show as any).finish();
    expect(sessionContext.stateView().active).toBeNull();
    // 复原开播状态，避免污染后续用例
    runtime.show.goLive(createdB.body.sessionId, undefined);
    runtime.show.endLive();
    clearInterval((runtime.show as any).director);
    (runtime.show as any).director = null;
  });

  // ── 正式评审 R5：资料缓冲预算在 IO 前约束，实际读取字节计费 ──

  it('stops issuing new read bytes once the turn buffer budget is exhausted', async () => {
    await save();
    const fresh = await post('sessions', { workspaceId });
    expect(fresh.status).toBe(200);
    const sessionId = fresh.body.sessionId as string;
    // 256 KiB 文件：同 turn 四次各返回一行
    await writeFile(join(dir, 'materials', 'big.txt'), `${'内容行。'.repeat(64)}\n${'x'.repeat(261000)}\n`);
    // FileHandle 类不作为 fs/promises 的运行时导出：从真实句柄取原型后计数实际读取字节
    const { open: openFile } = await import('node:fs/promises');
    const probe = await openFile(join(dir, 'materials', '课件', 'lesson-1.txt'), 'r');
    const handlePrototype = Object.getPrototypeOf(probe) as { read: (this: unknown, ...args: unknown[]) => Promise<{ bytesRead: number; buffer: Buffer }> };
    await probe.close();
    const originalRead = handlePrototype.read;
    let counted = 0;
    handlePrototype.read = async function (this: unknown, ...args: unknown[]) {
      const result = await originalRead.apply(this, args);
      counted += result.bytesRead;
      return result;
    };
    const statuses: string[] = [];
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        const result = await sessionContext.readMaterial(sessionId, { rootId: 'root-1', path: 'big.txt', maxLines: 1 });
        statuses.push(result.status);
      }
    } finally {
      handlePrototype.read = originalRead;
    }
    expect(statuses).toEqual(['available', 'available', 'limit_exceeded', 'limit_exceeded']);
    // 实际发出的 FileHandle.read 字节不得超过每 turn 512 KiB 预算（R5 修复前会读到 1 MiB）
    expect(counted).toBeLessThanOrEqual(512 * 1024);
  });

  // ── 正式评审 R6：同 turn 同名重复加载不重复输出正文；新 turn 重新输出并重新计费 ──

  it('emits the frozen skill body once per turn and re-emits it with fresh budget on the next turn', async () => {
    await writeFile(join(dir, 'skills', 'r6-skill.md'), '---\nname: r6-skill\ndescription: 重复加载语义验证。\n---\nR6 独立冻结正文。\n');
    const r6Revision = sessionContext.stateView().saved?.revision ?? 0;
    const r6Saved = await post('settings', { sessionContext: { expectedRevision: r6Revision, config: {
      enabled: true,
      cwd: join(dir, 'workdir'),
      skillSources: [{ path: join(dir, 'skills', 'r6-skill.md'), enabled: true }],
      readRoots: [{ path: join(dir, 'materials'), enabled: true }],
    } } });
    expect(r6Saved.status, JSON.stringify(r6Saved.body)).toBe(200);
    const fresh = await post('sessions', { workspaceId });
    expect(fresh.status).toBe(200);
    const sessionId = fresh.body.sessionId as string;
    const first = sessionContext.loadSkill(sessionId, 'r6-skill');
    expect(first.status).toBe('loaded');
    if (first.status !== 'loaded') return;
    expect(first.body).toContain('R6 独立冻结正文');
    const firstBytes = Buffer.byteLength(first.body, 'utf8');
    // 同 turn 重复：明确「本轮已加载」，不带正文
    const repeat = sessionContext.loadSkill(sessionId, 'r6-skill');
    expect(repeat.status).toBe('loaded');
    if (repeat.status !== 'loaded') return;
    expect(repeat.body).toBe('');
    expect(repeat.repeated).toBe(true);
    // 真实输出字节（正文只在首次注入）：重复不携带正文
    const emittedBytes = [first, repeat].reduce((total, result) => total + (result.status === 'loaded' ? Buffer.byteLength(result.body, 'utf8') : 0), 0);
    expect(emittedBytes).toBe(firstBytes);
    // 推进到下一个真实 turn：同一冻结正文可再次输出，并重新计入该 turn 预算
    sessionContext.noteSessionTurn(sessionId, 2);
    const nextTurn = sessionContext.loadSkill(sessionId, 'r6-skill');
    expect(nextTurn.status).toBe('loaded');
    if (nextTurn.status !== 'loaded') return;
    expect(nextTurn.body).toContain('R6 独立冻结正文');
    expect(nextTurn.repeated).toBeUndefined();
  });

  // ── 四轮接收核对 1：取消/超时路径的真实已读字节先结算再分类（不免单）──

  it('settles consumed bytes for a cancelled read before classification and caps later reads at zero new bytes', async () => {
    await save();
    const fresh = await post('sessions', { workspaceId });
    expect(fresh.status).toBe(200);
    const sessionId = fresh.body.sessionId as string;
    // 256 KiB 文件（≤单文件 256KiB 上限）
    // ~254 KiB 文件（≤单文件 256KiB 上限），行短于输出上限，避免输出预算掩盖缓冲结算
    await writeFile(join(dir, 'materials', 'cancel-big.txt'), `${'x'.repeat(99)}\n`.repeat(2600));
    const { open: openFile } = await import('node:fs/promises');
    const probe = await openFile(join(dir, 'materials', '课件', 'lesson-1.txt'), 'r');
    const handlePrototype = Object.getPrototypeOf(probe) as { read: (this: unknown, ...args: unknown[]) => Promise<{ bytesRead: number; buffer: Buffer }> };
    await probe.close();
    const originalRead = handlePrototype.read;
    let counted = 0;
    // 仅第一次 read：正常返回完整缓冲后立即取消信号（helper 走「cancelled + consumedBytes」路径）；
    // 后续 read 只计数不取消，供结算验证
    const controller = new AbortController();
    let firstReadSeen = false;
    handlePrototype.read = async function (this: unknown, ...args: unknown[]) {
      const result = await originalRead.apply(this, args);
      counted += result.bytesRead;
      if (!firstReadSeen) {
        firstReadSeen = true;
        controller.abort();
      }
      return result;
    };
    const cancelled = await sessionContext.readMaterial(sessionId, { rootId: 'root-1', path: 'cancel-big.txt', signal: controller.signal });
    // 取消零正文
    expect(cancelled.status).toBe('cancelled');
    if (cancelled.status === 'cancelled') expect(cancelled.detail).toBe('');
    // 取消的已读字节必须已结算：取消（~260000）+ 完整（~260000）后剩余 ~4288 →
    // 第三次在发出任何读取前就 limit_exceeded（零新增读取字节）；未结算实现此时仍会完整读取
    const afterCancel = await sessionContext.readMaterial(sessionId, { rootId: 'root-1', path: 'cancel-big.txt' });
    expect(afterCancel.status).toBe('available');
    const third = await sessionContext.readMaterial(sessionId, { rootId: 'root-1', path: 'cancel-big.txt' });
    expect(third.status).toBe('limit_exceeded');
    handlePrototype.read = originalRead;
    // 全程实际读取字节：取消的 ~260000 + 一次完整 ~260000 ≤ 512 KiB；
    // 未结算实现会让第三次读出完整文件（~780000 字节）而在此失败
    expect(counted).toBeGreaterThanOrEqual(2 * 260000);
    expect(counted).toBeLessThanOrEqual(512 * 1024);
  });

  it('keeps per-turn budgets isolated across a real turn switch with an in-flight read (barrier-controlled)', async () => {
    await save();
    const fresh = await post('sessions', { workspaceId });
    expect(fresh.status).toBe(200);
    const sessionId = fresh.body.sessionId as string;
    await writeFile(join(dir, 'materials', 'turn-big.txt'), `${'x'.repeat(99)}\n`.repeat(2600));
    const { open: openFile } = await import('node:fs/promises');
    const probe = await openFile(join(dir, 'materials', '课件', 'lesson-1.txt'), 'r');
    const handlePrototype = Object.getPrototypeOf(probe) as { read: (this: unknown, ...args: unknown[]) => Promise<{ bytesRead: number; buffer: Buffer }> };
    await probe.close();
    const originalRead = handlePrototype.read;
    let counted = 0;
    // barrier：T1 的第一次 read 挂起，直到显式放行（不靠 sleep）
    let releaseFirst: (() => void) | null = null;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let hungReleased = false;
    handlePrototype.read = async function (this: unknown, ...args: unknown[]) {
      if (!hungReleased) {
        hungReleased = true;
        await firstGate;
      }
      const result = await originalRead.apply(this, args);
      counted += result.bytesRead;
      return result;
    };
    // T1 进入 IO 并挂起（busy）
    const first = sessionContext.readMaterial(sessionId, { rootId: 'root-1', path: 'turn-big.txt' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    // 切换到 T2（真实 native turn 语义入口）
    sessionContext.noteSessionTurn(sessionId, 2);
    // T2 的新读必须 busy（会话级在途保护不提前释放）
    const duringTurn2 = await sessionContext.readMaterial(sessionId, { rootId: 'root-1', path: '课件/lesson-1.txt' });
    expect(duringTurn2.status).toBe('busy');
    // 放行 T1：旧结果结算进 T1，不污染 T2
    releaseFirst!();
    const settled = await first;
    expect(settled.status).toBe('available');
    // T2 使用自身完整预算：两次 256KiB 全文读都 available，第三次 limit_exceeded（若 T1 结算污染了 T2，第二次就会失败）
    const t2r1 = await sessionContext.readMaterial(sessionId, { rootId: 'root-1', path: 'turn-big.txt' });
    expect(t2r1.status).toBe('available');
    const t2r2 = await sessionContext.readMaterial(sessionId, { rootId: 'root-1', path: 'turn-big.txt' });
    expect(t2r2.status).toBe('available');
    const t2r3 = await sessionContext.readMaterial(sessionId, { rootId: 'root-1', path: 'turn-big.txt' });
    expect(t2r3.status).toBe('limit_exceeded');
    handlePrototype.read = originalRead;
    // 实际读取字节：T1 一次 + T2 两次 = 3 × ~262001，未跨 turn 污染
    expect(counted).toBeLessThanOrEqual(3 * 262144);
    expect(counted).toBeGreaterThan(2 * 262000);
  });

  // ── 正式评审 R4：内部 2 秒 deadline 正确分类为 timeout；取消为 cancelled ──

  it('classifies the internal read deadline as timeout and the owner cancel as cancelled with zero content', async () => {
    await save();
    const fresh = await post('sessions', { workspaceId });
    expect(fresh.status).toBe(200);
    const sessionId = fresh.body.sessionId as string;
    const { open: openFile } = await import('node:fs/promises');
    const probe = await openFile(join(dir, 'materials', '课件', 'lesson-1.txt'), 'r');
    const handlePrototype = Object.getPrototypeOf(probe) as { read: (this: unknown, ...args: unknown[]) => Promise<{ bytesRead: number; buffer: Buffer }> };
    await probe.close();
    const originalRead = handlePrototype.read;
    // 第一次 read 挂起超过内部 2 秒 deadline：分类必须是 timeout（不是 cancelled），正文为零
    handlePrototype.read = function (this: unknown, ...args: unknown[]) {
      return new Promise((resolve) => setTimeout(() => resolve(originalRead.apply(this, args)), 2300));
    };
    const hung = await sessionContext.readMaterial(sessionId, { rootId: 'root-1', path: '课件/lesson-1.txt' });
    handlePrototype.read = originalRead;
    expect(hung.status).toBe('timeout');
    if (hung.status === 'timeout') expect(hung.detail).toBe('');
    // owner 取消（外部 signal，调用前已中止）：cancelled 且零正文
    const controller = new AbortController();
    controller.abort();
    const cancelled = await sessionContext.readMaterial(sessionId, { rootId: 'root-1', path: '课件/lesson-1.txt', signal: controller.signal });
    expect(cancelled.status).toBe('cancelled');
    // 外部取消即使携带 TimeoutError 名称的理由（DOMException 误判向量），也不得分类为内部超时
    const externalTimeoutNamed = new AbortController();
    externalTimeoutNamed.abort(new DOMException('external timeout-like', 'TimeoutError'));
    const misclassified = await sessionContext.readMaterial(sessionId, { rootId: 'root-1', path: '课件/lesson-1.txt', signal: externalTimeoutNamed.signal });
    expect(misclassified.status).toBe('cancelled');
  });

  it('keeps the first external cancellation when the local deadline expires before IO settles', async () => {
    await save();
    const fresh = await post('sessions', { workspaceId });
    expect(fresh.status).toBe(200);
    const sessionId = fresh.body.sessionId as string;
    const { open: openFile } = await import('node:fs/promises');
    const probe = await openFile(join(dir, 'materials', '课件', 'lesson-1.txt'), 'r');
    const handlePrototype = Object.getPrototypeOf(probe) as {
      read: (this: unknown, ...args: unknown[]) => Promise<{ bytesRead: number; buffer: Buffer }>;
    };
    await probe.close();
    const originalRead = handlePrototype.read;
    const originalTimeout = AbortSignal.timeout;
    let deadline: AbortSignal | undefined;
    let releaseRead!: () => void;
    let enterRead!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    const readEntered = new Promise<void>((resolve) => { enterRead = resolve; });
    let pending: ReturnType<typeof sessionContext.readMaterial> | undefined;
    try {
      AbortSignal.timeout = (milliseconds) => {
        const signal = originalTimeout(milliseconds);
        if (milliseconds === 2000) deadline = signal;
        return signal;
      };
      handlePrototype.read = async function (this: unknown, ...args: unknown[]) {
        enterRead();
        await readGate;
        return originalRead.apply(this, args);
      };
      const controller = new AbortController();
      pending = sessionContext.readMaterial(sessionId, {
        rootId: 'root-1',
        path: '课件/lesson-1.txt',
        signal: controller.signal,
      });
      await readEntered;
      expect(deadline).toBeDefined();
      controller.abort(new Error('owner stopped the read'));
      await new Promise<void>((resolve) => {
        if (deadline!.aborted) resolve();
        else deadline!.addEventListener('abort', () => resolve(), { once: true });
      });
      releaseRead();
      const result = await pending;
      expect(result.status).toBe('cancelled');
      expect('content' in result).toBe(false);
    } finally {
      releaseRead();
      await pending?.catch(() => undefined);
      handlePrototype.read = originalRead;
      AbortSignal.timeout = originalTimeout;
    }
  });

  // ── 正式评审 R3：创建只消费保存的 canonical 来源，原始 alias 改指不改变发现集合 ──

  it('ignores an alias re-pointed to a deeper directory when creating from the saved bindings', async () => {
    const { symlink, rm, mkdir } = await import('node:fs/promises');
    // 保存时 alias → 源目录（real-source 直接 SKILL.md，另有 hidden/ 子目录 SKILL.md 按规则不被发现）
    await mkdir(join(dir, 'real-source', 'hidden'), { recursive: true });
    await writeFile(join(dir, 'real-source', 'SKILL.md'), '---\nname: selected\ndescription: 保存时应发现的来源。\n---\nselected 正文。\n');
    await writeFile(join(dir, 'real-source', 'hidden', 'SKILL.md'), '---\nname: unselected\ndescription: 直接 SKILL.md 规则下不该发现。\n---\nunselected 正文。\n');
    await rm(join(dir, 'skills', 'papermorph.md'), { force: true });
    await symlink(join(dir, 'real-source'), join(dir, 'skills', 'alias-source'));
    const revision = sessionContext.stateView().saved?.revision ?? 0;
    const saved = await post('settings', { sessionContext: { expectedRevision: revision, config: {
      enabled: true,
      cwd: join(dir, 'workdir'),
      skillSources: [{ path: join(dir, 'skills', 'alias-source'), enabled: true }],
      readRoots: [{ path: join(dir, 'materials'), enabled: true }],
    } } });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const first = await post('sessions', { workspaceId });
    expect(first.status).toBe(200);
    expect(first.body.sessionContext.skills.map((skill: { name: string }) => skill.name)).toEqual(['selected']);
    // alias 改指更深的 hidden 目录（owner 原路径仅回显/脱敏用，创建不重新解析）
    await rm(join(dir, 'skills', 'alias-source'), { force: true });
    await symlink(join(dir, 'real-source', 'hidden'), join(dir, 'skills', 'alias-source'));
    const second = await post('sessions', { workspaceId });
    expect(second.status).toBe(200);
    expect(second.body.sessionContext.skills.map((skill: { name: string }) => skill.name)).toEqual(['selected']);
    const hidden = sessionContext.loadSkill(second.body.sessionId, 'unselected');
    expect(hidden.status).toBe('unavailable');
    // 恢复基线来源
    await rm(join(dir, 'skills', 'alias-source'), { force: true });
    await writeFile(join(dir, 'skills', 'papermorph.md'), '---\nname: papermorph\ndescription: 把文章做成可翻页的网页书。\n---\nPapermorph 第一版正文。\n');
    await save();
  });
});
