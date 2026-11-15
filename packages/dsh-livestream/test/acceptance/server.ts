/**
 * FEAT-010-T001 同版内部组合 fixture。
 *
 * 一个进程里同时挂起：真实 SDK HostConnectionService（owner/nonowner 准入）、真实插件入口
 * （src/dsh/index.ts + src/dsh/agent.ts + src/dsh/runtime.ts）、真实 Stage（src/body/server.ts）、
 * 真实课程控制器与真实公屏宿主、真实 registration 私有读取路由。
 * 外部依赖全部是任务自有的本地替身：协议模型替身、课程素材、mock 抖音桥、可控合成音频。
 *
 * 边界（诚实声明）：
 * - 生产公屏 sender 未装配（DSH_PUBLIC_CHAT_DEPLOYMENT_FILE / MATERIAL_FILE / HELPER_DATA_DIR 缺失），
 *   所以宿主级公屏只观察「未装配即零派发」；已授权路径由同一进程内真实 PublicChatSendController
 *   加既有离线 sender seam（test/publicChat/frozenTestGateway.ts）组合验证。
 * - registration 私有读取只覆盖已接受的 T003 读取子集（012 的写入仍由原 Task 负责）。
 */

import { createServer } from 'node:http';
import net from 'node:net';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import Group from '@deepseek-ai/cordis-plugin-group';
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry';
import AgentPreset from '@deepseek-ai/dsh-agent-preset';
import * as Persona from '@deepseek-ai/dsh-persona';
import { parse } from 'yaml';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import { WebSocketServer } from 'ws';
import { PublicChatSendController } from '../../src/publicChat/controller';
import { FrozenPublicChatOperationJournal } from '../../src/publicChat/frozenJournal';
import { makeFrozenTestGateway, FROZEN_TEST_DEPLOYMENT } from '../../test/publicChat/frozenTestGateway';
import { TEST_LIVE_EPOCH } from '../../test/publicChat/test-helpers';
import { OWNED_OUTPUT_PROTOCOL } from '../../src/stage/protocol';

const port = Number(process.argv[2]);
const dshHome = process.env.DSH_HOME;
const sdkRoot = process.env.DSH_ACCEPTANCE_SDK_ROOT;
const workRoot = process.env.DSH_ACCEPTANCE_WORK;
const artifactDirectory = process.env.DSH_ACCEPTANCE_ARTIFACT;
const packageDir = process.env.DSH_LIVESTREAM_PACKAGE_DIR;
const outputDir = process.env.DSH_ACCEPTANCE_OUTPUT;
if (!port || !dshHome || !sdkRoot || !workRoot || !artifactDirectory || !packageDir || !outputDir) {
  throw new Error('acceptance fixture configuration required');
}
if ([3080, 3081, 7390, 8757].includes(port)) throw new Error('shared port selected');

/** 本轮唯一的私有测试值：只允许出现在原私有读取的受众里。 */
const PRIVATE_VALUE = 'feat010-private-contact-value';
const PRIVATE_FIELD = 'f2';
let ordinaryLogPrivateHits = 0;
for (const level of ['log', 'warn', 'error'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    const safe = args.map((value) => {
      const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
      ordinaryLogPrivateHits += text.split(PRIVATE_VALUE).length - 1;
      return text.split(PRIVATE_VALUE).join('[fixture-private-redacted]');
    });
    original(...safe);
  };
}

/* ── 任务自有设置（stagePort=0，绝不复用共享端口） ───────────────────────── */

const dataDir = join(dshHome, 'dsh-livestream');
await mkdir(dataDir, { recursive: true, mode: 0o700 });
await writeFile(join(dataDir, 'settings.json'), JSON.stringify({
  stagePort: 0,
  stageToken: 'fixture',
  livePlatform: 'douyin',
  douyinRoomId: '101',
  publicChat: { enabled: true, reply: true, welcome: false, thanks: false, drafts: { manual: '' } },
  registrationRead: {
    workspaceId: 'workspace',
    profile: 'selected',
    appId: 'app1',
    userOpenId: 'user1',
    artifactDirectory,
    baseId: 'base1',
    tableId: 'table1',
    recordId: 'record1',
    mappingId: 'map',
    mappingRevision: 1,
    displayNameField: 'f1',
    contactField: PRIVATE_FIELD,
    interestField: 'f4',
    photoField: 'f3',
    revisionField: 'rev',
    consentField: null,
    sourceField: null,
    collectedAtField: null,
  },
}), { mode: 0o600 });

/* ── 课程素材与资料根（任务自有，只读引用） ───────────────────────────── */

