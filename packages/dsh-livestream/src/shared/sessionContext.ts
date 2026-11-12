/**
 * 直播会话上下文：浏览器与宿主共用的 JSON DTO、纯结构校验、默认值和受限工具结果枚举。
 *
 * 这里只定义一处结构规则：不 import Node/fs/path、运行时或服务实例；
 * 宿主（src/dsh/sessionContext*.ts）在这之上再加实际 IO 验证，浏览器只提交 config 和 revision。
 */

export const SESSION_CONTEXT_SCHEMA_VERSION = 1;

/** 单个 Skill 来源或资料根：owner 显式路径 + 启停 */
export interface SessionContextEntry {
  path: string;
  enabled: boolean;
}

/** 一次保存的整体配置：cwd 可留空（沿用原控制台 workspace） */
export interface SessionContextConfig {
  enabled: boolean;
  cwd: string;
  skillSources: SessionContextEntry[];
  readRoots: SessionContextEntry[];
}

/** POST settings 里的整组替换请求：不对数组逐项 patch */
export interface SessionContextSaveRequest {
  expectedRevision: number;
  config: SessionContextConfig;
}

/** 保存后返回给 owner 的单条健康检查视图（不含宿主绑定细节） */
export interface SessionContextHealthEntry {
  kind: 'skill' | 'root' | 'cwd';
  index: number;
  path: string;
  enabled: boolean;
  status: 'valid' | 'not_found' | 'unreadable' | 'invalid' | 'conflict' | 'disabled';
  /** 人类可读的修正提示；不含原生 Error 文本 */
  detail?: string;
}

/** owner 状态里的已保存视图 */
export interface SessionContextSavedView {
  revision: number;
  config: SessionContextConfig;
}

/** 快照里的一份冻结 Skill（owner 可见；正文不进公共状态） */
export interface SessionContextSkillView {
  name: string;
  description: string;
  status: 'available' | 'unavailable';
  /** 最近一次实际加载是否成功；未加载为 null */
  loadedAt: number | null;
  /** 实际进入会话的正文 hash（SHA-256，去 frontmatter 后） */
  contentHash: string | null;
}

/** 活动会话快照视图（owner 状态用） */
export interface SessionContextSnapshotView {
  sessionId: string;
  revision: number;
  platform: string;
  presetId: string;
  /** 实际生效的目录；空串表示沿用原 workspace */
  effectiveCwd: string;
  cwdReady: boolean;
  skills: SessionContextSkillView[];
  rootIds: string[];
  issues: string[];
  createdAt: number;
}

/** GET state 里新增的 sessionContext 视图 */
export interface SessionContextStateView {
  /** null：从未保存过（legacy）；enabled:false 是显式关闭 */
  saved: SessionContextSavedView | null;
  /** 保存记录本身损坏时的提示；存在时 saved 为 null */
  invalid?: string;
  health: {
    checkedAt: number | null;
    entries: SessionContextHealthEntry[];
  };
  active: SessionContextSnapshotView | null;
  /** 上次显式重查被拒绝的原因（限频/在途），文字状态 */
  recheck?: string;
}

/** 受限工具与读取路径的统一结果状态 */
export type SessionContextStatus =
  | 'available'
  | 'loaded'
  | 'empty'
  | 'unavailable'
  | 'denied'
  | 'unsupported'
  | 'busy'
  | 'timeout'
  | 'cancelled'
  | 'limit_exceeded';

/** 校验失败的定位信息：发给 owner 的是字段与错误码，不含原生错误文本 */
export interface SessionContextIssue {
  code: string;
  field: string;
  detail?: string;
}

const MAX_LIST_ITEMS = 8;
const MAX_PATH_CHARS = 4096;

function hasBuiltinPrototype(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** 路径文本的结构检查：结构合法返回 null，否则返回给 owner 的错误码 */
export function checkPathText(raw: unknown, field: string): SessionContextIssue | null {
  if (typeof raw !== 'string') return { code: 'invalid_type', field };
  if (raw.length === 0) return { code: 'empty_path', field };
  if (raw.length > MAX_PATH_CHARS) return { code: 'path_too_long', field };
  for (const character of raw) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0 || (code > 0 && code < 0x20) || code === 0x7f) return { code: 'control_character', field };
    if (character.length === 1 && code >= 0xd800 && code <= 0xdfff) return { code: 'lone_surrogate', field };
  }
  if (/^[\w+.-]+:\/\//.test(raw) || /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('\\\\')) return { code: 'uri_or_windows_path', field };
  if (!raw.startsWith('/')) return { code: 'relative_path', field };
  if (raw.startsWith('/~') || raw === '~' || raw.includes('/~') || raw.includes('${') || raw.includes('$HOME')) return { code: 'expansion_not_allowed', field };
  // 方向控制字符全部拒绝：U+202A～U+202E（含 LRE/LEFTRUNTIME）与 U+2066～U+2069（isolate）
  if (/[‪‫‬‭‮⁦-⁩]/.test(raw)) return { code: 'bidi_control', field };
  return null;
}

