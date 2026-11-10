import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

async function blockShared(browser: any): Promise<string[]> {
  const blocked: string[] = [];
  await browser.route(/^https?:\/\/(?:127\.0\.0\.1|localhost):(?:3080|3081|7390|8757)(?:\/|$)/, async (route: any) => {
    blocked.push(route.request.url);
    await route.abort();
  });
  return blocked;
}

const request = (baseUrl: string, path: string) => fetch(`${baseUrl}/${path}`, { method: 'POST' });
const fixture = async (baseUrl: string) => (await fetch(`${baseUrl}/__fixture`)).json();

async function openTarget(app: any, screen: any, browser: any) {
  await request(app.baseUrl, '__reset');
  await browser.addInitScript(() => {
    const errors: string[] = [];
    (window as any).testErrors = errors;
    const originalError = console.error;
    console.error = (...args) => { errors.push(args.map(String).join(' ')); originalError(...args); };
    window.addEventListener('error', (event) => errors.push(event.message));
    window.addEventListener('unhandledrejection', () => errors.push('unhandled rejection'));
  });
  await app.open('/');
  await screen.getByLabel('平台').focus();
  expect(await browser.evaluate(() => {
    const active = document.activeElement;
    return active?.id === 'live-platform' && getComputedStyle(active).outlineStyle !== 'none';
  })).toBe(true);
  await screen.getByLabel('平台').selectOption({ value: 'douyin' });
  await screen.getByLabel('抖音房间号或完整直播间地址').fill('https://live.douyin.com/90071992547409931234');
  await screen.getByRole('button', '保存', { exact: true }).focus();
  await screen.getByRole('button', '保存', { exact: true }).press('Enter');
  await expect(screen.getByRole('button', '连接', { exact: true })).toBeEnabled();
  await expect(screen.getByText('连接状态：没连接')).toBeVisible();
  expect(await browser.evaluate(() => {
    const panel = document.querySelector('.dl-room-control');
    return !!panel && panel.scrollWidth <= panel.clientWidth;
  })).toBe(true);
}

