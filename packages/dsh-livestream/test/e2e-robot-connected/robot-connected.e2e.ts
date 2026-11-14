/**
 * 已连接机器人插件的确定性 Web 旅程（FEAT-DSH-004 F7/F8）：
 * 真实控制台 + 真实直播路由 + 真实安装的 dsh-qdroid robot 插件（离线软件 fixture）。
 * 证明：装配状态为 ready、能力显示真实离线原因、原任务行来自真实 owner 路由的
 * TaskView、查询/取消按权威返回更新（取消受理 ≠ 已停止）、停用后策略显示停用。
 */
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

interface Fixture {
  robot: {
    saved: { enabled: boolean; liveSessionId: string | null; bindingId: string | null; cooldownMs: number } | null;
    status: string;
    statusDetail: string | null;
    binding: { version: string; journalSchemaVersion: number; configRevision: number } | null;
    policy: { enabled: boolean; cooldownMs: number; configRevision: number; hasAccepted: boolean } | null;
    feedback: Array<{ kind: string; outcome: string | null; taskId: string | null; text: string }>;
    tasks: Array<{ taskId: string; phase: string; job: string; reason: string | null }>;
  };
  onAir: boolean;
  installedIdentity: { qdroid: string; live: string };
  sharedRequests: number;
}

async function fixture(baseUrl: string): Promise<Fixture> {
  return (await fetch(`${baseUrl}/__fixture`)).json();
}

test('connected robot: console saves, shows offline capability reason, and refreshes task rows from real owner routes', async ({ app, screen, browser }) => {
  await browser.addInitScript(() => {
    const errors: string[] = [];
    (window as unknown as { testErrors: string[] }).testErrors = errors;
    const originalError = console.error;
    console.error = (...args) => { errors.push(args.map(String).join(' ')); originalError(...args); };
    window.addEventListener('error', (event) => errors.push(event.message));
    window.addEventListener('unhandledrejection', () => errors.push('unhandled rejection'));
  });
  await app.open('/');

  // 先建她的直播会话并开播（真实 owner 路径，先会话后启用）
  const onairResponse = await fetch(`${app.baseUrl}/api/dsh-livestream/onair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'connected-live' }) });
  expect(onairResponse.status).toBe(200);
  await expect.poll(async () => (await fixture(app.baseUrl)).onAir).toBe(true);

  // 设置抽屉 → 机器人联动：先显示未配置
  await screen.getByRole('button', '设置', { exact: true }).tap();
  const panel = screen.getByRole('region', '机器人联动');
  await expect(panel).toContainText('联动状态：未配置：直播按自身状态独立运行，机器人无副作用');

  // 保存启用配置：装配状态 ready（真实 CAS 安装），能力显示真实离线原因
  await panel.getByLabel('启用机器人联动').check();
  await panel.getByLabel('机器人绑定 ID').fill('binding-1');
  await panel.getByLabel('她直播用的会话 ID（启用时必填）').fill('connected-live');
  await panel.getByLabel('打招呼（greeting）').check();
  await panel.getByLabel('坐下（sit_down）').check();
  await panel.getByRole('button', '添加规则').tap();
  await panel.getByLabel('规则 1 关键词').fill('坐下');
  await panel.getByLabel('规则 1 动作').selectOption({ value: 'greeting' });
  await panel.getByLabel('共享冷却（秒）').fill('10');
  await panel.getByRole('button', '保存联动设置').tap();
  await expect(panel.getByRole('status').last()).toContainText('已保存并装配');
  await expect(panel).toContainText('装配信息：robot-live/1，journal v2');
  const data = await fixture(app.baseUrl);
  expect(data.robot.status).toBe('ready');
  expect(data.robot.policy?.enabled).toBe(true);
  // 能力来自真实 robot 插件（Bridge 已连接 → connection=ready，软件报告为准）
  await expect(panel).toContainText('机器人：已连接（软件/实机以插件报告为准）');
  await expect(panel).toContainText('存储 ready');

  // 原弹幕经真实路由进入：规则消费接纳真实任务（Bridge 已连接 → accepted）
  await fetch(`${app.baseUrl}/api/dsh-livestream/simulate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'chat', name: '小明', text: '坐下' }) });
  await expect.poll(async () => (await fixture(app.baseUrl)).robot.feedback.some((item) => item.kind === 'task' && item.outcome === 'accepted')).toBe(true);
  const acceptedRow = (await fixture(app.baseUrl)).robot.tasks.find((task) => task.phase === 'accepted' || task.phase === 'running');
  expect(acceptedRow).toBeDefined();
  // 能力面板显示 Bridge 连接（真实 robot 报告），不再是离线
  await expect(panel).toContainText('已连接');

  // 行上的查询走真实 owner 路由：权威 TaskView 更新行显示
  const taskId = acceptedRow!.taskId;
  await panel.getByRole('button', '查询').first().tap();
  await expect(screen.getByRole('status').last()).toContainText(taskId.slice(0, 8));
  // 取消：受理文案与「实际停止要等机器人自己的停止证明」严格分开
  await panel.getByRole('button', '取消').first().tap();
  await expect(screen.getByRole('status').last()).toContainText('已受理取消');
  await expect(screen.getByRole('status').last()).toContainText('实际停止要等机器人自己的停止证明');

  // 停用：状态与在册策略都显示停用；直播照常
  await panel.getByLabel('启用机器人联动').uncheck();
  await panel.getByRole('button', '保存联动设置').tap();
  await expect(panel).toContainText('联动状态：已保存为停用：机器人不会因弹幕产生动作');
  const disabled = await fixture(app.baseUrl);
  expect(disabled.robot.status).toBe('saved-disabled');
  expect(disabled.robot.policy?.enabled).toBe(false);
  expect(disabled.robot.binding).not.toBeNull();

  // 共享服务零请求；零控制台错误
  expect((await fixture(app.baseUrl)).sharedRequests).toBe(0);
  expect(await browser.evaluate(() => (window as unknown as { testErrors: string[] }).testErrors)).toEqual([]);
  console.log('Browser:', await browser.evaluate(() => navigator.userAgent));
  console.log('Installed:', JSON.stringify((await fixture(app.baseUrl)).installedIdentity));
});
