/**
 * 直播会话上下文：宿主设置验证、有界 Skill 加载、资料受限读取、快照存取。
 *
 * 复用 runtime 的 settings 原子提交（同目录独占 0600 临时 JSON rename 成功后才发布内存）；
 * 本模块只对插件自有 settings 字段 `sessionContext` 与 `session-context/` 快照执行写入；
 * Skill、cwd 与资料树只有受限只读 IO。
 *
 * 三个独立授权集合（工程上下文决定 3）：cwd 只进 native header/workingDirectory；
 * Skill 来源只授权读取选定 Markdown；资料工具只访问快照内 rootId 指定的根。
 */

import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  decodeSessionContextRecord,
  STATUS_TEXT,
  validateSessionContextSaveRequest,
  SESSION_CONTEXT_LIMITS,
  type SessionContextConfig,
  type SessionContextEntry,
  type SessionContextHealthEntry,
  type SessionContextIssue,
  type SessionContextRecord,
  type SessionContextSaveRequest,
  type SessionContextSkillView,
  type SessionContextSnapshotView,
  type SessionContextStateView,
  type SessionContextStatus,
} from '../shared/sessionContext';
import { bindDirectory, readBoundedFile, verifyDirectory, type DirectoryBinding, type PathFailure } from './sessionContextPaths';
import { parseSkillMarkdown, SKILL_LIMITS } from './sessionContextSkills';
import { dataDir, hooks, settings } from './runtime';

// ── 预算与目录常量 ────────────────────────────────────

const SNAPSHOT_LIMITS = {
  /** 单条 JSON 最多 2 MiB */
  maxFileBytes: 2 * 1024 * 1024,
  /** 解码深度最多 16 */
  maxDecodeDepth: 16,
  /** 目录最多 128 条 */
  maxFiles: 128,
  /** 目录总量最多 128 MiB */
  maxTotalBytes: 128 * 1024 * 1024,
} as const;

const MATERIAL_LIMITS = {
  /** 原始文件最多 256 KiB */
  maxFileBytes: 256 * 1024,
  /** startLine 默认 1 */
  defaultStartLine: 1,
  /** maxLines 默认 80、范围 1～200 */
  defaultMaxLines: 80,
  maxLines: 200,
  /** 返回最多 16 KiB UTF-8 */
  maxOutputBytes: 16 * 1024,
  /** 每 turn 最多 4 次尝试 */
  attemptsPerTurn: 4,
  /** 实际读取缓冲累计最多 512 KiB */
  turnBufferBytes: 512 * 1024,
  /** 返回正文累计最多 32 KiB */
  turnOutputBytes: 32 * 1024,
  /** 单次 2 秒 */
  readTimeoutMs: 2000,
} as const;

const SKILL_TURN_LIMITS = {
  /** 每 turn 最多 4 次调用 */
  callsPerTurn: 4,
  /** 每 turn 合计最多 128 KiB 正文字节 */
  turnBodyBytes: 128 * 1024,
} as const;

export const SESSION_CONTEXT_ISSUE_TEXT: Record<string, string> = {
  invalid_type: '类型无效',
  invalid_config: '配置无效',
  invalid_request: '请求无效',
  invalid_enabled: '开关必须是布尔值',
  invalid_entry: '条目无效',
  invalid_list: '列表无效',
  invalid_revision: 'revision 无效',
  invalid_path: '路径无效',
  empty_path: '路径不能为空',
  path_too_long: '路径太长',
  control_character: '路径含控制字符',
  lone_surrogate: '路径含不完整字符',
  uri_or_windows_path: '只接受本机绝对路径',
  relative_path: '必须是 / 开头的绝对路径',
  expansion_not_allowed: '不接受 ~ 或环境变量写法',
  bidi_control: '路径含不可见方向字符',
  unknown_field: '未知字段',
  too_many_items: '列表最多 8 项',
  revision_conflict: '设置已变化，请刷新后重试',
  duplicate_path: '同一来源/根重复提交',
  duplicate_name: '不同来源的 Skill 同名冲突',
  mixed_enabled: '重复项的启停不一致',
  HOST_COMPOSITION_UNSUPPORTED: '宿主全局 Skill/文件工具处于启用状态，无法确认来源隔离',
};

export interface SessionSnapshotSkill {
  name: string;
  description: string;
  modelInvocable: boolean;
  userInvocable: boolean;
  /** canonical 文件来源（owner 诊断；不进模型消息） */
  sourcePath: string;
  /** 原始文件 SHA-256 */
  sourceHash: string;
  /** 去 frontmatter 后正文 SHA-256 */
  contentHash: string;
  body: string;
}

export interface SessionContextSnapshot {
  schemaVersion: 1;
  sessionId: string;
  revision: number;
  platform: string;
  presetId: string;
  effectiveCwd: string;
  cwdBinding: DirectoryBinding | null;
  rootBindings: Array<{ rootId: string; binding: DirectoryBinding }>;
  skills: SessionSnapshotSkill[];
  issues: string[];
  createdAt: number;
}

// ── 保存记录读取 ──────────────────────────────────────

export type CurrentRecord =
  | { kind: 'saved'; record: SessionContextRecord }
  | { kind: 'invalid'; reason: string }
  | null;

export function currentRecord(): CurrentRecord {
  const raw = (settings as { sessionContext?: unknown }).sessionContext;
  return decodeSessionContextRecord(raw);
}

function issueText(issue: SessionContextIssue): string {
  const base = SESSION_CONTEXT_ISSUE_TEXT[issue.code] ?? issue.code;
  return issue.detail ? `${base}（${issue.field}：${issue.detail}）` : `${base}（${issue.field}）`;
}

// ── 有界发现与解析 ────────────────────────────────────

export interface DiscoveredSkill {
  name: string;
  description: string;
  modelInvocable: boolean;
  userInvocable: boolean;
  /** canonical 文件路径 */
  sourcePath: string;
  raw: Uint8Array;
  body: string;
  sourceHash: string;
  contentHash: string;
}

