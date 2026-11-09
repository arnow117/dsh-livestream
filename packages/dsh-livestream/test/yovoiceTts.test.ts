import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { YovoiceClient } from '../src/body/yovoiceTts';

function wav(): Uint8Array {
  const samples = 8000;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(samples * 2, 40);
  return bytes;
}

function fakeServer(options: { holdFirst?: boolean; invalidDownload?: boolean; failCancel?: boolean; busy?: boolean } = {}) {
  const calls: Array<{ path: string; method: string; init: RequestInit }> = [];
  const active = new Map<string, string>();
  let firstId = '';
  let releaseFirst = false;
  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const path = new URL(String(input)).pathname;
    const method = init.method ?? 'GET';
    calls.push({ path, method, init });
    if (path.startsWith('/v1/audio/')) return new Response(wav(), { status: 200 });
    const id = path.split('/').at(-1)!;
    if (method === 'PUT') {
      if (options.busy || [...active.values()].includes('running')) return new Response(null, { status: 409 });
      firstId ||= id;
      active.set(id, 'running');
      return Response.json({ requestId: id, status: 'running' });
    }
    if (method === 'DELETE') {
      if (options.failCancel) return new Response(null, { status: 500 });
      active.set(id, 'cancelled');
      return Response.json({ requestId: id, status: 'running' });
    }
    const status = active.get(id);
    if (!status) return new Response(null, { status: 404 });
    if (status === 'cancelled') return Response.json({ requestId: id, status });
    if (options.holdFirst && id === firstId && !releaseFirst) return Response.json({ requestId: id, status: 'running' });
    active.set(id, 'completed');
    return Response.json({ requestId: id, status: 'completed', id: 'audio123', duration: 1, downloadPath: options.invalidDownload ? 'https://evil.example/audio' : '/v1/audio/audio123' });
  });
  return { calls, active, fetch, release: () => { releaseFirst = true; } };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for fake job');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(() => vi.unstubAllGlobals());

