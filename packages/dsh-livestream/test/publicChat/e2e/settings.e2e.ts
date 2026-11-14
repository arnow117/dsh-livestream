import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readPublicChatGeometry } from './responsive-geometry';
import { join } from 'node:path';

async function assertPublicChatLayout(browser: any) {
  const geometry = await browser.evaluate(readPublicChatGeometry);
  expect(geometry.document.scrollWidth).toBeLessThanOrEqual(geometry.document.clientWidth + 1);
  expect(geometry.drawer.scrollWidth).toBeLessThanOrEqual(geometry.drawer.clientWidth + 1);
  expect(geometry.drawer.scrollLeft).toBe(0);
  expect(geometry.panel.scrollWidth).toBeLessThanOrEqual(geometry.panel.clientWidth + 1);
  expect(geometry.clipped).toEqual([]);
  expect(geometry.textOverflow).toEqual([]);
  return geometry;
}

test('owner saves a draft without sender activity and retains it on failure', async ({ app, screen, browser }) => {
  try {
    await app.open('/');
    await screen.getByRole('button', '设置').tap();
    await expect(screen.getByRole('heading', '公屏文字')).toBeVisible();
    await assertPublicChatLayout(browser);
    await expect(screen.getByLabel('启用公屏发送')).not.toBeChecked();
    await expect(screen.getByLabel('允许当前公屏事件的 Agent 回复')).not.toBeChecked();
    await expect(screen.getByLabel('欢迎观众进场')).not.toBeChecked();
    await expect(screen.getByLabel('感谢礼物')).not.toBeChecked();
    await expect(screen.getByRole('button', '明确授权')).toBeDisabled();
    await screen.getByLabel('启用公屏发送').check();
    const draft = screen.getByLabel('手动文字草稿');
    await draft.fill('本地测试文字');
    await draft.press('Tab');
    await expect(screen.getByRole('button', '保存公屏设置')).toBeFocused();
    await assertPublicChatLayout(browser);
    await browser.keyboard.press('Enter');
    await expect(screen.getByText('设置已保存；尚未核查或授权发送')).toBeVisible();
    await expect(screen.getByText('发送服务：不可用')).toBeVisible();
    const counts = await browser.evaluate(async () => (await fetch('/fixture-counts')).json());
    expect(counts).toMatchObject({ settingsPosts: 1, publicActions: 0 });
    await browser.evaluate(async () => { await fetch('/fixture-fail-next-save'); });
    await draft.fill('保存失败的草稿');
    await screen.getByRole('button', '保存公屏设置').tap();
    await expect(screen.getByText('保存失败，草稿仍保留')).toBeVisible();
    await expect(draft).toHaveValue('保存失败的草稿');
    await assertPublicChatLayout(browser);
    const after = await browser.evaluate(async () => (await fetch('/fixture-counts')).json());
    expect(after).toMatchObject({ settingsPosts: 2, publicActions: 0 });
    await browser.evaluate(async () => { await fetch('/fixture-long-public-chat'); });
    await expect(screen.getByText(/结果未知，需核对原请求/)).toBeVisible();
    const longSource = 'source-' + 's'.repeat(180);
    expect(await browser.evaluate((value: string) => document.querySelector('.dl-public-chat')?.textContent?.includes(value), longSource)).toBe(true);
    await screen.getByText('原请求完整绑定').tap();
    await assertPublicChatLayout(browser);
    await screen.getByLabel('备注或未看到').fill('本地备注');
    await screen.getByLabel('备注或未看到').press('Tab');
    await expect(screen.getByRole('button', '记录备注')).toBeFocused();
    const geometry = await assertPublicChatLayout(browser);
    const imagePath = await app.screenshot(`long-unknown-${geometry.viewport.width}`);
    const png = readFileSync(imagePath);
    expect(png.readUInt32BE(16)).toBe(geometry.viewport.width);
    expect(png.readUInt32BE(20)).toBe(geometry.viewport.height);
    const evidenceRoot = process.env.DSH_PUBLIC_CHAT_E2E_ROOT;
    if (!evidenceRoot) throw new Error('task-owned output required');
    writeFileSync(join(evidenceRoot, 'output', `long-responsive-${process.pid}-${geometry.viewport.width}.json`),
      JSON.stringify({ path: imagePath, viewport: geometry.viewport, geometry }, null, 2), { flag: 'wx' });
  } finally {
    await browser.evaluate(async () => { await fetch('/fixture-finish'); });
    const root = process.env.DSH_PUBLIC_CHAT_E2E_ROOT;
    if (!root) throw new Error('task-owned output required');
    const resultPath = join(root, 'output', `e2e-settings-cleanup-${new URL(app.baseUrl).port}.json`);
    await expect.poll(() => existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')).code : null,
      { timeout: 25000 }).toBe(0);
  }
});
