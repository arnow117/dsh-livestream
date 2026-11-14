import React, { useEffect, useId, useRef, useState } from 'react';
import type { PublicChatSettings } from './settings';
import type { FrozenGrantSnapshot } from './frozenGrant';
import type { RecoveryFact } from './recoveryFacts';

interface Props {
  saved: PublicChatSettings;
  targetKey: string;
  onSave(settings: PublicChatSettings): Promise<void>;
  onView(): Promise<PublicChatView>;
  onAction(input: Record<string, unknown>): Promise<{ result?: { status: string; reason?: string } }>;
}

export interface PublicChatView {
  available: boolean;
  historyAvailable?: boolean;
  starting: boolean;
  hold: boolean;
  grant: { grantId: string } | null;
  identity: { accountRecordId: string; roomId: string; principalUid: string | null; platformRoomId: string | null; qualified: boolean } | null;
  messages: Array<{ requestId: string; sourceKey: string; state: string; textDigest: string; createdAtMs: number;
    writeAttempted: boolean; executionEnded: boolean; senderProcessNonce: string; requestHash: string;
    helperPayloadHash: string; autoEvent: { rawId: string; rawType: string } | null;
    facts: RecoveryFact[]; factsRevision: number; factsDigest: string;
    conflicts: Array<{ reason: string; factId: string | null; controlId: string | null }>;
    terminalEvidence: { joinedAtMs: number; firstWriteAttemptAtMs: number | null } | null;
    recovery: { state: string; controlId: string | null }; grant: FrozenGrantSnapshot }>;
  controls: Array<{ id: string; kind: string; historicalState: string; adoptedInCurrentInstance: boolean }>;
}

function copySettings(settings: PublicChatSettings): PublicChatSettings {
  return { ...settings, drafts: { ...settings.drafts } };
}

