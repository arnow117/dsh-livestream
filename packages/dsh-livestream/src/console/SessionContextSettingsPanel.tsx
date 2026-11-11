/**
 * 控制台「新直播会话」设置：工作目录、显式 Skill 来源、资料根的草稿编辑与保存。
 *
 * 复用既有抽屉的表单与反馈方式（dl-field/dl-row/dl-hint、checkbox、useBusy 局部保存状态）。
 * 路径是普通输入；轮询不能覆盖未保存草稿；保存失败保留输入；关闭抽屉不隐式保存。
 */

import React, { useState } from 'react';
import type { SessionContextConfig, SessionContextStateView } from '../shared/sessionContext';
import type { HostState } from './console';

interface DraftEntry {
  path: string;
  enabled: boolean;
}

interface Draft {
  enabled: boolean;
  cwd: string;
  skillSources: DraftEntry[];
  readRoots: DraftEntry[];
}

const HEALTH_TEXT: Record<string, string> = {
  valid: '已验证可用',
  not_found: '路径不存在或已移动',
  unreadable: '路径不可读',
  invalid: '配置无效',
  conflict: '与其他来源冲突',
  disabled: '已关闭，未检查',
};

function draftFrom(config: SessionContextConfig | undefined): Draft {
  if (!config) return { enabled: false, cwd: '', skillSources: [], readRoots: [] };
  return {
    enabled: config.enabled,
    cwd: config.cwd,
    skillSources: config.skillSources.map((entry) => ({ ...entry })),
    readRoots: config.readRoots.map((entry) => ({ ...entry })),
  };
}

