/**
 * 机器人联动（FEAT-DSH-004）：把可选的 dsh-qdroid/robot 模块接到既有直播插件上。
 *
 * 职责边界：
 *  - 配置归直播 owner 设置（settings.robotLive，shared/robotLive.ts 校验）；本模块按 Host 合同
 *    第 10.1 节先读实际 policy revision 再 CAS 装配 binding，失败不猜 revision、不放宽权限。
 *  - 任何撤销（重装、停用、插件退出）都在第一个 await 之前同步 dispose 原 rule/binding，
 *    并按 applyGeneration 隔离迟到结果；Show 生命周期真失效（下播收尾/真正下播/会话被替换/
 *    断订阅）经 invalidateRobotLiveForShow 在失效动作的同一同步段撤销原授权，且提交/绑定都在
 *    await 返回后的同一同步段复核代次与句柄——迟到 receipt/ACK 不产生新 job/send；
 *    真失效后必须由 owner 重新装配，不会自动复活旧来源或补做被跳过的请求。
 *  - 原事件在 show.observe 的可信接收处登记 receipt（先于注意力/话题聚合）；来源绑定只认
 *    hub 写入的可信进入元数据（恰好一条、实时进入、原始平台 id）；规则只消费 chat 原文，
 *    非 chat 互动 chatText 恒为 null 且不触发规则。
 *  - RobotService/journal 是接纳、冷却、一次预算和真实结果的唯一权威；这里不复制执行机制，
 *    不 bundle 第二份 robot 模块（dsh-qdroid/robot 用动态 import，由构建保持 external，
 *    与宿主里安装的同一模块实例共享 WeakMap 状态）。
 *  - 缺插件、停用、离线都不破坏直播：所有 robot 调用都有界并吞错记诊断，直播照常。
 */

import type { LiveEvent } from '../core/live';
import { liveIngress, pickCompositionOf, type Topic } from '../core/attention/topics';
import { normalizeRobotLiveConfig, robotErrorText, robotSkipReasonText, type RobotAction, type RobotLiveConfig, type RobotRule } from '../shared/robotLive';
import { hooks, settings, show } from './runtime';

const skipReasonText = robotSkipReasonText;
const errorText = robotErrorText;
export { errorText, skipReasonText };

/** dsh-qdroid/robot 导出的结构化视图（动态加载，不能静态 import 类型的包）。 */
interface RobotInteractionInput {
  platformNamespace: string;
  accountRef: string;
  streamEpoch: string;
  eventId: string;
  interactionKey: string;
  event: { kind: string; chatText: string | null };
}

/** receipt 是 robot 模块的私有冻结对象；这里只依赖其中合同化的只读字段。 */
interface RobotReceipt {
  receiptId: string;
  sourceKey: string;
  receivedAtHostMs: number | null;
  sourceDispatchMs: number | null;
  capturedConfigRevision: number | null;
  taskId: string | null;
}

interface RobotPolicySnapshot {
  configRevision: number;
  enabled: boolean;
  cooldownMs: number;
  authoritySha: string;
  hasAccepted: boolean;
}

interface RobotBindingHandle {
  readonly description: Readonly<{ version: string; journalSchemaVersion: number; configRevision: number }>;
  capture(input: RobotInteractionInput): Promise<unknown>;
  dispose(): void;
}

interface RobotRuleHandle {
  evaluate(receipt: unknown): Promise<unknown>;
  get(taskId: string): Promise<unknown>;
  cancel(taskId: string): unknown;
  dispose(): void;
}

interface RobotModule {
  attachRobotLiveBinding(ctx: unknown, config: unknown, expectedRevision: number): Promise<RobotBindingHandle>;
  readRobotLivePolicy(ctx: unknown, bindingId: string): Promise<RobotPolicySnapshot | null>;
  attachRobotLiveRule(ctx: unknown, handle: RobotBindingHandle): RobotRuleHandle;
  bindRobotLiveMessage(handle: RobotBindingHandle, agent: object, message: { id: string }, receipt: unknown): void;
  attachRobotLiveCaller(
    ctx: unknown,
    agent: object,
    allowedActions: readonly string[],
    currentInteraction: (exec: unknown) => unknown,
  ): () => void;
}

/** LiveFeedback.result 的封闭联合（Host 10.3）；只读消费，不构造 TaskView。 */
export interface RobotFeedbackView {
  kind: 'selection' | 'task' | 'error';
  code: string | null;
  outcome: string | null;
  taskId: string | null;
  text: string;
  at: number;
}

interface BoundInteraction {
  platformNamespace: string;
  accountRef: string;
  streamEpoch: string;
  eventId: string;
  interactionKey: string;
  receivedAtHostMs: number | null;
}

/** 一次 capture 的完整上下文：身份来自 hub 可信进入元数据，授权随捕获代次固定。 */
interface CapturedSource {
  /** hub 记录的平台原始 id（不是展示 id） */
  rawId: string;
  kind: LiveEvent['kind'];
  /** capture 时的授权代次：reinstall/offair/会话失效都会推进 */
  generation: number;
  interaction: BoundInteraction;
  /** 规则消费只对 chat；其余 kind 恒 null 且不触发规则 */
  chatText: string | null;
  receipt: Promise<RobotReceipt | null>;
}

