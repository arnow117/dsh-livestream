export interface TtsSettings {
  backend: 'yovoice' | 'macos' | 'doubao';
  yovoiceModel: string;
  yovoiceVoice: string;
  macosVoice: string;
  doubaoVoice: string;
  doubaoRate: number;
}

export const DEFAULT_YOVOICE_VOICE = '年轻温暖的中文女声，自然亲切，像和朋友聊天，咬字清楚，语气轻松活泼';

export function defaultTtsSettings(env: Record<string, string | undefined>, voice: string): TtsSettings {
  const backend = env.DSH_LIVESTREAM_TTS_BACKEND;
  const model = env.DSH_LIVESTREAM_YOVOICE_MODEL?.trim() || 'voxcpm2-q8';
  return {
    backend: backend === 'yovoice' || backend === 'macos' ? backend : 'doubao',
    yovoiceModel: model,
    yovoiceVoice: env.DSH_LIVESTREAM_YOVOICE_VOICE?.trim() || DEFAULT_YOVOICE_VOICE,
    macosVoice: env.DSH_LIVESTREAM_MACOS_VOICE?.trim() || 'Tingting',
    doubaoVoice: voice,
    doubaoRate: 0,
  };
}

export function mergeTtsSettings(current: TtsSettings, patch: unknown, options: { allowInvalidCurrent?: boolean } = {}): TtsSettings {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.getPrototypeOf(patch) !== Object.prototype) {
    throw new Error('声音设置必须是对象');
  }
  for (const key of Object.keys(patch)) {
    if (!Object.hasOwn(current, key)) throw new Error('未知声音设置');
  }
  const result = { ...current };
  const values = options.allowInvalidCurrent ? patch : { ...current, ...patch };
  for (const [key, value] of Object.entries(values)) {
    switch (key) {
      case 'backend':
        if (value !== 'yovoice' && value !== 'macos' && value !== 'doubao') throw new Error('不支持的语音后端');
        result.backend = value;
        break;
      case 'yovoiceModel':
        if (value !== 'voxcpm2-q8' && value !== 'voxcpm2-bf16') throw new Error('不支持的 yovoice 模型');
        result.yovoiceModel = value;
        break;
      case 'yovoiceVoice':
      case 'macosVoice':
      case 'doubaoVoice': {
        if (typeof value !== 'string') throw new Error('音色必须是文字');
        const trimmed = value.trim();
        const limit = key === 'yovoiceVoice' ? 500 : key === 'macosVoice' ? 100 : 200;
        const characters = [...trimmed];
        const malformed = characters.some((character) => character.length === 1 && character.charCodeAt(0) >= 0xd800 && character.charCodeAt(0) <= 0xdfff);
        if (malformed || (!trimmed && key !== 'doubaoVoice') || characters.length > limit) throw new Error('音色长度无效');
        result[key] = trimmed;
        break;
      }
      case 'doubaoRate':
        if (typeof value !== 'number' || !Number.isInteger(value) || value < -50 || value > 100) throw new Error('语速无效');
        result.doubaoRate = value;
        break;
      default:
        throw new Error('未知声音设置');
    }
  }
  return result;
}
