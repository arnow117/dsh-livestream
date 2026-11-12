import { randomBytes } from 'node:crypto';
import { lstat, opendir, realpath } from 'node:fs/promises';
import { extname, join, parse, sep } from 'node:path';
import { readBoundedFile, type DirectoryBinding } from '../../dsh/sessionContextPaths';

const MAX_FILES = 128;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_DIRECTORIES = 128;
const ALLOWED_EXTENSIONS = new Set(['.html', '.js', '.css', '.mp3', '.png', '.jpg', '.jpeg', '.svg', '.woff2', '.json']);

interface Identity {
  path: string;
  dev: number;
  ino: number;
  file?: { size: number; mtimeMs: number; ctimeMs: number };
}

interface ManifestEntry {
  hash: string;
  size: number;
  identities: Identity[];
}

function validRelativePath(path: string): boolean {
  if (!path || path.length > 4096 || path.includes('%') || path.includes('\\')) return false;
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && !/[\x00-\x1f\x7f]/.test(part));
}

/** Capture every ancestor, including those above the granted root. */
async function identities(path: string): Promise<Identity[]> {
  const root = parse(path).root;
  const parts = path.slice(root.length).split(sep).filter(Boolean);
  const result: Identity[] = [];
  let current = root;
  for (const part of ['', ...parts]) {
    if (part) current = join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new Error('asset identity changed');
    result.push({
      path: current, dev: stat.dev, ino: stat.ino,
      ...(stat.isFile() ? { file: { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs } } : {}),
    });
  }
  return result;
}

async function identitiesMatch(expected: Identity[]): Promise<boolean> {
  try {
    for (const item of expected) {
      const stat = await lstat(item.path);
      if (stat.isSymbolicLink() || stat.dev !== item.dev || stat.ino !== item.ino) return false;
      if (item.file && (!stat.isFile() || stat.size !== item.file.size || stat.mtimeMs !== item.file.mtimeMs || stat.ctimeMs !== item.file.ctimeMs)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** An in-memory, revocable authorization for a single frozen asset manifest. */
export class CourseAssets {
  readonly capability = randomBytes(24).toString('base64url');
  private revoked = false;

  private constructor(
    private readonly root: DirectoryBinding,
    private readonly entries: Map<string, ManifestEntry>,
    readonly entryPath: string,
    private readonly hooks: { afterRead?: () => Promise<void> | void },
  ) {}

  static async load(root: DirectoryBinding, entryPath: string, hooks: { afterRead?: () => Promise<void> | void } = {}): Promise<CourseAssets> {
    if (!validRelativePath(entryPath) || extname(entryPath).toLowerCase() !== '.html') throw new Error('invalid course entry');
    if (await realpath(root.path) !== root.path) throw new Error('asset root changed');
    const rootStat = await lstat(root.path);
    if (!rootStat.isDirectory() || rootStat.dev !== root.dev || rootStat.ino !== root.ino) throw new Error('asset root changed');
    const rootIdentities = await identities(root.path);
    const entries = new Map<string, ManifestEntry>();
    let total = 0;
    let directoryCount = 0;

    async function scan(relativeDirectory: string): Promise<void> {
      const directory = relativeDirectory ? join(root.path, relativeDirectory) : root.path;
      if (++directoryCount > MAX_DIRECTORIES) throw new Error('asset directory limit exceeded');
      const handle = await opendir(directory);
      for await (const entry of handle) {
        const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
        if (!validRelativePath(relative) || entry.isSymbolicLink()) throw new Error('invalid asset path');
        if (entry.isDirectory()) {
          await scan(relative);
          continue;
        }
        if (!entry.isFile() || entries.size >= MAX_FILES) throw new Error('asset limit exceeded');
        const read = await readBoundedFile({ root, relativePath: relative, maxBytes: MAX_FILE_BYTES });
        if (!read.ok) throw new Error('asset read failed');
        total += read.bytes.byteLength;
        if (total > MAX_TOTAL_BYTES) throw new Error('asset limit exceeded');
        const pathIdentities = await identities(join(root.path, relative));
        if (!await identitiesMatch(rootIdentities)) throw new Error('asset root changed');
        entries.set(relative, { hash: read.sha256, size: read.bytes.byteLength, identities: pathIdentities });
      }
    }

    await scan('');
    if (!entries.has(entryPath) || !await identitiesMatch(rootIdentities)) throw new Error('course entry unavailable');
    return new CourseAssets(root, entries, entryPath, hooks);
  }

  async read(relativePath: string): Promise<Buffer | null> {
    if (this.revoked || !validRelativePath(relativePath) || !ALLOWED_EXTENSIONS.has(extname(relativePath).toLowerCase())) return null;
    const entry = this.entries.get(relativePath);
    if (!entry || !await identitiesMatch(entry.identities)) return null;
    const result = await readBoundedFile({ root: this.root, relativePath, maxBytes: MAX_FILE_BYTES, afterRead: this.hooks.afterRead });
    if (!result.ok || result.sha256 !== entry.hash || result.bytes.byteLength !== entry.size) return null;
    if (!await identitiesMatch(entry.identities) || this.revoked) return null;
    return Buffer.from(result.bytes);
  }

  revoke(): void {
    this.revoked = true;
  }

  get active(): boolean {
    return !this.revoked;
  }
}
