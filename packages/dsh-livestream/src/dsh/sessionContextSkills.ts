/**
 * 有界 Skill Markdown 解析（宿主端）。
 *
 * 首版格式是严格 UTF-8、`---` YAML frontmatter、非空正文；必需 name（原生 kebab-case 规则、
 * 最多 64 字符）与 description（最多 2048 字符）。未知 metadata 作为惰性数据不执行；
 * 不接受 YAML 自定义 tag、重复 key、alias/merge、非标量必需字段，限制 frontmatter 深度 8。
 * 支持原生 `disable-model-invocation` / `user-invocable` 的已核实布尔语义；拒绝历史 camelCase 别名。
 * 模型 loader 只可加载 modelInvocable 定义。
 */

import { isAlias, parseDocument, visit } from 'yaml';

export const SKILL_LIMITS = {
  /** 每份原始 UTF-8 最多 64 KiB */
  maxFileBytes: 64 * 1024,
  /** frontmatter 最多 8 KiB */
  maxFrontmatterBytes: 8 * 1024,
  /** 全部 Skill 原始字节合计最多 256 KiB */
  maxTotalBytes: 256 * 1024,
  /** 启用来源最多 8 */
  maxSources: 8,
  /** 每源最多检查 128 个直接条目、最多一级子目录 */
  maxEntriesPerSource: 128,
  /** 最终最多 16 份唯一 Skill */
  maxSkills: 16,
  /** 发现/验证整体预算（毫秒，单在途） */
  scanBudgetMs: 5000,
  /** name 最长 64 字符 */
  maxNameChars: 64,
  /** description 最长 2048 字符 */
  maxDescriptionChars: 2048,
  /** frontmatter 数据深度上限 */
  maxDepth: 8,
} as const;

export interface ParsedSkill {
  name: string;
  description: string;
  /** 明确禁止模型调用（disable-model-invocation: true）或声明仅用户可调（user-invocable: true）时为 false */
  modelInvocable: boolean;
  /** 用户显式调用允许；禁用模型调用时仍对 owner 可见（可发现、不可由模型加载） */
  userInvocable: boolean;
  /** 原始文件字节（sourceHash 由宿主对这份字节计算） */
  raw: Uint8Array;
  /** 去 frontmatter 后的正文 */
  body: string;
  /** frontmatter 里其余键（惰性数据，不执行） */
  metadata: Record<string, unknown>;
}

export type SkillParseFailure =
  | 'encoding'
  | 'missing_frontmatter'
  | 'invalid_yaml'
  | 'unsupported_yaml_feature'
  | 'duplicate_key'
  | 'missing_name'
  | 'invalid_name'
  | 'missing_description'
  | 'invalid_description'
  | 'depth_exceeded'
  | 'frontmatter_too_large'
  | 'empty_body';

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** 历史 camelCase 别名：直接拒绝而不是静默接受 */
const REJECTED_KEYS = ['disableModelInvocation', 'userInvocable', 'modelInvocation'] as const;

function objectDepth(value: unknown, depth: number): number {
  if (depth > SKILL_LIMITS.maxDepth) return depth;
  if (!value || typeof value !== 'object') return depth;
  let max = depth + 1;
  if (Array.isArray(value)) {
    for (const item of value) max = Math.max(max, objectDepth(item, depth + 1));
    return max;
  }
  for (const child of Object.values(value)) max = Math.max(max, objectDepth(child, depth + 1));
  return max;
}

/** alias 与 YAML 自定义 tag（非 `!!` 前缀）一律拒绝；原生 tag 与普通标量放行 */
function hasUnsupportedYaml(node: unknown): 'alias' | 'tag' | null {
  let found: 'alias' | 'tag' | null = null;
  visit(node as never, (_key, nodeValue) => {
    if (isAlias(nodeValue)) {
      found = 'alias';
      return visit.BREAK;
    }
    if (!nodeValue || typeof nodeValue !== 'object' || !('tag' in nodeValue)) return undefined;
    const tag = (nodeValue as { tag?: unknown }).tag;
    if (typeof tag !== 'string') return undefined;
    if (tag.startsWith('!!') || tag === '?') return undefined;
    found = 'tag';
    return visit.BREAK;
  });
  return found;
}

