import { mkdtemp, mkdir, rm, symlink, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bindDirectory, readBoundedFile, readRegularFileNoFollowSync, verifyDirectory } from '../src/dsh/sessionContextPaths';

describe('bounded material reading', () => {
  let dir: string;

  const read = (relativePath: string, root?: Awaited<ReturnType<typeof bindDirectory>>) =>
    readBoundedFile({ root: (root ?? (globalThis as any).__root), relativePath, maxBytes: 256 * 1024 });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-session-read-'));
    await mkdir(join(dir, 'root/inner'), { recursive: true });
    await writeFile(join(dir, 'root/allow.txt'), '允许读取的内容\n第二行\n');
    await writeFile(join(dir, 'root/inner/deep.txt'), '深层文件\n');
    await writeFile(join(dir, 'outside-secret.txt'), '范围外内容\n');
    await symlink(join(dir, 'outside-secret.txt'), join(dir, 'root/escape-link.txt'));
    await symlink(join(dir, 'root'), join(dir, 'root/inner/loop-link'));
    (globalThis as any).__root = await bindDirectory(join(dir, 'root'));
  });

  afterAll(async () => {
    delete (globalThis as any).__root;
    await rm(dir, { recursive: true, force: true });
  });

  it('binds a readable directory with dev/ino identity', () => {
    const root = (globalThis as any).__root;
    expect(typeof root).toBe('object');
    expect(root.path.endsWith('root')).toBe(true);
    expect(root.ino).toBeGreaterThan(0);
  });

  it('reads an allowed file and reports its hash', async () => {
    const result = await read('allow.txt');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(new TextDecoder().decode(result.bytes)).toContain('允许读取的内容');
      expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(result.target.endsWith('allow.txt')).toBe(true);
    }
    const deep = await read('inner/deep.txt');
    expect(deep.ok).toBe(true);
  });

  it('rejects absolute paths, traversal, NUL and URI forms lexically', async () => {
    for (const bad of ['/outside-secret.txt', '../outside-secret.txt', 'a/../../outside-secret.txt', 'allow.txt\u0000', 'file:///etc/passwd', '', 'C:\\x']) {
      const result = await read(bad);
      expect(result.ok, bad).toBe(false);
      if (!result.ok) expect(['escape', 'invalid_path'], bad).toContain(result.failure);
    }
  });

  it('rejects symlink escapes even when the target exists', async () => {
    const result = await read('escape-link.txt');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toBe('symlink');
  });

  it('rejects symlinked directory segments inside the root (smaller first-version semantics)', async () => {
    const result = await read('inner/loop-link/allow.txt');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toBe('symlink');
  });

  it('reports missing and unsupported entries without content', async () => {
    const missing = await read('nope.txt');
    expect(missing).toEqual({ ok: false, failure: 'not_found' });
    await mkdir(join(dir, 'root/folder'), { recursive: true });
    const directory = await read('folder');
    expect(directory.ok).toBe(false);
    if (!directory.ok) expect(directory.failure).toBe('unsupported_file');
  });

  it('enforces the per-request byte budget before reading', async () => {
    const result = await readBoundedFile({ root: (globalThis as any).__root, relativePath: 'allow.txt', maxBytes: 4 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toBe('limit_exceeded');
  });

  it('rejects the read when the root identity changed after binding', async () => {
    const stale = await bindDirectory(join(dir, 'root'));
    if (typeof stale === 'string') throw new Error('bind failed');
    // 模拟根被替换：换成另一个不同 inode 的同名目录
    const moved = join(dir, 'root-moved');
    await rename(join(dir, 'root'), moved);
    await mkdir(join(dir, 'root'), { recursive: true });
    await writeFile(join(dir, 'root/allow.txt'), '伪造内容');
    const result = await readBoundedFile({ root: stale, relativePath: 'allow.txt', maxBytes: 1024 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(['identity_mismatch', 'escape', 'symlink']).toContain(result.failure);
    await rm(join(dir, 'root'), { recursive: true, force: true });
    await rename(moved, join(dir, 'root'));
    expect(await verifyDirectory(stale)).toBeNull();
  });

  it('drops the buffer when the file is replaced between stat and open', async () => {
    const result = await readBoundedFile({
      root: (globalThis as any).__root,
      relativePath: 'allow.txt',
      maxBytes: 4096,
      beforeRead: async () => {
        await rm(join(dir, 'root/allow.txt'), { force: true });
        await symlink(join(dir, 'outside-secret.txt'), join(dir, 'root/allow.txt'));
      },
    });
    // O_NOFOLLOW 打开符号链接必须失败；任何情况下不允许读到范围外内容
    expect(result.ok).toBe(false);
    if (!result.ok) expect(['symlink', 'identity_mismatch', 'io_error']).toContain(result.failure);
    await rm(join(dir, 'root/allow.txt'), { force: true });
    await writeFile(join(dir, 'root/allow.txt'), '允许读取的内容\n第二行\n');
    const recovered = await read('allow.txt');
    expect(recovered.ok).toBe(true);
  });

  it('discards the buffer when the root is swapped while reading', async () => {
    const result = await readBoundedFile({
      root: (globalThis as any).__root,
      relativePath: 'allow.txt',
      maxBytes: 4096,
      afterRead: async () => {
        const moved = join(dir, 'root-swap');
        await rename(join(dir, 'root'), moved);
        await mkdir(join(dir, 'root'), { recursive: true });
        await writeFile(join(dir, 'root/allow.txt'), '伪造内容\n');
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toBe('identity_mismatch');
    await rm(join(dir, 'root'), { recursive: true, force: true });
    await rename(join(dir, 'root-swap'), join(dir, 'root'));
    expect(await verifyDirectory((globalThis as any).__root)).toBeNull();
  });

  it('cancels before opening when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await readBoundedFile({ root: (globalThis as any).__root, relativePath: 'allow.txt', maxBytes: 1024, signal: controller.signal });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toBe('cancelled');
  });
});

// ── 评审 HIGH：Skill 发现阶段的「发现到读取」替换防护（同步 O_NOFOLLOW 读取） ──

describe('discovery-time secure file reading', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-discovery-read-'));
    await writeFile(join(dir, 'real-skill.md'), '---\nname: real\ndescription: 真正文。\n---\n真实正文。\n');
    await writeFile(join(dir, 'outside-secret.txt'), '来源外的机密内容\n');
    await symlink(join(dir, 'outside-secret.txt'), join(dir, 'swapped-link.md')).catch(() => {});
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const identityOf = async (path: string) => {
    const { lstatSync } = await import('node:fs');
    const stats = lstatSync(path);
    return { dev: stats.dev, ino: stats.ino };
  };

  it('reads a normal regular file intact', async () => {
    const file = join(dir, 'real-skill.md');
    const result = readRegularFileNoFollowSync(file, 64 * 1024, await identityOf(file));
    expect(result.ok).toBe(true);
    if (result.ok) expect(new TextDecoder().decode(result.bytes)).toContain('真实正文');
  });

  it('refuses a path swapped to a symlink instead of following it (ELOOP)', async () => {
    const link = join(dir, 'swapped-link.md');
    const target = await identityOf(join(dir, 'outside-secret.txt'));
    // 即使传入的是「来源外目标」的身份，也不允许跟随 symlink 读到内容
    const result = readRegularFileNoFollowSync(link, 64 * 1024, target);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('symlink swap must never yield content');
    expect(['symlink', 'identity_mismatch']).toContain(result.failure);
  });

  it('discards the buffer when the path entry was replaced by a different file (stale identity)', async () => {
    const file = join(dir, 'real-skill.md');
    // 用「另一个文件」的身份来核对：模拟检查与打开之间文件被替换成别的文件
    const replacedIdentity = await identityOf(join(dir, 'outside-secret.txt'));
    const result = readRegularFileNoFollowSync(file, 64 * 1024, replacedIdentity);
    // 身份不匹配 → 拒绝并零正文（不返回 fd 打开的那个文件的内容）
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toBe('identity_mismatch');
  });

  it('enforces the byte budget before reading', async () => {
    const file = join(dir, 'real-skill.md');
    const result = readRegularFileNoFollowSync(file, 4, await identityOf(file));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toBe('limit_exceeded');
  });

  it('rejects directories without content', async () => {
    await mkdir(join(dir, 'folder'), { recursive: true });
    const identity = await identityOf(join(dir, 'folder'));
    const result = readRegularFileNoFollowSync(join(dir, 'folder'), 64 * 1024, identity);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toBe('unsupported_file');
  });

  it('reports missing files as not_found', () => {
    const result = readRegularFileNoFollowSync(join(dir, 'nope.md'), 64 * 1024, { dev: 1, ino: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toBe('not_found');
  });
});
