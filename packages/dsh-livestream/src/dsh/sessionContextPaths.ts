/**
 * 会话上下文的路径绑定与受限文件读取（宿主端，Node fs）。
 *
 * 只服务本 Feature 的两类授权范围：Skill 来源（目录/文件）和资料根。不是通用文件系统框架。
 *
 * 读取协议（工程上下文「目录、Skill 与实际读取验证」第 5 条；正式评审 R1/R4 后统一为同一实现）：
 * 1. 先做词法 containment（拒绝绝对路径、`..` 段、NUL/控制符、URI 形式）；
 * 2. 逐段 lstat 建立「根 + 全部祖先段 + 末端」的 dev/ino 身份（拒绝任何 symlink 与特殊文件）；
 * 3. realpath 边界核对：目标必须在当前授权根内；
 * 4. 打开前重走整条路径核对身份未变，再用只读 open + O_NOFOLLOW 打开终端普通文件并比对 fd 身份；
 * 5. 读取（每次 read 前后核对取消信号）后重走整条路径核对身份与实际边界未变；任何晚到/取消的缓冲
 *    丢弃，任何一步失败都零正文返回。资料与 Skill 读取共享同一实现，不维护两套不等价检查。
 */

import { createHash } from 'node:crypto';
import { open, lstat, realpath, access, constants as fsConstants, type FileHandle } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

export interface DirectoryBinding {
  path: string;
  dev: number;
  ino: number;
}

export type PathFailure =
  | 'not_found'
  | 'not_directory'
  | 'unreadable'
  | 'symlink'
  | 'escape'
  | 'invalid_path'
  | 'identity_mismatch'
  | 'unsupported_file'
  | 'limit_exceeded'
  | 'cancelled'
  | 'io_error';

/** 目录绑定：realpath + dev/ino；不存在的目录返回 null，由调用方转 not_found */
export async function bindDirectory(path: string): Promise<DirectoryBinding | PathFailure> {
  let real: string;
  try {
    real = await realpath(path);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not_found' : 'io_error';
  }
  let stats;
  try {
    stats = await lstat(real);
  } catch {
    return 'not_found';
  }
  if (!stats.isDirectory()) return 'not_directory';
  try {
    await access(real, fsConstants.R_OK | fsConstants.X_OK);
  } catch {
    return 'unreadable';
  }
  return { path: real, dev: stats.dev, ino: stats.ino };
}

/** 目录身份重查：realpath 未变且 dev/ino 一致才算仍授权 */
export async function verifyDirectory(binding: DirectoryBinding): Promise<PathFailure | null> {
  let real: string;
  try {
    real = await realpath(binding.path);
  } catch {
    return 'not_found';
  }
  if (real !== binding.path) return 'identity_mismatch';
  let stats;
  try {
    stats = await lstat(real);
  } catch {
    return 'not_found';
  }
  if (!stats.isDirectory()) return 'not_directory';
  if (stats.dev !== binding.dev || stats.ino !== binding.ino) return 'identity_mismatch';
  return null;
}

/** 词法 containment：相对路径段校验（拒绝绝对路径、`..`、NUL/控制符、URI 形式） */
export function checkRelativePath(raw: string): PathFailure | null {
  if (typeof raw !== 'string' || raw.length === 0) return 'invalid_path';
  if (raw.length > 4096) return 'invalid_path';
  for (const character of raw) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0 || (code > 0 && code < 0x20) || code === 0x7f) return 'invalid_path';
  }
  if (/^[\w+.-]+:\/\//.test(raw) || /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('\\\\')) return 'invalid_path';
  if (raw.startsWith('/')) return 'invalid_path';
  const segments = raw.split(/[\\/]+/);
  if (segments.includes('..')) return 'escape';
  return null;
}

/** 目标在绑定根内的分隔符边界检查（canonical 后调用） */
function withinRoot(rootPath: string, targetPath: string): boolean {
  if (targetPath === rootPath) return false;
  return targetPath.startsWith(rootPath.endsWith(sep) ? rootPath : rootPath + sep);
}

interface SegmentIdentity {
  path: string;
  dev: number;
  ino: number;
}