export type DiscoveryFailure =
  | { ok: true; skills: DiscoveredSkill[] }
  | { ok: false; code: 'limit_exceeded' | 'not_found' | 'unreadable' | 'invalid' | 'conflict'; field: string; detail: string };

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** 单个启用来源的有界发现：显式 .md 文件、含 SKILL.md 的目录，或容器目录（直接 .md + 一级子目录） */
function discoverSource(entry: SessionContextEntry, canonicalRoot: string, index: number, discovered: DiscoveredSkill[], seenPaths: Set<string>): DiscoveryFailure {
  let stats;
  try {
    stats = lstatSync(canonicalRoot);
  } catch {
    return { ok: false, code: 'not_found', field: `config.skillSources[${index}].path`, detail: '来源不存在' };
  }
  if (stats.isSymbolicLink()) return { ok: false, code: 'invalid', field: `config.skillSources[${index}].path`, detail: '来源是指向外部的符号链接' };
  let candidates: string[];
  if (stats.isFile()) {
    if (!canonicalRoot.endsWith('.md')) return { ok: false, code: 'invalid', field: `config.skillSources[${index}].path`, detail: '文件来源必须是 .md' };
    candidates = [canonicalRoot];
  } else {
    const ownSkillFile = join(canonicalRoot, 'SKILL.md');
    if (existsSync(ownSkillFile)) {
      // 遇到直接 SKILL.md 就作为单 Skill 目录，不再扩展其兄弟文件
      candidates = [ownSkillFile];
    } else {
      let names: string[];
      try {
        names = readdirSync(canonicalRoot);
      } catch {
        return { ok: false, code: 'unreadable', field: `config.skillSources[${index}].path`, detail: '来源目录不可读' };
      }
      if (names.length > SKILL_LIMITS.maxEntriesPerSource) {
        return { ok: false, code: 'limit_exceeded', field: `config.skillSources[${index}].path`, detail: `来源条目超过 ${SKILL_LIMITS.maxEntriesPerSource} 个` };
      }
      candidates = [];
      // 容器仅发现直接 .md 和一级子目录的 SKILL.md；不递归读取 references/scripts/dependencies
      for (const name of names.filter((item) => item.endsWith('.md'))) {
        const file = join(canonicalRoot, name);
        const child = lstatSync(file, { throwIfNoEntry: false });
        if (!child) continue;
        // 候选 Markdown 是符号链接 → 拒绝来源，不默默当成「未发现」
        if (child.isSymbolicLink()) return { ok: false, code: 'invalid', field: `config.skillSources[${index}].path`, detail: `候选 Markdown ${name} 是符号链接` };
        if (child.isFile()) candidates.push(file);
      }
      for (const name of names) {
        const dir = join(canonicalRoot, name);
        const child = lstatSync(dir, { throwIfNoEntry: false });
        if (!child || child.isSymbolicLink() || !child.isDirectory()) continue;
        const skillFile = join(dir, 'SKILL.md');
        if (existsSync(skillFile)) candidates.push(skillFile);
      }
    }
  }
  for (const file of candidates) {
    if (discovered.length >= SKILL_LIMITS.maxSkills) {
      return { ok: false, code: 'limit_exceeded', field: 'config.skillSources', detail: `唯一 Skill 超过 ${SKILL_LIMITS.maxSkills} 份` };
    }
    if (seenPaths.has(file)) continue;
    let bytes: Uint8Array;
    try {
      const buffer = readFileSync(file);
      if (buffer.byteLength > SKILL_LIMITS.maxFileBytes) {
        return { ok: false, code: 'limit_exceeded', field: `config.skillSources[${index}].path`, detail: `Skill 文件超过 ${SKILL_LIMITS.maxFileBytes} 字节` };
      }
      bytes = new Uint8Array(buffer);
    } catch {
      return { ok: false, code: 'unreadable', field: `config.skillSources[${index}].path`, detail: 'Skill 文件不可读' };
    }
    const parsed = parseSkillMarkdown(bytes);
    if (!parsed.ok) {
      return { ok: false, code: 'invalid', field: `config.skillSources[${index}].path`, detail: `Skill 声明无效（${parsed.failure}）` };
    }
    if (discovered.some((existing) => existing.name === parsed.skill.name)) {
      return { ok: false, code: 'conflict', field: `config.skillSources[${index}].path`, detail: `不同来源的 Skill 同名：${parsed.skill.name}` };
    }
    seenPaths.add(file);
    discovered.push({
      name: parsed.skill.name,
      description: parsed.skill.description,
      modelInvocable: parsed.skill.modelInvocable,
      userInvocable: parsed.skill.userInvocable,
      sourcePath: file,
      raw: bytes,
      body: parsed.skill.body,
      sourceHash: sha256(bytes),
      contentHash: sha256(new TextEncoder().encode(parsed.skill.body)),
    });
  }
  return { ok: true, skills: discovered };
}

