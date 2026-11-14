/**
 * 控制台「机器人联动」设置（FEAT-DSH-004）：绑定目标、动作白名单、关键词规则与共享冷却的
 * 草稿编辑与保存，装配状态、真实能力交集、反馈与原任务查询/取消的确定性展示。
 *
 * 复用既有抽屉的表单与反馈方式（dl-field/dl-row/dl-hint、checkbox、局部 busy 状态）。
 * 轮询不覆盖未保存草稿；保存失败保留输入；非法值整体拒绝（服务端校验回显原因）。
 * 保存是等待装配完成的：响应里的状态就是最终装配事实（已装配/冲突/插件缺失各有文案），
 * 不在插件缺失或不兼容时宣称「已保存并装配」。
 * 原任务行以机器人 owner API 的权威 TaskView 为准（查询/取消的返回直接更新行）；
 * 取消只是受理（cancelAccepted），实际停止必须等机器人自己的停止证明，绝不显示「已停止」。
 * 能力（capabilities）由控制台直接读取已安装机器人插件的 owner 路由，随装配状态和
 * 有界定时器刷新；没有插件时显示不可用原因。
 */

import React, { useEffect, useRef, useState } from 'react';
import { robotErrorText, ROBOT_ACTIONS, type RobotAction, type RobotLiveConfig } from '../shared/robotLive';
import type { HostState } from './console';

export interface RobotLiveHostView {
  saved: RobotLiveConfig | null;
  savedInvalid: string | null;
  status: string;
  statusDetail: string | null;
  binding: { version: string; journalSchemaVersion: number; configRevision: number } | null;
  policy: { enabled: boolean; cooldownMs: number; configRevision: number; hasAccepted: boolean } | null;
  boundSession: string | null;
  noRuleMatches: number;
  ambiguousAggregations: number;
  feedback: Array<{ kind: string; code: string | null; outcome: string | null; taskId: string | null; text: string; at: number }>;
  tasks: Array<{ taskId: string; sourceKind: string; phase: string; job: string; reason: string | null; cancelRequested: boolean; updatedAt: number }>;
}

interface RobotCapability {
  connection: string;
  storageState: string;
  supportedActions: string[];
}

interface RobotTaskRow {
  taskId: string;
  sourceKind: string;
  phase: string;
  job: string;
  reason: string | null;
  cancelRequested: boolean;
  storageState?: string;
  snapshotOrigin?: string;
  safetyInvalidated?: boolean;
  /** 权威来源：owner API 返回（robot），或宿主推送的任务记录（push） */
  origin: 'robot' | 'push';
  updatedAt: number;
}

interface RuleDraft {
  text: string;
  action: RobotAction;
}

interface Draft {
  enabled: boolean;
  liveSessionId: string;
  bindingId: string;
  allowedActions: RobotAction[];
  rules: RuleDraft[];
  cooldownSec: string;
}

const ACTION_LABEL: Record<RobotAction, string> = {
  greeting: '打招呼（greeting）',
  sit_down: '坐下（sit_down）',
  lie_down: '趴下（lie_down）',
  stand_up: '站起来（stand_up）',
};

const STATUS_TEXT: Record<string, string> = {
  'not-configured': '未配置：直播按自身状态独立运行，机器人无副作用',
  inactive: '已保存，但还没有装配到机器人插件',
  ready: '已装配：配置已安装到机器人的执行账本',
  'saved-disabled': '已保存为停用：机器人不会因弹幕产生动作',
  'invalid-config': '已保存的配置无效',
};

const PHASE_TEXT: Record<string, string> = {
  accepted: '已接纳',
  running: '执行中',
  skipped: '已跳过',
  settled: '已结束',
  unknown: '结果未确认（unknown）',
};

const JOB_TEXT: Record<string, string> = {
  none: '无委派',
  running: '委派执行中',
  idle: '委派空闲',
  cancel_requested: '已受理取消',
  unknown: '委派结果未确认',
};

/** 能力刷新的有界间隔：装配状态/版本变化立即刷新，抽屉开着时每 30 秒一次。 */
const CAPABILITY_REFRESH_MS = 30_000;

