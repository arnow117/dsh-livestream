/**
 * 会话上下文的路径绑定与受限文件读取（宿主端，Node fs）。
 *
 * 只服务本 Feature 的两类授权范围：Skill 来源（目录/文件）和资料根。不是通用文件系统框架。
 *
 * 读取协议（工程上下文「目录、Skill 与实际读取验证」第 5 条）：
 * 1. 先做词法 containment（拒绝绝对路径、`..` 段、NUL/控制符、URI 形式）；
 * 2. 再校验保存根身份和目标 realpath 的分隔符边界；
 * 3. 逐段 lstat 拒绝后续 symlink（即使链接仍在根内）；
 * 4. 用只读 open + O_NOFOLLOW 打开终端普通文件，fd.fstat 与已验证目标 dev/ino 比对，匹配后才读取；
 * 5. 打开前后和缓冲读取结束后复核根/祖先/规范目标身份与范围；发现重定向、替换立即丢弃缓冲。
 */

import { createHash } from 'node:crypto';
import { open, lstat, realpath, access, constants as fsConstants, type FileHandle } from 'node:fs/promises';
import { closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
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

export interface BoundedReadRequest {
  /** 授权范围（已验证的目录绑定） */
  root: DirectoryBinding;
  /** 根内的相对路径（模型或发现提交） */
  relativePath: string;
  /** 最多读取的原始字节数 */
  maxBytes: number;
  /** 调用方取消 */
  signal?: AbortSignal;
  /** 读完后复核范围的间隔函数；测试可注入延迟 */
  beforeRead?: () => Promise<void> | void;
  afterRead?: () => Promise<void> | void;
}

export type BoundedReadResult =
  | { ok: true; bytes: Uint8Array; sha256: string; target: string }
  | { ok: false; failure: PathFailure };

/**
 * 受限读取一个普通文件：词法校验 → 逐段 lstat（拒绝 symlink 与特殊文件）→ realpath 边界 →
 * 根身份重查 → O_NOFOLLOW 打开 → fd 身份比对 → 读取 → 读后复核。任何一步失败都零正文返回。
 */
export async function readBoundedFile(request: BoundedReadRequest): Promise<BoundedReadResult> {
  const lexical = checkRelativePath(request.relativePath);
  if (lexical) return { ok: false, failure: lexical };
  // 逐段 lstat：拒绝任何一段是 symlink 或特殊文件；最后一段必须是普通文件
  const segments = request.relativePath.split('/');
  let walked = request.root.path;
  for (const [index, segment] of segments.entries()) {
    walked = walked.endsWith(sep) ? walked + segment : `${walked}/${segment}`;
    let stats;
    try {
      stats = await lstat(walked);
    } catch (error) {
      return { ok: false, failure: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not_found' : 'io_error' };
    }
    if (stats.isSymbolicLink()) return { ok: false, failure: 'symlink' };
    const isLast = index === segments.length - 1;
    if (isLast ? !stats.isFile() : !stats.isDirectory()) return { ok: false, failure: 'unsupported_file' };
  }
  let target: string;
  try {
    target = await realpath(walked);
  } catch {
    return { ok: false, failure: 'not_found' };
  }
  // realpath 等价于 walked（逐段已是真目录/文件），但仍按边界检查：目标必须在当前授权根内
  if (!withinRoot(request.root.path, target)) return { ok: false, failure: 'escape' };
  if (await verifyDirectory(request.root)) return { ok: false, failure: 'identity_mismatch' };
  let finalStats;
  try {
    finalStats = await lstat(target);
  } catch {
    return { ok: false, failure: 'not_found' };
  }
  if (!finalStats.isFile()) return { ok: false, failure: 'unsupported_file' };
  if (finalStats.size > request.maxBytes) return { ok: false, failure: 'limit_exceeded' };
  await request.beforeRead?.();
  if (request.signal?.aborted) return { ok: false, failure: 'cancelled' };
  let handle: FileHandle | null = null;
  try {
    handle = await open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW, 0);
    const fdStats = await handle.stat();
    // fd 身份比对：打开前后目标被替换（inode 变化）即拒绝，不读取任何字节
    if (fdStats.dev !== finalStats.dev || fdStats.ino !== finalStats.ino) return { ok: false, failure: 'identity_mismatch' };
    if (await verifyDirectory(request.root)) return { ok: false, failure: 'identity_mismatch' };
    const size = Math.min(fdStats.size, request.maxBytes);
    const buffer = Buffer.alloc(size);
    let readTotal = 0;
    while (readTotal < size) {
      if (request.signal?.aborted) return { ok: false, failure: 'cancelled' };
      const { bytesRead } = await handle.read(buffer, readTotal, size - readTotal, readTotal);
      if (bytesRead === 0) break;
      readTotal += bytesRead;
    }
    await request.afterRead?.();
    // 读后复核：根被替换/目标身份变化则丢弃缓冲
    if (await verifyDirectory(request.root)) return { ok: false, failure: 'identity_mismatch' };
    let afterStats;
    try {
      afterStats = await lstat(target);
    } catch {
      return { ok: false, failure: 'identity_mismatch' };
    }
    if (afterStats.dev !== finalStats.dev || afterStats.ino !== finalStats.ino) return { ok: false, failure: 'identity_mismatch' };
    const data = new Uint8Array(buffer.subarray(0, readTotal));
    return { ok: true, bytes: data, sha256: createHash('sha256').update(data).digest('hex'), target };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (request.signal?.aborted) return { ok: false, failure: 'cancelled' };
    if (code === 'ENOENT') return { ok: false, failure: 'not_found' };
    if (code === 'ELOOP') return { ok: false, failure: 'symlink' };
    if (code === 'EACCES') return { ok: false, failure: 'unreadable' };
    return { ok: false, failure: 'io_error' };
  } finally {
    await handle?.close().catch(() => {});
  }
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

/**
 * 发现阶段的候选读取（Skill 来源）：以「发现时 lstat 过的可信根」为锚，逐段核对根/各中间目录/末端文件的
 * 身份（中间目录被换成 symlink 即拒绝——末端 O_NOFOLLOW 不保护路径段），O_NOFOLLOW 打开 + fd 身份比对，
 * 有界读取，读后复核整条路径身份未变。beforeRead/afterRead 供测试在「发现到读取」之间注入受控替换。
 */
export interface DiscoveryReadHooks {
  beforeRead?: () => Promise<void> | void;
  afterRead?: () => Promise<void> | void;
}

export type DiscoveredSkillReadResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; failure: PathFailure };

function walkSegments(rootPath: string, rootIdentity: { dev: number; ino: number }, relativePath: string):
  { ok: true; segments: Array<{ path: string; dev: number; ino: number }>; terminal: { path: string; dev: number; ino: number } }
  | { ok: false; failure: PathFailure } {
  let rootStats;
  try {
    rootStats = lstatSync(rootPath, { throwIfNoEntry: false });
  } catch {
    return { ok: false, failure: 'io_error' };
  }
  if (!rootStats) return { ok: false, failure: 'not_found' };
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) return { ok: false, failure: 'identity_mismatch' };
  if (rootStats.dev !== rootIdentity.dev || rootStats.ino !== rootIdentity.ino) return { ok: false, failure: 'identity_mismatch' };
  const segments: Array<{ path: string; dev: number; ino: number }> = [{ path: rootPath, dev: rootStats.dev, ino: rootStats.ino }];
  const parts = relativePath.split('/').filter((part) => part.length > 0);
  let walked = rootPath;
  for (const [index, part] of parts.entries()) {
    walked = walked.endsWith(sep) ? walked + part : `${walked}/${part}`;
    let stats;
    try {
      stats = lstatSync(walked, { throwIfNoEntry: false });
    } catch {
      return { ok: false, failure: 'io_error' };
    }
    if (!stats) return { ok: false, failure: 'not_found' };
    if (stats.isSymbolicLink()) return { ok: false, failure: 'symlink' };
    const isTerminal = index === parts.length - 1;
    if (isTerminal) {
      if (!stats.isFile()) return { ok: false, failure: 'unsupported_file' };
      return {
        ok: true,
        segments,
        terminal: { path: walked, dev: stats.dev, ino: stats.ino },
      };
    }
    if (!stats.isDirectory()) return { ok: false, failure: 'unsupported_file' };
    segments.push({ path: walked, dev: stats.dev, ino: stats.ino });
  }
  return { ok: false, failure: 'invalid_path' };
}