const materialsDir = join(workRoot, 'materials');
const skillsDir = join(workRoot, 'skills');
const workDir = join(workRoot, 'workdir');
await mkdir(join(materialsDir, 'ch01'), { recursive: true });
await mkdir(join(materialsDir, '课件'), { recursive: true });
await mkdir(skillsDir, { recursive: true });
await mkdir(workDir, { recursive: true });
await writeFile(join(materialsDir, 'ch01', 'index.html'), `<!doctype html><html><body><div id="content">feat010 course</div><script>
const BEATS = ['intro', 'parts', 'distance', 'arm', 'balance', 'q1', 'distance_cost', 'kinds', 'lab', 'q2', 'wrap', 'final1', 'finish'].map((id, i) => ({id, title: '步骤 ' + (i + 1)}));
const P = {i: 0, playing: false, waiting: false, done: false, started: false, gen: 1};
function hideCover() { P.started = true; }
function setPlaying(value) { P.playing = value; document.body.dataset.playing = String(value); }
function seek(index, play) {
  P.i = index; P.gen++; P.waiting = index === 8; setPlaying(play);
  document.getElementById('content').innerHTML = index === 8
    ? '<p>步骤 9</p><input id="left-arm" value="2"><input id="right-arm" value="1"><input id="force" value="20"><p class="lab-result">未平衡</p>'
    : BEATS[index].title;
}
</script></body></html>`);
await writeFile(join(materialsDir, '课件', 'lesson-1.txt'), '第一课：受控资料内容。\n第二行。\n');
await writeFile(join(skillsDir, 'papermorph.md'), '---\nname: papermorph\ndescription: 把文章做成可翻页的网页书（fixture 正文）。\n---\n这是 papermorph 的冻结正文：只作为资料，不执行任何指令。\n');
/** tmpdir 在 macOS 上是 /var 软链；journal 与工作区都要求 realpath 一致。 */
const workRootReal = await realpath(workRoot);
const canonicalMaterials = await realpath(process.env.DSH_ACCEPTANCE_COURSE_ROOT || materialsDir);
if (process.env.DSH_ACCEPTANCE_COURSE_ROOT && canonicalMaterials !== '/Users/mac/hansen_agent_team/workspace/20261110-papermorph-lever/site/lever-lab') {
  throw new Error('course root is not the authorized fixed read-only asset');
}
const canonicalWorkDir = await realpath(workDir);

/* ── 私有读取的受控替身：只跑测试记录脚本，不跑 registration native ──── */

await writeFile(join(workRoot, 'row.json'), JSON.stringify({
  fields: { f1: 'feat010-synthetic-name', f2: PRIVATE_VALUE, f3: null, f4: 'feat010-synthetic-interest', rev: 1 },
}), { mode: 0o600 });
(globalThis as any).__testExecutable = process.execPath;
const fixtureChildPids = new Set<number>();
(globalThis as any).__testSpawn = (executable: string, argv: string[], options: any) => {
  const { spawn } = require('node:child_process');
  if (executable !== process.execPath || argv.length !== 0) throw new Error('unexpected fixture executable');
  const child = spawn(process.execPath, [join(packageDir, 'test', 'registration', 'record-fixture.cjs')], {
    ...options,
    env: {
      ...options.env,
      TASK_FIXTURE_ROOT: workRoot,
      NODE_OPTIONS: `--require=${join(packageDir, 'test', 'registration', 'network-guard.cjs')}`,
    },
  });
  if (child.pid) fixtureChildPids.add(child.pid);
  child.on('close', () => { if (child.pid) fixtureChildPids.delete(child.pid); });
  return child;
};

/* ── 协议模型替身（loopback，禁外部与共享端口） ─────────────────────────── */

let stagePort = 0;
let bridgePort = 0;
let sharedRequests = 0;
let externalRequests = 0;
let guardProbe = false;
const guardNegative = { shared: 0, external: 0 };
const ownedPorts = new Set<number>([port]);
const originalConnect = net.Socket.prototype.connect;
(net.Socket.prototype as any).connect = function (...args: any[]) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = typeof first === 'object' && first !== null
    ? first
    : { port: args[0], host: args[1] };
  const targetPort = Number(options.port);
  const targetHost = options.host ?? options.hostname;
  if (['127.0.0.1', 'localhost', '::1'].includes(targetHost) && ownedPorts.has(targetPort)) {
    return (originalConnect as any).apply(this, args);
  }
  if ([3080, 3081, 7390, 8757].includes(targetPort)) {
    if (guardProbe) guardNegative.shared++; else sharedRequests++;
  } else if (guardProbe) guardNegative.external++; else externalRequests++;
  console.warn(`blocked socket host=${String(targetHost)} port=${String(options.port)}`);
  throw new Error('socket target outside task-owned loopback ports');
};
const toolInvocations: Array<{ name: string; args: unknown; status: string; result: unknown }> = [];
const observedToolSets: Array<string[]> = [];
const modelObservations: Array<{ requested: boolean; toolResult: boolean; offered: boolean; publicChatToolOffered: boolean }> = [];
let modelPrivateHits = 0;
let ttsPrivateHits = 0;
const courseToolsSent = new Set<string>();
const courseRequests: Array<{ text: string; input: Record<string, unknown> }> = [
  { text: '把动力臂调为1.3米', input: { kind: 'param', which: 'left', value: 1.3, unit: 'm' } },
  { text: '第一题选择错误项', input: { kind: 'answer', target: 'choice', index: 1 } },
  { text: '第一题选择正确项', input: { kind: 'answer', target: 'choice', index: 0 } },
];
const heldReplies = new Set<string>();
let releaseReply: (() => void) | undefined;
let multiSegmentNextResponse = false;
let holdNextModel = false;
let releasedModelResponses = 0;
let sessionCount = 0;
const nativeCreates: Array<Record<string, unknown>> = [];
const agents = new Map<string, any>();

