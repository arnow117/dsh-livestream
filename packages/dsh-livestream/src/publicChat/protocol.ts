/**
 * publicChat 协议常量与共享形状（FEAT-008）。
 *
 * L 侧控制器与独立 sender 只通过本文件定义的受保护 v1 协议通信；
 * wire 形状在此集中定义并校验，双方不各自猜测字段。
 */

export const PUBLIC_CHAT_PROTOCOL = 'dsh-public-chat-v1';
export const PUBLIC_CHAT_BUILD_ID = 'dsh-public-chat-v1';

/** 本地发送节流常量：是本机限制，不冒称平台限额。 */
export const SEND_QUEUE_LIMIT = 10;
export const SEND_QUEUE_WAIT_MS = 30_000;
export const SEND_DISPATCH_INTERVAL_MS = 3_000;
export const SEND_HTTP_TIMEOUT_MS = 15_000;
/** 单请求/响应体上限（受信通信双方都按此截断）。 */
export const MAX_WIRE_BODY_BYTES = 64 * 1024;
/** 身份证明捕获后可用于授权的本地有效窗。 */
export const QUALIFICATION_FRESH_MS = 60_000;

export interface Clock {
  wall(): number;
  monotonic(): number;
}

export function defaultClock(): Clock {
  return { wall: () => Date.now(), monotonic: () => performance.now() };
}

type JsonObject = Record<string, unknown>;

export const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const boundedString = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;

export const safeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export const hexDigest64 = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * 独立 sender 监听地址：只接受数字 loopback HTTP URL。
 * 端口 0 仅用于测试（OS 分配）；部署配置文件里的端口必须大于 0。
 */
export function parseSenderListenUrl(value: unknown): ValidationResult<{ origin: string; port: number }> {
  if (!boundedString(value, 100)) return { ok: false, error: 'sender 监听地址必须是字符串' };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, error: 'sender 监听地址必须是合法 URL' };
  }
  const loopbackHosts = new Set(['127.0.0.1', '[::1]', '::1']);
  if (url.protocol !== 'http:' || !loopbackHosts.has(url.hostname.replace(/^\[|\]$/g, '')) ) {
    return { ok: false, error: 'sender 必须监听数字 loopback HTTP 地址' };
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    return { ok: false, error: 'sender 监听地址不得包含 userinfo/path/query/hash' };
  }
  const port = Number(url.port);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535 || !/^[0-9]{0,5}$/.test(url.port)) {
    return { ok: false, error: 'sender 监听端口必须是数字' };
  }
  return { ok: true, value: { origin: url.origin, port } };
}

/** 部署参数只来自受信环境/凭据，不接受普通 settings 或模型参数。 */
export interface SenderDeploymentFile {
  schemaVersion: 1;
  listenUrl: string;
  token: string;
  expectedPrincipalUid: string;
  roomId: string;
  accountRecordId: string;
  buildDigest: string;
  instanceId: string;
  profileOrigin: string;
  dataDir: string;
}

export function validateSenderDeploymentFile(value: unknown): ValidationResult<SenderDeploymentFile> {
  if (!isObject(value)) return { ok: false, error: '部署配置必须是对象' };
  const keys = ['schemaVersion', 'listenUrl', 'token', 'expectedPrincipalUid', 'roomId', 'accountRecordId', 'buildDigest', 'instanceId', 'profileOrigin', 'dataDir'];
  if (Object.keys(value).length !== keys.length || keys.some((key) => !(key in value))) {
    return { ok: false, error: '部署配置字段不完整或不认识多余字段' };
  }
  if (value.schemaVersion !== 1) return { ok: false, error: '部署配置版本不支持' };
  const listen = parseSenderListenUrl(value.listenUrl);
  if (!listen.ok) return { ok: false, error: listen.error };
  if (listen.value.port === 0) return { ok: false, error: '部署监听端口必须是指定数字，不能是 0' };
  if (!boundedString(value.token, 256)) return { ok: false, error: 'sender token 缺失或超出长度限制' };
  if (typeof value.expectedPrincipalUid !== 'string' || !/^[0-9]{1,32}$/.test(value.expectedPrincipalUid)) {
    return { ok: false, error: '预期真实主体 UID 必须是无损数字字符串' };
  }
  if (typeof value.roomId !== 'string' || !/^[0-9]{1,64}$/.test(value.roomId)) {
    return { ok: false, error: '固定房间号必须是数字字符串' };
  }
  if (!boundedString(value.accountRecordId, 128)) return { ok: false, error: 'accountRecordId 无效' };
  if (!hexDigest64(value.buildDigest)) return { ok: false, error: 'buildDigest 必须是 64 位十六进制摘要' };
  if (!boundedString(value.instanceId, 128)) return { ok: false, error: 'instanceId 无效' };
  if (!boundedString(value.profileOrigin, 100) || !/^https:\/\/(www\.)?douyin\.com$/.test(value.profileOrigin)) {
    return { ok: false, error: 'profileOrigin 必须是受支持的抖音 HTTPS 站点源' };
  }
  if (!boundedString(value.dataDir, 400)) return { ok: false, error: 'dataDir 无效' };
  return { ok: true, value: value as unknown as SenderDeploymentFile };
}