/** robot 工具注册后的 definition 身份（供会话限制名单按身份核对，不按名称放行）。 */
const robotToolDefinitions = new WeakMap<object, Map<string, unknown>>();
/**
 * Agent → 已装配 caller 的记录：dispose 函数与装配时的授权代次。
 * 代次推进（重装/停用）后允许同一 Agent 安全重建 caller（先 dispose 旧装配再装新）。
 */
const attachedCallers = new WeakMap<object, { generation: number; dispose: () => void }>();
/** 已知会话的实际 Agent 与其 scope ctx（agent/created 时登记；启用配置时用于既有会话补装）。 */
const sessionAgents = new Map<string, { agent: any; agentCtx: any }>();
/** Agent → 本次绑定的原互动（currentInteraction 一致性复核用；turn↔消息由 robot 注册表裁决）。 */
const boundInteractions = new WeakMap<object, BoundInteraction>();

const ROBOT_TOOL_NAMES = ['robot_task_capabilities', 'robot_task_submit', 'robot_task_get', 'robot_task_cancel'] as const;
/** 原事件来源登记的有界容量；超限丢最旧，不阻塞直播。 */
const SOURCE_BUDGET = 200;
/** 反馈与任务记录的有界容量（owner 控制台历史）。 */
const FEEDBACK_BUDGET = 50;
/** 会话 Agent 登记的有界容量。 */
const SESSION_AGENT_BUDGET = 32;

let hostContext: unknown = null;
let loadedModule: RobotModule | null = null;
let moduleLoadError: string | null = null;
let bindingHandle: RobotBindingHandle | null = null;
let ruleHandle: RobotRuleHandle | null = null;
let currentConfig: RobotLiveConfig | null = null;
let currentPolicy: RobotPolicySnapshot | null = null;
/** 当前已安装目标（本仓 journal 里的 bindingId）；停用/清空时用它读真实 revision。 */
let installedTarget: string | null = null;
let applyGeneration = 0;
let lastStatusNote: string | null = null;
let noRuleMatches = 0;
let ambiguousAggregations = 0;
let sourceBudget = 0;
const feedback: RobotFeedbackView[] = [];
const taskRecords = new Map<string, { taskId: string; sourceKind: string; phase: string; job: string; reason: string | null; cancelRequested: boolean; updatedAt: number }>();
/** rawId → capture（按身份取来源；消费即移除，同文新事件不会绑到旧来源）。 */
const sourcesById = new Map<string, CapturedSource>();
/** 限制名单同步回调（agent 插件注册；撤销收缩与启用补装后都要刷新）。 */
let restrictionSync: (() => void) | null = null;

/** 测试/宿主装配 seam：runtime.robotBridge.onOriginalEvent 指到这里。 */
export function robotOriginalEvent(event: LiveEvent): void {
  try {
    captureOriginalEvent(event);
  } catch (cause) {
    hooks.log('warn', `机器人原事件登记失败：${(cause as Error).message}`);
  }
}

function status(): { state: string; detail: string | null } {
  const savedRaw = settings.robotLive;
  if (savedRaw !== undefined) {
    const validation = normalizeRobotLiveConfig(savedRaw);
    if (!validation.ok) return { state: 'invalid-config', detail: validation.reason };
  }
  if (!currentConfig) return { state: savedRaw === undefined ? 'not-configured' : 'inactive', detail: lastStatusNote };
  if (!bindingHandle) return { state: 'inactive', detail: lastStatusNote };
  return { state: currentConfig.enabled ? 'ready' : 'saved-disabled', detail: lastStatusNote };
}

/** 控制台/状态视图：保存值、有效装配与最近反馈/任务（不含凭据与内部句柄）。 */
export function robotLiveView(): {
  saved: RobotLiveConfig | null;
  savedInvalid: string | null;
  status: string;
  statusDetail: string | null;
  binding: { version: string; journalSchemaVersion: number; configRevision: number } | null;
  policy: { enabled: boolean; cooldownMs: number; configRevision: number; hasAccepted: boolean } | null;
  boundSession: string | null;
  noRuleMatches: number;
  ambiguousAggregations: number;
  feedback: RobotFeedbackView[];
  tasks: Array<{ taskId: string; sourceKind: string; phase: string; job: string; reason: string | null; cancelRequested: boolean; updatedAt: number }>;
} {
  const savedRaw = settings.robotLive;
  const savedValidation = savedRaw === undefined ? null : normalizeRobotLiveConfig(savedRaw);
  const current = status();
  return {
    saved: savedValidation?.ok ? savedValidation.config : null,
    savedInvalid: savedValidation && !savedValidation.ok ? savedValidation.reason : null,
    status: current.state,
    statusDetail: current.detail,
    binding: bindingHandle ? { ...bindingHandle.description } : null,
    policy: currentPolicy ? { ...currentPolicy } : null,
    boundSession: currentConfig?.liveSessionId ?? null,
    noRuleMatches,
    ambiguousAggregations,
    feedback: [...feedback],
    tasks: [...taskRecords.values()].sort((a, b) => b.updatedAt - a.updatedAt),
  };
}

