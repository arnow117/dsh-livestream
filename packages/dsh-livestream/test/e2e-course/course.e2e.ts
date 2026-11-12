import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

test('loads and controls a course from the live console', async ({ app, screen, browser }) => {
  const realRoot = process.env.FEAT007_REAL_ASSET_ROOT;
  const observedAssets = new Map<string, string>();
  let entryUrl: string | undefined;
  let blockedShared = 0;
  let blockedExternal = 0;
  await browser.route('**/*', async (route) => {
    const url = new URL(route.request.url);
    if (url.hostname !== '127.0.0.1') {
      blockedExternal++;
      return route.abort();
    }
    if (['3080', '3081', '7390', '8757'].includes(url.port)) {
      blockedShared++;
      return route.abort();
    }
    if (realRoot && url.pathname.startsWith('/course/asset/')) {
      const relative = url.pathname.split('/').slice(4).join('/');
      const response = await route.fetch();
      const body = await response.body();
      if (relative === 'ch01/index.html' && response.status === 200) entryUrl = url.href;
      if (response.status === 200) observedAssets.set(relative, createHash('sha256').update(body).digest('hex'));
      return route.fulfill({ status: response.status, headers: { ...response.headers }, body });
    }
    return route.continue();
  });
  const getFixture = async () => (await (await fetch(`${app.baseUrl}/__fixture`)).json()) as {
    canonicalPaths: { materials: string; workdir: string };
    onAir: boolean;
    spokenCount: number;
    course: { courseEpoch: string; phase: string; step: { index: number; waiting: boolean; lab?: { left: number; force: number; balanced: boolean } } | null; question: { open: boolean; lastResult: string } | null; lastAction: { status: string } | null; playUnknown: boolean } | null;
    controlRevision: string;
    sharedRequests: number;
    externalRequests: number;
    nativeCreates: Array<{ sessionId: string }>;
    nativeEvents: Array<{ type: string; turn?: number; reason?: string; errorCode?: string }>;
    modelObservations: Array<{ requested: boolean; offered: boolean }>;
    replyHeld: boolean;
    observedTurnEnds: number;
    speechAttempts: number;
  };
  const invoke = async (sessionId: string, name: string, args: Record<string, unknown>) => (await (await fetch(`${app.baseUrl}/__invoke-tool`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, name, args }),
  })).json()) as { names?: string[]; text?: string; error?: string };
  const tool = (sessionId: string) => invoke(sessionId, 'apply_livestream_course_action', { input: { kind: 'question' } });
  const initial = await getFixture();
  await app.open('/');
  await screen.getByRole('button', '设置', { exact: true }).tap();
  await screen.getByLabel('启用新直播会话设置').check();
  await screen.getByLabel('工作目录（可留空：沿用默认工作区）').fill(initial.canonicalPaths.workdir);
  await screen.getByRole('region', '新直播会话').getByRole('button', '添加资料根').tap();
  await screen.getByLabel('资料根 1 路径').fill(initial.canonicalPaths.materials);
  await screen.getByRole('region', '新直播会话').getByRole('button', '保存会话设置').tap();
  await expect(screen.getByText('已保存：将在此后新建的直播会话生效；正在播的会话不变。')).toBeVisible();
  await screen.getByRole('button', '关闭', { exact: true }).tap();
  await screen.getByRole('button', '开始彩排').tap();
  await expect.poll(async () => (await getFixture()).onAir).toBe(true);
  await expect.poll(async () => (await getFixture()).spokenCount, { timeout: 20000 }).toBeGreaterThan(0);
  const sessionId = (await getFixture()).nativeCreates[0].sessionId;
  expect((await tool(sessionId)).names ?? []).not.toContain('apply_livestream_course_action');
  const allowedText = await invoke(sessionId, 'read_livestream_material', { rootId: 'root-1', path: 'ch01/index.html', maxLines: 2 });
  expect(allowedText.text).toContain('<!doctype html>');
  const deniedText = await invoke(sessionId, 'read_livestream_material', { rootId: 'root-1', path: '../outside-secret.txt' });
  expect(deniedText.text).toContain('拒绝');
  expect(deniedText.text).not.toContain('范围外内容');
  await screen.getByRole('button', '加载课程').tap();
  await expect.poll(async () => (await getFixture()).course?.playUnknown).toBe(false);
  let oldEntryUrl: string | undefined;
  if (realRoot) {
    await expect.poll(() => !!entryUrl).toBe(true);
    oldEntryUrl = entryUrl;
    const parsed = new URL(entryUrl!);
    const capability = parsed.pathname.split('/')[3];
    const assetBase = `${parsed.origin}/course/asset/${capability}`;
    for (const path of [`${parsed.origin}/course/asset/missing/ch01/index.html`, `${assetBase}/not-in-manifest`, `${assetBase}/ch01/%69ndex.html`]) {
      const response = await fetch(path);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe('');
    }
    expect((await fetch(`${parsed.origin}/events?token=${capability}`)).status).toBe(401);
    expect((await fetch(`${parsed.origin}/said?token=${capability}`, { method: 'POST' })).status).toBe(401);
    expect((await fetch(`${parsed.origin}/media?token=${capability}`, { method: 'POST' })).status).toBe(401);
  }
  const activeTool = await tool(sessionId);
  expect(activeTool.names ?? []).toContain('apply_livestream_course_action');
  expect(activeTool.text).toContain('失效');
  const lesson = browser.frameLocator('iframe[title="实际舞台"]').frameLocator('iframe[title="课程画面"]').frameLocator('iframe[title="课件"]');
  if (realRoot) await expect(lesson.locator('#stage')).toBeVisible();
  else await expect(lesson.getByText('fixture course')).toBeVisible();
  await screen.getByRole('button', '开始', { exact: true }).tap();
  await expect.poll(async () => (await getFixture()).course?.phase).toBe('playing');
  await screen.getByRole('button', '暂停', { exact: true }).tap();
  await expect.poll(async () => (await getFixture()).course?.phase).toBe('paused');
  await screen.getByRole('button', '继续', { exact: true }).tap();
  await expect.poll(async () => (await getFixture()).course?.phase).toBe('playing');
  await screen.getByRole('button', '暂停', { exact: true }).tap();
  await expect.poll(async () => (await getFixture()).course?.phase).toBe('paused');
  await screen.getByLabel('选择步骤').selectOption({ value: '8' });
  await screen.getByRole('button', '切换步骤').tap();
  await expect.poll(async () => (await getFixture()).course?.step?.index).toBe(8);
  if (realRoot) {
    await expect(lesson.locator('#left-arm')).toBeVisible();
    await screen.getByRole('button', '模拟观众').tap();
    const selectAndWait = async (index: string) => {
      await screen.getByLabel('选择步骤').selectOption({ value: index });
      await screen.getByRole('button', '切换步骤').tap();
      await expect.poll(async () => (await getFixture()).course?.step?.index).toBe(Number(index));
      await screen.getByRole('button', '继续', { exact: true }).tap();
      await expect.poll(async () => (await getFixture()).course?.step?.waiting, { timeout: 35000 }).toBe(true);
    };
    const audience = async (message: string) => {
      const before = (await getFixture()).observedTurnEnds;
      await screen.getByPlaceholder('弹幕内容（醒目留言也用这里的字）').fill(message);
      await screen.getByRole('button', '发弹幕').tap();
      await expect.poll(async () => (await getFixture()).observedTurnEnds, { timeout: 20000 }).toBe(before + 1);
    };
    await selectAndWait('5');
    await audience('第一题选择错误项');
    await expect.poll(async () => (await getFixture()).course?.question?.lastResult).toBe('wrong');
    await audience('第一题重复错误项');
    await expect.poll(async () => (await getFixture()).course?.lastAction?.status).toBe('rejected');
    expect((await getFixture()).course?.playUnknown).toBe(false);
    await audience('第一题选择正确项');
    await expect.poll(async () => (await getFixture()).course?.question?.lastResult).toBe('correct');
    expect((await getFixture()).course?.question?.open).toBe(false);
    await audience('正确后重复回答');
    await expect.poll(async () => (await getFixture()).course?.lastAction?.status).toBe('rejected');
    expect((await getFixture()).course?.question?.lastResult).toBe('correct');
    expect((await getFixture()).course?.playUnknown).toBe(false);
    await selectAndWait('9');
    await audience('第二题选择正确项');
    await expect.poll(async () => (await getFixture()).course?.question?.lastResult).toBe('correct');
    await selectAndWait('11');
    await audience('填空输入二');
    await expect.poll(async () => (await getFixture()).course?.question?.lastResult).toBe('correct');
    await selectAndWait('8');
    await audience('真实实验动力三十牛');
    await expect.poll(async () => (await getFixture()).course?.step?.lab?.force).toBe(30);
    await expect.poll(async () => (await getFixture()).course?.step?.lab?.balanced).toBe(true);
    await expect(lesson.locator('.lab-result')).toContainText('60.0 N·m');
    await audience('真实实验动力臂一米三');
    await expect.poll(async () => (await getFixture()).course?.step?.lab?.left).toBe(1.3);
  } else {
    await expect(lesson.getByText('步骤 9')).toBeVisible();
    await screen.getByRole('button', '继续', { exact: true }).tap();
    await expect.poll(async () => (await getFixture()).course?.phase).toBe('playing');
    await screen.getByRole('button', '模拟观众').tap();
    await screen.getByPlaceholder('弹幕内容（醒目留言也用这里的字）').fill('把动力臂调为1.3米');
    await screen.getByRole('button', '发弹幕').tap();
    await expect.poll(async () => (await getFixture()).nativeEvents.some((event) => event.type === 'turn/end' && event.turn === 2), { timeout: 20000 }).toBe(true);
    const diagnostic = await getFixture();
    expect(diagnostic.modelObservations.length, JSON.stringify({ events: diagnostic.nativeEvents, model: diagnostic.modelObservations })).toBeGreaterThan(0);
    await expect.poll(async () => (await getFixture()).course?.step?.lab?.left, { timeout: 20000 }).toBe(1.3);
    await expect.poll(async () => (await getFixture()).observedTurnEnds, { timeout: 20000 }).toBe(2);
    const beforeLateReply = (await getFixture()).speechAttempts;
    await screen.getByPlaceholder('弹幕内容（醒目留言也用这里的字）').fill('等待主人切步后回答');
    await screen.getByRole('button', '发弹幕').tap();
    await expect.poll(async () => (await getFixture()).replyHeld, { timeout: 20000 }).toBe(true);
    await screen.getByLabel('选择步骤').selectOption({ value: '0' });
    await screen.getByRole('button', '切换步骤').tap();
    await expect.poll(async () => (await getFixture()).course?.step?.index).toBe(0);
    await fetch(`${app.baseUrl}/__release-reply`, { method: 'POST' });
    await expect.poll(async () => (await getFixture()).observedTurnEnds, { timeout: 20000 }).toBe(3);
    expect((await getFixture()).speechAttempts).toBe(beforeLateReply);
    await screen.getByPlaceholder('弹幕内容（醒目留言也用这里的字）').fill('等待断订阅后回答');
    await screen.getByRole('button', '发弹幕').tap();
    await expect.poll(async () => (await getFixture()).replyHeld, { timeout: 20000 }).toBe(true);
    const beforeDisconnect = await getFixture();
    const disconnected = await fetch(`${app.baseUrl}/api/dsh-livestream/disconnect`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ controlRevision: beforeDisconnect.controlRevision }),
    });
    expect(disconnected.status).toBe(200);
    await fetch(`${app.baseUrl}/__release-reply`, { method: 'POST' });
    await expect.poll(async () => (await getFixture()).observedTurnEnds, { timeout: 20000 }).toBe(4);
    const afterDisconnect = await getFixture();
    expect(afterDisconnect.speechAttempts).toBe(beforeDisconnect.speechAttempts);
    expect(afterDisconnect.course?.courseEpoch).toBe(beforeDisconnect.course?.courseEpoch);
    expect(afterDisconnect.course?.playUnknown).toBe(false);
    await screen.getByLabel('选择步骤').selectOption({ value: '1' });
    await screen.getByRole('button', '切换步骤').tap();
    await expect.poll(async () => (await getFixture()).course?.step?.index).toBe(1);
  }
  await screen.getByRole('button', '重置', { exact: true }).tap();
  await expect.poll(async () => (await getFixture()).course?.step?.index).toBe(0);
  if (oldEntryUrl) {
    const stale = await fetch(oldEntryUrl);
    expect(stale.status).toBe(404);
    expect(await stale.text()).toBe('');
  }
  await screen.getByRole('button', '结束课程').tap();
  await expect.poll(async () => (await getFixture()).course).toBe(null);
  expect((await tool(sessionId)).names ?? []).not.toContain('apply_livestream_course_action');
  const result = await getFixture();
  expect(result.sharedRequests).toBe(0);
  expect(result.externalRequests).toBe(0);
  expect(blockedShared).toBe(0);
  expect(blockedExternal).toBe(0);
  if (realRoot) {
    const paths = ['ch01/index.html', 'lib/engine.js', 'lib/engine.css', 'lib/volume.css', 'lib/book.css', 'ch01/audio/zh/timings.js', 'ch01/audio/zh/intro.mp3'];
    for (const path of paths) {
      await expect.poll(() => observedAssets.has(path)).toBe(true);
      expect(observedAssets.get(path)).toBe(createHash('sha256').update(await readFile(join(realRoot, path))).digest('hex'));
    }
  }
});
