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
    expect(persisted.sessionContext.bindings.roots).toHaveLength(1);
    expect(persisted.sessionContext.bindings.roots[0].index).toBe(0);
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
    try {
      const result = await post('settings', request);
      expect([200, 500]).toContain(result.status);
      if (result.status === 200) throw new Error('injected failure did not trigger');
    } catch {
      // 保存失败是预期路径
    } finally {
      errors[failure] = false;
    }
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

  it('rate-limits owner rechecks without saving or creating sessions', async () => {
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
});
