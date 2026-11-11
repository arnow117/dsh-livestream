import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

interface Fixture {
  nativeCreates: Array<Record<string, unknown>>;
  toolInvocations: Array<{ name: string; status: string; result: unknown }>;
  observedToolSets: string[][];
  installedDependencies: number;
  executedScripts: number;
  materialWrites: number;
  externalFetchByAgents: number;
  sharedRequests: number;
  externalRequests: number;
  sessionContext: { saved: { revision: number } | null; active: { sessionId: string } | null; invalid?: string };
  onAir: boolean;
  canonicalPaths: { materials: string; skills: string; workdir: string };
}

const fixture = async (baseUrl: string): Promise<Fixture> => (await fetch(`${baseUrl}/__fixture`)).json();
const invoke = async (baseUrl: string, sessionId: string, name: string, args: Record<string, unknown>) =>
  (await (await fetch(`${baseUrl}/__invoke-tool`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, name, args }) })).json()) as { ok?: boolean; text?: string; names?: string[]; error?: string };

test('saves session context from the console, creates a managed native session, and serves frozen skills with bounded reads', async ({ app, screen }) => {
  const before = await fixture(app.baseUrl);
  // 控制台旅程：设置抽屉 → 新直播会话 → 保存（真实路由 + 原子 settings 提交）
  await app.open('/');
  await screen.getByRole('button', '设置', { exact: true }).tap();
  await screen.getByLabel('启用新直播会话设置').check();
  const cwd = screen.getByLabel('工作目录（可留空：沿用默认工作区）');
  await cwd.fill(before.canonicalPaths.workdir);
  const panel = screen.getByRole('region', '新直播会话');
  await panel.getByRole('button', '添加 Skill 来源').tap();
  await panel.getByRole('button', '添加资料根').tap();
  await screen.getByLabel('Skill 来源 1 路径').fill(before.canonicalPaths.skills);
  await screen.getByLabel('资料根 1 路径').fill(before.canonicalPaths.materials);
  await screen.getByRole('region', '新直播会话').getByRole('button', '保存会话设置').tap();
  await expect(screen.getByText('已保存：将在此后新建的直播会话生效；正在播的会话不变。')).toBeVisible();
  const afterSave = await fixture(app.baseUrl);
  expect(afterSave.sessionContext.saved).not.toBeNull();

  // 新直播会话（管理路径）：先创建会话，再进入开播
  await screen.getByRole('button', '关闭', { exact: true }).tap();
  await screen.getByRole('button', '开始彩排').tap();
  await expect.poll(async () => (await fixture(app.baseUrl)).onAir).toBe(true);
  const state = await fixture(app.baseUrl);
  expect(state.nativeCreates).toHaveLength(1);
  const nativeRequest = state.nativeCreates[0];
  expect(nativeRequest.cwd).toBe(before.canonicalPaths.workdir);
  expect(nativeRequest.agentPreset).toBe('dsh-livestream');
  expect(nativeRequest.workspaceId).toBeUndefined();
  const sessionId = String(nativeRequest.sessionId);
  expect(state.sessionContext.active?.sessionId).toBe(sessionId);

  // 真实 header：native create 把 cwd 写入 Session header；有效目录从 header 初始化
  const header = await (await fetch(`${app.baseUrl}/__header-cwd`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId }) })).json();
  expect(header.cwd).toBe(before.canonicalPaths.workdir);

  // 冻结快照持久化：固定输入与正文，不保存资料文件内容
  const snapshot = await (await fetch(`${app.baseUrl}/__snapshot-file`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId }) })).json();
  expect(snapshot.sessionId).toBe(sessionId);
  expect(snapshot.skills[0].body).toContain('papermorph 的冻结正文');
  expect(snapshot.skills[0].sourceHash).toMatch(/^[0-9a-f]{64}$/);
  expect(JSON.stringify(snapshot)).not.toContain('第一课：受控资料内容');

  // 实际工具执行：冻结正文、允许读取、越界拒绝（原生 toolset 解析 + 执行）
  const loaded = await invoke(app.baseUrl, sessionId, 'load_livestream_skill', { name: 'papermorph' });
  expect(loaded.ok).toBe(true);
  expect(loaded.text).toContain('papermorph 的冻结正文');
  const allow = await invoke(app.baseUrl, sessionId, 'read_livestream_material', { rootId: 'root-1', path: '课件/lesson-1.txt' });
  expect(allow.ok).toBe(true);
  expect(allow.text).toContain('第一课：受控资料内容');
  expect(allow.text).toMatch(/第 1-2 行/);
  const denied = await invoke(app.baseUrl, sessionId, 'read_livestream_material', { rootId: 'root-1', path: '../outside-secret.txt' });
  expect(denied.ok).toBe(true);
  expect(denied.text).toContain('已拒绝');
  expect(denied.text).not.toContain('范围外内容');
  const unknownRoot = await invoke(app.baseUrl, sessionId, 'read_livestream_material', { rootId: 'root-9', path: '课件/lesson-1.txt' });
  expect(unknownRoot.text).toContain('已拒绝');

  // 实际 toolset：只有既有直播预设工具加两个受限工具，没有 Shell、fs、插件安装类工具
  const toolsetState = await fixture(app.baseUrl);
  const names = toolsetState.observedToolSets.at(-1) ?? [];
  const allowedTools = new Set(['show_stats', 'weather_lookup', 'public_search', 'load_livestream_skill', 'read_livestream_material']);
  for (const name of names) {
    expect(allowedTools.has(name), `unexpected tool ${name} in ${JSON.stringify(names)}`).toBe(true);
  }
  expect(names, JSON.stringify(names)).toContain('load_livestream_skill');
  expect(names).toContain('read_livestream_material');

  // 保存失败保护：无效保存保留上次成功配置
  const badSave = await (await fetch(`${app.baseUrl}/__save-config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    enabled: true,
    cwd: '/does/not/exist',
    skillSources: [],
    readRoots: [],
  }) })).json();
  expect(badSave.status).toBe(400);
  expect((await fixture(app.baseUrl)).sessionContext.saved).not.toBeNull();

  // A/B：活动 A 不变；保存 B 并修改磁盘正文后，新会话取得 B 的冻结正文
  await fetch(`${app.baseUrl}/__write-skill`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: '---\nname: papermorph\ndescription: 把文章做成可翻页的网页书（fixture 正文）。\n---\n这是 papermorph 的第二版正文。\n' }) });
  const saveB = await (await fetch(`${app.baseUrl}/__save-config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    enabled: true,
    cwd: before.canonicalPaths.workdir,
    skillSources: [{ path: before.canonicalPaths.skills, enabled: true }],
    readRoots: [{ path: before.canonicalPaths.materials, enabled: true }],
  }) })).json();
  expect(saveB.status).toBe(200);
  const oldLoad = await invoke(app.baseUrl, sessionId, 'load_livestream_skill', { name: 'papermorph' });
  expect(oldLoad.text).toContain('papermorph 的冻结正文');
  await screen.getByRole('button', '设置', { exact: true }).tap();
  await screen.getByRole('button', '关闭', { exact: true }).tap();
  await screen.getByRole('button', '下播（先让她道别）').tap();
  await expect.poll(async () => (await fixture(app.baseUrl)).onAir).toBe(false);
  await screen.getByRole('button', '开始彩排').tap();
  await expect.poll(async () => (await fixture(app.baseUrl)).onAir).toBe(true);
  const abState = await fixture(app.baseUrl);
  expect(abState.nativeCreates).toHaveLength(2);
  const secondSessionId = String(abState.nativeCreates[1].sessionId);
  expect(secondSessionId).not.toBe(sessionId);
  const newLoad = await invoke(app.baseUrl, secondSessionId, 'load_livestream_skill', { name: 'papermorph' });
  expect(newLoad.text).toContain('第二版正文');
  const snapshotB = await (await fetch(`${app.baseUrl}/__snapshot-file`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: secondSessionId }) })).json();
  expect(snapshotB.revision).toBe(abState.sessionContext.saved.revision ?? snapshotB.revision);

  // 预算与计数：零脚本、零依赖安装、零资料写入；不触共享端口与外网
  expect(abState.executedScripts).toBe(0);
  expect(abState.installedDependencies).toBe(0);
  expect(abState.materialWrites).toBe(0);
  expect(abState.sharedRequests).toBe(0);
  expect(abState.externalRequests).toBe(0);
  expect((await fetch(`${app.baseUrl}/api/dsh-livestream/offair`, { method: 'POST' })).status).toBe(200);
  await screen.getByRole('button', '设置', { exact: true }).tap();
  await screen.getByRole('region', '新直播会话').scrollIntoView();
  await app.screenshot('session-context-journey');
});

test('degrades gracefully when the skill source disappears before creating a new session', async ({ app }) => {
  const state = await fixture(app.baseUrl);
  expect(state.sessionContext.saved).not.toBeNull();
  // 删除 Skill 来源文件（来源父目录仍在）；创建降级为问题标记，会话仍可建立
  const { rm } = await import('node:fs/promises');
  const dshHome = state.sessionContext ? undefined : undefined;
  void dshHome;
  const fixturePaths = await (await fetch(`${app.baseUrl}/__fixture`)).json();
  await rm(fixturePaths.canonicalPaths.skills, { force: true });
  const created = await (await fetch(`${app.baseUrl}/__managed-session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId: 'fixture' }) })).json();
  expect(created.status).toBe(200);
  expect(created.body.sessionContext.skills).toHaveLength(0);
  expect(created.body.sessionContext.issues.join()).toContain('papermorph');
  const loaded = await invoke(app.baseUrl, created.body.sessionId, 'load_livestream_skill', { name: 'papermorph' });
  expect(loaded.text).toContain('不可用');
});
