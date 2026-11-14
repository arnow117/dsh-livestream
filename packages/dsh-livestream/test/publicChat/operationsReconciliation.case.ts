/** 原操作核对与 unknown 边界（FEAT-008 API-6/7 / P1-04）。 */
import { describe, expect, it } from 'vitest';
import {
  appendFact, applyDispatchOutcome, applyRestartRecovery, reconcileHold, validateFactInput,
  type OriginalOperation,
} from '../../src/publicChat/operations';
import { PublicChatOperationJournal } from '../../src/publicChat/journal';
import { FrozenPublicChatOperationJournal, messageReference } from '../../src/publicChat/frozenJournal';
import { PublicChatSendController } from '../../src/publicChat/controller';
import { makeFrozenTestGateway, successfulOperation } from './frozenTestGateway';
import { makeFakeGateway, makeTempDir, testGrantSnapshot, TEST_BUILD_DIGEST, TEST_INSTANCE_ID, TEST_ROOM_ID, TEST_ACCOUNT_RECORD_ID, TEST_PRINCIPAL_UID, TEST_LIVE_EPOCH, digestOf, waitFor } from './test-helpers';

const DEPLOYMENT = {
  expectedPrincipalUid: TEST_PRINCIPAL_UID,
  roomId: TEST_ROOM_ID,
  accountRecordId: TEST_ACCOUNT_RECORD_ID,
  buildDigest: TEST_BUILD_DIGEST,
  instanceId: TEST_INSTANCE_ID,
};

function baseOperation(): OriginalOperation {
  return {
    schemaVersion: 1,
    requestId: 'req-1',
    sourceKey: 'sk-1',
    binding: {
      principalUid: TEST_PRINCIPAL_UID,
      roomId: TEST_ROOM_ID,
      grantId: 'grant-1',
      liveEpoch: TEST_LIVE_EPOCH,
      senderSessionId: 'session-1',
      senderProcessNonce: 'sender-nonce-1',
      inputConnectionGeneration: 1,
      identityGeneration: 3,
      snapshot: testGrantSnapshot(),
    },
    textDigest: digestOf('第一条'),
    textLength: 3,
    phase: 'dispatched',
    outcome: 'unknown',
    outcomeReason: 'transport:timeout',
    enterAttempted: false,
    pageSubmitted: false,
    senderProofApplied: false,
    conflictOpen: false,
    facts: [],
    createdAt: 1_000,
    updatedAt: 1_000,
    tombstone: true,
  };
}

