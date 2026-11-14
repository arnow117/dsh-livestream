#!/usr/bin/env node
/**
 * FEAT-DSH-004 DSH004-T02 组合验收脚本（修正批次）：真实打包安装的两个插件在同一宿主组合。
 *
 * 安装：两个候选包各自 `npm pack`，在私有宿主目录 `npm install --offline`
 * （本机缓存 APFS 拷贝为私有缓存 + 本地 tarball 补种缺失条目；零网络安装）。
 * 核对安装文件/清单身份与同一 dsh-qdroid 模块实例解析后，在安装产物上挂真实 SDK
 * 服务与 Python Bridge 软件 fixture，跑完整联动旅程：
 *   正常 owner 路径（先建会话 → 后经真实 settings 路由启用）→ 原事件 → 规则接纳 →
 *   她的话题在 followup 前绑定原 receipt → 真实 claimed turn → robot_task_submit
 *   同源异动作冲突 → 动作到达软件 Bridge → 占用期持久 skip → 她对同源提交 duplicate
 *   返回原 skipped 任务 → 聚合拒绝 source_unverified → 正常模型文本收尾 + 确定性豆包
 *   替身 TTS（零真实模型/TTS/OS 音频）→ owner 取消 → 断连真失效（同步撤 grant、零接纳
 *   零发送、hold 保留）→ 停用撤销、历史可读 → 下播仍撤销、清理核对。
 */
import { spawn, execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile, readFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { preparePackedInstall, startSdkHost } from './fixtureHost.mjs';

const exec = promisify(execFile);
const PACKAGE_DIR = resolve(import.meta.dirname, '..', '..');
// 运行目录直接放在 .runtime/ 下（前缀 t02comp-）：packageDir() 从 lib realpath 最多向上找
// 4 层 package.json，过深的嵌套会找不到直播插件包目录。
const RUN_BASE = join(PACKAGE_DIR, '.runtime');
const Q_DIR = process.env.DSH_QDROID_DIR ?? resolve(PACKAGE_DIR, '..', '..', '..', '..', '20261110-qdroid-dsh-t1', 'dsh-qdroid');
const WITH_BRIDGE = process.env.T02_BRIDGE !== '0';
const LIVE_SESSION = 'live-show';
const FIXTURE_PROVIDER = 'dsh003-fixture';
const FIXTURE_MODEL = 'deterministic';
const PROTOCOL_SHA = '8c2a01abd1dc9fad3cb821fc335bda6c998884b7d281d3848c183282ede821f9';
const startedAt = Date.now();

const summary = { steps: [], ok: false };
function record(step, detail = {}) {
  summary.steps.push({ step, ...detail, atMs: Date.now() - startedAt });
  console.log(`[t02] ${step} ${JSON.stringify(detail)}`);
}
function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
  record('assert', { message });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(poll, what, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    let value;
    try {
      value = await poll();
    } catch (pollError) {
      value = `poll-error: ${pollError?.message ?? pollError}`;
    }
    if (value && value !== 'poll-error: undefined') return value;
    last = value;
    if (Date.now() > deadline) {
      throw new Error(`timeout waiting for ${what}; last=${JSON.stringify(last)?.slice(0, 600)}`);
    }
    await sleep(100);
  }
}

