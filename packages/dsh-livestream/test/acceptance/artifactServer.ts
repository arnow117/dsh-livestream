/** Load the unmodified standard index/agent/client/stage artifacts; no source runtime imports. */
import { createServer } from 'node:http';
import net from 'node:net';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import Group from '@deepseek-ai/cordis-plugin-group';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry';
import AgentPreset from '@deepseek-ai/dsh-agent-preset';
import * as Persona from '@deepseek-ai/dsh-persona';
import { parse } from 'yaml';
import { WebSocketServer } from 'ws';

const port = Number(process.argv[2]);
const packageDir = process.env.DSH_ACCEPTANCE_STANDARD_PACKAGE!;
const sourcePackage = process.env.DSH_LIVESTREAM_PACKAGE_DIR!;
const output = process.env.DSH_ACCEPTANCE_OUTPUT!;
const work = process.env.DSH_ACCEPTANCE_WORK!;
const sdkRoot = process.env.DSH_ACCEPTANCE_SDK_ROOT!;
const dshHome = process.env.DSH_HOME!;
if (!port || !packageDir || !work || !sdkRoot || !dshHome || [3080, 3081, 7390, 8757].includes(port)) throw new Error('fixture configuration required');
const privateValue = 'feat010-artifact-private-value';
const materials = join(work, 'materials');
const cwd = join(work, 'workdir');
await mkdir(join(materials, 'ch01'), { recursive: true });
await mkdir(cwd, { recursive: true });
await writeFile(join(materials, 'ch01/index.html'), `<!doctype html><html><body><div id="content">artifact course</div><script>
const BEATS=['intro','parts','distance','arm','balance','q1','distance_cost','kinds','lab','q2','wrap','final1','finish'].map((id,i)=>({id,title:'步骤 '+(i+1)}));
const P={i:0,playing:false,waiting:false,done:false,started:false,gen:1};
function hideCover(){ P.started=true; }
function setPlaying(value){ P.playing=value; }
function seek(index,play){
  P.i=index;
  P.gen++;
  P.waiting=false;
  setPlaying(play);
}
</script></body></html>`);
const data = join(dshHome, 'dsh-livestream');
await mkdir(data, { recursive: true, mode: 0o700 });
await writeFile(join(data, 'settings.json'), JSON.stringify({ stagePort: 0, stageToken: 'artifact-stage-fixture',
  livePlatform: 'douyin', douyinRoomId: '101', publicChat: { enabled: true, reply: true, welcome: false, thanks: false, drafts: { manual: '' } } }), { mode: 0o600 });
process.env.DSH_LIVESTREAM_PACKAGE_DIR = packageDir;
process.env.QUERY_FIXTURE_MODEL_KEY = 'synthetic-model';
let nativeAttempts = 0;
let syntheticAudioProcesses = 0;
const audioChildren = new Set<number>();
const childProcess = require('node:child_process');
const originalSpawn = childProcess.spawn.bind(childProcess);
childProcess.spawn = (command: string, args: string[], options: any) => {
  if (command !== 'ffmpeg' && command !== 'ffprobe') {
    nativeAttempts++;
    throw new Error('unexpected subprocess blocked');
  }
  const candidate = resolve(args.at(-1)!);
  const tempRoot = realpathSync(process.env.TMPDIR!);
  const parent = realpathSync(dirname(candidate));
  const relativeParent = relative(tempRoot, parent);
  if (!relativeParent || relativeParent.startsWith('..')) throw new Error('audio output outside task temporary root');
  syntheticAudioProcesses++;
  const operation = command === 'ffmpeg' ? 'encode' : 'probe';
  const child = originalSpawn(process.execPath, [join(sourcePackage, 'test/acceptance/audio-process-fixture.cjs'), operation, candidate], {
    ...options, env: { HOME: process.env.HOME!, TMPDIR: process.env.TMPDIR!, PATH: '/usr/bin:/bin' },
  });
  if (child.pid) audioChildren.add(child.pid);
  child.on('close', () => { if (child.pid) audioChildren.delete(child.pid); });
  return child;
};
syncBuiltinESMExports();

