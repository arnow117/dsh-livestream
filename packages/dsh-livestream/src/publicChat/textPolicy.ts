/**
 * 公开文字与模板校验（FEAT-008）。
 *
 * 所有公屏文字是普通公开内容：拒绝可识别联系方式、链接/附件语法和控制字符。
 * 校验失败整条拒发，不以截断/替换把敏感原文「修成成功」。
 * 此校验只做语法拒绝，不声称能自动识别任意语义隐私；
 * owner/Agent 仍只可提供普通非敏感文字。
 */

/** 本地长度限制：不是平台字数限制，平台限制未验证。 */
export const MAX_PUBLIC_TEXT_LENGTH = 200;
export const MAX_TEMPLATE_NAME_LENGTH = 24;

/** 控制字符：C0 全部 + C1 常见 + 零宽/Bidi/替换字符。公开文字没有合理用途。 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f​‎‏‪-‮﻿�]/;
/** URL：显式 scheme、常见协议相对写法或 www. 前缀。 */
const URL_PATTERN = /(?:[a-z][a-z0-9+.-]{1,31}:\/\/|(?<![\w@.])www\.)/i;
/** 链接/附件/记录引用语法（ASCII 前缀用 \b；CJK 前缀不能带 \b——中文字符不是 \w）。 */
const ATTACHMENT_PATTERN = /(?:\bdata:|\bfile:|\bblob:|\battachment\b|附件\s*[:：]|记录\s*[:：]\s*\S+\/\S+)/i;
/** 邮箱地址。 */
const EMAIL_PATTERN = /[^\s@]+@[^\s@]+\.[^\s@]{2,}/;
/** 电话：独立数字串（允许空格/短横线分隔）≥7 位即视为联系方式候选，保守拒绝。 */
const PHONE_PATTERN = /(?:^|[^0-9])(?:\+?[0-9][0-9\s-]{5,18}[0-9])(?=$|[^0-9])/;
/** 明确微信联系方式标记（微信号/vx 等常见变体 + 邻近标识）。 */
const WECHAT_PATTERN = /(?:微信|weixin|wx|wx|vx)\s*(?:号|id|:|：)?\s*[:：]?\s*\S{2,}/i;
/** 抖音/其他平台主页链接的常见写法一并按 URL 语法拒绝。 */
const MAINPAGE_PATTERN = /(?:live\.douyin\.com|douyin\.com\/user|v\.douyin\.com)/i;

export type TextPolicyResult = { ok: true } | { ok: false; reason: string };

export function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function validatePublicText(raw: unknown): TextPolicyResult {
  if (typeof raw !== 'string') return { ok: false, reason: '文字必须是字符串' };
  if (!isWellFormedUnicode(raw)) return { ok: false, reason: '文字编码无效' };
  const value = raw.trim();
  if (value.length === 0) return { ok: false, reason: '文字不能为空' };
  if (value.length > MAX_PUBLIC_TEXT_LENGTH) return { ok: false, reason: `文字超过本地长度上限 ${MAX_PUBLIC_TEXT_LENGTH}` };
  if (CONTROL_CHARS.test(value)) return { ok: false, reason: '文字包含控制字符' };
  if (URL_PATTERN.test(value) || MAINPAGE_PATTERN.test(value)) return { ok: false, reason: '文字包含链接语法' };
  if (ATTACHMENT_PATTERN.test(value)) return { ok: false, reason: '文字包含附件/文件/记录引用语法' };
  if (EMAIL_PATTERN.test(value)) return { ok: false, reason: '文字包含邮箱联系方式' };
  if (WECHAT_PATTERN.test(value)) return { ok: false, reason: '文字包含微信联系方式标记' };
  if (PHONE_PATTERN.test(value)) return { ok: false, reason: '文字疑似电话号码' };
  return { ok: true };
}

/**
 * 模板变量（观众名字/礼物名）安全化：只有完全通过校验的短安全文本才会被回显；
 * 任何剥离/超限/可疑语法都会退回不含变量的固定模板，绝不回显未经处理的名字。
 */
export function sanitizeTemplateVariable(raw: unknown, maxLength = MAX_TEMPLATE_NAME_LENGTH): string | null {
  if (typeof raw !== 'string') return null;
  if (!isWellFormedUnicode(raw)) return null;
  const value = raw.trim();
  if (value.length === 0 || value.length > maxLength) return null;
  if (CONTROL_CHARS.test(value)) return null;
  if (URL_PATTERN.test(value) || MAINPAGE_PATTERN.test(value)) return null;
  if (ATTACHMENT_PATTERN.test(value)) return null;
  if (EMAIL_PATTERN.test(value)) return null;
  if (WECHAT_PATTERN.test(value)) return null;
  if (PHONE_PATTERN.test(value)) return null;
  return value;
}

export const WELCOME_TEMPLATE_WITH_NAME = '欢迎 {name} 来到直播间';
export const WELCOME_TEMPLATE_GENERIC = '欢迎来到直播间';
export const GIFT_THANKS_TEMPLATE = '谢谢 {name} 送的 {gift}';

export function renderWelcome(displayName: string | null): string {
  if (displayName === null) return WELCOME_TEMPLATE_GENERIC;
  return WELCOME_TEMPLATE_WITH_NAME.replace('{name}', displayName);
}

export function renderGiftThanks(displayName: string | null, giftName: string | null): string {
  // 礼物金额 unknown：模板永不提及金额，也不把 unknown 写成 0 元。
  if (displayName === null || giftName === null) return '谢谢礼物';
  return GIFT_THANKS_TEMPLATE.replace('{name}', displayName).replace('{gift}', giftName);
}

/** 每条模板产物同样过一遍完整文字校验，模板本身出错也会被拒发。 */
export function validateTemplateOutput(text: string): TextPolicyResult {
  return validatePublicText(text);
}