/** 保存/创建共用的发现入口：预算、去重、同名冲突都在这里收口。allowMissing 供创建时降级（缺失条目跳过并标记问题） */
export async function discoverSkills(config: SessionContextConfig, options: { allowMissing?: boolean } = {}): Promise<DiscoveryFailure> {
  const enabled = config.skillSources.filter((entry) => entry.enabled);
  if (!enabled.length) return { ok: true, skills: [] };
  if (enabled.length > SKILL_LIMITS.maxSources) {
    return { ok: false, code: 'limit_exceeded', field: 'config.skillSources', detail: `启用来源超过 ${SKILL_LIMITS.maxSources} 个` };
  }
  const discovered: DiscoveredSkill[] = [];
  const seenPaths = new Set<string>();
  const seenCanonical = new Map<string, number>();
  let totalBytes = 0;
  const deadline = Date.now() + SKILL_LIMITS.scanBudgetMs;
  for (const [index, entry] of config.skillSources.entries()) {
    if (!entry.enabled) continue;
    if (Date.now() > deadline) return { ok: false, code: 'limit_exceeded', field: `config.skillSources[${index}].path`, detail: '发现整体超时' };
    // owner 显式选择的根级 symlink 在这里解析为规范目标；之后授权只记该目标
    let canonical: string;
    try {
      canonical = realpathSync(entry.path);
    } catch {
      if (options.allowMissing) continue;
      return { ok: false, code: 'not_found', field: `config.skillSources[${index}].path`, detail: '来源不存在' };
    }
    const stats = lstatSync(canonical, { throwIfNoEntry: false });
    if (!stats) {
      if (options.allowMissing) continue;
      return { ok: false, code: 'not_found', field: `config.skillSources[${index}].path`, detail: '来源不存在' };
    }
    if (stats.isSymbolicLink()) return { ok: false, code: 'invalid', field: `config.skillSources[${index}].path`, detail: '来源是指向外部的符号链接' };
    try {
      accessSync(canonical, stats.isFile() ? constants.R_OK : constants.R_OK | constants.X_OK);
    } catch {
      if (options.allowMissing) continue;
      return { ok: false, code: 'unreadable', field: `config.skillSources[${index}].path`, detail: '来源不可读' };
    }
    if (!stats.isFile() && !stats.isDirectory()) {
      return { ok: false, code: 'invalid', field: `config.skillSources[${index}].path`, detail: '来源不是普通文件或目录' };
    }
    const previous = seenCanonical.get(canonical);
    if (previous !== undefined) {
      if (entry.enabled !== config.skillSources[previous].enabled) {
        return { ok: false, code: 'conflict', field: `config.skillSources[${index}].path`, detail: '同一来源的启停不一致' };
      }
      continue;
    }
    seenCanonical.set(canonical, index);
    const before = discovered.length;
    const result = discoverSource(entry, canonical, index, discovered, seenPaths);
    if (!result.ok) {
      // 创建时来源目录整体缺失按降级处理；解析冲突/预算仍拒绝
      if (options.allowMissing && (result.code === 'not_found' || result.code === 'unreadable')) continue;
      return result;
    }
    for (const skill of discovered.slice(before)) totalBytes += skill.raw.byteLength;
    if (totalBytes > SKILL_LIMITS.maxTotalBytes) {
      return { ok: false, code: 'limit_exceeded', field: 'config.skillSources', detail: `Skill 原始字节合计超过 ${SKILL_LIMITS.maxTotalBytes}` };
    }
  }
  return { ok: true, skills: discovered };
}

// ── 保存 ──────────────────────────────────────────────

export type SaveOutcome =
  | { ok: true; view: SessionContextStateView }
  | { ok: false; status: number; error: string; issue?: SessionContextIssue };

/** 保存候选的完整验证：结构 → IO；全部通过才允许一次原子提交（由 index.ts 调 updateSettings） */
export async function validateSaveCandidate(request: SessionContextSaveRequest): Promise<
  { ok: true; record: SessionContextRecord; health: SessionContextHealthEntry[] } | { ok: false; status: number; error: string; issue?: SessionContextIssue }
> {
  const config = request.config;
  const health: SessionContextHealthEntry[] = [];
  const bindings: SessionContextRecord['bindings'] = { cwd: null, skills: [], roots: [] };
  const ioNeeded = config.enabled && (config.cwd !== '' || config.skillSources.some((entry) => entry.enabled) || config.readRoots.some((entry) => entry.enabled));
  if (!ioNeeded) {
    // enabled:false 或单项关闭仅做结构校验，保留合法路径文本、不读取磁盘
    for (const [index, entry] of config.skillSources.entries()) {
      if (!entry.enabled) health.push({ kind: 'skill', index, path: entry.path, enabled: false, status: 'disabled' });
    }
    for (const [index, entry] of config.readRoots.entries()) {
      if (!entry.enabled) health.push({ kind: 'root', index, path: entry.path, enabled: false, status: 'disabled' });
    }
    if (config.cwd !== '' && !config.enabled) health.push({ kind: 'cwd', index: 0, path: config.cwd, enabled: false, status: 'disabled' });
    return { ok: true, record: { schemaVersion: 1, revision: request.expectedRevision, config, bindings }, health };
  }
  // cwd：存在且为可遍历、可读目录（R_OK + X_OK）；不 mkdir、不修权限
  if (config.cwd !== '') {
    const binding = await bindDirectory(config.cwd);
    if (typeof binding === 'string') {
      const status = binding === 'not_found' ? 'not_found' : binding === 'not_directory' ? 'invalid' : 'unreadable';
      health.push({ kind: 'cwd', index: 0, path: config.cwd, enabled: true, status, detail: '工作目录不存在或不可读' });
      return { ok: false, status: 400, error: `工作目录无效：${config.cwd}`, issue: { code: status, field: 'config.cwd' } };
    }
    bindings.cwd = binding;
    health.push({ kind: 'cwd', index: 0, path: binding.path, enabled: true, status: 'valid' });
  }
  // 启用来源逐个有界发现；无效声明不是成功的空 Skill
  const skills = await discoverSkills(config);
  if (!skills.ok) {
    const status = skills.code === 'not_found' ? 'not_found' : skills.code === 'unreadable' ? 'unreadable' : skills.code === 'conflict' ? 'conflict' : 'invalid';
    const limit = skills.code === 'limit_exceeded';
    return {
      ok: false,
      status: 400,
      error: `${limit ? 'Skill 来源超出预算' : 'Skill 来源无效'}：${skills.detail}`,
      issue: { code: limit ? 'too_many_items' : status, field: skills.field },
    };
  }
  for (const [index, entry] of config.skillSources.entries()) {
    if (!entry.enabled) {
      health.push({ kind: 'skill', index, path: entry.path, enabled: false, status: 'disabled' });
      continue;
    }
    // 文件型 Skill 绑定父目录，允许下次新会话读取同一路径的合法新正文
    const canonical = realpathSync(entry.path);
    const stats = lstatSync(canonical);
    if (stats.isFile()) {
      const parent = await bindDirectory(dirname(canonical));
      if (typeof parent === 'string') {
        return { ok: false, status: 400, error: `Skill 来源父目录无效：${dirname(canonical)}`, issue: { code: 'invalid', field: `config.skillSources[${index}].path` } };
      }
      // 同一规范文件重复提交只保留一份绑定（不增加加载）
      if (!bindings.skills.some((existing) => existing.file === canonical)) {
        bindings.skills.push({ index, path: parent.path, dev: parent.dev, ino: parent.ino, file: canonical });
      }
      health.push({ kind: 'skill', index, path: canonical, enabled: true, status: 'valid' });
    } else {
      const bound = await bindDirectory(canonical);
      if (typeof bound === 'string') {
        return { ok: false, status: 400, error: `Skill 来源目录无效：${canonical}`, issue: { code: 'invalid', field: `config.skillSources[${index}].path` } };
      }
      if (!bindings.skills.some((existing) => !existing.file && existing.path === bound.path)) {
        bindings.skills.push({ index, path: bound.path, dev: bound.dev, ino: bound.ino });
      }
      health.push({ kind: 'skill', index, path: bound.path, enabled: true, status: 'valid' });
    }
  }
  // 资料根：必须存在且为可读目录
  const rootCanonical = new Map<string, number>();
  for (const [index, entry] of config.readRoots.entries()) {
    if (!entry.enabled) {
      health.push({ kind: 'root', index, path: entry.path, enabled: false, status: 'disabled' });
      continue;
    }
    const binding = await bindDirectory(entry.path);
    if (typeof binding === 'string') {
      const status = binding === 'not_found' ? 'not_found' : binding === 'not_directory' ? 'invalid' : 'unreadable';
      return { ok: false, status: 400, error: `资料根无效：${entry.path}`, issue: { code: status, field: `config.readRoots[${index}].path` } };
    }
    const previous = rootCanonical.get(binding.path);
    if (previous !== undefined && config.readRoots[previous].enabled !== entry.enabled) {
      return { ok: false, status: 400, error: '同一资料根的启停不一致', issue: { code: 'mixed_enabled', field: `config.readRoots[${index}].path` } };
    }
    if (previous !== undefined) {
      // 重复同一项不增加加载
      health.push({ kind: 'root', index, path: binding.path, enabled: true, status: 'valid' });
      continue;
    }
    rootCanonical.set(binding.path, index);
    bindings.roots.push({ index, path: binding.path, dev: binding.dev, ino: binding.ino });
    health.push({ kind: 'root', index, path: binding.path, enabled: true, status: 'valid' });
  }
  return { ok: true, record: { schemaVersion: 1, revision: request.expectedRevision, config, bindings }, health };
}

