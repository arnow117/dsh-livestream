/**
 * unknown 事实可信性（静态缺口4）正式回归：owner 通道不能伪造
 * termination_proof；受信终态走内部入口并核对持久化的原 sender nonce；
 * hold 恢复需要「原执行终止 + 正面观察」或明确未执行，冲突未决继续 hold。
 */
import { describe, expect, it } from 'vitest';
import {
  appendFact, reconcileHold, validateFactInput, validateInternalFactInput,
  type OriginalOperation,
} from '../../src/publicChat/operations';
import { FrozenPublicChatOperationJournal, messageReference } from '../../src/publicChat/frozenJournal';
import { PublicChatSendController } from '../../src/publicChat/controller';
import { makeFrozenTestGateway, successfulOperation } from './frozenTestGateway';
import { makeTempDir, testGrantSnapshot, TEST_BUILD_DIGEST, TEST_INSTANCE_ID, TEST_ROOM_ID, TEST_ACCOUNT_RECORD_ID, TEST_PRINCIPAL_UID, TEST_LIVE_EPOCH, TEST_SENDER_NONCE, digestOf, waitFor } from './test-helpers';

const DEPLOYMENT = {
  expectedPrincipalUid: TEST_PRINCIPAL_UID,
  roomId: TEST_ROOM_ID,
  accountRecordId: TEST_ACCOUNT_RECORD_ID,
  buildDigest: TEST_BUILD_DIGEST,
  instanceId: TEST_INSTANCE_ID,
};

const BOUNDS = { queueLimit: 10, queueWaitMs: 5_000, dispatchIntervalMs: 5, httpTimeoutMs: 1_000 };