/** v1 state 响应（sender → L）。 */
export interface SenderStateWire {
  protocol: string;
  buildDigest: string;
  instanceId: string;
  processNonce: string;
  senderConnectionGeneration: number;
  capabilities?: string[];
  privateProtocol?: string;
  activeAuthorizationId?: string | null;
  session: { sessionId: string; roomId: string; connected: boolean } | null;
  qualification: { state: 'none' | 'captured'; capturedAt: number | null; principalUid: string | null; qualificationToken: string | null };
  hold: boolean;
}

export function validateSenderStateWire(value: unknown): ValidationResult<SenderStateWire> {
  if (!isObject(value)) return { ok: false, error: 'state 必须是对象' };
  if (value.protocol !== PUBLIC_CHAT_PROTOCOL) return { ok: false, error: '协议版本不符' };
  if (!hexDigest64(value.buildDigest)) return { ok: false, error: 'buildDigest 无效' };
  if (!boundedString(value.instanceId, 128)) return { ok: false, error: 'instanceId 无效' };
  if (!boundedString(value.processNonce, 128)) return { ok: false, error: 'processNonce 无效' };
  if (!safeInteger(value.senderConnectionGeneration)) return { ok: false, error: '连接代次无效' };
  const capabilities = value.capabilities;
  if (!Array.isArray(capabilities) ||
    !['explicit-grant-snapshot-v1', 'frozen-http-auth-v1', 'no-replay-http1-v1'].every((capability) => capabilities.includes(capability)) ||
    value.privateProtocol !== 'dsh-public-chat-http-v1') return { ok: false, error: '缺少冻结 HTTP 授权能力' };
  if (value.activeAuthorizationId !== null && !boundedString(value.activeAuthorizationId, 128)) return { ok: false, error: '授权槽无效' };
  const session = value.session;
  if (session !== null && !isObject(session)) return { ok: false, error: 'session 形状无效' };
  if (isObject(session)) {
    if (!boundedString(session.sessionId, 128) || typeof session.roomId !== 'string' || !/^[0-9]{1,64}$/.test(session.roomId)
      || typeof session.connected !== 'boolean') {
      return { ok: false, error: 'session 形状无效' };
    }
  }
  const qualification = value.qualification;
  if (!isObject(qualification)) return { ok: false, error: 'qualification 形状无效' };
  if (!['none', 'captured'].includes(String(qualification.state))) return { ok: false, error: 'qualification 状态无效' };
  if (qualification.state === 'captured') {
    if (typeof qualification.capturedAt !== 'number' || !Number.isSafeInteger(qualification.capturedAt)
      || typeof qualification.principalUid !== 'string' || !/^[0-9]{1,32}$/.test(qualification.principalUid)
      || typeof qualification.qualificationToken !== 'string' || qualification.qualificationToken.length === 0
      || qualification.qualificationToken.length > 128) {
      return { ok: false, error: 'qualification 证明字段无效' };
    }
  } else if (qualification.capturedAt !== null || qualification.principalUid !== null || qualification.qualificationToken !== null) {
    return { ok: false, error: 'qualification 未捕获时不得携带证明' };
  }
  if (typeof value.hold !== 'boolean') return { ok: false, error: 'hold 必须是布尔值' };
  return { ok: true, value: value as unknown as SenderStateWire };
}

