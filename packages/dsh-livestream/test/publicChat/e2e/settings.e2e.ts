import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

test('owner saves a draft without sender activity and retains it on failure', async ({ app, screen, browser }) => {
  try {
    await app.open('/');
    await screen.getByRole('button', '设置').tap();
    await expect(screen.getByRole('heading', '公屏文字')).toBeVisible();
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
    const after = await browser.evaluate(async () => (await fetch('/fixture-counts')).json());
    expect(after).toMatchObject({ settingsPosts: 2, publicActions: 0 });
  } finally {
    await browser.evaluate(async () => { await fetch('/fixture-finish'); });
    const root = process.env.DSH_PUBLIC_CHAT_E2E_ROOT;
    if (!root) throw new Error('task-owned output required');
    const resultPath = join(root, 'output', `e2e-settings-cleanup-${new URL(app.baseUrl).port}.json`);
    await expect.poll(() => existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')).code : null,
      { timeout: 25000 }).toBe(0);
  }
});