describe('核对事实', () => {
  it('备注/「没看到」类 note 永不结算 unknown', () => {
    const op = baseOperation();
    const result = appendFact(op, { kind: 'note', note: '当前公屏没有看到这条消息' }, 2_000);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('appendFact failed');
    expect(result.settled).toBe(false);
    if (result.ok) {
      expect(result.operation.outcome).toBe('unknown');
      expect(result.operation.facts[result.operation.facts.length - 1].kind).toBe('note');
    }
  });

  it('正面人工观察单独记录，不改写 outcome，不写成 not_sent 或平台 receipt', () => {
    const op = baseOperation();
    const fact = validateFactInput({
      kind: 'owner_observation',
      source: 'designated-viewer',
      attributionStrength: 'direct',
      observedAt: 1_900,
      textDigest: digestOf('第一条'),
      accountHint: TEST_PRINCIPAL_UID,
      roomHint: TEST_ROOM_ID,
    });
    expect(fact.ok).toBe(true);
    const result = appendFact(op, fact.ok ? fact.value : { kind: 'note', note: '' }, 2_000);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('appendFact failed');
    expect(result.settled).toBe(false);
    if (result.ok) {
      const observation = result.operation.facts[result.operation.facts.length - 1];
      expect(observation.kind).toBe('owner_observation');
      expect(observation.source).toBe('designated-viewer');
      expect(result.operation.outcome).toBe('unknown');
    }
  });

  it('受信终止证明（原执行终止且从未 Enter）把 unknown 细化为 terminal_not_dispatched', () => {
    const op = baseOperation();
    const result = appendFact(op, {
      kind: 'termination_proof',
      proof: { executionEnded: true, enterNeverCalled: true, senderProcessNonce: 'sender-nonce-1', recordedAt: 2_100 },
    }, 2_200);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('appendFact failed');
    expect(result.settled).toBe(true);
    if (result.ok) {
      expect(result.operation.outcome).toBe('terminal_not_dispatched');
      expect(result.operation.senderProofApplied).toBe(true);
    }
  });

  it('原执行还活（executionEnded=false）继续 hold；不伪造终态', () => {
    const op = baseOperation();
    const result = appendFact(op, {
      kind: 'termination_proof',
      proof: { executionEnded: false, enterNeverCalled: true, senderProcessNonce: 'sender-nonce-1', recordedAt: 2_100 },
    }, 2_200);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('appendFact failed');
    expect(result.settled).toBe(false);
    if (result.ok) expect(result.operation.outcome).toBe('unknown');
  });

  it('页面已提交与「从未 Enter」冲突：保留 unknown，冲突标记返回', () => {
    const op = baseOperation();
    op.pageSubmitted = true;
    const result = appendFact(op, {
      kind: 'termination_proof',
      proof: { executionEnded: true, enterNeverCalled: true, senderProcessNonce: 'sender-nonce-1', recordedAt: 2_100 },
    }, 2_200);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('appendFact failed');
    expect(result.settled).toBe(false);
    expect(result.conflict).toBe(true);
    if (result.ok) expect(result.operation.outcome).toBe('unknown');
  });

  it('Enter 已调用后未知：终止证明不能把它结算为未执行', () => {
    const op = baseOperation();
    op.enterAttempted = true;
    const result = appendFact(op, {
      kind: 'termination_proof',
      proof: { executionEnded: true, enterNeverCalled: false, senderProcessNonce: 'sender-nonce-1', recordedAt: 2_100 },
    }, 2_200);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('appendFact failed');
    expect(result.settled).toBe(false);
    if (result.ok) expect(result.operation.outcome).toBe('unknown');
  });
});

describe('派发结果结算', () => {
  it('transport 失败一律 unknown；不推断 Enter 是否已调用', () => {
    const op = baseOperation();
    op.phase = 'dispatching';
    op.outcome = null;
    const next = applyDispatchOutcome(op, { kind: 'transport_unknown', reason: 'transport:5xx', trustedSender: false }, 2_000);
    expect(next.outcome).toBe('unknown');
    expect(next.phase).toBe('dispatched');
  });

  it('不受信的 not-dispatched 声明按 unknown 处理', () => {
    const op = baseOperation();
    op.phase = 'dispatching';
    op.outcome = null;
    const next = applyDispatchOutcome(op, {
      kind: 'terminal_not_dispatched',
      reason: 'claim',
      trustedSender: false,
      proof: { executionEnded: true, enterNeverCalled: true, senderProcessNonce: 'x', recordedAt: 2_000 },
    }, 2_000);
    expect(next.outcome).toBe('unknown');
    expect(next.outcomeReason).toContain('untrusted_not_dispatched_claim');
  });
});

