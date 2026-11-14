/** F2 正式回归（原预期2）：采证期间的撤权/连接变化/并发采集不得恢复资格。 */
import { describe, expect, it } from 'vitest';
import { SenderRuntime, type SenderRuntimePort } from '../../src/publicChat/senderRuntime';
import {
  TEST_BUILD_DIGEST, TEST_INSTANCE_ID, TEST_PRINCIPAL_UID, TEST_OTHER_PRINCIPAL_UID,
  TEST_ROOM_ID, TEST_ACCOUNT_RECORD_ID, TEST_COOKIE_DIGEST,
} from './test-helpers';

const DEPLOYMENT = {
  buildDigest: TEST_BUILD_DIGEST,
  instanceId: TEST_INSTANCE_ID,
  expectedPrincipalUid: TEST_PRINCIPAL_UID,
  roomId: TEST_ROOM_ID,
  accountRecordId: TEST_ACCOUNT_RECORD_ID,
  profileOrigin: 'https://www.douyin.com',
};

const validCapture = () => ({
  finalUrl: 'https://www.douyin.com/aweme/v1/web/user/profile/self/?aid=6383',
  httpStatus: 200,
  bodyText: JSON.stringify({ status_code: 0, data: { user: { id_str: TEST_PRINCIPAL_UID } } }),
  pageUrl: `https://live.douyin.com/${TEST_ROOM_ID}`,
  contextId: 'ctx-1',
  sessionId: 'session-1',
  authCookieDigest: TEST_COOKIE_DIGEST,
  authCookieGeneration: 2,
  capturedAt: Date.now() - 5,
});

/** 可控 capture/cookie 的 port；capture 挂起由测试编排。 */
function makeRuntime() {
  const captureGates: Array<(value: unknown) => void> = [];
  let captureResult: import('../../src/publicChat/identity').ProfileCaptureRaw | null = null;
  let capturePending = false;
  const port: SenderRuntimePort = {
    currentSession: () => ({ sessionId: 'session-1', roomId: TEST_ROOM_ID, contextId: 'ctx-1' }),
    currentSessionPageUrl: () => `https://live.douyin.com/${TEST_ROOM_ID}`,
    authCookieDigest: async () => ({ digest: TEST_COOKIE_DIGEST, generation: 2 }),
    captureProfile: async () => {
      if (capturePending) {
        await new Promise((resolveGate) => captureGates.push(resolveGate));
      }
      return captureResult;
    },
    sendPort: () => null,
    enqueueControlledSend: () => null,
  };
  const runtime = new SenderRuntime({ deployment: DEPLOYMENT, port });
  runtime.notifySessionEstablished({ sessionId: 'session-1', roomId: TEST_ROOM_ID, contextId: 'ctx-1' });
  runtime.notifyConnectionChange(true);
  const control = {
    startCapture() {
      capturePending = true;
    },
    releaseCapture(value: import('../../src/publicChat/identity').ProfileCaptureRaw | null) {
      captureResult = value;
      capturePending = false;
      for (const gate of captureGates.splice(0)) gate(value);
    },
  };
  return { runtime, control };
}

/** 原预期2：profile await 期间撤权后旧采证返回 → 资格不得恢复（qualified=false）。 */
describe('F2 采证迟到零复活', () => {
  it('profile await 期间撤权：旧采证返回后资格保持未捕获', async () => {
    const { runtime, control } = makeRuntime();
    control.startCapture();
    const pending = runtime.refreshQualification();
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    runtime.revoke('owner-revoke');
    control.releaseCapture(validCapture());
    const wire = await pending;
    // 原预期：qualified=false（原实现为 true——已修正）。
    expect(wire.qualified).toBe(false);
    if (!wire.qualified) expect(wire.reason).toContain('identity_unverified');
    expect(runtime.state().qualification.state).toBe('none');
  });

  it('采证期间连接 down/up：旧采证作废；恢复 connected 不复活', async () => {
    const { runtime, control } = makeRuntime();
    control.startCapture();
    const pending = runtime.refreshQualification();
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    runtime.notifyConnectionChange(false);
    runtime.notifyConnectionChange(true);
    control.releaseCapture(validCapture());
    const wire = await pending;
    expect(wire.qualified).toBe(false);
    // 恢复 connected 不能复活：重新采集仍走完整校验。
    control.releaseCapture(validCapture());
    const again = await runtime.refreshQualification();
    expect(again.qualified).toBe(true);
  });

  it('并发两次采集：旧采集被新采集开始作废，新采集的事实不被覆盖', async () => {
    const first = makeRuntime();
    first.control.startCapture();
    const pendingA = first.runtime.refreshQualification();
    // 第二次采集开始即作废第一次（identityEpoch 推进）。
    const pendingB = first.runtime.refreshQualification();
    first.control.releaseCapture(validCapture());
    // A 返回：被作废。
    const wireA = await pendingA;
    expect(wireA.qualified).toBe(false);
    if (!wireA.qualified) expect(wireA.reason).toContain('superseded-capture-or-revoked');
    // B 返回：发布，principalUid 与采证一致。
    const wireB = await pendingB;
    expect(wireB.qualified).toBe(true);
    if (wireB.qualified) expect(wireB.principalUid).toBe(TEST_PRINCIPAL_UID);
  });

  it('采证期间主体不同：fail-closed（不发布资格）', async () => {
    const { runtime, control } = makeRuntime();
    control.releaseCapture({
      ...validCapture(),
      bodyText: JSON.stringify({ status_code: 0, data: { user: { id_str: TEST_OTHER_PRINCIPAL_UID } } }),
    });
    const wire = await runtime.refreshQualification();
    expect(wire.qualified).toBe(false);
    if (!wire.qualified) expect(wire.reason).toContain('主体不符');
  });

  it('发布后的 token 在撤销/重采后不可复用（资格查询返回新 token）', async () => {
    const { runtime, control } = makeRuntime();
    control.releaseCapture(validCapture());
    const first = await runtime.refreshQualification();
    expect(first.qualified).toBe(true);
    const token1 = first.qualified ? first.qualificationToken : '';
    runtime.revoke('owner-revoke');
    control.releaseCapture(validCapture());
    const second = await runtime.refreshQualification();
    expect(second.qualified).toBe(true);
    const token2 = second.qualified ? second.qualificationToken : '';
    expect(token2).not.toBe(token1);
    // F4 前置：资格 wire 携带采证时的 sender nonce/连接代/身份代。
    if (second.qualified) {
      expect(second.senderProcessNonce).toBe(runtime.processNonce);
      expect(second.identityEpoch).toBeGreaterThan(0);
    }
  });
});
