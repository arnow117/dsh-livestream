import { mkdtemp, mkdir, rm, symlink, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bindDirectory, readBoundedFile, readDiscoveredSkill, verifyDirectory } from '../src/dsh/sessionContextPaths';

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

  // ── 正式评审 R1：中间目录在打开前检查后被移出根并以 symlink 换回（末端 inode 保持）必须零正文 ──

  it('returns zero content when an intermediate segment is moved outside and swapped back as a symlink', async () => {
    await mkdir(join(dir, 'root/mid'), { recursive: true });
    await writeFile(join(dir, 'root/mid/file.txt'), '根内原正文\n');
    const { rename: renamePath, symlink: symlinkPath, writeFile: rewrite } = await import('node:fs/promises');
    const result = await readBoundedFile({
      root: (globalThis as any).__root,
      relativePath: 'mid/file.txt',
      maxBytes: 4096,
      beforeRead: async () => {
        // 受控替换点：逐段检查之后、打开之前——mid 移到根外，原位换 symlink 指向它，就地改写正文
        await renamePath(join(dir, 'root/mid'), join(dir, 'mid-outside'));
        await symlinkPath(join(dir, 'mid-outside'), join(dir, 'root/mid'));
        await rewrite(join(dir, 'mid-outside/file.txt'), '根外被改写的正文\n');
      },
    });
    expect(result.ok, 'moved-outside ancestor with symlink-back must yield zero content').toBe(false);
    if (!result.ok) expect(['identity_mismatch', 'symlink', 'escape']).toContain(result.failure);
    await rm(join(dir, 'root/mid'), { recursive: true, force: true });
    await rename(join(dir, 'mid-outside'), join(dir, 'root/mid'));
  });

  it('returns zero content when an intermediate segment inside the root is swapped to a symlink after the pre-open check', async () => {
    await mkdir(join(dir, 'root/mid'), { recursive: true });
    await writeFile(join(dir, 'root/mid/file.txt'), '根内原正文\n');
    const { rename: renamePath, symlink: symlinkPath, writeFile: rewrite } = await import('node:fs/promises');
    const result = await readBoundedFile({
      root: (globalThis as any).__root,
      relativePath: 'mid/file.txt',
      maxBytes: 4096,
      beforeRead: async () => {
        // 受控替换点：mid 移为 root 内真实目录 mid-real，原位换 symlink（仍在根内），终端文件改写
        await renamePath(join(dir, 'root/mid'), join(dir, 'root/mid-real'));
        await symlinkPath(join(dir, 'root/mid-real'), join(dir, 'root/mid'));
        await rewrite(join(dir, 'root/mid-real/file.txt'), '换回后被改写的正文\n');
      },
    });
    expect(result.ok, 'root-internal intermediate symlink swap must yield zero content').toBe(false);
    if (!result.ok) expect(['identity_mismatch', 'symlink', 'escape']).toContain(result.failure);
    await rm(join(dir, 'root/mid'), { recursive: true, force: true });
    await rename(join(dir, 'root/mid-real'), join(dir, 'root/mid'));
  });

  // ── 正式评审 R4：最后一次读取之后的取消必须零正文 ──

  it('returns zero content when the signal aborts after the final read (post-read re-checks)', async () => {
    const controller = new AbortController();
    const result = await readBoundedFile({
      root: (globalThis as any).__root,
      relativePath: 'allow.txt',
      maxBytes: 4096,
      signal: controller.signal,
      afterRead: async () => {
        // 最后一次 read 已完成、缓冲已就绪：此窗口内的取消必须丢弃缓冲
        controller.abort();
      },
    });
    expect(result.ok, 'post-read abort must not commit content').toBe(false);
    if (!result.ok) expect(result.failure).toBe('cancelled');
  });
});

// ── Skill 发现阶段的「发现到读取」替换防护（与资料读取共享同一身份纪律的入口） ──

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
    const result = await readDiscoveredSkill(dir, await identityOf(dir), 'real-skill.md', 64 * 1024);
    expect(result.ok).toBe(true);
    if (result.ok) expect(new TextDecoder().decode(result.bytes)).toContain('真实正文');
  });

  it('refuses a path swapped to a symlink instead of following it', async () => {
    // 即使目标指向来源外文件，也不允许跟随 symlink 读到内容
    const result = await readDiscoveredSkill(dir, await identityOf(dir), 'swapped-link.md', 64 * 1024);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('symlink swap must never yield content');
    expect(['symlink', 'identity_mismatch']).toContain(result.failure);
  });

  it('discards the buffer when the path entry was replaced by a different file (stale identity)', async () => {
    // 用「另一个文件」的身份来核对：模拟检查与打开之间文件被替换成别的文件
    const replacedIdentity = await identityOf(join(dir, 'outside-secret.txt'));
    const result = await readDiscoveredSkill(dir, replacedIdentity, 'real-skill.md', 64 * 1024);
    // 身份不匹配 → 拒绝并零正文
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toBe('identity_mismatch');
  });

  it('enforces the byte budget before reading', async () => {
    const result = await readDiscoveredSkill(dir, await identityOf(dir), 'real-skill.md', 4);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toBe('limit_exceeded');
  });

  it('rejects directories without content', async () => {
    const { mkdir: makeDir } = await import('node:fs/promises');
    await makeDir(join(dir, 'folder'), { recursive: true });
    const result = await readDiscoveredSkill(dir, await identityOf(dir), 'folder', 64 * 1024);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toBe('unsupported_file');
  });

  it('reports missing files as not_found', async () => {
    const result = await readDiscoveredSkill(dir, { dev: 1, ino: 1 }, 'nope.md', 64 * 1024);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(['not_found', 'identity_mismatch']).toContain(result.failure);
  });
});
