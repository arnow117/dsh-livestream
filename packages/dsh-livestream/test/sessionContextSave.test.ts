import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const errors = vi.hoisted(() => ({ write: false, rename: false }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (errors.write) throw new Error('injected write failure');
      return actual.writeFileSync(...args);
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (errors.rename) throw new Error('injected rename failure');
      return actual.renameSync(...args);
    },
  };
});

describe('session context save flow', () => {
  let dir: string;
  let runtime: typeof import('../src/dsh/runtime');
  let sessionContext: typeof import('../src/dsh/sessionContext');
  let routes: Map<string, (request: Request) => Response | Promise<Response>>;
  const previous = { ...process.env };
  let settingsFile: string;
  let state: () => Promise<any>;

  const post = async (path: string, data: unknown) => {
    const response = await routes.get(`/api/dsh-livestream/${path}`)!(new Request('http://localhost/', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data),
    }));
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };

  const config = (overrides: Record<string, unknown> = {}) => ({
    enabled: true,
    cwd: join(dir, 'workdir'),
    skillSources: [{ path: join(dir, 'skills', 'note.md'), enabled: true }],
    readRoots: [{ path: join(dir, 'materials'), enabled: true }],
    ...overrides,
  });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-session-save-'));
    process.env.DSH_HOME = dir;
    await mkdir(join(dir, 'workdir'), { recursive: true });
    await mkdir(join(dir, 'skills'), { recursive: true });
    await mkdir(join(dir, 'materials'), { recursive: true });
    await writeFile(join(dir, 'skills', 'note.md'), '---\nname: note-skill\ndescription: 一份用于保存校验的技能。\n---\n保存校验正文。\n');
    settingsFile = join(dir, 'dsh-livestream', 'settings.json');
    await mkdir(join(dir, 'dsh-livestream'), { recursive: true });
    await writeFile(settingsFile, JSON.stringify({ stageToken: 'test', unknownField: 'preserved' }));
    runtime = await import('../src/dsh/runtime');
    sessionContext = await import('../src/dsh/sessionContext');
    const host = await import('../src/dsh/index');
    routes = new Map();
    host.apply({
      effect(effect: () => unknown, label?: string) {
        if (['dsh-livestream credentials', 'state', 'settings', 'session context recheck', 'sessions'].includes(label ?? '')) effect();
      },
      provide() {},
      get(name: string) { return name === 'credentials' ? { resolve: async () => ({ value: '' }), set: async () => {} } : undefined; },
      connection: { fetch: { register(route: { path: string; fetch: (request: Request) => Response }) { routes.set(route.path, route.fetch); return () => {}; } } },
    });
    state = async () => (await routes.get('/api/dsh-livestream/state')!(new Request('http://localhost/'))).json();
  });

  afterAll(async () => {
    process.env = previous;
    await rm(dir, { recursive: true, force: true });
  });

  it('starts in legacy state with no saved config and an empty state view', async () => {
    const view = (await state()).sessionContext;
    expect(view.saved).toBeNull();
    expect(view.invalid).toBeUndefined();
    expect(view.active).toBeNull();
    // 内部 bindings 不回显
    expect((await state()).settings.sessionContext).toBeUndefined();
  });

  it('persists a valid save with revision 1 and owner-only views', async () => {
    const result = await post('settings', { sessionContext: { expectedRevision: 0, config: config() } });
    expect(result.status).toBe(200);
    expect(result.body.sessionContext.saved.revision).toBe(1);
    expect(result.body.sessionContext.saved.config.skillSources[0].path).toBe(join(dir, 'skills', 'note.md'));
    const health = result.body.sessionContext.health.entries;
    expect(health.find((entry: any) => entry.kind === 'cwd')?.status).toBe('valid');
    expect(health.find((entry: any) => entry.kind === 'skill' && entry.index === 0)?.status).toBe('valid');
    expect(health.find((entry: any) => entry.kind === 'root' && entry.index === 0)?.status).toBe('valid');
    const persisted = JSON.parse(await readFile(settingsFile, 'utf8'));
    expect(persisted.sessionContext.revision).toBe(1);
    expect(persisted.sessionContext.bindings.skills[0].file).toBe(await realpath(join(dir, 'skills', 'note.md')));
    expect(persisted.unknownField).toBe('preserved');
    expect(result.body.settings.sessionContext).toBeUndefined();
  });

  it('rejects an invalid cwd or unreadable skill declaration and keeps the last saved values', async () => {
    const before = await readFile(settingsFile, 'utf8');
    const missing = await post('settings', { sessionContext: { expectedRevision: 1, config: config({ cwd: join(dir, 'missing-dir') }) } });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toContain('工作目录无效');
    expect(missing.body.issue?.code).toBe('not_found');
    const badSkill = await writeFile(join(dir, 'skills', 'note.md'), '---\nname: 不同的名字\ndescription: 改名会让创建时重新发现失败。\n---\n正文\n');
    void badSkill;
    await writeFile(join(dir, 'skills', 'note.md'), '没有 frontmatter 的文件\n');
    const invalid = await post('settings', { sessionContext: { expectedRevision: 1, config: config() } });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toContain('Skill 来源无效');
    // 恢复合法内容，用于后续用例
    await writeFile(join(dir, 'skills', 'note.md'), '---\nname: note-skill\ndescription: 一份用于保存校验的技能。\n---\n保存校验正文。\n');
    expect(await readFile(settingsFile, 'utf8')).toBe(before);
  });

  it('rejects same-name conflicts across different sources and dedups identical canonical entries', async () => {
    await mkdir(join(dir, 'skills', 'other'), { recursive: true });
    await writeFile(join(dir, 'skills', 'other', 'SKILL.md'), '---\nname: note-skill\ndescription: 同名异源。\n---\n另一个正文。\n');
    const conflictRequest = {
      expectedRevision: 1,
      config: config({ skillSources: [
        { path: join(dir, 'skills', 'note.md'), enabled: true },
        { path: join(dir, 'skills', 'other'), enabled: true },
      ] }),
    };
    const conflict = await post('settings', { sessionContext: conflictRequest });
    expect(conflict.status).toBe(400);
    expect(conflict.body.error).toContain('同名');
    await rm(join(dir, 'skills', 'other'), { recursive: true, force: true });
    const dedupRequest = {
      expectedRevision: 1,
      config: config({ readRoots: [
        { path: join(dir, 'materials'), enabled: true },
        { path: join(dir, 'materials'), enabled: true },
      ] }),
    };
    const dedup = await post('settings', { sessionContext: dedupRequest });
    expect(dedup.status).toBe(200);
    const persisted = JSON.parse(await readFile(settingsFile, 'utf8'));
    // 六轮接收核对 2：逐条绑定保留——重复 canonical 的两个条目各保留一份 index 绑定；
    // 实际授权去重在创建时按已核对 canonical 目录做
    expect(persisted.sessionContext.bindings.roots).toHaveLength(2);
    expect(persisted.sessionContext.bindings.roots.map((item: { index: number }) => item.index)).toEqual([0, 1]);
    // 恢复单一资料根的基线配置
    await post('settings', { sessionContext: { expectedRevision: persisted.sessionContext.revision, config: config() } });
  });

  it('skips IO for disabled items and reports them as closed, not checked', async () => {
    const current = JSON.parse(await readFile(settingsFile, 'utf8')).sessionContext.revision;
    const disabledRequest = {
      expectedRevision: current,
      config: config({
        enabled: false,
        cwd: join(dir, 'never-created'),
        skillSources: [{ path: join(dir, 'never.md'), enabled: false }],
        readRoots: [{ path: join(dir, 'never-root'), enabled: false }],
      }),
    };
    const result = await post('settings', { sessionContext: disabledRequest });
    expect(result.status).toBe(200);
    const health = result.body.sessionContext.health.entries;
    expect(health.every((entry: any) => entry.status === 'disabled')).toBe(true);
    const persisted = JSON.parse(await readFile(settingsFile, 'utf8'));
    expect(persisted.sessionContext.config.enabled).toBe(false);
    // 恢复启用配置
    await post('settings', { sessionContext: { expectedRevision: persisted.sessionContext.revision, config: config() } });
  });

  it('returns 409 on revision conflicts without changing anything', async () => {
    const before = await readFile(settingsFile, 'utf8');
    const conflict = await post('settings', { sessionContext: { expectedRevision: 0, config: config() } });
    expect(conflict.status).toBe(409);
    expect(await readFile(settingsFile, 'utf8')).toBe(before);
  });

  it('rejects a mixed request when any other field is invalid and applies nothing', async () => {
    const before = await readFile(settingsFile, 'utf8');
    const revision = JSON.parse(before).sessionContext.revision;
    const mixed = await post('settings', { douyinRoomId: 'not-a-room', sessionContext: { expectedRevision: revision, config: config() } });
    expect(mixed.status).toBe(400);
    expect(JSON.parse(await readFile(settingsFile, 'utf8')).sessionContext.revision).toBe(revision);
  });

  it.each(['write', 'rename'] as const)('keeps the previous config after a %s failure during save', async (failure) => {
    const before = await readFile(settingsFile, 'utf8');
    const revision = JSON.parse(before).sessionContext.revision;
    const request = { sessionContext: { expectedRevision: revision, config: config({ cwd: '' }) } };
    errors[failure] = true;
    let result: { status: number; body: any };
    try {
      result = await post('settings', request);
    } finally {
      errors[failure] = false;
    }
    // 评审修正加固：注入必须真的触发（保存以 500 失败），不再把「注入没生效」也当成通过
    expect(result.status, `injected ${failure} failure did not trigger`).toBe(500);
    expect(result.body.error).toContain('保存设置失败');
    expect(JSON.parse(await readFile(settingsFile, 'utf8')).sessionContext.revision).toBe(revision);
    expect(runtime.settings.sessionContext).toBeDefined();
  });

  it('reports a corrupt persisted record as invalid and allows explicit replacement', async () => {
    const before = await readFile(settingsFile, 'utf8');
    const revision = JSON.parse(before).sessionContext.revision;
    await writeFile(settingsFile, JSON.stringify({ ...JSON.parse(before), sessionContext: { schemaVersion: 99, revision, config: {} } }));
    // runtime 内存对象是在模块加载时填充的：直接改内存里的值来模拟重启后的解码结果
    (runtime.settings as { sessionContext?: unknown }).sessionContext = { schemaVersion: 99, revision, config: {} };
    const view = (await state()).sessionContext;
    expect(view.saved).toBeNull();
    expect(view.invalid).toContain('schemaVersion');
    // 损坏记录阻止创建（由 sessions 测试覆盖）；显式替换即可恢复，revision 从损坏记录无法读取，重新从 1 计数
    const replacement = await post('settings', { sessionContext: { expectedRevision: 0, config: config() } });
    expect(replacement.status).toBe(200);
    expect(replacement.body.sessionContext.saved.revision).toBe(1);
  });

  // ── 正式复审 R8 残余：owner 重查按真实声明状态报告（不只目录存在）──

  it('reports not_found on recheck after the saved skill declaration is deleted, keeping saved state frozen', async () => {
    const { mkdir: makeDir, writeFile: writeFileFs, rm: rmPath } = await import('node:fs/promises');
    await makeDir(join(dir, 'health-container', 'references'), { recursive: true });
    await writeFileFs(join(dir, 'health-container', 'SKILL.md'), '---\nname: health-skill\ndescription: 健康重查来源。\n---\n健康正文。\n');
    await writeFileFs(join(dir, 'health-container', 'references', 'note.md'), '参考资料。\n');
    const saved = await post('settings', { sessionContext: { expectedRevision: JSON.parse(await readFile(settingsFile, 'utf8')).sessionContext.revision, config: config({ skillSources: [{ path: join(dir, 'health-container'), enabled: true }] }) } });
    expect(saved.status).toBe(200);
    const before = await readFile(settingsFile, 'utf8');
    const revisionBefore = JSON.parse(before).sessionContext.revision;
    // 删除声明（保留目录与 references）：重查必须报 not_found，不再把目录存在当 valid
    await rmPath(join(dir, 'health-container', 'SKILL.md'));
    await sessionContext.recheckSessionContext();
    let entry = sessionContext.stateView().health.entries.find((candidate: any) => candidate.kind === 'skill' && candidate.enabled);
    expect(entry?.status).toBe('not_found');
    // 保存记录、revision 与活动快照不被重查改变
    expect(await readFile(settingsFile, 'utf8')).toBe(before);
    expect(JSON.parse(await readFile(settingsFile, 'utf8')).sessionContext.revision).toBe(revisionBefore);
    expect(sessionContext.stateView().active?.sessionId).toBeUndefined();
    // 创建路径同诊断一致：启用来源没有声明 → 新会话无 Skill（unavailable 语义，不扩权）
    const created = await post('sessions', {});
    const loaded = created.body.sessionContext.skills ?? [];
    expect(loaded.length).toBe(0);
    // 恢复声明后重查回到 valid（recheck 有真实 1 秒限频窗口，需要真实流逝）
    await writeFileFs(join(dir, 'health-container', 'SKILL.md'), '---\nname: health-skill\ndescription: 健康重查来源。\n---\n健康正文。\n');
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await sessionContext.recheckSessionContext();
    entry = sessionContext.stateView().health.entries.find((candidate: any) => candidate.kind === 'skill' && candidate.enabled);
    expect(entry?.status).toBe('valid');
    await post('settings', { sessionContext: { expectedRevision: JSON.parse(await readFile(settingsFile, 'utf8')).sessionContext.revision, config: config() } });
  });

  // ── 六轮接收核对 2/3：逐条绑定保留 + 健康按保存绑定核对固定 canonical 目标 ──

  it('retains per-index bindings for duplicate entries and health follows the saved binding, not the raw alias', async () => {
    const { mkdir: makeDir, symlink: symlinkPath, writeFile: writeFileFs, rm: rmPath, readFile: readFileFs } = await import('node:fs/promises');
    await makeDir(join(dir, 'bind-real-a'), { recursive: true });
    await makeDir(join(dir, 'bind-real-b'), { recursive: true });
    await writeFileFs(join(dir, 'bind-real-a', 'SKILL.md'), '---\nname: bind-a\ndescription: A 来源。\n---\nA 正文。\n');
    await writeFileFs(join(dir, 'bind-real-b', 'SKILL.md'), '---\nname: bind-b\ndescription: B 来源。\n---\nB 正文。\n');
    try {
      await symlinkPath(join(dir, 'bind-real-a'), join(dir, 'bind-alias-a'));
    } catch {
      return;
    }
    // 两个重复条目（本体+alias）+ 一个独立来源；保存后 bindings 逐条保留
    const saved = await post('settings', { sessionContext: { expectedRevision: JSON.parse(await readFile(settingsFile, 'utf8')).sessionContext.revision, config: config({ skillSources: [
      { path: join(dir, 'bind-real-a'), enabled: true },
      { path: join(dir, 'bind-alias-a'), enabled: true },
      { path: join(dir, 'bind-real-b'), enabled: true },
    ] }) } });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const persisted = JSON.parse(await readFileFs(settingsFile, 'utf8'));
    expect(persisted.sessionContext.bindings.skills).toHaveLength(3);
    expect(persisted.sessionContext.bindings.skills.map((item: { index: number }) => item.index)).toEqual([0, 1, 2]);
    await sessionContext.recheckSessionContext();
    let skillEntries = sessionContext.stateView().health.entries.filter((candidate: any) => candidate.kind === 'skill' && candidate.enabled);
    expect(skillEntries.map((entry: any) => entry.status)).toEqual(['valid', 'valid', 'valid']);
    const settingsBefore = await readFileFs(settingsFile, 'utf8');
    // alias 重指向另一个已绑定目标（B）：健康仍按各自保存绑定报告，不跟随 alias 的新目标
    await rmPath(join(dir, 'bind-alias-a'));
    await symlinkPath(join(dir, 'bind-real-b'), join(dir, 'bind-alias-a'));
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await sessionContext.recheckSessionContext();
    skillEntries = sessionContext.stateView().health.entries.filter((candidate: any) => candidate.kind === 'skill' && candidate.enabled);
    expect(skillEntries.map((entry: any) => entry.status)).toEqual(['valid', 'valid', 'valid']);
    // 健康路径 = 各自保存绑定的固定 canonical 目标（目录绑定 path；文件绑定 file）
    expect(skillEntries[0].path).toBe(persisted.sessionContext.bindings.skills[0].path);
    expect(skillEntries[1].path).toBe(persisted.sessionContext.bindings.skills[1].path);
    // 删除原始目标的声明：alias 条目不得借用 alias 新目标（B）的 valid——按各自保存绑定报告失效
    await rmPath(join(dir, 'bind-real-a', 'SKILL.md'));
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await sessionContext.recheckSessionContext();
    skillEntries = sessionContext.stateView().health.entries.filter((candidate: any) => candidate.kind === 'skill' && candidate.enabled);
    expect(skillEntries[0].status).toBe('not_found');
    expect(skillEntries[1].status).toBe('not_found');
    expect(skillEntries[2].status).toBe('valid');
    // 重查不改变 settings 字节
    expect(await readFileFs(settingsFile, 'utf8')).toBe(settingsBefore);
  });

  it('marks duplicate read-root entries valid and keeps recheck read-only', async () => {
    const { mkdir: makeDir, readFile: readFileFs, writeFile: writeFileFs } = await import('node:fs/promises');
    await makeDir(join(dir, 'dup-root'), { recursive: true });
    await writeFileFs(join(dir, 'dup-root', 'f.txt'), '内容\n');
    const saved = await post('settings', { sessionContext: { expectedRevision: JSON.parse(await readFile(settingsFile, 'utf8')).sessionContext.revision, config: config({ readRoots: [
      { path: join(dir, 'dup-root'), enabled: true },
      { path: join(dir, 'dup-root'), enabled: true },
    ] }) } });
    expect(saved.status).toBe(200);
    const persisted = JSON.parse(await readFileFs(settingsFile, 'utf8'));
    expect(persisted.sessionContext.bindings.roots).toHaveLength(2);
    await sessionContext.recheckSessionContext();
    const entries = sessionContext.stateView().health.entries.filter((candidate: any) => candidate.kind === 'root' && candidate.enabled);
    expect(entries.map((entry: any) => entry.status)).toEqual(['valid', 'valid']);
    expect(entries.map((entry: any) => entry.path)).toEqual([persisted.sessionContext.bindings.roots[0].path, persisted.sessionContext.bindings.roots[1].path]);
    await post('settings', { sessionContext: { expectedRevision: JSON.parse(await readFile(settingsFile, 'utf8')).sessionContext.revision, config: config() } });
  });

  it('keeps legal duplicate canonical sources valid across recheck', async () => {
    const { mkdir: makeDir, symlink: symlinkPath, writeFile: writeFileFs } = await import('node:fs/promises');
    await makeDir(join(dir, 'dup-health'), { recursive: true });
    await writeFileFs(join(dir, 'dup-health', 'SKILL.md'), '---\nname: dup-health\ndescription: 合法重复。\n---\n正文。\n');
    try {
      await symlinkPath(join(dir, 'dup-health'), join(dir, 'dup-health-alias'));
    } catch {
      return;
    }
    const saved = await post('settings', { sessionContext: { expectedRevision: JSON.parse(await readFile(settingsFile, 'utf8')).sessionContext.revision, config: config({ skillSources: [
      { path: join(dir, 'dup-health'), enabled: true },
      { path: join(dir, 'dup-health-alias'), enabled: true },
    ] }) } });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await sessionContext.recheckSessionContext();
    const entries = sessionContext.stateView().health.entries.filter((candidate: any) => candidate.kind === 'skill' && candidate.enabled);
    expect(entries.length).toBe(2);
    expect(entries.every((entry: any) => entry.status === 'valid')).toBe(true);
    await post('settings', { sessionContext: { expectedRevision: JSON.parse(await readFile(settingsFile, 'utf8')).sessionContext.revision, config: config() } });
  });

  it('rate-limits owner rechecks without saving or creating sessions', async () => {
    // 前面的用例刚做过重查：真实 1 秒限频窗口需要真实流逝（本用例本身就在测真实时钟限频）
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const first = await post('session-context/recheck', {});
    expect(first.status).toBe(200);
    const second = await post('session-context/recheck', {});
    expect([200, 429]).toContain(second.status);
    const saved = JSON.parse(await readFile(settingsFile, 'utf8')).sessionContext.revision;
    expect(saved).toBeGreaterThan(0);
  });

  it('resolves owner-chosen root-level symlinks to their canonical targets', async () => {
    const { mkdir: makeDir, realpath } = await import('node:fs/promises');
    await makeDir(join(dir, 'real-materials'), { recursive: true });
    await writeFile(join(dir, 'real-materials', 'a.txt'), '实际内容\n');
    try {
      await symlink(join(dir, 'real-materials'), join(dir, 'linked-materials'));
    } catch {
      // 个别环境不允许 symlink；跳过此用例
      return;
    }
    const canonicalTarget = await realpath(join(dir, 'real-materials'));
    const revision = JSON.parse(await readFile(settingsFile, 'utf8')).sessionContext.revision;
    const request = { expectedRevision: revision, config: config({ readRoots: [{ path: join(dir, 'linked-materials'), enabled: true }] }) };
    const result = await post('settings', { sessionContext: request });
    expect(result.status).toBe(200);
    const persisted = JSON.parse(await readFile(settingsFile, 'utf8'));
    expect(persisted.sessionContext.bindings.roots[0].path).toBe(canonicalTarget);
    expect(result.body.sessionContext.health.entries.find((entry: any) => entry.kind === 'root')?.path).toBe(canonicalTarget);
    await post('settings', { sessionContext: { expectedRevision: persisted.sessionContext.revision, config: config() } });
  });

  it('keeps the health cache readable from the module for owner state', async () => {
    await sessionContext.refreshHealth();
    expect(sessionContext.stateView().health.checkedAt).toBeGreaterThan(0);
  });

  // ── 评审修正：资料根的授权范围下限 ────────────────────

  it('rejects a read root at the filesystem root or the plugin data directory', async () => {
    const revision = JSON.parse(await readFile(settingsFile, 'utf8')).sessionContext.revision;
    const before = await readFile(settingsFile, 'utf8');
    for (const [label, path] of [['fs-root', '/'], ['data-dir', join(dir, 'dsh-livestream')]] as const) {
      const result = await post('settings', { sessionContext: { expectedRevision: revision, config: config({ readRoots: [{ path, enabled: true }] }) } });
      expect(result.status, label).toBe(400);
      expect(result.body.error, label).toContain('资料根');
      expect(result.body.error, label).toContain('数据目录');
    }
    expect(await readFile(settingsFile, 'utf8')).toBe(before);
  });

  it('accepts the home directory as a read root with a correctable health warning', async () => {
    const { homedir } = await import('node:os');
    const revision = JSON.parse(await readFile(settingsFile, 'utf8')).sessionContext.revision;
    const result = await post('settings', { sessionContext: { expectedRevision: revision, config: config({ readRoots: [{ path: homedir(), enabled: true }] }) } });
    expect(result.status).toBe(200);
    const entry = result.body.sessionContext.health.entries.find((candidate: any) => candidate.kind === 'root' && candidate.enabled);
    expect(entry?.status).toBe('valid');
    expect(entry?.detail).toContain('主目录');
    // 恢复基线资料根
    const persisted = JSON.parse(await readFile(settingsFile, 'utf8')).sessionContext.revision;
    await post('settings', { sessionContext: { expectedRevision: persisted, config: config() } });
  });

  // ── 正式评审 R8：启用的空 Skill 来源不是成功的空 Skill ──

  it('rejects an enabled empty skill container as not_found instead of saving a valid empty skill', async () => {
    const { mkdir: makeDir } = await import('node:fs/promises');
    await makeDir(join(dir, 'empty-container'), { recursive: true });
    const revision = JSON.parse(await readFile(settingsFile, 'utf8')).sessionContext.revision;
    const before = await readFile(settingsFile, 'utf8');
    const result = await post('settings', { sessionContext: { expectedRevision: revision, config: config({ skillSources: [{ path: join(dir, 'empty-container'), enabled: true }] }) } });
    expect(result.status, 'empty container must not save as valid').toBe(400);
    expect(JSON.stringify(result.body)).toContain('not_found');
    expect(await readFile(settingsFile, 'utf8')).toBe(before);
  });

  it('rejects an enabled container whose subdirectories lack SKILL.md', async () => {
    const { mkdir: makeDir, writeFile: writeFileFs } = await import('node:fs/promises');
    await makeDir(join(dir, 'refs-only-container', 'references'), { recursive: true });
    await makeDir(join(dir, 'refs-only-container', 'scripts'), { recursive: true });
    await writeFileFs(join(dir, 'refs-only-container', 'references', 'a.md'), '参考资料不是声明。\n');
    const revision = JSON.parse(await readFile(settingsFile, 'utf8')).sessionContext.revision;
    const result = await post('settings', { sessionContext: { expectedRevision: revision, config: config({ skillSources: [{ path: join(dir, 'refs-only-container'), enabled: true }] }) } });
    expect(result.status).toBe(400);
    expect(JSON.stringify(result.body)).toContain('not_found');
  });

  it('keeps the legitimate duplicate canonical skill source saving successfully (dedup, no false empty)', async () => {
    const { mkdir: makeDir, symlink: symlinkPath } = await import('node:fs/promises');
    await makeDir(join(dir, 'dup-source'), { recursive: true });
    await writeFile(join(dir, 'dup-source', 'SKILL.md'), '---\nname: dup-skill\ndescription: 合法重复来源。\n---\ndup 正文。\n');
    try {
      await symlinkPath(join(dir, 'dup-source'), join(dir, 'dup-alias'));
    } catch {
      return;
    }
    const revision = JSON.parse(await readFile(settingsFile, 'utf8')).sessionContext.revision;
    const result = await post('settings', { sessionContext: { expectedRevision: revision, config: config({ skillSources: [
      { path: join(dir, 'dup-source'), enabled: true },
      { path: join(dir, 'dup-alias'), enabled: true },
    ] }) } });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const health = result.body.sessionContext.health.entries.filter((entry: { kind: string }) => entry.kind === 'skill');
    expect(health.every((entry: { status: string }) => entry.status === 'valid')).toBe(true);
  });

  // ── 评审修正（HIGH）：SKILL.md 是符号链接的来源必须整体拒绝，不读取目标 ──

  it('rejects a container source whose nested SKILL.md is a symlink without reading the target', async () => {
    const { mkdir, symlink, writeFile } = await import('node:fs/promises');
    // 靶子是合法声明：旧实现会跟随读取并以「发现成功」通过保存——红灯即在此失败
    await mkdir(join(dir, 'skills-link-container', 'sub'), { recursive: true });
    await writeFile(join(dir, 'outside-skill.md'), '---\nname: outside-skill\ndescription: 外部文件不应被读取。\n---\n外部正文\n');
    try {
      await symlink(join(dir, 'outside-skill.md'), join(dir, 'skills-link-container', 'sub', 'SKILL.md'));
    } catch {
      // 个别环境不允许 symlink；跳过此用例
      return;
    }
    const revision = JSON.parse(await readFile(settingsFile, 'utf8')).sessionContext.revision;
    const result = await post('settings', { sessionContext: { expectedRevision: revision, config: config({ skillSources: [{ path: join(dir, 'skills-link-container'), enabled: true }] }) } });
    expect(result.status).toBe(400);
    expect(result.body.error).toContain('符号链接');
    expect(JSON.stringify(result.body)).not.toContain('outside-skill');
  });

  it('rejects a source directory whose top-level SKILL.md is a symlink', async () => {
    const { mkdir, symlink } = await import('node:fs/promises');
    await mkdir(join(dir, 'skills-link-top'), { recursive: true });
    try {
      await symlink(join(dir, 'skills', 'note.md'), join(dir, 'skills-link-top', 'SKILL.md'));
    } catch {
      return;
    }
    const revision = JSON.parse(await readFile(settingsFile, 'utf8')).sessionContext.revision;
    const result = await post('settings', { sessionContext: { expectedRevision: revision, config: config({ skillSources: [{ path: join(dir, 'skills-link-top'), enabled: true }] }) } });
    expect(result.status).toBe(400);
    expect(result.body.error).toContain('符号链接');
  });

  // ── 二轮修正（HIGH）：候选发现之后、读取之前，中间目录被替换为 symlink 必须拒绝 ──
  // 末端 O_NOFOLLOW 不保护中间路径段：sub 目录在发现后被换成指来源外的 symlink 时，
  // 旧实现会经 lstat/读取跟随它把来源外正文收进快照。受控替换点为 discovery hooks。

  it('rejects a container whose subdirectory is swapped to a symlink after discovery, with outside content never captured', async () => {
    const { mkdir, rm, symlink, writeFile } = await import('node:fs/promises');
    // 容器：sub/SKILL.md 是真实文件（发现阶段合法）；来源外目录里有另一份合法声明、同名不同正文
    await mkdir(join(dir, 'swap-container', 'sub'), { recursive: true });
    await writeFile(join(dir, 'swap-container', 'sub', 'SKILL.md'), '---\nname: swap-inner\ndescription: 发现时的正文。\n---\n发现时正文\n');
    await mkdir(join(dir, 'outside-swap'), { recursive: true });
    await writeFile(join(dir, 'outside-swap', 'SKILL.md'), '---\nname: swap-inner\ndescription: 来源外正文不应进入快照。\n---\n来源外正文\n');
    const { discoverSkills } = await import('../src/dsh/sessionContext');
    const swapAfterDiscovery = async () => {
      // 受控替换点：候选收集之后、候选读取之前，把 sub 目录换成指来源外的 symlink
      await rm(join(dir, 'swap-container', 'sub'), { recursive: true, force: true });
      await symlink(join(dir, 'outside-swap'), join(dir, 'swap-container', 'sub'));
    };
    const result = await discoverSkills(
      { enabled: true, cwd: '', skillSources: [{ path: join(dir, 'swap-container'), enabled: true }], readRoots: [] },
      { hooks: { beforeRead: swapAfterDiscovery } },
    );
    expect(result.ok, 'mid-directory swap between discovery and read must fail discovery').toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('invalid');
      expect(JSON.stringify(result)).not.toContain('来源外正文');
    }
    await rm(join(dir, 'outside-swap'), { recursive: true, force: true });
  });

  it('rejects discovery when the trusted container root itself is replaced before candidate reads', async () => {
    const { mkdir, rename, writeFile } = await import('node:fs/promises');
    await mkdir(join(dir, 'root-swap-container'), { recursive: true });
    await writeFile(join(dir, 'root-swap-container', 'note.md'), '---\nname: root-swap-inner\ndescription: 发现时的正文。\n---\n发现时正文\n');
    const { discoverSkills } = await import('../src/dsh/sessionContext');
    const replaceRoot = async () => {
      // 整个容器目录被换成同名新目录（inode 变化），并埋入一份合法声明的新正文
      await rename(join(dir, 'root-swap-container'), join(dir, 'root-swap-original'));
      await mkdir(join(dir, 'root-swap-container'), { recursive: true });
      await writeFile(join(dir, 'root-swap-container', 'note.md'), '---\nname: root-swap-inner\ndescription: 替换后的正文。\n---\n替换后正文\n');
    };
    const result = await discoverSkills(
      { enabled: true, cwd: '', skillSources: [{ path: join(dir, 'root-swap-container'), enabled: true }], readRoots: [] },
      { hooks: { beforeRead: replaceRoot } },
    );
    expect(result.ok, 'root replacement between discovery and read must fail discovery').toBe(false);
    if (!result.ok) expect(JSON.stringify(result)).not.toContain('替换后正文');
    await rm(join(dir, 'root-swap-original'), { recursive: true, force: true });
  });
});