/** 保存配置只写宿主设置；资格与授权需要单独的主人操作。 */
export function PublicChatSettingsPanel({ saved, targetKey, onSave, onView, onAction }: Props) {
  const [draft, setDraft] = useState(() => copySettings(saved));
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const sequence = useRef(0);
  const actionPending = useRef(false);
  const viewSequence = useRef(0);
  const currentTarget = useRef(targetKey);
  currentTarget.current = targetKey;
  const request = useRef<{ text: string; id: string } | null>(null);
  const [view, setView] = useState<PublicChatView | null>(null);
  const prefix = useId();

  useEffect(() => {
    if (!dirty && !pending) setDraft(copySettings(saved));
  }, [saved, dirty, pending]);

  useEffect(() => {
    ++viewSequence.current;
    request.current = null;
    setView(null);
  }, [targetKey]);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      if (actionPending.current) return;
      const revision = ++viewSequence.current;
      const target = currentTarget.current;
      try {
        const next = await onView();
        if (active && target === currentTarget.current && !actionPending.current && revision === viewSequence.current) setView(next);
      } catch {
        if (active && target === currentTarget.current && revision === viewSequence.current) setMessage('公屏状态读取失败');
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1000);
    return () => { active = false; window.clearInterval(timer); };
  }, [onView]);

  async function act(action: string, fields: Record<string, unknown> = {}) {
    if (actionPending.current || pending) return;
    actionPending.current = true;
    ++viewSequence.current;
    const target = currentTarget.current;
    setPending(true);
    try {
      let input: Record<string, unknown> = { action, ...fields };
      if (action === 'send') {
        if (!request.current || request.current.text !== draft.drafts.manual) {
          request.current = { text: draft.drafts.manual, id: crypto.randomUUID() };
        }
        input = { action, requestId: request.current.id, text: draft.drafts.manual };
      }
      const result = await onAction(input);
      const next = await onView();
      if (target !== currentTarget.current) return;
      setView(next);
      setMessage(result.result?.status === 'rejected' ? `发送未受理：${result.result.reason ?? '不可用'}`
        : action === 'send' ? '已提交，等待实际请求结果' : '操作已完成，请核对状态');
    } catch {
      if (target === currentTarget.current) setMessage('操作未完成，请核对状态；草稿仍保留');
    } finally {
      actionPending.current = false;
      setPending(false);
    }
  }

  async function save() {
    if (pending) return;
    const current = ++sequence.current;
    const target = currentTarget.current;
    const value = copySettings(draft);
    setPending(true);
    setMessage('正在保存公屏设置');
    try {
      await onSave(value);
      if (sequence.current === current && target === currentTarget.current) {
        setDirty(false);
        setMessage('设置已保存；尚未核查或授权发送');
      }
    } catch {
      if (sequence.current === current && target === currentTarget.current) setMessage('保存失败，草稿仍保留');
    } finally {
      if (sequence.current === current) setPending(false);
    }
  }

  const switches = [
    ['enabled', '启用公屏发送'],
    ['reply', '允许当前公屏事件的 Agent 回复'],
    ['welcome', '欢迎观众进场'],
    ['thanks', '感谢礼物'],
  ] as const;

  return (
    <section className="dl-field dl-public-chat" aria-labelledby={`${prefix}-title`}>
      <h3 id={`${prefix}-title`}>公屏文字</h3>
      <p className="dl-hint">保存不会登录、连接或授权发送。发送账号和房间由受信部署及当前房间决定。</p>
      {switches.map(([key, label]) => (
        <label key={key}>
          <input
            type="checkbox"
            checked={draft[key]}
            disabled={pending}
            onChange={(event) => {
              setDraft((previous) => ({ ...previous, [key]: event.target.checked }));
              setDirty(true);
            }}
          />
          {' '}{label}
        </label>
      ))}
      <label htmlFor={`${prefix}-manual`}>手动文字草稿</label>
      <textarea
        id={`${prefix}-manual`}
        value={draft.drafts.manual}
        disabled={pending}
        onChange={(event) => {
          setDraft((previous) => ({ ...previous, drafts: { manual: event.target.value } }));
          setDirty(true);
        }}
      />
      <button type="button" disabled={pending || !dirty} onClick={() => void save()}>保存公屏设置</button>
      <p>发送服务：{view?.available ? '已装配' : '不可用'}</p>
      <p>历史：{view?.historyAvailable ? '可读取' : '不可用'}</p>
      <p>本地账号记录：{view?.identity?.accountRecordId ?? '未配置'}</p>
      <p>真实 UID：{view?.identity?.principalUid ?? '未核实'}；固定房间：{view?.identity?.roomId ?? '未核实'}；内部房间：{view?.identity?.platformRoomId ?? '未核实'}</p>
      <p>资格：{view?.identity?.qualified ? '已核查' : '未核查'}；授权：{view?.grant ? '已授权' : '未授权'}；暂停：{view?.hold ? '是' : '否'}</p>
      <div className="dl-row">
        <button type="button" disabled={pending || !saved.enabled} onClick={() => void act('maintain')}>维护发送材料</button>
        <button type="button" disabled={pending || !view?.available || !saved.enabled} onClick={() => void act('qualify')}>核查资格</button>
        <button type="button" disabled={pending || !view?.identity?.qualified || !!view?.hold} onClick={() => void act('authorize')}>明确授权</button>
        <button type="button" disabled={pending || !view?.available} onClick={() => void act('revoke')}>撤权</button>
        <button type="button" disabled={pending || !view?.grant || !!view?.hold || !draft.drafts.manual} onClick={() => void act('send')}>发送这条文字</button>
      </div>
      {view?.messages.map((item) => <p key={item.requestId}>请求 {item.requestId}：{item.state === 'api_reported_success'
        ? '接口返回成功码，观众未核对' : item.state === 'unknown' ? '结果未知，需核对原请求' : item.state}</p>)}
      {view?.messages.filter((item) => item.state === 'unknown').map((item) => (
        <RecoveryEntry key={item.requestId} item={item} disabled={pending} act={act} />
      ))}
      {view?.controls.map((control) => <div key={control.id} className="dl-field">
        <p>控制 {control.id}：{control.kind} / {control.historicalState}；当前实例{control.adoptedInCurrentInstance ? '已采用' : '未采用'}</p>
        <button type="button" disabled={pending} onClick={() => void act('reconcile-control', { controlId: control.id })}>按原控制编号核对或采用</button>
      </div>)}
      <p aria-live="polite">{message}</p>
    </section>
  );
}