/**
 * 解析一份 Skill Markdown。所有失败都返回受控错误码，不返回部分结果。
 * strict YAML：alias/自定义 tag/重复 key 在文档层直接拒绝；merge 键默认关闭（`<<` 只是普通键，
 * 但会落入未知 metadata 不执行，不构成能力）。
 */
export function parseSkillMarkdown(bytes: Uint8Array): { ok: true; skill: ParsedSkill } | { ok: false; failure: SkillParseFailure; detail?: string } {
  if (bytes.byteLength > SKILL_LIMITS.maxFileBytes) return { ok: false, failure: 'frontmatter_too_large' };
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, failure: 'encoding' };
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return { ok: false, failure: 'missing_frontmatter' };
  const frontmatterText = match[1];
  if (Buffer.byteLength(frontmatterText, 'utf8') > SKILL_LIMITS.maxFrontmatterBytes) return { ok: false, failure: 'frontmatter_too_large' };
  const body = text.slice(match[0].length).replace(/^\r?\n/, '');
  if (!body.trim()) return { ok: false, failure: 'empty_body' };

  const document = parseDocument(frontmatterText, { merge: false });
  const problems = [...document.errors, ...document.warnings];
  if (problems.length) {
    const message = problems[0]?.message ?? '';
    if (/alias|anchor/i.test(message)) return { ok: false, failure: 'unsupported_yaml_feature', detail: message };
    if (/duplicate|unique/i.test(message)) return { ok: false, failure: 'duplicate_key', detail: message };
    return { ok: false, failure: 'invalid_yaml', detail: message };
  }
  const unsupported = hasUnsupportedYaml(document.contents);
  if (unsupported) return { ok: false, failure: 'unsupported_yaml_feature', detail: unsupported === 'alias' ? '不接受 YAML alias' : '不接受 YAML 自定义 tag' };

  const frontmatter: unknown = document.toJS();
  if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    return { ok: false, failure: 'invalid_yaml', detail: 'frontmatter 必须是键值映射' };
  }
  const record = frontmatter as Record<string, unknown>;
  if (objectDepth(record, 0) > SKILL_LIMITS.maxDepth) return { ok: false, failure: 'depth_exceeded' };
  for (const key of Object.keys(record)) {
    if (REJECTED_KEYS.includes(key as (typeof REJECTED_KEYS)[number])) {
      return { ok: false, failure: 'unsupported_yaml_feature', detail: '历史 camelCase 别名不被接受' };
    }
  }
  const name = record.name;
  if (typeof name !== 'string' || !name) return { ok: false, failure: 'missing_name' };
  if ([...name].length > SKILL_LIMITS.maxNameChars || !NAME_PATTERN.test(name)) return { ok: false, failure: 'invalid_name' };
  const description = record.description;
  if (typeof description !== 'string' || !description.trim()) return { ok: false, failure: 'missing_description' };
  if ([...description].length > SKILL_LIMITS.maxDescriptionChars) return { ok: false, failure: 'invalid_description' };
  const disable = record['disable-model-invocation'];
  const userOnly = record['user-invocable'];
  if (disable !== undefined && typeof disable !== 'boolean') return { ok: false, failure: 'invalid_yaml', detail: 'disable-model-invocation 必须是布尔值' };
  if (userOnly !== undefined && typeof userOnly !== 'boolean') return { ok: false, failure: 'invalid_yaml', detail: 'user-invocable 必须是布尔值' };
  const metadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key !== 'name' && key !== 'description' && key !== 'disable-model-invocation' && key !== 'user-invocable') metadata[key] = value;
  }
  return {
    ok: true,
    skill: {
      name,
      description,
      modelInvocable: disable !== true && userOnly !== true,
      userInvocable: userOnly !== false,
      raw: bytes,
      body,
      metadata,
    },
  };
}