/** v1 qualification 响应：真实主体证明摘要或明确失败。 */
export type QualificationWire =
  | {
    qualified: true;
    principalUid: string;
    contextId: string;
    sessionId: string;
    authCookieDigest: string;
    authCookieGeneration: number;
    capturedAt: number;
    profileOrigin: string;
    profileStatus: number;
    /** sender 签发的不可复用授权令牌：grantId 必须取自它（F1/F4）。 */
    qualificationToken: string;
    /** 采证时的 sender 身份代次（撤销/重采/连接/会话变化时推进）。 */
    identityEpoch: number;
    /** 采证时 sender 的进程 nonce（F1：授权贯通，不用 L nonce）。 */
    senderProcessNonce: string;
    /** 采证时的 sender 连接代次（F1：全部代次取自授权时核实值）。 */
    senderConnectionGeneration: number;
  }
  | { qualified: false; reason: string };

export function validateQualificationWire(value: unknown): ValidationResult<QualificationWire> {
  if (!isObject(value)) return { ok: false, error: 'qualification 必须是对象' };
  if (value.qualified === false) {
    if (!boundedString(value.reason, 200)) return { ok: false, error: '失败原因无效' };
    return { ok: true, value: { qualified: false, reason: value.reason } };
  }
  if (value.qualified !== true) return { ok: false, error: 'qualified 必须是布尔值' };
  if (typeof value.principalUid !== 'string' || !/^[0-9]{1,32}$/.test(value.principalUid)) return { ok: false, error: '主体 UID 必须是无损数字字符串' };
  if (!boundedString(value.contextId, 128) || !boundedString(value.sessionId, 128)) return { ok: false, error: 'Context/Session 标识无效' };
  if (!hexDigest64(value.authCookieDigest)) return { ok: false, error: 'Cookie 摘要无效' };
  if (!safeInteger(value.authCookieGeneration)) return { ok: false, error: 'Cookie 代次无效' };
  if (typeof value.capturedAt !== 'number' || !Number.isSafeInteger(value.capturedAt)) return { ok: false, error: '采证时间无效' };
  if (!boundedString(value.profileOrigin, 100)) return { ok: false, error: 'profileOrigin 无效' };
  if (typeof value.profileStatus !== 'number' || !Number.isSafeInteger(value.profileStatus)) return { ok: false, error: 'profile 状态码无效' };
  if (!boundedString(value.qualificationToken, 128)) return { ok: false, error: 'qualificationToken 无效' };
  if (!safeInteger(value.identityEpoch)) return { ok: false, error: 'identityEpoch 无效' };
  if (!boundedString(value.senderProcessNonce, 128)) return { ok: false, error: 'senderProcessNonce 无效' };
  if (!safeInteger(value.senderConnectionGeneration)) return { ok: false, error: 'senderConnectionGeneration 无效' };
  return { ok: true, value: value as unknown as QualificationWire };
}

/** v1 send 请求（L → sender）。只接收固定绑定元组、requestId/sourceKey、普通文本与自动事件证明。 */
export interface SendRequestWire {
  requestId: string;
  sourceKey: string | null;
  binding: {
    version: string;
    buildDigest: string;
    instanceId: string;
    processNonce: string;
    accountRecordId: string;
    principalUid: string;
    roomId: string;
    senderSessionId: string;
    senderConnectionGeneration: number;
    identityGeneration: number;
    inputConnectionGeneration: number;
    liveEpoch: string;
    grantId: string;
  };
  text: string;
  autoEvent: { rawId: string; rawType: string } | null;
}

export type SendResponseWire =
  | { status: 'rejected'; reason: string }
  | { status: 'terminal_not_dispatched'; proof: { executionEnded: boolean; enterNeverCalled: boolean; senderProcessNonce: string; recordedAt: number } }
  | { status: 'dispatched'; enterAttempted: true; pageSubmitted: boolean };

