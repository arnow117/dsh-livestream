import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

export type WeatherCacheKind = 'geo' | 'current' | 'forecast';
export interface WeatherCacheEntry {
  url: string;
  data: unknown;
  retrievedAt: string;
  validUntil: number;
  lastModified?: string;
}

type CacheData = { schemaVersion: 1; geo: WeatherCacheEntry[]; current: WeatherCacheEntry[]; forecast: WeatherCacheEntry[] };
const LIMITS: Record<WeatherCacheKind, number> = { geo: 16, current: 8, forecast: 8 };
const MAX_FILE_BYTES = 4 * 1024 * 1024;

function boundedJson(value: unknown): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const item = stack.pop()!;
    if (++nodes > 250_000 || item.depth > 20) return false;
    if (!item.value || typeof item.value !== 'object') continue;
    for (const child of Object.values(item.value)) stack.push({ value: child, depth: item.depth + 1 });
  }
  return true;
}

function validEntry(entry: any): entry is WeatherCacheEntry {
  return !!entry && typeof entry === 'object' && !Array.isArray(entry)
    && typeof entry.url === 'string' && entry.url.length <= 4096
    && typeof entry.retrievedAt === 'string' && Number.isFinite(Date.parse(entry.retrievedAt))
    && typeof entry.validUntil === 'number' && Number.isFinite(entry.validUntil)
    && (entry.lastModified === undefined || (typeof entry.lastModified === 'string' && entry.lastModified.length <= 200))
    && entry.data !== undefined && boundedJson(entry.data)
    && Buffer.byteLength(JSON.stringify(entry.data)) <= 1024 * 1024;
}

/** Single-process cache of public source responses. It never stores participants or credentials. */
export class WeatherCache {
  private data: CacheData = { schemaVersion: 1, geo: [], current: [], forecast: [] };
  private loaded = false;
  private lastGeoRequest = 0;

  constructor(private readonly file: string, private readonly now: () => number) {}

  private async assertTarget(): Promise<void> {
    const target = resolve(this.file);
    const settings = join(dirname(target), 'settings.json');
    if (target === settings) throw new Error('cache_target_invalid');
    const targetStat = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (targetStat && (!targetStat.isFile() || targetStat.isSymbolicLink())) throw new Error('cache_target_invalid');
    const settingsStat = await lstat(settings).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (targetStat && settingsStat && targetStat.dev === settingsStat.dev && targetStat.ino === settingsStat.ino) {
      throw new Error('cache_target_invalid');
    }
  }

  async load(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.loaded) return;
    await this.assertTarget();
    signal.throwIfAborted();
    let file;
    try {
      file = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.loaded = true; return; }
      throw new Error('cache_read_failed');
    }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('cache_corrupt');
      const bytes = await file.readFile();
      signal.throwIfAborted();
      if (bytes.length > MAX_FILE_BYTES) throw new Error('cache_corrupt');
      const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!parsed || parsed.schemaVersion !== 1 || !boundedJson(parsed)) throw new Error('cache_corrupt');
      for (const kind of ['geo', 'current', 'forecast'] as const) {
        if (!Array.isArray(parsed[kind]) || parsed[kind].length > LIMITS[kind] || !parsed[kind].every(validEntry)) throw new Error('cache_corrupt');
        if (new Set(parsed[kind].map((entry: WeatherCacheEntry) => entry.url)).size !== parsed[kind].length) throw new Error('cache_corrupt');
      }
      this.data = parsed;
      this.loaded = true;
    } catch (error) {
      if (signal.aborted) throw error;
      throw new Error('cache_corrupt');
    } finally {
      await file.close();
    }
  }

  async get(kind: WeatherCacheKind, url: string, signal: AbortSignal): Promise<WeatherCacheEntry | undefined> {
    await this.load(signal);
    signal.throwIfAborted();
    return this.data[kind].find((entry) => entry.url === url);
  }

  async ensureCapacity(kind: WeatherCacheKind, url: string, signal: AbortSignal): Promise<void> {
    await this.load(signal);
    signal.throwIfAborted();
    const entries = this.data[kind].filter((entry) => entry.url !== url && entry.validUntil > this.now());
    if (entries.length >= LIMITS[kind]) throw new Error('cache_full');
    const remaining = { ...this.data, [kind]: entries };
    const maximumEntryBytes = 1024 * 1024 + 8192;
    if (Buffer.byteLength(JSON.stringify(remaining)) + maximumEntryBytes > MAX_FILE_BYTES) throw new Error('cache_full');
  }

  async waitForGeo(signal: AbortSignal): Promise<void> {
    const delay = Math.max(0, this.lastGeoRequest + 1000 - this.now());
    if (delay) await new Promise<void>((resolveDelay, reject) => {
      const timer = setTimeout(done, delay);
      function done() { signal.removeEventListener('abort', aborted); resolveDelay(); }
      function aborted() { clearTimeout(timer); reject(signal.reason); }
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) aborted();
    });
    signal.throwIfAborted();
    this.lastGeoRequest = this.now();
  }

  async put(kind: WeatherCacheKind, entry: WeatherCacheEntry, signal: AbortSignal): Promise<void> {
    await this.load(signal);
    signal.throwIfAborted();
    if (!validEntry(entry)) throw new Error('cache_invalid_entry');
    const entries = this.data[kind].filter((old) => old.url !== entry.url && old.validUntil > this.now());
    if (entries.length >= LIMITS[kind]) throw new Error('cache_full');
    const next: CacheData = { ...this.data, [kind]: [...entries, entry] };
    const bytes = Buffer.from(JSON.stringify(next));
    if (bytes.length > MAX_FILE_BYTES) throw new Error('cache_full');
    const temp = join(dirname(this.file), `.weather-cache-${randomBytes(16).toString('hex')}.tmp`);
    try {
      await mkdir(dirname(this.file), { recursive: true });
      await this.assertTarget();
      signal.throwIfAborted();
      const file = await open(temp, 'wx', 0o600);
      try { await file.writeFile(bytes); } finally { await file.close(); }
      signal.throwIfAborted();
      await this.assertTarget();
      signal.throwIfAborted();
      await rename(temp, this.file);
      if (!signal.aborted) this.data = next;
    } catch (error) {
      // Keep successful public data after a write failure, but never commit a cancelled result in memory.
      if (!signal.aborted) this.data = next;
      throw error;
    } finally {
      await rm(temp, { force: true });
    }
  }
}