/**
 * 装配：撤销旧授权（同步、在任何 await 之前），再读 robot 模块与实际 policy revision、
 * CAS 安装新 binding/rule。所有 await 之后按 generation 复核，迟到结果不再影响现状。
 */
export async function applyRobotLiveSettings(ctx?: unknown): Promise<void> {
  if (ctx !== undefined) hostContext = ctx;
  // F1/F6：先按上一代授权同步撤销（dispose 原 rule/binding、清来源与工具身份），
  // 再进入任何 await；旧 caller 的宿主 grant 随 binding.dispose 一并失效。
  const generation = ++applyGeneration;
  revokeAll(null);

  const savedRaw = settings.robotLive;
  const validation = savedRaw === undefined ? { ok: true as const, config: null } : normalizeRobotLiveConfig(savedRaw);
  if (!validation.ok) {
    lastStatusNote = `已保存的配置无效：${validation.reason}`;
    return;
  }
  const config = validation.config;
  if (!hostContext) return;
  if (!config) return;

  // F6：停用（bindingId 为空）时不是「无 policy」——用已安装目标读真实 revision，
  // 以停用配置覆盖原目标，撤销其全部提交资格；从不清零、不猜 revision。
  const targetForPolicy = config.bindingId ?? (config.enabled ? null : installedTarget);
  const module = await loadRobotModule();
  if (generation !== applyGeneration) return;
  if (!module) {
    lastStatusNote = moduleLoadError
      ? `机器人插件不可用（${moduleLoadError}）：未安装 dsh-qdroid 或版本不兼容`
      : '机器人插件不可用：未安装 dsh-qdroid';
    return;
  }
  try {
    const policy = targetForPolicy ? await module.readRobotLivePolicy(hostContext, targetForPolicy) : null;
    if (generation !== applyGeneration) return;
    const expectedRevision = policy ? policy.configRevision : 0;
    const handle = await module.attachRobotLiveBinding(hostContext, config, expectedRevision);
    if (generation !== applyGeneration) {
      // 迟到完成：已不是当前代次，立即丢弃，不影响新装配。
      handle.dispose();
      return;
    }
    // F7：先核版本握手（robot-live/1 + journal schema 2）再消费；不兼容零动作。
    if (handle.description.version !== 'robot-live/1' || handle.description.journalSchemaVersion !== 2) {
      handle.dispose();
      lastStatusNote = `机器人插件版本不兼容（${handle.description.version}/journal v${handle.description.journalSchemaVersion}）：需要 robot-live/1 与 journal schema 2`;
      hooks.log('warn', `机器人插件版本不兼容：${JSON.stringify(handle.description)}`);
      return;
    }
    const rule = module.attachRobotLiveRule(hostContext, handle);
    bindingHandle = handle;
    ruleHandle = rule;
    currentConfig = config;
    installedTarget = targetForPolicy ?? config.bindingId;
    moduleLoadError = null;
    lastStatusNote = null;
    // F7：安装后再读一次真实策略（装配前读到的 revision 是 CAS 输入，不是结果）。
    let installedPolicy: RobotPolicySnapshot | null;
    try {
      installedPolicy = installedTarget ? await module.readRobotLivePolicy(hostContext, installedTarget) : null;
    } catch {
      installedPolicy = null;
    }
    if (generation !== applyGeneration) {
      // 这一代句柄已由后续装配同步撤销；迟到读取不能修改新一代的句柄或策略。
      return;
    }
    currentPolicy = installedPolicy;
    hooks.log('info', `机器人联动已装配（revision ${handle.description.configRevision}，${config.enabled ? '启用' : '已保存停用'}）`);
    // F3：既有会话补装 caller（owner 先建会话、后启用联动的正常路径）。
    activateRobotForExistingSession(generation);
  } catch (cause) {
    // 只有当前代次的失败才改变状态显示；迟到的失败不影响更新的装配。
    if (generation !== applyGeneration) return;
    bindingHandle = null;
    ruleHandle = null;
    currentConfig = null;
    const code = cause instanceof Error ? cause.message : 'internal_unknown';
    lastStatusNote = code === 'idempotency_conflict'
      ? '装配时配置版本已变化（revision 冲突）：请重新保存一次联动设置'
      : `机器人联动装配失败（${errorText(code)}）`;
    hooks.log('warn', `机器人联动装配失败（${code}）`);
  }
}

/** 插件退出/停用：同步撤销本侧句柄；robot host 侧的 grants 随 binding.dispose 一并撤销。 */
export function disposeRobotLive(): void {
  applyGeneration += 1;
  revokeAll(null);
}