function draftFrom(config: RobotLiveConfig | null): Draft {
  if (!config) return { enabled: false, liveSessionId: '', bindingId: '', allowedActions: [], rules: [], cooldownSec: '10' };
  return {
    enabled: config.enabled,
    liveSessionId: config.liveSessionId ?? '',
    bindingId: config.bindingId ?? '',
    allowedActions: [...config.allowedActions],
    rules: config.rules.map((rule) => ({ text: rule.text, action: rule.action })),
    cooldownSec: config.cooldownMs === 0 ? '' : String(config.cooldownMs / 1000),
  };
}

/** 界面的秒值必须能精确转回整数毫秒：不接受小数秒、0、负数或空。 */
function cooldownMsFrom(sec: string): number | null {
  if (!/^\d+$/.test(sec.trim())) return null;
  const seconds = Number(sec.trim());
  if (!Number.isSafeInteger(seconds) || seconds < 1) return null;
  const ms = seconds * 1000;
  return Number.isSafeInteger(ms) ? ms : null;
}

function sameDraft(config: RobotLiveConfig | null, draft: Draft): boolean {
  if (!config) return false;
  const sameActions = config.allowedActions.length === draft.allowedActions.length
    && config.allowedActions.every((action) => draft.allowedActions.includes(action));
  const sameRules = config.rules.length === draft.rules.length
    && config.rules.every((rule, index) => rule.text === draft.rules[index].text && rule.action === draft.rules[index].action);
  return config.enabled === draft.enabled
    && (config.liveSessionId ?? '') === draft.liveSessionId
    && (config.bindingId ?? '') === draft.bindingId
    && sameActions && sameRules
    && config.cooldownMs === (cooldownMsFrom(draft.cooldownSec) ?? -1);
}

function useLocalBusy(): [boolean, string, (run: () => Promise<unknown>) => void] {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    fn().catch((e) => setError((e as Error).message)).finally(() => setBusy(false));
  };
  return [busy, error, run];
}

