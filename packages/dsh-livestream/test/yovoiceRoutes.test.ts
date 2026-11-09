import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

function wav(): Uint8Array {
  const bytes = Buffer.alloc(44 + 16000);
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
  bytes.writeUInt32LE(16000, 40);
  return bytes;
}

describe('yovoice draft and saved speech', () => {
  let dir: string;
  let runtime: typeof import('../src/dsh/runtime');
  let routes: Map<string, (request: Request) => Response | Promise<Response>>;
  const previous = { ...process.env };
  const requests: Array<Record<string, unknown>> = [];
  const statuses = new Map<string, string>();
  let hold = false;
  let cancellations = 0;
  const post = (path: string, data: unknown) => routes.get(`/api/dsh-livestream/${path}`)!(new Request('http://localhost/', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data),
  }));
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-voice-yovoice-'));
    process.env.DSH_HOME = dir;
    process.env.DSH_LIVESTREAM_TTS_BACKEND = 'yovoice';
    process.env.DSH_LIVESTREAM_YOVOICE_VOICE = '原来的声音';
    process.env.YOVOICE_URL = 'http://127.0.0.1:9999';
    process.env.YOVOICE_API_TOKEN = 'test-token';
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const path = new URL(String(input)).pathname;
      if (path.startsWith('/v1/audio/')) return new Response(wav());
      const id = path.split('/').at(-1)!;
      if (init.method === 'PUT') {
        requests.push(JSON.parse(String(init.body)));
        statuses.set(id, hold ? 'running' : 'completed');
      }
      if (init.method === 'DELETE') {
        cancellations++;
        statuses.set(id, 'cancelled');
      }
      const status = statuses.get(id) === 'running' && !hold ? 'completed' : statuses.get(id);
      return Response.json({ requestId: id, status, downloadPath: '/v1/audio/audio123' });
    }));
    const host = await import('../src/dsh/index');
    runtime = await import('../src/dsh/runtime');
    routes = new Map();
    host.apply({
      effect(effect: () => unknown, label?: string) {
        if (['state', 'settings', 'tts preview'].includes(label ?? '')) effect();
      },
      provide() {},
      connection: { fetch: { register(route: { path: string; fetch: (request: Request) => Response }) { routes.set(route.path, route.fetch); return () => {}; } } },
    });
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    process.env = previous;
    await rm(dir, { recursive: true, force: true });
  });
  it('uses draft for private preview, then saved description for the next speech', async () => {
    const before = await readFile(join(dir, 'dsh-livestream/settings.json'), 'utf8');
    const events: unknown[] = [];
    const unsubscribe = runtime.show.stage.subscribe((event) => events.push(event), false);
    events.length = 0;
    const response = await post('tts/preview', { text: '你好', tts: { yovoiceVoice: '新的声音' } });
    expect(response.status).toBe(200);
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
    expect(requests[0]).toMatchObject({ voiceDescription: '新的声音', modelId: 'voxcpm2-q8' });
    expect(runtime.settings.tts.yovoiceVoice).toBe('原来的声音');
    expect(await readFile(join(dir, 'dsh-livestream/settings.json'), 'utf8')).toBe(before);
    expect(events).toEqual([]);
    unsubscribe();
    expect((await post('settings', { tts: { yovoiceVoice: '新的声音' } })).status).toBe(200);
    await runtime.speech('下一句话', AbortSignal.timeout(10000));
    expect(requests[1]).toMatchObject({ voiceDescription: '新的声音', modelId: 'voxcpm2-q8' });
  }, 15000);
  it('cancels unconsumed prepared audio but leaves consumed audio on its original snapshot', async () => {
    const waitFor = async (predicate: () => boolean) => {
      const deadline = Date.now() + 3000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error('fixture did not receive the job');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    hold = true;
    const start = requests.length;
    runtime.prepareSpeech('未消费');
    await waitFor(() => requests.length === start + 1);
    runtime.updateSettings({ tts: { ...runtime.settings.tts, yovoiceVoice: '再次修改' } });
    await waitFor(() => cancellations === 1);
    hold = false;
    await runtime.speech('下一句', AbortSignal.timeout(10000));
    expect(requests.at(-1)).toMatchObject({ voiceDescription: '再次修改' });

    hold = true;
    const beforeConsumed = requests.length;
    runtime.prepareSpeech('已消费');
    await waitFor(() => requests.length === beforeConsumed + 1);
    const hook = (runtime.show as unknown as { hooks: { synthesize: (text: string, signal: AbortSignal) => Promise<unknown> } }).hooks;
    const consumed = hook.synthesize('已消费', AbortSignal.timeout(10000));
    runtime.updateSettings({ tts: { ...runtime.settings.tts, yovoiceVoice: '最终声音' } });
    hold = false;
    await consumed;
    expect(cancellations).toBe(1);
    expect(requests[beforeConsumed]).toMatchObject({ voiceDescription: '再次修改' });
    await runtime.speech('最终句', AbortSignal.timeout(10000));
    expect(requests.at(-1)).toMatchObject({ voiceDescription: '最终声音' });
  }, 15000);

});