const ownedPorts = new Set<number>([port]);
let sharedRequests = 0;
let externalRequests = 0;
const originalConnect = net.Socket.prototype.connect;
(net.Socket.prototype as any).connect = function (...args: any[]) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = typeof first === 'object' && first !== null ? first : { port: args[0], host: args[1] };
  const targetPort = Number(options.port);
  const host = options.host ?? options.hostname;
  if (['127.0.0.1', 'localhost', '::1'].includes(host) && ownedPorts.has(targetPort)) return (originalConnect as any).apply(this, args);
  if ([3080, 3081, 7390, 8757].includes(targetPort)) sharedRequests++; else externalRequests++;
  throw new Error('blocked non-owned socket');
};
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input: any, init: any) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === '127.0.0.1' && ownedPorts.has(Number(url.port))) return originalFetch(input, init);
  if ([3080, 3081, 7390, 8757].includes(Number(url.port))) sharedRequests++; else externalRequests++;
  throw new Error('blocked non-owned fetch');
};
let modelPrivateHits = 0;
let modelCalls = 0;
let bridgeCalls = 0;
let syntheticTtsCalls = 0;
let ttsPrivateHits = 0;
const registrationSaveEffects: Array<{ native: number; model: number; bridge: number; tts: number }> = [];
const model = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/v1/audio/fixture') {
    res.writeHead(200, { 'content-type': 'audio/wav' });
    return res.end(Buffer.from('synthetic-audio-input'));
  }
  if (req.method === 'PUT' && /^\/v1\/jobs\/[0-9a-f]{32}$/.test(req.url ?? '')) {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString('utf8');
      ttsPrivateHits += body.split(privateValue).length - 1;
      syntheticTtsCalls++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ requestId: req.url!.split('/').at(-1), status: 'completed', downloadPath: '/v1/audio/fixture' }));
    })();
    return;
  }
  if (req.method === 'GET') {
    bridgeCalls++;
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/rooms/101') return res.end(JSON.stringify({ room: { roomId: '101', status: 'live' } }));
    if (req.url === '/api/stats') return res.end(JSON.stringify({ uptimeSec: 1 }));
    if (req.url === '/api/accounts') return res.end(JSON.stringify({ accounts: [{ id: 'fixture-anonymous',
      name: 'dsh-livestream-anonymous-fixture', hasCookie: false, hasLogin: false }] }));
    res.writeHead(404);
    return res.end();
  }
  void (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const request = Buffer.concat(chunks).toString('utf8');
    modelPrivateHits += request.split(privateValue).length - 1;
    modelCalls++;
    const frames = [
      { type: 'message_start', message: { id: `artifact-${randomUUID()}`, type: 'message', role: 'assistant', model: 'model', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '合成模型回答。' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''));
  })();
});
const bridgeSockets = new WebSocketServer({ noServer: true });
model.on('upgrade', (request, socket, head) => {
  if (request.url !== '/ws?roomId=101') {
    socket.destroy();
    return;
  }
  bridgeSockets.handleUpgrade(request, socket, head, (ws) => {
    ws.send(JSON.stringify({ type: '__connected', roomId: '101', room: { roomId: '101', status: 'live' } }));
  });
});
await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
const modelPort = (model.address() as net.AddressInfo).port;
ownedPorts.add(modelPort);
process.env.DSH_LIVESTREAM_DOUYIN_BRIDGE_URL = `http://127.0.0.1:${modelPort}`;
process.env.DSH_LIVESTREAM_TTS_BACKEND = 'yovoice';
process.env.YOVOICE_URL = `http://127.0.0.1:${modelPort}`;
process.env.YOVOICE_API_TOKEN = 'synthetic-fixture-token';

