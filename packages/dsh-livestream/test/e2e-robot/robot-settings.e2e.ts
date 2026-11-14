import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

interface Fixture {
  robot: {
    saved: { enabled: boolean; liveSessionId: string | null; bindingId: string | null; allowedActions: string[]; rules: Array<{ ruleId: string; text: string; action: string }>; cooldownMs: number } | null;
    savedInvalid: string | null;
    status: string;
    statusDetail: string | null;
    binding: { configRevision: number } | null;
    feedback: Array<{ text: string }>;
    tasks: Array<{ taskId: string }>;
  };
  savedRobotLive: Record<string, unknown> | null;
  sharedRequests: number;
}

async function fixture(baseUrl: string): Promise<Fixture> {
  return (await fetch(`${baseUrl}/__fixture`)).json();
}

test('saves, reads back, rolls back invalid robot settings, and shows unavailable reasons in the real console', async ({ app, screen, browser }) => {
  await browser.addInitScript(() => {
    const errors: string[] = [];
    (window as unknown as { testErrors: string[] }).testErrors = errors;
    const originalError = console.error;
    console.error = (...args) => { errors.push(args.map(String).join(' ')); originalError(...args); };
    window.addEventListener('error', (event) => errors.push(event.message));
    window.addEventListener('unhandledrejection', () => errors.push('unhandled rejection'));
  });
  await app.open('/');

  // 打开设置抽屉 → 机器人联动面板（未配置状态）
  await screen.getByRole('button', '设置', { exact: true }).tap();
  const panel = screen.getByRole('region', '机器人联动');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('联动状态：未配置：直播按自身状态独立运行，机器人无副作用');
  await expect(panel.getByText('还没有联动任务。')).toBeVisible();

  // 保存启用配置（同文字同动作的重复规则在保存时合并）
  await panel.getByLabel('启用机器人联动').check();
  await panel.getByLabel('机器人绑定 ID').fill('binding-1');
  await panel.getByLabel('她直播用的会话 ID（启用时必填）').fill('live-session-1');
  await panel.getByLabel('打招呼（greeting）').check();
  await panel.getByLabel('坐下（sit_down）').check();
  await panel.getByRole('button', '添加规则').tap();
  await panel.getByLabel('规则 1 关键词').fill('坐下');
  await panel.getByLabel('规则 1 动作').selectOption({ value: 'sit_down' });
  await panel.getByRole('button', '添加规则').tap();
  await panel.getByLabel('规则 2 关键词').fill('坐下');
  await panel.getByLabel('规则 2 动作').selectOption({ value: 'sit_down' });
  await panel.getByLabel('共享冷却（秒）').fill('10');
  await panel.getByRole('button', '保存联动设置').tap();
  // F7：保存与装配分开汇报——缺插件时不再宣称「已保存并装配」，给出真实原因
  await expect(panel.getByRole('status')).toContainText('已保存，但没有装配成功：机器人插件不可用');
  await expect(panel.getByText('读不到机器人插件能力（未安装或不可达）')).toBeVisible();
  let data = await fixture(app.baseUrl);
  expect(data.robot.saved).toMatchObject({ enabled: true, bindingId: 'binding-1', liveSessionId: 'live-session-1', cooldownMs: 10000 });
  // 同文字同动作合并为一条规则（保留首个规则 ID 作诊断）
  expect(data.robot.saved?.rules).toEqual([{ ruleId: 'rule-1', text: '坐下', action: 'sit_down' }]);
  expect(data.robot.saved?.allowedActions).toEqual(['greeting', 'sit_down']);
  // 装配失败原因（未安装插件）以可读文案出现在状态里；能力读取也给出可读原因
  expect(data.robot.statusDetail ?? '').toContain('机器人插件不可用');
  expect(data.robot.status).toBe('inactive');
  expect(data.robot.savedInvalid).toBeNull();
  await expect(panel.getByText('读不到机器人插件能力（未安装或不可达）')).toBeVisible();

  // 非法冷却：整体拒绝，不产生半套保存
  await panel.getByLabel('共享冷却（秒）').fill('0');
  await panel.getByRole('button', '保存联动设置').tap();
  await expect(panel.getByRole('alert').last()).toContainText('正整数秒');
  expect(((await fixture(app.baseUrl)).robot.saved)?.cooldownMs).toBe(10000);

  // 界面里的规则动作只提供白名单内的选项（趴下没勾选，就不出现）
  await panel.getByLabel('规则 1 动作').selectOption({ value: 'greeting' });
  // 服务端整体拒绝分支：规则动作不在白名单的配置走真实 settings 路由，400 且旧配置保持
  const invalid = await fetch(`${app.baseUrl}/__save-robot`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ robotLive: {
    version: 'robot-live/1', enabled: true, liveSessionId: 'live-session-1', bindingId: 'binding-1',
    allowedActions: ['greeting', 'sit_down'],
    rules: [{ ruleId: 'rule-1', text: '坐下', action: 'lie_down' }],
    cooldownMs: 10000,
  } }) });
  expect(invalid.status).toBe(200);
  const invalidPayload = (await invalid.json()) as { status: number; body: { error: string } };
  expect(invalidPayload.status).toBe(400);
  expect(invalidPayload.body.error).toContain('不在白名单内');
  data = await fixture(app.baseUrl);
  expect(data.robot.saved?.allowedActions).toEqual(['greeting', 'sit_down']);
  expect(data.robot.saved?.rules).toEqual([{ ruleId: 'rule-1', text: '坐下', action: 'sit_down' }]);

  // 关闭联动：保存值仍在，装配状态明确（先把冷却恢复成有效值）
  await panel.getByLabel('共享冷却（秒）').fill('10');
  await panel.getByLabel('启用机器人联动').uncheck();
  await panel.getByRole('button', '保存联动设置').tap();
  await expect(panel.getByRole('status')).toContainText('已保存（未启用');
  data = await fixture(app.baseUrl);
  expect(data.robot.saved?.enabled).toBe(false);

  // 键盘可达：焦点放在保存按钮上回车即保存
  await panel.getByLabel('启用机器人联动').check();
  await panel.getByRole('button', '保存联动设置').focus();
  await panel.getByRole('button', '保存联动设置').press('Enter');
  await expect(panel.getByRole('status')).toContainText('已保存，但没有装配成功');
  expect(((await fixture(app.baseUrl)).robot.saved)?.enabled).toBe(true);

  // 共享服务零请求（不触真实平台/OBS）
  expect((await fixture(app.baseUrl)).sharedRequests).toBe(0);
  // 无控制台错误（能力 404 是可读告警，不产生 console error）
  expect(await browser.evaluate(() => (window as unknown as { testErrors: string[] }).testErrors)).toEqual([]);
  console.log('Browser:', await browser.evaluate(() => navigator.userAgent));
});
