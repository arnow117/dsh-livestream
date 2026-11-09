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

async function reset(baseUrl: string) {
  await fetch(`${baseUrl}/__reset`, { method: 'POST' });
}
async function fixture(baseUrl: string) {
  return (await fetch(`${baseUrl}/__fixture`)).json();
}

test('draft preview is private and saved voice survives reload', async ({ app, screen, browser }) => {
  const blocked = await blockShared(browser);
  await reset(app.baseUrl);
  await browser.addInitScript(() => {
    const errors: string[] = [];
    (window as unknown as { testErrors: string[] }).testErrors = errors;
    const originalError = console.error;
    console.error = (...args) => { errors.push(args.map(String).join(' ')); originalError(...args); };
    window.addEventListener('error', (event) => errors.push(event.message));
    window.addEventListener('unhandledrejection', () => errors.push('unhandled rejection'));
  });
  await app.open('/');
  await screen.getByRole('button', '设置').focus();
  await screen.getByRole('button', '设置').press('Enter');
  await expect(screen.getByLabel('音色描述')).toBeVisible();
  await screen.getByRole('button', '关闭').tap();
  await fetch(`${app.baseUrl}/__external-save`, { method: 'POST' });
  await fetch(`${app.baseUrl}/__fail-state`, { method: 'POST' });
  await screen.getByRole('button', '设置').tap();
  await expect(screen.getByRole('alert')).toContainText('读取声音设置失败');
  await screen.getByRole('button', '重试').tap();
  await expect(screen.getByLabel('音色描述')).toHaveValue('外部更新声音');
  expect(await browser.evaluate(() => { const drawer = document.querySelector('.dl-drawer')!; return drawer.scrollWidth <= drawer.clientWidth; })).toBe(true);
  console.log('Browser:', await browser.evaluate(() => navigator.userAgent));
  await screen.getByLabel('音色描述').fill('新的温暖声音');
  await expect(screen.getByText('声音设置：未保存')).toBeVisible();
  await screen.getByRole('button', '试听', { exact: true }).tap();
  await expect(screen.getByRole('status')).toHaveText('试听已准备好');
  await expect(screen.getByText('声音设置：未保存')).toBeVisible();
  let data = await fixture(app.baseUrl);
  expect(data.settings.yovoiceVoice).toBe('外部更新声音');
  expect(data.stageEvents).toBe(0);
  expect(data.onAir).toBe(false);
  expect(data.calls[0]).toMatchObject({ backend: 'yovoice', voiceDescription: '新的温暖声音' });
  await fetch(`${app.baseUrl}/__fail-save`, { method: 'POST' });
  await screen.getByRole('button', '保存声音').focus();
  await screen.getByRole('button', '保存声音').press('Enter');
  await expect(screen.getByRole('status')).toContainText('保存设置失败');
  await expect(screen.getByText('声音设置：未保存')).toBeVisible();
  expect((await fixture(app.baseUrl)).settings.yovoiceVoice).toBe('外部更新声音');
  await screen.getByRole('button', '保存声音').press('Enter');
  await expect(screen.getByRole('status')).toContainText('已保存');
  await expect(screen.getByText('声音设置：已生效')).toBeVisible();
  await browser.reload();
  await screen.getByRole('button', '设置').tap();
  await expect(screen.getByLabel('音色描述')).toHaveValue('新的温暖声音');
  await screen.getByRole('button', '试听', { exact: true }).tap();
  await expect(screen.getByRole('status')).toHaveText('试听已准备好');
  data = await fixture(app.baseUrl);
  expect(data.calls[1]).toMatchObject({ backend: 'yovoice', voiceDescription: '新的温暖声音' });
  expect(await browser.evaluate(() => (window as unknown as { testErrors: string[] }).testErrors)).toEqual([]);
  await expect.poll(async () => (await fixture(app.baseUrl)).stageRequests).toBeGreaterThan(0);
  expect((await fixture(app.baseUrl)).stageUrl).toContain(app.baseUrl);
  expect(blocked).toEqual([]);
  await app.screenshot('voice-saved');
});

