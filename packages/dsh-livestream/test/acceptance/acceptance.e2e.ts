import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * FEAT-010-T001 同版内部组合旅程。
 *
 * 一个浏览器会话里同时核对：真实 SDK 准入、真实 Stage（正式舞台有声音解锁，预览静音）、
 * 真实课程、公屏未装配零派发、私有读取只到原受众，以及公开面零泄漏。
 */
interface Composition {
  ports: { app: number; model: number; stage: number; bridge: number };
  admission: {
    ownerStatus: number;
    guestPeerStatus: number;
    guestPrincipalKind: string | null;
    ownerPrincipalKind: string | null;
    unauthenticatedStatus: number | null;
  };
  publicChat: {
    view: { ok: boolean; publicChat?: { available: boolean; historyAvailable: boolean; identity: unknown } };
    maintain: { ok: boolean; reason?: string };
    senderRequests: string[];
    controller: Record<string, any>;
  };
  registration: Record<string, any>;
  leak: Record<string, number>;
  stage: { receipts: Array<{ kind: string; id: string; result?: string }>; events: Array<{ type: string; id: string; text?: string; hasAudio?: boolean; onAir: boolean; ending: boolean }> };
  course: { phase: string; step: { index: number; waiting?: boolean; lab?: { left: number } } | null; question?: { lastResult: string; open: boolean } | null; playUnknown: boolean } | null;
  onAir: boolean | null;
  ending: boolean;
  brain: string | null;
  spokenCount: number;
  speechAttempts: number;
  observedTurnEnds: number;
  replyHeld: boolean;
  releasedModelResponses: number;
  hubConnected: boolean;
  ttsHeld: boolean;
  settledSpeech: number;
  nativeCreates: Array<{ sessionId: string; cwd?: string }>;
  counters: { sharedRequests: number; externalRequests: number };
  canonicalPaths: { materials: string; workdir: string };
}