const model = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', async () => {
    const request = JSON.parse(Buffer.concat(chunks).toString());
    const last = request.messages.at(-1);
    const blocks = Array.isArray(last?.content) ? last.content : [];
    const toolResult = blocks.some((block: any) => block.type === 'tool_result');
    const serialized = JSON.stringify(request.messages);
    modelPrivateHits += countHits(request);
    const requestedAction = !toolResult
      ? courseRequests.find((item) => serialized.includes(item.text) && !courseToolsSent.has(item.text))
      : undefined;
    const requestPublicReply = !toolResult && serialized.includes('合成公屏问题')
      && (request.tools ?? []).some((item: any) => item.name === 'send_public_chat_reply');
    const shouldApply = !!requestedAction || requestPublicReply;
    if (serialized.includes('合成公屏问题')) {
      console.log('fixture model source turn', JSON.stringify({ toolResult, requestPublicReply,
        tools: (request.tools ?? []).map((item: any) => item.name) }));
    }
    if (requestedAction) courseToolsSent.add(requestedAction.text);
    const marker = holdNextModel ? '主动延迟模型' : ['等待主人切步后回答', '等待断订阅后回答'].find((item) => serialized.includes(item) && !heldReplies.has(item));
    holdNextModel = false;
    if (marker) {
      heldReplies.add(marker);
      await new Promise<void>((resolve) => { releaseReply = resolve; });
    }
    modelObservations.push({
      requested: shouldApply,
      toolResult,
      offered: (request.tools ?? []).some((item: any) => item.name === 'apply_livestream_course_action'),
      publicChatToolOffered: (request.tools ?? []).some((item: any) => item.name === 'send_public_chat_reply'),
    });
    const responseText = marker ? '迟到测试回答。'
      : multiSegmentNextResponse ? '第一段。[laugh]第二段。' : '大家好。';
    multiSegmentNextResponse = false;
    const frames = [
      { type: 'message_start', message: { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: 'model', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } },
      ...(shouldApply ? [
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `call_${randomUUID()}`, name: requestPublicReply ? 'send_public_chat_reply' : 'apply_livestream_course_action', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(requestPublicReply ? { text: '合成回复' } : { input: requestedAction!.input }) } },
      ] : [
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: responseText } },
      ]),
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: shouldApply ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const frame of frames) res.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
    res.end();
    if (marker) releasedModelResponses++;
  });
});
await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
const modelPort = (model.address() as { port: number }).port;
if ([3080, 3081, 7390, 8757].includes(modelPort)) throw new Error('shared port selected');
ownedPorts.add(modelPort);

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && ['3080', '3081', '7390', '8757'].includes(url.port)) {
    if (guardProbe) guardNegative.shared++; else sharedRequests++;
    throw new Error('shared service request blocked');
  }
  if (url.hostname === '127.0.0.1' && [port, modelPort, stagePort, bridgePort].includes(Number(url.port))) return originalFetch(input, init);
  if (guardProbe) guardNegative.external++; else externalRequests++;
  console.warn(`blocked fetch host=${url.hostname} port=${url.port}`);
  throw new Error('unexpected external request blocked');
};

/* ── mock 抖音桥（loopback，只提供连接握手；不发真实平台流量） ─────────── */

const bridge = createServer((request, response) => {
  response.setHeader('content-type', 'application/json');
  if (request.method !== 'GET') { response.writeHead(405); response.end(); return; }
  if (request.url === '/api/accounts') {
    response.end(JSON.stringify({ accounts: [{ id: 'fixture-anonymous', name: 'dsh-livestream-anonymous-fixture', hasCookie: false, hasLogin: false }] }));
  } else if (request.url === '/api/stats') {
    response.end(JSON.stringify({ uptimeSec: 1 }));
  } else if (request.url === '/api/rooms/101') {
    response.end(JSON.stringify({ room: { roomId: '101', status: 'live' } }));
  } else {
    response.writeHead(404);
    response.end();
  }
});
const bridgeSockets = new WebSocketServer({ noServer: true });
bridge.on('upgrade', (request, socket, head) => {
  if (request.url !== '/ws?roomId=101') { socket.destroy(); return; }
  bridgeSockets.handleUpgrade(request, socket, head, (ws) => {
    ws.send(JSON.stringify({ type: '__connected', roomId: '101', room: { roomId: '101', status: 'live' } }));
  });
});
await new Promise<void>((resolve) => bridge.listen(0, '127.0.0.1', resolve));
bridgePort = (bridge.address() as { port: number }).port;
if ([3080, 3081, 7390, 8757].includes(bridgePort)) throw new Error('shared bridge port selected');
ownedPorts.add(bridgePort);
process.env.DSH_LIVESTREAM_DOUYIN_BRIDGE_URL = `http://127.0.0.1:${bridgePort}`;
if (process.env.DSH_ACCEPTANCE_SENDER_MODE === 'offline') {
  // Synthetic references satisfy the original environment parser; the test-only loader
  // never opens these files, starts a helper, or connects to a real sender.
  const fixtureReference = join(workRoot, 'synthetic-reference');
  for (const name of ['BUILD_DEPLOYMENT_FILE', 'DEPLOYMENT_FILE', 'BROWSER_EXECUTABLE',
    'HELPER_MANIFEST', 'HELPER_SOURCE_DIRECTORY', 'MATERIAL_FILE', 'HELPER_DATA_DIR']) {
    process.env[`DSH_PUBLIC_CHAT_${name}`] = fixtureReference;
  }
  process.env.DSH_PUBLIC_CHAT_HELPER_MANIFEST_SHA256 = 'a'.repeat(64);
}

/* ── 真实插件运行时 ──────────────────────────────────────────────────── */