/**
 * Show 生命周期真失效（FEAT-DSH-004 F2：ending/offair/session-retired/connection-lost）：
 * show 在失效动作的同一同步段调用这里——先于任何异步等待 dispose 原 Host grant（真实
 * rule.dispose + binding.dispose，Q 侧 grants 随之撤销）、清来源登记、推进授权代次，
 * 使在途的 receipt/装配/ACK 全部被隔离：迟到的 receipt 不再提交 evaluate/bind，
 * Q 侧拒绝已撤销句柄上的新 capture；不会产生新 job/send，unknown/hold 按原语义保留。
 * 真失效后动作资格不会自动复活——回到直播也必须由 owner 重新装配（重存联动配置）。
 */
export function invalidateRobotLiveForShow(detail: string): void {
  // 尚在等待装配结果时也必须使该代次失效，不能等句柄发布后才撤权（R1 种子）。
  applyGeneration += 1;
  if (!bindingHandle && !ruleHandle) return;
  revokeAll(`场次失效：${detail}`);
}

/** 限制名单同步回调（agent 插件注册；撤销收缩与启用补装后都调用它刷新）。 */
export function setRobotRestrictionSync(sync: (() => void) | null): void {
  restrictionSync = sync;
}

/** 当前 agent 已登记的 robot 工具 definition（身份核对用；没有装配时为空）。 */
export function robotToolDefinitionsFor(agent: object): Map<string, unknown> | null {
  return robotToolDefinitions.get(agent) ?? null;
}

async function loadRobotModule(): Promise<RobotModule | null> {
  if (loadedModule) return loadedModule;
  if (moduleLoadError) return null;
  try {
    // external 导入：运行时解析宿主里安装的 dsh-qdroid，与 robot 插件共享同一模块实例。
    const imported = (await import('dsh-qdroid/robot')) as RobotModule;
    if (typeof imported?.attachRobotLiveBinding !== 'function' || typeof imported?.attachRobotLiveRule !== 'function') {
      throw new Error('incompatible_robot_module');
    }
    loadedModule = imported;
    return imported;
  } catch (cause) {
    moduleLoadError = cause instanceof Error ? cause.message : 'robot_module_unavailable';
    return null;
  }
}

/** 测试专用：注入替身 robot 模块（生产不得调用）。 */
export function setRobotModuleOverrideForTest(module: RobotModule | null): void {
  loadedModule = module;
  moduleLoadError = module ? null : 'robot_module_unavailable';
}

/**
 * F1：同步撤销——真实 dispose 原 rule 与 binding（幂等），清来源登记与授权代次推进，
 * 再触发限制名单收缩。不等待、不丢 dispose。
 */
function revokeAll(detail: string | null): void {
  const rule = ruleHandle;
  const binding = bindingHandle;
  ruleHandle = null;
  bindingHandle = null;
  currentConfig = null;
  currentPolicy = null;
  sourcesById.clear();
  sourceBudget = 0;
  if (rule) {
    try {
      rule.dispose();
    } catch (cause) {
      hooks.log('warn', `机器人规则句柄撤销失败：${(cause as Error).message}`);
    }
  }
  if (binding) {
    try {
      binding.dispose();
    } catch (cause) {
      hooks.log('warn', `机器人绑定撤销失败：${(cause as Error).message}`);
    }
  }
  if ((rule || binding) && restrictionSync) {
    try {
      restrictionSync();
    } catch (cause) {
      hooks.log('warn', `机器人联动撤销回调失败：${(cause as Error).message}`);
    }
  }
  if (detail) hooks.log('warn', `机器人联动已撤销：${detail}`);
}

/**
 * F2 的同步失效基准：只在绑定会话开播、未进入下播收尾时开放。
 * 每个 effect 提交前在「await 返回后的同一同步段」重新执行本检查并比对捕获代次。
 */
function liveGateOpen(): boolean {
  return !!bindingHandle && !!currentConfig?.enabled && !show.isEnding && show.isOnAir && !!show.currentSession
    && show.currentSession === currentConfig.liveSessionId;
}

function accountRef(): string {
  const room = show.status().live.room;
  const id = room?.realRoomId ?? room?.roomId;
  return id !== undefined && id !== null ? String(id) : 'unknown-room';
}

function captureReceipt(source: {
  platformNamespace: string;
  accountRef: string;
  streamEpoch: string;
  eventId: string;
  interactionKey: string;
  chatText: string | null;
  kind: string;
}): { receipt: Promise<RobotReceipt | null>; interaction: BoundInteraction } {
  const handle = bindingHandle!;
  const input: RobotInteractionInput = {
    platformNamespace: source.platformNamespace,
    accountRef: source.accountRef,
    streamEpoch: source.streamEpoch,
    eventId: source.eventId,
    interactionKey: source.interactionKey,
    event: { kind: source.kind, chatText: source.chatText },
  };
  const receipt = handle.capture(input).then((value) => value as RobotReceipt).catch(() => null);
  const interaction: BoundInteraction = {
    platformNamespace: source.platformNamespace,
    accountRef: source.accountRef,
    streamEpoch: source.streamEpoch,
    eventId: source.eventId,
    interactionKey: source.interactionKey,
    receivedAtHostMs: null,
  };
  void receipt.then((value) => {
    interaction.receivedAtHostMs = value?.receivedAtHostMs ?? null;
  });
  return { receipt, interaction };
}

