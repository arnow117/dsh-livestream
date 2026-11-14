/**
 * 原操作记录与核对事实（FEAT-008 API-6/7 / P1-04 修订）。
 *
 * 区分未派发、排队、派发中、明确未执行、页面已提交、结果未知。
 * terminal_not_dispatched 只接受受信 sender 终态证明（原执行已终止且从未
 * Enter）；备注、「没看到」、HTTP 失败不构成证明。正面人工观察单独记录，
 * 不写成 not_sent 或平台 receipt。unknown 事实保留，冲突不覆盖；
 * 原执行未终止或证据冲突时继续 hold。迟到期结果只追加。
 */

import { boundedString, safeInteger, isObject, hexDigest64, type ValidationResult } from './protocol';
import type { GrantSnapshot } from './grantAuthority';

export type OperationPhase = 'queued' | 'dispatching' | 'dispatched';
export type OperationOutcome = 'unknown' | 'terminal_not_dispatched';

export interface OriginalOperation {
  schemaVersion: 1;
  requestId: string;
  sourceKey: string | null;
  /** 持久化只保留最小绑定元数据；不含 Cookie、原始错误或登记资料。 */
  binding: {
    principalUid: string;
    roomId: string;
    grantId: string;
    liveEpoch: string;
    senderSessionId: string;
    /** 采证时 sender 的进程 nonce：查询核对与「借新进程」拒绝的锚点（F1）。 */
    senderProcessNonce: string;
    inputConnectionGeneration: number;
    identityGeneration: number;
    snapshot?: GrantSnapshot;
  };
  /** 文本只保留 SHA-256 摘要与长度，不保留原文。 */
  textDigest: string;
  textLength: number;
  phase: OperationPhase;
  outcome: OperationOutcome | null;
  outcomeReason: string | null;
  enterAttempted: boolean;
  pageSubmitted: boolean;
  /** outcome 依据是否来自受信 v1 sender 终态。 */
  senderProofApplied: boolean;
  /** 证据冲突未决（如页面已提交 vs「从未 Enter」）：恢复前必须人工核对。 */
  conflictOpen: boolean;
  facts: VerificationFact[];
  createdAt: number;
  updatedAt: number;
  /** sourceKey tombstone：原事件永不重发。 */
  tombstone: boolean;
}

export interface VerificationFact {
  factId: string;
  kind: 'owner_observation' | 'termination_proof' | 'note';
  /** 观察来源：owner 或指定观众；无归属的观察不记录。 */
  source: 'owner' | 'designated-viewer' | 'lifecycle' | null;
  /** 归属强度：direct=核对者确认账号/房间/时间/内容摘要；indirect=转述。 */
  attributionStrength: 'direct' | 'indirect' | null;
  observedAt: number | null;
  textDigest: string | null;
  accountHint: string | null;
  roomHint: string | null;
  /** 仅 termination_proof：受信 sender 终态。 */
  proof: { executionEnded: boolean; enterNeverCalled: boolean; senderProcessNonce: string; recordedAt: number } | null;
  note: string | null;
  createdAt: number;
}

export type FactInput =
  | {
    kind: 'owner_observation';
    source: 'owner' | 'designated-viewer';
    attributionStrength: 'direct' | 'indirect';
    observedAt: number;
    textDigest: string;
    accountHint: string;
    roomHint: string;
  }
  | { kind: 'note'; note: string };

export type InternalFactInput =
  | { kind: 'termination_proof'; proof: { executionEnded: boolean; enterNeverCalled: boolean; senderProcessNonce: string; recordedAt: number } };

/**
 * owner 通道事实校验：只允许备注与有归属观察。
 * termination_proof 不能从 owner 通道提交（F7/静态缺口4）——受信 sender
 * 终态只走内部入口（reconcileFromSender），防止任意伪造的「未发送证明」。
 */
export function validateFactInput(value: unknown): ValidationResult<FactInput> {
  if (!isObject(value)) return { ok: false, error: '核对事实必须是对象' };
  if (value.kind === 'termination_proof') {
    return { ok: false, error: 'termination_proof 不能从 owner 通道提交；须由受信 sender 查询入口核实' };
  }
  if (value.kind === 'owner_observation') {
    if (value.source !== 'owner' && value.source !== 'designated-viewer') return { ok: false, error: '观察来源无效' };
    if (value.attributionStrength !== 'direct' && value.attributionStrength !== 'indirect') return { ok: false, error: '归属强度无效' };
    if (!safeInteger(value.observedAt)) return { ok: false, error: '观察时间无效' };
    if (!hexDigest64(value.textDigest)) return { ok: false, error: '观察文本摘要无效' };
    if (!boundedString(value.accountHint, 128) || !boundedString(value.roomHint, 64)) return { ok: false, error: '观察账号/房间提示无效' };
    return { ok: true, value: value as unknown as Extract<FactInput, { kind: 'owner_observation' }> };
  }
  if (value.kind === 'note') {
    if (!boundedString(value.note, 500)) return { ok: false, error: '备注无效' };
    return { ok: true, value: { kind: 'note', note: value.note } };
  }
  return { ok: false, error: '核对事实类型未知' };
}