// ── owner 健康检查（内存缓存） ─────────────────────────

let lastHealth: { checkedAt: number; entries: SessionContextHealthEntry[] } = { checkedAt: 0, entries: [] };
let recheckInFlight = false;
let lastRecheckAt = 0;
let lastRecheckNote = '';
let resumeNote = '';

/** resumeLive 跳过自动恢复时给 owner 的文字提示 */
export function setResumeNote(note: string): void {
  resumeNote = note;
}

/** 启动时、保存前、新会话准备时的重查入口；owner 显式重查走带限频的 recheck */
export async function refreshHealth(): Promise<SessionContextHealthEntry[]> {
  const current = currentRecord();
  if (!current || current.kind === 'invalid') return [];
  const config = current.record.config;
  const entries: SessionContextHealthEntry[] = [];
  if (config.enabled && config.cwd !== '') {
    const cwdBinding = current.record.bindings.cwd;
    const failure = cwdBinding ? await verifyDirectory(cwdBinding) : 'not_found';
    entries.push({ kind: 'cwd', index: 0, path: config.cwd, enabled: true, status: failure ? 'invalid' : 'valid', ...(failure ? { detail: '工作目录已失效，需修正或清空后再新建会话' } : {}) });
  }
  const skills = await discoverSkillsForHealth(config, 'skill');
  entries.push(...skills);
  const roots = await discoverSkillsForHealth(config, 'root');
  entries.push(...roots);
  lastHealth = { checkedAt: Date.now(), entries };
  return entries;
}

/** 健康重查按条目做轻量存在性检查（不重新解析全文；解析只在保存/创建做） */
async function discoverSkillsForHealth(config: SessionContextConfig, kind: 'skill' | 'root'): Promise<SessionContextHealthEntry[]> {
  const list = kind === 'skill' ? config.skillSources : config.readRoots;
  const entries: SessionContextHealthEntry[] = [];
  for (const [index, entry] of list.entries()) {
    if (!entry.enabled) {
      entries.push({ kind, index, path: entry.path, enabled: false, status: 'disabled' });
      continue;
    }
    if (kind === 'skill') {
      // 文件型来源按普通文件检查（R_OK）；目录来源按可遍历目录检查
      let canonical: string;
      try {
        canonical = realpathSync(entry.path);
      } catch {
        entries.push({ kind, index, path: entry.path, enabled: true, status: 'not_found', detail: '路径已不存在或已移动' });
        continue;
      }
      const stats = lstatSync(canonical, { throwIfNoEntry: false });
      const isFile = !!stats?.isFile();
      const isDir = !!stats?.isDirectory();
      try {
        accessSync(canonical, isFile ? constants.R_OK : constants.R_OK | constants.X_OK);
        entries.push({ kind, index, path: canonical, enabled: true, status: isFile || isDir ? 'valid' : 'invalid' });
      } catch {
        entries.push({ kind, index, path: canonical, enabled: true, status: 'unreadable', detail: '路径不可读' });
      }
      continue;
    }
    const binding = await bindDirectory(entry.path);
    entries.push({
      kind,
      index,
      path: typeof binding === 'string' ? entry.path : binding.path,
      enabled: true,
      status: binding === 'not_found' ? 'not_found' : binding === 'unreadable' ? 'unreadable' : typeof binding === 'string' ? 'invalid' : 'valid',
      ...(binding === 'not_found' ? { detail: '路径已不存在或已移动' } : binding === 'unreadable' ? { detail: '路径不可读' } : {}),
    });
  }
  return entries;
}