function trackSource(source: CapturedSource): void {
  sourceBudget += 1;
  while (sourceBudget > SOURCE_BUDGET) {
    const oldest = sourcesById.keys().next();
    if (!oldest.done) {
      sourcesById.delete(oldest.value);
      sourceBudget -= 1;
      continue;
    }
    break;
  }
}

function captureOriginalEvent(event: LiveEvent): void {
  if (!bindingHandle || !currentConfig) return;
  // 可证明的原互动：chat/superchat/gift/membership。follow/enter 等不产生动作来源。
  if (event.kind !== 'chat' && event.kind !== 'superchat' && event.kind !== 'gift' && event.kind !== 'membership') return;
  if (!liveGateOpen()) return;
  // 主播自己的弹幕按 owner 话题处理，不产生观众动作来源。
  if (event.user.id && event.user.id === show.status().live.room?.anchorId) return;
  // F4/新鲜度：只接受带受信进入证明的事件（当前唯一来源是受控离线注入；普通平台回调与
  // 重连补发 fail closed，真实平台实时证明归 T03）；原始平台 id 作为来源身份，展示 id 不参与。
  const ingress = liveIngress(event);
  if (!ingress?.live) return;
  const rawId = ingress.rawId;
  if (sourcesById.has(rawId)) return; // 同一原事件（连击/重复投递）只登记一次
  // 场次身份缺失（如续播存档没有 robotEpoch）：机器人来源保持拒绝，直播照常。
  const streamEpoch = show.streamEpochId;
  if (!streamEpoch) return;
  const chatText = event.kind === 'chat' ? event.text : null;
  const { receipt, interaction } = captureReceipt({
    platformNamespace: event.platform,
    accountRef: accountRef(),
    streamEpoch,
    eventId: rawId,
    interactionKey: `${event.kind}:${rawId}`,
    chatText,
    kind: event.kind,
  });
  const source: CapturedSource = {
    rawId,
    kind: event.kind,
    generation: applyGeneration,
    interaction,
    chatText,
    receipt,
  };
  sourcesById.set(rawId, source);
  trackSource(source);
  // 规则在原事件处消费，且只对 chat 字面匹配；非 chat 互动只登记来源（供她的轮次绑定）。
  if (event.kind === 'chat') void evaluateRuleAtReception(source, receipt);
}

/**
 * 规则在原事件处消费：字面全等命中才提交；receipt 等待返回后的同一同步段复核
 * 代次/句柄/直播状态——撤销、下播、会话失效之后，迟到的 receipt 不再提交。
 */
async function evaluateRuleAtReception(source: CapturedSource, receipt: Promise<RobotReceipt | null>): Promise<void> {
  const rule = ruleHandle;
  const config = currentConfig;
  if (!rule || !config) return;
  const action = matchRule(config.rules, source.chatText ?? '');
  if (!action) {
    noRuleMatches += 1;
    return;
  }
  const receiptValue = await receipt;
  if (!receiptValue) return;
  if (generationStale(source) || ruleHandle !== rule) return;
  if (!liveGateOpen()) return;
  try {
    const outcome = await rule.evaluate(receiptValue);
    if (generationStale(source)) return;
    recordFeedback(outcome);
  } catch (cause) {
    if (generationStale(source)) return;
    recordErrorFeedback(cause instanceof Error ? cause.message : 'internal_unknown');
  }
}

/** 捕获代次失效：重装/停用/退出（applyGeneration 推进）或会话失效（show 代次推进）。 */
function generationStale(source: CapturedSource): boolean {
  return source.generation !== applyGeneration || !bindingHandle || !ruleHandle;
}

function matchRule(rules: RobotRule[], text: string): RobotAction | null {
  for (const rule of rules) {
    if (rule.text === text) return rule.action;
  }
  return null;
}

/**
 * Agent 路径：话题 → 按组成身份证明「恰好一条实时原事件」才给绑定；
 * 多条合并、缺进入标记、未知/伪造身份一律不给来源（机器人侧返回 source_unverified）。
 */
export interface RobotPushSource {
  bind(agent: object, message: { id: string }): Promise<void>;
}

export function robotPushSource(topic: Topic): RobotPushSource | null {
  if (!bindingHandle || !loadedModule || !currentConfig?.enabled) return null;
  if (!liveGateOpen()) return null;
  const source = resolveTopicSource(topic);
  if (!source) return null;
  sourcesById.delete(source.rawId);
  sourceBudget -= 1;
  return bindOnce(source);
}

/** 按话题组成解析唯一原事件；组成必须来自 attention 的私有登记，任何聚合/缺标记/伪造都拒绝。 */
function resolveTopicSource(topic: Topic): CapturedSource | null {
  if (topic.kind === 'superchat') {
    return singleLiveEventSource([topic.event]);
  }
  if (topic.kind === 'gifts' || topic.kind === 'thanks') {
    return singleLiveEventSource(topic.events);
  }
  if (topic.kind !== 'chat' || topic.picks.length !== 1) return null;
  const pick = topic.picks[0];
  // F4/组成身份：公开 sources 数组只是展示 metadata（{id,live} 可复制，不构成凭据）；
  // 组成以 attention 的私有登记为准——伪造 pick、复制的事件对象或同文重建读不到登记，不给来源。
  const composition = pickCompositionOf(pick);
  if (!composition) return null;
  if (composition.length !== 1) {
    // 一次 ChatPick 聚合了多条原弹幕：不是单一原输入，不给来源选择权。
    ambiguousAggregations += 1;
    return null;
  }
  return sourceForOriginalEvent(composition[0]);
}