test('switching backends preserves drafts and sends adapter parameters', async ({ app, screen, browser }) => {
  const blocked = await blockShared(browser);
  await reset(app.baseUrl);
  await app.open('/');
  await screen.getByRole('button', '设置').tap();
  await screen.getByLabel('音色描述').fill('保留的描述');
  await screen.getByLabel('语音后端').selectOption({ value: 'macos' });
  await screen.getByLabel('Mac 音色名').fill('Meijia');
  await screen.getByRole('button', '试听', { exact: true }).tap();
  await expect(screen.getByRole('status')).toHaveText('试听已准备好');
  await screen.getByLabel('语音后端').selectOption({ value: 'doubao' });
  await screen.getByLabel('豆包音色 ID').fill('zh_female_zhixingnv_uranus_bigtts');
  await screen.getByLabel('语速').fill('12');
  await screen.getByRole('button', '试听', { exact: true }).tap();
  await expect(screen.getByRole('status')).toHaveText('试听已准备好');
  const data = await fixture(app.baseUrl);
  expect(data.calls[0]).toMatchObject({ backend: 'macos', args: expect.arrayContaining(['Meijia']) });
  expect(data.calls[1]).toMatchObject({ backend: 'doubao', req_params: { speaker: 'zh_female_zhixingnv_uranus_bigtts', audio_params: { speech_rate: 12 } } });
  await screen.getByLabel('语音后端').selectOption({ value: 'yovoice' });
  await expect(screen.getByLabel('音色描述')).toHaveValue('保留的描述');
  await fetch(`${app.baseUrl}/__fail-next`, { method: 'POST' });
  await screen.getByRole('button', '试听', { exact: true }).tap();
  await expect(screen.getByRole('status')).toContainText('语音服务不可用');
  const failed = await fixture(app.baseUrl);
  expect(failed.calls).toHaveLength(3);
  expect(failed.calls[2].backend).toBe('yovoice');
  expect(blocked).toEqual([]);
  await app.screenshot('voice-backends');
});

test('cancelling and editing aborts the old preview and allows a new one', async ({ app, screen, browser }) => {
  const blocked = await blockShared(browser);
  await reset(app.baseUrl);
  await app.open('/');
  await screen.getByRole('button', '设置').tap();
  await screen.getByLabel('试听文字').fill('慢速试听');
  await screen.getByRole('button', '试听', { exact: true }).tap();
  await expect(screen.getByRole('status')).toHaveText('正在生成试听');
  await expect.poll(async () => (await fixture(app.baseUrl)).calls.length).toBeGreaterThan(0);
  await screen.getByRole('button', '取消试听').tap();
  await expect(screen.getByRole('status')).toHaveText('试听已取消');
  await expect.poll(async () => (await fixture(app.baseUrl)).calls.some((call: { backend: string }) => call.backend === 'cancel')).toBe(true);
  await screen.getByRole('button', '试听', { exact: true }).tap();
  await expect.poll(async () => (await fixture(app.baseUrl)).calls.filter((call: { backend: string }) => call.backend === 'yovoice').length).toBe(2);
  await screen.getByLabel('语音后端').selectOption({ value: 'macos' });
  await expect.poll(async () => (await fixture(app.baseUrl)).calls.filter((call: { backend: string }) => call.backend === 'cancel').length).toBe(2);
  await screen.getByLabel('语音后端').selectOption({ value: 'yovoice' });
  await screen.getByRole('button', '试听', { exact: true }).tap();
  await expect.poll(async () => (await fixture(app.baseUrl)).calls.filter((call: { backend: string }) => call.backend === 'yovoice').length).toBe(3);
  await screen.getByRole('button', '关闭').tap();
  await expect.poll(async () => (await fixture(app.baseUrl)).calls.filter((call: { backend: string }) => call.backend === 'cancel').length).toBe(3);
  await screen.getByRole('button', '设置').tap();
  await screen.getByLabel('试听文字').fill('新的试听');
  await screen.getByRole('button', '试听', { exact: true }).tap();
  await expect(screen.getByRole('status')).toHaveText('试听已准备好');
  await screen.getByRole('button', '关闭').tap();
  expect(blocked).toEqual([]);
  await app.screenshot('voice-closed');
});