test('exercises the host and course alongside a separate offline controller fixture', async ({ app, screen, browser }) => {
  const getComposition = async () => (await (await fetch(`${app.baseUrl}/__acceptance`)).json()) as Composition;
  let blockedExternal = 0;
  let blockedShared = 0;
  await browser.addInitScript(() => {
    if (window === window.top) {
      (window as any).__fixtureAudio = [];
      window.addEventListener('message', (event) => {
        if (event.data?.type === 'feat010-audio') (window as any).__fixtureAudio.push(event.data);
      });
      return;
    }
    const OriginalAudio = window.Audio;
    let rejectFirst = !new URL(location.href).searchParams.has('preview');
    let holdEnded = false;
    const pendingEnded: Array<() => void> = [];
    window.addEventListener('message', (event) => {
      if (event.data?.type !== 'feat010-control') return;
      holdEnded = event.data.hold === true;
      if (!holdEnded) while (pendingEnded.length) pendingEnded.shift()?.();
      window.parent.postMessage({ type: 'feat010-audio', kind: holdEnded ? 'holding' : 'released', preview: false }, '*');
    });
    const observed = function (src?: string) {
      const player = new OriginalAudio(src);
      const preview = new URL(location.href).searchParams.get('preview') === '1';
      const report = (kind: string) => window.parent.postMessage({ type: 'feat010-audio', preview, kind, hasSource: !!src }, '*');
      report('created');
      for (const kind of ['playing', 'ended', 'error']) player.addEventListener(kind, () => report(kind));
      let onended: ((event: Event) => unknown) | null = null;
      Object.defineProperty(player, 'onended', {
        configurable: true,
        get: () => onended,
        set: (listener) => { onended = listener; },
      });
      player.addEventListener('ended', (event) => {
        const deliver = () => onended?.call(player, event);
        if (holdEnded) { pendingEnded.push(deliver); report('ended-held'); }
        else deliver();
      });
      if (src && rejectFirst) {
        rejectFirst = false;
        player.play = () => Promise.reject(new DOMException('fixture autoplay denied', 'NotAllowedError'));
      }
      return player;
    };
    Object.setPrototypeOf(observed, OriginalAudio);
    window.Audio = observed as unknown as typeof Audio;
  });
  await browser.route('**/*', async (route) => {
    const url = new URL(route.request.url);
    if (url.hostname !== '127.0.0.1') { blockedExternal++; return route.abort(); }
    if (['3080', '3081', '7390', '8757'].includes(url.port)) { blockedShared++; return route.abort(); }
    if (url.pathname.startsWith('/api/')) {
      const kind = url.searchParams.get('fixture-auth');
      const headers = { ...route.request.headers };
      if (kind === 'guest') headers['x-fixture-guest'] = 'guest-fixture';
      else if (kind !== 'anonymous') headers['x-fixture-owner'] = 'owner-fixture';
      return route.continue({ headers });
    }
    return route.continue();
  });

  const composition = await getComposition();

  /* S1：真实 SDK 准入（owner / nonowner peer / 未认证） */
  expect(composition.admission.ownerPrincipalKind).toBe('owner');
  expect(composition.admission.guestPrincipalKind).toBe('guest');
  expect(composition.admission.ownerStatus).toBe(200);
  expect(composition.admission.guestPeerStatus).toBe(403);
  expect(composition.admission.unauthenticatedStatus).toBe(401);

  /* S3：公屏未装配即零派发；控制器级既有离线 seam 组合保持原规则 */
  expect(composition.publicChat.view.ok).toBe(true);
  expect(composition.publicChat.view.publicChat?.available).toBe(false);
  expect(composition.publicChat.maintain.ok).toBe(false);
  expect(composition.publicChat.senderRequests).toEqual([]);
  const controller = composition.publicChat.controller;
  expect(controller.qualificationWithoutGrant.sends).toBe(0);
  expect(controller.authorized.submitStatus).toBe('accepted');
  expect(controller.authorized.sends).toBe(1);
  expect(controller.authorized.sentSourceKey).toBe('src-1');
  expect(controller.afterRevoke.sends).toBe(1);
  expect(controller.afterDisconnect.sends).toBe(1);
  expect(controller.afterEnd.sends).toBe(1);
  expect(controller.unknown.state).toBe('unknown');
  expect(controller.unknown.hold).toBe(true);
  expect(controller.unknown.nextStatus).toBe('rejected');
  expect(controller.unknown.duplicateStatus).toBe('duplicate');

  /* S6：私有读取只到原受众，公开面零泄漏 */
  expect(composition.registration.guestLiveReadStatus).toBe(403);
  expect(composition.registration.authorization.status).toBe(200);
  expect(composition.registration.liveRead.status).toBe(200);
  expect(composition.registration.robotRead.status).toBe(200);
  expect(composition.registration.liveRead.matchesFixture).toBe(true);
  expect(composition.registration.robotRead.matchesFixture).toBe(true);
  expect(composition.registration.afterRevokeRead.containsFixture).toBe(false);
  for (const [key, hits] of Object.entries(composition.leak)) expect(hits, key).toBe(0);

  /* 守卫负例与正式计数分开 */
  expect(composition.counters.sharedRequests).toBe(0);
  expect(composition.counters.externalRequests).toBe(0);
  expect(blockedShared).toBe(0);
  expect(blockedExternal).toBe(0);

  /* 控制台可达性：1440 与 375 都要能拿到关键操作 */
  await app.open('/');
  const browserAdmission = await browser.evaluate(async () => {
    const request = (query: string) => fetch(`/api/dsh-livestream/state${query}`).then((response) => response.status);
    return {
      owner: await request(''),
      guest: await request('?fixture-auth=guest'),
      anonymous: await request('?fixture-auth=anonymous'),
    };
  });
  expect(browserAdmission).toEqual({ owner: 200, guest: 401, anonymous: 401 });
  await expect(screen.getByRole('button', '设置', { exact: true })).toBeVisible();
  await screen.getByRole('button', '设置', { exact: true }).tap();
  await screen.getByLabel('启用新直播会话设置').check();
  await screen.getByLabel('工作目录（可留空：沿用默认工作区）').fill(composition.canonicalPaths.workdir);
  await screen.getByRole('region', '新直播会话').getByRole('button', '添加资料根').tap();
  await screen.getByLabel('资料根 1 路径').fill(composition.canonicalPaths.materials);
  await screen.getByRole('region', '新直播会话').getByRole('button', '保存会话设置').tap();
  await expect(screen.getByText('已保存：将在此后新建的直播会话生效；正在播的会话不变。')).toBeVisible();
  await screen.getByRole('button', '关闭', { exact: true }).tap();

  /* S1：正式舞台与静音预览的区别（同一份 Stage 产物） */
  const stage = browser.frameLocator('iframe[title="实际舞台"]');
  await expect(stage.locator('body')).toBeVisible();
  const preview = browser.frameLocator('iframe[title="静音预览"]');
  await expect(preview.locator('body')).toBeVisible();
  await app.screenshot('console-and-stages');

  await screen.getByRole('button', '开始本地舞台').tap();
  await expect.poll(async () => (await getComposition()).onAir).toBe(true);
  await expect(stage.getByRole('button', '点一下这里开启声音（OBS 的浏览器源不需要）')).toBeVisible();
  await browser.evaluate(() => {
    const frame = document.querySelector('iframe[title="实际舞台"]') as HTMLIFrameElement;
    frame.style.position = 'fixed';
    frame.style.top = '0';
    frame.style.zIndex = '100';
    return null;
  });
  await stage.getByRole('button', '点一下这里开启声音（OBS 的浏览器源不需要）').tap();
  await expect(stage.getByRole('button', '点一下这里开启声音（OBS 的浏览器源不需要）')).not.toBeVisible();
  await browser.evaluate(() => {
    const frame = document.querySelector('iframe[title="实际舞台"]') as HTMLIFrameElement;
    frame.style.position = '';
    frame.style.top = '';
    frame.style.zIndex = '';
    return null;
  });
  await expect.poll(async () => (await getComposition()).observedTurnEnds, { timeout: 20000 }).toBeGreaterThan(0);
  await expect.poll(async () => (await getComposition()).brain, { timeout: 20000 }).toBe('listening');
  const opening = await getComposition();
  const openingLine = opening.stage.events.find((event) => event.hasAudio && event.id);
  expect(openingLine?.text).toBe('大家好。');
  expect(opening.stage.receipts.some((receipt) => receipt.kind === 'audio' && receipt.id === openingLine?.id && receipt.result === 'error')).toBe(true);
  const created = (await getComposition()).nativeCreates[0];
  expect(created.cwd).toBe(composition.canonicalPaths.workdir);
  await screen.getByRole('button', '加载课程').tap();
  await expect.poll(async () => (await getComposition()).course?.playUnknown).toBe(false);
  const lesson = stage.frameLocator('iframe[title="课程画面"]').frameLocator('iframe[title="课件"]');
  await expect(lesson.getByText('feat010 course')).toBeVisible();
  await screen.getByRole('button', '开始', { exact: true }).tap();
  await expect.poll(async () => (await getComposition()).course?.phase).toBe('playing');
  await screen.getByRole('button', '模拟观众').tap();
  await browser.evaluate(() => {
    const frame = document.querySelector('iframe[title="实际舞台"]') as HTMLIFrameElement;
    frame.contentWindow?.postMessage({ type: 'feat010-control', hold: true }, '*');
    return null;
  });
  await expect.poll(() => browser.evaluate(() => (window as any).__fixtureAudio.some((event: any) => event.kind === 'holding'))).toBe(true);
  const beforeReply = await getComposition();
  await screen.getByPlaceholder('弹幕内容（醒目留言也用这里的字）').fill('讲解当前课程');
  await screen.getByRole('button', '发弹幕').tap();
  await expect.poll(() => browser.evaluate(() => (window as any).__fixtureAudio.some((event: any) => event.kind === 'ended-held')), { timeout: 20000 }).toBe(true);
  await expect.poll(async () => (await getComposition()).observedTurnEnds, { timeout: 20000 }).toBeGreaterThan(beforeReply.observedTurnEnds);
  const held = await getComposition();
  const heldLine = held.stage.events.at(-1);
  expect(held.course?.phase).toBe('paused');
  expect(heldLine?.hasAudio).toBe(true);
  expect(held.stage.receipts.some((receipt) => receipt.kind === 'audio' && receipt.id === heldLine?.id && receipt.result === 'ended')).toBe(false);
  await browser.evaluate(() => {
    const frame = document.querySelector('iframe[title="实际舞台"]') as HTMLIFrameElement;
    frame.contentWindow?.postMessage({ type: 'feat010-control', hold: false }, '*');
    return null;
  });
  await expect.poll(async () => (await getComposition()).stage.receipts.some((receipt) => receipt.kind === 'audio' && receipt.id === heldLine?.id && receipt.result === 'ended')).toBe(true);
  await expect.poll(async () => (await getComposition()).course?.phase).toBe('playing');
  await screen.getByRole('button', '暂停', { exact: true }).tap();
  await expect.poll(async () => (await getComposition()).course?.phase).toBe('paused');
  await screen.getByRole('button', '继续', { exact: true }).tap();
  await expect.poll(async () => (await getComposition()).course?.phase).toBe('playing');
  await screen.getByRole('button', '暂停', { exact: true }).tap();
  await screen.getByLabel('选择步骤').focus();
  expect(await browser.evaluate(() => (document.activeElement?.id ?? null))).toBe('course-step');
  await screen.getByLabel('选择步骤').selectOption({ value: '8' });
  await screen.getByRole('button', '切换步骤').tap();
  await expect.poll(async () => (await getComposition()).course?.step?.index).toBe(8);
  await screen.getByRole('button', '继续', { exact: true }).tap();
  await screen.getByPlaceholder('弹幕内容（醒目留言也用这里的字）').fill('把动力臂调为1.3米');
  await screen.getByRole('button', '发弹幕').tap();
  await expect.poll(async () => (await getComposition()).course?.step?.lab?.left, { timeout: 20000 }).toBe(1.3);
  await expect.poll(async () => (await getComposition()).observedTurnEnds, { timeout: 20000 }).toBeGreaterThan(1);
  await expect.poll(async () => (await getComposition()).brain, { timeout: 20000 }).toBe('listening');
  await expect(screen.getByText('动力臂 1.3 m · 阻力臂 1 m · 动力 20 N · 未平衡')).toBeVisible();
  await expect.poll(async () => (await getComposition()).stage.receipts.some((receipt) => receipt.kind === 'audio' && receipt.result === 'ended'), { timeout: 10000 }).toBe(true);
  await app.screenshot('course-action');
  expect(await browser.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await screen.getByRole('button', '重置', { exact: true }).tap();
  await expect.poll(async () => (await getComposition()).course?.step?.index).toBe(0);
  await screen.getByRole('button', '继续', { exact: true }).tap();
  await expect.poll(async () => (await getComposition()).course?.phase).toBe('playing');
  await screen.getByPlaceholder('弹幕内容（醒目留言也用这里的字）').fill('等待主人切步后回答');
  await screen.getByRole('button', '发弹幕').tap();
  await expect.poll(async () => (await getComposition()).replyHeld, { timeout: 20000 }).toBe(true);
  await screen.getByRole('button', '下播（先让她道别）').tap();
  const ending = await getComposition();
  expect(ending.onAir).toBe(true);
  expect(ending.ending).toBe(true);
  await fetch(`${app.baseUrl}/__release-reply`, { method: 'POST' });
  await expect.poll(async () => (await getComposition()).onAir, { timeout: 30000 }).toBe(false);
  await expect.poll(async () => (await getComposition()).course).toBe(null);
  const afterEnd = await getComposition();
  const lateModelEvents = afterEnd.stage.events.filter((event) => event.text === '迟到测试回答。');
  console.log('held model events by lifecycle', JSON.stringify(lateModelEvents.map(({ onAir, ending }) => ({ onAir, ending }))));
  expect(lateModelEvents.some((event) => !event.onAir)).toBe(false);
  const final = await getComposition();
  for (const [key, hits] of Object.entries(final.leak)) expect(hits, key).toBe(0);
  const audio = await browser.evaluate(() => (window as any).__fixtureAudio as Array<{ preview: boolean; kind: string; hasSource: boolean }>);
  expect(audio.some((event) => !event.preview && event.kind === 'created' && event.hasSource)).toBe(true);
  expect(audio.some((event) => !event.preview && event.kind === 'playing')).toBe(true);
  expect(audio.some((event) => !event.preview && event.kind === 'ended')).toBe(true);
  expect(audio.filter((event) => event.preview && event.hasSource)).toEqual([]);
  expect(final.counters.sharedRequests).toBe(0);
  expect(final.counters.externalRequests).toBe(0);
  expect(blockedShared).toBe(0);
  expect(blockedExternal).toBe(0);
});

test('reads the fixed course and exercises its question and parameter', async ({ app, screen, browser }) => {
  await browser.addInitScript(() => {
    if (window === window.top) {
      (window as any).__fixedCourseAudio = [];
      window.addEventListener('message', (event) => {
        if (event.data?.type === 'feat010-fixed-audio') (window as any).__fixedCourseAudio.push(event.data.kind);
      });
      return;
    }
    if (location.pathname !== '/' || new URL(location.href).searchParams.has('preview')) return;
    const OriginalAudio = window.Audio;
    let holding = false;
    const pending: Array<() => void> = [];
    window.addEventListener('message', (event) => {
      if (event.data?.type !== 'feat010-fixed-control') return;
      holding = event.data.hold === true;
      if (!holding) while (pending.length) pending.shift()?.();
      window.parent.postMessage({ type: 'feat010-fixed-audio', kind: holding ? 'holding' : 'released' }, '*');
    });
    const observed = function (src?: string) {
      const player = new OriginalAudio(src);
      let onended: ((event: Event) => unknown) | null = null;
      Object.defineProperty(player, 'onended', { configurable: true, get: () => onended, set: (listener) => { onended = listener; } });
      player.addEventListener('ended', (event) => {
        const deliver = () => onended?.call(player, event);
        if (holding) { pending.push(deliver); window.parent.postMessage({ type: 'feat010-fixed-audio', kind: 'held' }, '*'); }
        else deliver();
      });
      return player;
    };
    Object.setPrototypeOf(observed, OriginalAudio);
    window.Audio = observed as unknown as typeof Audio;
  });
  const root = process.env.DSH_ACCEPTANCE_COURSE_ROOT;
  if (!root) throw new Error('fixed course root required for this test');
  const observed = new Map<string, string>();
  let blocked = 0;
  await browser.route('**/*', async (route) => {
    const url = new URL(route.request.url);
    if (url.hostname !== '127.0.0.1' || ['3080', '3081', '7390', '8757'].includes(url.port)) { blocked++; return route.abort(); }
    if (url.pathname.startsWith('/api/')) return route.continue({ headers: { ...route.request.headers, 'x-fixture-owner': 'owner-fixture' } });
    if (url.pathname.startsWith('/course/asset/')) {
      const path = url.pathname.split('/').slice(4).join('/');
      const response = await route.fetch();
      const bytes = await response.body();
      if (response.status === 200) observed.set(path, createHash('sha256').update(bytes).digest('hex'));
      return route.fulfill({ status: response.status, headers: { ...response.headers }, body: bytes });
    }
    return route.continue();
  });
  const state = async () => (await (await fetch(`${app.baseUrl}/__acceptance`)).json()) as Composition;
  const initial = await state();
  expect(initial.canonicalPaths.materials).toBe(root);
  await app.open('/');
  await screen.getByRole('button', '设置', { exact: true }).tap();
  await screen.getByLabel('启用新直播会话设置').check();
  await screen.getByLabel('工作目录（可留空：沿用默认工作区）').fill(initial.canonicalPaths.workdir);
  await screen.getByRole('region', '新直播会话').getByRole('button', '添加资料根').tap();
  await screen.getByLabel('资料根 1 路径').fill(root);
  await screen.getByRole('region', '新直播会话').getByRole('button', '保存会话设置').tap();
  await expect(screen.getByText('已保存：将在此后新建的直播会话生效；正在播的会话不变。')).toBeVisible();
  await screen.getByRole('button', '关闭', { exact: true }).tap();
  await screen.getByRole('button', '开始本地舞台').tap();
  await expect.poll(async () => (await state()).observedTurnEnds, { timeout: 20000 }).toBeGreaterThan(0);
  await expect.poll(async () => (await state()).brain, { timeout: 20000 }).toBe('listening');
  await screen.getByRole('button', '加载课程').tap();
  await expect.poll(async () => (await state()).course?.playUnknown).toBe(false);
  const session = (await state()).nativeCreates[0].sessionId;
  const toolResponse = await fetch(`${app.baseUrl}/__invoke-tool`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: session, name: 'apply_livestream_course_action', args: { input: { kind: 'question' } } }),
  });
  const tools = await toolResponse.json() as { names: string[]; registeredNames: string[] };
  expect(tools.registeredNames).toContain('apply_livestream_course_action');
  expect(tools.registeredNames).toContain('send_public_chat_reply');
  expect(tools.names).toContain('apply_livestream_course_action');
  expect(tools.names).not.toContain('send_public_chat_reply');
  const lesson = browser.frameLocator('iframe[title="实际舞台"]').frameLocator('iframe[title="课程画面"]').frameLocator('iframe[title="课件"]');
  await expect(lesson.locator('#stage')).toBeVisible();
  await screen.getByRole('button', '开始', { exact: true }).tap();
  await expect.poll(async () => (await state()).course?.phase).toBe('playing');
  await screen.getByRole('button', '模拟观众').tap();
  await browser.evaluate(() => {
    (document.querySelector('iframe[title="实际舞台"]') as HTMLIFrameElement).contentWindow?.postMessage({ type: 'feat010-fixed-control', hold: true }, '*');
    return null;
  });
  await expect.poll(() => browser.evaluate(() => (window as any).__fixedCourseAudio.includes('holding'))).toBe(true);
  const beforeReply = await state();
  await screen.getByPlaceholder('弹幕内容（醒目留言也用这里的字）').fill('请解释当前固定课件');
  await screen.getByRole('button', '发弹幕').tap();
  await expect.poll(() => browser.evaluate(() => (window as any).__fixedCourseAudio.includes('held')), { timeout: 20000 }).toBe(true);
  const held = await state();
  const reply = held.stage.events.slice(beforeReply.stage.events.length).find((event) => event.hasAudio);
  expect(reply).toBeDefined();
  expect(held.course?.phase).toBe('paused');
  expect(held.stage.receipts.some((entry) => entry.id === reply?.id && entry.result === 'ended')).toBe(false);
  await browser.evaluate(() => {
    (document.querySelector('iframe[title="实际舞台"]') as HTMLIFrameElement).contentWindow?.postMessage({ type: 'feat010-fixed-control', hold: false }, '*');
    return null;
  });
  await expect.poll(async () => (await state()).stage.receipts.some((entry) => entry.id === reply?.id && entry.result === 'ended')).toBe(true);
  await expect.poll(async () => (await state()).course?.phase, { timeout: 20000 }).toBe('playing');
  await screen.getByRole('button', '暂停', { exact: true }).tap();
  await screen.getByLabel('选择步骤').selectOption({ value: '5' });
  await screen.getByRole('button', '切换步骤').tap();
  await expect.poll(async () => (await state()).course?.step?.index).toBe(5);
  await screen.getByRole('button', '继续', { exact: true }).tap();
  await expect.poll(async () => (await state()).course?.step?.waiting, { timeout: 35000 }).toBe(true);
  for (const [message, result] of [['第一题选择错误项', 'wrong'], ['第一题选择正确项', 'correct']]) {
    const before = (await state()).observedTurnEnds;
    await screen.getByPlaceholder('弹幕内容（醒目留言也用这里的字）').fill(message);
    await screen.getByRole('button', '发弹幕').tap();
    await expect.poll(async () => (await state()).observedTurnEnds, { timeout: 20000 }).toBeGreaterThan(before);
    await expect.poll(async () => (await state()).course?.question?.lastResult).toBe(result);
  }
  await screen.getByLabel('选择步骤').selectOption({ value: '8' });
  await screen.getByRole('button', '切换步骤').tap();
  await expect.poll(async () => (await state()).course?.step?.index).toBe(8);
  await screen.getByRole('button', '继续', { exact: true }).tap();
  await expect.poll(async () => (await state()).course?.step?.waiting, { timeout: 35000 }).toBe(true);
  const beforeParameter = (await state()).observedTurnEnds;
  await screen.getByPlaceholder('弹幕内容（醒目留言也用这里的字）').fill('把动力臂调为1.3米');
  await screen.getByRole('button', '发弹幕').tap();
  await expect.poll(async () => (await state()).observedTurnEnds, { timeout: 20000 }).toBeGreaterThan(beforeParameter);
  await expect.poll(async () => (await state()).course?.step?.lab?.left).toBe(1.3);
  await app.screenshot('fixed-course-parameter');
  await expect.poll(async () => (await state()).brain, { timeout: 20000 }).toBe('listening');
  const beforeLate = await state();
  await fetch(`${app.baseUrl}/__arm-tts`, { method: 'POST' });
  await screen.getByPlaceholder('弹幕内容（醒目留言也用这里的字）').fill('固定课件结束前的迟到语音');
  await screen.getByRole('button', '发弹幕').tap();
  await expect.poll(async () => (await state()).ttsHeld, { timeout: 20000 }).toBe(true);
  await expect.poll(async () => (await state()).speechAttempts - beforeLate.speechAttempts, { timeout: 20000 }).toBe(2);
  await screen.getByRole('button', '下播（先让她道别）').tap();
  const ending = await state();
  expect(ending.onAir).toBe(true);
  expect(ending.ending).toBe(true);
  await expect.poll(async () => (await state()).onAir, { timeout: 105000 }).toBe(false);
  const completed = await state();
  expect(completed.course).toBe(null);
  await fetch(`${app.baseUrl}/__release-tts`, { method: 'POST' });
  await expect.poll(async () => (await state()).settledSpeech - beforeLate.settledSpeech, { timeout: 20000 }).toBe(2);
  expect((await state()).stage.events).toEqual(completed.stage.events);
  for (const path of ['ch01/index.html', 'lib/engine.js', 'lib/engine.css']) {
    await expect.poll(() => observed.has(path)).toBe(true);
    expect(observed.get(path)).toBe(createHash('sha256').update(await readFile(join(root, path))).digest('hex'));
  }
  const final = await state();
  for (const [key, hits] of Object.entries(final.leak)) expect(hits, key).toBe(0);
  expect(final.counters).toEqual({ sharedRequests: 0, externalRequests: 0 });
  expect(blocked).toBe(0);
});