function validateEntry(raw: unknown, field: string): SessionContextIssue | EntryIssue {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !hasBuiltinPrototype(raw)) return { code: 'invalid_entry', field };
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'path' && key !== 'enabled') return { code: 'unknown_field', field: `${field}.${key}` };
  }
  const path = record.path;
  const pathIssue = checkPathText(path, `${field}.path`);
  if (pathIssue) return pathIssue;
  if (typeof path !== 'string') return { code: 'invalid_type', field: `${field}.path` };
  if (typeof record.enabled !== 'boolean') return { code: 'invalid_enabled', field: `${field}.enabled` };
  return { path, enabled: record.enabled };
}

type EntryIssue = SessionContextIssue | { path: string; enabled: boolean };

function validateList(raw: unknown, field: string): SessionContextIssue | { items: SessionContextEntry[] } {
  if (!Array.isArray(raw)) return { code: 'invalid_list', field };
  if (raw.length > MAX_LIST_ITEMS) return { code: 'too_many_items', field };
  const items: SessionContextEntry[] = [];
  for (const [index, item] of raw.entries()) {
    const result = validateEntry(item, `${field}[${index}]`);
    if ('code' in result) return result;
    items.push(result);
  }
  return { items };
}

/** 结构校验：只查形状与文本规则，不读磁盘；通过返回 config，失败返回定位错误 */
export function validateSessionContextConfig(raw: unknown): { ok: true; config: SessionContextConfig } | { ok: false; issue: SessionContextIssue } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !hasBuiltinPrototype(raw)) {
    return { ok: false, issue: { code: 'invalid_config', field: 'config' } };
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!['enabled', 'cwd', 'skillSources', 'readRoots'].includes(key)) {
      return { ok: false, issue: { code: 'unknown_field', field: `config.${key}` } };
    }
  }
  if (typeof record.enabled !== 'boolean') return { ok: false, issue: { code: 'invalid_enabled', field: 'config.enabled' } };
  if (typeof record.cwd !== 'string') return { ok: false, issue: { code: 'invalid_type', field: 'config.cwd' } };
  if (record.cwd.length > MAX_PATH_CHARS) return { ok: false, issue: { code: 'path_too_long', field: 'config.cwd' } };
  if (record.cwd !== '') {
    // 空 cwd 合法（沿用原控制台 workspace）；非空必须同样满足路径文本规则
    const issue = checkPathText(record.cwd, 'config.cwd');
    if (issue) return { ok: false, issue };
  }
  const skills = validateList(record.skillSources, 'config.skillSources');
  if ('code' in skills) return { ok: false, issue: skills };
  const roots = validateList(record.readRoots, 'config.readRoots');
  if ('code' in roots) return { ok: false, issue: roots };
  return {
    ok: true,
    config: { enabled: record.enabled, cwd: record.cwd, skillSources: skills.items, readRoots: roots.items },
  };
}

export function validateSessionContextSaveRequest(raw: unknown): { ok: true; request: SessionContextSaveRequest } | { ok: false; issue: SessionContextIssue } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !hasBuiltinPrototype(raw)) {
    return { ok: false, issue: { code: 'invalid_request', field: 'sessionContext' } };
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!['expectedRevision', 'config'].includes(key)) {
      return { ok: false, issue: { code: 'unknown_field', field: `sessionContext.${key}` } };
    }
  }
  if (typeof record.expectedRevision !== 'number' || !Number.isSafeInteger(record.expectedRevision) || record.expectedRevision < 0) {
    return { ok: false, issue: { code: 'invalid_revision', field: 'sessionContext.expectedRevision' } };
  }
  const config = validateSessionContextConfig(record.config);
  if (!config.ok) return config;
  return { ok: true, request: { expectedRevision: record.expectedRevision, config: config.config } };
}

/** 宿主持久记录：settings.sessionContext 的完整形状；bindings 由宿主维护，客户端不能提交 */
export interface SessionContextBinding {
  /** canonical realpath */
  path: string;
  dev: number;
  ino: number;
}

export interface SessionContextRecord {
  schemaVersion: number;
  revision: number;
  config: SessionContextConfig;
  /** canonical path + dev/ino；按输入顺序排列 */
  bindings: {
    cwd: SessionContextBinding | null;
    /** 文件型 Skill 绑定父目录；file 为该文件的 canonical 路径 */
    skills: Array<SessionContextBinding & { index: number; file?: string }>;
    roots: Array<SessionContextBinding & { index: number }>;
  };
}

export type DecodedSessionContextRecord =
  | { kind: 'saved'; record: SessionContextRecord }
  | { kind: 'invalid'; reason: string };

