import { mkdtemp, mkdir, rm, symlink, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bindDirectory, readBoundedFile, verifyDirectory } from '../src/dsh/sessionContextPaths';

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