export async function readDiscoveredSkill(
  rootPath: string,
  rootIdentity: { dev: number; ino: number },
  relativePath: string,
  maxBytes: number,
  hooks: DiscoveryReadHooks = {},
): Promise<DiscoveredSkillReadResult> {
  const walked = walkSegments(rootPath, rootIdentity, relativePath);
  if (!walked.ok) return walked;
  await hooks.beforeRead?.();
  const rewalked = walkSegments(rootPath, rootIdentity, relativePath);
  if (!rewalked.ok) return rewalked;
  // 打开前再走查一次：受控替换窗口内目录/文件身份变化即拒绝
  for (const [index, segment] of rewalked.segments.entries()) {
    const before = walked.segments[index];
    if (!before || before.dev !== segment.dev || before.ino !== segment.ino) return { ok: false, failure: 'identity_mismatch' };
  }
  const terminal = rewalked.terminal;
  let fd: number | null = null;
  try {
    fd = openSync(terminal.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile()) return { ok: false, failure: 'unsupported_file' };
      if (opened.dev !== terminal.dev || opened.ino !== terminal.ino) return { ok: false, failure: 'identity_mismatch' };
      if (opened.size > maxBytes) return { ok: false, failure: 'limit_exceeded' };
      const buffer = Buffer.alloc(opened.size);
      let total = 0;
      while (total < opened.size) {
        const read = readSync(fd, buffer, total, opened.size - total, total);
        if (read === 0) break;
        total += read;
      }
      if (total > maxBytes) return { ok: false, failure: 'limit_exceeded' };
      await hooks.afterRead?.();
      // 读后复核整条路径身份（根/各段/末端）未变；替换即丢弃缓冲
      const finalWalk = walkSegments(rootPath, rootIdentity, relativePath);
      if (!finalWalk.ok) return { ok: false, failure: finalWalk.failure };
      for (const [index, segment] of finalWalk.segments.entries()) {
        const before = rewalked.segments[index];
        if (!before || before.dev !== segment.dev || before.ino !== segment.ino) return { ok: false, failure: 'identity_mismatch' };
      }
      if (finalWalk.terminal.dev !== terminal.dev || finalWalk.terminal.ino !== terminal.ino) return { ok: false, failure: 'identity_mismatch' };
      return { ok: true, bytes: new Uint8Array(buffer.subarray(0, total)) };
    } finally {
      closeSync(fd);
      fd = null;
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') return { ok: false, failure: 'symlink' };
    if (code === 'ENOENT') return { ok: false, failure: 'not_found' };
    if (code === 'EACCES') return { ok: false, failure: 'unreadable' };
    return { ok: false, failure: 'io_error' };
  }
}

