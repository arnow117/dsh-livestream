import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('saves one platform and room draft on the main page', async ({ app, screen, browser }) => {
  const blocked: string[] = [];
  await browser.route(/^https?:\/\/(?:127\.0\.0\.1|localhost):(?:3080|3081|7390|8757)(?:\/|$)/, async (route: any) => {
    blocked.push(route.request.url);
    await route.abort();
  });
  await fetch(`${app.baseUrl}/__reset`, { method: 'POST' });
  await app.open('/');
  await screen.getByLabel('平台').selectOption({ value: 'douyin' });
  await screen.getByLabel('抖音房间号或完整直播间地址').fill('https://live.douyin.com/90071992547409931234');
  const before = await (await fetch(`${app.baseUrl}/__fixture`)).json();
  expect(before.settings.livePlatform).toBe('bilibili');
  expect(before.settings.douyinRoomId).toBe('');
  await screen.getByRole('button', '保存', { exact: true }).press('Enter');
  await expect.poll(async () => (await (await fetch(`${app.baseUrl}/__fixture`)).json()).settings.livePlatform).toBe('douyin');
  await expect(screen.getByText('已保存：抖音 90071992547409931234')).toBeVisible();
  await expect(screen.getByText(/采集服务：可用/)).toBeVisible();
  expect(await browser.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(await browser.evaluate(() => {
    const title = document.querySelector('.dl-top h1')?.getBoundingClientRect();
    const confirmation = document.querySelector('.dl-room-control .dl-check')?.getBoundingClientRect();
    return !!title && title.height < 60 && !!confirmation && confirmation.width > 150 && confirmation.height < 80;
  })).toBe(true);
  expect((await (await fetch(`${app.baseUrl}/__fixture`)).json()).sharedRequests).toBe(0);
  expect(blocked).toEqual([]);
  await app.screenshot('room-draft-saved');
});