describe('重启恢复', () => {
  it('dispatching 未知落定 → unknown；进程 nonce 变化不证明旧执行终止', () => {
    const op = baseOperation();
    op.phase = 'dispatching';
    op.outcome = null;
    const next = applyRestartRecovery(op, 3_000, null);
    expect(next.outcome).toBe('unknown');
    expect(next.outcomeReason).toBe('l-restart');
    expect(next.senderProofApplied).toBe(false);
  });

  it('重启后新进程空表不能作为 not_found=未发送', () => {
    const op = baseOperation();
    const next = applyRestartRecovery(op, 3_000, 'old-nonce');
    expect(next.outcome).toBe('unknown');
  });

  it('journal 损坏时控制器整体 hold，发送不可用', async () => {
    const dir = makeTempDir('pubchat-corrupt').directory;
    const { writeFileSync } = await import('node:fs');
    writeFileSync(`${dir}/public-chat-operations.json`, '{not-json', { mode: 0o600 });
    const journal = new PublicChatOperationJournal(dir);
    expect(journal.corrupt).toBe(true);
    const gateway = makeFakeGateway({ sendResults: [() => ({ status: 'dispatched', enterAttempted: true, pageSubmitted: true })] });
    const controller = new PublicChatSendController({
      deployment: DEPLOYMENT, gateway, journal,
      bounds: { queueLimit: 10, queueWaitMs: 5_000, dispatchIntervalMs: 5, httpTimeoutMs: 1_000 },
    });
    expect(controller.hold).toBe(true);
    const result = await controller.submit({ requestId: 'req-x', sourceKey: null, text: '普通文字' });
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') expect(result.reason).toBe('journal-unavailable');
    expect(gateway.calls.sends.length).toBe(0);
  });

  it('重启后 dispatching 记录转 unknown，授权不恢复、队列不重放；解除 hold 需受信终止事实', async () => {
    const dir = makeTempDir('pubchat-restart').directory;
    // 先造一个含 dispatching 记录的 journal（模拟上次进程崩溃时的落盘状态）。
    const pre = new PublicChatOperationJournal(dir);
    const op = baseOperation();
    op.phase = 'dispatching';
    op.outcome = null;
    pre.records = [op];
    pre.write();
    // 重启：新控制器加载该 journal。
    const gateway = makeFakeGateway({
      sendResults: [() => ({ status: 'dispatched', enterAttempted: true, pageSubmitted: true })],
    });
    const snapshot = op.binding.snapshot!;
    gateway.operation = async () => ({ ok: true as const, value: { found: true as const, requestId: op.requestId,
      sourceKey: op.sourceKey, binding: { ...snapshot, processNonce: snapshot.senderProcessNonce, identityGeneration: snapshot.identityEpoch },
      senderProcessNonce: snapshot.senderProcessNonce, enterAttempted: true, executionTerminated: true,
      enterNeverCalled: false, pageSubmitted: false, finishedAt: Date.now() } });
    const restarted = new PublicChatSendController({
      deployment: DEPLOYMENT, gateway, journal: new PublicChatOperationJournal(dir),
      bounds: { queueLimit: 10, queueWaitMs: 5_000, dispatchIntervalMs: 5, httpTimeoutMs: 1_000 },
    });
    expect(restarted.hold).toBe(true);
    expect(restarted.operationView('req-1')?.outcome).toBe('unknown');
    const state = restarted.requestResumeAfterReconciliation();
    expect(state.safeToResume).toBe(false);
    expect(state.blockingRequestIds).toEqual(['req-1']);
    // owner 通道不能提交 termination_proof：受信终态只走内部 sender 查询入口。
    const forged = restarted.recordVerificationFact({
      requestId: 'req-1',
      principalUid: TEST_PRINCIPAL_UID,
      roomId: TEST_ROOM_ID,
      grantId: 'grant-1',
      liveEpoch: TEST_LIVE_EPOCH,
      inputConnectionGeneration: 1,
      fact: { kind: 'termination_proof', proof: { executionEnded: true, enterNeverCalled: true, senderProcessNonce: 'sender-nonce-2', recordedAt: 4_000 } },
    });
    expect(forged.ok).toBe(false);
    // 受信查询：sender 记录 nonce 与持久化原 nonce 一致 → 终态事实可追加。
    const reconciled = await restarted.reconcileFromSender('req-1');
    expect(reconciled.ok).toBe(true);
    expect(reconciled.reason).toBe('recorded');
    // 联合恢复规则：unknown + 终止事实仍需正面观察才可恢复。
    const stillBlocked = restarted.requestResumeAfterReconciliation();
    expect(stillBlocked.safeToResume).toBe(false);
    const observation = restarted.recordVerificationFact({
      requestId: 'req-1',
      principalUid: TEST_PRINCIPAL_UID,
      roomId: TEST_ROOM_ID,
      grantId: 'grant-1',
      liveEpoch: TEST_LIVE_EPOCH,
      inputConnectionGeneration: 1,
      fact: { kind: 'owner_observation', source: 'designated-viewer', attributionStrength: 'direct', observedAt: Date.now(), textDigest: digestOf('第一条'), accountHint: TEST_PRINCIPAL_UID, roomHint: TEST_ROOM_ID },
    });
    expect(observation.ok).toBe(true);
    const resumed = restarted.requestResumeAfterReconciliation();
    expect(resumed.safeToResume).toBe(true);
    expect(restarted.hold).toBe(false);
  });
});