const ctx = new Context();
await ctx.plugin(Loader);
ctx.loader.builtins.group = Group;
ctx.loader.builtins.persona = Persona;
await ctx.plugin(LlmRuntime);
await ctx.plugin(LlmPiAi, { providers: { fixture: { api: 'anthropic-messages', baseURL: `http://127.0.0.1:${modelPort}`, apiKeyEnv: 'QUERY_FIXTURE_MODEL_KEY', cacheRetention: 'none', models: [{ id: 'model' }] } } });
await ctx.plugin(SessionStore);
await ctx.plugin(SessionProjectionRegistry);
await ctx.plugin(SystemPrompt, { personaPrefix: '' });
await ctx.plugin(ToolRuntime);
await ctx.plugin({ inject: ['tools'], apply(owner: Context) { owner.tools.setExecutor(new NativeToolExecutor.NativeToolExecutor(owner, () => 1)); } });
await ctx.plugin(AgentRegistry);
await ctx.plugin(AgentLoop, { agents: [] });
await ctx.plugin(AgentPresets, { default: 'dsh-livestream-douyin' });
const agentPlugin = await import(pathToFileURL(join(packageDir, 'lib/agent.js')).href);
const hostPlugin = await import(pathToFileURL(join(packageDir, 'lib/index.js')).href);
ctx.loader.builtins.livestreamAgent = agentPlugin;
const patch = parse(await readFile(join(sourcePackage, 'cordis.patch.yml'), 'utf8')) as Array<{ insert?: any[] }>;
const preset = patch.flatMap((entry) => entry.insert ?? []).find((entry) => entry.config?.id === 'dsh-livestream-douyin');
if (!preset) throw new Error('original preset unavailable');
const presetConfig = structuredClone(preset.config);
for (const entry of presetConfig.plugins) {
  if (entry.name === '@deepseek-ai/dsh-persona') entry.name = 'cordis:persona';
  if (entry.name === 'dsh-livestream/agent') entry.name = 'cordis:livestreamAgent';
}
await ctx.plugin(AgentPreset, presetConfig);
const { HostConnectionService } = await import(pathToFileURL(join(sdkRoot, '@deepseek-ai/dsh-client-connection/lib/index.js')).href) as any;
const connectionContext = new Context();
let guestPeer: any;
const connection = new HostConnectionService(connectionContext, [], {
  isAuthenticated: (request: any) => request.headers?.get?.('x-fixture-owner') === 'owner-fixture',
  authenticateApi: (request: any) => request.headers?.get?.('x-fixture-guest') === 'guest-fixture' ? guestPeer?.id : undefined,
});
const agents = new Map<string, any>();
const creates: any[] = [];
const hostContext = {
  effect(effect: () => unknown, label?: string) {
    if (['dsh-livestream credentials','state','settings','session context recheck','sessions','onair','offair','owner','events','query cancel','connect','disconnect','course','room control','account','simulate','dsh-livestream public chat','dsh-livestream course context','dsh-livestream robot live','dsh-livestream stage server','dsh-livestream show','dsh-livestream asr','registration private read','registration settings','registration authorize','registration live read','registration robot consume','registration revoke','public chat','dsh-livestream query ownership'].includes(label ?? '')) effect();
  },
  get(name: string) {
    if (name === 'credentials') return { resolve: async () => ({ value: '' }), set: async () => {} };
    if (name === 'sessionController') return { create: async (request: any) => {
      creates.push(request);
      const handle = await ctx.agents.create({ sessionId: SessionId(request.sessionId),
        meta: request.cwd ? { cwd: request.cwd } : undefined, agentOptions: { provider: 'fixture', model: 'model' },
        setup: async (scope: any) => { await ctx.agentPresets.mount(scope, 'dsh-livestream-douyin'); } });
      agents.set(request.sessionId, handle.agent);
      return { sessionId: request.sessionId, agentPreset: request.agentPreset };
    } };
    if (name === 'agents') return { get: (id: string) => agents.get(id) };
    if (name === 'workingDirectory') return { get: (session: any) => session?.header?.cwd ?? null };
    if (name === 'workspaceRegistry') return { get: (id: string) => id === 'workspace' ? { path: work } : undefined };
    if (name === 'loader') return { entries: () => [][Symbol.iterator]() };
    return undefined;
  },
  provide() {}, plugin: ctx.plugin.bind(ctx),
  connection: { fetch: connection.fetch, admit: (request: any) => connection.admit(request) },
};
// Observe the public listening address; never access or mutate the artifact's runtime state.
let stagePort = 0;
const originalListen = net.Server.prototype.listen;
(net.Server.prototype as any).listen = function (...args: any[]) {
  this.once('listening', () => {
    const address = this.address();
    if (address && typeof address !== 'string') stagePort = address.port;
  });
  return (originalListen as any).apply(this, args);
};
hostPlugin.apply(hostContext);
const waitDeadline = Date.now() + 5000;
while (!stagePort && Date.now() < waitDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
(net.Server.prototype as any).listen = originalListen;
if (!stagePort || [3080, 3081, 7390, 8757].includes(stagePort)) throw new Error('stage listener unavailable');
ownedPorts.add(stagePort);
const ownerPeer = connection.createPeer({ principal: { kind: 'owner' } });
guestPeer = connection.createPeer({ principal: { kind: 'guest' } });
const handler = connection.createSharedFetchHandler('/api');
let sessionCount = 0;
const app = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html>
        <html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
        <body>
          <iframe title="实际舞台" src="http://127.0.0.1:${stagePort}/?token=artifact-stage-fixture" style="width:100%;height:300px;border:0"></iframe>
          <div id="root"></div>
          <script src="/bootstrap.js"></script><script src="/standard-client.js"></script>
        </body></html>`);
    }
    if (url.pathname === '/bootstrap.js' || url.pathname === '/standard-client.js') {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      return res.end(await readFile(url.pathname === '/bootstrap.js' ? join(output, 'client.js') : join(packageDir, 'lib/client.js')));
    }
    if (url.pathname === '/__artifact') {
      const snapshots = [...agents.values()].flatMap((agent) => agent.session?.snapshotEvents(0) ?? []);
      const guestRequest = new Request('http://127.0.0.1/api/dsh-livestream/state', { headers: { host: '127.0.0.1' } });
      const guestRoute = await handler.fetch(guestRequest, guestPeer);
      return res.end(JSON.stringify({ stagePort, modelPort, nativeAttempts, modelCalls, modelPrivateHits,
        guestRouteStatus: guestRoute.status, guestPrincipalKind: guestPeer.principal?.kind ?? null, syntheticTtsCalls, syntheticAudioProcesses, ttsPrivateHits,
        agentPrivateHits: JSON.stringify(snapshots).split(privateValue).length - 1, registrationSaveEffects,
        creates, canonicalPaths: { materials: await realpath(materials), workdir: await realpath(cwd) },
        counters: { sharedRequests, externalRequests }, loaded: ['index.js', 'agent.js', 'client.js', 'stage.js'] }));
    }
    if (url.pathname === '/__legacy-session') return res.end(JSON.stringify({ id: `legacy-${++sessionCount}` }));
    if (!url.pathname.startsWith('/api/')) {
      res.writeHead(404);
      return res.end();
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const request = new Request(url, { method: req.method, headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json',
      ...(typeof req.headers['x-fixture-owner'] === 'string' ? { 'x-fixture-owner': req.headers['x-fixture-owner'] } : {}),
      ...(typeof req.headers['x-fixture-guest'] === 'string' ? { 'x-fixture-guest': req.headers['x-fixture-guest'] } : {}) },
      ...(body.length ? { body } : {}) });
    const admitted = connection.admit(request);
    if ('rejection' in admitted) {
      res.writeHead(admitted.rejection);
      return res.end();
    }
    const before = { native: nativeAttempts, model: modelCalls, bridge: bridgeCalls, tts: syntheticTtsCalls };
    const response = await handler.fetch(request, admitted.peer);
    if (url.pathname === '/api/dsh-livestream/registration/settings' && req.method === 'POST') {
      registrationSaveEffects.push({ native: nativeAttempts - before.native, model: modelCalls - before.model,
        bridge: bridgeCalls - before.bridge, tts: syntheticTtsCalls - before.tts });
    }
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (!response.body) return res.end();
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  })().catch(() => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});
app.listen(port, '127.0.0.1');
console.log(`standard artifact fixture pid=${process.pid} app=${port} model=${modelPort} stage=${stagePort}`);
async function shutdown() {
  await guestPeer.dispose();
  await ownerPeer.dispose();
  await ctx.fiber.dispose();
  await connectionContext.fiber.dispose();
  app.closeAllConnections();
  model.closeAllConnections();
  bridgeSockets.close();
  app.close();
  model.close();
  console.log(`standard artifact fixture stopped sharedRequests=${sharedRequests} externalRequests=${externalRequests} nativeAttempts=${nativeAttempts} remainingAudioChildren=${audioChildren.size}`);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