/**
 * 原事件对象必须带受信进入证明、且身份仍在当次登记中才可作为来源：
 * 事件对象引用不可跨进程/序列化复制，复制的公开字段（uid/文字/id）不构成身份证明。
 */
function sourceForOriginalEvent(event: LiveEvent): CapturedSource | null {
  const ingress = liveIngress(event);
  if (!ingress?.live) return null;
  return sourcesById.get(ingress.rawId) ?? null;
}

/** 事件集合必须恰好一条、且带受信进入证明才可作为来源。 */
function singleLiveEventSource(events: LiveEvent[]): CapturedSource | null {
  if (events.length !== 1) return null;
  return sourceForOriginalEvent(events[0]);
}

function bindOnce(source: CapturedSource): RobotPushSource {
  return {
    bind: async (agent, message) => {
      const receiptValue = await source.receipt;
      const module = loadedModule;
      const handle = bindingHandle;
      // await 返回后的同一同步段复核：代次、句柄、直播状态——撤销/下播后迟到的
      // receipt 既不绑定也不产生后续。
      if (!receiptValue || !module || !handle) return;
      if (generationStale(source) || bindingHandle !== handle) return;
      if (!liveGateOpen()) return;
      try {
        module.bindRobotLiveMessage(handle, agent, message, receiptValue);
        boundInteractions.set(agent, { ...source.interaction, receivedAtHostMs: receiptValue.receivedAtHostMs });
      } catch (cause) {
        hooks.log('warn', `机器人消息绑定未生效：${(cause as Error).message}`);
      }
    },
  };
}

/** currentInteraction 一致性复核：只回本进程登记过的原互动；turn↔消息由 robot 注册表裁决。 */
function currentInteractionFor(exec: unknown): unknown {
  const agent = (exec as { agent?: object } | null)?.agent;
  if (!agent) return null;
  const interaction = boundInteractions.get(agent);
  return interaction ?? null;
}

/**
 * agent/created 时登记实际 Agent 与 scope ctx（无论是否配置机器人）：这是后续
 * 「既有会话首次启用/重配」补装 caller 的唯一可信来源。
 */
export function registerRobotSessionAgent(sessionId: string, agent: any, agentCtx: any): void {
  if (!sessionId || !agent) return;
  sessionAgents.set(sessionId, { agent, agentCtx });
  while (sessionAgents.size > SESSION_AGENT_BUDGET) {
    const oldest = sessionAgents.keys().next();
    if (oldest.done) break;
    // 不删当前绑定会话的登记
    if (oldest.value === currentConfig?.liveSessionId) {
      const keys = [...sessionAgents.keys()];
      const nextOldest = keys.find((key) => key !== currentConfig?.liveSessionId);
      if (!nextOldest) break;
      sessionAgents.delete(nextOldest);
      continue;
    }
    sessionAgents.delete(oldest.value);
  }
}

/**
 * F3：配置装配成功后，把 caller 补装到既有绑定会话的实际 Agent 上（先同步 dispose
 * 本 Agent 的旧装配，再按新代次重建工具与身份），随后触发限制名单同步。
 */
function activateRobotForExistingSession(generation: number): void {
  if (!bindingHandle || !loadedModule || !currentConfig?.enabled) return;
  const sessionId = currentConfig.liveSessionId;
  const known = sessionId ? sessionAgents.get(sessionId) : undefined;
  if (!known) return;
  attachCallerToAgent(known.agentCtx, known.agent, generation);
}

/**
 * 在 Agent 自己的 scope 装配 robot caller（真实工具 + claimed 监听），并按当前解析链
 * 记录 robot 工具 definition 对象，供会话限制名单按身份核对。装配失败不破坏会话创建。
 * 返回 definition 映射；未配置/不属于绑定会话时返回空 Map。
 */
export function attachRobotForSession(
  agentCtx: {
    tools?: { layers?: unknown };
  } & Record<string, any>,
  agent: object,
  sessionId: string,
  chainReader: (agentCtx: unknown, agent: unknown) => Map<string, any> | null,
): Map<string, unknown> {
  const definitions = new Map<string, unknown>();
  if (!agent) return definitions;
  // F3：无论配置与否，登记实际会话 Agent（既有会话后续启用依赖这份登记）。
  registerRobotSessionAgent(sessionId, agent, agentCtx);
  if (!bindingHandle || !loadedModule || !currentConfig?.enabled) return definitions;
  if (sessionId !== currentConfig.liveSessionId) return definitions;
  const attached = attachCallerToAgent(agentCtx, agent, applyGeneration);
  if (attached) {
    const chain = chainReader(agentCtx, agent);
    if (chain) {
      for (const name of ROBOT_TOOL_NAMES) {
        const registration = chain.get(name);
        if (registration && registration.definition) definitions.set(name, registration.definition);
      }
    }
  }
  return definitions;
}

