/** 真实主体取证与 sender 资格 fail-closed 边界（FEAT-008 API-2 / P1-01）。 */
import { describe, expect, it } from 'vitest';
import {
  verifyProfileCapture, digestAuthCookies, authCookieDigestChanged, DOUYIN_PROFILE_SELF_PATH,
  type ProfileCaptureRaw,
} from '../../src/publicChat/identity';
import { SenderRuntime, type SenderRuntimePort } from '../../src/publicChat/senderRuntime';
import { TEST_BUILD_DIGEST, TEST_INSTANCE_ID, TEST_PRINCIPAL_UID, TEST_OTHER_PRINCIPAL_UID, TEST_ROOM_ID, TEST_ACCOUNT_RECORD_ID, TEST_COOKIE_DIGEST } from './test-helpers';

const NOW = 1_700_000_000_000;

function validCapture(overrides: Partial<ProfileCaptureRaw> = {}): ProfileCaptureRaw {
  return {
    finalUrl: `https://www.douyin.com${DOUYIN_PROFILE_SELF_PATH}?aid=6383`,
    httpStatus: 200,
    bodyText: JSON.stringify({ status_code: 0, data: { user: { id_str: TEST_PRINCIPAL_UID, id: 4400889900112233445 } } }),
    pageUrl: `https://live.douyin.com/${TEST_ROOM_ID}`,
    contextId: 'ctx-1',
    sessionId: 'session-1',
    authCookieDigest: TEST_COOKIE_DIGEST,
    authCookieGeneration: 3,
    capturedAt: NOW - 1_000,
    ...overrides,
  };
}

const EXPECTATION = {
  profileOrigin: 'https://www.douyin.com',
  expectedPrincipalUid: TEST_PRINCIPAL_UID,
  roomId: TEST_ROOM_ID,
  now: NOW,
};

describe('verifyProfileCapture', () => {
  it('接受来源/状态/业务成功且 id_str 与预期一致的无损取证', () => {
    const result = verifyProfileCapture(validCapture(), EXPECTATION);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.proof.principalUid).toBe(TEST_PRINCIPAL_UID);
      expect(result.proof.authCookieDigest).toBe(TEST_COOKIE_DIGEST);
    }
  });

  it('拒绝来源 URL 与预期端点不符', () => {
    expect(verifyProfileCapture(validCapture({ finalUrl: 'https://evil.example/aweme/v1/web/user/profile/self/' }), EXPECTATION).ok).toBe(false);
    expect(verifyProfileCapture(validCapture({ finalUrl: 'https://www.douyin.com/other/path' }), EXPECTATION).ok).toBe(false);
  });

  it('拒绝非 200 与业务失败', () => {
    expect(verifyProfileCapture(validCapture({ httpStatus: 403 }), EXPECTATION).ok).toBe(false);
    expect(verifyProfileCapture(validCapture({ bodyText: JSON.stringify({ status_code: 2151, data: { user: { id_str: TEST_PRINCIPAL_UID } } }) }), EXPECTATION).ok).toBe(false);
  });

  it('拒绝探针页不在固定房间页面', () => {
    expect(verifyProfileCapture(validCapture({ pageUrl: 'https://www.douyin.com/' }), EXPECTATION).ok).toBe(false);
    expect(verifyProfileCapture(validCapture({ pageUrl: `https://live.douyin.com/999` }), EXPECTATION).ok).toBe(false);
  });

  it('拒绝实际主体与部署预期不符（同本地记录换主体）', () => {
    const result = verifyProfileCapture(validCapture({ bodyText: JSON.stringify({ status_code: 0, data: { user: { id_str: TEST_OTHER_PRINCIPAL_UID } } }) }), EXPECTATION);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('主体不符');
  });

  it('拒绝缺失 id_str / 有损 UID / 未来采证', () => {
    expect(verifyProfileCapture(validCapture({ bodyText: JSON.stringify({ status_code: 0, data: { user: { id: 123 } } }) }), EXPECTATION).ok).toBe(false);
    expect(verifyProfileCapture(validCapture({ bodyText: JSON.stringify({ status_code: 0, data: { user: { id_str: 4400889900112233445 } } }) }), EXPECTATION).ok).toBe(false);
    expect(verifyProfileCapture(validCapture({ capturedAt: NOW + 60_000 }), EXPECTATION).ok).toBe(false);
  });
});

