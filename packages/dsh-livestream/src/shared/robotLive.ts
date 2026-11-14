/**
 * 机器人联动配置（FEAT-DSH-004 / Host 合同第 10.1 节）的共享类型与校验。
 *
 * 配置字节归直播 owner 设置所有；journal 只保存接纳所需的快照。这里只做纯校验：
 * 缺少整个配置时规范化为「关闭、无绑定、无规则、默认 10000ms 冷却」；
 * 提供了配置则所有字段必填、拒绝未知字段，非法值不套默认（整体拒绝保存）。
 */

export const ROBOT_LIVE_VERSION = 'robot-live/1';
/** 与 dsh-qdroid robot 模块一致的默认共享冷却（毫秒）。 */
export const ROBOT_LIVE_DEFAULT_COOLDOWN_MS = 10000;
/** 规则条数上限：主人显式配置的关键词规则；超限整体拒绝，不静默截断。 */
export const ROBOT_LIVE_MAX_RULES = 32;

export const ROBOT_ACTIONS = ['greeting', 'sit_down', 'lie_down', 'stand_up'] as const;
export type RobotAction = (typeof ROBOT_ACTIONS)[number];

export interface RobotRule {
  ruleId: string;
  text: string;
  action: RobotAction;
}

export interface RobotLiveConfig {
  version: typeof ROBOT_LIVE_VERSION;
  enabled: boolean;
  liveSessionId: string | null;
  bindingId: string | null;
  allowedActions: RobotAction[];
  rules: RobotRule[];
  cooldownMs: number;
}

export type RobotLiveValidation =
  | { ok: true; config: RobotLiveConfig; mergedRuleIds: string[] }
  | { ok: false; reason: string };

/** Host 合同的 Id 约束（第 1 节）：字母开头，随后字母数字点下划线冒号连字符。 */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function isAction(value: unknown): value is RobotAction {
  return typeof value === 'string' && (ROBOT_ACTIONS as readonly string[]).includes(value);
}

/** Text500：非空、≤500 Unicode codepoints、不含 NUL、不含孤立代理对；不 trim、不改写原语义。 */
function isRuleText(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  // 按 Unicode 标量个数计数（UTF-16 长度会把代理对算成两个）
  if ([...value].length > 500) return false;
  if (value.includes('\0')) return false;
  // 孤立代理项不是合法标量序列：任一半边没有配对即拒绝
  const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  return !loneSurrogate.test(value);
}

export function defaultRobotLiveConfig(): RobotLiveConfig {
  return {
    version: ROBOT_LIVE_VERSION,
    enabled: false,
    liveSessionId: null,
    bindingId: null,
    allowedActions: [],
    rules: [],
    cooldownMs: ROBOT_LIVE_DEFAULT_COOLDOWN_MS,
  };
}

/**
 * 校验整份机器人配置：值全部有效才通过；任何非法值整体拒绝（reason 供 UI 显示）。
 * 与 Host 10.1 一致：白名单去重、ruleId 唯一、同文字同动作合并保留首个诊断 ID、
 * 同文字异动作拒绝、规则动作必须属于白名单、enabled 必须给出绑定与直播会话。
 */
