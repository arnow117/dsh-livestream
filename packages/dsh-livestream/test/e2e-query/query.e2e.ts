import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

const fixture = async (baseUrl: string) => (await fetch(`${baseUrl}/__fixture`)).json();

test('configures queries and follows the real console to the owned stage', async ({ app, screen, browser }) => {
  const blocked: string[] = [];
  await browser.route(/^https?:\/\/(?:127\.0\.0\.1|localhost):(?:3080|3081|7390|8757)(?:\/|$)/, async (route: any) => {
    blocked.push(route.request.url);
    await route.abort();
  });
  await app.open('/');
  await screen.getByRole('button', '设置', { exact: true }).tap();
  await expect(screen.getByText('凭据：未配置；服务：未验证')).toBeVisible();
  const weather = screen.getByLabel('启用天气查询');
  await weather.focus();
  expect(await browser.evaluate(() => document.activeElement?.getAttribute('type'))).toBe('checkbox');
  await weather.press('Space');
  await expect(weather).toBeChecked();
  await screen.getByLabel('GLM Coding Plan API Key').fill('fixture-key');
  await screen.getByRole('region', '天气与公开资料').getByRole('button', '保存', { exact: true }).tap();
  await expect(screen.getByText('凭据：已配置；服务：未验证')).toBeVisible();
  await screen.getByRole('region', '天气与公开资料').scrollIntoView();
  await app.screenshot('query-settings');
  await screen.getByRole('button', '关闭', { exact: true }).tap();
  await screen.getByRole('button', '开始彩排').tap();
  await expect.poll(async () => (await fixture(app.baseUrl)).status.onAir).toBe(true);
  await screen.getByPlaceholder('比如：给大家讲讲你今天学到的东西').fill('北京天气如何');
  await screen.getByRole('button', '说', { exact: true }).tap();
  await expect.poll(async () => (await fixture(app.baseUrl)).mcpRequests.filter((item: any) => item?.method === 'tools/call').length).toBe(1);
  await expect(screen.getByText('天气：资料不足')).toBeVisible();
  await expect(screen.getByRole('link', 'weather.com.cn')).toBeVisible();
  const result = await fixture(app.baseUrl);
  expect(result.modelRequests.some((request: any) => request.tools?.some((tool: any) => tool.name === 'weather_lookup'))).toBe(true);
  expect(result.modelRequests.some((request: any) => request.messages?.some((message: any) => Array.isArray(message.content) && message.content.some((block: any) => block.type === 'tool_result' && JSON.stringify(block.content).includes('limited'))))).toBe(true);
  const owned = result.stageEvents.find((event: any) => event.type === 'say' && event.owner);
  expect(owned).toBeDefined();
  expect(result.stageEvents.some((event: any) => event.type === 'output' && event.epoch === owned.owner.epoch)).toBe(true);
  expect(result.status.outputCapabilities.capableSpeakers).toBeGreaterThan(0);
  expect(result.sharedRequests).toBe(0);
  expect(result.externalRequests).toBe(0);
  expect(blocked).toEqual([]);
  expect(await browser.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await screen.getByRole('region', '查询状态与来源').scrollIntoView();
  await app.screenshot('query-weather-limited');

  await fetch(`${app.baseUrl}/__mode`, { method: 'POST', body: 'weather-evidence' });
  await screen.getByPlaceholder('比如：给大家讲讲你今天学到的东西').fill('北京天气如何');
  await screen.getByRole('button', '说', { exact: true }).tap();
  await expect(screen.getByText('天气：已取得资料')).toBeVisible();
  await expect(screen.getByRole('link', '北京天气')).toBeVisible();
  await expect.poll(async () => {
    const state = await fixture(app.baseUrl);
    return state.modelRequests.some((request: any) => request.messages?.some((message: any) =>
      Array.isArray(message.content) && message.content.some((block: any) =>
        block.type === 'tool_result' && typeof block.content === 'string'
          && block.content.includes('"status":"evidence"') && block.content.includes('气温 20℃'))));
  }).toBe(true);
  await fetch(`${app.baseUrl}/__mode`, { method: 'POST', body: 'normal' });

  await screen.getByRole('button', '设置', { exact: true }).tap();
  await screen.getByLabel('启用公开资料搜索').check();
  await screen.getByRole('button', '关闭', { exact: true }).tap();
  await screen.getByPlaceholder('比如：给大家讲讲你今天学到的东西').fill('OBS Studio 许可证是什么');
  await screen.getByRole('button', '说', { exact: true }).tap();
  await expect(screen.getByText('公开资料：已取得资料')).toBeVisible();
  await expect(screen.getByRole('link', 'OBS Studio')).toBeVisible();
  await fetch(`${app.baseUrl}/__mode`, { method: 'POST', body: 'failed' });
  await screen.getByPlaceholder('比如：给大家讲讲你今天学到的东西').fill('OBS Studio 许可证是什么');
  await screen.getByRole('button', '说', { exact: true }).tap();
  await expect(screen.getByText('公开资料：查询失败')).toBeVisible();
  await fetch(`${app.baseUrl}/__mode`, { method: 'POST', body: 'empty' });
  await screen.getByPlaceholder('比如：给大家讲讲你今天学到的东西').fill('OBS Studio 许可证是什么');
  await screen.getByRole('button', '说', { exact: true }).tap();
  await expect(screen.getByText('公开资料：没有结果')).toBeVisible();
  await fetch(`${app.baseUrl}/__mode`, { method: 'POST', body: 'hold' });
  await screen.getByPlaceholder('比如：给大家讲讲你今天学到的东西').fill('北京天气如何');
  await screen.getByRole('button', '说', { exact: true }).tap();
  await expect(screen.getByText('天气：正在查询')).toBeVisible();
  const beforeCancel = await fixture(app.baseUrl);
  await screen.getByRole('button', '让她停下这一轮').tap();
  await expect(screen.getByText('天气：查询已取消')).toBeVisible();
  await fetch(`${app.baseUrl}/__release`, { method: 'POST' });
  await expect.poll(async () => (await fixture(app.baseUrl)).status.query.status).toBe('cancelled');
  const afterCancel = await fixture(app.baseUrl);
  expect(afterCancel.stageEvents.filter((event: any) => event.type === 'say' && event.owner).length).toBe(beforeCancel.stageEvents.filter((event: any) => event.type === 'say' && event.owner).length);
  expect(afterCancel.modelRequests.length).toBe(beforeCancel.modelRequests.length);
  await fetch(`${app.baseUrl}/__mode`, { method: 'POST', body: 'hold-tts' });
  await screen.getByPlaceholder('比如：给大家讲讲你今天学到的东西').fill('北京天气如何');
  await screen.getByRole('button', '说', { exact: true }).tap();
  await expect.poll(async () => { const state = await fixture(app.baseUrl); return state.ttsPending && state.agentStatus === 'idle'; }).toBe(true);
  const pendingTts = await fixture(app.baseUrl);
  const queryId = pendingTts.status.query.queryId;
  const sessionId = pendingTts.status.brainSession;
  const stale = await fetch(`${app.baseUrl}/api/dsh-livestream/query/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, queryId: 'stale' }) });
  expect(stale.status).toBe(409);
  await screen.getByRole('button', '停止查询回复').tap();
  await expect(screen.getByText('天气：查询已取消')).toBeVisible();
  const duplicate = await fetch(`${app.baseUrl}/api/dsh-livestream/query/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, queryId }) });
  expect(duplicate.status).toBe(200);
  await fetch(`${app.baseUrl}/__release-tts`, { method: 'POST' });
  const afterTts = await fixture(app.baseUrl);
  expect(afterTts.stageEvents.filter((event: any) => event.type === 'say' && event.owner).length).toBe(pendingTts.stageEvents.filter((event: any) => event.type === 'say' && event.owner).length);
  await fetch(`${app.baseUrl}/__mode`, { method: 'POST', body: 'normal' });
  await screen.getByPlaceholder('比如：给大家讲讲你今天学到的东西').fill('北京天气如何');
  await screen.getByRole('button', '说', { exact: true }).tap();
  await expect(screen.getByText('天气：资料不足')).toBeVisible();
  await expect.poll(async () => (await fixture(app.baseUrl)).status.query.queryId !== queryId).toBe(true);
  await screen.getByRole('button', '设置', { exact: true }).tap();
  await screen.getByLabel('启用天气查询').uncheck();
  await screen.getByLabel('启用公开资料搜索').uncheck();
  await screen.getByRole('button', '关闭', { exact: true }).tap();
});