test('does not publish held synthesis or queued speech after actual offair', async ({ app, screen, browser }) => {
  await browser.route('**/*', async (route) => {
    const url = new URL(route.request.url);
    if (url.hostname !== '127.0.0.1' || ['3080', '3081', '7390', '8757'].includes(url.port)) return route.abort();
    if (url.pathname.startsWith('/api/')) {
      return route.continue({ headers: { ...route.request.headers, 'x-fixture-owner': 'owner-fixture' } });
    }
    return route.continue();
  });
  const state = async () => (await (await fetch(`${app.baseUrl}/__acceptance`)).json()) as Composition;
  const initial = await state();
  await app.open('/');
  await screen.getByRole('button', '设置', { exact: true }).tap();
  await screen.getByLabel('启用新直播会话设置').check();
  await screen.getByLabel('工作目录（可留空：沿用默认工作区）').fill(initial.canonicalPaths.workdir);
  await screen.getByRole('region', '新直播会话').getByRole('button', '添加资料根').tap();
  await screen.getByLabel('资料根 1 路径').fill(initial.canonicalPaths.materials);
  await screen.getByRole('region', '新直播会话').getByRole('button', '保存会话设置').tap();
  await expect(screen.getByText('已保存：将在此后新建的直播会话生效；正在播的会话不变。')).toBeVisible();
  await screen.getByRole('button', '关闭', { exact: true }).tap();
  await expect(browser.frameLocator('iframe[title="实际舞台"]').locator('body')).toBeVisible();
  await fetch(`${app.baseUrl}/__arm-tts`, { method: 'POST' });
  await screen.getByRole('button', '开始本地舞台').tap();
  await expect.poll(async () => (await state()).ttsHeld, { timeout: 20000 }).toBe(true);
  await expect.poll(async () => (await state()).speechAttempts, { timeout: 20000 }).toBe(2);
  await screen.getByRole('button', '下播（先让她道别）').tap();
  const ending = await state();
  expect(ending.onAir).toBe(true);
  expect(ending.ending).toBe(true);
  // Observe the existing 90-second ending fallback; no shorter product deadline is assumed.
  await expect.poll(async () => (await state()).onAir, { timeout: 105000 }).toBe(false);
  const completed = await state();
  await fetch(`${app.baseUrl}/__release-tts`, { method: 'POST' });
  await expect.poll(async () => (await state()).settledSpeech, { timeout: 20000 }).toBe(2);
  const released = await state();
  expect(released.stage.events).toEqual(completed.stage.events);
  expect(released.counters).toEqual({ sharedRequests: 0, externalRequests: 0 });
});

test('drops a held model result after actual offair and starts a new session', async ({ app, screen, browser }) => {
  await browser.route('**/*', async (route) => {
    const url = new URL(route.request.url);
    if (url.hostname !== '127.0.0.1' || ['3080', '3081', '7390', '8757'].includes(url.port)) return route.abort();
    if (url.pathname.startsWith('/api/')) {
      return route.continue({ headers: { ...route.request.headers, 'x-fixture-owner': 'owner-fixture' } });
    }
    return route.continue();
  });
  const state = async () => (await (await fetch(`${app.baseUrl}/__acceptance`)).json()) as Composition;
  const initial = await state();
  await app.open('/');
  await screen.getByRole('button', '设置', { exact: true }).tap();
  await screen.getByLabel('启用新直播会话设置').check();
  await screen.getByLabel('工作目录（可留空：沿用默认工作区）').fill(initial.canonicalPaths.workdir);
  await screen.getByRole('region', '新直播会话').getByRole('button', '添加资料根').tap();
  await screen.getByLabel('资料根 1 路径').fill(initial.canonicalPaths.materials);
  await screen.getByRole('region', '新直播会话').getByRole('button', '保存会话设置').tap();
  await expect(screen.getByText('已保存：将在此后新建的直播会话生效；正在播的会话不变。')).toBeVisible();
  await screen.getByRole('button', '关闭', { exact: true }).tap();
  await expect(browser.frameLocator('iframe[title="实际舞台"]').locator('body')).toBeVisible();
  await fetch(`${app.baseUrl}/__arm-model`, { method: 'POST' });
  await screen.getByRole('button', '开始本地舞台').tap();
  await expect.poll(async () => (await state()).replyHeld, { timeout: 20000 }).toBe(true);
  await screen.getByRole('button', '下播（先让她道别）').tap();
  const ending = await state();
  expect(ending.onAir).toBe(true);
  expect(ending.ending).toBe(true);
  await expect.poll(async () => (await state()).onAir, { timeout: 105000 }).toBe(false);
  const completed = await state();
  await fetch(`${app.baseUrl}/__release-reply`, { method: 'POST' });
  await expect.poll(async () => (await state()).releasedModelResponses).toBe(1);
  await expect.poll(async () => (await state()).observedTurnEnds, { timeout: 20000 }).toBeGreaterThan(completed.observedTurnEnds);
  const released = await state();
  expect(released.stage.events).toEqual(completed.stage.events);
  await screen.getByRole('button', '开始本地舞台').tap();
  await expect.poll(async () => (await state()).nativeCreates.length).toBe(2);
  await expect.poll(async () => (await state()).stage.events.some((event) => event.text === '大家好。'), { timeout: 20000 }).toBe(true);
  expect((await state()).counters).toEqual({ sharedRequests: 0, externalRequests: 0 });
});

test('requires explicit input reconnection and drops a prior course reply', async ({ app, screen, browser }) => {
  await browser.route('**/*', async (route) => {
    const url = new URL(route.request.url);
    if (url.hostname !== '127.0.0.1' || ['3080', '3081', '7390', '8757'].includes(url.port)) return route.abort();
    if (url.pathname.startsWith('/api/')) return route.continue({ headers: { ...route.request.headers, 'x-fixture-owner': 'owner-fixture' } });
    return route.continue();
  });
  const state = async () => (await (await fetch(`${app.baseUrl}/__acceptance`)).json()) as Composition;
  const initial = await state();
  await app.open('/');
  await screen.getByRole('button', '设置', { exact: true }).tap();
  await screen.getByLabel('启用新直播会话设置').check();
  await screen.getByLabel('工作目录（可留空：沿用默认工作区）').fill(initial.canonicalPaths.workdir);
  await screen.getByRole('region', '新直播会话').getByRole('button', '添加资料根').tap();
  await screen.getByLabel('资料根 1 路径').fill(initial.canonicalPaths.materials);
  await screen.getByRole('region', '新直播会话').getByRole('button', '保存会话设置').tap();
  await expect(screen.getByText('已保存：将在此后新建的直播会话生效；正在播的会话不变。')).toBeVisible();
  await screen.getByRole('button', '关闭', { exact: true }).tap();
  await screen.getByRole('button', '连接', { exact: true }).tap();
  await expect.poll(async () => (await state()).hubConnected, { timeout: 20000 }).toBe(true);
  await screen.getByRole('button', '开始本地舞台').tap();
  await expect.poll(async () => (await state()).observedTurnEnds, { timeout: 20000 }).toBeGreaterThan(0);
  await expect.poll(async () => (await state()).brain, { timeout: 20000 }).toBe('listening');
  await screen.getByRole('button', '加载课程').tap();
  await expect.poll(async () => (await state()).course?.playUnknown).toBe(false);
  await screen.getByRole('button', '开始', { exact: true }).tap();
  await expect.poll(async () => (await state()).course?.phase).toBe('playing');
  await screen.getByRole('button', '模拟观众').tap();
  await screen.getByPlaceholder('弹幕内容（醒目留言也用这里的字）').fill('等待断订阅后回答');
  await screen.getByRole('button', '发弹幕').tap();
  await expect.poll(async () => (await state()).replyHeld, { timeout: 20000 }).toBe(true);
  await screen.getByRole('button', '断开订阅').tap();
  await expect.poll(async () => (await state()).hubConnected).toBe(false);
  const disconnected = await state();
  await fetch(`${app.baseUrl}/__release-reply`, { method: 'POST' });
  await expect.poll(async () => (await state()).releasedModelResponses).toBe(1);
  await expect.poll(async () => (await state()).observedTurnEnds, { timeout: 20000 }).toBeGreaterThan(disconnected.observedTurnEnds);
  const released = await state();
  expect(released.stage.events.some((event) => event.text === '迟到测试回答。')).toBe(false);
  expect(released.course).not.toBe(null);
  await screen.getByRole('button', '连接', { exact: true }).tap();
  await expect.poll(async () => (await state()).hubConnected, { timeout: 20000 }).toBe(true);
  const beforeNewInput = await state();
  await screen.getByPlaceholder('弹幕内容（醒目留言也用这里的字）').fill('重新连接后的新问题');
  await screen.getByRole('button', '发弹幕').tap();
  await expect.poll(async () => (await state()).observedTurnEnds, { timeout: 20000 }).toBeGreaterThan(beforeNewInput.observedTurnEnds);
  await expect.poll(async () => (await state()).stage.events.length, { timeout: 20000 }).toBeGreaterThan(beforeNewInput.stage.events.length);
  expect((await state()).stage.events.some((event) => event.text === '迟到测试回答。')).toBe(false);
  expect((await state()).counters).toEqual({ sharedRequests: 0, externalRequests: 0 });
});