describe('认证 Cookie 摘要', () => {
  it('摘要只含认证键且排序稳定；Cookie 值变化立即检出', () => {
    const first = digestAuthCookies([{ name: 'others', value: 'x' }, { name: 'sessionid', value: 'aaa' }, { name: 'sid_tt', value: 'bbb' }]);
    const same = digestAuthCookies([{ name: 'sessionid', value: 'aaa' }, { name: 'sid_tt', value: 'bbb' }]);
    expect(first.digest).toBe(same.digest);
    expect(authCookieDigestChanged(first.digest, first.digest)).toBe(false);
    const replaced = digestAuthCookies([{ name: 'sessionid', value: 'zzz' }, { name: 'sid_tt', value: 'bbb' }]);
    expect(authCookieDigestChanged(first.digest, replaced.digest)).toBe(true);
  });
});

describe('SenderRuntime.refreshQualification fail-closed', () => {
  const deployment = {
    buildDigest: TEST_BUILD_DIGEST,
    instanceId: TEST_INSTANCE_ID,
    expectedPrincipalUid: TEST_PRINCIPAL_UID,
    roomId: TEST_ROOM_ID,
    accountRecordId: TEST_ACCOUNT_RECORD_ID,
    profileOrigin: 'https://www.douyin.com',
  };

  function makeRuntime(port: Partial<SenderRuntimePort>): SenderRuntime {
    const runtime = new SenderRuntime({
      deployment,
      port: {
        currentSession: () => ({ sessionId: 'session-1', roomId: TEST_ROOM_ID, contextId: 'ctx-1' }),
        currentSessionPageUrl: () => `https://live.douyin.com/${TEST_ROOM_ID}`,
        authCookieDigest: async () => ({ digest: TEST_COOKIE_DIGEST, generation: 3 }),
        captureProfile: async () => validCapture(),
        sendPort: () => null,
        ...port,
      } as SenderRuntimePort,
    });
    runtime.notifySessionEstablished({ sessionId: 'session-1', roomId: TEST_ROOM_ID, contextId: 'ctx-1' });
    runtime.notifyConnectionChange(true);
    return runtime;
  }

  it('采集齐全时资格成立并绑定证明', async () => {
    const runtime = makeRuntime({});
    const wire = await runtime.refreshQualification();
    expect(wire.qualified).toBe(true);
    if (wire.qualified) expect(wire.principalUid).toBe(TEST_PRINCIPAL_UID);
    expect(runtime.state().qualification.state).toBe('captured');
  });

  it('采不到/来源不合预期/主体不符时 identity_unverified，禁止资格', async () => {
    const failed = await makeRuntime({ captureProfile: async () => null }).refreshQualification();
    expect(failed.qualified).toBe(false);
    if (!failed.qualified) expect(failed.reason).toContain('identity_unverified');

    const badUrl = await makeRuntime({ captureProfile: async () => validCapture({ finalUrl: 'https://www.douyin.com/other' }) }).refreshQualification();
    expect(badUrl.qualified).toBe(false);

    const wrongPrincipal = await makeRuntime({ captureProfile: async () => validCapture({ bodyText: JSON.stringify({ status_code: 0, data: { user: { id_str: TEST_OTHER_PRINCIPAL_UID } } }) }) }).refreshQualification();
    expect(wrongPrincipal.qualified).toBe(false);
    if (!wrongPrincipal.qualified) expect(wrongPrincipal.reason).toContain('主体不符');
    expect(makeRuntime({}).state().qualification.state).toBe('none');
  });

  it('采集后 Cookie 摘要与当前不一致时拒绝', async () => {
    const runtime = makeRuntime({ authCookieDigest: async () => ({ digest: 'ff'.repeat(32), generation: 4 }) });
    const wire = await runtime.refreshQualification();
    expect(wire.qualified).toBe(false);
    if (!wire.qualified) expect(wire.reason).toContain('cookie-digest-mismatch');
  });

  it('真实断连/重建回调同步废弃资格；恢复 connected 不复活', async () => {
    const runtime = makeRuntime({});
    expect((await runtime.refreshQualification()).qualified).toBe(true);
    // 同步 down/up：两次通知都推进代次并废弃旧资格。
    runtime.notifyConnectionChange(false);
    runtime.notifyConnectionChange(true);
    expect(runtime.state().senderConnectionGeneration).toBeGreaterThanOrEqual(3);
    expect(runtime.state().qualification.state).toBe('none');
    expect((await runtime.refreshQualification()).qualified).toBe(true);
  });

  it('会话替换/关闭废弃资格；qualification revoke 后 hold 生效', async () => {
    const runtime = makeRuntime({});
    expect((await runtime.refreshQualification()).qualified).toBe(true);
    runtime.notifySessionClosed();
    expect(runtime.state().session).toBeNull();
    expect(runtime.state().qualification.state).toBe('none');
    runtime.revoke('unknown-hold');
    expect(runtime.state().hold).toBe(true);
    const afterHold = await runtime.refreshQualification();
    expect(afterHold.qualified).toBe(false);
  });
});