test('revokes pending browser audio across a same-build reconnect when invalidate is lost', async ({ app, browser }) => {
  await browser.addInitScript(() => {
    const OriginalEventSource = window.EventSource;
    (window as any).__events = [];
    (window as any).__players = [];
    (window as any).EventSource = class extends OriginalEventSource {
      constructor(url: string) {
        super(url);
        this.addEventListener('message', (event) => { try { (window as any).__events.push(JSON.parse((event as MessageEvent).data)); } catch {} });
        this.addEventListener('error', () => (window as any).__events.push({ type: 'disconnected' }));
      }
    };
    (window as any).Audio = class {
      duration = 1;
      paused = false;
      onloadedmetadata: (() => void) | null = null;
      onplaying: (() => void) | null = null;
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      pause() { this.paused = true; }
      play() { return new Promise<void>((resolve) => { (this as any).release = resolve; }); }
      constructor() { (window as any).__players.push(this); }
    };
  });
  const setup = await (await fetch(`${app.baseUrl}/__stage-test-start`, { method: 'POST' })).json();
  await app.open(setup.stageUrl);
  await expect.poll(() => browser.evaluate(() => (window as any).__events.filter((event: any) => event.type === 'hello').length)).toBe(1);
  await fetch(`${app.baseUrl}/__stage-pending`, { method: 'POST' });
  await expect.poll(() => browser.evaluate(() => (window as any).__players.length)).toBe(1);
  await fetch(`${app.baseUrl}/__drop-invalidate`, { method: 'POST' });
  await expect.poll(() => browser.evaluate(() => (window as any).__events.some((event: any) => event.type === 'disconnected'))).toBe(true);
  await expect.poll(() => browser.evaluate(() => (window as any).__events.filter((event: any) => event.type === 'hello').length), { timeout: 10000 }).toBe(2);
  const outcome = await browser.evaluate(async () => {
    const player = (window as any).__players[0];
    player.onloadedmetadata?.();
    player.release();
    await Promise.resolve();
    player.onplaying?.();
    player.onerror?.();
    return { paused: player.paused, text: document.body.innerText, builds: (window as any).__events.filter((event: any) => event.type === 'hello').map((event: any) => event.build) };
  });
  expect(outcome.paused).toBe(true);
  expect(outcome.text).not.toContain('不应晚到的字幕');
  expect(outcome.builds[0]).toBe(outcome.builds[1]);
  await app.screenshot('stage-reconnect-revoked');
});