/**
 * 同一 Agent 的安全（重）装配：按代次判定——代次未变且已装配则跳过；
 * 否则先同步 dispose 旧 caller（撤销旧 grant、卸下旧工具注册），再装新、记新身份。
 */
function attachCallerToAgent(agentCtx: any, agent: object, generation: number): boolean {
  const previous = attachedCallers.get(agent);
  if (previous && previous.generation === generation) return false;
  if (previous) {
    try {
      previous.dispose();
    } catch (cause) {
      hooks.log('warn', `机器人旧 caller 撤销失败：${(cause as Error).message}`);
    }
    attachedCallers.delete(agent);
  }
  try {
    const dispose = loadedModule!.attachRobotLiveCaller(agentCtx, agent, currentConfig!.allowedActions, (exec) => currentInteractionFor(exec));
    attachedCallers.set(agent, { generation, dispose });
    watchAgentTaskResults(agent);
    // 从当前解析链记录本代次的 robot 工具 definition 身份（同名 global 不借名获准）。
    const chain = readChain(agentCtx, agent);
    if (chain) {
      const definitions = new Map<string, unknown>();
      for (const name of ROBOT_TOOL_NAMES) {
        const registration = chain.get(name);
        if (registration && registration.definition) definitions.set(name, registration.definition);
      }
      if (definitions.size) robotToolDefinitions.set(agent, definitions);
      else robotToolDefinitions.delete(agent);
    }
    // 限制名单按新身份原子刷新（fail-closed 由 agent 插件语义保证）。
    try {
      restrictionSync?.();
    } catch (cause) {
      hooks.log('warn', `机器人联动限制刷新失败：${(cause as Error).message}`);
    }
    return true;
  } catch (cause) {
    hooks.log('warn', `机器人联动装配失败：${(cause as Error).message}`);
    return false;
  }
}

function readChain(agentCtx: any, agent: any): Map<string, any> | null {
  try {
    const layers = agentCtx?.tools?.layers;
    if (!layers || typeof layers.chainLayers !== 'function' || !layers.global?.tools) return null;
    const merged = new Map<string, any>();
    for (const [name, registration] of layers.global.tools.entries()) merged.set(name, registration);
    for (const layer of layers.chainLayers(agent)) {
      for (const [name, registration] of layer.tools.entries()) merged.set(name, registration);
    }
    return merged;
  } catch {
    return null;
  }
}

/** 观察绑定 Agent 的 robot_task_submit 结果，把 agent 路径创建的任务记入 owner 历史。 */
const watchedAgents = new WeakSet<object>();
function watchAgentTaskResults(agent: any): void {
  if (!agent || watchedAgents.has(agent)) return;
  watchedAgents.add(agent);
  const off = agent.ctx?.on?.('session/event', (session: unknown, event: { type?: string; data?: { message?: { content?: Array<{ type?: string; text?: string }> } } }) => {
    if (session !== agent.session || event?.type !== 'tool/result') return;
    const block = (event.data?.message?.content ?? []).find((item) => item?.type === 'text');
    const text = block?.type === 'text' && typeof block.text === 'string' ? block.text : null;
    if (!text) return;
    try {
      const parsed = JSON.parse(text) as { version?: string; value?: { outcome?: string; task?: { taskId?: string; sourceKind?: string; phase?: string; job?: string; reason?: string | null; cancelRequested?: boolean } }; error?: { code?: string } };
      if (parsed.version !== 'robot-task/1') return;
      const task = parsed.value?.task;
      if (typeof task?.taskId === 'string') {
        recordTask(task);
        // Agent 路径的提交结果（含 duplicate/conflict）进入 owner 可见的反馈记录
        feedback.unshift({
          kind: 'task',
          code: null,
          outcome: parsed.value?.outcome ?? null,
          taskId: task.taskId,
          text: submissionText(parsed.value?.outcome, task),
          at: Date.now(),
        });
        while (feedback.length > FEEDBACK_BUDGET) feedback.pop();
      } else if (parsed.error?.code) recordErrorFeedback(parsed.error.code);
    } catch {
      // 非 JSON 工具结果：不是 robot 工具输出，忽略。
    }
  });
  if (typeof off !== 'function') return;
  // agent 释放时取消监听（agentCtx.effect 只在注册时可用；这里用 session 关闭事件兜底）。
  agent.ctx?.on?.('agent/disposed', () => off());
}

/** owner 确定性查询：走当前 rule 句柄（journal 权威）；停用/撤销后按合同保留历史路由。 */
export async function robotOwnerGet(taskId: string): Promise<{ ok: true; task: Record<string, unknown> } | { ok: false; error: string }> {
  const rule = ruleHandle;
  if (!rule) return { ok: false, error: 'not_configured' };
  try {
    const task = await rule.get(taskId);
    if (!task) return { ok: false, error: 'not_found' };
    return { ok: true, task: projectTask(task) };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : 'internal_unknown' };
  }
}

