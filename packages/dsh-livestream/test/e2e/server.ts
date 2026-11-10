import { createServer } from 'node:http';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const port = Number(process.argv[2]);
const dir = await mkdtemp(join(tmpdir(), 'dsh-voice-e2e-'));
process.env.DSH_HOME = dir;
process.env.DSH_LIVESTREAM_LOCAL_REHEARSAL = '1';
process.env.DSH_LIVESTREAM_TTS_BACKEND = 'yovoice';
process.env.DSH_LIVESTREAM_YOVOICE_VOICE = '初始声音';
process.env.YOVOICE_URL = 'http://127.0.0.1:1';
process.env.YOVOICE_API_TOKEN = 'fixture-token';
process.env.DOUBAO_TTS_API_KEY = 'fixture-key';
process.env.DOUBAO_TTS_APP_ID = 'fixture-app';
process.env.DOUBAO_TTS_ACCESS_KEY = 'fixture-access';
const providerCalls: unknown[] = [];
const jobs = new Map<string, string>();
(globalThis as any).__audioCalls = providerCalls;
const originalFetch = globalThis.fetch;
let sharedRequests = 0;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && ['3080', '3081', '7390', '8757'].includes(url.port)) {
    sharedRequests++;
    throw new Error('fixture blocked a shared service request');
  }
  if (url.hostname === '127.0.0.1' && url.port === '1') {
    if (url.pathname.startsWith('/v1/audio/')) return new Response(new Uint8Array([1, 2, 3]));
    const requestId = url.pathname.split('/').at(-1);
    if (init.method === 'PUT') {
      const payload = JSON.parse(String(init.body));
      providerCalls.push({ backend: 'yovoice', ...payload });
      if (failNextProvider) { failNextProvider = false; return new Response(null, { status: 400 }); }
      jobs.set(requestId!, payload.text === '慢速试听' ? 'running' : 'completed');
    }
    if (init.method === 'DELETE') {
      providerCalls.push({ backend: 'cancel', requestId });
      jobs.set(requestId!, 'cancelled');
    }
    return Response.json({ requestId, status: jobs.get(requestId!) ?? 'completed', downloadPath: '/v1/audio/audio123' });
  }
  if (url.hostname === 'openspeech.bytedance.com') {
    providerCalls.push({ backend: 'doubao', ...JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ data: Buffer.from('fixture audio').toString('base64') }));
  }
  return originalFetch(input, init);
};
const host = await import('../../src/dsh/index');
const runtime = await import('../../src/dsh/runtime');
Object.defineProperty(runtime.server, 'url', { get: () => `http://127.0.0.1:${port}/__stage?token=fixture` });
let stageRequests = 0;
let stageEvents = 0;
let failNextProvider = false;
let failNextState = false;
let failNextSave = false;
const unsubscribe = runtime.show.stage.subscribe(() => { stageEvents++; }, false);
stageEvents = 0;
const routes = new Map<string, (request: Request) => Response | Promise<Response>>();
host.apply({
  effect(effect: () => unknown, label?: string) {
    if (['dsh-livestream credentials', 'state', 'settings', 'tts preview'].includes(label ?? '')) effect();
  },
  provide() {},
  connection: { fetch: { register(route: { path: string; fetch: (request: Request) => Response }) { routes.set(route.path, route.fetch); return () => {}; } } },
});
const http = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script src="/client.js"></script></body></html>');
    return;
  }
  if (url.pathname === '/__stage') {
    stageRequests++;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>本地测试舞台</title>');
    return;
  }
  if (url.pathname === '/client.js') {
    res.writeHead(200, { 'content-type': 'application/javascript' });
    res.end(await readFile(new URL('./client.js', import.meta.url)));
    return;
  }
  if (url.pathname === '/__fail-save') {
    await chmod(runtime.dataDir, 0o500);
    failNextSave = true;
    res.writeHead(200); res.end('ok'); return;
  }
  if (url.pathname === '/__fail-state') { failNextState = true; res.writeHead(200); res.end('ok'); return; }
  if (url.pathname === '/__external-save') { runtime.updateSettings({ tts: { ...runtime.settings.tts, yovoiceVoice: '外部更新声音' } }); res.writeHead(200); res.end('ok'); return; }
  if (url.pathname === '/__fail-next') { failNextProvider = true; res.writeHead(200); res.end('ok'); return; }
  if (url.pathname === '/__reset') {
    providerCalls.length = 0;
    sharedRequests = 0;
    jobs.clear();
    failNextProvider = false;
    failNextState = false;
    stageEvents = 0;
    runtime.updateSettings({ tts: { backend: 'yovoice', yovoiceModel: 'voxcpm2-q8', yovoiceVoice: '初始声音', macosVoice: 'Tingting', doubaoVoice: '', doubaoRate: 0 } });
    res.writeHead(200); res.end('ok'); return;
  }
  if (url.pathname === '/__fixture') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ calls: providerCalls, sharedRequests, settings: runtime.settings.tts, stageEvents, stageRequests, stageUrl: runtime.server.url, onAir: runtime.show.isOnAir }));
    return;
  }
  if (url.pathname === '/api/dsh-livestream/state' && failNextState) { failNextState = false; res.writeHead(503); res.end(); return; }
  const handler = routes.get(url.pathname);
  if (!handler) { res.writeHead(404); res.end(); return; }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  try {
    const response = await handler(new Request(url, {
      method: req.method,
      headers: { 'content-type': 'application/json' },
      ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}),
      signal: controller.signal,
    }));
    if (url.pathname === '/api/dsh-livestream/settings' && failNextSave) {
      await chmod(runtime.dataDir, 0o700);
      failNextSave = false;
    }
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    if (failNextSave) { await chmod(runtime.dataDir, 0o700); failNextSave = false; }
    if (!res.destroyed) { res.writeHead(500); res.end(); }
  }
});
http.listen(port, '127.0.0.1');
const shutdown = () => http.close(() => { unsubscribe(); void rm(dir, { recursive: true, force: true }).then(() => process.exit(0)); });
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