test('does not deliver owned output to an old client connecting after a stage upgrade', async ({ app, browser }) => {
  await browser.addInitScript(() => {
    const OriginalEventSource = window.EventSource;
    (window as any).__sources = [];
    (window as any).EventSource = class extends OriginalEventSource {
      constructor(url: string) { super(url); (window as any).__sources.push({ url, source: this }); }
    };
  });
  const setup = await (await fetch(`${app.baseUrl}/__stage-test-start`, { method: 'POST' })).json();
  await app.open(setup.stageUrl);
  await expect.poll(() => browser.evaluate(() => (window as any).__sources.length)).toBeGreaterThan(0);
  await browser.evaluate(() => { for (const item of (window as any).__sources) item.source.close(); });
  await fetch(`${app.baseUrl}/__stage-upgrade`, { method: 'POST' });
  await browser.evaluate(() => {
    (window as any).__oldEvents = [];
    (window as any).__newEvents = [];
    const old = new EventSource('/events?token=fixture');
    const current = new EventSource('/events?token=fixture&outputProtocol=owned-live-v1');
    old.onmessage = (event) => (window as any).__oldEvents.push(JSON.parse(event.data));
    current.onmessage = (event) => (window as any).__newEvents.push(JSON.parse(event.data));
  });
  await expect.poll(() => browser.evaluate(() => (window as any).__oldEvents.some((event: any) => event.type === 'hello') && (window as any).__newEvents.some((event: any) => event.type === 'hello'))).toBe(true);
  await fetch(`${app.baseUrl}/__stage-pending`, { method: 'POST' });
  await expect.poll(() => browser.evaluate(() => (window as any).__newEvents.some((event: any) => event.type === 'say' && event.owner))).toBe(true);
  const outcome = await browser.evaluate(() => ({ old: (window as any).__oldEvents, urls: (window as any).__sources.map((item: any) => item.url) }));
  expect(outcome.old.some((event: any) => event.type === 'say' && event.owner)).toBe(false);
  expect(outcome.urls).toContain('/events?token=fixture');
  await app.screenshot('legacy-stage-upgrade');
});


