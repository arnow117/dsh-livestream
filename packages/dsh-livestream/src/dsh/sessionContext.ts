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
import { accessSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, basename, join } from 'node:path';
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
import { bindDirectory, readBoundedFile, readDiscoveredSkill, verifyDirectory, type DirectoryBinding, type DiscoveryReadHooks, type PathFailure } from './sessionContextPaths';
import { parseSkillMarkdown, SKILL_LIMITS } from './sessionContextSkills';
import { dataDir, hooks, settings, show } from './runtime';

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
async function discoverSource(entry: SessionContextEntry, canonicalRoot: string, index: number, discovered: DiscoveredSkill[], seenPaths: Set<string>, hooks: DiscoveryReadHooks): Promise<DiscoveryFailure> {
  let stats;
  try {
    stats = lstatSync(canonicalRoot);
  } catch {
    return { ok: false, code: 'not_found', field: `config.skillSources[${index}].path`, detail: '来源不存在' };
  }
  if (stats.isSymbolicLink()) return { ok: false, code: 'invalid', field: `config.skillSources[${index}].path`, detail: '来源是指向外部的符号链接' };
  // 读取防护的可信锚：发现时的来源根身份（目录来源=容器本身；单文件来源=其父目录）
  const anchorIsDirectory = !stats.isFile();
  const anchorPath = anchorIsDirectory ? canonicalRoot : dirname(canonicalRoot);
  let anchorStats;
  try {
    anchorStats = lstatSync(anchorPath);
  } catch {
    return { ok: false, code: 'not_found', field: `config.skillSources[${index}].path`, detail: '来源不存在' };
  }
  if (anchorStats.isSymbolicLink() || !anchorStats.isDirectory()) {
    return { ok: false, code: 'invalid', field: `config.skillSources[${index}].path`, detail: '来源锚点不是目录' };
  }
  const rootIdentity = { dev: anchorStats.dev, ino: anchorStats.ino };
  let candidates: Array<{ file: string; relative: string }>;
  if (stats.isFile()) {
    if (!canonicalRoot.endsWith('.md')) return { ok: false, code: 'invalid', field: `config.skillSources[${index}].path`, detail: '文件来源必须是 .md' };
    candidates = [{ file: canonicalRoot, relative: canonicalRoot.slice(anchorPath.length + 1) }];
  } else {
    const ownSkillFile = join(canonicalRoot, 'SKILL.md');
    const ownSkillStats = lstatSync(ownSkillFile, { throwIfNoEntry: false });
    if (ownSkillStats) {
      // 遇到直接 SKILL.md 就作为单 Skill 目录，不再扩展其兄弟文件；
      // 与直接 .md 分支同一硬规则：symlink/非普通文件不跟随，整体拒绝来源，不读取目标内容
      if (ownSkillStats.isSymbolicLink()) return { ok: false, code: 'invalid', field: `config.skillSources[${index}].path`, detail: 'SKILL.md 是符号链接，已拒绝该来源' };
      if (!ownSkillStats.isFile()) return { ok: false, code: 'invalid', field: `config.skillSources[${index}].path`, detail: 'SKILL.md 不是普通文件，已拒绝该来源' };
      candidates = [{ file: ownSkillFile, relative: 'SKILL.md' }];
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
        if (child.isFile()) candidates.push({ file, relative: name });
      }
      for (const name of names) {
        const dir = join(canonicalRoot, name);
        const child = lstatSync(dir, { throwIfNoEntry: false });
        if (!child || child.isSymbolicLink() || !child.isDirectory()) continue;
        const skillFile = join(dir, 'SKILL.md');
        const skillStats = lstatSync(skillFile, { throwIfNoEntry: false });
        if (!skillStats) continue;
        if (skillStats.isSymbolicLink()) return { ok: false, code: 'invalid', field: `config.skillSources[${index}].path`, detail: `候选 SKILL.md ${name}/SKILL.md 是符号链接，已拒绝该来源` };
        if (skillStats.isFile()) candidates.push({ file: skillFile, relative: `${name}/SKILL.md` });
      }
      // 正式评审 R8：启用的容器必须实际发现有效声明——空容器/仅 references/scripts/缺 SKILL.md 不是成功的空 Skill
      if (candidates.length === 0) {
        return { ok: false, code: 'not_found', field: `config.skillSources[${index}].path`, detail: '来源未发现任何 Skill 声明（空容器或子目录缺少 SKILL.md）' };
      }
    }
  }
  for (const candidate of candidates) {
    if (discovered.length >= SKILL_LIMITS.maxSkills) {
      return { ok: false, code: 'limit_exceeded', field: 'config.skillSources', detail: `唯一 Skill 超过 ${SKILL_LIMITS.maxSkills} 份` };
    }
    if (seenPaths.has(candidate.file)) continue;
    // 读取防护（评审 HIGH + 二轮中间目录替换）：末端 O_NOFOLLOW 不保护中间路径段——
    // 以发现时的来源根为锚逐段核对根/各目录段/末端文件身份；「发现到读取」之间目录被换成
    // symlink 或根被整体替换一律拒绝来源，源外正文绝不进入快照
    const secure = await readDiscoveredSkill(anchorPath, rootIdentity, candidate.relative, SKILL_LIMITS.maxFileBytes, hooks);
    let bytes: Uint8Array;
    if (!secure.ok) {
      if (secure.failure === 'symlink') {
        return { ok: false, code: 'invalid', field: `config.skillSources[${index}].path`, detail: '候选在发现后被替换为符号链接（含中间目录），已拒绝该来源' };
      }
      if (secure.failure === 'identity_mismatch') {
        return { ok: false, code: 'invalid', field: `config.skillSources[${index}].path`, detail: '候选在发现后被替换（根或路径身份不符），已拒绝该来源' };
      }
      if (secure.failure === 'limit_exceeded') {
        return { ok: false, code: 'limit_exceeded', field: `config.skillSources[${index}].path`, detail: `Skill 文件超过 ${SKILL_LIMITS.maxFileBytes} 字节` };
      }
      if (secure.failure === 'not_found') {
        return { ok: false, code: 'not_found', field: `config.skillSources[${index}].path`, detail: 'Skill 文件不可读' };
      }
      return { ok: false, code: 'unreadable', field: `config.skillSources[${index}].path`, detail: 'Skill 文件不可读' };
    }
    bytes = secure.bytes;
    const parsed = parseSkillMarkdown(bytes);
    if (!parsed.ok) {
      return { ok: false, code: 'invalid', field: `config.skillSources[${index}].path`, detail: `Skill 声明无效（${parsed.failure}）` };
    }
    if (discovered.some((existing) => existing.name === parsed.skill.name)) {
      return { ok: false, code: 'conflict', field: `config.skillSources[${index}].path`, detail: `不同来源的 Skill 同名：${parsed.skill.name}` };
    }
    seenPaths.add(candidate.file);
    discovered.push({
      name: parsed.skill.name,
      description: parsed.skill.description,
      modelInvocable: parsed.skill.modelInvocable,
      userInvocable: parsed.skill.userInvocable,
      sourcePath: candidate.file,
      raw: bytes,
      body: parsed.skill.body,
      sourceHash: sha256(bytes),
      contentHash: sha256(new TextEncoder().encode(parsed.skill.body)),
    });
  }
  return { ok: true, skills: discovered };
}

