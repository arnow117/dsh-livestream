import { link, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { WeatherCache } from '../src/body/weatherCache';

const signal = () => new AbortController().signal;
const entry = (url: string, until = 10_000) => ({ url, data: { public: true }, retrievedAt: '2026-11-11T00:00:00Z', validUntil: until });

it('persists public responses with private mode and reloads their original timestamps', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'weather-cache-'));
  const path = join(dir, 'weather-cache-v1.json');
  try {
    const original = entry('https://example.org/one');
    await new WeatherCache(path, () => 1000).put('geo', original, signal());
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await new WeatherCache(path, () => 1000).get('geo', original.url, signal())).toEqual(original);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it.each(['bad json', 'bad version', 'deep object'])('rejects %s without overwriting it', async (kind) => {
  const dir = await mkdtemp(join(tmpdir(), 'weather-cache-invalid-'));
  const path = join(dir, 'weather-cache-v1.json');
  let raw = '{bad';
  if (kind === 'bad version') raw = JSON.stringify({ schemaVersion: 2, geo: [], current: [], forecast: [] });
  if (kind === 'deep object') {
    let value: unknown = 'end';
    for (let i = 0; i < 30; i++) value = { value };
    raw = JSON.stringify({ schemaVersion: 1, geo: [{ ...entry('https://example.org/one'), data: value }], current: [], forecast: [] });
  }
  try {
    await writeFile(path, raw);
    const cache = new WeatherCache(path, () => 1000);
    await expect(cache.get('geo', 'https://example.org/one', signal())).rejects.toThrow('cache_corrupt');
    expect(await readFile(path, 'utf8')).toBe(raw);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it.each(['symlink', 'hardlink', 'same path'])('refuses settings aliases via %s', async (kind) => {
  const dir = await mkdtemp(join(tmpdir(), 'weather-cache-alias-'));
  const settings = join(dir, 'settings.json');
  const cachePath = kind === 'same path' ? settings : join(dir, 'weather-cache-v1.json');
  try {
    await writeFile(settings, '{"important":true}');
    if (kind === 'symlink') await symlink(settings, cachePath);
    if (kind === 'hardlink') await link(settings, cachePath);
    await expect(new WeatherCache(cachePath, () => 1000).get('geo', 'https://example.org/one', signal())).rejects.toThrow('cache_target_invalid');
    expect(await readFile(settings, 'utf8')).toBe('{"important":true}');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('does not evict unexpired source entries to make room', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'weather-cache-full-'));
  try {
    const cache = new WeatherCache(join(dir, 'weather-cache-v1.json'), () => 1000);
    for (let i = 0; i < 16; i++) await cache.put('geo', entry(`https://example.org/${i}`), signal());
    await expect(cache.put('geo', entry('https://example.org/overflow'), signal())).rejects.toThrow('cache_full');
    expect(await cache.get('geo', 'https://example.org/0', signal())).toEqual(entry('https://example.org/0'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
