/**
 * 公屏发送设置（FEAT-008 FR-1，类型与校验部分）。
 *
 * 发送默认关闭；手动、Agent 回复、欢迎、感谢分别有明确开关。
 * UI 只保存默认 false 的开关与普通安全文字草稿，授权在内存。
 * 模型与普通设置不能指定账号、房间、URL 或授权；部署参数只来自受信配置。
 */

import { isObject, boundedString } from './protocol';
import { MAX_PUBLIC_TEXT_LENGTH, validatePublicText } from './textPolicy';

export interface PublicChatSettings {
  /** 主开关：默认关闭。保存 enabled 不等于授权。 */
  enabled: boolean;
  /** Agent 对真实公屏事件的公开回复开关。 */
  reply: boolean;
  /** 进场欢迎开关。 */
  welcome: boolean;
  /** 礼物感谢开关。 */
  thanks: boolean;
  drafts: {
    /** 手动发送文字草稿：只保存普通非敏感文字，发送前再校验。 */
    manual: string;
  };
}

export const DEFAULT_PUBLIC_CHAT_SETTINGS: PublicChatSettings = {
  enabled: false,
  reply: false,
  welcome: false,
  thanks: false,
  drafts: { manual: '' },
};

const TOP_LEVEL_KEYS = new Set(['enabled', 'reply', 'welcome', 'thanks', 'drafts']);
const DRAFT_KEYS = new Set(['manual']);

export type SettingsPatchResult =
  | { ok: true; next: PublicChatSettings }
  | { ok: false; error: string };

/** 严格白名单 patch：不认识/越权字段一律拒绝（含账号/房间/URL 类键）。 */
export function applySettingsPatch(current: PublicChatSettings, patch: unknown): SettingsPatchResult {
  if (!isObject(patch)) return { ok: false, error: '设置 patch 必须是对象' };
  const next: PublicChatSettings = { ...current, drafts: { ...current.drafts } };
  for (const key of Object.keys(patch)) {
    if (!TOP_LEVEL_KEYS.has(key)) return { ok: false, error: `设置不接受字段 ${key}` };
  }
  for (const key of ['enabled', 'reply', 'welcome', 'thanks'] as const) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (typeof value !== 'boolean') return { ok: false, error: `${key} 必须是布尔值` };
    next[key] = value;
  }
  if ('drafts' in patch) {
    const drafts = patch.drafts;
    if (!isObject(drafts)) return { ok: false, error: 'drafts 必须是对象' };
    for (const key of Object.keys(drafts)) {
      if (!DRAFT_KEYS.has(key)) return { ok: false, error: `草稿不接受字段 ${key}` };
    }
    if ('manual' in drafts) {
      const manual = drafts.manual;
      if (typeof manual !== 'string') return { ok: false, error: 'manual 草稿必须是字符串' };
      if (manual.length > MAX_PUBLIC_TEXT_LENGTH) return { ok: false, error: `草稿超过本地长度上限 ${MAX_PUBLIC_TEXT_LENGTH}` };
      if (manual !== '' && !validatePublicText(manual).ok) return { ok: false, error: '草稿包含不允许公开的内容' };
      next.drafts = { ...next.drafts, manual };
    }
  }
  return { ok: true, next };
}

/** 序列化到宿主设置存储的最小形状；不含凭据或部署参数。 */
export function serializePublicChatSettings(settings: PublicChatSettings): Record<string, unknown> {
  return {
    enabled: settings.enabled,
    reply: settings.reply,
    welcome: settings.welcome,
    thanks: settings.thanks,
    drafts: { manual: settings.drafts.manual },
  };
}

/** 从宿主设置存储恢复；未知形状回退默认关闭。 */
export function parsePublicChatSettings(value: unknown): PublicChatSettings {
  if (!isObject(value)) return { ...DEFAULT_PUBLIC_CHAT_SETTINGS, drafts: { ...DEFAULT_PUBLIC_CHAT_SETTINGS.drafts } };
  const merged: PublicChatSettings = { ...DEFAULT_PUBLIC_CHAT_SETTINGS, drafts: { ...DEFAULT_PUBLIC_CHAT_SETTINGS.drafts } };
  if (typeof value.enabled === 'boolean') merged.enabled = value.enabled;
  if (typeof value.reply === 'boolean') merged.reply = value.reply;
  if (typeof value.welcome === 'boolean') merged.welcome = value.welcome;
  if (typeof value.thanks === 'boolean') merged.thanks = value.thanks;
  if (isObject(value.drafts) && typeof value.drafts.manual === 'string' && boundedString(value.drafts.manual, MAX_PUBLIC_TEXT_LENGTH + 1)
    && (value.drafts.manual === '' || validatePublicText(value.drafts.manual).ok)) {
    merged.drafts = { manual: value.drafts.manual };
  }
  return merged;
}
