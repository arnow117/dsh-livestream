import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { readPublicChatGeometry } from './responsive-geometry';

test('owner can inspect, cancel and confirm a synthetic login while history is held', async ({ app, screen, browser }) => {
  let opened = false;
  try {
    await app.open('/');
    opened = true;
    await screen.getByRole('button', '设置').tap();
    await expect(screen.getByRole('heading', '公屏文字')).toBeVisible();
    await expect(screen.getByText('历史：不可用')).toBeVisible();
    const initial = await browser.evaluate(async () => (await fetch('/fixture-counts')).json());
    expect(initial).toMatchObject({ settingsPosts: 0, publicActions: 0 });
    await screen.getByLabel('手动文字草稿').press('Tab');
    await expect(screen.getByRole('button', '登录发送账号')).toBeFocused();
    await browser.keyboard.press('Enter');
    await expect(screen.getByText('登录状态：请使用本人手机扫码')).toBeVisible();
    await expect(screen.getByRole('img', '使用本人手机扫描登录二维码')).toBeVisible();
    await screen.getByLabel('手动文字草稿').press('Tab');
    await expect(screen.getByRole('button', '取消登录')).toBeFocused();
    await browser.keyboard.press('Enter');
    await expect(screen.getByRole('img', '使用本人手机扫描登录二维码')).not.toBeVisible();
    await browser.evaluate(async () => { await fetch('/fixture-login-failure'); });
    await expect(screen.getByText('登录状态：登录未完成，请重试')).toBeVisible();
    await screen.getByLabel('手动文字草稿').press('Tab');
    await expect(screen.getByRole('button', '登录发送账号')).toBeFocused();
    await browser.keyboard.press('Enter');
    await browser.evaluate(async () => { await fetch('/fixture-confirm'); });
    await expect(screen.getByRole('button', '确认账号和房间')).toBeVisible();
    await expect(screen.getByText('发送账号：42；房间：101')).toBeVisible();
    await screen.getByLabel('手动文字草稿').press('Tab');
    await expect(screen.getByRole('button', '取消登录')).toBeFocused();
    await screen.getByRole('button', '取消登录').press('Tab');
    await expect(screen.getByRole('button', '确认账号和房间')).toBeFocused();
    await browser.keyboard.press('Enter');
    await expect(screen.getByText('登录状态：账号已确认，等待直播连接')).toBeVisible();
    await expect(screen.getByRole('button', '开启本次公屏回复')).toBeDisabled();
    await browser.evaluate(async () => { await fetch('/fixture-unknown'); });
    await expect(screen.getByText(/结果未知，需核对原请求/)).toBeVisible();
    const geometry = await browser.evaluate(readPublicChatGeometry);
    expect(geometry.document.scrollWidth).toBeLessThanOrEqual(geometry.document.clientWidth + 1);
    expect(geometry.drawer.scrollWidth).toBeLessThanOrEqual(geometry.drawer.clientWidth + 1);
    expect(geometry.panel.scrollWidth).toBeLessThanOrEqual(geometry.panel.clientWidth + 1);
    expect(geometry.clipped).toEqual([]);
    expect(geometry.textOverflow).toEqual([]);
    const text = await browser.evaluate(() => document.body.textContent ?? '');
    expect(text.includes('SYNTHETIC_SECRET_SENTINEL')).toBe(false);
    await app.screenshot(`session-${geometry.viewport.width}`);
    const final = await browser.evaluate(async () => (await fetch('/fixture-counts')).json());
    expect(final).toMatchObject({ settingsPosts: 0, publicActions: 4 });
  } finally {
    if (opened) await browser.evaluate(async () => { await fetch('/fixture-finish'); });
  }
});