test('requires course reload after stage disconnect and drops the old reply', async ({ app, screen, browser }) => {
  await browser.route('**/*', async (route) => {
    const url = new URL(route.request.url);
    if (url.hostname !== '127.0.0.1' || ['3080', '3081', '7390', '8757'].includes(url.port)) return route.abort();
    if (url.pathname.startsWith('/api/')) return route.continue({ headers: { ...route.request.headers, 'x-fixture-owner': 'owner-fixture' } });
    return route.continue();
  });
  const state = async () => (await (await fetch(`${app.baseUrl}/__acceptance`)).json()) as Composition;
  const initial = await state();
  await app.open('/');
  await screen.getByRole('button', '设置', { exact: true }).tap();
  await screen.getByLabel('启用新直播会话设置').check();
  await screen.getByLabel('工作目录（可留空：沿用默认工作区）').fill(initial.canonicalPaths.workdir);
  await screen.getByRole('region', '新直播会话').getByRole('button', '添加资料根').tap();
  await screen.getByLabel('资料根 1 路径').fill(initial.canonicalPaths.materials);
  await screen.getByRole('region', '新直播会话').getByRole('button', '保存会话设置').tap();
  await expect(screen.getByText('已保存：将在此后新建的直播会话生效；正在播的会话不变。')).toBeVisible();
  await screen.getByRole('button', '关闭', { exact: true }).tap();
  await screen.getByRole('button', '开始本地舞台').tap();
  await expect.poll(async () => (await state()).observedTurnEnds, { timeout: 20000 }).toBeGreaterThan(0);
  await expect.poll(async () => (await state()).brain, { timeout: 20000 }).toBe('listening');
  await screen.getByRole('button', '加载课程').tap();
  await expect.poll(async () => (await state()).course?.playUnknown).toBe(false);
  await screen.getByRole('button', '开始', { exact: true }).tap();
  await expect.poll(async () => (await state()).course?.phase).toBe('playing');
  await screen.getByRole('button', '模拟观众').tap();
  await screen.getByPlaceholder('弹幕内容（醒目留言也用这里的字）').fill('等待主人切步后回答');
  await screen.getByRole('button', '发弹幕').tap();
  await expect.poll(async () => (await state()).replyHeld, { timeout: 20000 }).toBe(true);
  await browser.evaluate(() => {
    const frame = document.querySelector('iframe[title="实际舞台"]') as HTMLIFrameElement;
    (window as any).__stageSource = frame.src;
    frame.remove();
    return null;
  });
  await expect.poll(async () => (await state()).course?.playUnknown).toBe(true);
  const disconnected = await state();
  await fetch(`${app.baseUrl}/__release-reply`, { method: 'POST' });
  await expect.poll(async () => (await state()).releasedModelResponses).toBe(1);
  await expect.poll(async () => (await state()).observedTurnEnds, { timeout: 20000 }).toBeGreaterThan(disconnected.observedTurnEnds);
  expect((await state()).stage.events.some((event) => event.text === '迟到测试回答。')).toBe(false);
  await browser.evaluate(() => {
    const frame = document.createElement('iframe');
    frame.title = '实际舞台';
    frame.src = (window as any).__stageSource;
    frame.style.cssText = 'width:100%;height:300px;border:0';
    document.body.prepend(frame);
    return null;
  });
  await expect(browser.frameLocator('iframe[title="实际舞台"]').locator('body')).toBeVisible();
  expect((await state()).course?.playUnknown).toBe(true);
  await screen.getByRole('button', '加载课程').tap();
  await expect.poll(async () => (await state()).course?.playUnknown).toBe(false);
  expect((await state()).stage.events.some((event) => event.text === '迟到测试回答。')).toBe(false);
  expect((await state()).counters).toEqual({ sharedRequests: 0, externalRequests: 0 });
});

test('settles an already played callback after actual offair without new output', async ({ app, screen, browser }) => {
  await browser.addInitScript(() => {
    if (window === window.top) {
      (window as any).__lateAudio = [];
      window.addEventListener('message', (event) => {
        if (event.data?.type === 'feat010-playback') (window as any).__lateAudio.push(event.data.kind);
      });
      return;
    }
    const OriginalAudio = window.Audio;
    let hold = false;
    const pending: Array<() => void> = [];
    window.addEventListener('message', (event) => {
      if (event.data?.type !== 'feat010-playback-control') return;
      hold = event.data.hold === true;
      if (!hold) while (pending.length) pending.shift()?.();
      window.parent.postMessage({ type: 'feat010-playback', kind: hold ? 'holding' : 'released' }, '*');
    });
    const observed = function (src?: string) {
      const player = new OriginalAudio(src);
      let onended: ((event: Event) => unknown) | null = null;
      Object.defineProperty(player, 'onended', { configurable: true, get: () => onended, set: (listener) => { onended = listener; } });
      player.addEventListener('ended', (event) => {
        const deliver = () => onended?.call(player, event);
        if (hold) {
          pending.push(deliver);
          window.parent.postMessage({ type: 'feat010-playback', kind: 'ended-held' }, '*');
        } else deliver();
      });
      return player;
    };
    Object.setPrototypeOf(observed, OriginalAudio);
    window.Audio = observed as unknown as typeof Audio;
  });
  await browser.route('**/*', async (route) => {
    const url = new URL(route.request.url);
    if (url.hostname !== '127.0.0.1' || ['3080', '3081', '7390', '8757'].includes(url.port)) return route.abort();
    if (url.pathname.startsWith('/api/')) return route.continue({ headers: { ...route.request.headers, 'x-fixture-owner': 'owner-fixture' } });
    return route.continue();
  });
  const state = async () => (await (await fetch(`${app.baseUrl}/__acceptance`)).json()) as Composition;
  const initial = await state();
  await app.open('/');
  await screen.getByRole('button', '设置', { exact: true }).tap();
  await screen.getByLabel('启用新直播会话设置').check();
  await screen.getByLabel('工作目录（可留空：沿用默认工作区）').fill(initial.canonicalPaths.workdir);
  await screen.getByRole('region', '新直播会话').getByRole('button', '添加资料根').tap();
  await screen.getByLabel('资料根 1 路径').fill(initial.canonicalPaths.materials);
  await screen.getByRole('region', '新直播会话').getByRole('button', '保存会话设置').tap();
  await expect(screen.getByText('已保存：将在此后新建的直播会话生效；正在播的会话不变。')).toBeVisible();
  await screen.getByRole('button', '关闭', { exact: true }).tap();
  await screen.getByRole('button', '开始本地舞台').tap();
  await expect.poll(async () => (await state()).observedTurnEnds, { timeout: 20000 }).toBeGreaterThan(0);
  await expect.poll(async () => (await state()).brain, { timeout: 20000 }).toBe('listening');
  await screen.getByRole('button', '加载课程').tap();
  await expect.poll(async () => (await state()).course?.playUnknown).toBe(false);
  await screen.getByRole('button', '开始', { exact: true }).tap();
  await expect.poll(async () => (await state()).course?.phase).toBe('playing');
  await browser.evaluate(() => {
    const frame = document.querySelector('iframe[title="实际舞台"]') as HTMLIFrameElement;
    frame.contentWindow?.postMessage({ type: 'feat010-playback-control', hold: true }, '*');
    return null;
  });
  await expect.poll(() => browser.evaluate(() => (window as any).__lateAudio.includes('holding'))).toBe(true);
  await screen.getByRole('button', '模拟观众').tap();
  await screen.getByPlaceholder('弹幕内容（醒目留言也用这里的字）').fill('请解释当前课程');
  await screen.getByRole('button', '发弹幕').tap();
  await expect.poll(() => browser.evaluate(() => (window as any).__lateAudio.includes('ended-held')), { timeout: 20000 }).toBe(true);
  const heldLine = (await state()).stage.events.at(-1);
  expect(heldLine?.hasAudio).toBe(true);
  await screen.getByRole('button', '下播（先让她道别）').tap();
  expect((await state()).ending).toBe(true);
  await expect.poll(async () => (await state()).onAir, { timeout: 105000 }).toBe(false);
  const completed = await state();
  expect(completed.stage.receipts.some((receipt) => receipt.kind === 'said' && receipt.id === heldLine?.id)).toBe(false);
  await browser.evaluate(() => {
    const frame = document.querySelector('iframe[title="实际舞台"]') as HTMLIFrameElement;
    frame.contentWindow?.postMessage({ type: 'feat010-playback-control', hold: false }, '*');
    return null;
  });
  await expect.poll(async () => (await state()).stage.receipts.some((receipt) => receipt.kind === 'said' && receipt.id === heldLine?.id), { timeout: 20000 }).toBe(true);
  const released = await state();
  expect(released.stage.events).toEqual(completed.stage.events);
  expect(released.course).toBe(null);
  expect(released.counters).toEqual({ sharedRequests: 0, externalRequests: 0 });
});