/** 启动/读取时的有界解码：损坏或未知版本保留为 invalid，不悄悄回退成有效空配置 */
export function decodeSessionContextRecord(raw: unknown): DecodedSessionContextRecord | null {
  if (raw === undefined || raw === null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !hasBuiltinPrototype(raw)) {
    return { kind: 'invalid', reason: '损坏的保存记录' };
  }
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== SESSION_CONTEXT_SCHEMA_VERSION) return { kind: 'invalid', reason: '不支持的 schemaVersion' };
  if (typeof record.revision !== 'number' || !Number.isSafeInteger(record.revision) || record.revision < 0) {
    return { kind: 'invalid', reason: '损坏的 revision' };
  }
  const config = validateSessionContextConfig(record.config);
  if (!config.ok) return { kind: 'invalid', reason: '损坏的配置' };
  const bindings = decodeBindings(record.bindings);
  if (!bindings.ok) return { kind: 'invalid', reason: '损坏的绑定' };
  return {
    kind: 'saved',
    record: {
      schemaVersion: SESSION_CONTEXT_SCHEMA_VERSION,
      revision: record.revision,
      config: config.config,
      bindings: bindings.value,
    },
  };
}

/**
 * 绑定解码：形状损坏时整体失败（由调用方把整条记录转 invalid），不再宽松回退成空绑定。
 * 空但形状完好的绑定（cwd null、两个空数组）是显式关闭保存的合法形状，仍然有效。
 */
function decodeBindings(raw: unknown): { ok: true; value: SessionContextRecord['bindings'] } | { ok: false } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !hasBuiltinPrototype(raw)) return { ok: false };
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'cwd' && key !== 'skills' && key !== 'roots') return { ok: false };
  }
  const readFields = (binding: Record<string, unknown>): SessionContextBinding | null => {
    if (typeof binding.path !== 'string' || !binding.path.startsWith('/')) return null;
    if (typeof binding.dev !== 'number' || !Number.isSafeInteger(binding.dev) || binding.dev < 0) return null;
    if (typeof binding.ino !== 'number' || !Number.isSafeInteger(binding.ino) || binding.ino <= 0) return null;
    return { path: binding.path, dev: binding.dev, ino: binding.ino };
  };
  const read = (value: unknown): SessionContextBinding | null => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !hasBuiltinPrototype(value)) return null;
    const binding = value as Record<string, unknown>;
    for (const key of Object.keys(binding)) {
      if (key !== 'path' && key !== 'dev' && key !== 'ino') return null;
    }
    return readFields(binding);
  };
  const list = (value: unknown, fileAllowed: boolean): Array<SessionContextBinding & { index: number; file?: string }> | null => {
    if (!Array.isArray(value)) return null;
    const out: Array<SessionContextBinding & { index: number; file?: string }> = [];
    for (const item of value) {
      if (!item || typeof item !== 'object' || Array.isArray(item) || !hasBuiltinPrototype(item)) return null;
      const entry = item as Record<string, unknown>;
      // 条目键白名单：path/dev/ino + index（+ file 仅限文件型 Skill 绑定）
      const allowedKeys = fileAllowed ? ['path', 'dev', 'ino', 'index', 'file'] : ['path', 'dev', 'ino', 'index'];
      for (const key of Object.keys(entry)) {
        if (!allowedKeys.includes(key)) return null;
      }
      const binding = readFields(entry);
      if (!binding) return null;
      const index = entry.index;
      // index 是保存时的配置条目位次，用存储值（数组顺序可能与去重后的位次不同）
      if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) return null;
      const file = entry.file;
      if (file === undefined) {
        out.push({ ...binding, index });
        continue;
      }
      if (!fileAllowed || typeof file !== 'string' || !file.startsWith('/')) return null;
      out.push({ ...binding, index, file });
    }
    return out;
  };
  const cwd = record.cwd === null ? null : read(record.cwd);
  if (record.cwd !== null && cwd === null) return { ok: false };
  const skills = list(record.skills, true);
  if (!skills) return { ok: false };
  const roots = list(record.roots, false);
  if (!roots) return { ok: false };
  return { ok: true, value: { cwd, skills, roots } };
}

/** owner 可见的工具结果统一文案；模型结果只出现这些受控词 */
export const STATUS_TEXT: Record<SessionContextStatus, string> = {
  available: '可用',
  loaded: '已加载',
  empty: '没有内容',
  unavailable: '不可用',
  denied: '已拒绝：超出授权范围',
  unsupported: '不支持的内容',
  busy: '正在处理其他读取',
  timeout: '读取超时',
  cancelled: '已取消',
  limit_exceeded: '超出预算',
};

/** 快照文件的单条上限等宿主预算常量（shared 提供数值，宿主执行） */
export const SESSION_CONTEXT_LIMITS = {
  maxListItems: MAX_LIST_ITEMS,
  maxPathChars: MAX_PATH_CHARS,
} as const;