test('saves and connects a room before forwarding input to the local stage', async ({ app, screen, browser }) => {
  const blocked = await blockShared(browser);
  await openTarget(app, screen, browser);
  await browser.reload();
  await expect(screen.getByLabel('抖音房间号或完整直播间地址')).toHaveValue('90071992547409931234');
  await screen.getByRole('button', '连接', { exact: true }).tap();
  await expect.poll(async () => (await fixture(app.baseUrl)).status.live.state).toBe('connecting');
  await expect(screen.getByText('连接状态：连接中')).toBeVisible();
  await request(app.baseUrl, '__live');
  await expect.poll(async () => (await fixture(app.baseUrl)).status.live.state).toBe('connected');
  await expect(screen.getByText('连接状态：已连上')).toBeVisible();
  await app.screenshot('douyin-connected');
  await screen.getByRole('button', '模拟观众').tap();
  await expect(screen.getByRole('button', '小花 ×5')).toBeVisible();
  await expect(screen.getByText('上舰')).toHaveCount(0);
  await expect(screen.getByText('小电视飞船 ¥1245')).toHaveCount(0);
  await screen.getByRole('button', '开始本地舞台').tap();
  await expect.poll(async () => (await fixture(app.baseUrl)).selectedPreset).toBe('dsh-livestream-douyin');
  await expect.poll(async () => (await fixture(app.baseUrl)).prompts.length).toBeGreaterThan(0);
  await request(app.baseUrl, '__chat');
  await expect(screen.getByText('测试弹幕')).toBeVisible();
  await expect.poll(async () => (await fixture(app.baseUrl)).prompts.some((prompt: string) => prompt.includes('测试弹幕'))).toBe(true);
  expect(await browser.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await expect.poll(async () => (await fixture(app.baseUrl)).stageRequests).toBeGreaterThan(0);
  expect((await fixture(app.baseUrl)).stageUrl).toContain(app.baseUrl);
  expect((await fixture(app.baseUrl)).sharedRequests).toBe(0);
  expect(blocked).toEqual([]);
  expect(await browser.evaluate(() => (window as any).testErrors)).toEqual([]);
});

test('reports terminal errors and explicitly retries the subscription', async ({ app, screen, browser }) => {
  const blocked = await blockShared(browser);
  await openTarget(app, screen, browser);
  await screen.getByRole('button', '连接', { exact: true }).tap();
  await expect.poll(async () => (await fixture(app.baseUrl)).subscriptions).toBe(1);
  await request(app.baseUrl, '__error');
  await expect(screen.getByRole('alert')).toContainText('显式重试');
  await expect(screen.getByRole('button', '断开订阅')).toBeVisible();
  expect((await fixture(app.baseUrl)).subscriptions).toBe(1);
  await request(app.baseUrl, '__rearm');
  await expect(screen.getByRole('button', '重试连接')).toBeEnabled();
  await screen.getByRole('button', '重试连接').tap();
  await expect.poll(async () => (await fixture(app.baseUrl)).subscriptions).toBe(2);
  await request(app.baseUrl, '__drop');
  await expect(screen.getByRole('alert')).toContainText('显式重试');
  expect((await fixture(app.baseUrl)).subscriptions).toBe(2);
  await screen.getByRole('button', '断开订阅').tap();
  await request(app.baseUrl, '__rearm');
  await screen.getByRole('button', '连接', { exact: true }).tap();
  await expect.poll(async () => (await fixture(app.baseUrl)).subscriptions).toBe(3);
  await screen.getByRole('button', '断开订阅').tap();
  expect((await fixture(app.baseUrl)).sharedRequests).toBe(0);
  expect(blocked).toEqual([]);
  expect(await browser.evaluate(() => (window as any).testErrors)).toEqual([]);
});

test('blocks switching while subscribed and clears the old event after disconnect', async ({ app, screen, browser }) => {
  const blocked = await blockShared(browser);
  await openTarget(app, screen, browser);
  await screen.getByRole('button', '连接', { exact: true }).tap();
  await expect.poll(async () => (await fixture(app.baseUrl)).subscriptions).toBe(1);
  await request(app.baseUrl, '__live');
  await request(app.baseUrl, '__chat');
  await expect(screen.getByText('测试弹幕')).toBeVisible();
  await screen.getByLabel('平台').selectOption({ value: 'bilibili' });
  await screen.getByLabel('B 站直播间房间号').fill('42');
  await screen.getByRole('button', '保存', { exact: true }).tap();
  await expect(screen.getByText(/请先停止舞台、断开订阅/)).toBeVisible();
  await screen.getByRole('button', '断开订阅').tap();
  await screen.getByRole('button', '保存', { exact: true }).tap();
  await expect(screen.getByLabel('B 站直播间房间号')).toBeVisible();
  await expect(screen.getByText('测试弹幕')).toHaveCount(0);
  expect((await fixture(app.baseUrl)).sharedRequests).toBe(0);
  expect(blocked).toEqual([]);
  expect(await browser.evaluate(() => (window as any).testErrors)).toEqual([]);
});

test('confirms the shared effect before stopping only the selected room', async ({ app, screen, browser }) => {
  const blocked = await blockShared(browser);
  await openTarget(app, screen, browser);
  await screen.getByRole('button', '连接', { exact: true }).tap();
  await expect.poll(async () => (await fixture(app.baseUrl)).subscriptions).toBe(1);
  await screen.getByRole('button', '断开订阅').tap();
  expect((await fixture(app.baseUrl)).stopRequests).toBe(0);
  await expect(screen.getByRole('button', '停止此房间采集')).toBeDisabled();
  await screen.getByLabel('确认停止抖音 90071992547409931234 的采集，会影响使用该房间的其他程序').check();
  await screen.getByRole('button', '停止此房间采集').tap();
  await expect.poll(async () => (await fixture(app.baseUrl)).stopRequests).toBe(1);
  await expect.poll(async () => (await fixture(app.baseUrl)).bridgeStatus).toBe('stopped');
  await expect(screen.getByText(/房间状态：已停止/)).toBeVisible();
  await app.screenshot('room-stopped');
  expect((await fixture(app.baseUrl)).sharedRequests).toBe(0);
  expect(blocked).toEqual([]);
  expect(await browser.evaluate(() => (window as any).testErrors)).toEqual([]);
});

test('keeps the target protected when a start result is unknown', async ({ app, screen, browser }) => {
  const blocked = await blockShared(browser);
  await openTarget(app, screen, browser);
  await request(app.baseUrl, '__unknown-start');
  await screen.getByRole('button', '连接', { exact: true }).tap();
  await expect.poll(async () => (await (await fetch(`${app.baseUrl}/api/dsh-livestream/state`)).json()).roomControl.operation.state).toBe('unknown');
  await expect(screen.getByRole('button', '连接', { exact: true })).toBeDisabled();
  expect((await fixture(app.baseUrl)).startRequests).toBe(1);
  expect((await fixture(app.baseUrl)).subscriptions).toBe(0);
  await app.screenshot('room-result-unknown');
  expect((await fixture(app.baseUrl)).sharedRequests).toBe(0);
  expect(blocked).toEqual([]);
  expect(await browser.evaluate(() => (window as any).testErrors)).toEqual([]);
});