test('composes the original host with a synthetic offline sender', async ({ app, screen, browser }) => {
  let blockedShared = 0;
  let blockedExternal = 0;
  await browser.route('**/*', async (route) => {
    const url = new URL(route.request.url);
    if (['3080', '3081', '7390', '8757'].includes(url.port)) { blockedShared++; return route.abort(); }
    if (url.hostname !== '127.0.0.1') { blockedExternal++; return route.abort(); }
    if (url.pathname.startsWith('/api/')) return route.continue({ headers: { ...route.request.headers, 'x-fixture-owner': 'owner-fixture' } });
    return route.continue();
  });
  const state = async () => (await (await fetch(`${app.baseUrl}/__acceptance`)).json()) as any;
  const action = (name: string) => browser.evaluate(async (actionName) => {
    const response = await fetch('/api/dsh-livestream/public-chat', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: actionName }),
    });
    return response.json();
  }, name);
  const initial = await state();
  await app.open('/');
  const guard = await (await fetch(`${app.baseUrl}/__guard-negative`)).json();
  expect(guard).toEqual({ rejected: 2, shared: 1, external: 1 });
  await browser.evaluate(async () => {
    for (const url of ['http://127.0.0.1:8757/', 'http://192.0.2.1/']) {
      try { await fetch(url); } catch { /* route aborts before either request leaves */ }
    }
    return null;
  });
  expect(blockedShared).toBe(1);
  expect(blockedExternal).toBe(1);
  await browser.evaluate(() => {
    const controller = new AbortController();
    (window as any).__fixtureSse = { controller, text: '', chunks: 0 };
    void fetch('/api/dsh-livestream/events', { signal: controller.signal }).then(async (response) => {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        (window as any).__fixtureSse.text += decoder.decode(value, { stream: true });
        (window as any).__fixtureSse.chunks++;
      }
    }).catch(() => {});
    return null;
  });
  await screen.getByRole('button', '设置', { exact: true }).tap();
  await screen.getByLabel('启用新直播会话设置').check();
  await screen.getByLabel('工作目录（可留空：沿用默认工作区）').fill(initial.canonicalPaths.workdir);
  await screen.getByRole('region', '新直播会话').getByRole('button', '添加资料根').tap();
  await screen.getByLabel('资料根 1 路径').fill(initial.canonicalPaths.materials);
  await screen.getByRole('region', '新直播会话').getByRole('button', '保存会话设置').tap();
  await expect(screen.getByText('已保存：将在此后新建的直播会话生效；正在播的会话不变。')).toBeVisible();
  await screen.getByRole('button', '关闭', { exact: true }).tap();
  await screen.getByRole('button', '连接', { exact: true }).tap();
  await expect.poll(async () => (await state()).hubConnected).toBe(true);
  await screen.getByRole('button', '开始本地舞台').tap();
  await expect.poll(async () => (await state()).observedTurnEnds, { timeout: 20000 }).toBeGreaterThan(0);
  await expect.poll(async () => (await state()).brain, { timeout: 20000 }).toBe('listening');
  await screen.getByRole('button', '加载课程').tap();
  await expect.poll(async () => (await state()).course?.playUnknown).toBe(false);
  await screen.getByRole('button', '开始', { exact: true }).tap();
  await expect.poll(async () => (await state()).course?.phase).toBe('playing');
  const sessionId = (await state()).nativeCreates[0].sessionId;
  const toolSet = await (await fetch(`${app.baseUrl}/__invoke-tool`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, name: 'apply_livestream_course_action', args: { input: { kind: 'question' } } }),
  })).json() as { registeredNames: string[] };
  expect(toolSet.registeredNames).toContain('apply_livestream_course_action');
  expect(toolSet.registeredNames).toContain('send_public_chat_reply');
  const sourceTurn = async () => {
    const before = (await state()).observedTurnEnds;
    const response = await fetch(`${app.baseUrl}/__source-event`, { method: 'POST' });
    const event = await response.json() as { rawId: string; connections: number };
    expect(event.connections).toBe(1);
    await expect.poll(async () => (await state()).observedTurnEnds, { timeout: 30000 }).toBeGreaterThan(before);
    await expect.poll(async () => (await state()).brain, { timeout: 20000 }).toBe('listening');
    await expect.poll(async () => (await state()).course?.phase, { timeout: 20000 }).toBe('playing');
    return event.rawId;
  };
  expect((await action('maintain')).ok).toBe(true);
  expect((await action('authorize')).ok).toBe(false);
  await sourceTurn();
  expect((await state()).publicChat.offlineSender.sends).toHaveLength(0);
  expect((await action('qualify')).ok).toBe(true);
  await sourceTurn();
  expect((await state()).publicChat.offlineSender.sends).toHaveLength(0);
  expect((await action('authorize')).ok).toBe(true);
  const rawId = await sourceTurn();
  await expect.poll(async () => (await state()).publicChat.offlineSender.sends.length, { timeout: 20000 }).toBe(1);
  const sent = (await state()).publicChat.offlineSender.sends[0];
  expect(sent.text).toBe('合成回复');
  expect(sent.sourceKey).toMatch(/^auto:/);
  expect(sent.autoEvent.rawId).toBe(rawId);
  expect(sent.autoEvent.rawType).toBe('WebcastChatMessage');
  expect((await state()).publicChat.offlineSender.proofAccepted).toBe(1);
  expect((await state()).publicChat.offlineSender.proofRejected).toBe(0);
  expect((await action('revoke')).ok).toBe(true);
  await sourceTurn();
  expect((await state()).publicChat.offlineSender.sends).toHaveLength(1);
  await screen.getByRole('button', '断开订阅').tap();
  await expect.poll(async () => (await state()).hubConnected).toBe(false);
  await screen.getByRole('button', '连接', { exact: true }).tap();
  await expect.poll(async () => (await state()).hubConnected).toBe(true);
  await sourceTurn();
  expect((await state()).publicChat.offlineSender.sends).toHaveLength(1);
  await expect.poll(() => browser.evaluate(() => (window as any).__fixtureSse.chunks)).toBeGreaterThan(0);
  const sse = await browser.evaluate(() => { const item = (window as any).__fixtureSse; item.controller.abort(); return item.text; });
  expect(sse).not.toContain('feat010-private-contact-value');
  const final = await state();
  for (const [key, hits] of Object.entries(final.leak)) expect(hits, key).toBe(0);
  expect(final.counters).toEqual({ sharedRequests: 0, externalRequests: 0 });
  expect(blockedShared).toBe(1);
  expect(blockedExternal).toBe(1);
});

test('keeps an unknown synthetic sender result from dispatching again', async ({ app, screen, browser }) => {
  await browser.route('**/*', async (route) => {
    const url = new URL(route.request.url);
    if (url.hostname !== '127.0.0.1' || ['3080', '3081', '7390', '8757'].includes(url.port)) return route.abort();
    if (url.pathname.startsWith('/api/')) return route.continue({ headers: { ...route.request.headers, 'x-fixture-owner': 'owner-fixture' } });
    return route.continue();
  });
  const state = async () => (await (await fetch(`${app.baseUrl}/__acceptance`)).json()) as any;
  const action = (name: string) => browser.evaluate(async (actionName) => {
    const response = await fetch('/api/dsh-livestream/public-chat', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: actionName }),
    });
    return response.json();
  }, name);
  const initial = await state();
  await app.open('/');
  await screen.getByRole('button', '设置', { exact: true }).tap();
  await screen.getByLabel('启用新直播会话设置').check();
  await screen.getByLabel('工作目录（可留空：沿用默认工作区）').fill(initial.canonicalPaths.workdir);
  await screen.getByRole('region', '新直播会话').getByRole('button', '添加资料根').tap();
  await screen.getByLabel('资料根 1 路径').fill(initial.canonicalPaths.materials);
  await screen.getByRole('region', '新直播会话').getByRole('button', '保存会话设置').tap();
  await expect(screen.getByText('已保存：将在此后新建的直播会话生效；正在播的会话不变。')).toBeVisible();
  await screen.getByRole('button', '关闭', { exact: true }).tap();
  await screen.getByRole('button', '连接', { exact: true }).tap();
  await expect.poll(async () => (await state()).hubConnected).toBe(true);
  await screen.getByRole('button', '开始本地舞台').tap();
  await expect.poll(async () => (await state()).brain, { timeout: 20000 }).toBe('listening');
  const sourceTurn = async () => {
    const before = (await state()).observedTurnEnds;
    const response = await fetch(`${app.baseUrl}/__source-event`, { method: 'POST' });
    const event = await response.json() as { rawId: string; connections: number };
    expect(event.connections).toBe(1);
    await expect.poll(async () => (await state()).observedTurnEnds, { timeout: 30000 }).toBeGreaterThan(before);
    await expect.poll(async () => (await state()).brain, { timeout: 20000 }).toBe('listening');
    return event.rawId;
  };
  expect((await action('maintain')).ok).toBe(true);
  expect((await action('authorize')).ok).toBe(false);
  await sourceTurn();
  expect((await state()).publicChat.offlineSender.sends).toHaveLength(0);
  expect((await action('qualify')).ok).toBe(true);
  await sourceTurn();
  expect((await state()).publicChat.offlineSender.sends).toHaveLength(0);
  expect((await action('authorize')).ok).toBe(true);
  await fetch(`${app.baseUrl}/__unknown-next`, { method: 'POST' });
  const rawId = await sourceTurn();
  await expect.poll(async () => (await state()).publicChat.offlineSender.sends.length, { timeout: 20000 }).toBe(1);
  await expect.poll(async () => (await state()).publicChat.view.publicChat.hold).toBe(true);
  const unknown = await state();
  expect(unknown.publicChat.offlineSender.sends[0].autoEvent.rawId).toBe(rawId);
  expect(unknown.publicChat.view.publicChat.messages.some((entry: any) => entry.state === 'unknown')).toBe(true);
  await sourceTurn();
  expect((await state()).publicChat.offlineSender.sends).toHaveLength(1);
  expect((await state()).counters).toEqual({ sharedRequests: 0, externalRequests: 0 });
});

test('rejects a synthetic sender event without matching raw proof', async ({ app, screen, browser }) => {
  await browser.route('**/*', async (route) => {
    const url = new URL(route.request.url);
    if (url.hostname !== '127.0.0.1' || ['3080', '3081', '7390', '8757'].includes(url.port)) return route.abort();
    if (url.pathname.startsWith('/api/')) return route.continue({ headers: { ...route.request.headers, 'x-fixture-owner': 'owner-fixture' } });
    return route.continue();
  });
  const state = async () => (await (await fetch(`${app.baseUrl}/__acceptance`)).json()) as any;
  const action = (name: string) => browser.evaluate(async (actionName) => {
    const response = await fetch('/api/dsh-livestream/public-chat', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: actionName }),
    });
    return response.json();
  }, name);
  const initial = await state();
  await app.open('/');
  await screen.getByRole('button', '设置', { exact: true }).tap();
  await screen.getByLabel('启用新直播会话设置').check();
  await screen.getByLabel('工作目录（可留空：沿用默认工作区）').fill(initial.canonicalPaths.workdir);
  await screen.getByRole('region', '新直播会话').getByRole('button', '添加资料根').tap();
  await screen.getByLabel('资料根 1 路径').fill(initial.canonicalPaths.materials);
  await screen.getByRole('region', '新直播会话').getByRole('button', '保存会话设置').tap();
  await expect(screen.getByText('已保存：将在此后新建的直播会话生效；正在播的会话不变。')).toBeVisible();
  await screen.getByRole('button', '关闭', { exact: true }).tap();
  await screen.getByRole('button', '连接', { exact: true }).tap();
  await expect.poll(async () => (await state()).hubConnected).toBe(true);
  await screen.getByRole('button', '开始本地舞台').tap();
  await expect.poll(async () => (await state()).brain, { timeout: 20000 }).toBe('listening');
  const sourceTurn = async (withoutRaw = false) => {
    const before = (await state()).observedTurnEnds;
    const response = await fetch(`${app.baseUrl}/__source-event${withoutRaw ? '?withoutRaw=1' : ''}`, { method: 'POST' });
    const event = await response.json() as { rawId: string; connections: number };
    expect(event.connections).toBe(1);
    await expect.poll(async () => (await state()).observedTurnEnds, { timeout: 30000 }).toBeGreaterThan(before);
    await expect.poll(async () => (await state()).brain, { timeout: 20000 }).toBe('listening');
    return event.rawId;
  };
  expect((await action('maintain')).ok).toBe(true);
  expect((await action('authorize')).ok).toBe(false);
  await sourceTurn();
  expect((await state()).publicChat.offlineSender.sends).toHaveLength(0);
  expect((await action('qualify')).ok).toBe(true);
  await sourceTurn();
  expect((await state()).publicChat.offlineSender.sends).toHaveLength(0);
  expect((await action('authorize')).ok).toBe(true);
  const rawId = await sourceTurn(true);
  await expect.poll(async () => (await state()).publicChat.offlineSender.sends.length, { timeout: 20000 }).toBe(1);
  await expect.poll(async () => (await state()).publicChat.view.publicChat.hold).toBe(true);
  const unknown = await state();
  expect(unknown.publicChat.offlineSender.sends[0].autoEvent.rawId).toBe(rawId);
  expect(unknown.publicChat.offlineSender.proofAccepted).toBe(0);
  expect(unknown.publicChat.offlineSender.proofRejected).toBe(1);
  expect(unknown.publicChat.view.publicChat.messages.some((entry: any) => entry.state === 'unknown')).toBe(true);
  await sourceTurn();
  expect((await state()).publicChat.offlineSender.sends).toHaveLength(1);
  expect((await state()).counters).toEqual({ sharedRequests: 0, externalRequests: 0 });
});