const ctx = new Context();
if (process.env.DSH_ACCEPTANCE_SENDER_MODE === 'offline') {
  await ctx.plugin(Loader);
  ctx.loader.builtins.group = Group;
  ctx.loader.builtins.persona = Persona;
} else {
  ctx.provide('loader', { entries: () => [][Symbol.iterator]() });
}
await ctx.plugin(LlmRuntime);
await ctx.plugin(LlmPiAi, { providers: { fixture: { api: 'anthropic-messages', baseURL: `http://127.0.0.1:${modelPort}`, apiKeyEnv: 'QUERY_FIXTURE_MODEL_KEY', cacheRetention: 'none', models: [{ id: 'model' }] } } });
await ctx.plugin(SessionStore);
await ctx.plugin(SessionProjectionRegistry);
await ctx.plugin(SystemPrompt, { personaPrefix: '' });
await ctx.plugin(ToolRuntime);
await ctx.plugin({ inject: ['tools'], apply(owner: Context) { owner.tools.setExecutor(new NativeToolExecutor.NativeToolExecutor(owner, () => 1)); } });
await ctx.plugin(AgentRegistry);
await ctx.plugin(AgentLoop, { agents: [] });

process.env.QUERY_FIXTURE_MODEL_KEY = 'fake-model';
delete process.env.GLM_CODING_PLAN_API_KEY;

// The real runtime StageServer serves this fixture's stage build and read-only assets.
process.env.DSH_LIVESTREAM_PACKAGE_DIR = outputDir;
const runtime = await import('../../src/dsh/runtime');

/** 受控合成音频：本机自造的静音 MP3 帧，不是真实 yovoice，也不是人耳可听内容。 */
function silentMp3(frames = 20): Buffer {
  const header = Buffer.from([0xff, 0xfb, 0x90, 0x64]);
  const frame = Buffer.concat([header, Buffer.alloc(417 - header.length)]);
  return Buffer.concat(Array.from({ length: frames }, () => frame));
}
const controlledAudio = silentMp3();
let holdNextTts = false;
let releaseTts: (() => void) | undefined;
(runtime.show as any).hooks.synthesize = async (text: string) => {
  ttsPrivateHits += countHits(text);
  if (holdNextTts) {
    holdNextTts = false;
    await new Promise<void>((resolve) => { releaseTts = resolve; });
  }
  return {
    audio: new Uint8Array(controlledAudio),
    timeline: Array.from({ length: Math.max(1, text.length) }, (_, index) => ({ chars: index + 1, atMs: index * 40 })),
  };
};

let observedTurnEnds = 0;
let speechAttempts = 0;
let settledSpeech = 0;
const originalTurnEnded = runtime.show.turnEnded.bind(runtime.show);
runtime.show.turnEnded = (...args: unknown[]) => { observedTurnEnds++; return (originalTurnEnded as any)(...args); };
const originalSay = runtime.show.say.bind(runtime.show);
runtime.show.say = (...args: unknown[]) => {
  speechAttempts++;
  return (originalSay as any)(...args).finally(() => { settledSpeech++; });
};

/** 舞台回执：said（念完一句）与 audioResult（ended/error/unknown）。 */
const stageReceipts: Array<{ kind: 'said' | 'audio'; id: string; result?: string }> = [];
const stageAudioResults: Array<{ id: string; result: string }> = [];
const stageEvents: Array<{ type: string; id?: string; text?: string; hasAudio?: boolean; epoch?: string; onAir: boolean; ending: boolean }> = [];
const stage = runtime.show.stage as any;
const originalWaitAudio = stage.waitAudio.bind(stage);
stage.waitAudio = (id: string, ...args: unknown[]) => originalWaitAudio(id, ...args).then((result: string) => {
  stageAudioResults.push({ id, result });
  return result;
});
const originalSaid = stage.said.bind(stage);
stage.said = (id: string) => { stageReceipts.push({ kind: 'said', id }); return originalSaid(id); };
const originalAudioResult = stage.audioResult.bind(stage);
stage.audioResult = (id: string, result: string, watcherId: string) => {
  stageReceipts.push({ kind: 'audio', id, result });
  return originalAudioResult(id, result, watcherId);
};
stage.subscribe((event: any) => {
  if (event?.type !== 'say') return;
  stageEvents.push({ type: event.type, id: event.id, text: event.text, hasAudio: typeof event.audio === 'string' && event.audio.length > 0, epoch: event.owner?.epoch, onAir: runtime.show.isOnAir, ending: runtime.show.isEnding });
}, false, OWNED_OUTPUT_PROTOCOL);

const plugin = await import('../../src/dsh/agent');
const host = await import('../../src/dsh/index');
if (process.env.DSH_ACCEPTANCE_SENDER_MODE === 'offline') {
  await ctx.plugin(AgentPresets, { default: 'dsh-livestream-douyin' });
  ctx.loader.builtins.livestreamAgent = plugin;
  const patch = parse(await readFile(join(packageDir, 'cordis.patch.yml'), 'utf8')) as Array<{ insert?: any[] }>;
  const row = patch.flatMap((entry) => entry.insert ?? []).find((entry) => entry.config?.id === 'dsh-livestream-douyin');
  if (!row) throw new Error('original douyin preset unavailable');
  const config = structuredClone(row.config);
  for (const entry of config.plugins) {
    if (entry.name === '@deepseek-ai/dsh-persona') entry.name = 'cordis:persona';
    if (entry.name === 'dsh-livestream/agent') entry.name = 'cordis:livestreamAgent';
  }
  await ctx.plugin(AgentPreset, config);
} else {
  await ctx.plugin(plugin);
}

/* ── 真实 SDK HostConnectionService（owner/nonowner 准入） ──────────────── */

const { HostConnectionService } = await import(pathToFileURL(join(sdkRoot, '@deepseek-ai/dsh-client-connection/lib/index.js')).href) as any;
const connectionContext = new Context();
let guestPeer: any;
const connection = new HostConnectionService(connectionContext, [], {
  isAuthenticated: (request: any) => request.headers?.get?.('x-fixture-owner') === 'owner-fixture',
  authenticateApi: (request: any) => request.headers?.get?.('x-fixture-guest') === 'guest-fixture' ? guestPeer?.id : undefined,
});

