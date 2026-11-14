/**
 * 真实主体取证（FEAT-008 API-2 / P1-01 修订）。
 *
 * 真实 principalUid 只从实际发送 BrowserContext 里新收到的 HTTPS 本人资料
 * 响应取证（yunsur 固定 7e90d139.../douyin/api_misc_profile.go:26 核对的
 * /aweme/v1/web/user/profile/self/ 候选端点）。严格核来源 URL、HTTP 状态、
 * 业务成功与 UID 无损字符串；不从 Cookie 键、标签、昵称取 UID，
 * 不用有损 Number 转换。Cookie 值不出进程，只保留摘要与变更代次。
 */

import { createHash } from 'node:crypto';
import { boundedString, safeInteger, isObject, QUALIFICATION_FRESH_MS } from './protocol';
import { isValidPrincipalUid } from './binding';

/** 本人资料端点路径（来源见 FEAT-008.engineering.md API-2）。 */
export const DOUYIN_PROFILE_SELF_PATH = '/aweme/v1/web/user/profile/self/';
/** 判定登录态的 Cookie 键名（与 DyHub accountStore LOGIN_KEYS 一致，仅键名）。 */
export const AUTH_COOKIE_NAMES = ['sessionid', 'sessionid_ss', 'sid_tt', 'sid_guard'] as const;

/** 授权所需的完整证明：只在 sender 进程内持有完整字段。 */
export interface PrincipalProof {
  principalUid: string;
  contextId: string;
  sessionId: string;
  authCookieDigest: string;
  authCookieGeneration: number;
  capturedAt: number;
  profileOrigin: string;
  profileStatus: number;
}

/** glue 采回的原始捕获材料；bodyText 在校验后立即丢弃，不持久化。 */
export interface ProfileCaptureRaw {
  finalUrl: string;
  httpStatus: number;
  bodyText: string;
  /** 采证时探针页所在页面 URL，必须是固定房间页面。 */
  pageUrl: string;
  contextId: string;
  sessionId: string;
  authCookieDigest: string;
  authCookieGeneration: number;
  capturedAt: number;
}

export type ProfileVerifyResult =
  | { ok: true; proof: PrincipalProof }
  | { ok: false; reason: string };

export interface ProfileVerifyExpectation {
  profileOrigin: string;
  expectedPrincipalUid: string;
  roomId: string;
  /** 注入时钟的当前时间，用于拒绝未来采证。 */
  now: number;
}

export function verifyProfileCapture(raw: ProfileCaptureRaw, expectation: ProfileVerifyExpectation): ProfileVerifyResult {
  let finalUrl: URL;
  try {
    finalUrl = new URL(raw.finalUrl);
  } catch {
    return { ok: false, reason: 'profile 响应 URL 无法解析' };
  }
  if (finalUrl.origin !== expectation.profileOrigin || finalUrl.pathname !== DOUYIN_PROFILE_SELF_PATH) {
    return { ok: false, reason: 'profile 响应来源 URL 与预期端点不符' };
  }
  if (raw.httpStatus !== 200) return { ok: false, reason: `profile 响应 HTTP 状态非 200：${raw.httpStatus}` };
  let pageUrl: URL;
  try {
    pageUrl = new URL(raw.pageUrl);
  } catch {
    return { ok: false, reason: '探针页 URL 无法解析' };
  }
  if (pageUrl.origin !== 'https://live.douyin.com' || pageUrl.pathname !== `/${expectation.roomId}`) {
    return { ok: false, reason: '探针页不在固定房间页面，采证来源不可信' };
  }
  if (!boundedString(raw.contextId, 128) || !boundedString(raw.sessionId, 128)) {
    return { ok: false, reason: 'Context/Session 标识缺失' };
  }
  if (!boundedString(raw.authCookieDigest, 64) || !/^[0-9a-f]{64}$/.test(raw.authCookieDigest)) {
    return { ok: false, reason: '认证 Cookie 摘要缺失或无效' };
  }
  if (!safeInteger(raw.authCookieGeneration)) return { ok: false, reason: '认证 Cookie 代次无效' };
  if (!Number.isSafeInteger(raw.capturedAt) || raw.capturedAt > expectation.now) {
    return { ok: false, reason: '采证时间缺失或来自未来' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.bodyText);
  } catch {
    return { ok: false, reason: 'profile 响应不是合法 JSON' };
  }
  if (!isObject(parsed)) return { ok: false, reason: 'profile 响应结构无效' };
  if (parsed.status_code !== 0) return { ok: false, reason: `profile 业务状态非成功：${String(parsed.status_code)}` };
  const data = parsed.data;
  if (!isObject(data) || !isObject(data.user)) return { ok: false, reason: 'profile 响应缺少 data.user' };
  const idStr = (data.user as { id_str?: unknown }).id_str;
  if (!isValidPrincipalUid(idStr)) return { ok: false, reason: 'profile 响应缺少无损 id_str 字符串 UID' };
  // 只信任 id_str；数字 id 字段有损，绝不使用。
  if (idStr !== expectation.expectedPrincipalUid) {
    return { ok: false, reason: '实际主体与部署预期主体不符' };
  }
  return {
    ok: true,
    proof: {
      principalUid: idStr,
      contextId: raw.contextId,
      sessionId: raw.sessionId,
      authCookieDigest: raw.authCookieDigest,
      authCookieGeneration: raw.authCookieGeneration,
      capturedAt: raw.capturedAt,
      profileOrigin: expectation.profileOrigin,
      profileStatus: raw.httpStatus,
    },
  };
}

export function isQualificationFresh(proof: PrincipalProof, now: number): boolean {
  return now - proof.capturedAt >= 0 && now - proof.capturedAt <= QUALIFICATION_FRESH_MS;
}

/**
 * 认证 Cookie 摘要：对排序后的 name=value 行做 SHA-256。
 * Cookie 值不离开 sender 进程；L 侧只见摘要与代次。
 */
export function digestAuthCookies(cookies: { name: string; value: string }[]): { digest: string; generation: number } {
  const auth = cookies
    .filter((cookie) => (AUTH_COOKIE_NAMES as readonly string[]).includes(cookie.name))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .sort();
  const digest = createHash('sha256').update(auth.join('\n')).digest('hex');
  return { digest, generation: 0 };
}

/** 比较两次摘要是否一致；不一致即认证代次变化，旧资格作废。 */
export function authCookieDigestChanged(previous: string, current: string): boolean {
  return previous !== current;
}