test('does not restore synthetic sender authorization after input reconnect', async ({ app, screen, browser }) => {
  await browser.route('**/*', async (route) => {
    const url = new URL(route.request.url);
    if (url.hostname !== '127.0.0.1' || ['3080', '3081', '7390', '8757'].includes(url.port)) return route.abort();
    if (url.pathname.startsWith('/api/')) return route.continue({ headers: { ...route.request.headers, 'x-fixture-owner': 'owner-fixture' } });
    return route.continue();
  });
  const state = async () => (await (await fetch(`${app.baseUrl}/__acceptance`)).json()) as any;
  const action = (name: string) => browser.evaluate(async (actionName) => {
    const response = await fetch('/api/dsh-livestream/public-chat', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: actionName }),
    });
    return response.json();
  }, name);
  const initial = await state();
  await app.open('/');
  await screen.getByRole('button', '设置', { exact: true }).tap();
  await screen.getByLabel('启用新直播会话设置').check();
  await screen.getByLabel('工作目录（可留空：沿用默认工作区）').fill(initial.canonicalPaths.workdir);
  await screen.getByRole('region', '新直播会话').getByRole('button', '添加资料根').tap();
  await screen.getByLabel('资料根 1 路径').fill(initial.canonicalPaths.materials);
  await screen.getByRole('region', '新直播会话').getByRole('button', '保存会话设置').tap();
  await expect(screen.getByText('已保存：将在此后新建的直播会话生效；正在播的会话不变。')).toBeVisible();
  await screen.getByRole('button', '关闭', { exact: true }).tap();
  await screen.getByRole('button', '连接', { exact: true }).tap();
  await expect.poll(async () => (await state()).hubConnected).toBe(true);
  await screen.getByRole('button', '开始本地舞台').tap();
  await expect.poll(async () => (await state()).brain, { timeout: 20000 }).toBe('listening');
  const sourceTurn = async () => {
    const before = (await state()).observedTurnEnds;
    const response = await fetch(`${app.baseUrl}/__source-event`, { method: 'POST' });
    const event = await response.json() as { rawId: string; connections: number };
    expect(event.connections).toBe(1);
    await expect.poll(async () => (await state()).observedTurnEnds, { timeout: 30000 }).toBeGreaterThan(before);
    await expect.poll(async () => (await state()).brain, { timeout: 20000 }).toBe('listening');
    return event.rawId;
  };
  expect((await action('maintain')).ok).toBe(true);
  expect((await action('authorize')).ok).toBe(false);
  await sourceTurn();
  expect((await state()).publicChat.offlineSender.sends).toHaveLength(0);
  expect((await action('qualify')).ok).toBe(true);
  await sourceTurn();
  expect((await state()).publicChat.offlineSender.sends).toHaveLength(0);
  expect((await action('authorize')).ok).toBe(true);
  await screen.getByRole('button', '断开订阅').tap();
  await expect.poll(async () => (await state()).hubConnected).toBe(false);
  await screen.getByRole('button', '连接', { exact: true }).tap();
  await expect.poll(async () => (await state()).hubConnected).toBe(true);
  await sourceTurn();
  const afterReconnect = await state();
  expect(afterReconnect.publicChat.offlineSender.sends).toHaveLength(0);
  expect(afterReconnect.publicChat.view.publicChat.grant).toBe(null);
  expect((await state()).counters).toEqual({ sharedRequests: 0, externalRequests: 0 });
});


test('does not reuse a held sender turn after actual end and a new session', async ({ app, screen, browser }) => {
  await browser.route('**/*', async (route) => {
    const url = new URL(route.request.url);
    if (url.hostname !== '127.0.0.1' || ['3080', '3081', '7390', '8757'].includes(url.port)) return route.abort();
    if (url.pathname.startsWith('/api/')) return route.continue({ headers: { ...route.request.headers, 'x-fixture-owner': 'owner-fixture' } });
    return route.continue();
  });
  const state = async () => (await (await fetch(`${app.baseUrl}/__acceptance`)).json()) as any;
  const action = (name: string) => browser.evaluate(async (actionName) => {
    const response = await fetch('/api/dsh-livestream/public-chat', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: actionName }),
    });
    return response.json();
  }, name);
  const initial = await state();
  await app.open('/');
  await screen.getByRole('button', '设置', { exact: true }).tap();
  await screen.getByLabel('启用新直播会话设置').check();
  await screen.getByLabel('工作目录（可留空：沿用默认工作区）').fill(initial.canonicalPaths.workdir);
  await screen.getByRole('region', '新直播会话').getByRole('button', '添加资料根').tap();
  await screen.getByLabel('资料根 1 路径').fill(initial.canonicalPaths.materials);
  await screen.getByRole('region', '新直播会话').getByRole('button', '保存会话设置').tap();
  await expect(screen.getByText('已保存：将在此后新建的直播会话生效；正在播的会话不变。')).toBeVisible();
  await screen.getByRole('button', '关闭', { exact: true }).tap();
  await screen.getByRole('button', '连接', { exact: true }).tap();
  await expect.poll(async () => (await state()).hubConnected).toBe(true);
  await screen.getByRole('button', '开始本地舞台').tap();
  await expect.poll(async () => (await state()).brain, { timeout: 20000 }).toBe('listening');
  const sourceTurn = async () => {
    const before = (await state()).observedTurnEnds;
    const response = await fetch(`${app.baseUrl}/__source-event`, { method: 'POST' });
    const event = await response.json() as { rawId: string; connections: number };
    expect(event.connections).toBe(1);
    await expect.poll(async () => (await state()).observedTurnEnds, { timeout: 30000 }).toBeGreaterThan(before);
    await expect.poll(async () => (await state()).brain, { timeout: 20000 }).toBe('listening');
    return event.rawId;
  };
  expect((await action('maintain')).ok).toBe(true);
  expect((await action('authorize')).ok).toBe(false);
  await sourceTurn();
  expect((await state()).publicChat.offlineSender.sends).toHaveLength(0);
  expect((await action('qualify')).ok).toBe(true);
  await sourceTurn();
  expect((await state()).publicChat.offlineSender.sends).toHaveLength(0);
  expect((await action('authorize')).ok).toBe(true);
  await fetch(`${app.baseUrl}/__arm-model`, { method: 'POST' });
  await fetch(`${app.baseUrl}/__source-event`, { method: 'POST' });
  await expect.poll(async () => (await state()).replyHeld, { timeout: 20000 }).toBe(true);
  await screen.getByRole('button', '下播（先让她道别）').tap();
  const ending = await state();
  expect(ending.onAir).toBe(true);
  expect(ending.ending).toBe(true);
  await expect.poll(async () => (await state()).onAir, { timeout: 105000 }).toBe(false);
  const completed = await state();
  await fetch(`${app.baseUrl}/__release-reply`, { method: 'POST' });
  await expect.poll(async () => (await state()).releasedModelResponses, { timeout: 20000 }).toBeGreaterThan(completed.releasedModelResponses);
  const released = await state();
  expect(released.publicChat.offlineSender.sends).toHaveLength(0);
  expect(released.stage.events).toEqual(completed.stage.events);
  await screen.getByRole('button', '开始本地舞台').tap();
  await expect.poll(async () => (await state()).nativeCreates.length, { timeout: 20000 }).toBe(2);
  await expect.poll(async () => (await state()).brain, { timeout: 20000 }).toBe('listening');
  await sourceTurn();
  const afterNewSession = await state();
  expect(afterNewSession.publicChat.offlineSender.sends).toHaveLength(0);
  expect(afterNewSession.publicChat.view.publicChat.grant).toBe(null);
  expect((await state()).counters).toEqual({ sharedRequests: 0, externalRequests: 0 });
});



test('loads the unmodified standard artifacts in one SDK host', async ({ app, screen, browser }) => {
  await browser.addInitScript(() => {
    if (window === window.top) {
      (window as any).__artifactAudio = [];
      window.addEventListener('message', (event) => {
        if (event.data?.type === 'artifact-audio-observation') (window as any).__artifactAudio.push(event.data);
      });
      return;
    }
    const preview = new URL(location.href).searchParams.get('preview') === '1';
    const OriginalSource = window.EventSource;
    class ObservedSource extends OriginalSource {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        this.addEventListener('message', (message) => {
          try {
            const event = JSON.parse(message.data);
            if (event.type === 'say') window.parent.postMessage({ type: 'artifact-audio-observation',
              kind: 'say', preview, id: event.id, hasAudio: !!event.audio }, '*');
          } catch { /* Ignore non-JSON stream frames. */ }
        });
      }
    }
    window.EventSource = ObservedSource;
    const OriginalAudio = window.Audio;
    const observed = function (src?: string) {
      const player = new OriginalAudio(src);
      window.parent.postMessage({ type: 'artifact-audio-observation', kind: 'created', preview, hasAudio: !!src }, '*');
      for (const kind of ['playing', 'ended', 'error']) {
        player.addEventListener(kind, () => window.parent.postMessage({ type: 'artifact-audio-observation', kind, preview }, '*'));
      }
      return player;
    };
    Object.setPrototypeOf(observed, OriginalAudio);
    window.Audio = observed as unknown as typeof Audio;
  });
  const standard = process.env.DSH_ACCEPTANCE_STANDARD_PACKAGE;
  if (!standard) throw new Error('standard artifact package required');
  const observed = new Map<string, string>();
  let blocked = 0;
  await browser.route('**/*', async (route) => {
    const url = new URL(route.request.url);
    if (url.hostname !== '127.0.0.1' || ['3080', '3081', '7390', '8757'].includes(url.port)) { blocked++; return route.abort(); }
    if (url.pathname.startsWith('/api/')) {
      const auth = url.searchParams.get('fixture-auth');
      const headers = { ...route.request.headers };
      if (auth === 'guest') headers['x-fixture-guest'] = 'guest-fixture';
      else if (auth !== 'anonymous') headers['x-fixture-owner'] = 'owner-fixture';
      return route.continue({ headers });
    }
    if (url.pathname === '/standard-client.js' || url.pathname === '/stage.js') {
      const response = await route.fetch();
      const bytes = await response.body();
      observed.set(url.pathname, createHash('sha256').update(bytes).digest('hex'));
      return route.fulfill({ status: response.status, headers: { ...response.headers }, body: bytes });
    }
    return route.continue();
  });
  const artifact = async () => (await (await fetch(`${app.baseUrl}/__artifact`)).json()) as any;
  const initial = await artifact();
  await app.open('/');
  expect(await browser.evaluate(() => (window as any).__standardClientLoaded)).toBe(true);
  const admission = await browser.evaluate(async () => {
    const read = (suffix: string) => fetch(`/api/dsh-livestream/state${suffix}`).then((response) => response.status);
    return { owner: await read(''), guest: await read('?fixture-auth=guest'), anonymous: await read('?fixture-auth=anonymous') };
  });
  expect(admission).toEqual({ owner: 200, guest: 401, anonymous: 401 });
  expect(initial.guestPrincipalKind).toBe('guest');
  expect(initial.guestRouteStatus).toBe(403);
  const registration = await browser.evaluate(async () => {
    const response = await fetch('/api/dsh-livestream/registration/settings', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'workspace', profile: 'selected', appId: 'app1', userOpenId: 'user1',
        artifactDirectory: '/synthetic/not-loaded', baseId: 'base1', tableId: 'table1', recordId: 'feat010-artifact-private-value',
        mappingId: 'map', mappingRevision: 1, displayNameField: 'f1', contactField: 'f2', interestField: 'f4', photoField: 'f3',
        revisionField: 'rev', consentField: null, sourceField: null, collectedAtField: null }) });
    return { status: response.status, body: await response.json() };
  });
  expect(registration.status).toBe(200);
  expect(registration.body.ok).toBe(true);
  const afterRegistrationSave = await artifact();
  expect(afterRegistrationSave.nativeAttempts).toBe(0);
  expect(afterRegistrationSave.modelCalls).toBe(0);
  expect(afterRegistrationSave.registrationSaveEffects).toEqual([{ native: 0, model: 0, bridge: 0, tts: 0 }]);
  const publicChat = await browser.evaluate(async () => (await fetch('/api/dsh-livestream/public-chat')).json());
  expect(publicChat.publicChat.available).toBe(false);
  const maintain = await browser.evaluate(async () => (await fetch('/api/dsh-livestream/public-chat', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'maintain' }),
  })).json());
  expect(maintain.ok).toBe(false);
  await browser.evaluate(() => {
    const controller = new AbortController();
    (window as any).__fixtureSse = { controller, text: '', chunks: 0 };
    void fetch('/api/dsh-livestream/events', { signal: controller.signal }).then(async (response) => {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        (window as any).__fixtureSse.text += decoder.decode(value, { stream: true });
        (window as any).__fixtureSse.chunks++;
      }
    }).catch(() => {});
    return null;
  });
  await screen.getByRole('button', '设置', { exact: true }).tap();
  await screen.getByLabel('启用新直播会话设置').check();
  await screen.getByLabel('工作目录（可留空：沿用默认工作区）').fill(initial.canonicalPaths.workdir);
  await screen.getByRole('region', '新直播会话').getByRole('button', '添加资料根').tap();
  await screen.getByLabel('资料根 1 路径').fill(initial.canonicalPaths.materials);
  await screen.getByRole('region', '新直播会话').getByRole('button', '保存会话设置').tap();
  await expect(screen.getByText('已保存：将在此后新建的直播会话生效；正在播的会话不变。')).toBeVisible();
  await screen.getByRole('button', '关闭', { exact: true }).tap();
  await screen.getByRole('button', '连接', { exact: true }).tap();
  await expect.poll(async () => browser.evaluate(async () => (await (await fetch('/api/dsh-livestream/state')).json()).show?.live?.state), { timeout: 20000 }).toBe('connected');
  const stage = browser.frameLocator('iframe[title="实际舞台"]');
  await expect(stage.locator('body')).toBeVisible();
  const preview = browser.frameLocator('iframe[title="舞台预览"]');
  await expect(preview.locator('body')).toBeVisible();
  const advertised = await browser.evaluate(async () => (await (await fetch('/api/dsh-livestream/state')).json()).stageUrl);
  expect(Number(new URL(advertised).port)).toBe(initial.stagePort);
  expect(Number(new URL(advertised).port)).toBeGreaterThan(0);
  await screen.getByRole('button', '开始本地舞台').tap();
  await expect.poll(async () => (await artifact()).creates.length, { timeout: 20000 }).toBe(1);
  await expect.poll(async () => (await artifact()).modelCalls, { timeout: 20000 }).toBeGreaterThan(0);
  await expect.poll(async () => (await artifact()).syntheticTtsCalls, { timeout: 20000 }).toBeGreaterThan(0);
  await expect.poll(() => browser.evaluate(() => (window as any).__artifactAudio.some((event: any) => event.preview && event.kind === 'say' && event.hasAudio)), { timeout: 20000 }).toBe(true);
  await expect.poll(() => browser.evaluate(() => (window as any).__artifactAudio.some((event: any) => !event.preview && event.kind === 'ended')), { timeout: 20000 }).toBe(true);
  const audioEvents = await browser.evaluate(() => (window as any).__artifactAudio as Array<{ preview: boolean; kind: string; id?: string; hasAudio?: boolean }>);
  const previewSay = audioEvents.find((event) => event.preview && event.kind === 'say' && event.hasAudio);
  expect(audioEvents.some((event) => !event.preview && event.kind === 'say' && event.id === previewSay?.id && event.hasAudio)).toBe(true);
  expect(audioEvents.some((event) => event.preview && event.kind === 'created' && event.hasAudio)).toBe(false);
  expect((await artifact()).creates[0].cwd).toBe(initial.canonicalPaths.workdir);
  await expect.poll(async () => browser.evaluate(async () => (await (await fetch('/api/dsh-livestream/state')).json()).show?.brain), { timeout: 20000 }).toBe('listening');
  const liveMaintain = await browser.evaluate(async () => (await fetch('/api/dsh-livestream/public-chat', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'maintain' }),
  })).json());
  expect(liveMaintain).toEqual({ ok: false, reason: 'deployment-unavailable' });
  await screen.getByRole('button', '加载课程').tap();
  await expect(stage.frameLocator('iframe[title="课程画面"]').frameLocator('iframe[title="课件"]').getByText('artifact course')).toBeVisible();
  await screen.getByRole('button', '开始', { exact: true }).tap();
  await expect.poll(async () => browser.evaluate(async () => (await (await fetch('/api/dsh-livestream/state')).json()).course?.phase)).toBe('playing');
  await expect.poll(() => browser.evaluate(() => (window as any).__fixtureSse.chunks)).toBeGreaterThan(0);
  const sse = await browser.evaluate(() => { const item = (window as any).__fixtureSse; item.controller.abort(); return item.text; });
  expect(sse).not.toContain('feat010-artifact-private-value');
  const publicState = await browser.evaluate(async () => (await fetch('/api/dsh-livestream/state')).text());
  expect(publicState).not.toContain('feat010-artifact-private-value');
  expect(observed.get('/standard-client.js')).toBe(createHash('sha256').update(await readFile(join(standard, 'lib/client.js'))).digest('hex'));
  expect(observed.get('/stage.js')).toBe(createHash('sha256').update(await readFile(join(standard, 'lib/stage.js'))).digest('hex'));
  const final = await artifact();
  expect(final.nativeAttempts).toBe(0);
  expect(final.modelPrivateHits).toBe(0);
  expect(final.agentPrivateHits).toBe(0);
  expect(final.ttsPrivateHits).toBe(0);
  expect(final.syntheticAudioProcesses).toBeGreaterThan(0);
  expect(final.counters).toEqual({ sharedRequests: 0, externalRequests: 0 });
  expect(blocked).toBe(0);
  await app.screenshot('standard-artifact-course');
});