/** 判断路径（已 canonical）是否落在某个绑定目录内 */
export function isInsideDirectory(binding: DirectoryBinding, canonicalPath: string): boolean {
  return withinRoot(binding.path, canonicalPath);
}

export type SyncSecureReadResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; failure: PathFailure };

/**
 * 发现阶段的同步安全读取（Skill 候选 Markdown 等已 lstat 过的普通文件）：
 * O_NOFOLLOW 打开（检查与打开之间被换成 symlink 即 ELOOP 拒绝）→ fd 身份与检查时的 dev/ino 比对 →
 * 有界读取 → 读后复核路径身份未变。任何一步失败都零正文返回，不跟随「发现到读取」之间的替换。
 */
export function readRegularFileNoFollowSync(path: string, maxBytes: number, observed: { dev: number; ino: number }): SyncSecureReadResult {
  let fd: number | null = null;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile()) return { ok: false, failure: 'unsupported_file' };
      if (opened.dev !== observed.dev || opened.ino !== observed.ino) return { ok: false, failure: 'identity_mismatch' };
      if (opened.size > maxBytes) return { ok: false, failure: 'limit_exceeded' };
      const buffer = Buffer.alloc(opened.size);
      let total = 0;
      while (total < opened.size) {
        const read = readSync(fd, buffer, total, opened.size - total, total);
        if (read === 0) break;
        total += read;
      }
      if (total > maxBytes) return { ok: false, failure: 'limit_exceeded' };
      // 读后复核：路径条目在读取期间被替换（inode 变化或变成 symlink）则丢弃缓冲
      const after = lstatSync(path, { throwIfNoEntry: false });
      if (!after || after.dev !== observed.dev || after.ino !== observed.ino) return { ok: false, failure: 'identity_mismatch' };
      return { ok: true, bytes: new Uint8Array(buffer.subarray(0, total)) };
    } finally {
      closeSync(fd);
      fd = null;
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') return { ok: false, failure: 'symlink' };
    if (code === 'ENOENT') return { ok: false, failure: 'not_found' };
    if (code === 'EACCES') return { ok: false, failure: 'unreadable' };
    return { ok: false, failure: 'io_error' };
  }
}

/** 规范化候选路径（保存时发现用）：realpath 失败原样抛出 */
export function canonicalExisting(path: string): Promise<string> {
  return realpath(resolve(path));
}

export { dirname, join };