const sessionController = {
  create: async (request: Record<string, unknown>) => {
    nativeCreates.push({ ...request });
    if (request.cwd !== undefined && request.workspaceId !== undefined) throw new Error('native contract violation');
    const { mkdirSync } = await import('node:fs');
    if (typeof request.cwd === 'string') mkdirSync(request.cwd, { recursive: true });
    const id = SessionId(String(request.sessionId));
    const meta = typeof request.cwd === 'string' ? { cwd: request.cwd } : undefined;
    const agent = process.env.DSH_ACCEPTANCE_SENDER_MODE === 'offline'
      ? (await ctx.agents.create({ sessionId: id, meta, agentOptions: { provider: 'fixture', model: 'model' },
        setup: async (scope: any) => { await ctx.agentPresets.mount(scope, 'dsh-livestream-douyin'); } })).agent
      : await ctx.agentLoop.create(id, { provider: 'fixture', model: 'model' }, meta);
    agents.set(String(request.sessionId), agent);
    return { sessionId: request.sessionId, ...(request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset }) };
  },
};

/** 稳定身份：readService 每次取到的必须是同一个 registry 实例。 */
const workspace = { path: workRootReal };
const workspaceRegistry = { get: (id: string) => (id === 'workspace' ? workspace : undefined) };

const hostContext = {
  effect(effect: () => unknown, label?: string) {
    if (['dsh-livestream credentials', 'state', 'settings', 'session context recheck', 'sessions', 'onair', 'offair', 'owner', 'events', 'query cancel', 'connect', 'disconnect', 'course', 'room control', 'account', 'simulate', 'dsh-livestream public chat', 'dsh-livestream course context', 'dsh-livestream robot live', 'dsh-livestream stage server', 'dsh-livestream show', 'dsh-livestream resume', 'dsh-livestream asr', 'registration private read', 'registration settings', 'registration authorize', 'registration live read', 'registration robot consume', 'registration revoke', 'public chat', 'dsh-livestream query ownership'].includes(label ?? '')) effect();
  },
  get(name: string) {
    if (name === 'credentials') return { resolve: async () => ({ value: '' }), set: async () => {} };
    if (name === 'sessionController') return sessionController;
    if (name === 'agents') return { get: (id: string) => agents.get(id) };
    if (name === 'workingDirectory') return { get: (session: any) => session?.header?.cwd ?? null };
    if (name === 'loader') return { entries: () => [][Symbol.iterator]() };
    if (name === 'workspaceRegistry') return workspaceRegistry;
    return undefined;
  },
  provide() {},
  plugin: ctx.plugin.bind(ctx),
  connection: { fetch: connection.fetch, admit: (request: any) => connection.admit(request) },
};
host.apply(hostContext as any);

const stageServer = runtime.server;
const stageDeadline = Date.now() + 5000;
while (Number(new URL(stageServer.url).port) === 0 && Date.now() < stageDeadline) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
stagePort = Number(new URL(stageServer.url).port);
if (!stagePort || [3080, 3081, 7390, 8757].includes(stagePort)) throw new Error('stage listener unavailable');
ownedPorts.add(stagePort);

/* ── 宿主级准入与路由调用 ─────────────────────────────────────────────── */

const handler = connection.createSharedFetchHandler('/api');
const ownerPeer = connection.createPeer({ principal: { kind: 'owner' } });
guestPeer = connection.createPeer({ principal: { kind: 'guest' } });
// A public SDK-created guest can exercise the route's authorization directly.
// The SDK has no public non-owner HTTP publication path; admission remains unverified.

