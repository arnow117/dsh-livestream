import { createServer, get } from 'node:http';
import { mkdtemp, readFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';

const port = Number(process.argv[2]);
const dir = await mkdtemp(join(tmpdir(), 'dsh-query-web-'));
process.env.DSH_HOME = dir;
process.env.DSH_LIVESTREAM_LOCAL_REHEARSAL = '1';
process.env.QUERY_FIXTURE_MODEL_KEY = 'fake-model';
delete process.env.GLM_CODING_PLAN_API_KEY;
let credential = '';
let mode = 'normal';
let selectedPreset = '';
let sessionCount = 0;
let sharedRequests = 0;
let externalRequests = 0;
let stagePort = 0;
let room = '';
let subscriptions = 0;
const bridge = createServer(async (request, response) => {
  response.setHeader('content-type', 'application/json');
  if (request.url === '/api/stats') return response.end(JSON.stringify({ uptimeSec: 1 }));
  if (request.url === '/api/accounts') return response.end(JSON.stringify({ accounts: [{ id: 'fixture-anonymous', name: 'dsh-livestream-anonymous-fixture', hasCookie: false, hasLogin: false }] }));
  if (request.url === '/api/rooms/connect' && request.method === 'POST') {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    room = JSON.parse(Buffer.concat(chunks).toString()).roomId;
    return response.end(JSON.stringify({ ok: true, room: { roomId: room, status: 'connecting', startedAt: Date.now() } }));
  }
  const requestedRoom = request.url?.match(/^\/api\/rooms\/(\d+)$/)?.[1];
  if (requestedRoom && !room) { response.statusCode = 404; return response.end('{}'); }
  return response.end(JSON.stringify({ room: { roomId: requestedRoom ?? room, status: 'live' } }));
});
const sockets = new WebSocketServer({ server: bridge });
sockets.on('connection', (socket, request) => {
  subscriptions++;
  const roomId = new URL(request.url ?? '/', 'http://localhost').searchParams.get('roomId');
  socket.send(JSON.stringify({ type: '__connected', roomId, room: { roomId, status: 'connecting' } }));
  socket.send(JSON.stringify({ id: 'fixture-live', type: 'roomStatus', platform: 'douyin', roomId, ts: Date.now(), data: { status: 'live' } }));
});
await new Promise<void>((resolve) => bridge.listen(0, '127.0.0.1', resolve));
const bridgePort = (bridge.address() as { port: number }).port;
if ([3080, 3081, 7390, 8757].includes(bridgePort)) throw new Error('shared bridge port selected');
process.env.DSH_LIVESTREAM_DOUYIN_BRIDGE_URL = `http://127.0.0.1:${bridgePort}`;
let releaseMcp: (() => void) | undefined;
let releaseTts: (() => void) | undefined;
let ttsPending = false;
let currentAgent: any;
const modelRequests: any[] = [];
const mcpRequests: any[] = [];
const stageEvents: any[] = [];
const observedEvents: any[] = [];
const model = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const request = JSON.parse(Buffer.concat(chunks).toString());
    modelRequests.push(request);
    const last = request.messages.at(-1);
    const blocks = Array.isArray(last?.content) ? last.content : [];
    const toolResult = blocks.find((block: any) => block.type === 'tool_result');
    const content = typeof last?.content === 'string' ? last.content : blocks.filter((block: any) => block.type === 'text').map((block: any) => block.text).join(' ');
    const ownerText = /<主人>([\s\S]*?)<\/主人>/.exec(content)?.[1] ?? '';
    const tool = /天气/.test(ownerText) ? { name: 'weather_lookup', input: { location: '北京' } }
      : /许可证/.test(ownerText) ? { name: 'public_search', input: { query: 'OBS Studio 许可证' } } : null;
    const resultText = typeof toolResult?.content === 'string' ? toolResult.content : JSON.stringify(toolResult?.content ?? '');
    const answer = resultText.includes('public_search') && resultText.includes('\"status\":\"evidence\"')
      ? 'OBS Studio 使用 GPL 第二版或以后版本，来源是 OBS 官方仓库。'
      : resultText.includes('weather') && resultText.includes('"status":"evidence"')
        ? '测试资料显示北京观测气温为 20℃，请核对来源时间。'
        : '资料来源不足，暂时无法确认。';
    const frames: Array<Record<string, unknown>> = [
      { type: 'message_start', message: { id: `msg_${modelRequests.length}`, type: 'message', role: 'assistant', model: 'model', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } },
    ];
    if (tool && !toolResult) {
      frames.push(
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `call_${modelRequests.length}`, name: tool.name, input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } },
      );
    } else {
      frames.push(
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: toolResult ? answer : '大家好。' } },
      );
    }
    frames.push(
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: tool && !toolResult ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    );
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const frame of frames) res.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
    res.end();
  });
});
await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
const modelPort = (model.address() as { port: number }).port;
if ([3080, 3081, 7390, 8757].includes(modelPort)) throw new Error('shared port selected');
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && ['3080', '3081', '7390', '8757'].includes(url.port)) {
    sharedRequests++;
    throw new Error('shared service request blocked');
  }
  if (url.href !== 'https://open.bigmodel.cn/api/mcp/web_search_prime/mcp') {
    if (url.hostname === '127.0.0.1' && [port, modelPort, stagePort, bridgePort].includes(Number(url.port))) return originalFetch(input, init);
    externalRequests++;
    throw new Error('unexpected external request blocked');
  }
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
  mcpRequests.push(body);
  if (body?.id === undefined) return new Response(null, { status: 202 });
  const schema = { type: 'object', properties: Object.fromEntries(['search_query', 'search_domain_filter', 'search_recency_filter', 'content_size', 'location'].map((key) => [key, { type: 'string' }])), required: ['search_query'], additionalProperties: false };
  const rows = mode === 'empty' ? [] : body.params?.arguments?.search_domain_filter
    ? [{
      title: '北京天气',
      link: 'https://weather.com.cn/beijing',
      content: mode === 'weather-evidence'
        ? `北京当前天气实况：${new Date().toISOString().slice(0, 10)} 00:00 UTC+00:00 气温 20℃`
        : '北京天气资料，无观测时间',
    }]
    : [{ title: 'OBS Studio', link: 'https://github.com/obsproject/obs-studio', content: 'OBS Studio is licensed under GPL version 2 or later.' }];
  if (mode === 'hold' && body.method === 'tools/call') await new Promise<void>((resolve) => { releaseMcp = resolve; });
  const result = body.method === 'initialize'
    ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
    : body.method === 'tools/list' ? { tools: [{ name: 'web_search_prime', inputSchema: schema }] }
      : mode === 'failed' ? { isError: true, content: [{ type: 'text', text: 'fixture failure' }] }
        : { content: [{ type: 'text', text: JSON.stringify(JSON.stringify(rows)) }] };
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { headers: { 'content-type': 'application/json' } });
};