function sameConfig(a: SessionContextConfig, b: Draft): boolean {
  const sameList = (list: DraftEntry[], other: Array<{ path: string; enabled: boolean }>) =>
    list.length === other.length && list.every((entry, index) => entry.path === other[index].path && entry.enabled === other[index].enabled);
  return a.enabled === b.enabled && a.cwd === b.cwd && sameList(a.skillSources, b.skillSources) && sameList(a.readRoots, b.readRoots);
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

export function SessionContextSettingsPanel({ view, onSaved }: { view: SessionContextStateView; onSaved: (state: HostState) => void }) {
  // 草稿只在首次挂载和保存成功后同步；之后的轮询/刷新不覆盖未保存输入
  const [draft, setDraft] = useState<Draft>(() => draftFrom(view.saved?.config));
  const [status, setStatus] = useState('');
  const [fieldError, setFieldError] = useState('');
  const [busy, error, run] = useLocalBusy();
  const saved = view.saved;
  const dirty = !saved ? true : !sameConfig(saved.config, draft);
  const expectedRevision = saved?.revision ?? 0;

  const patch = (change: Partial<Draft>) => {
    setStatus('');
    setFieldError('');
    setDraft((current) => ({ ...current, ...change }));
  };
  const patchList = (kind: 'skillSources' | 'readRoots', index: number, change: Partial<DraftEntry>) => {
    setStatus('');
    setFieldError('');
    setDraft((current) => ({ ...current, [kind]: current[kind].map((entry, i) => (i === index ? { ...entry, ...change } : entry)) }));
  };
  const addEntry = (kind: 'skillSources' | 'readRoots') => {
    setStatus('');
    setFieldError('');
    setDraft((current) => (current[kind].length >= 8 ? current : { ...current, [kind]: [...current[kind], { path: '', enabled: true }] }));
  };
  const removeEntry = (kind: 'skillSources' | 'readRoots', index: number) => {
    setStatus('');
    setFieldError('');
    setDraft((current) => ({ ...current, [kind]: current[kind].filter((_, i) => i !== index) }));
  };

  const save = () => run(async () => {
    setStatus('正在保存会话设置');
    const config: SessionContextConfig = {
      enabled: draft.enabled,
      cwd: draft.cwd.trim(),
      skillSources: draft.skillSources.map((entry) => ({ path: entry.path.trim(), enabled: entry.enabled })),
      readRoots: draft.readRoots.map((entry) => ({ path: entry.path.trim(), enabled: entry.enabled })),
    };
    try {
      const result = await postJson('settings', { sessionContext: { expectedRevision, config } });
      onSaved(result);
      setDraft(draftFrom(result.sessionContext?.saved?.config));
      setFieldError('');
      setStatus('已保存：将在此后新建的直播会话生效；正在播的会话不变。');
    } catch (err) {
      const message = (err as Error).message;
      const marker = message.indexOf('config.');
      const field = marker >= 0 ? message.slice(marker + 'config.'.length).split(/[）：(]/)[0] : '';
      setFieldError(field);
      setStatus('');
      throw err;
    }
  });

  const recheck = () => run(async () => {
    setStatus('正在重查路径有效性');
    try {
      const result = await postJson('session-context/recheck', {});
      onSaved(result);
      setStatus('重查完成');
    } catch (err) {
      setStatus('');
      throw err;
    }
  });

  const healthFor = (kind: 'skill' | 'root', index: number) => view.health.entries.find((entry) => entry.kind === kind && entry.index === index);
  const cwdHealth = view.health.entries.find((entry) => entry.kind === 'cwd');

  return (
    <section className="dl-field dl-session-context" aria-labelledby="session-context-title">
      <h3 id="session-context-title">新直播会话</h3>
      <p className="dl-hint">保存后，下一次在这里新建的直播会话使用所选目录、Skill 和资料；正在播的会话不变，Skill 只读、不执行脚本、不安装依赖、不写文件。</p>
      <label className="dl-check"><input type="checkbox" checked={draft.enabled} disabled={busy} onChange={(e) => patch({ enabled: e.target.checked })} /> 启用新直播会话设置</label>
      <label htmlFor="session-context-cwd">工作目录（可留空：沿用默认工作区）</label>
      <input
        id="session-context-cwd"
        value={draft.cwd}
        placeholder="/绝对路径/工作目录"
        disabled={busy}
        onChange={(e) => patch({ cwd: e.target.value })}
        aria-invalid={fieldError === 'cwd' || fieldError === 'config.cwd'}
      />
      {cwdHealth && cwdHealth.status !== 'valid' && <p role="alert" className="dl-error">工作目录：{HEALTH_TEXT[cwdHealth.status] ?? cwdHealth.status}</p>}
      <fieldset className="dl-voice-fields" disabled={busy}>
        <legend className="dl-hint">Skill 来源（显式 .md 文件、含 SKILL.md 的目录或容器目录，最多 8 项）</legend>
        {draft.skillSources.map((entry, index) => {
          const health = healthFor('skill', index);
          return (
            <div className="dl-row" key={`skill-${index}`}>
              <label className="dl-check">
                <input type="checkbox" checked={entry.enabled} onChange={(e) => patchList('skillSources', index, { enabled: e.target.checked })} />
                <span className="dl-meta">启用</span>
              </label>
              <input
                aria-label={`Skill 来源 ${index + 1} 路径`}
                value={entry.path}
                placeholder="/绝对路径/Skill.md 或目录"
                onChange={(e) => patchList('skillSources', index, { path: e.target.value })}
                aria-invalid={health ? health.status !== 'valid' && health.status !== 'disabled' : false}
              />
              <button type="button" onClick={() => removeEntry('skillSources', index)}>删除</button>
              {health && <p className={health.status === 'valid' || health.status === 'disabled' ? 'dl-hint' : 'dl-error'} role={health.status === 'valid' || health.status === 'disabled' ? undefined : 'alert'}>来源 {index + 1}：{HEALTH_TEXT[health.status] ?? health.status}{health.detail ? `（${health.detail}）` : ''}</p>}
            </div>
          );
        })}
        <button type="button" disabled={draft.skillSources.length >= 8} onClick={() => addEntry('skillSources')}>添加 Skill 来源</button>
        <legend className="dl-hint">资料根（只读读取的目录，最多 8 项；Skill 引用的其他文件不会自动成为资料根）</legend>
        {draft.readRoots.map((entry, index) => {
          const health = healthFor('root', index);
          return (
            <div className="dl-row" key={`root-${index}`}>
              <label className="dl-check">
                <input type="checkbox" checked={entry.enabled} onChange={(e) => patchList('readRoots', index, { enabled: e.target.checked })} />
                <span className="dl-meta">启用</span>
              </label>
              <input
                aria-label={`资料根 ${index + 1} 路径`}
                value={entry.path}
                placeholder="/绝对路径/资料目录"
                onChange={(e) => patchList('readRoots', index, { path: e.target.value })}
                aria-invalid={health ? health.status !== 'valid' && health.status !== 'disabled' : false}
              />
              <button type="button" onClick={() => removeEntry('readRoots', index)}>删除</button>
              {health && <p className={health.status === 'valid' || health.status === 'disabled' ? 'dl-hint' : 'dl-error'} role={health.status === 'valid' || health.status === 'disabled' ? undefined : 'alert'}>资料根 {index + 1}：{HEALTH_TEXT[health.status] ?? health.status}{health.detail ? `（${health.detail}）` : ''}</p>}
            </div>
          );
        })}
        <button type="button" disabled={draft.readRoots.length >= 8} onClick={() => addEntry('readRoots')}>添加资料根</button>
      </fieldset>
      <div className="dl-row">
        <button type="button" disabled={busy} onClick={() => void save()}>保存会话设置</button>
        <button type="button" disabled={busy || !saved} onClick={() => void recheck()}>重查路径有效性</button>
      </div>
      <p className="dl-hint" aria-live="polite">会话设置：{view.invalid ? '已保存的记录损坏' : saved ? (dirty ? '未保存' : `已保存（第 ${saved.revision} 版，将在此后新建的直播会话生效）`) : '未保存过（新建直播会话暂不使用这些设置）'}</p>
      {view.invalid && <p role="alert" className="dl-error">已保存的会话设置损坏：{view.invalid}。可重新保存一次覆盖。</p>}
      {view.recheck && <p className="dl-hint">{view.recheck}</p>}
      {error && <p role="alert" className="dl-error">{error}</p>}
      {status && <p role="status">{status}</p>}
      {saved && <p className="dl-hint">已保存配置：{saved.config.enabled ? '启用' : '关闭'}；工作目录 {saved.config.cwd ? '已设置' : '留空（沿用默认工作区）'}；Skill 来源 {saved.config.skillSources.length} 项；资料根 {saved.config.readRoots.length} 项。</p>}
      {view.active ? (
        <div className="dl-field">
          <p className="dl-hint">活动会话 {view.active.sessionId}：第 {view.active.revision} 版 · {view.active.platform === 'douyin' ? '抖音本地舞台' : 'B 站'}</p>
          <p className="dl-hint">实际工作目录：{view.active.effectiveCwd ? view.active.effectiveCwd : '沿用默认工作区'}</p>
          <p className="dl-hint">Skill：{view.active.skills.length ? view.active.skills.map((skill) => `${skill.name}${skill.loadedAt ? '（已加载）' : '（未加载）'}`).join('、') : '没有启用的 Skill'}</p>
          {view.active.issues.length > 0 && <p className="dl-error">创建时已失效的条目：{view.active.issues.join('；')}</p>}
        </div>
      ) : (
        <p className="dl-hint">当前没有使用这些设置的活动直播会话。</p>
      )}
    </section>
  );
}