export function validateSendResponseWire(value: unknown): ValidationResult<SendResponseWire> {
  if (!isObject(value)) return { ok: false, error: 'send 响应必须是对象' };
  if (value.status === 'rejected') {
    if (!boundedString(value.reason, 200)) return { ok: false, error: '拒绝原因无效' };
    return { ok: true, value: { status: 'rejected', reason: value.reason } };
  }
  if (value.status === 'terminal_not_dispatched') {
    const proof = value.proof;
    if (!isObject(proof) || typeof proof.executionEnded !== 'boolean' || typeof proof.enterNeverCalled !== 'boolean'
      || !boundedString(proof.senderProcessNonce, 128)
      || typeof proof.recordedAt !== 'number' || !Number.isSafeInteger(proof.recordedAt)) {
      return { ok: false, error: '终态证明形状无效' };
    }
    return { ok: true, value: value as unknown as SendResponseWire };
  }
  if (value.status === 'dispatched') {
    if (value.enterAttempted !== true || typeof value.pageSubmitted !== 'boolean') {
      return { ok: false, error: 'dispatched 响应形状无效' };
    }
    return { ok: true, value: value as unknown as SendResponseWire };
  }
  return { ok: false, error: 'send 响应状态未知' };
}

/** v1 原操作查询响应（sender 侧记录）。 */
export type SenderOperationWire =
  | { found: true; requestId: string; senderProcessNonce: string; sourceKey?: string | null; binding?: SendRequestWire['binding']; enterAttempted: boolean; executionTerminated: boolean; enterNeverCalled: boolean; pageSubmitted: boolean; finishedAt: number | null }
  | { found: false };

export function validateSenderOperationWire(value: unknown): ValidationResult<SenderOperationWire> {
  if (!isObject(value)) return { ok: false, error: 'operation 响应必须是对象' };
  if (value.found === false) return { ok: true, value: { found: false } };
  if (value.found !== true) return { ok: false, error: 'found 必须是布尔值' };
  if (!boundedString(value.requestId, 128) || !boundedString(value.senderProcessNonce, 128)) return { ok: false, error: 'requestId/processNonce 无效' };
  if ((value.sourceKey !== null && !boundedString(value.sourceKey, 200)) || !isObject(value.binding)) return { ok: false, error: '原操作绑定缺失' };
  for (const key of ['enterAttempted', 'executionTerminated', 'enterNeverCalled', 'pageSubmitted']) {
    if (typeof value[key] !== 'boolean') return { ok: false, error: `${key} 必须是布尔值` };
  }
  if (value.finishedAt !== null && (typeof value.finishedAt !== 'number' || !Number.isSafeInteger(value.finishedAt))) {
    return { ok: false, error: 'finishedAt 无效' };
  }
  return { ok: true, value: value as unknown as SenderOperationWire };
}

/** v1 send 请求校验（sender 侧接收时使用）。 */
export function validateSendRequestWire(value: unknown): SendRequestWire | null {
  if (!isObject(value)) return null;
  if (!boundedString(value.requestId, 128)) return null;
  if (value.sourceKey !== null && !boundedString(value.sourceKey, 200)) return null;
  if (typeof value.text !== 'string' || value.text.length === 0 || value.text.length > 4096) return null;
  if (!isObject(value.binding)) return null;
  const autoEvent = value.autoEvent;
  if (autoEvent !== null && !isObject(autoEvent)) return null;
  if (isObject(autoEvent) && (!boundedString(autoEvent.rawId, 128) || !boundedString(autoEvent.rawType, 64))) return null;
  return {
    requestId: value.requestId,
    sourceKey: value.sourceKey ?? null,
    binding: value.binding as SendRequestWire['binding'],
    text: value.text,
    autoEvent: isObject(autoEvent) ? { rawId: autoEvent.rawId as string, rawType: autoEvent.rawType as string } : null,
  };
}

export const V1_ROUTES = {
  state: { method: 'GET', path: '/v1/state' },
  qualification: { method: 'POST', path: '/v1/qualification' },
  revoke: { method: 'POST', path: '/v1/grant/revoke' },
  send: { method: 'POST', path: '/v1/send' },
  operation: { method: 'GET', path: '/v1/operations' },
} as const;