/** 内部受信通道事实校验（仅 termination_proof，由 reconcileFromSender 使用）。 */
export function validateInternalFactInput(value: unknown): ValidationResult<InternalFactInput> {
  if (!isObject(value) || value.kind !== 'termination_proof') {
    return { ok: false, error: '内部通道只接受 termination_proof' };
  }
  const proof = value.proof;
  if (!isObject(proof) || typeof proof.executionEnded !== 'boolean' || typeof proof.enterNeverCalled !== 'boolean'
    || !boundedString(proof.senderProcessNonce, 128) || !safeInteger(proof.recordedAt)) {
    return { ok: false, error: '终态证明形状无效' };
  }
  return { ok: true, value: value as unknown as InternalFactInput };
}

export type AppendFactResult =
  | { ok: true; settled: boolean; conflict: boolean; operation: OriginalOperation }
  | { ok: false; error: string };

function validStoredFact(value: unknown, binding: Record<string, unknown>, textDigest: string, createdAt: number): boolean {
  if (!isObject(value) || !boundedString(value.factId, 128) || !safeInteger(value.createdAt)) return false;
  const keys = ['factId', 'kind', 'source', 'attributionStrength', 'observedAt', 'textDigest', 'accountHint', 'roomHint', 'proof', 'note', 'createdAt'];
  if (Object.keys(value).length !== keys.length || keys.some((key) => !(key in value))) return false;
  if (value.kind === 'note') {
    return boundedString(value.note, 500) && value.source === null && value.attributionStrength === null
      && value.observedAt === null && value.textDigest === null && value.accountHint === null && value.roomHint === null && value.proof === null;
  }
  if (value.kind === 'termination_proof') {
    const proof = value.proof;
    return value.source === 'lifecycle' && value.attributionStrength === null && value.observedAt === null
      && value.textDigest === null && value.accountHint === null && value.roomHint === null && value.note === null
      && isObject(proof) && typeof proof.executionEnded === 'boolean' && typeof proof.enterNeverCalled === 'boolean'
      && proof.senderProcessNonce === binding.senderProcessNonce && safeInteger(proof.recordedAt);
  }
  if (value.kind === 'owner_observation') {
    return (value.source === 'owner' || value.source === 'designated-viewer')
      && (value.attributionStrength === 'direct' || value.attributionStrength === 'indirect')
      && safeInteger(value.observedAt) && value.observedAt >= createdAt && value.textDigest === textDigest
      && value.accountHint === binding.principalUid && value.roomHint === binding.roomId && value.proof === null && value.note === null;
  }
  return false;
}

export function validateOperationRecord(value: unknown): ValidationResult<OriginalOperation> {
  if (!isObject(value)) return { ok: false, error: '操作记录必须是对象' };
  const allowedKeys = [
    'schemaVersion', 'requestId', 'sourceKey', 'binding', 'textDigest', 'textLength', 'phase', 'outcome',
    'outcomeReason', 'enterAttempted', 'pageSubmitted', 'senderProofApplied', 'conflictOpen', 'facts',
    'createdAt', 'updatedAt', 'tombstone',
  ];
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) return { ok: false, error: '记录包含未知字段' };
  if (value.schemaVersion !== 1) return { ok: false, error: '记录版本不支持' };
  if (!boundedString(value.requestId, 128)) return { ok: false, error: 'requestId 无效' };
  if (value.sourceKey !== null && !boundedString(value.sourceKey, 200)) return { ok: false, error: 'sourceKey 无效' };
  const binding = value.binding;
  if (!isObject(binding) || !isValidPrincipalUidField(binding.principalUid) || typeof binding.roomId !== 'string'
    || !/^[0-9]{1,64}$/.test(binding.roomId) || !boundedString(binding.grantId, 128) || !boundedString(binding.liveEpoch, 128)
    || !boundedString(binding.senderSessionId, 128) || !boundedString(binding.senderProcessNonce, 128)
    || !safeInteger(binding.inputConnectionGeneration) || !safeInteger(binding.identityGeneration)) {
    return { ok: false, error: '绑定元数据无效' };
  }
  if (!hexDigest64(value.textDigest)) return { ok: false, error: '文本摘要无效' };
  if (!safeInteger(value.textLength)) return { ok: false, error: '文本长度无效' };
  if (!['queued', 'dispatching', 'dispatched'].includes(String(value.phase))) return { ok: false, error: 'phase 无效' };
  if (value.outcome !== null && !['unknown', 'terminal_not_dispatched'].includes(String(value.outcome))) return { ok: false, error: 'outcome 无效' };
  if (value.outcomeReason !== null && !boundedString(value.outcomeReason, 200)) return { ok: false, error: 'outcomeReason 无效' };
  if (typeof value.enterAttempted !== 'boolean' || typeof value.pageSubmitted !== 'boolean'
    || typeof value.senderProofApplied !== 'boolean' || typeof value.tombstone !== 'boolean'
    || typeof value.conflictOpen !== 'boolean') {
    return { ok: false, error: '布尔字段无效' };
  }
  if (!Array.isArray(value.facts)) return { ok: false, error: 'facts 必须是数组' };
  if (!safeInteger(value.createdAt) || !safeInteger(value.updatedAt)) return { ok: false, error: '时间字段无效' };
  if (!value.facts.every((fact) => validStoredFact(fact, binding, value.textDigest as string, value.createdAt as number))) return { ok: false, error: '核对事实无效' };
  if (value.outcome === 'terminal_not_dispatched' && (value.enterAttempted || value.pageSubmitted || value.conflictOpen)) return { ok: false, error: '未派发状态与执行事实冲突' };
  if (value.tombstone !== true) return { ok: false, error: '原操作 tombstone 缺失' };
  return { ok: true, value: value as unknown as OriginalOperation };
}

