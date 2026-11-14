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

test('owner sends once and reconciles the original unknown through the built sender', async ({ app, screen, browser }) => {
  try {
    await app.open('/');
    await screen.getByRole('button', '设置').tap();
    await expect(screen.getByRole('heading', '公屏文字')).toBeVisible();
    const counts = async () => browser.evaluate(async () => (await fetch('/fixture-counts')).json());
    const initial = await counts();
    await screen.getByLabel('启用公屏发送').check();
    await screen.getByLabel('手动文字草稿').fill('普通文字');
    await screen.getByRole('button', '保存公屏设置').tap();
    await expect(screen.getByText('设置已保存；尚未核查或授权发送')).toBeVisible();
    const saved = await counts();
    expect(saved.chatCount).toBe(initial.chatCount);
    expect(saved.wireCount).toBe(initial.wireCount);
    expect(saved.senderRequests).toBe(0);
    expect(saved.helperCount).toBe(0);
    await screen.getByRole('button', '维护发送材料').tap();
    await expect(screen.getByText('发送服务：已装配')).toBeVisible({ timeout: 30000 });
    await screen.getByRole('button', '核查资格').tap();
    await expect(screen.getByText(/资格：已核查/)).toBeVisible();
    expect((await counts()).chatCount).toBe(initial.chatCount);
    await screen.getByRole('button', '明确授权').tap();
    await expect(screen.getByText(/授权：已授权/)).toBeVisible();
    expect((await counts()).chatCount).toBe(initial.chatCount);
    await screen.getByRole('button', '发送这条文字').tap();
    await expect(screen.getByText(/接口返回成功码，观众未核对/)).toBeVisible({ timeout: 15000 });
    expect((await counts()).chatCount).toBe(initial.chatCount + 1);
    await screen.getByRole('button', '发送这条文字').tap();
    expect((await counts()).chatCount).toBe(initial.chatCount + 1);
    // A later maintenance must use the current host lifecycle, not the
    // revision captured when the sender was first constructed.
    await screen.getByRole('button', '撤权').tap();
    await expect.poll(async () => (await browser.evaluate(async () => (await (await fetch('/api/dsh-livestream/public-chat')).json()).publicChat)).grant,
      { timeout: 15000 }).toBeNull();
    await expect.poll(async () => (await browser.evaluate(async () => (await (await fetch('/api/dsh-livestream/public-chat')).json()).publicChat)).hold,
      { timeout: 15000 }).toBe(false);
    const maintainedAgain = await browser.evaluate(async () => (await fetch('/api/dsh-livestream/public-chat', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'maintain' }),
    })).json());
    expect(maintainedAgain.ok).toBe(true);
    expect((await counts()).chatCount).toBe(initial.chatCount + 1);
    await screen.getByRole('button', '核查资格').tap();
    await expect(screen.getByText(/资格：已核查/)).toBeVisible();
    await screen.getByRole('button', '明确授权').tap();
    await expect(screen.getByText(/授权：已授权/)).toBeVisible();
    await screen.getByLabel('手动文字草稿').fill('fixture message');
    await screen.getByRole('button', '发送这条文字').tap();
    await expect(screen.getByText(/结果未知，需核对原请求/)).toBeVisible({ timeout: 20000 });
    const view = await browser.evaluate(async () => (await (await fetch('/api/dsh-livestream/public-chat')).json()).publicChat);
    const original = view.messages.find((message: { state: string }) => message.state === 'unknown');
    const screenshotEvidence: Array<{ state: string; path: string; viewport: { width: number; height: number } }> = [];
    const capture = async (state: string) => {
      await browser.evaluate(() => {
        const heading = document.querySelector('.dl-public-chat h4');
        if (!heading) throw new Error('original recovery heading unavailable');
        heading.scrollIntoView({ block: 'start', inline: 'nearest' });
      });
      const geometry = await assertPublicChatLayout(browser);
      const path = await app.screenshot(`${state}-${geometry.viewport.width}`);
      const png = readFileSync(path);
      expect(png.readUInt32BE(16)).toBe(geometry.viewport.width);
      expect(png.readUInt32BE(20)).toBe(geometry.viewport.height);
      screenshotEvidence.push({ state, path, viewport: geometry.viewport });
    };
    await capture('unknown');
    expect(view.hold).toBe(true);
    await screen.getByText('原请求完整绑定').tap();
    const binding = await browser.evaluate(() => {
      const detail = Array.from(document.querySelectorAll('details')).find((element) =>
        element.querySelector('summary')?.textContent === '原请求完整绑定');
      if (!detail) throw new Error('original binding details unavailable');
      return { text: detail.textContent ?? '', width: detail.clientWidth, scrollWidth: detail.scrollWidth };
    });
    expect(binding.text).toContain(original.grant.grantId);
    expect(binding.text).toContain(original.grant.helperProcessNonce);
    expect(binding.text).toContain(original.requestHash);
    expect(binding.scrollWidth).toBeLessThanOrEqual(binding.width);
    await assertPublicChatLayout(browser);
    await screen.getByLabel('备注或未看到').fill('没有看到');
    await screen.getByLabel('备注或未看到').press('Tab');
    await expect(screen.getByRole('button', '记录备注')).toBeFocused();
    await assertPublicChatLayout(browser);
    await browser.keyboard.press('Enter');
    await expect.poll(async () => (await browser.evaluate(async () => (await (await fetch('/api/dsh-livestream/public-chat')).json()).publicChat)).hold).toBe(true);
    await screen.getByLabel('观察到的 UID').fill(original.grant.principalUid);
    await screen.getByLabel('观察到的房间').fill(original.grant.roomId);
    await screen.getByLabel('观察到的内部房间').fill(original.grant.platformRoomId);
    await screen.getByLabel('观察到的内容摘要').fill(original.textDigest);
    await screen.getByLabel('观察时间（毫秒）').fill(String(Date.now()));
    await screen.getByRole('button', '记录正面观察').tap();
    await screen.getByRole('button', '按原请求核对').tap();
    await expect.poll(async () => {
      const next = await browser.evaluate(async () => (await (await fetch('/api/dsh-livestream/public-chat')).json()).publicChat);
      return next.messages.find((message: { requestId: string }) => message.requestId === original.requestId)?.recovery.state;
    }, { timeout: 15000 }).toBe('committed');
    const after = await browser.evaluate(async () => (await (await fetch('/api/dsh-livestream/public-chat')).json()).publicChat);
    expect(after.messages.find((message: { requestId: string }) => message.requestId === original.requestId).state).toBe('unknown');
    expect(after.hold).toBe(false);
    await capture('reconciled');
    const evidenceRoot = process.env.DSH_PUBLIC_CHAT_E2E_ROOT;
    if (!evidenceRoot) throw new Error('task-owned output required');
    writeFileSync(join(evidenceRoot, 'output', `formal-responsive-${process.pid}-${screenshotEvidence[0].viewport.width}.json`),
      JSON.stringify(screenshotEvidence, null, 2), { flag: 'wx' });
    expect((await counts()).chatCount).toBe(initial.chatCount + 2);
    // Restart off-air, disconnected and with no authentication material.
    // History must still be visible and an existing receipt explicitly adopted.
    await screen.getByLabel('启用公屏发送').uncheck();
    await screen.getByRole('button', '保存公屏设置').tap();
    await expect(screen.getByText('设置已保存；尚未核查或授权发送')).toBeVisible();
    await browser.evaluate(async () => { await fetch('/fixture-restart-host'); });
    await expect.poll(async () => (await browser.evaluate(async () => (await (await fetch('/api/dsh-livestream/public-chat')).json()).publicChat)).historyAvailable,
      { timeout: 30000 }).toBe(true);
    await expect(screen.getByText('历史：可读取')).toBeVisible();
    expect((await counts()).helperCount).toBe(0);
    const restarted = await browser.evaluate(async () => (await (await fetch('/api/dsh-livestream/public-chat')).json()).publicChat);
    expect(restarted.hold).toBe(true);
    expect(restarted.grant).toBeNull();
    expect(restarted.messages.find((message: { requestId: string }) => message.requestId === original.requestId).state).toBe('unknown');
    for (const control of restarted.controls) {
      if (!['committed', 'revoked', 'rejected'].includes(control.historicalState)) continue;
      const entry = browser.locator('div.dl-field').filter({ hasText: `控制 ${control.id}：` });
      await entry.getByRole('button', '按原控制编号核对或采用').tap();
    }
    await expect.poll(async () => (await browser.evaluate(async () => (await (await fetch('/api/dsh-livestream/public-chat')).json()).publicChat)).hold,
      { timeout: 15000 }).toBe(false);
    expect((await counts()).chatCount).toBe(initial.chatCount + 2);
    await screen.getByLabel('启用公屏发送').check();
    await screen.getByRole('button', '保存公屏设置').tap();
    await expect(screen.getByText('设置已保存；尚未核查或授权发送')).toBeVisible();
    await browser.evaluate(async () => { await fetch('/fixture-resume-live'); });
    await screen.getByRole('button', '维护发送材料').tap();
    await expect(screen.getByText('发送服务：已装配')).toBeVisible({ timeout: 30000 });
    const afterMaintain = await browser.evaluate(async () => (await (await fetch('/api/dsh-livestream/public-chat')).json()).publicChat);
    expect(afterMaintain.hold).toBe(false);
    expect(afterMaintain.grant).toBeNull();
    await screen.getByRole('button', '核查资格').tap();
    await expect(screen.getByText(/资格：已核查/)).toBeVisible();
    await screen.getByRole('button', '明确授权').tap();
    await expect(screen.getByText(/授权：已授权/)).toBeVisible();
    await screen.getByLabel('手动文字草稿').fill('新的普通文字');
    await screen.getByRole('button', '发送这条文字').tap();
    await expect.poll(async () => (await counts()).chatCount, { timeout: 15000 }).toBe(initial.chatCount + 3);
    const finalView = await browser.evaluate(async () => (await (await fetch('/api/dsh-livestream/public-chat')).json()).publicChat);
    expect(finalView.messages.find((message: { requestId: string }) => message.requestId === original.requestId).state).toBe('unknown');
    // A new unknown has no receipt. Losing its original holder cannot release it.
    await screen.getByLabel('手动文字草稿').fill('fixture message');
    await screen.getByRole('button', '发送这条文字').tap();
    await expect.poll(async () => (await counts()).chatCount, { timeout: 15000 }).toBe(initial.chatCount + 4);
    await expect.poll(async () => {
      const next = await browser.evaluate(async () => (await (await fetch('/api/dsh-livestream/public-chat')).json()).publicChat);
      return next.messages.filter((message: { state: string }) => message.state === 'unknown').length;
    }, { timeout: 15000 }).toBe(2);
    await screen.getByLabel('启用公屏发送').uncheck();
    await screen.getByRole('button', '保存公屏设置').tap();
    await expect(screen.getByText('设置已保存；尚未核查或授权发送')).toBeVisible();
    await browser.evaluate(async () => { await fetch('/fixture-restart-host'); });
    const lost = await browser.evaluate(async () => (await (await fetch('/api/dsh-livestream/public-chat')).json()).publicChat);
    const unresolved = lost.messages.find((message: { state: string; recovery: { state: string } }) =>
      message.state === 'unknown' && message.recovery.state !== 'committed');
    expect(unresolved).toBeTruthy();
    expect(lost.hold).toBe(true);
    const requestsBefore = (await counts()).senderRequests;
    const attempted = await browser.evaluate(async (requestId: string) => (await fetch('/api/dsh-livestream/public-chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'reconcile-message', requestId }),
    })).json(), unresolved.requestId);
    expect(attempted.ok).toBe(false);
    expect((await counts()).senderRequests).toBe(requestsBefore);
    expect((await counts()).chatCount).toBe(initial.chatCount + 4);
    expect((await browser.evaluate(async () => (await (await fetch('/api/dsh-livestream/public-chat')).json()).publicChat)).hold).toBe(true);
    await browser.evaluate(async () => { await fetch('/fixture-missing-history'); });
    const missing = await browser.evaluate(async () => (await (await fetch('/api/dsh-livestream/public-chat')).json()).publicChat);
    expect(missing.historyAvailable).toBe(false);
    expect(missing.hold).toBe(true);
    await browser.evaluate(async () => { await fetch('/fixture-corrupt-history'); });
    const corrupt = await browser.evaluate(async () => (await (await fetch('/api/dsh-livestream/public-chat')).json()).publicChat);
    expect(corrupt.historyAvailable).toBe(false);
    expect(corrupt.hold).toBe(true);
    await expect(screen.getByText('历史：不可用')).toBeVisible();
    expect((await counts()).helperCount).toBe(0);
    expect((await counts()).chatCount).toBe(initial.chatCount + 4);
  } finally {
    await browser.evaluate(async () => { await fetch('/fixture-finish'); });
    const root = process.env.DSH_PUBLIC_CHAT_E2E_ROOT;
    if (!root) throw new Error('task-owned output required');
    const resultPath = join(root, 'output', `e2e-cleanup-${new URL(app.baseUrl).port}.json`);
    await expect.poll(() => existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')).code : null,
      { timeout: 25000 }).toBe(0);
  }
});