test('waits for all course reply segments and rejects error and unknown recovery', async ({ app, screen, browser }) => {
  await browser.addInitScript(() => {
    if (window === window.top) {
      (window as any).__courseAudio = [];
      window.addEventListener('message', (event) => {
        if (event.data?.type === 'feat010-course-audio') (window as any).__courseAudio.push(event.data.kind);
      });
      return;
    }
    if (new URL(location.href).searchParams.has('preview')) return;
    const OriginalAudio = window.Audio;
    let holding = false;
    let errorNext = false;
    const pending: Array<() => void> = [];
    window.addEventListener('message', (event) => {
      if (event.data?.type !== 'feat010-course-control') return;
      if (event.data.action === 'hold') holding = true;
      if (event.data.action === 'error-next') errorNext = true;
      if (event.data.action === 'release-one') pending.shift()?.();
      if (event.data.action === 'release-all') { holding = false; while (pending.length) pending.shift()?.(); }
      window.parent.postMessage({ type: 'feat010-course-audio', kind: `control-${event.data.action}` }, '*');
    });
    const observed = function (src?: string) {
      const player = new OriginalAudio(src);
      let onended: ((event: Event) => unknown) | null = null;
      Object.defineProperty(player, 'onended', { configurable: true, get: () => onended, set: (listener) => { onended = listener; } });
      player.addEventListener('ended', (event) => {
        const deliver = () => onended?.call(player, event);
        if (holding) { pending.push(deliver); window.parent.postMessage({ type: 'feat010-course-audio', kind: 'held' }, '*'); }
        else deliver();
      });
      if (src && errorNext) {
        errorNext = false;
        player.play = () => Promise.reject(new DOMException('fixture audio error', 'NotSupportedError'));
      }
      return player;
    };
    Object.setPrototypeOf(observed, OriginalAudio);
    window.Audio = observed as unknown as typeof Audio;
  });
  await browser.route('**/*', async (route) => {
    const url = new URL(route.request.url);
    if (url.hostname !== '127.0.0.1' || ['3080', '3081', '7390', '8757'].includes(url.port)) return route.abort();
    if (url.pathname.startsWith('/api/')) return route.continue({ headers: { ...route.request.headers, 'x-fixture-owner': 'owner-fixture' } });
    return route.continue();
  });
  const state = async () => (await (await fetch(`${app.baseUrl}/__acceptance`)).json()) as any;
  const control = async (action: string) => {
    await browser.evaluate((name) => {
      const frame = document.querySelector('iframe[title="实际舞台"]') as HTMLIFrameElement;
      frame.contentWindow?.postMessage({ type: 'feat010-course-control', action: name }, '*');
      return null;
    }, action);
    await expect.poll(() => browser.evaluate((name) => (window as any).__courseAudio.includes(`control-${name}`), action)).toBe(true);
  };
  const send = async (text: string) => {
    await screen.getByPlaceholder('弹幕内容（醒目留言也用这里的字）').fill(text);
    await screen.getByRole('button', '发弹幕').tap();
  };
  const initial = await state();
  await app.open('/');
  await screen.getByRole('button', '设置', { exact: true }).tap();
  await screen.getByLabel('启用新直播会话设置').check();
  await screen.getByLabel('工作目录（可留空：沿用默认工作区）').fill(initial.canonicalPaths.workdir);
  await screen.getByRole('region', '新直播会话').getByRole('button', '添加资料根').tap();
  await screen.getByLabel('资料根 1 路径').fill(initial.canonicalPaths.materials);
  await screen.getByRole('region', '新直播会话').getByRole('button', '保存会话设置').tap();
  await expect(screen.getByText('已保存：将在此后新建的直播会话生效；正在播的会话不变。')).toBeVisible();
  await screen.getByRole('button', '关闭', { exact: true }).tap();
  await screen.getByRole('button', '开始本地舞台').tap();
  await expect.poll(async () => (await state()).observedTurnEnds, { timeout: 20000 }).toBeGreaterThan(0);
  await expect.poll(async () => (await state()).brain, { timeout: 20000 }).toBe('listening');
  await screen.getByRole('button', '加载课程').tap();
  await expect.poll(async () => (await state()).course?.playUnknown).toBe(false);
  await screen.getByRole('button', '开始', { exact: true }).tap();
  await expect.poll(async () => (await state()).course?.phase).toBe('playing');
  await screen.getByRole('button', '模拟观众').tap();
  await control('hold');
  await fetch(`${app.baseUrl}/__arm-multisegment`, { method: 'POST' });
  const before = (await state()).stage.events.length;
  await send('请回答两个语音段');
  await expect.poll(() => browser.evaluate(() => (window as any).__courseAudio.filter((kind: string) => kind === 'held').length), { timeout: 20000 }).toBe(1);
  expect((await state()).course.phase).toBe('paused');
  await control('release-one');
  await expect.poll(() => browser.evaluate(() => (window as any).__courseAudio.filter((kind: string) => kind === 'held').length), { timeout: 20000 }).toBe(2);
  const middle = await state();
  const segments = middle.stage.events.slice(before).filter((event: any) => event.hasAudio);
  expect(segments.length).toBe(2);
  expect(middle.stage.audioResults.some((entry: any) => entry.id === segments[0].id && entry.result === 'ended')).toBe(true);
  expect(middle.stage.audioResults.some((entry: any) => entry.id === segments[1].id)).toBe(false);
  expect(middle.course.phase).toBe('paused');
  await control('release-all');
  await expect.poll(async () => (await state()).stage.audioResults.some((entry: any) => entry.id === segments[1].id && entry.result === 'ended')).toBe(true);
  await expect.poll(async () => (await state()).course.phase).toBe('playing');

  await control('error-next');
  const beforeError = (await state()).stage.events.length;
  await send('请产生受控音频错误');
  await expect.poll(async () => (await state()).stage.events.length, { timeout: 20000 }).toBeGreaterThan(beforeError);
  const errorId = (await state()).stage.events.at(-1).id;
  await expect.poll(async () => (await state()).stage.audioResults.some((entry: any) => entry.id === errorId && entry.result === 'error'), { timeout: 20000 }).toBe(true);
  await expect.poll(async () => (await state()).brain, { timeout: 20000 }).toBe('listening');
  expect((await state()).course.phase).toBe('paused');

  await screen.getByRole('button', '继续', { exact: true }).tap();
  await expect.poll(async () => (await state()).course.phase).toBe('playing');
  await control('hold');
  const beforeUnknown = (await state()).stage.events.length;
  await send('请产生受控舞台未知结果');
  await expect.poll(async () => (await state()).stage.events.length, { timeout: 20000 }).toBeGreaterThan(beforeUnknown);
  const unknownId = (await state()).stage.events.at(-1).id;
  await expect.poll(() => browser.evaluate(() => (window as any).__courseAudio.filter((kind: string) => kind === 'held').length), { timeout: 20000 }).toBe(3);
  const priorEpoch = (await state()).course.courseEpoch;
  await browser.evaluate(() => {
    const frame = document.querySelector('iframe[title="实际舞台"]') as HTMLIFrameElement;
    const extra = document.createElement('iframe');
    extra.title = '第二个舞台测试观察者';
    extra.src = frame.src;
    document.body.append(extra);
    return null;
  });
  await expect.poll(async () => (await state()).stage.audioResults.some((entry: any) => entry.id === unknownId && entry.result === 'unknown')).toBe(true);
  await browser.evaluate(() => { document.querySelector('iframe[title="第二个舞台测试观察者"]')?.remove(); return null; });
  expect((await state()).course.phase).toBe('paused');
  await screen.getByRole('button', '加载课程').tap();
  await expect.poll(async () => (await state()).course?.courseEpoch).not.toBe(priorEpoch);
  await expect.poll(async () => (await state()).course?.playUnknown).toBe(false);
  await control('release-all');
  await expect.poll(async () => (await state()).brain, { timeout: 20000 }).toBe('listening');
  expect((await state()).course.phase).toBe('paused');

  await screen.getByRole('button', '开始', { exact: true }).tap();
  await expect.poll(async () => (await state()).course.phase).toBe('playing');
  await control('hold');
  await send('结束课程前的迟到播放回执');
  await expect.poll(() => browser.evaluate(() => (window as any).__courseAudio.filter((kind: string) => kind === 'held').length), { timeout: 20000 }).toBe(4);
  await screen.getByRole('button', '结束课程').tap();
  await expect.poll(async () => (await state()).course).toBe(null);
  await control('release-all');
  await expect.poll(async () => (await state()).brain, { timeout: 20000 }).toBe('listening');
  expect((await state()).course).toBe(null);
  expect((await state()).counters).toEqual({ sharedRequests: 0, externalRequests: 0 });
});