function isValidPrincipalUidField(value: unknown): boolean {
  return typeof value === 'string' && /^[0-9]{1,32}$/.test(value);
}

export interface DispatchOutcomeInput {
  kind: 'terminal_not_dispatched' | 'dispatched' | 'transport_unknown';
  reason: string;
  /** terminal_not_dispatched 必须来自受信 v1 sender 响应。 */
  trustedSender: boolean;
  proof?: { executionEnded: boolean; enterNeverCalled: boolean; senderProcessNonce: string; recordedAt: number };
  pageSubmitted?: boolean;
}

/**
 * 派发结果结算。规则：
 *  - terminal_not_dispatched 仅在受信 sender 证明 executionEnded && enterNeverCalled 时接受。
 *  - dispatched：Enter 已调用，页面已提交（若得知），outcome 仍 unknown。
 *  - transport_unknown：超时/5xx/断连/重定向/协议错误/不可信响应，一律 unknown。
 */
export function applyDispatchOutcome(operation: OriginalOperation, input: DispatchOutcomeInput, now: number): OriginalOperation {
  const next: OriginalOperation = { ...operation, facts: [...operation.facts], updatedAt: now };
  if (input.kind === 'terminal_not_dispatched') {
    const proof = input.proof;
    const trusted = input.trustedSender && proof !== undefined
      && proof.senderProcessNonce === operation.binding.senderProcessNonce
      && proof.executionEnded === true && proof.enterNeverCalled === true;
    if (trusted) {
      next.phase = 'dispatched';
      next.outcome = 'terminal_not_dispatched';
      next.outcomeReason = input.reason;
      next.senderProofApplied = true;
      next.enterAttempted = false;
      return next;
    }
    // 证明不完整或不来自受信通道：一律保守 unknown，不得结算为未执行。
    next.phase = 'dispatched';
    next.outcome = 'unknown';
    next.outcomeReason = `untrusted_not_dispatched_claim:${input.reason}`;
    next.senderProofApplied = false;
    return next;
  }
  if (input.kind === 'dispatched') {
    next.phase = 'dispatched';
    next.enterAttempted = true;
    next.pageSubmitted = input.pageSubmitted === true;
    next.outcome = 'unknown';
    next.outcomeReason = input.reason;
    return next;
  }
  // transport_unknown：不推断 Enter 是否已调用，保持保守未知。
  next.phase = 'dispatched';
  next.outcome = 'unknown';
  next.outcomeReason = input.reason;
  return next;
}