describe('yovoice speech adapter', () => {
  it('serializes requests, sends the real job shape, and converts WAV to playable MP3', async () => {
    const server = fakeServer({ holdFirst: true });
    vi.stubGlobal('fetch', server.fetch);
    const client = new YovoiceClient('http://127.0.0.1:3081', 'test-token');
    const first = client.synthesize('第一句', AbortSignal.timeout(10000));
    const second = client.synthesize('第二句', AbortSignal.timeout(10000));
    await waitFor(() => server.calls.some((call) => call.method === 'GET'));
    expect(server.calls.filter((call) => call.method === 'PUT')).toHaveLength(1);
    server.release();
    const [speech] = await Promise.all([first, second]);
    const puts = server.calls.filter((call) => call.method === 'PUT');
    expect(puts).toHaveLength(2);
    expect(puts[0].path).toMatch(/^\/v1\/jobs\/[0-9a-f]{32}$/);
    expect(JSON.parse(String(puts[0].init.body))).toEqual({ text: '第一句', modelId: 'voxcpm2-q8', voxMode: 'design', voiceDescription: expect.any(String), seed: 42 });
    expect(puts[0].init.redirect).toBe('error');
    expect(speech.words).toHaveLength(3);
    const dir = await mkdtemp(join(tmpdir(), 'dsh-yovoice-test-'));
    try {
      const file = join(dir, 'speech.mp3');
      await writeFile(file, speech.audio);
      expect(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8' }).trim()).toBe('mp3');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 15000);

  it('cancels its active job, confirms terminal status, then runs the next job', async () => {
    const server = fakeServer({ holdFirst: true });
    vi.stubGlobal('fetch', server.fetch);
    const client = new YovoiceClient('http://127.0.0.1:3081', 'test-token');
    const controller = new AbortController();
    const first = client.synthesize('取消', controller.signal);
    const result = first.catch((error: unknown) => error);
    const second = client.synthesize('下一句', AbortSignal.timeout(10000));
    await waitFor(() => server.calls.some((call) => call.method === 'GET'));
    controller.abort();
    expect(await result).toBeDefined();
    await second;
    const deletion = server.calls.findIndex((call) => call.method === 'DELETE');
    const secondPut = server.calls.findIndex((call, index) => call.method === 'PUT' && index > 0);
    expect(deletion).toBeGreaterThan(0);
    expect(server.calls.slice(deletion + 1, secondPut).some((call) => call.method === 'GET')).toBe(true);
    expect([...server.active.values()]).toEqual(['cancelled', 'completed']);
  }, 15000);

  it('removes a cancelled queued request without submitting it', async () => {
    const server = fakeServer({ holdFirst: true });
    vi.stubGlobal('fetch', server.fetch);
    const client = new YovoiceClient('http://127.0.0.1:3081', 'test-token');
    const first = client.synthesize('第一句', AbortSignal.timeout(10000));
    const controller = new AbortController();
    const queued = client.synthesize('不要提交', controller.signal);
    controller.abort();
    await expect(queued).rejects.toThrow();
    server.release();
    await first;
    expect(server.calls.filter((call) => call.method === 'PUT')).toHaveLength(1);
  }, 15000);

  it('rejects foreign download paths, busy responses, and missing config without leaking tokens', async () => {
    expect(() => new YovoiceClient('', '')).toThrow(/YOVOICE_URL/);
    const server = fakeServer({ invalidDownload: true });
    vi.stubGlobal('fetch', server.fetch);
    const client = new YovoiceClient('http://127.0.0.1:3081', 'test-token');
    await expect(client.synthesize('测试', AbortSignal.timeout(5000))).rejects.toThrow(/下载地址无效/);
    expect(server.calls.some((call) => call.path.startsWith('/v1/audio/'))).toBe(false);
    const busy = fakeServer({ busy: true });
    vi.stubGlobal('fetch', busy.fetch);
    await expect(new YovoiceClient('http://127.0.0.1:3081', 'test-token').synthesize('测试', AbortSignal.timeout(5000))).rejects.toThrow('HTTP 409');
    expect(busy.calls.some((call) => call.method === 'DELETE')).toBe(false);
  });

  it('blocks subsequent jobs when cancellation cannot be confirmed', async () => {
    const server = fakeServer({ holdFirst: true, failCancel: true });
    vi.stubGlobal('fetch', server.fetch);
    const client = new YovoiceClient('http://127.0.0.1:3081', 'test-token');
    const controller = new AbortController();
    const first = client.synthesize('测试', controller.signal).catch((error: unknown) => error);
    await waitFor(() => server.calls.some((call) => call.method === 'GET'));
    controller.abort();
    await first;
    await expect(client.synthesize('下一句', AbortSignal.timeout(5000))).rejects.toThrow(/终态无法确认/);
    expect(server.calls.filter((call) => call.method === 'PUT')).toHaveLength(1);
  });

  it('cancels a prepared job when its playback is cancelled', async () => {
    const server = fakeServer({ holdFirst: true });
    vi.stubGlobal('fetch', server.fetch);
    const previous = { ...process.env };
    const dir = await mkdtemp(join(tmpdir(), 'dsh-yovoice-runtime-'));
    process.env.DSH_HOME = dir;
    process.env.DSH_LIVESTREAM_TTS_BACKEND = 'yovoice';
    process.env.YOVOICE_URL = 'http://127.0.0.1:3081';
    process.env.YOVOICE_API_TOKEN = 'test-token';
    try {
      const runtime = await import('../src/dsh/runtime');
      const hook = (runtime.show as unknown as { hooks: { synthesize: (text: string, signal: AbortSignal) => Promise<unknown> } }).hooks;
      runtime.prepareSpeech('预备台词');
      await waitFor(() => server.calls.some((call) => call.method === 'GET'));
      const controller = new AbortController();
      const playback = hook.synthesize('预备台词', controller.signal);
      controller.abort();
      await expect(playback).rejects.toThrow();
      expect([...server.active.values()]).toEqual(['cancelled']);
      await hook.synthesize('下一句', AbortSignal.timeout(10000));
      expect([...server.active.values()]).toEqual(['cancelled', 'completed']);
    } finally {
      process.env = previous;
      await rm(dir, { recursive: true, force: true });
    }
  }, 15000);
});
