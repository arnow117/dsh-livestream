/**
 * 发送绑定元组（FEAT-008 API-2）。
 *
 * accountRecordId 只是本地账号记录，绝不当真实主体；真实 principalUid
 * 必须来自实际发送 BrowserContext 的本人资料 HTTPS 响应取证。
 * 所有平台标识保持字符串语义，不做有损 Number 转换。
 */

import { PUBLIC_CHAT_PROTOCOL, hexDigest64, boundedString, safeInteger, isObject, type ValidationResult } from './protocol';

export interface BindingTuple {
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
}

const PRINCIPAL_UID = /^[0-9]{1,32}$/;
const ROOM_ID = /^[0-9]{1,64}$/;

export function isValidPrincipalUid(value: unknown): value is string {
  return typeof value === 'string' && PRINCIPAL_UID.test(value);
}

export function isValidRoomId(value: unknown): value is string {
  return typeof value === 'string' && ROOM_ID.test(value);
}

export function validateBindingTuple(value: unknown): ValidationResult<BindingTuple> {
  if (!isObject(value)) return { ok: false, error: '绑定元组必须是对象' };
  const keys = [
    'version', 'buildDigest', 'instanceId', 'processNonce', 'accountRecordId', 'principalUid', 'roomId',
    'senderSessionId', 'senderConnectionGeneration', 'identityGeneration', 'inputConnectionGeneration', 'liveEpoch', 'grantId',
  ] as const;
  if (keys.some((key) => !(key in value))) return { ok: false, error: '绑定元组字段不完整' };
  if (value.version !== PUBLIC_CHAT_PROTOCOL) return { ok: false, error: '绑定协议版本不符' };
  if (!hexDigest64(value.buildDigest)) return { ok: false, error: 'buildDigest 无效' };
  if (!boundedString(value.instanceId, 128)) return { ok: false, error: 'instanceId 无效' };
  if (!boundedString(value.processNonce, 128)) return { ok: false, error: 'processNonce 无效' };
  if (!boundedString(value.accountRecordId, 128)) return { ok: false, error: 'accountRecordId 无效' };
  if (!isValidPrincipalUid(value.principalUid)) return { ok: false, error: 'principalUid 必须是无损数字字符串' };
  if (!isValidRoomId(value.roomId)) return { ok: false, error: 'roomId 必须是数字字符串' };
  if (!boundedString(value.senderSessionId, 128)) return { ok: false, error: 'senderSessionId 无效' };
  for (const key of ['senderConnectionGeneration', 'identityGeneration', 'inputConnectionGeneration'] as const) {
    if (!safeInteger(value[key])) return { ok: false, error: `${key} 必须是非负安全整数` };
  }
  if (!boundedString(value.liveEpoch, 128)) return { ok: false, error: 'liveEpoch 无效' };
  if (!boundedString(value.grantId, 128)) return { ok: false, error: 'grantId 无效' };
  return { ok: true, value: value as unknown as BindingTuple };
}

/**
 * 与部署/当前期望逐字段比对；任何字段不匹配都拒绝发送。
 * expected 中未提供的字段不参与比对。
 */
export function bindingMatches(
  binding: BindingTuple,
  expected: Partial<Record<keyof BindingTuple, string | number>>,
): boolean {
  for (const [key, expectedValue] of Object.entries(expected)) {
    const actual = binding[key as keyof BindingTuple];
    if (actual !== expectedValue) return false;
  }
  return true;
}