/** owner 确定性取消：受理即返回（不等待落盘/物理停止）。 */
export function robotOwnerCancel(taskId: string): { ok: true; task: Record<string, unknown> } | { ok: false; error: string } {
  const rule = ruleHandle;
  if (!rule) return { ok: false, error: 'not_configured' };
  try {
    const task = rule.cancel(taskId);
    if (!task) return { ok: false, error: 'not_found' };
    recordTask(task as Record<string, unknown>);
    return { ok: true, task: projectTask(task) };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : 'internal_unknown' };
  }
}

function projectTask(value: unknown): Record<string, unknown> {
  const task = value as Record<string, unknown>;
  const operations = Array.isArray(task.operations) ? task.operations : [];
  return {
    taskId: task.taskId,
    sourceKind: task.sourceKind,
    phase: task.phase,
    reason: task.reason ?? null,
    job: task.job,
    cancelRequested: task.cancelRequested === true,
    storageState: task.storageState,
    snapshotOrigin: task.snapshotOrigin,
    safetyInvalidated: task.safetyInvalidated === true,
    operations: (operations as Record<string, unknown>[]).map((operation) => ({
      operationId: operation.operationId,
      kind: operation.kind,
      action: operation.action ?? null,
      sendState: operation.sendState,
      outcome: operation.outcome,
      goalCompleted: operation.goalCompleted === true,
      stopConfirmed: operation.stopConfirmed === true,
      noExecution: operation.noExecution === true,
      cancelRequested: operation.cancelRequested === true,
      conflictingEvidence: operation.conflictingEvidence === true,
      heldResources: Array.isArray(operation.heldResources) ? operation.heldResources : [],
    })),
  };
}

function recordTask(task: Record<string, unknown>): void {
  if (typeof task.taskId !== 'string') return;
  taskRecords.set(task.taskId, {
    taskId: task.taskId,
    sourceKind: String(task.sourceKind ?? ''),
    phase: String(task.phase ?? ''),
    job: String(task.job ?? ''),
    reason: typeof task.reason === 'string' ? task.reason : null,
    cancelRequested: task.cancelRequested === true,
    updatedAt: Date.now(),
  });
  while (taskRecords.size > FEEDBACK_BUDGET) {
    const oldest = [...taskRecords.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0];
    if (!oldest) break;
    taskRecords.delete(oldest[0]);
  }
}

function recordFeedback(outcome: unknown): void {
  const value = outcome as {
    result?: { kind?: string; code?: string; submission?: { outcome?: string; task?: Record<string, unknown> } };
  };
  const result = value?.result;
  if (!result) return;
  if (result.kind === 'task') {
    const task = result.submission?.task;
    if (task) recordTask(task);
    feedback.unshift({
      kind: 'task',
      code: null,
      outcome: result.submission?.outcome ?? null,
      taskId: typeof task?.taskId === 'string' ? task.taskId : null,
      text: submissionText(result.submission?.outcome, task),
      at: Date.now(),
    });
  } else if (result.kind === 'selection') {
    feedback.unshift({ kind: 'selection', code: result.code ?? null, outcome: null, taskId: null, text: selectionText(result.code), at: Date.now() });
  } else if (result.kind === 'error') {
    feedback.unshift({ kind: 'error', code: result.code ?? null, outcome: null, taskId: null, text: errorText(result.code), at: Date.now() });
  }
  while (feedback.length > FEEDBACK_BUDGET) feedback.pop();
}

function recordErrorFeedback(code: string): void {
  feedback.unshift({ kind: 'error', code, outcome: null, taskId: null, text: errorText(code), at: Date.now() });
  while (feedback.length > FEEDBACK_BUDGET) feedback.pop();
}

function submissionText(outcome: string | undefined, task: Record<string, unknown> | undefined): string {
  if (outcome === 'accepted') return '已接纳：机器人任务已创建';
  if (outcome === 'duplicate') return '同一原互动的重复请求：返回原任务（不重复执行）';
  if (outcome === 'skipped') return `已跳过：${skipReasonText(task?.reason)}`;
  return `机器人返回：${String(outcome ?? 'unknown')}`;
}

function selectionText(code: string | undefined): string {
  switch (code) {
    case 'not_configured': return '未配置机器人绑定';
    case 'disabled': return '联动已关闭';
    case 'no_rule_match': return '没有匹配的关键词规则';
    default: return `未创建任务：${String(code ?? 'unknown')}`;
  }
}

/** 测试专用：清空本模块进程内状态（生产不得调用）。 */
export function resetRobotLiveStateForTest(): void {
  applyGeneration += 1;
  bindingHandle = null;
  ruleHandle = null;
  currentConfig = null;
  currentPolicy = null;
  installedTarget = null;
  moduleLoadError = null;
  feedback.length = 0;
  taskRecords.clear();
  sourcesById.clear();
  sourceBudget = 0;
  noRuleMatches = 0;
  ambiguousAggregations = 0;
  restrictionSync = null;
  lastStatusNote = null;
  sessionAgents.clear();
}