/** 保存/创建共用的发现入口：预算、去重、同名冲突都在这里收口。allowMissing 供创建时降级（缺失条目跳过并标记问题）；
 * hooks 供测试在「发现到读取」之间注入受控替换（生产代码不传） */
export async function discoverSkills(config: SessionContextConfig, options: { allowMissing?: boolean; hooks?: DiscoveryReadHooks } = {}): Promise<DiscoveryFailure> {
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
    const result = await discoverSource(entry, canonical, index, discovered, seenPaths, options.hooks ?? {});
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

export type BindingsDiscoveryOutcome =
  | { ok: true; skills: DiscoveredSkill[]; issues: string[] }
  | { ok: false; code: 'limit_exceeded' | 'conflict'; field: string; detail: string };

/**
 * 创建时的 Skill 发现（正式评审 R3）：只消费保存记录里的 canonical 文件/目录与对象身份，
 * 原始别名不参与解析（owner 回显/脱敏用）。每个绑定先核对身份（目录 realpath/dev/ino；
 * 文件经共享的整链身份读取），身份不符或缺失按降级记入 issues（可用条目仍组成会话）；
 * 同名冲突与字节/时间预算超限整体拒绝。发现深度与去重规则与保存时完全一致。
 */
async function discoverSkillsFromBindings(record: SessionContextRecord): Promise<BindingsDiscoveryOutcome> {
  const discovered: DiscoveredSkill[] = [];
  const issues: string[] = [];
  const seenNames = new Set<string>();
  const seenPaths = new Set<string>();
  let totalBytes = 0;
  const deadline = Date.now() + SKILL_LIMITS.scanBudgetMs;
  for (const binding of record.bindings.skills) {
    if (Date.now() > deadline) return { ok: false, code: 'limit_exceeded', field: 'config.skillSources', detail: '发现整体超时' };
    const entry = record.config.skillSources[binding.index];
    if (!entry || !entry.enabled) continue;
    if (discovered.length >= SKILL_LIMITS.maxSkills) {
      return { ok: false, code: 'limit_exceeded', field: 'config.skillSources', detail: `唯一 Skill 超过 ${SKILL_LIMITS.maxSkills} 份` };
    }
    if (binding.file) {
      // 文件型来源：canonical 文件必须仍在身份核对过的父目录内；经共享读取原语取正文
      const parentIdentity = { path: binding.path, dev: binding.dev, ino: binding.ino };
      const parentFailure = await verifyDirectory(parentIdentity);
      if (parentFailure) {
        issues.push(`Skill 来源 ${entry.path} 已失效`);
        continue;
      }
      const relative = binding.file.startsWith(`${binding.path}/`) ? binding.file.slice(binding.path.length + 1) : basename(binding.file);
      const read = await readDiscoveredSkill(binding.path, { dev: binding.dev, ino: binding.ino }, relative, SKILL_LIMITS.maxFileBytes);
      if (!read.ok) {
        issues.push(`Skill 来源 ${entry.path} 已失效（${read.failure === 'symlink' ? '路径包含符号链接' : read.failure === 'not_found' ? '声明不存在' : '不可读'}）`);
        continue;
      }
      const parsed = parseSkillMarkdown(read.bytes);
      if (!parsed.ok) {
        issues.push(`Skill 来源 ${entry.path} 的声明已失效（${parsed.failure}）`);
        continue;
      }
      if (seenNames.has(parsed.skill.name)) continue;
      seenNames.add(parsed.skill.name);
      seenPaths.add(binding.file);
      discovered.push({
        name: parsed.skill.name,
        description: parsed.skill.description,
        modelInvocable: parsed.skill.modelInvocable,
        userInvocable: parsed.skill.userInvocable,
        sourcePath: binding.file,
        raw: read.bytes,
        body: parsed.skill.body,
        sourceHash: sha256(read.bytes),
        contentHash: sha256(new TextEncoder().encode(parsed.skill.body)),
      });
      totalBytes += read.bytes.byteLength;
      if (totalBytes > SKILL_LIMITS.maxTotalBytes) {
        return { ok: false, code: 'limit_exceeded', field: 'config.skillSources', detail: `Skill 原始字节合计超过 ${SKILL_LIMITS.maxTotalBytes}` };
      }
      continue;
    }
    // 目录型来源：身份核对后按与保存时相同的容器规则发现（深度/去重/预算一致）
    const canonical = { path: binding.path, dev: binding.dev, ino: binding.ino };
    const identityFailure = await verifyDirectory(canonical);
    if (identityFailure) {
      issues.push(`Skill 来源 ${entry.path} 已失效`);
      continue;
    }
    const before = discovered.length;
    const result = await discoverSource(entry, binding.path, binding.index, discovered, seenPaths, {});
    if (!result.ok) {
      if (result.code === 'conflict' || result.code === 'limit_exceeded') {
        return { ok: false, code: result.code, field: result.field, detail: result.detail };
      }
      // 其余（缺失/不可读/身份变化等）按降级记入问题，可用条目仍组成会话
      issues.push(`Skill 来源 ${entry.path} 已失效（${result.detail}）`);
      continue;
    }
    for (const skill of discovered.slice(before)) {
      if (seenNames.has(skill.name)) continue;
      seenNames.add(skill.name);
      totalBytes += skill.raw.byteLength;
    }
    if (totalBytes > SKILL_LIMITS.maxTotalBytes) {
      return { ok: false, code: 'limit_exceeded', field: 'config.skillSources', detail: `Skill 原始字节合计超过 ${SKILL_LIMITS.maxTotalBytes}` };
    }
  }
  return { ok: true, skills: discovered, issues };
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
    // 授权范围下限：文件系统根目录与插件数据目录（settings.json 所在目录）不作为资料根，请改用具体资料目录
    if (binding.path === '/' || binding.path === pluginDataDir()) {
      return { ok: false, status: 400, error: `资料根不能是文件系统根目录或插件数据目录：${entry.path}`, issue: { code: 'invalid', field: `config.readRoots[${index}].path` } };
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

let cachedPluginDataDir: string | null = null;

/** 插件数据目录的 canonical 路径（settings.json 所在目录）：资料根的授权范围下限用它判定 */
function pluginDataDir(): string {
  if (cachedPluginDataDir) return cachedPluginDataDir;
  let canonical = dataDir;
  try {
    canonical = realpathSync(dataDir);
  } catch {
    // 目录可能尚未创建：退回未解析路径，保存时的 bindDirectory 仍会给出可修正错误
  }
  cachedPluginDataDir = canonical;
  return canonical;
}

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
    const resolved = typeof binding === 'string' ? null : binding;
    // 等于用户主目录的资料根保存成功，但健康检查给出可修正警告（范围过大）
    const homeWarning = resolved && resolved.path === homedir() ? { detail: '资料根是整个用户主目录：建议改为具体资料目录，避免扩大只读范围' } : {};
    entries.push({
      kind,
      index,
      path: resolved ? resolved.path : entry.path,
      enabled: true,
      status: binding === 'not_found' ? 'not_found' : binding === 'unreadable' ? 'unreadable' : resolved ? 'valid' : 'invalid',
      ...(binding === 'not_found' ? { detail: '路径已不存在或已移动' } : binding === 'unreadable' ? { detail: '路径不可读' } : homeWarning),
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

/**
 * /onair 对管理会话的核对：只核对、绝不补绑或恢复成 ready。
 * - 真实 ENOENT（磁盘无快照）：legacy 未管理会话，原有路径放行；
 * - 磁盘有快照但本进程未恢复（恢复没跑过/恢复首装失败回滚）：409 可修正提示，不在此恢复；
 * - 快照存在但损坏/被替换：409；
 * - 已恢复但绑定非 ready（刷新失败锁定等，binding 由宿主经运行时回调核对传入）：409；
 * - ready 会话继续核对平台与 cwd。goLive 由路由在 ok 之后才可能触达。
 */
export async function verifyManagedOnair(sessionId: string, binding?: { bound: boolean; note?: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  const snapshot = snapshotForSession(sessionId);
  if (!snapshot) {
    const disk = readSnapshot(sessionId);
    if (!disk.ok && disk.code === 'missing') return { ok: true }; // 未注册且真实无快照：原有非管理路径不变
    if (!disk.ok) return { ok: false, error: `该会话有直播会话快照但已损坏，无法恢复受限能力（${disk.error}）；请创建新的直播会话` };
    return { ok: false, error: '该会话有直播会话快照但尚未恢复受限绑定；请重新打开该会话完成恢复，或创建新的直播会话' };
  }
  if (binding && !binding.bound) {
    return { ok: false, error: `该管理会话的受限绑定未就绪（${binding.note ?? '限制名单未安装'}）；本场不能开播，请重新创建会话` };
  }
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

/**
 * owner 的「活动会话」按实际开播状态 + 当前直播会话 id 选择（正式评审 R7）：
 * 未开播或当前直播会话没有管理快照时显示无活动；仅创建/恢复/准备其他快照不改变它。
 * 按会话 id 的绑定存储继续保留（恢复/核对用），不以登记顺序代替当前直播。
 */
function activeView() {
  if (!show.isOnAir) return null;
  const current = show.currentSession;
  if (!current) return null;
  const entry = activeSessions.get(current);
  if (!entry) return null;
  return snapshotView(entry.snapshot);
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
    // 正式评审 R3：创建只消费保存的 canonical 文件/目录与对象身份；原始 alias 仅供 owner 回显/脱敏，
    // 不在创建时重新解析（alias 改指更深目录/根外不能改变保存时确定的来源集合）
    const discovered = await discoverSkillsFromBindings(record);
    if (!discovered.ok) return { ok: false, status: 409, error: `Skill 来源在创建时失效：${discovered.detail}` };
    skills = discovered.skills.map(toSnapshotSkill);
    issues.push(...discovered.issues);
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
    // 目录符号链接保护：已存在但不是目录（或本身是符号链接）时拒绝；lstat 不跟随
    const existing = lstatSync(dir, { throwIfNoEntry: false });
    if (!existing || existing.isSymbolicLink() || !existing.isDirectory()) return { ok: false, error: '快照目录不可用' };
    const names = readdirSync(dir).filter((name) => name.endsWith('.json'));
    if (!names.some((name) => name === `${snapshot.sessionId}.json`) && names.length >= SNAPSHOT_LIMITS.maxFiles) {
      return { ok: false, error: `快照数量已达上限（${SNAPSHOT_LIMITS.maxFiles}），请让 owner 处理旧记录` };
    }
    let total = 0;
    for (const name of names) total += lstatSync(join(dir, name), { throwIfNoEntry: false })?.size ?? 0;
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
  let observedFile = false;
  try {
    const directory = lstatSync(snapshotDir(), { throwIfNoEntry: false });
    if (!directory) return { ok: false, code: 'missing', error: '快照不存在' };
    if (directory.isSymbolicLink() || !directory.isDirectory()) {
      return { ok: false, code: 'invalid', error: '快照目录无效' };
    }
    const stats = lstatSync(file, { throwIfNoEntry: false });
    if (!stats) return { ok: false, code: 'missing', error: '快照不存在' };
    observedFile = true;
    if (stats.isSymbolicLink() || !stats.isFile()) return { ok: false, code: 'invalid', error: '快照不是普通文件' };
    if (stats.size > SNAPSHOT_LIMITS.maxFileBytes) return { ok: false, code: 'oversize', error: '快照超出大小预算' };
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.dev !== stats.dev || opened.ino !== stats.ino) {
        return { ok: false, code: 'invalid', error: '快照文件已改变' };
      }
      if (opened.size > SNAPSHOT_LIMITS.maxFileBytes) return { ok: false, code: 'oversize', error: '快照超出大小预算' };
      raw = readFileSync(fd);
      if (raw.byteLength > SNAPSHOT_LIMITS.maxFileBytes) return { ok: false, code: 'oversize', error: '快照超出大小预算' };
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    // 只有明确不存在才走未管理会话；访问失败或检查与打开之间的替换均拒绝恢复。
    if (!observedFile && (error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, code: 'missing', error: '快照不存在' };
    return { ok: false, code: 'invalid', error: '无法安全读取快照' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return { ok: false, code: 'invalid', error: '快照不是有效 JSON' };
  }
  const checked = validateSnapshotContract(parsed, sessionId);
  if (!checked.ok) return { ok: false, code: 'invalid', error: checked.error };
  return { ok: true, snapshot: checked.snapshot };
}

// ── 持久快照的恢复（重启/手动打开原会话按 id 恢复原定义） ──

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const SNAPSHOT_FIELDS = ['schemaVersion', 'sessionId', 'revision', 'platform', 'presetId', 'effectiveCwd', 'cwdBinding', 'rootBindings', 'skills', 'issues', 'createdAt'] as const;
const SNAPSHOT_HASH_PATTERN = /^[0-9a-f]{64}$/;
const SNAPSHOT_SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SNAPSHOT_ROOT_ID_PATTERN = /^root-\d+$/;

/** 有界深度检查：解码深度超过预算即无效（显式栈，避免对抗性深嵌套撑爆递归） */
function snapshotDepth(value: unknown): number {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }];
  let max = 0;
  while (stack.length) {
    const current = stack.pop()!;
    if (current.depth > max) max = current.depth;
    if (max > SNAPSHOT_LIMITS.maxDecodeDepth) return max;
    if (Array.isArray(current.value)) {
      for (const item of current.value) stack.push({ value: item, depth: current.depth + 1 });
    } else if (isPlainRecord(current.value)) {
      for (const item of Object.values(current.value)) stack.push({ value: item, depth: current.depth + 1 });
    }
  }
  return max;
}

/** 绑定形状：只有 path/dev/ino 三个字段且类型合法 */
function validSnapshotBinding(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  for (const key of Object.keys(value)) {
    if (key !== 'path' && key !== 'dev' && key !== 'ino') return false;
  }
  if (typeof value.path !== 'string' || !value.path.startsWith('/') || value.path.length > SESSION_CONTEXT_LIMITS.maxPathChars) return false;
  if (typeof value.dev !== 'number' || !Number.isSafeInteger(value.dev) || value.dev < 0) return false;
  if (typeof value.ino !== 'number' || !Number.isSafeInteger(value.ino) || value.ino <= 0) return false;
  return true;
}

/** 恢复前的完整契约校验：深度、字段形状、绑定合法性、哈希格式；损坏 → invalid，拒绝用于新会话 */
function validateSnapshotContract(parsed: unknown, sessionId: string): { ok: true; snapshot: SessionContextSnapshot } | { ok: false; error: string } {
  if (!isPlainRecord(parsed)) return { ok: false, error: '快照格式无效' };
  if (snapshotDepth(parsed) > SNAPSHOT_LIMITS.maxDecodeDepth) return { ok: false, error: '快照解码深度超出预算' };
  for (const key of Object.keys(parsed)) {
    if (!(SNAPSHOT_FIELDS as readonly string[]).includes(key)) return { ok: false, error: `快照包含未知字段：${key}` };
  }
  if (parsed.schemaVersion !== 1) return { ok: false, error: '快照版本无效' };
  if (parsed.sessionId !== sessionId) return { ok: false, error: '快照归属会话不一致' };
  const revision = parsed.revision;
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) return { ok: false, error: '快照 revision 无效' };
  for (const key of ['platform', 'presetId'] as const) {
    const value = parsed[key];
    if (typeof value !== 'string' || value.length > 512) return { ok: false, error: `快照字段无效：${key}` };
  }
  // cwd 预算与配置一致（4096 字符）：覆盖系统支持的长目录保存/创建/冷恢复
  const effectiveCwd = parsed.effectiveCwd;
  if (typeof effectiveCwd !== 'string' || effectiveCwd.length > SESSION_CONTEXT_LIMITS.maxPathChars) return { ok: false, error: '快照字段无效：effectiveCwd' };
  const platform = parsed.platform as string;
  const presetId = parsed.presetId as string;
  if (platform === '' || presetId === '') return { ok: false, error: '快照字段无效：platform/presetId 为空' };
  if (effectiveCwd !== '' && !effectiveCwd.startsWith('/')) return { ok: false, error: '快照工作目录无效' };
  // effectiveCwd 为空 ⇔ cwdBinding 为 null；非空时绑定必须形状完好
  if (effectiveCwd === '' && parsed.cwdBinding !== null) return { ok: false, error: '快照工作目录绑定无效' };
  if (effectiveCwd !== '' && !validSnapshotBinding(parsed.cwdBinding)) return { ok: false, error: '快照工作目录绑定无效' };
  const rootBindings = parsed.rootBindings;
  if (!Array.isArray(rootBindings) || rootBindings.length > SESSION_CONTEXT_LIMITS.maxListItems) return { ok: false, error: '快照资料根列表无效' };
  const rootIds = new Set<string>();
  for (const entry of rootBindings) {
    if (!isPlainRecord(entry)) return { ok: false, error: '快照资料根绑定无效' };
    for (const key of Object.keys(entry)) {
      if (key !== 'rootId' && key !== 'binding') return { ok: false, error: '快照资料根绑定无效' };
    }
    const rootId = entry.rootId;
    if (typeof rootId !== 'string' || !SNAPSHOT_ROOT_ID_PATTERN.test(rootId) || rootIds.has(rootId)) return { ok: false, error: '快照资料根标识无效' };
    rootIds.add(rootId);
    if (!validSnapshotBinding(entry.binding)) return { ok: false, error: '快照资料根绑定无效' };
  }
  const skills = parsed.skills;
  if (!Array.isArray(skills) || skills.length > SKILL_LIMITS.maxSkills) return { ok: false, error: '快照 Skill 列表无效' };
  const names = new Set<string>();
  for (const skill of skills) {
    if (!isPlainRecord(skill)) return { ok: false, error: '快照 Skill 无效' };
    for (const key of Object.keys(skill)) {
      if (!['name', 'description', 'modelInvocable', 'userInvocable', 'sourcePath', 'sourceHash', 'contentHash', 'body'].includes(key)) return { ok: false, error: '快照 Skill 包含未知字段' };
    }
    const name = skill.name;
    if (typeof name !== 'string' || !SNAPSHOT_SKILL_NAME_PATTERN.test(name) || names.has(name)) return { ok: false, error: '快照 Skill 名称无效' };
    names.add(name);
    if (typeof skill.description !== 'string' || [...skill.description].length > SKILL_LIMITS.maxDescriptionChars) return { ok: false, error: '快照 Skill 描述无效' };
    if (typeof skill.modelInvocable !== 'boolean' || typeof skill.userInvocable !== 'boolean') return { ok: false, error: '快照 Skill 开关无效' };
    if (typeof skill.sourcePath !== 'string' || !skill.sourcePath.startsWith('/') || skill.sourcePath.length > SESSION_CONTEXT_LIMITS.maxPathChars) return { ok: false, error: '快照 Skill 来源无效' };
    if (typeof skill.sourceHash !== 'string' || !SNAPSHOT_HASH_PATTERN.test(skill.sourceHash)) return { ok: false, error: '快照 Skill 哈希无效' };
    if (typeof skill.contentHash !== 'string' || !SNAPSHOT_HASH_PATTERN.test(skill.contentHash)) return { ok: false, error: '快照 Skill 哈希无效' };
    // 冻结正文完整性：必须非空，且 contentHash 就是正文的实际 SHA-256（正文被篡改/置空 → invalid，原生恢复回滚）。
    // sourceHash 是含 frontmatter 的原始文件哈希，无法从正文重建，这里只核对 contentHash 语义。
    if (typeof skill.body !== 'string' || skill.body.length === 0 || Buffer.byteLength(skill.body, 'utf8') > SKILL_LIMITS.maxFileBytes) return { ok: false, error: '快照 Skill 正文无效' };
    const actualContentHash = createHash('sha256').update(skill.body, 'utf8').digest('hex');
    if (actualContentHash !== skill.contentHash) return { ok: false, error: '快照 Skill 正文与内容哈希不一致' };
  }
  const issues = parsed.issues;
  if (!Array.isArray(issues) || issues.some((issue) => typeof issue !== 'string' || issue.length > 512)) return { ok: false, error: '快照问题列表无效' };
  const createdAt = parsed.createdAt;
  if (typeof createdAt !== 'number' || !Number.isSafeInteger(createdAt) || createdAt <= 0) return { ok: false, error: '快照创建时间无效' };
  return { ok: true, snapshot: parsed as unknown as SessionContextSnapshot };
}

/** 已确认磁盘上没有可用快照的会话：恢复入口不再重复做磁盘 IO（只记「真实缺失」，损坏不在此列） */
const snapshotlessSessions = new Set<string>();

export type ManagedSnapshotOutcome =
  | { kind: 'none' }
  | { kind: 'snapshot'; snapshot: SessionContextSnapshot }
  | { kind: 'invalid'; error: string };

/**
 * 管理快照恢复的三态入口（preset-scoped 串行 agent/created 内调用）：
 * - none：磁盘上真实没有快照（ENOENT）→ legacy 未管理会话，不安装新增限制；
 * - snapshot：恢复成功（路径重查的失效项在 issues 如实标记，不改变快照授权）；
 * - invalid：存在但损坏/被替换（symlink/目录/超大/契约不符）→ 调用方必须拒绝该会话，不得降级为未管理。
 * 恢复失败只记「none」进免重查集合；invalid 每次如实重查，不把损坏缓存成缺失。
 */
export async function restoreManagedSnapshot(sessionId: string, loader?: unknown): Promise<ManagedSnapshotOutcome> {
  const active = snapshotForSession(sessionId);
  if (active) return { kind: 'snapshot', snapshot: active };
  if (!SESSION_ID_PATTERN.test(sessionId) || snapshotlessSessions.has(sessionId)) return { kind: 'none' };
  const disk = readSnapshot(sessionId);
  if (!disk.ok) {
    if (disk.code === 'missing') {
      snapshotlessSessions.add(sessionId);
      return { kind: 'none' };
    }
    hooks.log('warn', `直播会话快照无法恢复（${sessionId}）：${disk.error}`);
    return { kind: 'invalid', error: disk.error };
  }
  const snapshot = disk.snapshot;
  const issues = [...snapshot.issues];
  if (snapshot.effectiveCwd && snapshot.cwdBinding) {
    if (await verifyDirectory(snapshot.cwdBinding)) issues.push('工作目录已失效（恢复时核查）');
  }
  for (const root of snapshot.rootBindings) {
    if (await verifyDirectory(root.binding)) issues.push(`资料根 ${root.rootId} 已失效（恢复时核查）`);
  }
  const composition = loader === undefined ? { ok: true as const } : checkHostComposition(loader);
  const restored: SessionContextSnapshot = { ...snapshot, issues };
  registerActiveSession(restored, composition);
  registerObservationSession(sessionId);
  return { kind: 'snapshot', snapshot: restored };
}

/** 创建/恢复失败或 agent 释放后丢弃恢复阶段登记的活动会话（原生已回滚/会话已关闭，不留幽灵活动快照） */
export function discardActiveSession(sessionId: string): void {
  activeSessions.delete(sessionId);
  observations.delete(sessionId);
}

/** 测试隔离用：清空内存中的活动会话登记与观测（模拟进程重启；生产代码不得调用） */
export function clearActiveSessionsForTest(): void {
  activeSessions.clear();
  observations.clear();
  snapshotlessSessions.clear();
}

// ── 每 turn 预算与运行时观测 ──────────────────────────

/**
 * 单个 native turn 的预算与输出归属（四轮接收核对 2）：与会话级状态分离存储，
 * 按实际 native turn 键控——在途 IO 闭包捕获进入时的预算对象，切 turn 原地清零不再污染结算。
 */
interface TurnBudget {
  skillCalls: number;
  skillBodyBytes: number;
  /** 本 turn 已实际输出正文的 Skill 名称（正式评审 R6：与跨 turn 的历史加载状态分开计量） */
  turnEmittedSkills: Set<string>;
  readAttempts: number;
  readBufferBytes: number;
  readOutputBytes: number;
}

interface SessionObservation {
  turn: number;
  turns: Map<number, TurnBudget>;
  skills: Map<string, { status: SessionContextStatus; loadedAt: number | null; hash: string | null }>;
  /** 会话级在途保护：真实 IO 收束前 busy 不释放（与各 turn 预算无关） */
  inflight: boolean;
}

const observations = new Map<string, SessionObservation>();

function budgetFor(observed: SessionObservation, turn: number): TurnBudget {
  let budget = observed.turns.get(turn);
  if (!budget) {
    budget = { skillCalls: 0, skillBodyBytes: 0, turnEmittedSkills: new Set<string>(), readAttempts: 0, readBufferBytes: 0, readOutputBytes: 0 };
    observed.turns.set(turn, budget);
    // 有界：只保留当前与近两个 turn 的预算
    for (const key of observed.turns.keys()) {
      if (key < turn - 2) observed.turns.delete(key);
    }
  }
  return budget;
}

function observationFor(sessionId: string): SessionObservation {
  let existing = observations.get(sessionId);
  if (!existing) {
    existing = { turn: 0, turns: new Map<number, TurnBudget>(), skills: new Map(), inflight: false };
    observations.set(sessionId, existing);
  }
  return existing;
}

/** agent pre-step 在每个真实 turn 开始时调用：只推进当前 turn 号，各 turn 预算按键惰性创建，
 * 不做原地清零——在途 IO 闭包捕获的旧 turn 预算对象继续归属旧 turn，结算不污染新 turn */
export function noteSessionTurn(sessionId: string, turn: number): void {
  const existing = observations.get(sessionId);
  if (!existing) return;
  if (existing.turn !== turn) existing.turn = turn;
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
  | { status: 'loaded'; name: string; body: string; contentHash: string; /** 同 turn 重复：明确不重复注入正文（内部有界标记，对外状态仍是 loaded） */ repeated?: true }
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
  const budget = budgetFor(observed, observed.turn);
  if (budget.skillCalls >= SKILL_TURN_LIMITS.callsPerTurn) {
    return { status: 'limit_exceeded', detail: `本轮 Skill 加载次数已达上限（${SKILL_TURN_LIMITS.callsPerTurn}）。` };
  }
  // 正式评审 R6：分离「跨 turn 历史加载状态」与「本 turn 已输出正文集合」——
  // 同 turn 同名首次成功才输出一份冻结正文（计入 128 KiB），重复请求只返回无正文提示；
  // 新 turn 再次请求可返回同一冻结正文并重新计入该 turn 预算。调用次数上限不变。
  const alreadyEmittedThisTurn = budget.turnEmittedSkills.has(name);
  const bodyBytes = Buffer.byteLength(skill.body, 'utf8');
  if (!alreadyEmittedThisTurn && budget.skillBodyBytes + bodyBytes > SKILL_TURN_LIMITS.turnBodyBytes) {
    return { status: 'limit_exceeded', detail: `本轮 Skill 正文字节预算（${SKILL_TURN_LIMITS.turnBodyBytes}）不足。` };
  }
  budget.skillCalls += 1;
  if (!alreadyEmittedThisTurn) {
    budget.skillBodyBytes += bodyBytes;
    budget.turnEmittedSkills.add(name);
  }
  // 历史加载状态只供 owner 视图（loadedAt/hash），不参与本 turn 计量
  observed.skills.set(name, { status: 'loaded', loadedAt: Date.now(), hash: skill.contentHash });
  if (alreadyEmittedThisTurn) {
    return { status: 'loaded', name: skill.name, body: '', contentHash: skill.contentHash, repeated: true };
  }
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
  // 尝试次数预算按进入时的 turn 计（与下方 readMaterial 的结算归属一致）
  if (budgetFor(observed, observed.turn).readAttempts >= MATERIAL_LIMITS.attemptsPerTurn) {
    return { status: 'limit_exceeded', detail: `本轮资料读取次数已达上限（${MATERIAL_LIMITS.attemptsPerTurn}）。` };
  }
  const startLine = input.startLine === undefined ? MATERIAL_LIMITS.defaultStartLine : Number(input.startLine);
  const maxLines = input.maxLines === undefined ? MATERIAL_LIMITS.defaultMaxLines : Number(input.maxLines);
  if (!Number.isSafeInteger(startLine) || startLine < 1 || !Number.isSafeInteger(maxLines) || maxLines < 1 || maxLines > MATERIAL_LIMITS.maxLines) {
    return { status: 'denied', detail: `行段无效：startLine 从 1 开始，maxLines 1～${MATERIAL_LIMITS.maxLines}。` };
  }
  // 四轮接收核对 2：进入时捕获本次调用的 turn 预算对象——之后 noteSessionTurn 切换 turn
  // 也不影响本次结算的归属（旧 IO 结算不记新 turn）；busy 由会话级 inflight 单独保护。
  // entryTurnBudget 与 turnBudget 在同一同步段内捕获，指向同一 turn 的同一预算对象
  const turnBudget = budgetFor(observed, observed.turn);
  turnBudget.readAttempts += 1;
  observed.inflight = true;
  // 组合信号保留最先触发的原因：外部先取消后，即使 IO 收束时本地 deadline 也已到期，
  // 仍须返回 cancelled。只有组合原因确实来自本地 deadline 时才分类为 timeout。
  const deadlineSignal = AbortSignal.timeout(MATERIAL_LIMITS.readTimeoutMs);
  const timeout = input.signal ? AbortSignal.any([deadlineSignal, input.signal]) : deadlineSignal;
  const classifyAbort = (): 'timeout' | 'cancelled' => (
    deadlineSignal.aborted && timeout.reason === deadlineSignal.reason ? 'timeout' : 'cancelled'
  );
  try {
    // 正式评审 R5：IO 前按剩余预算约束本次读取上限（同时是文件大小上限）；剩余额度为零时不发出任何读取
    const remainingBudget = Math.max(0, MATERIAL_LIMITS.turnBufferBytes - turnBudget.readBufferBytes);
    if (remainingBudget <= 0) {
      return { status: 'limit_exceeded', detail: `本轮读取缓冲预算（${MATERIAL_LIMITS.turnBufferBytes} 字节）已用完。` };
    }
    const result = await readBoundedFile({
      root: root.binding,
      relativePath: input.path,
      maxBytes: Math.min(MATERIAL_LIMITS.maxFileBytes, remainingBudget),
      signal: timeout,
    });
    // 四轮接收核对 1：先把真实已读字节结算到进入时捕获的原 turn 预算（失败/取消不免单），
    // 再决定 cancelled/timeout/正文提交——早于任何 aborted 提前返回
    turnBudget.readBufferBytes += result.ok ? result.bytes.byteLength : (result.consumedBytes ?? 0);
    // 正式评审 R4：读取返回即核对组合信号——取消/内部超时零正文，晚到缓冲不提交
    if (timeout.aborted) return { status: classifyAbort(), detail: '' };
    if (!result.ok) {
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
    if (turnBudget.readBufferBytes > MATERIAL_LIMITS.turnBufferBytes) {
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
    if (turnBudget.readOutputBytes + encoded.byteLength > MATERIAL_LIMITS.turnOutputBytes) {
      return { status: 'limit_exceeded', detail: `本轮返回正文预算（${MATERIAL_LIMITS.turnOutputBytes} 字节）不足。` };
    }
    turnBudget.readOutputBytes += encoded.byteLength;
    // 正式评审 R4：结果提交前最后核对组合信号（读后复核与切片都可能跨越取消时点）
    if (timeout.aborted) return { status: classifyAbort(), detail: '' };
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
    // 真实在途操作跨 turn 收束前 busy 不提前释放：finally 只在本函数真正返回时解除
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