async function postJson(path: string, payload: unknown): Promise<HostState> {
  const res = await fetch(`/api/dsh-livestream/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok || data.ok === false) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data as HostState;
}

export function RobotSettingsPanel({ view: viewProp, onSaved }: { view: RobotLiveHostView; onSaved: (state: HostState) => void }) {
  // 草稿只在首次挂载和保存成功后同步；轮询/刷新不覆盖未保存输入。
  // 展示状态用有界轮询的最新 robot 视图（抽屉打开时每 2 秒一次），任务/反馈即时可见。
  const [draft, setDraft] = useState<Draft>(() => draftFrom(viewProp.saved));
  const [polled, setPolled] = useState<RobotLiveHostView | null>(null);
  const view = polled ?? viewProp;
  const [status, setStatus] = useState('');
  const [capabilities, setCapabilities] = useState<RobotCapability | null>(null);
  const [capabilityNote, setCapabilityNote] = useState('');
  // F8：任务行以机器人 owner API 的权威 TaskView 为准；宿主推送的记录作为种子，
  // 查询/取消的返回覆盖对应行（含 phase/job/unknown/取消受理）。
  const [taskRows, setTaskRows] = useState<RobotTaskRow[]>(() => viewProp.tasks.map((task) => ({ ...task, origin: 'push' as const })));
  const lastRevisionRef = useRef<number>(-1);
  const [busy, error, run] = useLocalBusy();
  const dirty = !sameDraft(viewProp.saved, draft);

  // 有界状态轮询：联动是异步事实（规则在原事件处消费、任务由机器人推进），
  // 抽屉打开期间每 2 秒刷新一次 robot 视图；卸载即停。
  useEffect(() => {
    let cancelled = false;
    const timer = setInterval(() => {
      fetch('/api/dsh-livestream/state', { cache: 'no-store' })
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { robot?: RobotLiveHostView } | null) => {
          if (!cancelled && data?.robot) setPolled(data.robot);
        })
        .catch(() => {});
    }, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const patch = (change: Partial<Draft>) => {
    setStatus('');
    setDraft((current) => ({ ...current, ...change }));
  };
  const toggleAction = (action: RobotAction) => {
    setStatus('');
    setDraft((current) => ({
      ...current,
      allowedActions: current.allowedActions.includes(action)
        ? current.allowedActions.filter((item) => item !== action)
        : [...current.allowedActions, action],
    }));
  };
  const patchRule = (index: number, change: Partial<RuleDraft>) => {
    setStatus('');
    setDraft((current) => ({ ...current, rules: current.rules.map((rule, i) => (i === index ? { ...rule, ...change } : rule)) }));
  };
  const addRule = () => {
    setStatus('');
    setDraft((current) => (current.rules.length >= 32 ? current : { ...current, rules: [...current.rules, { text: '', action: current.allowedActions[0] ?? 'greeting' }] }));
  };
  const removeRule = (index: number) => {
    setStatus('');
    setDraft((current) => ({ ...current, rules: current.rules.filter((_, i) => i !== index) }));
  };

  // 宿主推送的任务记录并入行集（robot 权威行优先，push 行按更新时间补充）
  useEffect(() => {
    setTaskRows((current) => {
      const byId = new Map(current.map((row) => [row.taskId, row]));
      for (const task of view.tasks) {
        const existing = byId.get(task.taskId);
        if (!existing || existing.origin !== 'robot' || task.updatedAt > existing.updatedAt) {
          byId.set(task.taskId, { ...task, origin: existing?.origin === 'robot' ? 'robot' : 'push', updatedAt: Math.max(task.updatedAt, existing?.updatedAt ?? 0) });
        }
      }
      return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    });
  }, [view.tasks]);

  // 真实能力：直接读已安装机器人插件的 owner 路由（同一宿主、同一 owner 认证）。
  // 装配版本变化立即刷新；抽屉开着时有界定时刷新，不无限轮询。
  useEffect(() => {
    let cancelled = false;
    const bindingId = view.saved?.bindingId;
    const fetchCapabilities = () => {
      if (!bindingId) {
        setCapabilities(null);
        setCapabilityNote('');
        return;
      }
      fetch(`/api/dsh-qdroid/robot/v1/capabilities?bindingId=${encodeURIComponent(bindingId)}`, { cache: 'no-store' })
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { value?: { connection?: string; storageState?: string; actions?: Array<{ action: string; support: string }> } } | null) => {
          if (cancelled) return;
          if (!data?.value) {
            setCapabilities(null);
            setCapabilityNote('读不到机器人插件能力（未安装或不可达）');
            return;
          }
          setCapabilities({
            connection: data.value.connection ?? 'unknown',
            storageState: data.value.storageState ?? 'unknown',
            supportedActions: (data.value.actions ?? []).filter((action) => action.support === 'supported').map((action) => action.action),
          });
          setCapabilityNote('');
        })
        .catch(() => {
          if (!cancelled) {
            setCapabilities(null);
            setCapabilityNote('读不到机器人插件能力（未安装或不可达）');
          }
        });
    };
    fetchCapabilities();
    const timer = setInterval(fetchCapabilities, CAPABILITY_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [view.saved?.bindingId, view.binding?.configRevision, view.status]);

  const save = () => run(async () => {
    const cooldownMs = cooldownMsFrom(draft.cooldownSec);
    if (cooldownMs === null) throw new Error('冷却时长须是正整数秒（按毫秒保存）');
    const config = {
      version: 'robot-live/1' as const,
      enabled: draft.enabled,
      liveSessionId: draft.liveSessionId.trim() === '' ? null : draft.liveSessionId.trim(),
      bindingId: draft.bindingId.trim() === '' ? null : draft.bindingId.trim(),
      allowedActions: draft.allowedActions,
      rules: draft.rules.map((rule, index) => ({ ruleId: `rule-${index + 1}`, text: rule.text, action: rule.action })),
      cooldownMs,
    };
    setStatus('正在保存联动设置');
    try {
      // 服务端等待装配完成后返回：响应里的 robot 状态就是最终事实。
      const result = await postJson('settings', { robotLive: config });
      const next = (result as { robot?: RobotLiveHostView }).robot;
      onSaved(result);
      setDraft(draftFrom(next?.saved ?? null));
      const finalStatus = next?.status;
      if (config.enabled && finalStatus === 'ready') {
        setStatus(`已保存并装配（配置版本 ${next?.binding?.configRevision ?? '?'}）；保存会撤销旧的联动授权并中止其持有的动作`);
      } else if (config.enabled && finalStatus === 'inactive') {
        setStatus(`已保存，但没有装配成功：${next?.statusDetail ?? '机器人插件不可用'}；机器人不会因弹幕产生动作`);
      } else if (finalStatus === 'saved-disabled') {
        setStatus('已保存为停用：机器人不会因弹幕产生动作');
      } else if (finalStatus === 'inactive') {
        setStatus(`已保存（未启用）：${next?.statusDetail ?? '未装配'}`);
      } else {
        setStatus(`已保存（当前状态：${STATUS_TEXT[finalStatus ?? ''] ?? finalStatus ?? '未知'}${next?.statusDetail ? `；${next.statusDetail}` : ''}）`);
      }
    } catch (err) {
      setStatus('');
      throw err;
    }
  });

  // F8：owner API 的权威 TaskView 直接更新任务行（保留 storage/snapshot/unknown 事实）。
  const applyAuthoritativeTask = (taskId: string, value: Record<string, unknown>): RobotTaskRow => {
    const row: RobotTaskRow = {
      taskId,
      sourceKind: String(value.sourceKind ?? ''),
      phase: String(value.phase ?? ''),
      job: String(value.job ?? ''),
      reason: typeof value.reason === 'string' ? value.reason : null,
      cancelRequested: value.cancelRequested === true,
      storageState: String(value.storageState ?? ''),
      snapshotOrigin: String(value.snapshotOrigin ?? ''),
      safetyInvalidated: value.safetyInvalidated === true,
      origin: 'robot',
      updatedAt: Date.now(),
    };
    setTaskRows((current) => [row, ...current.filter((item) => item.taskId !== taskId)]);
    return row;
  };

  const queryTask = (taskId: string) => run(async () => {
    setStatus(`正在查询任务 ${taskId.slice(0, 8)}…`);
    const res = await fetch(`/api/dsh-qdroid/robot/v1/tasks/${encodeURIComponent(taskId)}`, { cache: 'no-store' });
    const data = await res.json().catch(() => ({ error: { code: `HTTP ${res.status}` } }));
    if (!res.ok) throw new Error(robotErrorText((data as { error?: { code?: string } }).error?.code));
    const value = (data as { value: Record<string, unknown> }).value;
    const row = applyAuthoritativeTask(taskId, value);
    onSaved(await (await fetch('/api/dsh-livestream/state', { cache: 'no-store' })).json() as HostState);
    const operation = Array.isArray(value.operations) ? (value.operations as Array<Record<string, unknown>>)[0] : undefined;
    const operationNote = operation
      ? `；动作 ${String(operation.kind)} ${String(operation.outcome)}${operation.stopConfirmed === true ? '（已停止）' : operation.cancelRequested === true ? '（取消已受理）' : ''}`
      : '';
    setStatus(`任务 ${taskId.slice(0, 8)}…：${PHASE_TEXT[row.phase] ?? row.phase}${row.phase === 'skipped' && row.reason ? `（${row.reason}）` : ''}；委派：${JOB_TEXT[row.job] ?? row.job}${row.phase === 'unknown' ? `；存储 ${row.storageState}/${row.snapshotOrigin}` : ''}${operationNote}`);
  });

  const cancelTask = (taskId: string) => run(async () => {
    setStatus(`正在取消任务 ${taskId.slice(0, 8)}…`);
    const res = await fetch(`/api/dsh-qdroid/robot/v1/tasks/${encodeURIComponent(taskId)}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestKey: crypto.randomUUID() }) });
    const data = await res.json().catch(() => ({ error: { code: `HTTP ${res.status}` } }));
    if (!res.ok) throw new Error(robotErrorText((data as { error?: { code?: string } }).error?.code));
    const value = (data as { value: { task: Record<string, unknown>; cancelAccepted: boolean } }).value;
    const row = applyAuthoritativeTask(taskId, value.task);
    onSaved(await (await fetch('/api/dsh-livestream/state', { cache: 'no-store' })).json() as HostState);
    // 取消受理与已停止严格分开：没有机器人自己的停止证明就绝不说「已停止」。
    const stopProven = Array.isArray(value.task.operations) && (value.task.operations as Array<Record<string, unknown>>).some((op) => op.stopConfirmed === true);
    setStatus(`任务 ${taskId.slice(0, 8)}…：${value.cancelAccepted === true ? '已受理取消' : '取消未受理'}；${stopProven ? '机器人已确认停止' : '实际停止要等机器人自己的停止证明，当前委派状态：'}${stopProven ? '' : JOB_TEXT[row.job] ?? row.job}`);
  });

  const effectiveActions = view.saved
    ? view.saved.allowedActions.filter((action) => (capabilities?.supportedActions ?? view.saved!.allowedActions).includes(action))
    : [];
  const connectionText = capabilities ? (capabilities.connection === 'ready' ? '已连接（软件/实机以插件报告为准）' : capabilities.connection === 'offline' ? '机器人离线' : capabilities.connection === 'incompatible' ? '协议不兼容' : capabilities.connection) : '';

  return (
    <section className="dl-field dl-robot-live" aria-labelledby="robot-live-title">
      <h3 id="robot-live-title">机器人联动</h3>
      <p className="dl-hint">可选：把直播间弹幕联动为机器人动作。机器人说话、字幕、舞台和课程都不变；不配置或机器人不可用时直播照常独立运行。委派的只有动作，不会让机器人替她说话或跟随。</p>
      <label className="dl-check"><input type="checkbox" checked={draft.enabled} disabled={busy} onChange={(e) => patch({ enabled: e.target.checked })} /> 启用机器人联动</label>
      <div className="dl-row">
        <label htmlFor="robot-binding-id">机器人绑定 ID</label>
        <input
          id="robot-binding-id"
          value={draft.bindingId}
          placeholder="dsh-qdroid 里配置的 bindingId"
          disabled={busy}
          onChange={(e) => patch({ bindingId: e.target.value })}
        />
      </div>
      <div className="dl-row">
        <label htmlFor="robot-live-session">她直播用的会话 ID（启用时必填）</label>
        <input
          id="robot-live-session"
          value={draft.liveSessionId}
          placeholder="直播会话的 id；只有这个会话收到弹幕才联动"
          disabled={busy}
          onChange={(e) => patch({ liveSessionId: e.target.value })}
        />
      </div>
      <fieldset className="dl-voice-fields" disabled={busy}>
        <legend className="dl-hint">动作白名单（勾选后两条路径都只能申请这些动作；实际可执行再与机器人当前能力取交集）</legend>
        {ROBOT_ACTIONS.map((action) => (
          <label className="dl-check" key={action}>
            <input type="checkbox" checked={draft.allowedActions.includes(action)} onChange={() => toggleAction(action)} />
            {ACTION_LABEL[action]}
            {capabilities && !capabilities.supportedActions.includes(action) && <span className="dl-meta">（当前机器人不支持）</span>}
          </label>
        ))}
      </fieldset>
      <fieldset className="dl-voice-fields" disabled={busy}>
        <legend className="dl-hint">关键词规则（弹幕原文逐字相等才触发，不截断、不忽略大小写；同一文字只能配一个动作）</legend>
        {draft.rules.map((rule, index) => (
          <div className="dl-row" key={`rule-${index}`}>
            <input
              aria-label={`规则 ${index + 1} 关键词`}
              value={rule.text}
              placeholder="弹幕原文，例如：坐下"
              onChange={(e) => patchRule(index, { text: e.target.value })}
            />
            <select aria-label={`规则 ${index + 1} 动作`} value={rule.action} onChange={(e) => patchRule(index, { action: e.target.value as RobotAction })}>
              {(draft.allowedActions.length ? draft.allowedActions : ROBOT_ACTIONS).map((action) => (
                <option key={action} value={action}>{ACTION_LABEL[action]}</option>
              ))}
            </select>
            <button type="button" onClick={() => removeRule(index)}>删除</button>
          </div>
        ))}
        <button type="button" disabled={draft.rules.length >= 32} onClick={addRule}>添加规则</button>
      </fieldset>
      <div className="dl-row">
        <label htmlFor="robot-cooldown">共享冷却（秒）</label>
        <input
          id="robot-cooldown"
          inputMode="numeric"
          value={draft.cooldownSec}
          disabled={busy}
          onChange={(e) => patch({ cooldownSec: e.target.value })}
        />
        <span className="dl-meta">两条路径（她决定、关键词规则）共用的最小间隔；不会把欢迎语的节奏拿来当冷却</span>
      </div>
      <div className="dl-row">
        <button type="button" disabled={busy} onClick={() => void save()}>保存联动设置</button>
      </div>
      <p className="dl-hint" aria-live="polite">
        联动状态：{STATUS_TEXT[view.status] ?? view.status}{view.statusDetail ? `；${view.statusDetail}` : ''}
        {view.savedInvalid ? `；已保存配置无效：${view.savedInvalid}` : ''}
        {dirty ? '；有未保存的修改' : ''}
      </p>
      {view.binding && <p className="dl-hint">装配信息：{view.binding.version}，journal v{view.binding.journalSchemaVersion}，配置版本 {view.binding.configRevision}{view.policy ? `；机器人在册：${view.policy.enabled ? '启用' : '停用'}，冷却 ${view.policy.cooldownMs}ms${view.policy.hasAccepted ? '，有过接纳历史' : ''}` : ''}</p>}
      {view.boundSession && <p className="dl-hint">绑定会话：{view.boundSession}；不在该会话开播期间的弹幕不产生动作。</p>}
      {capabilityNote && <p role="alert" className="dl-error">{capabilityNote}</p>}
      {capabilities && <p className="dl-hint">机器人：{connectionText}；存储 {capabilities.storageState}；白名单内实际可执行：{effectiveActions.length ? effectiveActions.map((action) => ACTION_LABEL[action as RobotAction] ?? action).join('、') : '无（未保存白名单或机器人暂不支持）'}。</p>}
      {view.feedback.length > 0 && (
        <div className="dl-field">
          <p className="dl-hint">最近联动结果（新的在上）：</p>
          <ul>
            {view.feedback.slice(0, 8).map((item, index) => (
              <li key={`${item.at}-${index}`}>{item.text}{item.taskId ? `（任务 ${item.taskId.slice(0, 8)}…）` : ''}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="dl-field">
        <p className="dl-hint">原任务（owner 可查可取消；取消只是受理，实际停止要等机器人自己的停止证明）：</p>
        {taskRows.length === 0
          ? <p className="dl-hint">还没有联动任务。</p>
          : taskRows.slice(0, 6).map((task) => (
            <div className="dl-row" key={task.taskId}>
              <span className="dl-meta">{task.taskId.slice(0, 8)}… · {task.sourceKind === 'live_rule' ? '关键词规则' : task.sourceKind === 'live_agent' ? '她申请' : task.sourceKind} · {PHASE_TEXT[task.phase] ?? task.phase}{task.reason ? `（${task.reason}）` : ''} · {JOB_TEXT[task.job] ?? task.job}{task.phase === 'unknown' && task.snapshotOrigin ? ` · ${task.storageState}/${task.snapshotOrigin}` : ''}</span>
              <button type="button" disabled={busy} onClick={() => void queryTask(task.taskId)}>查询</button>
              <button type="button" disabled={busy} onClick={() => void cancelTask(task.taskId)}>取消</button>
            </div>
          ))}
      </div>
      <p className="dl-hint">「冷却中」和「机器人忙」是不同的跳过原因，都不排队；来源过期、未核实、权限不足也不会留下待执行动作。结果未确认（unknown）时请用上面的查询核对原任务，没有「清除并重试」捷径。</p>
      {error && <p role="alert" className="dl-error">{error}</p>}
      {status && <p role="status">{status}</p>}
    </section>
  );
}