/** 确定性模型替身：直播会话按工具请求序号选动作；委派 job 会话执行种子动作。 */
function createTwoAgentAdapter(llmModule) {
  const { LlmAdapter, ToolCallId } = llmModule;
  const sessions = new Map();
  const requests = [];
  class RobotFixtureAdapter extends LlmAdapter {
    constructor(toolName, toolArgumentsOrPicker) {
      super();
      this.toolName = toolName;
      this.pick = typeof toolArgumentsOrPicker === 'function' ? toolArgumentsOrPicker : () => toolArgumentsOrPicker;
      this.count = 0;
    }
    async *stream(options) {
      if (options.provider !== FIXTURE_PROVIDER || options.model !== FIXTURE_MODEL) throw new Error('unexpected fixture model route');
      options.signal?.throwIfAborted();
      requests.push({ sessionId: String(options.sessionId), messages: (options.messages ?? []).length });
      this.count += 1;
      // 奇数次请求发出一次工具调用（开场话题的首次调用没有绑定来源、被拒后；
      // 弹幕话题的下一轮调用才是真正带原 receipt 的提交），偶数次给正常文本收尾结束本轮
      if (this.count % 2 === 1) {
        const id = ToolCallId(`t02-call-${randomUUID().slice(0, 8)}`);
        const block = { type: 'tool-call', id, name: this.toolName, arguments: JSON.stringify(this.pick(this.count)) };
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments };
        yield { type: 'block-end', index: 0, block };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      // F10：正常文本收尾（完整 SDK 的文本流结束 + 直播念话路径）
      const block = { type: 'text', text: '好的，安排上了。' };
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: block.text };
      yield { type: 'block-end', index: 0, block };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  void requests;
  // TwoAgentAdapter 行为：直播会话提交 robot_task_submit；委派 job 会话执行 robot_effect_execute
  const twoAgent = new LlmAdapter();
  twoAgent.stream = async function* (options) {
    const session = String(options.sessionId);
    let inner = sessions.get(session);
    if (!inner) {
      inner = session === LIVE_SESSION
        // 直播会话：第 1 个弹幕话题（第 3 次请求）提交 sit_down —— 同源异动作 → 冲突；
        // 第 2 个弹幕话题提交 greeting —— 规则该源已持久 skip(busy)，duplicate 返回原任务
        ? new RobotFixtureAdapter('robot_task_submit', (request) => ({ intent: { kind: 'action', action: request === 3 ? 'sit_down' : 'greeting' } }))
        // 委派 job 会话：按任务种子动作 greeting 执行
        : new RobotFixtureAdapter('robot_effect_execute', { intent: { kind: 'action', action: 'greeting' } });
      sessions.set(session, inner);
    }
    yield* inner.stream(options);
  };
  return twoAgent;
}

function fixtureTrust() {
  const actions = ['greeting', 'sit_down', 'lie_down', 'stand_up'];
  const capabilities = [
    { kind: 'speech', action: null, resources: ['voice'] },
    { kind: 'display', action: null, resources: ['display'] },
    ...actions.map((action) => ({ kind: 'action', action, resources: ['motion'] })),
    { kind: 'follow', action: null, resources: ['motion'] },
  ].map((entry) => ({ ...entry, support: entry.kind === 'action' ? 'supported' : 'unsupported', ownedStop: entry.kind === 'action' ? 'verified' : 'unsupported' }));
  return {
    deviceId: 'device-1',
    runId: 'run-1',
    artifactSha256: PROTOCOL_SHA,
    control: {
      version: 'robot-control/1',
      protocolArtifactSha256: PROTOCOL_SHA,
      schemaVersion: 'operation/1',
      mode: 'fixture',
      capabilities,
      identity: {
        version: 'identity-reference/1', support: 'unsupported', matcher: 'factory_owned',
        normalizationVersion: 'face-reference-png/1', ownedNamespace: 'unverified', ownedCleanup: 'unverified',
        maxImageBytes: 614400, maxWidth: 640, maxHeight: 640, maxSetBytes: 16777216, maxReferences: 100, maxSets: 2,
      },
    },
    runPolicy: {
      version: 'run-policy/1', profile: 'fixture', workMs: 90000, cleanupMs: 10000, outerTimeoutMs: 130000,
      sourceDispatchMs: { manual: 10000, onsite: 60000, live: 30000 }, jobMs: 30000,
      effectTotalMs: { voice: 120000, motion: 30000, follow: 300000 }, leaseMs: 5000, renewEveryMs: 2000,
      businessLimits: { tasks: 64, inputs: 32, operations: 64, rpcRequests: 256, eventsPerOperation: 64, historyBytes: 4194304 },
    },
    runSupport: {
      profileId: 'fixture-profile', profileSha256: 'b'.repeat(64), status: 'verified', maxWorkMs: 90000,
      maxCleanupMs: 10000, maxOuterTimeoutMs: 130000, maxEffectTotalMs: { voice: 120000, motion: 30000, follow: 300000 },
    },
  };
}

/** 确定性豆包 TTS 替身：拦截 openspeech.bytedance.com，返回固定字节与逐字时间。零真实 TTS 调用。 */
function installDoubaoStub() {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.hostname === 'openspeech.bytedance.com') {
      let body = {};
      try { body = JSON.parse(String(init.body ?? '{}')); } catch { /* ignore */ }
      const text = body?.req_params?.text ?? '';
      calls.push({ text, speaker: body?.req_params?.speaker });
      const words = [...text].slice(0, 8).map((word, index) => ({ word, startTime: index * 0.2, endTime: index * 0.2 + 0.18 }));
      const payload = [
        JSON.stringify({ data: Buffer.from('fixture-mp3-bytes').toString('base64') }),
        JSON.stringify({ sentence: { words } }),
      ].join('\n');
      return new Response(payload, { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    return originalFetch(input, init);
  };
  return { calls, restore: () => { globalThis.fetch = originalFetch; } };
}

async function main() {
  if (!existsSync(join(Q_DIR, 'package.json'))) throw new Error(`q droid package not found at ${Q_DIR}`);
  await mkdir(RUN_BASE, { recursive: true });
  const root = await mkdtemp(join(RUN_BASE, 't02comp-'));
  const dshHome = join(root, 'dsh-home');
  let bridge = undefined;
  let bridgeExit = undefined;
  let liveHandle = undefined;
  let unregisterAdapter = () => {};
  let host = undefined;
  let caCert = undefined;
  let robotFiber = undefined;
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(String(reason?.stack ?? reason).slice(0, 500));
  process.on('unhandledRejection', onUnhandled);
  const doubao = installDoubaoStub();

  try {
    // 0. 私有环境：DSH_HOME、本地彩排、确定性豆包凭据；settings 不含 robotLive（正常 owner 路径先建会话后启用）
    await mkdir(join(dshHome, 'dsh-livestream'), { recursive: true });
    await writeFile(join(dshHome, 'dsh-livestream', 'settings.json'), JSON.stringify({
      stageToken: 't02-fixture', stagePort: 0,
      // 音色用 S_ 前缀（新控制台路由）：只需 apiKey，与替身拦截的单一请求形态一致
      tts: { backend: 'doubao', doubaoVoice: 'S_t02_fixture', doubaoRate: 0, yovoiceModel: 'voxcpm2-q8', yovoiceVoice: 't02 测试音色', macosVoice: 'Tingting' },
    }));
    process.env.DSH_HOME = dshHome;
    process.env.DSH_LIVESTREAM_LOCAL_REHEARSAL = '1';
    process.env.DSH_LIVESTREAM_PACKAGE_DIR = PACKAGE_DIR;
    process.env.DOUBAO_TTS_API_KEY = 't02-fixture-key';
    delete process.env.DOUBAO_TTS_APP_ID;
    delete process.env.DOUBAO_TTS_ACCESS_KEY;

    // 1. 打包 + 私有离线安装 + 安装/模块身份核对
    const packed = preparePackedInstall({ root, packageDir: PACKAGE_DIR, qdroidDir: Q_DIR });
    record('packed install', packed.identities);
    assert(packed.identities.qdroidFixtureSha === packed.identities.qdroidSourceSha, 'installed dsh-qdroid matches accepted candidate');
    assert(packed.identities.liveIndexSha === packed.identities.liveCandidateSha, 'installed dsh-livestream matches candidate build');

    // 2. 安装产物上的真实 SDK 宿主
    host = await startSdkHost({ hostDir: packed.hostDir, root });
    caCert = host.caCert;
    record('sdk host mounted', { port: host.port });

    // 3. robot 插件（安装产物；journal 私有目录 0700）
    const binding = { ownerRef: 'owner-1', bindingId: 'binding-1', deviceRef: 'device-1', bindingEpoch: 1 };
    const journalDir = join(root, 'journal');
    await mkdir(journalDir, { recursive: true });
    await chmod(journalDir, 0o700);
    const hostConfig = join(root, 'host.json');
    await writeFile(hostConfig, JSON.stringify({
      journalDir,
      journalId: randomUUID(),
      setup: true,
      binding,
      allowedActions: ['greeting', 'sit_down', 'lie_down', 'stand_up'],
      trust: fixtureTrust(),
      deviceToken: 't02-fixture-device-token-0123456789012345',
      hostId: 'host-t02',
      agent: { presetId: 'robot', provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL },
    }), { mode: 0o600 });
    const robotFactory = await import(pathToFileURL(packed.identities.robotModuleUrl).href);
    robotFiber = await host.ctx.plugin(robotFactory, { configFile: hostConfig });
    record('robot plugin mounted (installed copy)');

    // 4. 安装产物的直播根/agent 插件挂上同一宿主
    const requireLive = createRequire(join(packed.hostDir, 'node_modules', 'dsh-livestream', 'package.json'));
    const liveIndexUrl = requireLive.resolve('dsh-livestream');
    const liveAgentUrl = requireLive.resolve('dsh-livestream/agent');
    const liveIndex = await import(pathToFileURL(liveIndexUrl).href);
    const liveAgent = await import(pathToFileURL(liveAgentUrl).href);
    assert(liveIndex.name === 'dsh-livestream' && liveAgent.name === 'dsh-livestream-agent', 'livestream plugin identities');
    await host.ctx.plugin(liveIndex);
    await host.ctx.plugin(liveAgent);
    record('livestream plugins mounted (installed copy)', { liveIndexUrl, liveAgentUrl });

    const fetchLive = (path, init) => host.fetchApi(`/dsh-livestream${path}`, init);
    const fetchRobot = (path, init) => host.fetchApi(path, init);

    // 5. 正常 owner 路径：先建她的会话（robot 未配置），再经真实 settings 路由启用联动
    const adapter = createTwoAgentAdapter(host.modules.llmModule);
    unregisterAdapter = host.ctx.llm.registerAdapter([FIXTURE_PROVIDER], adapter);
    liveHandle = await host.ctx.agents.create({ sessionId: host.modules.sessionModule.SessionId(LIVE_SESSION), agentOptions: { provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL } });
    record('live session created before configuration');
    const saveResponse = await fetchLive('/settings', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ robotLive: {
        version: 'robot-live/1', enabled: true, liveSessionId: LIVE_SESSION, bindingId: 'binding-1',
        allowedActions: ['greeting', 'sit_down'],
        rules: [
          { ruleId: 'r-sit', text: '坐下', action: 'greeting' },
          { ruleId: 'r-hello', text: '你好', action: 'greeting' },
        ],
        cooldownMs: 1000,
      } }),
    });
    assert(saveResponse.status === 200, `settings save via real route (${saveResponse.status})`);
    const savedState = await saveResponse.json();
    assert(savedState.robot?.status === 'ready', `final assembly status in save response (${savedState.robot?.status})`);
    assert(savedState.robot?.binding?.version === 'robot-live/1' && savedState.robot?.binding?.journalSchemaVersion === 2, `binding handshake ${JSON.stringify(savedState.robot?.binding)}`);
    record('first enable on existing session via real route');

    // 6. 开播（真实 onair 路由）
    const onair = await fetchLive('/onair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: LIVE_SESSION }) });
    assert(onair.status === 200, `onair via real route (${onair.status})`);
    record('live session on air');

    // 7. bridge 软件 fixture（可选；默认开）
    if (WITH_BRIDGE) {
      const zip = join(root, 'fixture.zip');
      const extracted = join(root, 'device');
      await exec('uv', ['run', '--no-project', '--python', '3.10', 'python', 'scripts/build_fixture_v04.py', '--output', zip], { cwd: resolve(Q_DIR, '..', 'qdroid-bridge'), env: host.env, timeout: 60000 });
      await exec('unzip', ['-qq', zip, '-d', extracted], { env: host.env, timeout: 15000 });
      const deviceConfig = join(root, 'device.json');
      const trust = fixtureTrust();
      await writeFile(deviceConfig, JSON.stringify({
        endpoint: `wss://127.0.0.1:${host.port}/api/dsh-qdroid/robot/v1/device`,
        token: 't02-fixture-device-token-0123456789012345',
        deviceId: trust.deviceId,
        runId: trust.runId,
        package: { packageId: 'fixture', version: '1', artifactSha256: 'c'.repeat(64) },
        control: trust.control,
        runPolicy: trust.runPolicy,
        runSupport: trust.runSupport,
        protocolArtifactSha256: PROTOCOL_SHA,
        protocolBundle: join(Q_DIR, 'assets', 'qdroid-io-0.4-fixture-8c2a01abd1dc.tar'),
        allowLoopbackWs: false,
        caFile: caCert,
      }), { mode: 0o600 });
      bridge = spawn('uv', ['run', '--no-project', '--python', '3.10', 'python', '-I', 'scripts/run_fixture_v04.py', '--config', deviceConfig], { cwd: extracted, env: host.env, stdio: ['pipe', 'pipe', 'pipe'] });
      let bridgeStdout = '';
      bridge.stdout.on('data', (c) => { bridgeStdout += c; });
      bridge.stderr.on('data', (c) => { process.stderr.write(`[bridge] ${c}`); });
      bridgeExit = new Promise((resolveExit, rejectExit) => { bridge.once('error', rejectExit); bridge.once('close', (code) => resolveExit({ code, stdout: bridgeStdout })); });
      await waitFor(async () => {
        const response = await fetchRobot(`/dsh-qdroid/robot/v1/capabilities?bindingId=binding-1`);
        const body = await response.json();
        return body.value?.connection === 'ready';
      }, 'bridge connection ready', 30000);
      record('bridge ready');
    }

    const robotState = async () => (await (await fetchLive('/state')).json()).robot;
    const showState = async () => (await (await fetchLive('/state')).json()).show;
    const getRobotTask = async (taskId) => {
      const response = await fetchRobot(`/dsh-qdroid/robot/v1/tasks/${taskId}`);
      return { status: response.status, body: await response.json() };
    };

    // 8. 原事件 1：『坐下』→ 规则接纳 T1（greeting）；她的话题 → agent 提交 sit_down → 同源异动作冲突
    await fetchLive('/simulate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'chat', name: '小明', text: '坐下' }) });
    const first = await waitFor(async () => {
      const view = await robotState();
      const task = view.feedback.find((item) => item.kind === 'task' && item.outcome === 'accepted');
      return task ?? null;
    }, 'rule accepted first event');
    const firstTaskId = first.taskId;
    assert(/^[-0-9a-f]{36}$/.test(firstTaskId), `first task id (${firstTaskId})`);
    record('rule accepted', { taskId: firstTaskId });
    // 她的提交（agent 路径，既有会话已补装 caller）：同一原事件、不同动作 → 冲突
    const conflict = await waitFor(async () => {
      const view = await robotState();
      const item = view.feedback.find((entry) => entry.kind === 'error' && entry.code === 'idempotency_conflict');
      return item ?? null;
    }, 'agent same-source different-action conflict', 20000);
    record('agent conflict (existing-session caller works)', { code: conflict.code });
    const firstTask = await getRobotTask(firstTaskId);
    assert(firstTask.status === 200, 'owner can read the first task via robot route');
    assert(firstTask.body.value.sourceKind === 'live_rule', `first task sourceKind (${firstTask.body.value.sourceKind})`);
    assert(firstTask.body.value.operations.length === 1, `single motion operation (${firstTask.body.value.operations.length})`);
    if (WITH_BRIDGE) {
      let lastOpDump = 'none';
      const deadline = Date.now() + 15000;
      let deliveredSeen = false;
      while (Date.now() < deadline) {
        const task = await getRobotTask(firstTaskId);
        const op = task.body.value.operations[0];
        lastOpDump = JSON.stringify({ outcome: op?.outcome, sendState: op?.sendState, nativeAccepted: op?.nativeAccepted, job: task.body.value.job, phase: task.body.value.phase });
        if (op?.nativeAccepted === true && task.body.value.job === 'idle') { deliveredSeen = true; break; }
        await sleep(200);
      }
      assert(deliveredSeen, `first action delivered to software bridge; last op=${lastOpDump}`);
      record('bridge delivery evidence', { taskId: firstTaskId, op: lastOpDump });
    }

    // 9. 占用期持久 skip：motion hold 先于冷却（busy），零 operation
    await fetchLive('/simulate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'chat', name: '小红', text: '坐下' }) });
    const skipped = await waitFor(async () => {
      const view = await robotState();
      const item = view.feedback.find((entry) => entry.kind === 'task' && entry.outcome === 'skipped');
      return item ?? null;
    }, 'busy/cooldown skip');
    const skippedTask = await getRobotTask(skipped.taskId);
    assert(skippedTask.body.value.phase === 'skipped' && skippedTask.body.value.reason === 'busy', `skip reason (${skippedTask.body.value.reason})`);
    assert(skippedTask.body.value.operations.length === 0, 'skipped task has no operations');
    record('busy skip persisted', { taskId: skipped.taskId });

    // 10. 第二原事件：规则持久 skip；她提交 greeting → duplicate 返回原 skipped 任务
    await fetchLive('/simulate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'chat', name: '小刚', text: '你好' }) });
    const second = await waitFor(async () => {
      const view = await robotState();
      const skips = view.feedback.filter((item) => item.kind === 'task' && item.outcome === 'skipped');
      return skips.length >= 2 ? skips[0] : null;
    }, 'rule skipped second event');
    const secondTaskId = second.taskId;
    assert(secondTaskId !== firstTaskId, 'second event got its own skipped task');
    const duplicate = await waitFor(async () => {
      const view = await robotState();
      const item = view.feedback.find((entry) => entry.kind === 'task' && entry.outcome === 'duplicate');
      return item ?? null;
    }, 'agent duplicate submission', 20000);
    assert(duplicate.taskId === secondTaskId, `agent duplicate returns the original skipped task (${duplicate.taskId} vs ${secondTaskId})`);
    const secondTask = await getRobotTask(secondTaskId);
    assert(secondTask.body.value.phase === 'skipped' && secondTask.body.value.job === 'none', `skipped task stays skipped without job (${secondTask.body.value.phase}/${secondTask.body.value.job})`);
    record('same source duplicate of skipped task', { taskId: secondTaskId });

    // 11. 聚合歧义：同一观众两条合并为一个 pick → 零新接纳 + agent 请求 source_unverified
    await fetchLive('/simulate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'chat', name: '小聚合', text: '第一条' }) });
    await sleep(50);
    await fetchLive('/simulate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'chat', name: '小聚合', text: '第二条' }) });
    await sleep(1800);
    const afterAgg = await robotState();
    const aggAccepted = afterAgg.feedback.filter((item) => item.kind === 'task' && item.outcome === 'accepted').length;
    assert(aggAccepted === 1, `aggregated pick creates no new acceptance (${aggAccepted}/1)`);
    const aggUnverified = afterAgg.feedback.filter((item) => item.kind === 'error' && item.code === 'source_unverified').length;
    assert(aggUnverified >= 1, `agent attempt on aggregated pick denied as source_unverified (${aggUnverified})`);
    record('aggregation ambiguity rejected', { acceptedTotal: aggAccepted, sourceUnverified: aggUnverified });

    // 12. F10：正常模型文本收尾 + 确定性豆包替身 TTS（零真实模型/TTS/OS 音频调用）
    const spokenLine = await waitFor(async () => {
      const status = await showState();
      const line = status.lines?.find((item) => item.text.includes('好的，安排上了'));
      return line ?? null;
    }, 'normal text completion spoken through live path', 30000);
    record('normal text stream completed and voiced', { text: spokenLine.text, mood: spokenLine.mood });
    const doubaoCall = doubao.calls.find((call) => call.text.includes('好的，安排上了'));
    assert(!!doubaoCall, `deterministic TTS stub served her line (${JSON.stringify(doubao.calls).slice(0, 200)})`);
    record('deterministic doubao substitute exercised', { speaker: doubaoCall?.speaker });

    // 13. owner 原任务取消（受理，不等于停止）
    const cancelResponse = await fetchRobot(`/dsh-qdroid/robot/v1/tasks/${secondTaskId}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestKey: randomUUID() }) });
    assert(cancelResponse.status === 200, `owner cancel accepted (${cancelResponse.status})`);
    const cancelled = (await cancelResponse.json()).value;
    assert(cancelled.cancelAccepted === true, 'cancelAccepted true');
    record('owner cancel accepted', { taskId: secondTaskId });

    // 13.5 F2 真失效（真实安装链路）：断开直播间连接在失效动作的同一同步段撤销原 grant——
    // 断连后的原事件零 capture、零接纳、零发送；在途 unknown/hold 按原语义保留；
    // 恢复动作资格必须 owner 重新装配，不自动复活旧来源。
    const beforeDisconnect = await robotState();
    const acceptedBeforeDisconnect = beforeDisconnect.feedback.filter((item) => item.kind === 'task' && item.outcome === 'accepted').length;
    const taskRowsBefore = new Set(beforeDisconnect.tasks.map((item) => item.taskId));
    const liveStateBefore = await (await fetchLive('/state')).json();
    const disconnectResponse = await fetchLive('/disconnect', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ controlRevision: liveStateBefore.roomControl?.controlRevision }),
    });
    assert(disconnectResponse.status === 200, `disconnect via real route (${disconnectResponse.status})`);
    record('room disconnected via real route');
    // 撤销前快照既有记录：断连撤销不得改动/追加已存在的任务与操作
    const holdBeforeDisconnect = await getRobotTask(firstTaskId);
    assert(holdBeforeDisconnect.status === 200, 'first task readable before disconnect');
    // 断连后的原弹幕：直播照常接收，但机器人来源 fail closed
    const afterDisconnectInject = await fetchLive('/simulate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'chat', name: '小断连', text: '坐下' }) });
    assert(afterDisconnectInject.status === 200, 'live keeps receiving events after disconnect');
    await sleep(1200);
    const afterDisconnect = await robotState();
    const acceptedAfterDisconnect = afterDisconnect.feedback.filter((item) => item.kind === 'task' && item.outcome === 'accepted').length;
    assert(acceptedAfterDisconnect === acceptedBeforeDisconnect, `no admission after disconnect (${acceptedAfterDisconnect}/${acceptedBeforeDisconnect})`);
    const taskRowsAfter = new Set(afterDisconnect.tasks.map((item) => item.taskId));
    assert(taskRowsAfter.size === taskRowsBefore.size && [...taskRowsBefore].every((id) => taskRowsAfter.has(id)), `no new task rows after disconnect (${taskRowsAfter.size}/${taskRowsBefore.size})`);
    assert(afterDisconnect.binding === null, 'live grant revoked on disconnect (binding null)');
    // 既有记录原样保留（phase 随动作完成自然流转，撤销不改动它；unknown/hold 语义归 Q 侧 T01）
    const holdIntact = await getRobotTask(firstTaskId);
    const phaseBefore = holdBeforeDisconnect.body.value?.phase;
    assert(holdIntact.status === 200
      && holdIntact.body.value?.phase === phaseBefore
      && holdIntact.body.value?.operations?.length === holdBeforeDisconnect.body.value?.operations?.length
      && holdIntact.body.value?.operations?.[0]?.operationId === holdBeforeDisconnect.body.value?.operations?.[0]?.operationId,
    `existing task untouched by revocation (phase=${holdIntact.body.value?.phase}/${phaseBefore})`);
    record('disconnect truly revokes grant; zero admission/send; existing records untouched');

    // 14. 停用联动（真实 settings 路由，空 binding）：撤销用已安装目标真实 revision，不猜 0
    const disableResponse = await fetchLive('/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ robotLive: {
      version: 'robot-live/1', enabled: false, liveSessionId: null, bindingId: null,
      allowedActions: [], rules: [], cooldownMs: 10000,
    } }) });
    assert(disableResponse.status === 200, `disable save (${disableResponse.status})`);
    const disabledState = await disableResponse.json();
    // 停用：提交资格全部撤销；binding 句柄保留在已停用目标上（owner 历史/后续重启用都读它），
    // 权威事实是机器人在册策略 enabled=false
    assert(disabledState.robot?.status === 'saved-disabled', `disable status (${disabledState.robot?.status})`);
    assert(disabledState.robot?.policy?.enabled === false, `journal policy disabled (${JSON.stringify(disabledState.robot?.policy)})`);
    const history = await getRobotTask(secondTaskId);
    assert(history.status === 200, 'owner history readable after disable');
    const afterDisableInject = await fetchLive('/simulate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'chat', name: '小停用', text: '坐下' }) });
    assert(afterDisableInject.status === 200, 'live keeps working with robot disabled');
    await sleep(400);
    const viewAfterDisable = await robotState();
    const disabledAccepted = viewAfterDisable.feedback.filter((item) => item.kind === 'task' && item.outcome === 'accepted').length;
    assert(disabledAccepted === 1, `no new acceptance while disabled (${disabledAccepted}/1)`);
    record('disable revokes binding, history intact');

    // 15. 收尾：下播、撤会话、撤插件，核对清理
    await fetchLive('/offair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
    const afterOffair = await robotState();
    assert(afterOffair.binding === null, 'offair keeps the grant revoked (binding null)');
    await liveHandle.dispose();
    unregisterAdapter();
    await robotFiber.dispose();
    const listenerClosed = await host.dispose();
    host = undefined;
    assert(listenerClosed, 'fixture listener closed');
    if (bridgeExit) {
      const result = await Promise.race([bridgeExit, sleep(8000).then(() => { throw new Error('bridge shutdown timeout'); })]);
      const report = JSON.parse(result.stdout);
      assert(result.code === 0 && report.cleanupComplete === true && report.opened === true, `bridge clean exit (${result.code}, ${JSON.stringify(report)})`);
      // 全程只有 step 8 的动作真正送达设备（撤销/占用/截留路径一律零发送）
      assert(report.fixtureSubmissions === 1, `exactly one device submission across the whole run (${report.fixtureSubmissions})`);
      record('bridge exit report', report);
    }
    assert(unhandled.length === 0, `no unhandled rejections (${JSON.stringify(unhandled).slice(0, 300)})`);
    record('cleanup verified');

    summary.ok = true;
    summary.identities = packed.identities;
    console.log(JSON.stringify({ t02composition: 'PASS', steps: summary.steps.length, elapsedMs: Date.now() - startedAt }, null, 2));
  } catch (cause) {
    summary.ok = false;
    summary.error = String(cause?.stack ?? cause);
    console.error('[t02] FAILED:', cause?.stack ?? cause);
    console.error(JSON.stringify({ t02composition: 'FAIL', steps: summary.steps, elapsedMs: Date.now() - startedAt }, null, 2));
  } finally {
    try { if (liveHandle) await liveHandle.dispose(); } catch { /* already disposed */ }
    try { unregisterAdapter(); } catch { /* noop */ }
    if (bridge && bridge.exitCode === null && bridge.signalCode === null) {
      bridge.kill('SIGKILL');
    }
    if (host) {
      try { await host.dispose(); } catch { /* best effort */ }
    }
    doubao.restore();
    process.off('unhandledRejection', onUnhandled);
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
  if (!summary.ok) process.exitCode = 1;
}

main().catch((cause) => {
  console.error(cause);
  process.exit(1);
});