for (const disconnection of ['input', 'stage'] as const) {
  for (const phase of ['synthesis-and-queue', 'playing-and-queue'] as const) {
    test(`drops late ${phase} after ${disconnection} disconnection`, async ({ app, screen, browser }) => {
      await browser.addInitScript(() => {
        if (window === window.top) {
          (window as any).__latePhase = [];
          window.addEventListener('message', (event) => {
            if (event.data?.type === 'feat010-late-phase') (window as any).__latePhase.push(event.data.kind);
          });
          return;
        }
        if (new URL(location.href).searchParams.has('preview')) return;
        const OriginalAudio = window.Audio;
        let holding = false;
        const pending: Array<() => void> = [];
        window.addEventListener('message', (event) => {
          if (event.data?.type !== 'feat010-late-control') return;
          holding = event.data.hold === true;
          if (!holding) while (pending.length) pending.shift()?.();
          window.parent.postMessage({ type: 'feat010-late-phase', kind: holding ? 'holding' : 'released' }, '*');
        });
        const observed = function (src?: string) {
          const player = new OriginalAudio(src);
          let onended: ((event: Event) => unknown) | null = null;
          Object.defineProperty(player, 'onended', { configurable: true, get: () => onended, set: (listener) => { onended = listener; } });
          player.addEventListener('playing', () => window.parent.postMessage({ type: 'feat010-late-phase', kind: 'playing' }, '*'));
          player.addEventListener('ended', (event) => {
            const deliver = () => onended?.call(player, event);
            if (holding) { pending.push(deliver); window.parent.postMessage({ type: 'feat010-late-phase', kind: 'held' }, '*'); }
            else deliver();
          });
          return player;
        };
        Object.setPrototypeOf(observed, OriginalAudio);
        window.Audio = observed as unknown as typeof Audio;
      });
      await browser.route('**/*', async (route) => {
        const url = new URL(route.request.url);
        if (url.hostname !== '127.0.0.1' || ['3080', '3081', '7390', '8757'].includes(url.port)) return route.abort();
        if (url.pathname.startsWith('/api/')) return route.continue({ headers: { ...route.request.headers, 'x-fixture-owner': 'owner-fixture' } });
        return route.continue();
      });
      const state = async () => (await (await fetch(`${app.baseUrl}/__acceptance`)).json()) as any;
      const initial = await state();
      await app.open('/');
      await screen.getByRole('button', '设置', { exact: true }).tap();
      await screen.getByLabel('启用新直播会话设置').check();
      await screen.getByLabel('工作目录（可留空：沿用默认工作区）').fill(initial.canonicalPaths.workdir);
      await screen.getByRole('region', '新直播会话').getByRole('button', '添加资料根').tap();
      await screen.getByLabel('资料根 1 路径').fill(initial.canonicalPaths.materials);
      await screen.getByRole('region', '新直播会话').getByRole('button', '保存会话设置').tap();
      await expect(screen.getByText('已保存：将在此后新建的直播会话生效；正在播的会话不变。')).toBeVisible();
      await screen.getByRole('button', '关闭', { exact: true }).tap();
      await screen.getByRole('button', '连接', { exact: true }).tap();
      await expect.poll(async () => (await state()).hubConnected).toBe(true);
      await screen.getByRole('button', '开始本地舞台').tap();
      await expect.poll(async () => (await state()).observedTurnEnds, { timeout: 20000 }).toBeGreaterThan(0);
      await expect.poll(async () => (await state()).brain, { timeout: 20000 }).toBe('listening');
      await screen.getByRole('button', '加载课程').tap();
      await expect.poll(async () => (await state()).course?.playUnknown).toBe(false);
      await screen.getByRole('button', '开始', { exact: true }).tap();
      await expect.poll(async () => (await state()).course?.phase).toBe('playing');
      await screen.getByRole('button', '模拟观众').tap();
      const before = await state();
      if (phase === 'synthesis-and-queue') {
        await fetch(`${app.baseUrl}/__arm-tts`, { method: 'POST' });
      } else {
        await browser.evaluate(() => {
          (document.querySelector('iframe[title="实际舞台"]') as HTMLIFrameElement).contentWindow?.postMessage({ type: 'feat010-late-control', hold: true }, '*');
          return null;
        });
        await expect.poll(() => browser.evaluate(() => (window as any).__latePhase.includes('holding'))).toBe(true);
        await fetch(`${app.baseUrl}/__arm-multisegment`, { method: 'POST' });
      }
      await screen.getByPlaceholder('弹幕内容（醒目留言也用这里的字）').fill('断连前的两段回答');
      await screen.getByRole('button', '发弹幕').tap();
      await expect.poll(async () => (await state()).speechAttempts - before.speechAttempts, { timeout: 20000 }).toBe(2);
      if (phase === 'synthesis-and-queue') {
        await expect.poll(async () => (await state()).ttsHeld).toBe(true);
      } else {
        await expect.poll(() => browser.evaluate(() => (window as any).__latePhase.includes('held')), { timeout: 20000 }).toBe(true);
        expect(await browser.evaluate(() => (window as any).__latePhase.includes('playing'))).toBe(true);
      }
      if (disconnection === 'input') {
        await screen.getByRole('button', '断开订阅').tap();
        await expect.poll(async () => (await state()).hubConnected).toBe(false);
      } else {
        await fetch(`${app.baseUrl}/__stage-stop`, { method: 'POST' });
        await expect.poll(async () => (await state()).course?.playUnknown).toBe(true);
      }
      const disconnected = await state();
      if (phase === 'synthesis-and-queue') {
        await fetch(`${app.baseUrl}/__release-tts`, { method: 'POST' });
      } else {
        await browser.evaluate(() => {
          (document.querySelector('iframe[title="实际舞台"]') as HTMLIFrameElement).contentWindow?.postMessage({ type: 'feat010-late-control', hold: false }, '*');
          return null;
        });
      }
      await expect.poll(async () => (await state()).settledSpeech - before.settledSpeech, { timeout: 20000 }).toBe(2);
      const released = await state();
      expect(released.stage.events).toEqual(disconnected.stage.events);
      expect(released.course?.phase).not.toBe('playing');
      if (disconnection === 'input') {
        await screen.getByRole('button', '连接', { exact: true }).tap();
        await expect.poll(async () => (await state()).hubConnected).toBe(true);
      } else {
        const restored = await (await fetch(`${app.baseUrl}/__stage-start`, { method: 'POST' })).json() as { stagePort: number };
        await browser.evaluate((stagePort) => {
          const frame = document.querySelector('iframe[title="实际舞台"]') as HTMLIFrameElement;
          frame.src = `http://127.0.0.1:${stagePort}/?token=fixture`;
          return null;
        }, restored.stagePort);
        await expect(browser.frameLocator('iframe[title="实际舞台"]').locator('body')).toBeVisible();
        await screen.getByRole('button', '加载课程').tap();
        await expect.poll(async () => (await state()).course?.playUnknown).toBe(false);
      }
      expect((await state()).stage.events).toEqual(disconnected.stage.events);
      expect((await state()).counters).toEqual({ sharedRequests: 0, externalRequests: 0 });
    });
  }
}

test('uses the owner public chat drawer with the synthetic sender', async ({ app, screen, browser }) => {
  await browser.route('**/*', async (route) => {
    const url = new URL(route.request.url);
    if (url.hostname !== '127.0.0.1' || ['3080', '3081', '7390', '8757'].includes(url.port)) return route.abort();
    if (url.pathname.startsWith('/api/')) return route.continue({ headers: { ...route.request.headers, 'x-fixture-owner': 'owner-fixture' } });
    return route.continue();
  });
  const state = async () => (await (await fetch(`${app.baseUrl}/__acceptance`)).json()) as any;
  const initial = await state();
  await app.open('/');
  await screen.getByRole('button', '设置', { exact: true }).tap();
  await screen.getByLabel('启用新直播会话设置').check();
  await screen.getByLabel('工作目录（可留空：沿用默认工作区）').fill(initial.canonicalPaths.workdir);
  await screen.getByRole('region', '新直播会话').getByRole('button', '添加资料根').tap();
  await screen.getByLabel('资料根 1 路径').fill(initial.canonicalPaths.materials);
  await screen.getByRole('region', '新直播会话').getByRole('button', '保存会话设置').tap();
  await expect(screen.getByText('已保存：将在此后新建的直播会话生效；正在播的会话不变。')).toBeVisible();
  await screen.getByRole('button', '关闭', { exact: true }).tap();
  await screen.getByRole('button', '连接', { exact: true }).tap();
  await expect.poll(async () => (await state()).hubConnected).toBe(true);
  await screen.getByRole('button', '开始本地舞台').tap();
  await expect.poll(async () => (await state()).observedTurnEnds, { timeout: 20000 }).toBeGreaterThan(0);
  await expect.poll(async () => (await state()).brain, { timeout: 20000 }).toBe('listening');
  await screen.getByRole('button', '设置', { exact: true }).tap();
  await expect(screen.getByRole('heading', '公屏文字')).toBeVisible();
  await screen.getByRole('button', '维护发送材料').focus();
  expect(await browser.evaluate(() => (document.activeElement?.textContent?.trim() ?? null))).toBe('维护发送材料');
  await screen.getByRole('button', '维护发送材料').tap();
  await expect(screen.getByText('发送服务：已装配')).toBeVisible();
  await screen.getByRole('button', '核查资格').tap();
  await expect(screen.getByText('资格：已核查；授权：未授权；暂停：否')).toBeVisible();
  await screen.getByRole('button', '明确授权').tap();
  await expect(screen.getByText('资格：已核查；授权：已授权；暂停：否')).toBeVisible();
  await expect(screen.getByText('操作已完成，请核对状态')).toBeVisible();
  expect((await state()).publicChat.offlineSender.sends).toHaveLength(0);
  expect(await browser.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await app.screenshot('offline-sender-owner-controls');
  await screen.getByRole('button', '撤权', { exact: true }).tap();
  await expect.poll(async () => (await state()).publicChat.view.publicChat.grant).toBe(null);
  expect((await state()).publicChat.offlineSender.sends).toHaveLength(0);
  expect((await state()).counters).toEqual({ sharedRequests: 0, externalRequests: 0 });
});