/** owner 显式重查：最多每秒一次、单在途；不保存、不创建会话 */
export async function recheckSessionContext(): Promise<{ ok: boolean; note?: string }> {
  if (recheckInFlight) return { ok: false, note: '上一次检查还在进行' };
  const now = Date.now();
  if (now - lastRecheckAt < 1000) return { ok: false, note: '检查太频繁，稍后再试' };
  recheckInFlight = true;
  lastRecheckAt = now;
  try {
    await refreshHealth();
    lastRecheckNote = '';
    return { ok: true };
  } finally {
    recheckInFlight = false;
  }
}

// ── owner 状态视图 ────────────────────────────────────

export function stateView(): SessionContextStateView {
  const notes = [lastRecheckNote, resumeNote].filter(Boolean).join('；');
  const current = currentRecord();
  if (!current) return { saved: null, health: lastHealth, active: activeView(), ...(notes ? { recheck: notes } : {}) };
  if (current.kind === 'invalid') return { saved: null, invalid: current.reason, health: lastHealth, active: activeView(), ...(notes ? { recheck: notes } : {}) };
  return {
    saved: { revision: current.record.revision, config: current.record.config },
    health: lastHealth,
    active: activeView(),
    ...(notes ? { recheck: notes } : {}),
  };
}

/** /onair 对管理会话的绑定核对：ready 绑定 + 平台一致 + native cwd 仍有效；不重新从 settings 生成快照 */
export async function verifyManagedOnair(sessionId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const snapshot = snapshotForSession(sessionId);
  if (!snapshot) return { ok: true };
  if (snapshot.platform !== settings.livePlatform) {
    return { ok: false, error: '直播平台与该会话创建时不一致，请先创建新的直播会话' };
  }
  if (snapshot.effectiveCwd) {
    if (!snapshot.cwdBinding) return { ok: false, error: '会话缺少工作目录绑定，无法开播' };
    const failure = await verifyDirectory(snapshot.cwdBinding);
    if (failure) return { ok: false, error: '会话的工作目录已失效，请修正后创建新的直播会话' };
  }
  return { ok: true };
}

// ── 快照与活动会话（sessionContextSessions 登记） ──────

const activeSessions = new Map<string, { snapshot: SessionContextSnapshot; composition: { ok: true } | { ok: false; reason: string } }>();

export function registerActiveSession(snapshot: SessionContextSnapshot, composition: { ok: true } | { ok: false; reason: string }): void {
  activeSessions.set(snapshot.sessionId, { snapshot, composition });
}

export function snapshotForSession(sessionId: string): SessionContextSnapshot | null {
  return activeSessions.get(sessionId)?.snapshot ?? null;
}

export function compositionForSession(sessionId: string): { ok: true } | { ok: false; reason: string } | null {
  return activeSessions.get(sessionId)?.composition ?? null;
}

export function activeSnapshotSessionId(): string | null {
  for (const sessionId of activeSessions.keys()) return sessionId;
  return null;
}

function activeView() {
  const sessionId = activeSnapshotSessionId();
  if (!sessionId) return null;
  const { snapshot } = activeSessions.get(sessionId)!;
  return snapshotView(snapshot);
}

export function snapshotView(snapshot: SessionContextSnapshot): SessionContextSnapshotView {
  return {
    sessionId: snapshot.sessionId,
    revision: snapshot.revision,
    platform: snapshot.platform,
    presetId: snapshot.presetId,
    effectiveCwd: snapshot.effectiveCwd,
    cwdReady: snapshot.cwdBinding !== null,
    skills: snapshot.skills.map((skill): SessionContextSkillView => {
      const observed = sessionObservation(snapshot.sessionId)?.skills.get(skill.name);
      const loaded = observed?.status === 'loaded';
      return {
        name: skill.name,
        description: skill.description,
        status: 'available' as const,
        loadedAt: loaded ? observed!.loadedAt : null,
        contentHash: loaded ? observed!.hash : null,
      };
    }),
    rootIds: snapshot.rootBindings.map((root) => root.rootId),
    issues: snapshot.issues,
    createdAt: snapshot.createdAt,
  };
}

/** 同步捕获最近成功发布的完整记录（保存/创建的线性化点） */
export function captureSaved(): SessionContextRecord | null {
  const current = currentRecord();
  return current && current.kind === 'saved' ? current.record : null;
}

/** 公共输出脱敏用的 owner 原始输入路径（canonical + 输入别名） */
export function configuredRawPaths(): string[] {
  const current = currentRecord();
  if (!current || current.kind === 'invalid') return [];
  const config = current.record.config;
  return [config.cwd, ...config.skillSources.map((entry) => entry.path), ...config.readRoots.map((entry) => entry.path)].filter(Boolean);
}

function toSnapshotSkill(skill: DiscoveredSkill): SessionSnapshotSkill {
  return {
    name: skill.name,
    description: skill.description,
    modelInvocable: skill.modelInvocable,
    userInvocable: skill.userInvocable,
    sourcePath: skill.sourcePath,
    sourceHash: skill.sourceHash,
    contentHash: skill.contentHash,
    body: skill.body,
  };
}

// ── 快照准备（创建会话） ──────────────────────────────

export type PrepareOutcome =
  | { ok: true; snapshot: SessionContextSnapshot }
  | { ok: false; status: number; error: string };