type WalkOutcome =
  | { ok: true; segments: SegmentIdentity[]; terminal: SegmentIdentity }
  | { ok: false; failure: PathFailure };

/**
 * 逐段 lstat 建立「根 + 全部祖先段 + 末端」的身份（symlink 与特殊文件即拒绝，末端必须是普通文件）。
 * 与限制无关、与已安装限制状态无关，供打开前/读后两次核对整条路径使用。
 */
async function walkIdentifiedPath(rootPath: string, rootIdentity: { dev: number; ino: number }, relativePath: string): Promise<WalkOutcome> {
  let rootStats;
  try {
    rootStats = await lstat(rootPath);
  } catch (error) {
    return { ok: false, failure: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not_found' : 'io_error' };
  }
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) return { ok: false, failure: 'identity_mismatch' };
  if (rootStats.dev !== rootIdentity.dev || rootStats.ino !== rootIdentity.ino) return { ok: false, failure: 'identity_mismatch' };
  const segments: SegmentIdentity[] = [{ path: rootPath, dev: rootStats.dev, ino: rootStats.ino }];
  const parts = relativePath.split('/').filter((part) => part.length > 0);
  let walked = rootPath;
  for (const [index, part] of parts.entries()) {
    walked = walked.endsWith(sep) ? walked + part : `${walked}/${part}`;
    let stats;
    try {
      stats = await lstat(walked);
    } catch (error) {
      return { ok: false, failure: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not_found' : 'io_error' };
    }
    if (stats.isSymbolicLink()) return { ok: false, failure: 'symlink' };
    const isTerminal = index === parts.length - 1;
    if (isTerminal) {
      if (!stats.isFile()) return { ok: false, failure: 'unsupported_file' };
      return { ok: true, segments, terminal: { path: walked, dev: stats.dev, ino: stats.ino } };
    }
    if (!stats.isDirectory()) return { ok: false, failure: 'unsupported_file' };
    segments.push({ path: walked, dev: stats.dev, ino: stats.ino });
  }
  return { ok: false, failure: 'invalid_path' };
}

function identitiesUnchanged(before: WalkOutcome & { ok: true }, after: WalkOutcome & { ok: true }): boolean {
  if (before.segments.length !== after.segments.length) return false;
  for (const [index, segment] of before.segments.entries()) {
    const current = after.segments[index];
    if (!current || current.dev !== segment.dev || current.ino !== segment.ino) return false;
  }
  return after.terminal.dev === before.terminal.dev && after.terminal.ino === before.terminal.ino;
}

export interface BoundedReadRequest {
  /** 授权范围（已验证的目录绑定） */
  root: DirectoryBinding;
  /** 根内的相对路径（模型或发现提交） */
  relativePath: string;
  /** 最多读取的原始字节数（也是文件大小上限） */
  maxBytes: number;
  /** 调用方取消 */
  signal?: AbortSignal;
  /** 读完复核范围的间隔函数；测试可注入受控替换/取消 */
  beforeRead?: () => Promise<void> | void;
  afterRead?: () => Promise<void> | void;
}

export type BoundedReadResult =
  | { ok: true; bytes: Uint8Array; sha256: string; target: string }
  | { ok: false; failure: PathFailure; /** 已消耗的真实读取字节（失败/取消也要结算，零正文） */ consumedBytes?: number };

export interface DiscoveryReadHooks {
  beforeRead?: () => Promise<void> | void;
  afterRead?: () => Promise<void> | void;
}

/**
 * 两条读取路径（资料 readBoundedFile / Skill 发现 readDiscoveredSkill）共享的唯一实现：
 * 词法校验由调用方负责；这里建立整条路径身份 → realpath 边界 → beforeRead 钩子 → 重走核对 →
 * O_NOFOLLOW 打开 + fd 身份比对 → 逐段有界读取（每次 read 前后核对取消）→ afterRead 钩子 →
 * 取消核对 → 读后重走整条路径核对身份与实际边界。任何一步失败都零正文返回；
 * 读取已开始的失败/取消在结果上携带实际消耗字节，供调用方按已读量结算预算。
 */
async function readViaIdentifiedPath(
  rootPath: string,
  rootIdentity: { dev: number; ino: number },
  relativePath: string,
  maxBytes: number,
  options: { canonicalRoot: string; signal?: AbortSignal; beforeRead?: () => Promise<void> | void; afterRead?: () => Promise<void> | void },
): Promise<{ ok: true; bytes: Uint8Array; sha256: string; target: string } | { ok: false; failure: PathFailure; consumedBytes?: number }> {
  const identity = { dev: rootIdentity.dev, ino: rootIdentity.ino };
  const canonicalRoot = options.canonicalRoot;
  const before = await walkIdentifiedPath(rootPath, identity, relativePath);
  if (!before.ok) return before;
  // 正式复审 R9：授权边界是绑定/保存时固定的 canonical 根（调用方传入），不得以读取时
  // realpath(rootPath) 的新目标重新授权——root 之上的祖先被移动并以 symlink 换回时，
  // root/末端 inode 不变但 canonical 目标已偏离，必须按固定边界零正文拒绝。
  // rootPath 自身（调用方传入的 canonical 串）实时解析结果必须仍等于固定边界。
  let rootReal: string;
  try {
    rootReal = await realpath(rootPath);
  } catch {
    return { ok: false, failure: 'not_found' };
  }
  if (rootReal !== canonicalRoot) return { ok: false, failure: 'identity_mismatch' };
  // realpath 边界：逐段已无 symlink，realpath 等价于 walked，仍显式核对目标在固定授权根内
  let target: string;
  try {
    target = await realpath(before.terminal.path);
  } catch {
    return { ok: false, failure: 'not_found' };
  }
  if (!withinRoot(canonicalRoot, target)) return { ok: false, failure: 'escape' };
  let finalStats;
  try {
    finalStats = await lstat(target);
  } catch {
    return { ok: false, failure: 'not_found' };
  }
  if (!finalStats.isFile()) return { ok: false, failure: 'unsupported_file' };
  if (finalStats.size > maxBytes) return { ok: false, failure: 'limit_exceeded' };
  await options.beforeRead?.();
  if (options.signal?.aborted) return { ok: false, failure: 'cancelled' };
  // 打开前重走整条路径：受控替换窗口内的身份变化即拒绝（R1）
  const reopened = await walkIdentifiedPath(rootPath, identity, relativePath);
  if (!reopened.ok) return reopened;
  if (!identitiesUnchanged(before, reopened)) return { ok: false, failure: 'identity_mismatch' };
  let handle: FileHandle | null = null;
  let consumed = 0;
  try {
    handle = await open(reopened.terminal.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW, 0);
    const fdStats = await handle.stat();
    // fd 身份比对：打开时目标被替换（inode 变化）即拒绝，不读取任何字节
    if (fdStats.dev !== reopened.terminal.dev || fdStats.ino !== reopened.terminal.ino) return { ok: false, failure: 'identity_mismatch' };
    if (!fdStats.isFile()) return { ok: false, failure: 'unsupported_file' };
    if (fdStats.size > maxBytes) return { ok: false, failure: 'limit_exceeded' };
    const size = Math.min(fdStats.size, maxBytes);
    const buffer = Buffer.alloc(size);
    let readTotal = 0;
    while (readTotal < size) {
      if (options.signal?.aborted) return { ok: false, failure: 'cancelled', consumedBytes: consumed };
      const { bytesRead } = await handle.read(buffer, readTotal, size - readTotal, readTotal);
      if (bytesRead === 0) break;
      readTotal += bytesRead;
      consumed += bytesRead;
      // 最后一次 read 返回时也可能已取消：缓冲就地丢弃，不进入提交路径（R4）
      if (options.signal?.aborted) return { ok: false, failure: 'cancelled', consumedBytes: consumed };
    }
    await options.afterRead?.();
    if (options.signal?.aborted) return { ok: false, failure: 'cancelled', consumedBytes: consumed };
    // 读后复核：重走整条路径核对身份（R1）、固定 canonical 边界未变（R9）与实际边界（R1），
    // 变化/越界即丢弃缓冲
    const after = await walkIdentifiedPath(rootPath, identity, relativePath);
    if (!after.ok) return { ok: false, failure: after.failure, consumedBytes: consumed };
    if (!identitiesUnchanged(reopened, after)) return { ok: false, failure: 'identity_mismatch', consumedBytes: consumed };
    let rootRealAfter: string;
    try {
      rootRealAfter = await realpath(rootPath);
    } catch {
      return { ok: false, failure: 'identity_mismatch', consumedBytes: consumed };
    }
    if (rootRealAfter !== canonicalRoot) return { ok: false, failure: 'identity_mismatch', consumedBytes: consumed };
    let targetAfter: string;
    try {
      targetAfter = await realpath(after.terminal.path);
    } catch {
      return { ok: false, failure: 'identity_mismatch', consumedBytes: consumed };
    }
    if (!withinRoot(canonicalRoot, targetAfter)) return { ok: false, failure: 'escape', consumedBytes: consumed };
    if (options.signal?.aborted) return { ok: false, failure: 'cancelled', consumedBytes: consumed };
    const data = new Uint8Array(buffer.subarray(0, readTotal));
    return { ok: true, bytes: data, sha256: createHash('sha256').update(data).digest('hex'), target: after.terminal.path };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (options.signal?.aborted) return { ok: false, failure: 'cancelled', consumedBytes: consumed };
    if (code === 'ENOENT') return { ok: false, failure: 'not_found', consumedBytes: consumed };
    if (code === 'ELOOP') return { ok: false, failure: 'symlink', consumedBytes: consumed };
    if (code === 'EACCES') return { ok: false, failure: 'unreadable', consumedBytes: consumed };
    return { ok: false, failure: 'io_error', consumedBytes: consumed };
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * 受限读取资料根内的一个普通文件（模型工具的资料读取通道）。
 * 读取协议见文件头；任何一步失败都零正文返回，失败/取消携带实际消耗字节。
 */
export async function readBoundedFile(request: BoundedReadRequest): Promise<BoundedReadResult> {
  const lexical = checkRelativePath(request.relativePath);
  if (lexical) return { ok: false, failure: lexical };
  // DirectoryBinding.path 是 bindDirectory 时已规范化的固定 canonical 边界（正式复审 R9）
  return readViaIdentifiedPath(request.root.path, request.root, request.relativePath, request.maxBytes, {
    canonicalRoot: request.root.path,
    signal: request.signal,
    beforeRead: request.beforeRead,
    afterRead: request.afterRead,
  });
}

/**
 * 发现阶段的候选读取（Skill 来源）：rootPath 必须是调用方固定的 canonical 来源根（保存绑定或
 * 发现时已 realpath），走与资料读取完全相同的固定边界身份/取消纪律。
 * beforeRead/afterRead 供测试在「发现到读取」之间注入受控替换。
 */
export async function readDiscoveredSkill(
  canonicalRoot: string,
  rootIdentity: { dev: number; ino: number },
  relativePath: string,
  maxBytes: number,
  hooks: DiscoveryReadHooks = {},
  signal?: AbortSignal,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; failure: PathFailure }> {
  // R12：发现扫描取消信号透传到底层读取的协作检查点（迟到缓冲在读取方丢弃）
  const result = await readViaIdentifiedPath(canonicalRoot, rootIdentity, relativePath, maxBytes, {
    canonicalRoot,
    signal,
    ...hooks,
  });
  if (result.ok) return { ok: true, bytes: result.bytes };
  return { ok: false, failure: result.failure };
}

/** 普通文件绑定（Skill 来源是单个 .md 时的父目录 + 文件身份） */
export interface FileIdentity {
  dev: number;
  ino: number;
  size: number;
}

export async function statFileIdentity(path: string): Promise<FileIdentity | PathFailure> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not_found' : 'io_error';
  }
  if (!stats.isFile()) return 'unsupported_file';
  return { dev: stats.dev, ino: stats.ino, size: stats.size };
}

/** 判断路径（已 canonical）是否落在某个绑定目录内 */
export function isInsideDirectory(binding: DirectoryBinding, canonicalPath: string): boolean {
  return withinRoot(binding.path, canonicalPath);
}

/** 规范化候选路径（保存时发现用）：realpath 失败原样抛出 */
export function canonicalExisting(path: string): Promise<string> {
  return realpath(resolve(path));
}

export { dirname, join };