const ctx = new Context();
await ctx.plugin(LlmRuntime);
await ctx.plugin(LlmPiAi, { providers: { fixture: { api: 'anthropic-messages', baseURL: `http://127.0.0.1:${modelPort}`, apiKeyEnv: 'QUERY_FIXTURE_MODEL_KEY', cacheRetention: 'none', models: [{ id: 'model' }] } } });
await ctx.plugin(SessionStore);
await ctx.plugin(SessionProjectionRegistry);
await ctx.plugin(SystemPrompt, { personaPrefix: '' });
await ctx.plugin(ToolRuntime);
await ctx.plugin({ inject: ['tools'], apply(owner: Context) { owner.tools.setExecutor(new NativeToolExecutor.NativeToolExecutor(owner, () => 1)); } });
await ctx.plugin(AgentRegistry);
await ctx.plugin(AgentLoop, { agents: [] });
const host = await import('../../src/dsh/index');
const runtime = await import('../../src/dsh/runtime');
const plugin = await import('../../src/dsh/agent');
const { StageServer } = await import('../../src/body/server');
await ctx.plugin(plugin);
(runtime.show as any).hooks.synthesize = async () => {
  if (mode === 'hold-tts') {
    ttsPending = true;
    await new Promise<void>((resolve) => { releaseTts = resolve; });
    ttsPending = false;
  }
  return { audio: new Uint8Array([1]), timeline: [] };
};
const speechPromises: Promise<string>[] = [];
const originalSay = runtime.show.say.bind(runtime.show);
runtime.show.say = (...args) => {
  const result = originalSay(...args);
  speechPromises.push(result);
  return result;
};
let stage = new StageServer({ port: 0, token: 'fixture', packageDir: '.e2e/feat-004-build-fixture', packs: runtime.packs, stage: runtime.show.stage, current: () => ({ character: runtime.settings.character, template: runtime.settings.template }) });
await stage.start();
stagePort = (stage as any).server.address().port;
if ([3080, 3081, 7390, 8757].includes(stagePort)) throw new Error('shared stage port selected');
Object.defineProperty(runtime.server, 'url', { get: () => `http://127.0.0.1:${stagePort}/?token=fixture` });
const stopObserved = runtime.show.stage.subscribe((event) => observedEvents.push(event), false);
const outputConnection = get(`http://127.0.0.1:${stagePort}/events?token=fixture&outputProtocol=owned-live-v1`);
await new Promise<void>((resolve, reject) => {
  outputConnection.on('error', reject);
  outputConnection.on('response', (response) => {
    let buffer = '';
    response.on('data', (chunk) => {
      buffer += String(chunk);
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() ?? '';
      for (const block of blocks) {
        if (!block.startsWith('data: ')) continue;
        const event = JSON.parse(block.slice(6));
        stageEvents.push(event);
        if (event.type === 'hello') resolve();
        if (event.type === 'say') void originalFetch(`http://127.0.0.1:${stagePort}/said?id=${encodeURIComponent(event.id)}&token=fixture`, { method: 'POST' }).catch(() => {});
      }
    });
  });
});
const routes = new Map<string, (request: Request) => Response | Promise<Response>>();
const credentials = { resolve: async () => credential ? { value: credential } : undefined, set: async (_name: string, value: string) => { credential = value; } };
host.apply({
  effect(effect: () => unknown, label?: string) {
    if (['dsh-livestream credentials', 'state', 'settings', 'room control', 'connect', 'disconnect', 'onair', 'offair', 'owner', 'events', 'query cancel'].includes(label ?? '')) effect();
  },
  get(name: string) { return name === 'credentials' ? credentials : undefined; },
  provide() {},
  connection: { fetch: { register(route: { path: string; fetch: (request: Request) => Response }) { routes.set(route.path, route.fetch); return () => {}; } } },
});
const app = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script src="/client.js"></script></body></html>'); }
  if (url.pathname === '/client.js') { res.writeHead(200, { 'content-type': 'application/javascript' }); return res.end(await readFile('.e2e/feat-004-build-fixture/client.js')); }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString();
  if (url.pathname === '/__session') {
    const id = `query-session-${++sessionCount}`;
    currentAgent = await ctx.agentLoop.create(SessionId(id), { provider: 'fixture', model: 'model' });
    res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ id }));
  }
  if (url.pathname === '/__preset') { selectedPreset = body; return res.end('ok'); }
  if (url.pathname === '/__credential') {
    if (req.method === 'POST') { credential = body; process.env.GLM_CODING_PLAN_API_KEY = body; return res.end('ok'); }
    res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ GLM_CODING_PLAN_API_KEY: { configured: !!credential } }));
  }
  if (url.pathname === '/__reset-douyin') {
    if (runtime.show.isOnAir) { runtime.show.endLive(); (runtime.show as any).finish(); }
    runtime.show.setPlatform('bilibili');
    runtime.updateSettings({ livePlatform: 'bilibili', douyinRoomId: '', readOnlyQueries: { weather: true, publicSearch: false } });
    credential = 'fixture-key';
    process.env.GLM_CODING_PLAN_API_KEY = credential;
    room = '';
    subscriptions = 0;
    return res.end('ok');
  }
  if (url.pathname === '/__bridge-chat') {
    for (const socket of sockets.clients) socket.send(JSON.stringify({ id: 'after-disconnect', type: 'chat', platform: 'douyin', roomId: room, ts: Date.now(), user: { id: 'viewer-1', nickname: '测试观众' }, data: { content: '不应收到的弹幕' } }));
    return res.end('ok');
  }
  if (url.pathname === '/__stage-query-setup') {
    if (runtime.show.isOnAir) { runtime.show.endLive(); (runtime.show as any).finish(); }
    credential = 'fixture-key';
    process.env.GLM_CODING_PLAN_API_KEY = credential;
    mode = 'normal';
    runtime.updateSettings({ readOnlyQueries: { weather: true, publicSearch: false } });
    const id = `stage-query-${++sessionCount}`;
    currentAgent = await ctx.agentLoop.create(SessionId(id), { provider: 'fixture', model: 'model' });
    runtime.show.goLive(id);
    (runtime.show as any).priority = [];
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ sessionId: id, stageUrl: runtime.server.url }));
  }
  if (url.pathname === '/__stage-test-start') {
    if (runtime.show.isOnAir) { runtime.show.endLive(); (runtime.show as any).finish(); }
    runtime.show.goLive('stage-test');
    clearInterval((runtime.show as any).director);
    (runtime.show as any).director = null;
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ epoch: runtime.show.stage.outputEpoch, stageUrl: runtime.server.url }));
  }
  if (url.pathname === '/__stage-pending') {
    runtime.show.stage.broadcast({ type: 'say', id: 'interleaving', text: '不应晚到的字幕', mood: '', audio: 'AQ==', estimateMs: 1000, owner: { epoch: runtime.show.stage.outputEpoch!, turn: 'interleaving' } });
    return res.end('ok');
  }
  if (url.pathname === '/__drop-invalidate') {
    (stage as any).server.closeAllConnections();
    await new Promise<void>((resolve) => setImmediate(resolve));
    runtime.show.stage.broadcast({ type: 'invalidate', owner: { epoch: runtime.show.stage.outputEpoch!, turn: 'interleaving' } });
    return res.end('ok');
  }
  if (url.pathname === '/__stage-upgrade') {
    const previous = (stage as any).server;
    const closed = new Promise<void>((resolve) => previous.once('close', resolve));
    stage.stop();
    await closed;
    const future = new Date(Date.now() + 5000);
    await utimes('.e2e/feat-004-build-fixture/lib/stage.js', future, future);
    stage = new StageServer({ port: stagePort, token: 'fixture', packageDir: '.e2e/feat-004-build-fixture', packs: runtime.packs, stage: runtime.show.stage, current: () => ({ character: runtime.settings.character, template: runtime.settings.template }) });
    await stage.start();
    return res.end('ok');
  }
  if (url.pathname === '/__mode') { mode = body; return res.end('ok'); }
  if (url.pathname === '/__cancel') { currentAgent?.cancel({ kind: 'user' }); return res.end('ok'); }
  if (url.pathname === '/__release') { releaseMcp?.(); releaseMcp = undefined; return res.end('ok'); }
  if (url.pathname === '/__release-tts') { releaseTts?.(); releaseTts = undefined; await speechPromises.at(-1); return res.end('ok'); }
  if (url.pathname === '/__fixture') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ selectedPreset, modelRequests, mcpRequests, stageEvents, observedEvents, subscriptions, sharedRequests, externalRequests, ttsPending, agentStatus: currentAgent?.status, stageUrl: runtime.server.url, status: runtime.show.status() }));
  }
  const handler = routes.get(url.pathname);
  if (!handler) { res.writeHead(404); return res.end(); }
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  try {
    const response = await handler(new Request(url, { method: req.method, headers: { 'content-type': 'application/json' }, ...(req.method === 'POST' ? { body } : {}), signal: controller.signal }));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (!response.body) return res.end();
    const reader = response.body.getReader();
    while (!controller.signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  } catch { if (!res.destroyed) { res.writeHead(500); res.end(); } }
});
app.listen(port, '127.0.0.1');
console.log(`query fixture app=${port} model=${modelPort} stage=${stagePort} bridge=${bridgePort}`);
async function shutdown() {
  releaseMcp?.();
  releaseTts?.();
  outputConnection.destroy();
  stopObserved();
  runtime.show.dispose();
  stage.stop();
  for (const socket of sockets.clients) socket.terminate();
  sockets.close();
  bridge.closeAllConnections();
  bridge.close();
  await ctx.fiber.dispose();
  app.closeAllConnections(); model.closeAllConnections();
  app.close(); model.close();
  await rm(dir, { recursive: true, force: true });
  console.log(`query fixture stopped app=${port} model=${modelPort} stage=${stagePort} bridge=${bridgePort} sharedRequests=${sharedRequests} externalRequests=${externalRequests} model=${JSON.stringify(modelRequests.map((request) => ({ messages: request.messages, tools: request.tools?.map((tool: any) => tool.name) })))} mcp=${JSON.stringify(mcpRequests.map((request) => request?.method))} stage=${JSON.stringify(stageEvents.map((event) => ({ type: event.type, text: event.text, owner: event.owner })))}`);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