function RecoveryEntry({ item, disabled, act }: {
  item: PublicChatView['messages'][number]; disabled: boolean;
  act(action: string, fields?: Record<string, unknown>): Promise<void>;
}) {
  const [note, setNote] = useState('');
  const [uid, setUid] = useState('');
  const [room, setRoom] = useState('');
  const [platformRoom, setPlatformRoom] = useState('');
  const [digest, setDigest] = useState('');
  const [observedAt, setObservedAt] = useState('');
  const [strength, setStrength] = useState<'direct' | 'indirect'>('direct');
  const prefix = useId();
  return <section className="dl-field" aria-labelledby={`${prefix}-title`}>
    <h4 id={`${prefix}-title`}>核对原请求 {item.requestId}</h4>
    <p>来源编号：{item.sourceKey}；原直播：{item.grant.liveEpoch}；内容摘要：{item.textDigest}</p>
    <FullBinding item={item} />
    <p>原主体 UID：{item.grant.principalUid}；房间：{item.grant.roomId}；内部房间：{item.grant.platformRoomId}</p>
    <p>写入尝试：{item.writeAttempted ? '是' : '未确认'}；原执行结束：{item.executionEnded ? '有记录' : '未确认'}；核对：{item.recovery.state}；控制编号：{item.recovery.controlId ?? '无'}</p>
    <label htmlFor={`${prefix}-note`}>备注或未看到</label>
    <input id={`${prefix}-note`} value={note} disabled={disabled} onChange={(event) => setNote(event.target.value)} />
    <button type="button" disabled={disabled || !note} onClick={() => void act('record-fact', { requestId: item.requestId,
      fact: { kind: 'note', note } })}>记录备注</button>
    <p>正面观察需逐项核对原账号、两个房间、内容摘要和观察时间；间接观察不会解除暂停。</p>
    <label htmlFor={`${prefix}-uid`}>观察到的 UID</label><input id={`${prefix}-uid`} value={uid} onChange={(event) => setUid(event.target.value)} disabled={disabled} />
    <label htmlFor={`${prefix}-room`}>观察到的房间</label><input id={`${prefix}-room`} value={room} onChange={(event) => setRoom(event.target.value)} disabled={disabled} />
    <label htmlFor={`${prefix}-platform-room`}>观察到的内部房间</label><input id={`${prefix}-platform-room`} value={platformRoom} onChange={(event) => setPlatformRoom(event.target.value)} disabled={disabled} />
    <label htmlFor={`${prefix}-digest`}>观察到的内容摘要</label><input id={`${prefix}-digest`} value={digest} onChange={(event) => setDigest(event.target.value)} disabled={disabled} />
    <label htmlFor={`${prefix}-time`}>观察时间（毫秒）</label><input id={`${prefix}-time`} value={observedAt} onChange={(event) => setObservedAt(event.target.value)} disabled={disabled} inputMode="numeric" />
    <label htmlFor={`${prefix}-strength`}>观察来源</label><select id={`${prefix}-strength`} value={strength} disabled={disabled}
      onChange={(event) => setStrength(event.target.value as 'direct' | 'indirect')}>
      <option value="direct">本人直接观察</option><option value="indirect">间接观察</option>
    </select>
    <button type="button" disabled={disabled || !uid || !room || !platformRoom || !digest || !/^\d+$/.test(observedAt)}
      onClick={() => void act('record-fact', { requestId: item.requestId, fact: { kind: 'positive_observation',
        attributionStrength: strength, observedAtMs: Number(observedAt), textDigest: digest, principalUid: uid,
        roomId: room, platformRoomId: platformRoom } })}>记录正面观察</button>
    <button type="button" disabled={disabled} onClick={() => void act('reconcile-message', { requestId: item.requestId })}>按原请求核对</button>
  </section>;
}

const bindingLabels: Array<[keyof FrozenGrantSnapshot, string]> = [
  ['version', '协议'], ['transportKind', '传输'], ['buildDigest', '构建摘要'],
  ['instanceId', '发送实例'], ['senderProcessNonce', '发送进程'], ['senderConnectionGeneration', '发送连接代次'],
  ['authorizationId', '授权控制'], ['grantId', '授权编号'], ['captureId', '采证控制'],
  ['qualificationDigest', '资格摘要'], ['qualificationRevision', '资格版本'], ['identityEpoch', '身份代次'],
  ['accountRecordId', '本地账号记录'], ['principalUid', '原主体 UID'], ['roomId', '固定房间'],
  ['platformRoomId', '内部房间'], ['helperProcessNonce', 'helper 进程'], ['authContextId', '认证上下文'],
  ['authContextRevision', '认证上下文版本'], ['materialDigest', '材料摘要'],
  ['rawSourceSessionId', '原始来源会话'], ['rawSourceConnectionGeneration', '原始来源连接代次'],
  ['rawBrowserContextId', '原始浏览器上下文'], ['roomBindingProofDigest', '房间证明摘要'],
  ['inputConnectionGeneration', '输入连接代次'], ['liveEpoch', '原直播'],
  ['liveEpochStartedAtMs', '原直播开始时间'], ['authorizedAtMs', '授权时间'],
];

function FullBinding({ item }: { item: PublicChatView['messages'][number] }) {
  return <details style={{ overflowWrap: 'anywhere' }}>
    <summary>原请求完整绑定</summary>
    <dl>
      {bindingLabels.map(([key, label]) => <React.Fragment key={key}>
        <dt>{label}</dt><dd>{String(item.grant[key])}</dd>
      </React.Fragment>)}
      <dt>请求摘要</dt><dd>{item.requestHash}</dd>
      <dt>helper 载荷摘要</dt><dd>{item.helperPayloadHash}</dd>
      <dt>内容摘要</dt><dd>{item.textDigest}</dd>
    </dl>
    <p>原事件：{item.autoEvent ? item.autoEvent.rawType + ' / ' + item.autoEvent.rawId : '手动文字'}</p>
    <p>原请求创建时间：{item.createdAtMs}；首次写入时间：{item.terminalEvidence?.firstWriteAttemptAtMs ?? '未确认'}；原执行 joined 时间：{item.terminalEvidence?.joinedAtMs ?? '未确认'}</p>
    <p>事实版本：{item.factsRevision}；事实摘要：{item.factsDigest}</p>
    {item.facts.map((fact) => <p key={fact.factId}>
      事实 {fact.seq}：{fact.kind === 'note' ? '备注 ' + fact.note : fact.source + ' / ' + fact.attributionStrength + ' / 观察时间 ' + fact.observedAtMs}
    </p>)}
    {item.conflicts.map((conflict, index) => <p key={index}>
      冲突：{conflict.reason}；事实编号：{conflict.factId ?? '无'}；控制编号：{conflict.controlId ?? '无'}
    </p>)}
  </details>;
}
