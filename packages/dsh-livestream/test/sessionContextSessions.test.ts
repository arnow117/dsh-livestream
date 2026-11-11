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
  let nativeFailure: string | null = null;
  let nativeResultOverride: ((request: Record<string, unknown>) => Record<string, unknown>) | null = null;
  let workspaceId = 'fixture-workspace';
  let loaderEntries: Array<unknown> = [];
  let compositionChecked = false;

  const makeAgent = (sessionId: string, cwd: string | undefined, preset: string | undefined) => ({
    session: { id: sessionId, header: { id: sessionId, cwd, agentPreset: preset } },
    ctx: {
      effect: () => () => {},
      tools: { register: () => () => {}, restrict: () => () => {}, get: () => undefined },
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
    // 与生产接线一致：agent 子插件把绑定入口放到运行时回调上（这里直接赋值，避免拉起完整插件）
    const agentPlugin = await import('../src/dsh/agent');
    const runtimeState = await import('../src/dsh/runtime');
    runtimeState.sessionTools.bind = agentPlugin.bindSessionContextTools;
    const host = await import('../src/dsh/index');
    routes = new Map();
    host.apply({
      effect(effect: () => unknown, label?: string) {
        if (['dsh-livestream credentials', 'state', 'settings', 'session context recheck', 'sessions', 'onair'].includes(label ?? '')) effect();
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
              if (nativeResultOverride) return nativeResultOverride(request);
              return { sessionId: request.sessionId, ...(request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset }) };
            },
          };
        }
        if (name === 'agents') return { get: (id: string) => agents.get(id) };
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
    expect(view.active.sessionId).toBe(result.body.sessionId);
    expect(view.active.rootIds).toEqual(['root-1']);
  });

  it('freezes the active session definition across later saves (A/B semantics)', async () => {
    // 会话 A 的重复加载计入调用预算但不重复注入正文

    const view = sessionContext.stateView();
    const firstSessionId = view.active?.sessionId;
    expect(firstSessionId).toBeTruthy();
    // 修改磁盘上的 Skill 正文并保存 B
    await writeFile(join(dir, 'skills', 'papermorph.md'), '---\nname: papermorph\ndescription: 把文章做成可翻页的网页书。\n---\nPapermorph 第二版正文。\n');
    const savedB = await save({}, (view.saved?.revision ?? 0));
    expect(savedB.status).toBe(200);
    const created = await post('sessions', { workspaceId });
    expect(created.status).toBe(200);
    expect(nativeCreates).toHaveLength(2);
    // 会话 A 仍用旧定义；会话 B 取得新正文
    const oldLoaded = sessionContext.loadSkill(firstSessionId!, 'papermorph');
    expect(oldLoaded.status).toBe('loaded');
    if (oldLoaded.status === 'loaded') expect(oldLoaded.body).toContain('第一版正文');
    const newLoaded = sessionContext.loadSkill(created.body.sessionId, 'papermorph');
    expect(newLoaded.status).toBe('loaded');
    if (newLoaded.status === 'loaded') expect(newLoaded.body).toContain('第二版正文');
    // 资料读取按各自快照的根校验
    const firstRead = await sessionContext.readMaterial(firstSessionId!, { rootId: 'root-1', path: '课件/lesson-1.txt' });
    expect(firstRead.status).toBe('available');
    // 重复加载同一名称不重复注入预算
    const again = sessionContext.loadSkill(firstSessionId!, 'papermorph');
    expect(again.status).toBe('loaded');
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
});