export function normalizeRobotLiveConfig(raw: unknown): RobotLiveValidation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: '配置必须是对象' };
  const value = raw as Record<string, unknown>;
  const expected = ['version', 'enabled', 'liveSessionId', 'bindingId', 'allowedActions', 'rules', 'cooldownMs'];
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== [...expected].sort().join(',')) {
    return { ok: false, reason: '字段不完整或含有未知字段' };
  }
  if (value.version !== ROBOT_LIVE_VERSION) return { ok: false, reason: 'version 必须是 robot-live/1' };
  if (typeof value.enabled !== 'boolean') return { ok: false, reason: 'enabled 必须是布尔值' };
  const rawLiveSessionId = value.liveSessionId;
  const rawBindingId = value.bindingId;
  if (rawLiveSessionId !== null && !isId(rawLiveSessionId)) return { ok: false, reason: 'liveSessionId 必须是合法标识或 null' };
  if (rawBindingId !== null && !isId(rawBindingId)) return { ok: false, reason: 'bindingId 必须是合法标识或 null' };
  const liveSessionId: string | null = rawLiveSessionId;
  const bindingId: string | null = rawBindingId;
  if (!Array.isArray(value.allowedActions)) return { ok: false, reason: 'allowedActions 必须是数组' };
  const allowedActions: RobotAction[] = [];
  for (const item of value.allowedActions) {
    if (!isAction(item)) return { ok: false, reason: `动作 ${String(item)} 不是支持的动作` };
    if (!allowedActions.includes(item)) allowedActions.push(item);
  }
  if (!Array.isArray(value.rules)) return { ok: false, reason: 'rules 必须是数组' };
  if (value.rules.length > ROBOT_LIVE_MAX_RULES) return { ok: false, reason: `规则最多 ${ROBOT_LIVE_MAX_RULES} 条` };
  const rules: RobotRule[] = [];
  const mergedRuleIds: string[] = [];
  const byText = new Map<string, RobotAction>();
  const seenRuleIds = new Set<string>();
  for (const item of value.rules) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { ok: false, reason: '规则必须是对象' };
    const rule = item as Record<string, unknown>;
    if (Object.keys(rule).sort().join(',') !== 'action,ruleId,text') return { ok: false, reason: '规则字段必须是 ruleId、text、action' };
    if (!isId(rule.ruleId)) return { ok: false, reason: 'ruleId 必须是合法标识' };
    if (!isRuleText(rule.text)) return { ok: false, reason: '规则文字必须是非空、不超过 500 字且不含孤立代理项的原文' };
    if (!isAction(rule.action)) return { ok: false, reason: `规则动作 ${String(rule.action)} 不是支持的动作` };
    if (!allowedActions.includes(rule.action)) return { ok: false, reason: `规则动作 ${rule.action} 不在白名单内` };
    // 全部原始 ruleId（含将被合并掉的条目）都必须唯一：诊断 id 不允许隐形复用
    if (seenRuleIds.has(rule.ruleId)) return { ok: false, reason: `ruleId ${rule.ruleId} 重复` };
    seenRuleIds.add(rule.ruleId);
    const previous = byText.get(rule.text);
    if (previous !== undefined) {
      if (previous !== rule.action) return { ok: false, reason: `同一段文字配置了不同动作（${rule.ruleId}）` };
      // 同文字同动作：合并为一次选择，保留首个规则 ID 作诊断。
      mergedRuleIds.push(rule.ruleId);
      continue;
    }
    byText.set(rule.text, rule.action);
    rules.push({ ruleId: rule.ruleId, text: rule.text, action: rule.action });
  }
  const cooldown = value.cooldownMs;
  if (typeof cooldown !== 'number' || !Number.isSafeInteger(cooldown) || cooldown < 1) {
    return { ok: false, reason: 'cooldownMs 必须是正整数毫秒' };
  }
  if (value.enabled && (liveSessionId === null || bindingId === null)) {
    return { ok: false, reason: '启用联动必须先填写绑定 ID 和直播会话 ID' };
  }
  return {
    ok: true,
    config: {
      version: ROBOT_LIVE_VERSION,
      enabled: value.enabled,
      liveSessionId,
      bindingId,
      allowedActions,
      rules,
      cooldownMs: cooldown,
    },
    mergedRuleIds,
  };
}

/** 反馈文案：跳过原因（cooldown 与 busy 分开展示，不把冷却冒充忙）。 */
export function robotSkipReasonText(reason: unknown): string {
  switch (reason) {
    case 'cooldown': return '共享冷却中（不排队，稍后的新互动才可能再接纳）';
    case 'busy': return '机器人忙（正在执行其他动作）';
    case 'resource_unknown': return '机器人有未确认的资源占用，保守跳过';
    case 'job_unknown': return '有未确认的委派任务，保守跳过';
    default: return `原因：${String(reason ?? 'unknown')}`;
  }
}

/** 反馈文案：错误码。 */
export function robotErrorText(code: string | undefined): string {
  switch (code) {
    case 'source_unverified': return '来源未核实，未创建任务';
    case 'source_expired': return '原互动已超过来源期限，不能执行';
    case 'forbidden': return '权限不足';
    case 'binding_revoked': return '联动授权已撤销';
    case 'idempotency_conflict': return '同一原互动已绑定不同动作，按冲突拒绝';
    case 'storage_unavailable': return '机器人存储暂时不可用';
    case 'unsupported': return '当前环境不支持该能力';
    case 'incompatible_protocol': return '机器人插件版本不兼容';
    case 'not_found': return '没有这个任务（或不在可查询范围内）';
    case 'not_configured': return '机器人联动未装配';
    default: return `机器人错误：${String(code ?? 'unknown')}`;
  }
}