let factSequence = 0;
function newFactId(now: number): string {
  factSequence = (factSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `fact-${now}-${factSequence}`;
}

/**
 * 追加核对事实。备注永不结算；观察单独记录不改变 outcome；
 * 受信终止证明（内部通道）只在无 page_submitted 冲突证据时把 unknown
 * 细化为 terminal_not_dispatched；冲突一律保留 unknown 并置 conflictOpen。
 */
export function appendFact(operation: OriginalOperation, input: FactInput | InternalFactInput, now: number): AppendFactResult {
  if (input.kind === 'termination_proof' && input.proof.senderProcessNonce !== operation.binding.senderProcessNonce) {
    return { ok: false, error: 'sender nonce 与原操作不符' };
  }
  if (input.kind === 'owner_observation' && (input.accountHint !== operation.binding.principalUid
    || input.roomHint !== operation.binding.roomId || input.textDigest !== operation.textDigest
    || input.observedAt < operation.createdAt)) {
    return { ok: false, error: '观察事实与原操作不匹配' };
  }
  const fact: VerificationFact = {
    factId: newFactId(now),
    kind: input.kind,
    source: input.kind === 'owner_observation' ? input.source : input.kind === 'termination_proof' ? 'lifecycle' : null,
    attributionStrength: input.kind === 'owner_observation' ? input.attributionStrength : null,
    observedAt: input.kind === 'owner_observation' ? input.observedAt : null,
    textDigest: input.kind === 'owner_observation' ? input.textDigest : null,
    accountHint: input.kind === 'owner_observation' ? input.accountHint : null,
    roomHint: input.kind === 'owner_observation' ? input.roomHint : null,
    proof: input.kind === 'termination_proof' ? input.proof : null,
    note: input.kind === 'note' ? input.note : null,
    createdAt: now,
  };
  const next: OriginalOperation = { ...operation, facts: [...operation.facts, fact], updatedAt: now };
  if (input.kind !== 'termination_proof') {
    return { ok: true, settled: false, conflict: false, operation: next };
  }
  if (next.outcome !== 'unknown') {
    return { ok: true, settled: false, conflict: false, operation: next };
  }
  const trustedTerminated = input.proof.executionEnded === true;
  const enterNeverCalled = input.proof.enterNeverCalled === true;
  if (!trustedTerminated) {
    // 原执行还活：继续 hold，事实仅追加。
    return { ok: true, settled: false, conflict: false, operation: next };
  }
  if (next.pageSubmitted || next.enterAttempted) {
    // 已有页面提交证据与「从未 Enter」冲突：保留 unknown，标记冲突未决。
    return { ok: true, settled: false, conflict: true, operation: { ...next, conflictOpen: true } };
  }
  if (!enterNeverCalled) {
    return { ok: true, settled: false, conflict: false, operation: next };
  }
  const settledOperation: OriginalOperation = {
    ...next,
    outcome: 'terminal_not_dispatched',
    outcomeReason: 'sender-termination-proof',
    senderProofApplied: true,
    enterAttempted: false,
  };
  return { ok: true, settled: true, conflict: false, operation: settledOperation };
}

/** 重启恢复：dispatching 未知落定 → unknown；进程 nonce 变化不证明旧执行终止。 */
export function applyRestartRecovery(operation: OriginalOperation, now: number, previousProcessNonce: string | null): OriginalOperation {
  if (operation.outcome !== null && operation.phase !== 'dispatching') return operation;
  if (operation.outcome === 'terminal_not_dispatched') return operation;
  const next: OriginalOperation = { ...operation, facts: [...operation.facts], updatedAt: now };
  const needsConversion = next.outcome === null || next.phase === 'dispatching';
  if (!needsConversion) return next;
  next.phase = 'dispatched';
  next.outcome = 'unknown';
  next.outcomeReason = previousProcessNonce === null ? 'l-restart' : `l-restart:${previousProcessNonce}`;
  next.senderProofApplied = false;
  return next;
}

export interface ReconciliationState {
  safeToResume: boolean;
  blockingRequestIds: string[];
}

/**
 * hold 释放条件（联合恢复规则）：
 *  - 明确未执行（terminal_not_dispatched，受信 sender 证明）：可恢复。
 *  - 仍 unknown：需要「受信原执行已终止」事实 + 至少一条 owner/指定观众
 *    的正面观察关联，且没有未决冲突；仅 executionEnded 不够。
 * 本增量没有「承担风险后直接解除 unknown」入口；证据缺失、冲突未决或
 * 原执行未终止都继续 hold。原请求/sourceKey 永不重发与此无关。
 */
export function reconcileHold(operations: OriginalOperation[]): ReconciliationState {
  const blocking: string[] = [];
  for (const operation of operations) {
    if (operation.outcome === 'terminal_not_dispatched') continue;
    const terminated = operation.facts.some(
      (fact) => fact.kind === 'termination_proof' && fact.proof !== null && fact.proof.executionEnded === true
        && fact.proof.senderProcessNonce === operation.binding.senderProcessNonce,
    );
    const observed = operation.facts.some((fact) => fact.kind === 'owner_observation'
      && fact.accountHint === operation.binding.principalUid && fact.roomHint === operation.binding.roomId
      && fact.textDigest === operation.textDigest && fact.observedAt !== null && fact.observedAt >= operation.createdAt);
    if (!terminated || !observed || operation.conflictOpen) {
      blocking.push(operation.requestId);
    }
  }
  return { safeToResume: blocking.length === 0, blockingRequestIds: blocking };
}
