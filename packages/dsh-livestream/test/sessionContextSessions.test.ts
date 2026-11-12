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

  // ── 六轮接收核对：逐条绑定归属与实际声明去重分离 ──

  it('keeps a deeper explicit file inside a direct-SKILL container as an independent source (both orders)', async () => {
    // 容器 A 直接含 SKILL.md（按规则不发现更深文件）；更深的显式文件作为独立来源绑定
    await mkdir(join(dir, 'skills', 'deep-container', 'hidden'), { recursive: true });
    await writeFile(join(dir, 'skills', 'deep-container', 'SKILL.md'), '---\nname: container-skill\ndescription: 容器直接声明。\n---\n容器正文。\n');
    await writeFile(join(dir, 'skills', 'deep-container', 'hidden', 'inner.md'), '---\nname: hidden-skill\ndescription: 更深显式文件。\n---\n深层正文。\n');
    const sources = [
      { path: join(dir, 'skills', 'deep-container'), enabled: true },
      { path: join(dir, 'skills', 'deep-container', 'hidden', 'inner.md'), enabled: true },
    ];
    const saved = await saveSkillConfig(sources);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const created = await post('sessions', { workspaceId });
    expect(created.status).toBe(200);
    const names = created.body.sessionContext.skills.map((skill: { name: string }) => skill.name).sort();
    expect(names).toEqual(['container-skill', 'hidden-skill']);
    // 反序：显式文件在前、容器在后，两个独立名称都加载
    const savedReversed = await saveSkillConfig([sources[1], sources[0]]);
    expect(savedReversed.status).toBe(200);
    const createdReversed = await post('sessions', { workspaceId });
    expect(createdReversed.status).toBe(200);
    expect(createdReversed.body.sessionContext.skills.map((skill: { name: string }) => skill.name).sort()).toEqual(['container-skill', 'hidden-skill']);
    await save();
  });

  it('rejects save and creation when the deeper explicit file takes the container declaration name (both orders, zero native calls)', async () => {
    await mkdir(join(dir, 'skills', 'deep-container-2', 'hidden'), { recursive: true });
    await writeFile(join(dir, 'skills', 'deep-container-2', 'SKILL.md'), '---\nname: container-skill\ndescription: 容器直接声明。\n---\n容器正文。\n');
    await writeFile(join(dir, 'skills', 'deep-container-2', 'hidden', 'inner.md'), '---\nname: hidden-skill\ndescription: 更深显式文件。\n---\n深层正文。\n');
    const sources = [
      { path: join(dir, 'skills', 'deep-container-2'), enabled: true },
      { path: join(dir, 'skills', 'deep-container-2', 'hidden', 'inner.md'), enabled: true },
    ];
    // 先保存原名配置（记录里已有 container-skill 与 hidden-skill 两个声明）
    const savedOriginal = await saveSkillConfig(sources);
    expect(savedOriginal.status).toBe(200);
    const before = nativeCreates.length;
    // 保存后 hidden 文件改名为与容器声明同名：已保存记录的创建路径整体拒绝（409 同名）
    await writeFile(join(dir, 'skills', 'deep-container-2', 'hidden', 'inner.md'), '---\nname: container-skill\ndescription: 抢名。\n---\n抢名正文。\n');
    const created = await post('sessions', { workspaceId });
    expect(created.status).toBe(409);
    expect(JSON.stringify(created.body)).toContain('同名');
    expect(nativeCreates.length).toBe(before);
    // 冲突配置的保存也整体拒绝（400 同名）
    const saved = await saveSkillConfig(sources);
    expect(saved.status).toBe(400);
    expect(JSON.stringify(saved.body)).toContain('同名');
    expect(nativeCreates.length).toBe(before);
    // 反序（文件在前、容器在后）：恢复原名后保存 200 → 两个独立名称都加载
    await writeFile(join(dir, 'skills', 'deep-container-2', 'hidden', 'inner.md'), '---\nname: hidden-skill\ndescription: 更深显式文件。\n---\n深层正文。\n');
    const savedReversedOriginal = await saveSkillConfig([sources[1], sources[0]]);
    expect(savedReversedOriginal.status, JSON.stringify(savedReversedOriginal.body)).toBe(200);
    const createdReversedOriginal = await post('sessions', { workspaceId });
    expect(createdReversedOriginal.status).toBe(200);
    expect(createdReversedOriginal.body.sessionContext.skills.map((skill: { name: string }) => skill.name).sort()).toEqual(['container-skill', 'hidden-skill']);
    // 反序改名为同名后：创建 409（相对反序成功创建后的零新增）、冲突配置保存 400
    await writeFile(join(dir, 'skills', 'deep-container-2', 'hidden', 'inner.md'), '---\nname: container-skill\ndescription: 抢名。\n---\n抢名正文。\n');
    const createdReversed = await post('sessions', { workspaceId });
    expect(createdReversed.status).toBe(409);
    expect(nativeCreates.length).toBe(before + 1);
    const savedConflictedReversed = await saveSkillConfig([sources[1], sources[0]]);
    expect(savedConflictedReversed.status).toBe(400);
    await save();
  });

  it('retains per-index bindings for duplicate canonical entries and dedupes read-root grants (one rootId per unique dir)', async () => {
    await writeFile(join(dir, 'materials', 'grant.txt'), '授权内文件。\n');
    await mkdir(join(dir, 'materials-2'), { recursive: true });
    await writeFile(join(dir, 'materials-2', 'note.txt'), '第二个授权。\n');
    const saved = await saveSkillConfig([]);
    void saved;
    const revision = sessionContext.stateView().saved?.revision ?? 0;
    const savedRoots = await post('settings', { sessionContext: { expectedRevision: revision, config: {
      enabled: true,
      cwd: join(dir, 'workdir'),
      skillSources: [],
      readRoots: [
        { path: join(dir, 'materials'), enabled: true },
        { path: join(dir, 'materials'), enabled: true },
        { path: join(dir, 'materials-2'), enabled: true },
      ],
    } } });
    expect(savedRoots.status, JSON.stringify(savedRoots.body)).toBe(200);
    // 逐条绑定：重复 canonical 的两个条目各保留一份 index 绑定
    const persisted = JSON.parse(await readFile(join(dir, 'dsh-livestream', 'settings.json'), 'utf8'));
    expect(persisted.sessionContext.bindings.roots).toHaveLength(3);
    expect(persisted.sessionContext.bindings.roots.map((item: { index: number }) => item.index)).toEqual([0, 1, 2]);
    const created = await post('sessions', { workspaceId });
    expect(created.status).toBe(200);
    // 快照授权按已核对 canonical 目录去重：两个重复条目 → 一个唯一 grant，rootId 唯一
    const persistedSnapshot = JSON.parse(await readFile(join(dir, 'dsh-livestream', 'session-context', `${created.body.sessionId}.json`), 'utf8'));
    expect(persistedSnapshot.rootBindings).toHaveLength(2);
    expect(persistedSnapshot.rootBindings.map((item: { rootId: string }) => item.rootId)).toEqual(['root-1', 'root-2']);
    expect(created.body.sessionContext.rootIds).toEqual(['root-1', 'root-2']);
    const read = await sessionContext.readMaterial(created.body.sessionId, { rootId: 'root-1', path: 'grant.txt' });
    expect(read.status).toBe('available');
  });

  it('keeps one definition for a legal overlapping actual skill file (counted once at limits)', async () => {
    await mkdir(join(dir, 'skills', 'overlap-container'), { recursive: true });
    await writeFile(join(dir, 'skills', 'overlap-container', 'inner.md'), '---\nname: overlap-skill\ndescription: 容器与文件来源指向同一实际文件。\n---\n重叠正文。\n');
    const saved = await saveSkillConfig([
      { path: join(dir, 'skills', 'overlap-container'), enabled: true },
      { path: join(dir, 'skills', 'overlap-container', 'inner.md'), enabled: true },
    ]);
    expect(saved.status).toBe(200);
    const created = await post('sessions', { workspaceId });
    expect(created.status).toBe(200);
    expect(created.body.sessionContext.skills).toHaveLength(1);
    // 同一实际文件只计一次：第 2 次加载为同 turn 重复，第 5 次调用触发次数上限而不是重复注入正文
    const first = sessionContext.loadSkill(created.body.sessionId, 'overlap-skill');
    expect(first.status).toBe('loaded');
    const again = sessionContext.loadSkill(created.body.sessionId, 'overlap-skill');
    if (again.status === 'loaded') expect(again.body).toBe('');
    await save();
  });

  // ── 正式复审 R10：异源同名在创建时是硬冲突（两种来源形状与顺序），同 canonical 重复合法去重 ──

  const saveSkillConfig = async (skillSources: Array<{ path: string; enabled: boolean }>) => {
    const revision = sessionContext.stateView().saved?.revision ?? 0;
    return post('settings', { sessionContext: { expectedRevision: revision, config: {
      enabled: true,
      cwd: join(dir, 'workdir'),
      skillSources,
      readRoots: [{ path: join(dir, 'materials'), enabled: true }],
    } } });
  };

  it('rejects creation when a saved file source is renamed into an existing skill name (zero native calls)', async () => {
    await writeFile(join(dir, 'skills', 'a.md'), '---\nname: first\ndescription: A 来源。\n---\nA 正文。\n');
    await writeFile(join(dir, 'skills', 'b.md'), '---\nname: second\ndescription: B 来源。\n---\nB 正文。\n');
    const saved = await saveSkillConfig([
      { path: join(dir, 'skills', 'a.md'), enabled: true },
      { path: join(dir, 'skills', 'b.md'), enabled: true },
    ]);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const before = nativeCreates.length;
    // 保存后 b.md 改成与 a.md 同名（inode 不变，绑定仍有效）：创建必须整体拒绝
    await writeFile(join(dir, 'skills', 'b.md'), '---\nname: first\ndescription: 抢名。\n---\n抢名正文。\n');
    const created = await post('sessions', { workspaceId });
    expect(created.status).toBe(409);
    expect(JSON.stringify(created.body)).toContain('同名');
    expect(nativeCreates.length).toBe(before);
    // 恢复 b.md 后创建恢复可用（同名冲突消失）
    await writeFile(join(dir, 'skills', 'b.md'), '---\nname: second\ndescription: B 来源。\n---\nB 正文。\n');
    const recovered = await post('sessions', { workspaceId });
    expect(recovered.status).toBe(200);
    await save();
  });

  it('rejects dir/file mixed-order cross-source name conflicts at creation (zero native calls)', async () => {
    // 目录来源（inner/first）在前、文件来源（second）在后
    await mkdir(join(dir, 'skills', 'mixed-inner'), { recursive: true });
    await writeFile(join(dir, 'skills', 'mixed-inner', 'SKILL.md'), '---\nname: first\ndescription: 目录来源。\n---\n目录正文。\n');
    await writeFile(join(dir, 'skills', 'mixed-file.md'), '---\nname: second\ndescription: 文件来源。\n---\n文件正文。\n');
    const saved = await saveSkillConfig([
      { path: join(dir, 'skills', 'mixed-inner'), enabled: true },
      { path: join(dir, 'skills', 'mixed-file.md'), enabled: true },
    ]);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const before = nativeCreates.length;
    await writeFile(join(dir, 'skills', 'mixed-file.md'), '---\nname: first\ndescription: 抢名。\n---\n抢名正文。\n');
    const created = await post('sessions', { workspaceId });
    expect(created.status).toBe(409);
    expect(JSON.stringify(created.body)).toContain('同名');
    expect(nativeCreates.length).toBe(before);
    // 反向冲突：保存后改目录来源的 SKILL.md 去撞文件来源当前的名字（前一段已把文件改为 first；
    // 改后配置本身也会被保存拒绝，所以冲突只发生在已保存记录的创建路径）
    await writeFile(join(dir, 'skills', 'mixed-inner', 'SKILL.md'), '---\nname: first\ndescription: 反向抢名。\n---\n反向正文。\n');
    const beforeReversed = nativeCreates.length;
    const createdReversed = await post('sessions', { workspaceId });
    expect(createdReversed.status).toBe(409);
    expect(JSON.stringify(createdReversed.body)).toContain('同名');
    expect(nativeCreates.length).toBe(beforeReversed);
    await save();
  });

  // ── 正式复审 R11：发现失败分支保持预算与原子合并（部分声明不得绕过计量）──

  it('rejects creation when a saved single-file source exceeds the 64KiB read budget (zero native calls)', async () => {
    await writeFile(join(dir, 'skills', 'big-later.md'), '---\nname: big-later\ndescription: 之后超限。\n---\n小正文。\n');
    const saved = await saveSkillConfig([{ path: join(dir, 'skills', 'big-later.md'), enabled: true }]);
    expect(saved.status).toBe(200);
    const before = nativeCreates.length;
    // 保存后正文增至 64KiB 以上（声明合法，读取预算超限）
    await writeFile(join(dir, 'skills', 'big-later.md'), `---\nname: big-later\ndescription: 之后超限。\n---\n${'x'.repeat(65536)}\n`);
    const created = await post('sessions', { workspaceId });
    expect(created.status).toBe(409);
    expect(JSON.stringify(created.body)).toContain('Skill 文件超过');
    expect(nativeCreates.length).toBe(before);
    await save();
  });

  it('rejects creation atomically when a container has a bad declaration after legal prefixes (zero native calls, no partial snapshot)', async () => {
    await mkdir(join(dir, 'skills', 'atomic-container'), { recursive: true });
    await writeFile(join(dir, 'skills', 'atomic-container', 'a.md'), '---\nname: atomic-a\ndescription: 合法前缀。\n---\nA 正文。\n');
    await writeFile(join(dir, 'skills', 'atomic-container', 'b.md'), '---\nname: atomic-b\ndescription: 之后改坏。\n---\nB 正文。\n');
    const saved = await saveSkillConfig([{ path: join(dir, 'skills', 'atomic-container'), enabled: true }]);
    expect(saved.status).toBe(200);
    const before = nativeCreates.length;
    await writeFile(join(dir, 'skills', 'atomic-container', 'b.md'), '---\nname: atomic-b\n');
    const created = await post('sessions', { workspaceId });
    expect(created.status).toBe(409);
    expect(JSON.stringify(created.body)).toContain('声明无效');
    expect(nativeCreates.length).toBe(before);
    await save();
  });

  it('rejects creation when merged raw bytes exceed the 256KiB total budget (zero native calls)', async () => {
    const containers: Array<string> = [];
    for (let index = 0; index < 5; index++) {
      const container = join(dir, 'skills', `budget-${index}`);
      await mkdir(container, { recursive: true });
      containers.push(container);
      await writeFile(join(container, 'a.md'), `---\nname: budget-${index}-a\ndescription: 小声明。\n---\n小正文。\n`);
      await writeFile(join(container, 'b.md'), `---\nname: budget-${index}-b\ndescription: 小声明。\n---\n小正文。\n`);
    }
    const saved = await saveSkillConfig(containers.map((container) => ({ path: container, enabled: true })));
    expect(saved.status).toBe(200);
    const before = nativeCreates.length;
    // 每个容器的 a.md 改为 ~55KB 合法正文：合并 raw 总量 5×(55×1024) ≈ 281KB > 256KiB
    for (const [index, container] of containers.entries()) {
      await writeFile(join(container, 'a.md'), `---\nname: budget-${index}-a\ndescription: 超限。\n---\n${'x'.repeat(55 * 1024)}\n`);
    }
    const created = await post('sessions', { workspaceId });
    expect(created.status).toBe(409);
    expect(JSON.stringify(created.body)).toContain('Skill 原始字节合计超过');
    expect(nativeCreates.length).toBe(before);
    await save();
  });

  it('dedupes a same-canonical source at the 16-skill boundary (16 unique still load)', async () => {
    const containers: Array<string> = [];
    for (let index = 0; index < 4; index++) {
      const container = join(dir, 'skills', `boundary-${index}`);
      await mkdir(container, { recursive: true });
      containers.push(container);
      for (let slot = 0; slot < 4; slot++) {
        await writeFile(join(container, `s${slot}.md`), `---\nname: boundary-${index}-${slot}\ndescription: 边界来源。\n---\n正文 ${index}-${slot}。\n`);
      }
    }
    const saved = await saveSkillConfig(containers.map((container) => ({ path: container, enabled: true })));
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const created = await post('sessions', { workspaceId });
    expect(created.status).toBe(200);
    expect(created.body.sessionContext.skills).toHaveLength(16);
    // 同 canonical 的重复来源：替换入口为 alias（canonical 不变），保存与创建仍成功且不重复加载
    const { symlink: symlinkPath } = await import('node:fs/promises');
    await symlinkPath(containers[0], join(dir, 'skills', 'boundary-alias'));
    const revision = sessionContext.stateView().saved?.revision ?? 0;
    const savedAlias = await post('settings', { sessionContext: { expectedRevision: revision, config: {
      enabled: true,
      cwd: join(dir, 'workdir'),
      skillSources: [
        { path: join(dir, 'skills', 'boundary-alias'), enabled: true },
        ...containers.slice(1).map((container) => ({ path: container, enabled: true })),
      ],
      readRoots: [{ path: join(dir, 'materials'), enabled: true }],
    } } });
    expect(savedAlias.status, JSON.stringify(savedAlias.body)).toBe(200);
    const createdAlias = await post('sessions', { workspaceId });
    expect(createdAlias.status).toBe(200);
    expect(createdAlias.body.sessionContext.skills).toHaveLength(16);
    await save();
  });

  // ── 六轮接收核对 4：历史记录缺失 index 绑定的条目 → 受控 resave 诊断，不重解 raw alias ──

  it('reports a controlled resave diagnostic for orphan entries without bindings while bound entries stay available', async () => {
    await save();
    // 直接构造历史形状：config 两个启用条目，bindings 只保留 index 0（旧记录可能缺失重复条目绑定）
    const current = JSON.parse(await readFile(join(dir, 'dsh-livestream', 'settings.json'), 'utf8'));
    const record = current.sessionContext;
    const orphanEntry = join(dir, 'skills', 'orphan.md');
    await writeFile(orphanEntry, '---\nname: orphan-skill\ndescription: 无绑定条目。\n---\n孤儿正文。\n');
    record.config.skillSources = [
      record.config.skillSources[0],
      { path: orphanEntry, enabled: true },
    ];
    record.bindings.skills = record.bindings.skills.filter((item: { index: number }) => item.index === 0);
    runtime.updateSettings({ sessionContext: record });
    const created = await post('sessions', { workspaceId });
    // 仍是管理会话（不降级 legacy），但孤儿条目以 issue 呈现 resave 指引，且只有已绑定来源进入快照
    expect(created.status).toBe(200);
    const names = created.body.sessionContext.skills.map((skill: { name: string }) => skill.name);
    expect(names).not.toContain('orphan-skill');
    expect(JSON.stringify(created.body.sessionContext.issues)).toContain('重新保存');
    expect(JSON.stringify(created.body.sessionContext.issues)).toContain('orphan');
    // 健康重查同诊断：孤儿条目 not_found + resave 指引，不重解 raw alias
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await sessionContext.recheckSessionContext();
    const entry = sessionContext.stateView().health.entries.find((candidate: any) => candidate.kind === 'skill' && candidate.index === 1);
    expect(entry?.status).toBe('not_found');
    expect(entry?.detail ?? '').toContain('重新保存');
    await save();
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