test('owner cancellation revokes a browser pending reply after model generation ends', async ({ app, browser }) => {
  await browser.addInitScript(() => {
    (window as any).__players = [];
    (window as any).Audio = class {
      duration = 1;
      paused = false;
      onloadedmetadata: (() => void) | null = null;
      onplaying: (() => void) | null = null;
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      pause() { this.paused = true; }
      play() { return new Promise<void>((resolve) => { (this as any).release = resolve; }); }
      constructor() { (window as any).__players.push(this); }
    };
  });
  const setup = await (await fetch(`${app.baseUrl}/__stage-query-setup`, { method: 'POST' })).json();
  await app.open(setup.stageUrl);
  const owner = await fetch(`${app.baseUrl}/api/dsh-livestream/owner`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '北京天气如何' }) });
  expect(owner.status).toBe(200);
  await expect.poll(() => browser.evaluate(() => (window as any).__players.length), { timeout: 10000 }).toBe(1);
  const before = await fixture(app.baseUrl);
  expect(before.agentStatus).toBe('idle');
  const cancel = await fetch(`${app.baseUrl}/api/dsh-livestream/query/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: setup.sessionId, queryId: before.status.query.queryId }) });
  expect(cancel.status).toBe(200);
  await expect.poll(() => browser.evaluate(() => (window as any).__players[0].paused)).toBe(true);
  const result = await browser.evaluate(async () => {
    const player = (window as any).__players[0];
    player.onloadedmetadata?.();
    player.release();
    await Promise.resolve();
    player.onplaying?.();
    player.onerror?.();
    return { paused: player.paused, text: document.body.innerText };
  });
  expect(result.paused).toBe(true);
  expect(result.text).not.toContain('资料来源不足，暂时无法确认。');
  await app.screenshot('owner-cancel-pending-audio');
});

test('accepts a new owner query on the local stage after the Douyin subscription disconnects', async ({ app, screen }) => {
  await fetch(`${app.baseUrl}/__reset-douyin`, { method: 'POST' });
  await app.open('/');
  await screen.getByLabel('平台').selectOption({ value: 'douyin' });
  await screen.getByLabel('抖音房间号或完整直播间地址').fill('12345678');
  await screen.getByRole('button', '保存', { exact: true }).tap();
  await screen.getByRole('button', '连接', { exact: true }).tap();
  await expect.poll(async () => (await fixture(app.baseUrl)).subscriptions).toBe(1);
  await expect(screen.getByText('连接状态：已连上')).toBeVisible();
  await screen.getByRole('button', '开始本地舞台').tap();
  await expect.poll(async () => (await fixture(app.baseUrl)).status.onAir).toBe(true);
  await screen.getByRole('button', '断开订阅').tap();
  await expect(screen.getByText('连接状态：没连接')).toBeVisible();
  const before = await fixture(app.baseUrl);
  await fetch(`${app.baseUrl}/__bridge-chat`, { method: 'POST' });
  expect((await fixture(app.baseUrl)).observedEvents.filter((event: any) => event.type === 'live' && event.event?.id === 'after-disconnect')).toHaveLength(0);
  await screen.getByPlaceholder('比如：给大家讲讲你今天学到的东西').fill('北京天气如何');
  await screen.getByRole('button', '说', { exact: true }).tap();
  await expect(screen.getByText('天气：资料不足')).toBeVisible();
  const after = await fixture(app.baseUrl);
  expect(after.status.onAir).toBe(true);
  expect(after.mcpRequests.filter((item: any) => item?.method === 'tools/call').length).toBe(before.mcpRequests.filter((item: any) => item?.method === 'tools/call').length + 1);
  expect(after.sharedRequests).toBe(0);
  expect(after.externalRequests).toBe(0);
  await screen.getByRole('region', '查询状态与来源').scrollIntoView();
  await app.screenshot('douyin-disconnected-owner-query');
});