function baseOperation(): OriginalOperation {
  return {
    schemaVersion: 1,
    requestId: 'req-1',
    sourceKey: 'sk-1',
    binding: {
      principalUid: TEST_PRINCIPAL_UID,
      roomId: TEST_ROOM_ID,
      grantId: 'grant-token-1',
      liveEpoch: TEST_LIVE_EPOCH,
      senderSessionId: 'session-1',
      senderProcessNonce: TEST_SENDER_NONCE,
      inputConnectionGeneration: 1,
      identityGeneration: 3,
      snapshot: testGrantSnapshot({ grantId: 'grant-token-1' }),
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

describe('owner 通道事实限制', () => {
  it('owner 提交 termination_proof 被拒绝（不可伪造未发送证明）', () => {
    const result = validateFactInput({
      kind: 'termination_proof',
      proof: { executionEnded: true, enterNeverCalled: true, senderProcessNonce: TEST_SENDER_NONCE, recordedAt: 2_000 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('owner 通道');
  });

  it('内部通道只接受 termination_proof；备注/观察不走内部入口', () => {
    expect(validateInternalFactInput({ kind: 'note', note: 'x' }).ok).toBe(false);
    const proof = validateInternalFactInput({
      kind: 'termination_proof',
      proof: { executionEnded: true, enterNeverCalled: true, senderProcessNonce: TEST_SENDER_NONCE, recordedAt: 2_000 },
    });
    expect(proof.ok).toBe(true);
  });

  it('controller 公开事实入口拒绝 termination_proof（真实控制器路径）', async () => {
    const startedAt = Date.now() - 1000;
    const gateway = makeFrozenTestGateway(startedAt);
    gateway.setSend(async (request) => ({ ok: true, value: { ...successfulOperation(request), state: 'unknown' } }));
    const dir = makeTempDir('pubchat-trust').directory;
    const controller = new PublicChatSendController({ deployment: DEPLOYMENT, gateway: gateway.gateway, journal: new FrozenPublicChatOperationJournal(dir), bounds: BOUNDS });
    controller.advanceInputConnection();
    controller.setLiveEpoch(TEST_LIVE_EPOCH, startedAt);
    expect((await controller.refreshQualification()).ok).toBe(true);
    expect((await controller.authorize()).ok).toBe(true);
    await controller.submit({ requestId: 'req-1', sourceKey: null, text: '第一条' });
    await waitFor(() => controller.frozenOperationView('req-1')?.state === 'unknown');
    const original = controller.frozenOperationView('req-1')!;
    const reference = messageReference(original);
    const forged = controller.recordVerificationFact({
      requestId: 'req-1',
      principalUid: TEST_PRINCIPAL_UID,
      roomId: TEST_ROOM_ID,
      grantId: original.grant.grantId,
      liveEpoch: TEST_LIVE_EPOCH,
      inputConnectionGeneration: 1,
      ref: reference,
      factId: 'forged',
      fact: { kind: 'termination_proof', proof: { executionEnded: true, enterNeverCalled: true, senderProcessNonce: TEST_SENDER_NONCE, recordedAt: Date.now() } },
    });
    expect(forged.ok).toBe(false);
    expect(controller.frozenOperationView('req-1')?.facts).toHaveLength(0);
    // 备注与观察仍可提交。
    const note = controller.recordVerificationFact({
      requestId: 'req-1',
      principalUid: TEST_PRINCIPAL_UID,
      roomId: TEST_ROOM_ID,
      grantId: original.grant.grantId,
      liveEpoch: TEST_LIVE_EPOCH,
      inputConnectionGeneration: 1,
      ref: reference,
      factId: 'note',
      fact: { kind: 'note', note: '当前公屏没有看到' },
    });
    expect(note.ok).toBe(true);
  });
});

describe('受信终态的 nonce 核对与联合恢复', () => {
  it('sender 记录 nonce 与持久化原 nonce 不一致：不构成终态，保持 hold', async () => {
    const startedAt = Date.now() - 1000;
    const gateway = makeFrozenTestGateway(startedAt);
    gateway.setSend(async () => ({ ok: false, error: 'sender 响应超时', untrusted: false }));
    const dir = makeTempDir('pubchat-trust2').directory;
    const controller = new PublicChatSendController({ deployment: DEPLOYMENT, gateway: gateway.gateway, journal: new FrozenPublicChatOperationJournal(dir), bounds: BOUNDS });
    controller.advanceInputConnection();
    controller.setLiveEpoch(TEST_LIVE_EPOCH, startedAt);
    expect((await controller.refreshQualification()).ok).toBe(true);
    expect((await controller.authorize()).ok).toBe(true);
    await controller.submit({ requestId: 'req-1', sourceKey: null, text: '第一条' });
    await waitFor(() => controller.frozenOperationView('req-1')?.state === 'unknown');
    const op = controller.frozenOperationView('req-1')!;
    expect(op.grant.senderProcessNonce).toBe(TEST_SENDER_NONCE);
    // 查询返回的记录属于另一进程（nonce 不同）：不得结算。
    gateway.gateway.frozenOperation = async () => {
      const wire = successfulOperation(gateway.calls.sends[0]);
      return { ok: true as const, value: { ...wire, state: 'unknown' as const,
        grant: { ...wire.grant, senderProcessNonce: 'different-process-nonce' } } };
    };
    const reconcile = await controller.reconcileFromSender('req-1');
    expect(reconcile.ok).toBe(false);
    expect(controller.frozenOperationView('req-1')?.state).toBe('unknown');
    // 即使伪造「执行已终止」观察也救不回来：缺正面观察且 nonce 不符。
    controller.recordVerificationFact({
      requestId: 'req-1',
      principalUid: TEST_PRINCIPAL_UID,
      roomId: TEST_ROOM_ID,
      grantId: op.grant.grantId,
      liveEpoch: TEST_LIVE_EPOCH,
      inputConnectionGeneration: 1,
      ref: messageReference(op),
      factId: 'forged-observation',
      fact: { kind: 'owner_observation', source: 'owner', attributionStrength: 'direct', observedAt: Date.now(), textDigest: digestOf('第一条'), accountHint: TEST_PRINCIPAL_UID, roomHint: TEST_ROOM_ID },
    });
    // nonce 不一致 → 没有「终止」受信事实 → 仍 hold。
    const state = controller.requestResumeAfterReconciliation();
    expect(state.safeToResume).toBe(false);
  });

  it('联合恢复：unknown + 受信终止 + 正面观察 → 可恢复；缺观察或冲突 → 继续 hold', () => {
    // (a) unknown + 终止 + 观察：可恢复。
    const opA = baseOperation();
    const terminated = appendFact(opA, { kind: 'termination_proof', proof: { executionEnded: true, enterNeverCalled: false, senderProcessNonce: TEST_SENDER_NONCE, recordedAt: 2_000 } }, 2_100);
    if (!terminated.ok) throw new Error('fixture failed');
    const observed = appendFact(terminated.operation, { kind: 'owner_observation', source: 'designated-viewer', attributionStrength: 'direct', observedAt: 2_050, textDigest: digestOf('第一条'), accountHint: TEST_PRINCIPAL_UID, roomHint: TEST_ROOM_ID }, 2_200);
    if (!observed.ok) throw new Error('fixture failed');
    expect(reconcileHold([observed.operation]).safeToResume).toBe(true);

    // (b) unknown + 仅终止（无观察）：继续 hold（不能仅 executionEnded）。
    expect(reconcileHold([terminated.operation]).safeToResume).toBe(false);

    // (c) 页面已提交 + 「从未 Enter」终止证明：冲突置位，继续 hold。
    const opC = baseOperation();
    opC.pageSubmitted = true;
    const conflict = appendFact(opC, { kind: 'termination_proof', proof: { executionEnded: true, enterNeverCalled: true, senderProcessNonce: TEST_SENDER_NONCE, recordedAt: 2_000 } }, 2_100);
    if (!conflict.ok) throw new Error('fixture failed');
    expect(conflict.conflict).toBe(true);
    expect(conflict.operation.conflictOpen).toBe(true);
    const observedC = appendFact(conflict.operation, { kind: 'owner_observation', source: 'owner', attributionStrength: 'direct', observedAt: 2_050, textDigest: digestOf('第一条'), accountHint: TEST_PRINCIPAL_UID, roomHint: TEST_ROOM_ID }, 2_200);
    if (!observedC.ok) throw new Error('fixture failed');
    expect(reconcileHold([observedC.operation]).safeToResume).toBe(false);

    // (d) 明确未执行（terminal_not_dispatched）：直接可恢复。
    const opD = baseOperation();
    opD.outcome = 'terminal_not_dispatched';
    opD.senderProofApplied = true;
    expect(reconcileHold([opD]).safeToResume).toBe(true);

    // (e) 新进程空表：仅备注，不解除 hold。
    const opE = baseOperation();
    const noted = appendFact(opE, { kind: 'note', note: 'sender 报告无记录；空表不构成未发送证明' }, 2_100);
    if (!noted.ok) throw new Error('fixture failed');
    expect(reconcileHold([noted.operation]).safeToResume).toBe(false);
  });
});