export async function prepareSnapshot(record: SessionContextRecord, sessionId: string, platform: string, presetId: string): Promise<PrepareOutcome> {
  const config = record.config;
  const issues: string[] = [];
  let cwdBinding: DirectoryBinding | null = null;
  let effectiveCwd = '';
  if (config.enabled && config.cwd !== '') {
    if (!record.bindings.cwd) return { ok: false, status: 409, error: '保存记录缺少工作目录绑定' };
    const failure = await verifyDirectory(record.bindings.cwd);
    if (failure) return { ok: false, status: 409, error: '工作目录已失效，请修正或清空后再新建会话' };
    cwdBinding = record.bindings.cwd;
    effectiveCwd = record.bindings.cwd.path;
  }
  const rootBindings: SessionContextSnapshot['rootBindings'] = [];
  if (config.enabled) {
    for (const [slot, binding] of record.bindings.roots.entries()) {
      const entry = config.readRoots[binding.index];
      if (!entry || !entry.enabled) continue;
      const canonical: DirectoryBinding = { path: binding.path, dev: binding.dev, ino: binding.ino };
      const failure = await verifyDirectory(canonical);
      if (failure) {
        issues.push(`资料根 ${entry.path} 已失效`);
        continue;
      }
      rootBindings.push({ rootId: `root-${slot + 1}`, binding: canonical });
    }
  }
  let skills: SessionSnapshotSkill[] = [];
  if (config.enabled && config.skillSources.some((entry) => entry.enabled)) {
    // 创建时缺失/不可读来源按降级处理（标记问题、可用条目仍组成会话）；冲突与预算超限仍拒绝
    const discovered = await discoverSkills(config, { allowMissing: true });
    if (!discovered.ok) return { ok: false, status: 409, error: `Skill 来源在创建时失效：${discovered.detail}` };
    for (const binding of record.bindings.skills) {
      const entry = config.skillSources[binding.index];
      if (!entry || !entry.enabled) continue;
      // 创建时逐条重查保存的目录身份，不接受被替换成 symlink 或不同 inode 的根
      const canonical: DirectoryBinding = { path: binding.path, dev: binding.dev, ino: binding.ino };
      if (binding.ino > 0 && await verifyDirectory(canonical)) {
        issues.push(`Skill 来源 ${entry.path} 已失效`);
        continue;
      }
      const prefix = binding.path.endsWith('/') ? binding.path : `${binding.path}/`;
      const matched = discovered.skills.filter((item) =>
        (item.sourcePath === binding.file || item.sourcePath.startsWith(prefix)) && !skills.some((existing) => existing.name === item.name));
      if (binding.file) {
        const exact = discovered.skills.find((item) => item.sourcePath === binding.file);
        if (!exact) {
          issues.push(`Skill 来源 ${entry.path} 未发现可用声明`);
          continue;
        }
        if (!skills.some((existing) => existing.name === exact.name)) skills.push(toSnapshotSkill(exact));
        continue;
      }
      if (!matched.length) {
        issues.push(`Skill 来源 ${entry.path} 未发现可用声明`);
        continue;
      }
      for (const skill of matched) skills.push(toSnapshotSkill(skill));
    }
  }
  const snapshot: SessionContextSnapshot = {
    schemaVersion: 1,
    sessionId,
    revision: record.revision,
    platform,
    presetId,
    effectiveCwd,
    cwdBinding,
    rootBindings,
    skills,
    issues,
    createdAt: Date.now(),
  };
  const persisted = JSON.stringify(snapshot);
  if (Buffer.byteLength(persisted, 'utf8') > SNAPSHOT_LIMITS.maxFileBytes) return { ok: false, status: 409, error: '会话快照超出大小预算' };
  return { ok: true, snapshot };
}

// ── 快照持久化 ────────────────────────────────────────

function snapshotDir(): string {
  return join(dataDirOverride ?? dataDir, 'session-context');
}

let dataDirOverride: string | null = null;

