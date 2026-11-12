import { appendFile, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { bindDirectory } from '../src/dsh/sessionContextPaths';
import { CourseAssets } from '../src/body/course/assets';
import { Stage } from '../src/body/stage';
import { StageServer } from '../src/body/server';

const directories: string[] = [];

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'course-assets-'));
  directories.push(directory);
  const root = join(directory, 'root');
  await mkdir(join(root, 'chapter'), { recursive: true });
  await writeFile(join(root, 'chapter', 'index.html'), '<p>original</p>');
  await writeFile(join(root, 'chapter', 'lesson.js'), 'original');
  const binding = await bindDirectory(root);
  if (typeof binding === 'string') throw new Error(binding);
  return { directory, root, binding };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('course asset authorization', () => {
  it('locks authorized bytes to the loaded instance and rejects changes and unknown paths', async () => {
    const { root, binding } = await fixture();
    const assets = await CourseAssets.load(binding, 'chapter/index.html');
    expect(assets.capability).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(await assets.read('chapter/index.html')).toEqual(await readFile(join(root, 'chapter', 'index.html')));
    expect(await assets.read('../chapter/index.html')).toBeNull();
    expect(await assets.read('chapter/%69ndex.html')).toBeNull();
    await writeFile(join(root, 'chapter', 'new.js'), 'new');
    expect(await assets.read('chapter/new.js')).toBeNull();
    await writeFile(join(root, 'chapter', 'lesson.js'), 'changed');
    expect(await assets.read('chapter/lesson.js')).toBeNull();
    assets.revoke();
    expect(await assets.read('chapter/index.html')).toBeNull();
  });

  it('rejects symlinks and ancestor replacement even when the root inode is retained', async () => {
    const { directory, root, binding } = await fixture();
    const assets = await CourseAssets.load(binding, 'chapter/index.html');
    await rename(join(root, 'chapter'), join(root, 'old-chapter'));
    await symlink(join(root, 'old-chapter'), join(root, 'chapter'));
    expect(await assets.read('chapter/index.html')).toBeNull();
    await rm(join(root, 'chapter'));
    await rename(join(root, 'old-chapter'), join(root, 'chapter'));
    await rename(root, join(directory, 'moved'));
    await symlink(join(directory, 'moved'), root);
    expect(await assets.read('chapter/index.html')).toBeNull();
  });

  it('rejects oversized assets and symlinks during loading', async () => {
    const { root, binding } = await fixture();
    await writeFile(join(root, 'large.js'), Buffer.alloc(2 * 1024 * 1024 + 1));
    await expect(CourseAssets.load(binding, 'chapter/index.html')).rejects.toThrow();
    await rm(join(root, 'large.js'));
    await symlink('chapter', join(root, 'link'));
    await expect(CourseAssets.load(binding, 'chapter/index.html')).rejects.toThrow();
  });

  it('rejects too many files and excess aggregate bytes independently', async () => {
    const files = await fixture();
    for (let index = 0; index < 127; index++) {
      await writeFile(join(files.root, `extra-${index}.js`), 'x');
    }
    await expect(CourseAssets.load(files.binding, 'chapter/index.html')).rejects.toThrow();
    const bytes = await fixture();
    for (let index = 0; index < 9; index++) {
      await writeFile(join(bytes.root, `block-${index}.js`), Buffer.alloc(2 * 1024 * 1024));
    }
    await expect(CourseAssets.load(bytes.binding, 'chapter/index.html')).rejects.toThrow();
  });

  it('rejects replacement of a directory or file even when its bytes are unchanged', async () => {
    const { root, binding } = await fixture();
    const assets = await CourseAssets.load(binding, 'chapter/index.html');
    await rename(join(root, 'chapter', 'index.html'), join(root, 'chapter', 'old.html'));
    await writeFile(join(root, 'chapter', 'index.html'), '<p>original</p>');
    expect(await assets.read('chapter/index.html')).toBeNull();
    const other = await fixture();
    const otherAssets = await CourseAssets.load(other.binding, 'chapter/index.html');
    await rename(join(other.root, 'chapter'), join(other.root, 'previous'));
    await mkdir(join(other.root, 'chapter'));
    await writeFile(join(other.root, 'chapter', 'index.html'), '<p>original</p>');
    expect(await otherAssets.read('chapter/index.html')).toBeNull();
  });

  it('rejects replacement of an ancestor above the granted root', async () => {
    const { directory, root, binding } = await fixture();
    const assets = await CourseAssets.load(binding, 'chapter/index.html');
    const moved = `${directory}-old`;
    directories.push(moved);
    await rename(directory, moved);
    await mkdir(directory);
    await rename(join(moved, 'root'), root);
    expect(await assets.read('chapter/index.html')).toBeNull();
  });

  it('rejects a file that changes after its bytes are read but before they are published', async () => {
    const { root, binding } = await fixture();
    const assets = await CourseAssets.load(binding, 'chapter/index.html', {
      afterRead: () => appendFile(join(root, 'chapter', 'index.html'), 'changed'),
    });
    expect(await assets.read('chapter/index.html')).toBeNull();
  });

  it('serves only the current manifest through the real stage server', async () => {
    const { root, binding } = await fixture();
    const assets = await CourseAssets.load(binding, 'chapter/index.html');
    const stage = new Stage();
    const server = new StageServer({
      port: 0,
      token: 'test-stage-token',
      packageDir: '.',
      packs: {} as never,
      stage,
      current: () => ({ character: '', template: '' }),
      courseAssets: () => assets,
    });
    await server.start();
    const port = (server as unknown as { server: { address(): { port: number } } }).server.address().port;
    const base = `http://127.0.0.1:${port}`;
    try {
      const response = await fetch(`${base}/course/asset/${assets.capability}/chapter/index.html?v=1`);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(Buffer.from(await response.arrayBuffer())).toEqual(await readFile(join(root, 'chapter', 'index.html')));
      expect((await fetch(`${base}/course/asset/invalid/chapter/index.html`)).status).toBe(404);
      expect((await fetch(`${base}/events?token=${assets.capability}`)).status).toBe(401);
      expect((await fetch(`${base}/said?token=${assets.capability}`, { method: 'POST' })).status).toBe(401);
      expect((await fetch(`${base}/media?token=${assets.capability}`, { method: 'POST' })).status).toBe(401);
      const rawResponse = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request({ hostname: '127.0.0.1', port, path: `/course/asset/${assets.capability}/chapter/%69ndex.html` }, (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => { body += chunk; });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on('error', reject);
        req.end();
      });
      expect(rawResponse).toEqual({ status: 404, body: '' });
      assets.revoke();
      const revoked = await fetch(`${base}/course/asset/${assets.capability}/chapter/index.html`);
      expect(revoked.status).toBe(404);
      expect(await revoked.text()).toBe('');
    } finally {
      server.stop();
    }
  });

  it('protects bridge reports and validates their body before dispatch', async () => {
    const stage = new Stage();
    const reports: unknown[] = [];
    const server = new StageServer({
      port: 0,
      token: 'test-stage-token',
      packageDir: '.',
      packs: {} as never,
      stage,
      current: () => ({ character: '', template: '' }),
      courseReport: (report) => { reports.push(report); return (report as { accepted?: boolean }).accepted === true; },
    });
    await server.start();
    const port = (server as unknown as { server: { address(): { port: number } } }).server.address().port;
    const base = `http://127.0.0.1:${port}`;
    try {
      expect((await fetch(`${base}/course/bridge`)).status).toBe(401);
      const bridge = await fetch(`${base}/course/bridge?token=test-stage-token`);
      expect(bridge.status).toBe(200);
      expect(bridge.headers.get('cache-control')).toBe('no-store');
      expect(bridge.headers.get('referrer-policy')).toBe('no-referrer');
      const post = (body: string) => fetch(`${base}/course/report?token=test-stage-token`, { method: 'POST', body });
      expect((await post('{')).status).toBe(400);
      expect((await post('x'.repeat(8193))).status).toBe(413);
      expect((await post('{"accepted":false}')).status).toBe(400);
      expect((await post('{"accepted":true}')).status).toBe(204);
      expect(reports).toEqual([{ accepted: false }, { accepted: true }]);
      expect((await fetch(`${base}/course/report`, { method: 'POST', body: '{"accepted":true}' })).status).toBe(401);
    } finally {
      server.stop();
    }
  });

  it('does not reuse an old capability for a replacement root or allow other methods', async () => {
    const first = await fixture();
    const second = await fixture();
    const oldAssets = await CourseAssets.load(first.binding, 'chapter/index.html');
    const newAssets = await CourseAssets.load(second.binding, 'chapter/index.html');
    let active: CourseAssets | null = oldAssets;
    const server = new StageServer({
      port: 0,
      token: 'test-stage-token',
      packageDir: '.',
      packs: {} as never,
      stage: new Stage(),
      current: () => ({ character: '', template: '' }),
      courseAssets: () => active,
    });
    await server.start();
    const port = (server as unknown as { server: { address(): { port: number } } }).server.address().port;
    const base = `http://127.0.0.1:${port}/course/asset`;
    const oldUrl = `${base}/${oldAssets.capability}/chapter/index.html`;
    const newUrl = `${base}/${newAssets.capability}/chapter/index.html`;
    try {
      expect((await fetch(oldUrl)).status).toBe(200);
      expect((await fetch(newUrl)).status).toBe(404);
      active = newAssets;
      expect((await fetch(oldUrl)).status).toBe(404);
      expect((await fetch(newUrl)).status).toBe(200);
      expect((await fetch(newUrl, { method: 'POST' })).status).toBe(401);
      expect((await fetch(newUrl, { method: 'HEAD' })).status).toBe(401);
      active = null;
      expect((await fetch(newUrl)).status).toBe(404);
    } finally {
      server.stop();
    }
  });
});

it.skipIf(!process.env.FEAT007_REAL_ASSET_ROOT)('serves the real authorized asset bytes without changing the source files', async () => {
  const root = process.env.FEAT007_REAL_ASSET_ROOT!;
  const binding = await bindDirectory(root);
  if (typeof binding === 'string') throw new Error(binding);
  const assets = await CourseAssets.load(binding, 'ch01/index.html');
  const server = new StageServer({
    port: 0,
    token: 'test-stage-token',
    packageDir: '.',
    packs: {} as never,
    stage: new Stage(),
    current: () => ({ character: '', template: '' }),
    courseAssets: () => assets,
  });
  await server.start();
  const port = (server as unknown as { server: { address(): { port: number } } }).server.address().port;
  try {
    for (const path of ['ch01/index.html', 'lib/engine.js', 'lib/engine.css', 'lib/volume.css', 'lib/book.css', 'ch01/audio/zh/timings.js', 'ch01/audio/zh/intro.mp3']) {
      const query = path.endsWith('.mp3') ? '?v=1' : '';
      const response = await fetch(`http://127.0.0.1:${port}/course/asset/${assets.capability}/${path}${query}`);
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(await readFile(join(root, path)));
    }
  } finally {
    server.stop();
  }
});