async function callRoute(path: string, options: { method?: string; body?: unknown; peer?: any } = {}) {
  const request = new Request(`http://127.0.0.1/api${path}`, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers: {
      host: '127.0.0.1',
      'content-type': 'application/json',
      ...(options.peer === guestPeer ? { 'x-fixture-guest': 'guest-fixture' } : { 'x-fixture-owner': 'owner-fixture' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const response = await handler.fetch(request, options.peer ?? ownerPeer);
  const text = await response.text();
  let body: unknown = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body: body as any };
}

/* ── 公屏：宿主未装配（零派发） + 控制器级既有离线 seam 组合 ──────────── */

const senderRequests: string[] = [];
const originalGlobalFetch = globalThis.fetch;
globalThis.fetch = async (input: any, init: any) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  senderRequests.push(url.href);
  return originalGlobalFetch(input, init);
};

const controllerComposition = await (async () => {
  const startedAt = Date.now() - 1000;
  const gateway = makeFrozenTestGateway(startedAt);
  const journalDirectory = join(workRootReal, 'public-chat-journal');
  await mkdir(journalDirectory, { recursive: true, mode: 0o700 });
  const freshJournal = async (name: string) => {
    const directory = join(workRootReal, `public-chat-journal-${name}`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return { journal: new FrozenPublicChatOperationJournal(directory), directory };
  };
  const bounds = { queueLimit: 10, queueWaitMs: 5_000, dispatchIntervalMs: 5, httpTimeoutMs: 1_000 };
  const report: Record<string, unknown> = {};

  // 未授权：真实控制器不得产生任何派发
  const unqualifiedJournal = (await freshJournal('unqualified')).journal;
  const unqualified = new PublicChatSendController({ deployment: FROZEN_TEST_DEPLOYMENT, gateway: gateway.gateway, journal: unqualifiedJournal, bounds });
  unqualified.advanceInputConnection();
  unqualified.setLiveEpoch(TEST_LIVE_EPOCH, startedAt);
  const qualification = await unqualified.refreshQualification();
  const unauthorized = await unqualified.submit({ requestId: 'req-unauthorized', sourceKey: 'src-1', text: '不该被发送' });
  report.qualificationWithoutGrant = { qualification, submitStatus: unauthorized?.status, sends: gateway.calls.sends.length };

  // 明确 fixture 授权：同一原事件按原规则派发
  const authorizedJournal = (await freshJournal('authorized')).journal;
  const controller = new PublicChatSendController({ deployment: FROZEN_TEST_DEPLOYMENT, gateway: gateway.gateway, journal: authorizedJournal, bounds });
  controller.advanceInputConnection();
  controller.setLiveEpoch(TEST_LIVE_EPOCH, startedAt);
  await controller.refreshQualification();
  const authorization = await controller.authorize();
  const accepted = await controller.submit({ requestId: 'req-1', sourceKey: 'src-1', text: '大家好' });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && controller.frozenOperationView('req-1')?.state !== 'api_reported_success') {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  report.authorized = {
    authorization, submitStatus: accepted?.status,
    sends: gateway.calls.sends.length,
    sentText: gateway.calls.sends[0]?.text,
    sentSourceKey: gateway.calls.sends[0]?.sourceKey,
    operationState: controller.frozenOperationView('req-1')?.state,
  };

  // 撤权：原授权不复活
  controller.revokeGrant('owner-revoke');
  const afterRevoke = await controller.submit({ requestId: 'req-2', sourceKey: 'src-2', text: '撤权后不该发送' });
  report.afterRevoke = { submitStatus: afterRevoke?.status, sends: gateway.calls.sends.length, hold: controller.hold };

  // 断连：输入连接代际变化使原授权失效
  controller.advanceInputConnection();
  const afterDisconnect = await controller.submit({ requestId: 'req-3', sourceKey: 'src-3', text: '断连后不该发送' });
  report.afterDisconnect = { submitStatus: afterDisconnect?.status, sends: gateway.calls.sends.length };

  // 结束：直播场次 epoch 变化使原授权失效
  controller.setLiveEpoch('epoch-after-end', Date.now());
  const afterEnd = await controller.submit({ requestId: 'req-4', sourceKey: 'src-4', text: '结束后不该发送' });
  report.afterEnd = { submitStatus: afterEnd?.status, sends: gateway.calls.sends.length };

  // unknown：原请求保留，新动作被拒，不重发
  gateway.setSend(async (request: any) => ({ ok: true, value: { ...(await import('../../test/publicChat/frozenTestGateway')).successfulOperation(request), state: 'unknown' } }));
  const unknownJournal = (await freshJournal('unknown')).journal;
  const unknownController = new PublicChatSendController({ deployment: FROZEN_TEST_DEPLOYMENT, gateway: gateway.gateway, journal: unknownJournal, bounds });
  unknownController.advanceInputConnection();
  unknownController.setLiveEpoch(TEST_LIVE_EPOCH, startedAt);
  await unknownController.refreshQualification();
  await unknownController.authorize();
  const beforeUnknown = gateway.calls.sends.length;
  await unknownController.submit({ requestId: 'req-unknown', sourceKey: 'src-5', text: '结果未知' });
  const unknownDeadline = Date.now() + 5000;
  while (Date.now() < unknownDeadline && unknownController.frozenOperationView('req-unknown')?.state !== 'unknown') {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const afterUnknown = await unknownController.submit({ requestId: 'req-after-unknown', sourceKey: 'src-6', text: '未知后不该发送' });
  const duplicate = await unknownController.submit({ requestId: 'req-unknown', sourceKey: 'src-5', text: '结果未知' });
  report.unknown = {
    state: unknownController.frozenOperationView('req-unknown')?.state,
    hold: unknownController.hold,
    nextStatus: afterUnknown?.status,
    duplicateStatus: duplicate?.status,
    sendsDuringUnknown: gateway.calls.sends.length - beforeUnknown,
  };
  report.journalRecords = existsSync(join(journalDirectory, 'public-chat-operations.json'));
  report.journalCorrupt = unqualifiedJournal.corrupt || authorizedJournal.corrupt || unknownJournal.corrupt;
  return report;
})();

/* ── 私有读取组合（T003 读取子集） ────────────────────────────────────── */

const registrationComposition = await (async () => {
  const report: Record<string, unknown> = {};
  const settingsBefore = await callRoute('/dsh-livestream/registration/settings');
  report.settingsStatus = settingsBefore.status;
  const unauthorizedRead = await callRoute('/dsh-livestream/registration/live/read', { method: 'POST', body: {}, peer: guestPeer });
  report.guestLiveReadStatus = unauthorizedRead.status;
  const authorized = await callRoute('/dsh-livestream/registration/authorize', { method: 'POST', body: {} });
  report.authorization = { status: authorized.status, code: authorized.body?.code ?? null };
  const ownerRead = await callRoute('/dsh-livestream/registration/live/read', { method: 'POST', body: {} });
  report.ownerLiveReadStatus = ownerRead.status;
  report.liveRead = { status: ownerRead.status, matchesFixture: countHits(ownerRead.body) > 0 };
  const robotRead = await callRoute('/dsh-livestream/registration/robot/consume', { method: 'POST', body: {} });
  report.robotRead = { status: robotRead.status, matchesFixture: countHits(robotRead.body) > 0 };
  const revoke = await callRoute('/dsh-livestream/registration/revoke', { method: 'POST', body: {} });
  report.revokeStatus = revoke.status;
  const afterRevoke = await callRoute('/dsh-livestream/registration/live/read', { method: 'POST', body: {} });
  report.afterRevokeRead = { status: afterRevoke.status, containsFixture: countHits(afterRevoke.body) > 0 };
  return report;
})();

/* ── 公开面泄漏扫描 ──────────────────────────────────────────────────── */

function countHits(value: unknown): number {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  if (!text) return 0;
  return text.split(PRIVATE_VALUE).length - 1;
}

async function leakScan() {
  const publicState = await callRoute('/dsh-livestream/state');
  const publicChat = await callRoute('/dsh-livestream/public-chat');
  const agentTurns = [...agents.values()].flatMap((agent) => (agent.session?.snapshotEvents(0) ?? []).map((event: any) => JSON.stringify(event)));
  return {
    publicState: countHits(publicState.body),
    publicChat: countHits(publicChat.body),
    agentTurns: countHits(agentTurns.join('\n')),
    toolInvocations: countHits(toolInvocations),
    stageEvents: countHits(stageEvents),
    stageReceipts: countHits(stageReceipts),
    modelObservations: countHits(modelObservations),
    modelRequests: modelPrivateHits,
    synthesisInputs: ttsPrivateHits,
    ordinaryLogs: ordinaryLogPrivateHits,
    senderGateway: countHits((globalThis as any).__acceptanceSender?.gateway.calls.sends ?? []),
  };
}

/* ── HTTP 服务 ───────────────────────────────────────────────────────── */

async function invokeTool(sessionId: string, name: string, args: Record<string, unknown>) {
  const agent = agents.get(sessionId);
  if (!agent) return { error: 'session not found' };
  const registeredNames = ctx.tools.definitions(agent).map((definition: any) => definition.name);
  const toolSet = await ctx.tools.resolve({ agent, modelSelection: { provider: 'fixture', model: 'model' }, signal: AbortSignal.timeout(10_000) });
  try {
    const names = ctx.tools.schemas(agent, toolSet).map((schema: any) => schema.name);
    observedToolSets.push(names);
    const definition = ctx.tools.executable(name, agent, toolSet);
    if (!definition) return { error: 'tool not visible', names, registeredNames };
    const result = await definition.execute(args, { agent, signal: AbortSignal.timeout(10_000) } as any);
    const rendered = definition.output.render(args, result as any);
    const text = rendered.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n');
    toolInvocations.push({ name, args, status: 'executed', result: text });
    return { ok: true, text, names, registeredNames };
  } finally {
    toolSet.dispose();
  }
}

const app = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      const stageStyle = process.env.DSH_ACCEPTANCE_COURSE_ROOT
        ? 'width:100%;height:180px;border:0;position:sticky;top:0;z-index:2'
        : 'width:100%;height:300px;border:0';
      return res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><iframe title="实际舞台" src="http://127.0.0.1:${stagePort}/?token=fixture" style="${stageStyle}"></iframe><iframe title="静音预览" src="http://127.0.0.1:${stagePort}/?token=fixture&amp;preview=1" style="width:100%;height:150px;border:0"></iframe><div id="root"></div><script src="/client.js"></script></body></html>`);
    }
    if (url.pathname === '/client.js') {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      return res.end(await readFile(join(outputDir, 'client.js')));
    }
    if (url.pathname === '/__acceptance') {
      res.setHeader('content-type', 'application/json');
      const state = await callRoute('/dsh-livestream/state');
      const publicChatView = await callRoute('/dsh-livestream/public-chat');
      const publicChatMaintain = process.env.DSH_ACCEPTANCE_SENDER_MODE === 'offline' ? null
        : await callRoute('/dsh-livestream/public-chat', { method: 'POST', body: { action: 'maintain' } });
      const unauthenticatedAdmission = connection.admit(new Request('http://127.0.0.1/api/dsh-livestream/state', { headers: { host: '127.0.0.1' } }));
      const admission = {
        ownerStatus: (await callRoute('/dsh-livestream/state')).status,
        guestPeerStatus: (await callRoute('/dsh-livestream/state', { peer: guestPeer })).status,
        guestPrincipalKind: guestPeer.principal?.kind ?? null,
        ownerPrincipalKind: ownerPeer.principal?.kind ?? null,
        unauthenticatedStatus: 'rejection' in unauthenticatedAdmission ? unauthenticatedAdmission.rejection : null,
      };
      return res.end(JSON.stringify({
        ports: { app: port, model: modelPort, stage: stagePort, bridge: bridgePort },
        admission,
        publicChat: {
          view: publicChatView.body,
          maintain: publicChatMaintain?.body ?? null,
          senderRequests,
          helperPids: [],
          controller: controllerComposition,
          offlineSender: (globalThis as any).__acceptanceSender ? {
            sends: (globalThis as any).__acceptanceSender.gateway.calls.sends,
            authorizations: (globalThis as any).__acceptanceSender.gateway.calls.authorizations.length,
            revocations: (globalThis as any).__acceptanceSender.gateway.calls.revocations.length,
            proofAccepted: (globalThis as any).__acceptanceSender.proofAccepted,
            proofRejected: (globalThis as any).__acceptanceSender.proofRejected,
          } : null,
        },
        registration: registrationComposition,
        leak: await leakScan(),
        stage: { receipts: stageReceipts, events: stageEvents, audioResults: stageAudioResults },
        course: state.body?.course ?? null,
        onAir: state.body?.show?.onAir ?? null,
        ending: runtime.show.isEnding,
        brain: state.body?.show?.brain ?? null,
        spokenCount: state.body?.show?.lines?.length ?? 0,
        speechAttempts,
        settledSpeech,
        ttsHeld: !!releaseTts,
        observedTurnEnds,
        replyHeld: !!releaseReply,
        releasedModelResponses,
        toolInvocations,
        observedToolSets,
        modelObservations,
        nativeCreates,
        canonicalPaths: { materials: canonicalMaterials, workdir: canonicalWorkDir },
        counters: { sharedRequests, externalRequests },
        hubConnected: runtime.show.hub.isConnected,
        stageEpoch: runtime.show.stage.outputEpoch,
      }));
    }
    if (url.pathname === '/__guard-negative') {
      guardProbe = true;
      let rejected = 0;
      try {
        for (const target of ['http://127.0.0.1:8757/', 'http://192.0.2.1/']) {
          try { await globalThis.fetch(target); } catch { rejected++; }
        }
      } finally { guardProbe = false; }
      return res.end(JSON.stringify({ rejected, ...guardNegative }));
    }
    if (url.pathname === '/__source-event' && process.env.DSH_ACCEPTANCE_SENDER_MODE === 'offline') {
      const rawId = `fixture-event-${randomUUID()}`;
      const timestamp = Date.now();
      if (url.searchParams.get('withoutRaw') !== '1') {
        (globalThis as any).__acceptanceSender.captureRaw(rawId, 'WebcastChatMessage', timestamp);
      }
      const frame = { type: 'chat', platform: 'douyin', roomId: '101', id: rawId,
        rawMethod: 'WebcastChatMessage', ts: timestamp, user: { id: 'fixture-viewer', nickname: '测试观众' },
        data: { content: '合成公屏问题' } };
      for (const socket of bridgeSockets.clients) socket.send(JSON.stringify(frame));
      return res.end(JSON.stringify({ rawId, connections: bridgeSockets.clients.size }));
    }
    if (url.pathname === '/__unknown-next' && process.env.DSH_ACCEPTANCE_SENDER_MODE === 'offline') {
      (globalThis as any).__acceptanceSender.unknownNext = true;
      return res.end('ok');
    }
    if (url.pathname === '/__release-reply') {
      releaseReply?.();
      releaseReply = undefined;
      return res.end('ok');
    }
    if (url.pathname === '/__arm-model') {
      holdNextModel = true;
      return res.end('ok');
    }
    if (url.pathname === '/__stage-stop') {
      stageServer.stop();
      return res.end('ok');
    }
    if (url.pathname === '/__stage-start') {
      await stageServer.start();
      stagePort = Number(new URL(stageServer.url).port);
      if ([3080, 3081, 7390, 8757].includes(stagePort)) throw new Error('shared stage port selected');
      ownedPorts.add(stagePort);
      return res.end(JSON.stringify({ stagePort }));
    }
    if (url.pathname === '/__arm-multisegment') {
      multiSegmentNextResponse = true;
      return res.end('ok');
    }
    if (url.pathname === '/__arm-tts') {
      holdNextTts = true;
      multiSegmentNextResponse = true;
      return res.end('ok');
    }
    if (url.pathname === '/__release-tts') {
      releaseTts?.();
      releaseTts = undefined;
      return res.end('ok');
    }
    if (url.pathname === '/__invoke-tool') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const { sessionId, name, args } = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify(await invokeTool(String(sessionId), String(name), args ?? {})));
    }
    if (url.pathname === '/__legacy-session') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ id: `legacy-${++sessionCount}` }));
    }
    if (url.pathname === '/__managed-session') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const input = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      const created = await callRoute('/dsh-livestream/sessions', { method: 'POST', body: input.workspaceId ? { workspaceId: input.workspaceId } : {} });
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ status: created.status, body: created.body }));
    }
    // 真实 SDK 准入：非 /api 路径之外的请求走真实 HostConnectionService
    if (!url.pathname.startsWith('/api/')) { res.writeHead(404); return res.end(); }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const request = new Request(url, {
      method: req.method,
      headers: {
        'content-type': 'application/json',
        host: `127.0.0.1:${port}`,
        ...(typeof req.headers['x-fixture-owner'] === 'string' ? { 'x-fixture-owner': req.headers['x-fixture-owner'] } : {}),
        ...(typeof req.headers['x-fixture-guest'] === 'string' ? { 'x-fixture-guest': req.headers['x-fixture-guest'] } : {}),
      },
      ...(body.length ? { body } : {}),
    });
    const admitted = connection.admit(request);
    if ('rejection' in admitted) { res.writeHead(admitted.rejection); return res.end(); }
    const response = await handler.fetch(request, admitted.peer);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (!response.body) return res.end();
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  })().catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
});
app.listen(port, '127.0.0.1');
console.log(`acceptance fixture pid=${process.pid} app=${port} model=${modelPort} stage=${stagePort} bridge=${bridgePort}`);

async function shutdown() {
  try {
    await guestPeer.dispose();
    await ownerPeer.dispose();
  } catch { /* peers already gone */ }
  runtime.show.dispose();
  stageServer.stop();
  await ctx.fiber.dispose();
  await connectionContext.fiber.dispose();
  app.closeAllConnections();
  model.closeAllConnections();
  bridge.closeAllConnections();
  bridgeSockets.close();
  app.close();
  model.close();
  bridge.close();
  console.log(`acceptance fixture stopped sharedRequests=${sharedRequests} externalRequests=${externalRequests} remainingFixtureChildren=${fixtureChildPids.size}`);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
