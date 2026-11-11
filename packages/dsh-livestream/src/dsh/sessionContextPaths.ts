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

/** 判断路径（已 canonical）是否落在某个绑定目录内 */
export function isInsideDirectory(binding: DirectoryBinding, canonicalPath: string): boolean {
  return withinRoot(binding.path, canonicalPath);
}

/** 规范化候选路径（保存时发现用）：realpath 失败原样抛出 */
export function canonicalExisting(path: string): Promise<string> {
  return realpath(resolve(path));
}

export { dirname, join };