describe('迟到结果与冲突保留', () => {
  it('迟到的终止事实追加到原记录，不覆盖既有事实', () => {
    const first = appendFact(baseOperation(), { kind: 'note', note: '第一次核对备注' }, 2_000);
    if (!first.ok) throw new Error('fixture append failed');
    const second = appendFact(first.operation, {
      kind: 'termination_proof',
      proof: { executionEnded: true, enterNeverCalled: true, senderProcessNonce: 'sender-nonce-1', recordedAt: 5_000 },
    }, 6_000);
    if (!second.ok) throw new Error('fixture append failed');
    expect(second.operation.facts.length).toBe(2);
    expect(second.operation.facts[0].kind).toBe('note');
    expect(second.operation.facts[1].kind).toBe('termination_proof');
    expect(second.operation.outcome).toBe('terminal_not_dispatched');
  });
});

describe('controller 引用绑定校验', () => {
  it('引用主体/房间/代次与原操作不符时拒绝', async () => {
    const startedAt = Date.now() - 1000;
    const gateway = makeFrozenTestGateway(startedAt);
    gateway.setSend(async (request) => ({ ok: true, value: { ...successfulOperation(request), state: 'unknown' } }));
    const dir = makeTempDir('pubchat-ref').directory;
    const controller = new PublicChatSendController({
      deployment: DEPLOYMENT, gateway: gateway.gateway, journal: new FrozenPublicChatOperationJournal(dir),
      bounds: { queueLimit: 10, queueWaitMs: 5_000, dispatchIntervalMs: 5, httpTimeoutMs: 1_000 },
    });
    controller.advanceInputConnection();
    controller.setLiveEpoch(TEST_LIVE_EPOCH, startedAt);
    expect((await controller.refreshQualification()).ok).toBe(true);
    expect((await controller.authorize()).ok).toBe(true);
    await controller.submit({ requestId: 'req-1', sourceKey: 'sk-1', text: '第一条' });
    await waitFor(() => controller.frozenOperationView('req-1')?.state === 'unknown');
    const original = controller.frozenOperationView('req-1')!;
    const ref = messageReference(original);
    const wrongPrincipal = controller.recordVerificationFact({
      requestId: 'req-1',
      principalUid: '0000000000000000001',
      roomId: TEST_ROOM_ID,
      grantId: original.grant.grantId,
      liveEpoch: TEST_LIVE_EPOCH,
      inputConnectionGeneration: 1,
      ref,
      factId: 'wrong-reference',
      fact: { kind: 'note', note: 'x' },
    });
    expect(wrongPrincipal.ok).toBe(false);
    const rightReference = controller.recordVerificationFact({
      requestId: 'req-1',
      principalUid: TEST_PRINCIPAL_UID,
      roomId: TEST_ROOM_ID,
      grantId: original.grant.grantId,
      liveEpoch: TEST_LIVE_EPOCH,
      inputConnectionGeneration: 1,
      ref,
      factId: 'right-reference',
      fact: { kind: 'note', note: '核对备注' },
    });
    expect(rightReference.ok).toBe(true);
  });
});

describe('original execution identity', () => {
  it('does not accept a terminal proof from a different sender process', () => {
    const op = baseOperation();
    const direct = applyDispatchOutcome(op, {
      kind: 'terminal_not_dispatched', reason: 'test', trustedSender: true,
      proof: { executionEnded: true, enterNeverCalled: true, senderProcessNonce: 'different', recordedAt: 2100 },
    }, 2200);
    expect(direct.outcome).toBe('unknown');
    const fact = appendFact(op, {
      kind: 'termination_proof',
      proof: { executionEnded: true, enterNeverCalled: true, senderProcessNonce: 'different', recordedAt: 2100 },
    }, 2200);
    expect(fact.ok).toBe(false);
  });
});
