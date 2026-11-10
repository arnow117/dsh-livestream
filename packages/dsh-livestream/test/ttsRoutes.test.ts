import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

describe('voice settings and preview routes', () => {
  let dir: string;
  let runtime: typeof import('../src/dsh/runtime');
  let routes: Map<string, (request: Request) => Response | Promise<Response>>;
  const previous = { ...process.env };
  let host: typeof import('../src/dsh/index');
  let oldDispose: () => void;
  const fetchProvider = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body));
    expect(payload.req_params.speaker).toBe('zh_female_mengyatou_uranus_bigtts');
    expect(payload.req_params.audio_params.speech_rate).toBe(12);
    expect(new Headers(init?.headers).get('X-Api-Key')).toBe('test-key');
    return new Response(JSON.stringify({ data: Buffer.from('audio').toString('base64') }));
  });
  const post = (path: string, data: unknown) => routes.get(`/api/dsh-livestream/${path}`)!(new Request('http://localhost/', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data),
  }));

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-voice-routes-'));
    process.env.DSH_HOME = dir;
    process.env.DSH_LIVESTREAM_TTS_BACKEND = 'doubao';
    delete process.env.DOUBAO_TTS_API_KEY;
    host = await import('../src/dsh/index');
    runtime = await import('../src/dsh/runtime');
    routes = new Map();
    host.apply({
      effect(effect: () => unknown, label?: string) {
        if (['dsh-livestream credentials', 'state', 'settings', 'tts preview'].includes(label ?? '')) {
          const dispose = effect();
          if (label === 'dsh-livestream credentials') oldDispose = dispose as () => void;
        }
      },
      provide() {},
      get(name: string) {
        return name === 'credentials' ? { resolve: async () => ({ value: 'test-key' }), set: vi.fn() } : undefined;
      },
      connection: { fetch: { register(route: { path: string; fetch: (request: Request) => Response }) { routes.set(route.path, route.fetch); return () => {}; } } },
    });
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    process.env = previous;
    await rm(dir, { recursive: true, force: true });
  });

  it('persists query settings atomically and rejects invalid changes', async () => {
    expect(runtime.settings.readOnlyQueries).toEqual({ weather: false, publicSearch: false });
    expect((await post('settings', { readOnlyQueries: { weather: true } })).status).toBe(200);
    expect(runtime.settings.readOnlyQueries).toEqual({ weather: true, publicSearch: false });
    const before = await readFile(join(dir, 'dsh-livestream/settings.json'), 'utf8');
    expect((await post('settings', { readOnlyQueries: { publicSearch: 'true' } })).status).toBe(400);
    expect(await readFile(join(dir, 'dsh-livestream/settings.json'), 'utf8')).toBe(before);
    expect(runtime.settings.readOnlyQueries).toEqual({ weather: true, publicSearch: false });
  });

  it('previews a draft with root credentials and saves only on request', async () => {
    vi.stubGlobal('fetch', fetchProvider);
    const before = await readFile(join(dir, 'dsh-livestream/settings.json'), 'utf8');
    const events: unknown[] = [];
    const unsubscribe = runtime.show.stage.subscribe((event) => events.push(event), false);
    events.length = 0;
    const response = await post('tts/preview', { text: '你好', tts: { doubaoRate: 12 } });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/mpeg');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('audio');
    expect(await readFile(join(dir, 'dsh-livestream/settings.json'), 'utf8')).toBe(before);
    expect(runtime.settings.tts.doubaoRate).toBe(0);
    expect(events).toEqual([]);
    unsubscribe();
    const saved = await post('settings', { tts: { doubaoRate: 12 } });
    expect(saved.status).toBe(200);
    expect((await saved.json()).settings.tts.doubaoRate).toBe(12);
    expect(JSON.parse(await readFile(join(dir, 'dsh-livestream/settings.json'), 'utf8')).tts.doubaoRate).toBe(12);
  });

  it('rejects invalid and conflicting patches without changing settings', async () => {
    const before = await readFile(join(dir, 'dsh-livestream/settings.json'), 'utf8');
    for (const patch of [{ tts: { unknown: 'x' } }, { tts: { doubaoRate: '12' } }, { voice: 'one', tts: { doubaoVoice: 'two' } }]) {
      expect((await post('settings', patch)).status).toBe(400);
    }
    expect(await readFile(join(dir, 'dsh-livestream/settings.json'), 'utf8')).toBe(before);
    expect(runtime.settings.tts.doubaoRate).toBe(12);
  });
  it('reports provider errors without exposing details or falling back', async () => {
    const provider = vi.fn(async () => { throw new Error('secret test-key /internal/path'); });
    vi.stubGlobal('fetch', provider);
    const response = await post('tts/preview', { text: '你好' });
    expect(response.status).toBe(502);
    expect(await response.text()).not.toMatch(/test-key|internal/);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('validates preview input, supports the legacy alias, and preserves a newer credentials binding', async () => {
    for (const data of [null, { text: '' }, { text: 'x'.repeat(201) }, { text: '\ud800' }, { text: 'ok', tts: { doubaoRate: 'bad' } }, { text: 'ok', tts: null }]) {
      expect((await post('tts/preview', data)).status).toBe(400);
    }
    const unavailable = await post('tts/preview', { text: 'ok', tts: { backend: 'yovoice' } });
    expect(unavailable.status).toBe(503);
    expect((await post('settings', { voice: 'legacy-id', tts: { doubaoRate: 3 } })).status).toBe(200);
    expect(runtime.settings.tts).toMatchObject({ doubaoVoice: 'legacy-id', doubaoRate: 3 });
    let newDispose: () => void = () => {};
    host.apply({
      effect(effect: () => unknown, label?: string) {
        if (label === 'dsh-livestream credentials') newDispose = effect() as () => void;
      },
      provide() {},
      get: () => ({ resolve: async () => ({ value: 'new-key' }), set: vi.fn() }),
    });
    oldDispose();
    expect(await runtime.hooks.secret('DSH_VOICE_TEST_MISSING_SECRET')).toBe('new-key');
    newDispose();
    expect(await runtime.hooks.secret('DSH_VOICE_TEST_MISSING_SECRET')).toBe('');
  });

});