/** 测试隔离用：重定向快照目录（生产代码不得调用） */
export function setSnapshotDataDir(dir: string | null): void {
  dataDirOverride = dir;
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function assertSessionFileName(sessionId: string): string {
  if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error('快照文件名不是宿主生成的会话标识');
  return join(snapshotDir(), `${sessionId}.json`);
}

export function writeSnapshot(snapshot: SessionContextSnapshot): { ok: true } | { ok: false; error: string } {
  const dir = snapshotDir();
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // 目录符号链接保护：已存在但不是目录时拒绝
    const existing = statSync(dir, { throwIfNoEntry: false });
    if (!existing || existing.isSymbolicLink() || !existing.isDirectory()) return { ok: false, error: '快照目录不可用' };
    const names = readdirSync(dir).filter((name) => name.endsWith('.json'));
    if (!names.some((name) => name === `${snapshot.sessionId}.json`) && names.length >= SNAPSHOT_LIMITS.maxFiles) {
      return { ok: false, error: `快照数量已达上限（${SNAPSHOT_LIMITS.maxFiles}），请让 owner 处理旧记录` };
    }
    let total = 0;
    for (const name of names) total += statSync(join(dir, name), { throwIfNoEntry: false })?.size ?? 0;
    const serialized = JSON.stringify(snapshot);
    if (total + Buffer.byteLength(serialized) > SNAPSHOT_LIMITS.maxTotalBytes) {
      return { ok: false, error: '快照目录容量已满，请让 owner 处理旧记录' };
    }
    const target = assertSessionFileName(snapshot.sessionId);
    const temporary = join(dir, `.${snapshot.sessionId}.${Date.now().toString(36)}.tmp`);
    writeFileSync(temporary, serialized, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, target);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

export function removeSnapshotFile(sessionId: string): void {
  try {
    rmSync(assertSessionFileName(sessionId), { force: true });
  } catch {
    // 快照清理失败不阻塞主流程；owner 状态如实反映即可
  }
}

export type ReadSnapshotOutcome =
  | { ok: true; snapshot: SessionContextSnapshot }
  | { ok: false; code: 'missing' | 'invalid' | 'oversize'; error: string };

export function readSnapshot(sessionId: string): ReadSnapshotOutcome {
  if (!SESSION_ID_PATTERN.test(sessionId)) return { ok: false, code: 'invalid', error: '会话标识无效' };
  const file = assertSessionFileName(sessionId);
  let raw: Buffer;
  try {
    const stats = statSync(file, { throwIfNoEntry: false });
    if (!stats || stats.isSymbolicLink() || !stats.isFile()) return { ok: false, code: 'missing', error: '快照不存在' };
    if (stats.size > SNAPSHOT_LIMITS.maxFileBytes) return { ok: false, code: 'oversize', error: '快照超出大小预算' };
    raw = readFileSync(file);
  } catch {
    return { ok: false, code: 'missing', error: '快照不存在' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return { ok: false, code: 'invalid', error: '快照不是有效 JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, code: 'invalid', error: '快照格式无效' };
  const snapshot = parsed as Record<string, unknown>;
  if (snapshot.schemaVersion !== 1) return { ok: false, code: 'invalid', error: '快照版本无效' };
  if (snapshot.sessionId !== sessionId) return { ok: false, code: 'invalid', error: '快照归属会话不一致' };
  return { ok: true, snapshot: parsed as unknown as SessionContextSnapshot };
}

// ── 每 turn 预算与运行时观测 ──────────────────────────

interface SessionObservation {
  turn: number;
  skills: Map<string, { status: SessionContextStatus; loadedAt: number | null; hash: string | null }>;
  skillCalls: number;
  skillBodyBytes: number;
  readAttempts: number;
  readBufferBytes: number;
  readOutputBytes: number;
  inflight: boolean;
}

const observations = new Map<string, SessionObservation>();

function observationFor(sessionId: string): SessionObservation {
  let existing = observations.get(sessionId);
  if (!existing) {
    existing = { turn: 0, skills: new Map(), skillCalls: 0, skillBodyBytes: 0, readAttempts: 0, readBufferBytes: 0, readOutputBytes: 0, inflight: false };
    observations.set(sessionId, existing);
  }
  return existing;
}

/** agent pre-step 在每个真实 turn 开始时调用：预算按 turn 重置 */
export function noteSessionTurn(sessionId: string, turn: number): void {
  const existing = observations.get(sessionId);
  if (!existing) return;
  if (existing.turn !== turn) {
    existing.turn = turn;
    existing.skillCalls = 0;
    existing.skillBodyBytes = 0;
    existing.readAttempts = 0;
    existing.readBufferBytes = 0;
    existing.readOutputBytes = 0;
  }
}

function sessionObservation(sessionId: string): SessionObservation | undefined {
  return observations.get(sessionId);
}

export function disposeSessionObservation(sessionId: string): void {
  observations.delete(sessionId);
}

export function registerObservationSession(sessionId: string): void {
  observationFor(sessionId);
}

// ── 模型工具：Skill 加载 ──────────────────────────────

export type SkillLoadResult =
  | { status: 'loaded'; name: string; body: string; contentHash: string }
  | { status: 'limit_exceeded'; detail: string }
  | { status: 'unavailable'; detail: string }
  | { status: 'denied'; detail: string };

export function loadSkill(sessionId: string, name: unknown): SkillLoadResult {
  const snapshot = snapshotForSession(sessionId);
  if (!snapshot) return { status: 'unavailable', detail: '这个会话没有启用的直播会话设置。' };
  const observed = observationFor(sessionId);
  if (typeof name !== 'string' || !name) return { status: 'denied', detail: '缺少 Skill 名称。' };
  const skill = snapshot.skills.find((item) => item.name === name);
  if (!skill) return { status: 'unavailable', detail: `没有名为 ${name.slice(0, 64)} 的可加载 Skill。` };
  if (!skill.modelInvocable) return { status: 'denied', detail: `Skill ${skill.name} 已被 owner 设置为不可由模型加载。` };
  if (observed.skillCalls >= SKILL_TURN_LIMITS.callsPerTurn) {
    return { status: 'limit_exceeded', detail: `本轮 Skill 加载次数已达上限（${SKILL_TURN_LIMITS.callsPerTurn}）。` };
  }
  // 相同 name 在一 turn 重复不重复注入，但仍返回同一份冻结正文；无磁盘重读
  const alreadyLoaded = observed.skills.get(name)?.status === 'loaded';
  const bodyBytes = Buffer.byteLength(skill.body, 'utf8');
  if (!alreadyLoaded && observed.skillBodyBytes + bodyBytes > SKILL_TURN_LIMITS.turnBodyBytes) {
    return { status: 'limit_exceeded', detail: `本轮 Skill 正文字节预算（${SKILL_TURN_LIMITS.turnBodyBytes}）不足。` };
  }
  observed.skillCalls += 1;
  if (!alreadyLoaded) observed.skillBodyBytes += bodyBytes;
  observed.skills.set(name, { status: 'loaded', loadedAt: Date.now(), hash: skill.contentHash });
  return { status: 'loaded', name: skill.name, body: skill.body, contentHash: skill.contentHash };
}

// ── 模型工具：资料读取 ────────────────────────────────

export type MaterialReadResult =
  | {
    status: 'available';
    rootId: string;
    relativePath: string;
    startLine: number;
    endLine: number;
    totalLines: number | null;
    content: string;
    sha256: string;
    bytes: number;
  }
  | { status: 'empty'; rootId: string; relativePath: string }
  | { status: 'unavailable'; detail: string }
  | { status: 'denied'; detail: string }
  | { status: 'unsupported'; detail: string }
  | { status: 'busy'; detail: string }
  | { status: 'timeout'; detail: string }
  | { status: 'cancelled'; detail: string }
  | { status: 'limit_exceeded'; detail: string };

export interface MaterialReadInput {
  rootId: unknown;
  path: unknown;
  startLine?: unknown;
  maxLines?: unknown;
  signal?: AbortSignal;
}

function lineCount(text: string): number {
  if (!text) return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

export async function readMaterial(sessionId: string, input: MaterialReadInput): Promise<MaterialReadResult> {
  const snapshot = snapshotForSession(sessionId);
  if (!snapshot) return { status: 'unavailable', detail: '这个会话没有启用的直播会话设置。' };
  if (typeof input.rootId !== 'string' || !/^root-\d+$/.test(input.rootId)) return { status: 'denied', detail: '资料根标识无效。' };
  if (typeof input.path !== 'string' || !input.path) return { status: 'denied', detail: '缺少资料相对路径。' };
  const root = snapshot.rootBindings.find((item) => item.rootId === input.rootId);
  if (!root) return { status: 'denied', detail: '没有这个资料根。' };
  const observed = observationFor(sessionId);
  if (observed.inflight) return { status: 'busy', detail: '已有一次资料读取在进行。' };
  if (observed.readAttempts >= MATERIAL_LIMITS.attemptsPerTurn) {
    return { status: 'limit_exceeded', detail: `本轮资料读取次数已达上限（${MATERIAL_LIMITS.attemptsPerTurn}）。` };
  }
  const startLine = input.startLine === undefined ? MATERIAL_LIMITS.defaultStartLine : Number(input.startLine);
  const maxLines = input.maxLines === undefined ? MATERIAL_LIMITS.defaultMaxLines : Number(input.maxLines);
  if (!Number.isSafeInteger(startLine) || startLine < 1 || !Number.isSafeInteger(maxLines) || maxLines < 1 || maxLines > MATERIAL_LIMITS.maxLines) {
    return { status: 'denied', detail: `行段无效：startLine 从 1 开始，maxLines 1～${MATERIAL_LIMITS.maxLines}。` };
  }
  observed.readAttempts += 1;
  observed.inflight = true;
  const startedAt = Date.now();
  const timeout = AbortSignal.any([AbortSignal.timeout(MATERIAL_LIMITS.readTimeoutMs), ...(input.signal ? [input.signal] : [])]);
  try {
    const result = await readBoundedFile({
      root: root.binding,
      relativePath: input.path,
      maxBytes: MATERIAL_LIMITS.maxFileBytes,
      signal: timeout,
    });
    if (!result.ok) {
      if (timeout.aborted) return { status: timeout.reason === 'TimeoutError' ? 'timeout' : 'cancelled', detail: '' };
      if (result.failure === 'escape') return { status: 'denied', detail: '路径超出授权范围。' };
      if (result.failure === 'symlink') return { status: 'denied', detail: '路径包含符号链接，已拒绝。' };
      if (result.failure === 'not_found') return { status: 'unavailable', detail: '资料文件不存在。' };
      if (result.failure === 'unreadable') return { status: 'unavailable', detail: '资料文件不可读。' };
      if (result.failure === 'invalid_path') return { status: 'denied', detail: '路径无效。' };
      if (result.failure === 'unsupported_file') return { status: 'unsupported', detail: '只支持普通文本文件。' };
      if (result.failure === 'limit_exceeded') return { status: 'limit_exceeded', detail: `文件超过 ${MATERIAL_LIMITS.maxFileBytes} 字节预算。` };
      return { status: 'unavailable', detail: '资料读取失败。' };
    }
    const bytes = result.bytes;
    observed.readBufferBytes += bytes.byteLength;
    if (observed.readBufferBytes > MATERIAL_LIMITS.turnBufferBytes) {
      return { status: 'limit_exceeded', detail: `本轮读取缓冲预算（${MATERIAL_LIMITS.turnBufferBytes} 字节）不足。` };
    }
    // 只接受 UTF-8 文本；二进制/NUL 拒绝
    if (bytes.includes(0)) return { status: 'unsupported', detail: '资料文件包含二进制内容。' };
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return { status: 'unsupported', detail: '资料文件不是 UTF-8 文本。' };
    }
    const total = lineCount(text);
    if (startLine > total) return { status: 'empty', rootId: root.rootId, relativePath: input.path };
    // 结尾换行不产生空行段；切片按真实行计算
    const allLines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
    const lines = allLines.slice(startLine - 1, startLine - 1 + maxLines);
    let content = lines.join('\n');
    const encoded = new TextEncoder().encode(content);
    if (encoded.byteLength > MATERIAL_LIMITS.maxOutputBytes) {
      // 请求行段超过输出上限则拒绝并提示缩小行段，不默默截断
      return { status: 'limit_exceeded', detail: `请求行段的输出超过 ${MATERIAL_LIMITS.maxOutputBytes} 字节，请缩小行段。` };
    }
    if (observed.readOutputBytes + encoded.byteLength > MATERIAL_LIMITS.turnOutputBytes) {
      return { status: 'limit_exceeded', detail: `本轮返回正文预算（${MATERIAL_LIMITS.turnOutputBytes} 字节）不足。` };
    }
    observed.readOutputBytes += encoded.byteLength;
    void startedAt;
    return {
      status: 'available',
      rootId: root.rootId,
      relativePath: input.path,
      startLine,
      endLine: startLine - 1 + lines.length,
      totalLines: total,
      content,
      sha256: result.sha256,
      bytes: bytes.byteLength,
    };
  } finally {
    observed.inflight = false;
  }
}

// ── 宿主组合检查 ──────────────────────────────────────

const UNSUPPORTED_GLOBAL_PATTERN = /@deepseek-ai\/dsh-(tool-skill|skill-filesystem|skill|agent-instructions|tool-fs)$/;

/** 有效全局 entry 检查：native tool-skill、默认扫描 filesystem 或 agent-instructions 启用/加载中即不支持 */
export function checkHostComposition(loader: unknown): { ok: true } | { ok: false; reason: string } {
  if (!loader || typeof (loader as { entries?: unknown }).entries !== 'function') {
    return { ok: false, reason: '宿主缺少可检查的插件装载器' };
  }
  for (const entry of (loader as { entries(): Iterable<{ options?: { name?: unknown }; disabled?: boolean; fiber?: unknown }> }).entries()) {
    const name = entry?.options?.name;
    if (typeof name !== 'string' || !UNSUPPORTED_GLOBAL_PATTERN.test(name)) continue;
    if (entry.disabled === true) continue;
    // 未挂 fiber 或 fiber 未激活都视为“无法确认隔离”
    const fiber = entry.fiber as { isActive?: boolean } | undefined;
    if (!fiber || fiber.isActive !== true) return { ok: false, reason: `全局组件仍在加载：${name}` };
    return { ok: false, reason: `全局组件处于启用状态：${name}` };
  }
  return { ok: true };
}

// ── 汇总导出 ──────────────────────────────────────────

export { STATUS_TEXT, SESSION_CONTEXT_LIMITS };
export type { SessionContextStatus };
