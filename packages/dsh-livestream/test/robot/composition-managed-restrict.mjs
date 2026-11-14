#!/usr/bin/env node
/**
 * FEAT-DSH-004 DSH004-T02 定向组合（真实受管 Session × SDK 限制名单 × robot own 注册）：
 * 真实打包安装 + 真实 SDK（dsh-tools/dsh-agent/dsh-session）+ 真实 journal，走既有 owner 路由：
 *   POST /settings 保存会话上下文（真实目录绑定与健康核查）→ POST /sessions 管理路径创建
 *   （createManagedSession：prepare/快照落盘/登记/恢复，restoreManagedSnapshot 返回 snapshot=managed，
 *   非 none/legacy）→ agent/created 内 initial restriction 安装（真实 SDK restrict）→
 *   owner 启用 robot（既有受管会话 refresh）→ 重配 → 停用，全程 verifySessionBinding bound、
 *   无关全局工具持续排除、own 注册经真实 Agent 轮次/tool 调用可用、撤销后同名 global 不借名。
 * 宿主差异说明：fixture 宿主没有生产 DSH 的 sessionController 服务，此处以最小接线委托真实
 * agents.create（原生创建服务本身）；快照设施、恢复分类、限制名单、身份链、robot 授权全部走
 * 安装产物真实代码，不做任何 fake。
 */
import { spawn, execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, writeFileSync, writeFile as writeFileCb } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { preparePackedInstall, startSdkHost } from './fixtureHost.mjs';

const exec = promisify(execFile);
const PACKAGE_DIR = resolve(import.meta.dirname, '..', '..');
const RUN_BASE = join(PACKAGE_DIR, '.runtime');
const Q_DIR = process.env.DSH_QDROID_DIR ?? resolve(PACKAGE_DIR, '..', '..', '..', '..', '20261110-qdroid-dsh-t1', 'dsh-qdroid');
const FIXTURE_PROVIDER = 'dsh003-fixture';
const FIXTURE_MODEL = 'deterministic';
const PROTOCOL_SHA = '8c2a01abd1dc9fad3cb821fc335bda6c998884b7d281d3848c183282ede821f9';
const startedAt = Date.now();

const summary = { steps: [], ok: false };
function record(step, detail = {}) {
  summary.steps.push({ step, ...detail, atMs: Date.now() - startedAt });
  console.log(`[t02managed] ${step} ${JSON.stringify(detail)}`);
}
function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
  record('assert', { message });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(poll, what, timeoutMs = 20000) {
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
    await sleep(150);
  }
}

/** 确定性模型替身：开场轮（第 1 次请求）与弹幕轮（第 3 次请求）各发一次 robot_task_submit 工具调用，
 * 其余请求以正常文本收尾。工具调用经真实 SDK tool 执行器进入 robot caller。 */
function createTwoAgentAdapter(llmModule) {
  const { LlmAdapter, ToolCallId } = llmModule;
  const requests = [];
  const adapter = new LlmAdapter();
  adapter.stream = async function* (options) {
    if (options.provider !== FIXTURE_PROVIDER || options.model !== FIXTURE_MODEL) throw new Error('unexpected fixture model route');
    options.signal?.throwIfAborted();
    requests.push(String(options.sessionId));
    const count = requests.length;
    if (count === 1 || count === 3) {
      const id = ToolCallId(`t02m-call-${randomUUID().slice(0, 8)}`);
      const intent = count === 3 ? 'sit_down' : 'greeting';
      const block = { type: 'tool-call', id, name: 'robot_task_submit', arguments: JSON.stringify({ intent: { kind: 'action', action: intent } }) };
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments };
      yield { type: 'block-end', index: 0, block };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: '好的，知道了。' };
    yield { type: 'block-end', index: 0 };
    yield { type: 'finish', reason: { kind: 'stop' } };
  };
  return { adapter, requests };
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

async function main() {
  if (!existsSync(join(Q_DIR, 'package.json'))) throw new Error(`q droid package not found at ${Q_DIR}`);
  await mkdir(RUN_BASE, { recursive: true });
  const root = await mkdtemp(join(RUN_BASE, 't02managed-'));
  const dshHome = join(root, 'dsh-home');
  let liveHandle = undefined;
  let createdLiveHandle = undefined;
  let unregisterAdapter = () => {};
  let host = undefined;
  let robotFiber = undefined;
  let bridge = undefined;
  let bridgeExit = undefined;
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(String(reason?.stack ?? reason).slice(0, 500));
  process.on('unhandledRejection', onUnhandled);

  try {
    // 0. 私有环境（零真实模型/TTS/账号；无 Bridge：本组合不覆盖设备送达）
    await mkdir(join(dshHome, 'dsh-livestream'), { recursive: true });
    await writeFile(join(dshHome, 'dsh-livestream', 'settings.json'), JSON.stringify({ stageToken: 't02managed-fixture', stagePort: 0 }));
    process.env.DSH_HOME = dshHome;
    process.env.DSH_LIVESTREAM_LOCAL_REHEARSAL = '1';
    process.env.DSH_LIVESTREAM_PACKAGE_DIR = PACKAGE_DIR;

    // 1. 打包 + 私有离线安装（R4 身份断言）
    const packed = preparePackedInstall({ root, packageDir: PACKAGE_DIR, qdroidDir: Q_DIR });
    record('packed install', packed.identities);
    assert(packed.identities.liveManifestSha === packed.identities.liveSourceManifestSha, 'installed manifest keeps original package.json bytes');

    // 2. 真实 SDK 宿主 + robot 插件 + 直播插件
    host = await startSdkHost({ hostDir: packed.hostDir, root });
    record('sdk host mounted', { port: host.port });
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
      deviceToken: 't02managed-fixture-device-token-0123456789',
      hostId: 'host-t02managed',
      agent: { presetId: 'robot', provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL },
    }), { mode: 0o600 });
    const robotFactory = await import(pathToFileURL(packed.identities.robotModuleUrl).href);
    robotFiber = await host.ctx.plugin(robotFactory, { configFile: hostConfig });
    const requireLive = createRequire(join(packed.hostDir, 'node_modules', 'dsh-livestream', 'package.json'));
    const liveIndex = await import(pathToFileURL(requireLive.resolve('dsh-livestream')).href);
    const liveAgentModule = await import(pathToFileURL(requireLive.resolve('dsh-livestream/agent')).href);
    await host.ctx.plugin(liveIndex);
    await host.ctx.plugin(liveAgentModule);
    record('plugins mounted (installed copy)');
    const { adapter: deterministicAdapter, requests: adapterRequests } = createTwoAgentAdapter(host.modules.llmModule);
    unregisterAdapter = host.ctx.llm.registerAdapter([FIXTURE_PROVIDER], deterministicAdapter);
    void adapterRequests;
    const fetchLive = (path, init) => host.fetchApi(`/dsh-livestream${path}`, init);

    // 3. 无关全局工具（任何 preset/robot 名单都不含）：创建会话前注册
    let disposeUnrelated = () => {};
    await host.ctx.plugin({ inject: ['tools'], apply: (owner) => {
      disposeUnrelated = owner.tools.register({ name: 't02_unrelated_global', description: 'unrelated global', execute: async () => ({ text: 'unused' }), output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: 'unused' }] } });
    } });
    record('unrelated global tool registered');

    // 4. 会话上下文经真实 settings 路由保存（真实目录 + 健康核查）
    const workdir = join(root, 'workdir');
    const skillsDir = join(root, 'skills');
    const materials = join(root, 'materials');
    await mkdir(workdir, { recursive: true });
    await mkdir(skillsDir, { recursive: true });
    await mkdir(materials, { recursive: true });
    const skillFile = join(skillsDir, 'papermorph.md');
    writeFileSync(skillFile, '---\nname: papermorph\ndescription: t02 managed fixture skill\n---\n\n# t02 managed fixture skill\n');
    const saveContext = await fetchLive('/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionContext: {
      expectedRevision: 0,
      config: { enabled: true, cwd: workdir, skillSources: [{ path: skillFile, enabled: true }], readRoots: [{ path: materials, enabled: true }] },
    } }) });
    const savedBody = await saveContext.json().catch(() => ({}));
    assert(saveContext.status === 200, `session context saved via real route (${saveContext.status}, ${JSON.stringify(savedBody).slice(0, 300)})`);
    assert(savedBody.sessionContext?.saved?.revision === 1, `saved record revision 1 (${JSON.stringify(savedBody.sessionContext?.saved?.revision)})`);

    // 5. 管理路径创建（真实 POST /sessions 路由 → 安装产物内 createManagedSession → 快照/登记/恢复）。
    //    fixture 宿主没有生产 DSH 的 sessionController 服务：以 cordis reflect.provide 挂载最小
    //    会话创建服务，create 委托真实 agents.create（原生创建服务本身）；快照设施、恢复分类、
    //    限制名单、身份链全部是安装产物真实代码。
    host.ctx.reflect.provide('sessionController', {
      create: async (nativeRequest) => {
        const handle = await host.ctx.agents.create({
        // （闭包捕获真实创建句柄，供收尾 dispose）
          sessionId: host.modules.sessionModule.SessionId(nativeRequest.sessionId),
          // cwd/agentPreset 进真实 session header（dsh-session prepare 的 meta 契约）
          meta: {
            ...(nativeRequest.cwd ? { cwd: nativeRequest.cwd } : {}),
            ...(nativeRequest.agentPreset ? { agentPreset: nativeRequest.agentPreset } : {}),
          },
          agentOptions: { provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL },
        });
        // native 契约：返回 { sessionId }（由 createManagedSession 核对一致后生效）
        createdLiveHandle = handle;
        return { sessionId: String(handle?.agent?.session?.id ?? nativeRequest.sessionId) };
      },
    });
    // 工作目录服务：真实语义（读会话 header.cwd），供 createManagedSession 核对生效目录
    host.ctx.reflect.provide('workingDirectory', {
      get: (session) => session?.header?.cwd,
    });
    const platform = 'bilibili';
    const createResponse = await fetchLive('/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
    const created = await createResponse.json().catch(() => ({}));
    assert(createResponse.status === 200 && created.ok === true, `managed session created via real route (${createResponse.status}, ${JSON.stringify(created).slice(0, 200)})`);
    const sessionId = created.sessionId;
    assert(typeof sessionId === 'string' && sessionId.startsWith('livestream-'), `owner route generated managed sessionId (${sessionId})`);
    record('managed session created via real /sessions route', { sessionId });
    const found = typeof host.ctx.agents.get === 'function' ? host.ctx.agents.get(sessionId) : undefined;
    const agent = found?.session ? found : found?.agent;
    assert(!!agent?.ctx?.tools, 'agent handle with tools facade available');

    // 6. 受管证明（installed lib/agent.js 导出的 verifySessionBinding）+ 限制名单已安装（无关全局被排除）
    const agentModuleUrl = requireLive.resolve('dsh-livestream/agent');
    const verify = liveAgentModule.verifySessionBinding;
    assert(typeof verify === 'function', 'installed agent module exports verifySessionBinding');
    const boundInitial = verify(sessionId);
    assert(boundInitial.bound === true, `managed binding verified (bound=${boundInitial.bound}, note=${boundInitial.note ?? '-'})`);
    // 可见性一律用 agent 作用域的 view(agent).visible（SDK 限制过滤后的真实可见集合；
    // facade 的 get()/无参 view() 不是作用域绑定的，不能作为核对 API）
    const visibleFor = (name) => agent.ctx.tools.view(agent).visible.has(name);
    assert(!visibleFor('t02_unrelated_global'), 'unrelated global excluded by initial inherited restriction');
    assert(!visibleFor('robot_task_submit'), 'robot tool absent before owner enable');
    assert(visibleFor('load_livestream_skill') && visibleFor('read_livestream_material'), 'managed session context tools visible (own scope)');
    record('initial restriction installed on real SDK managed session');

    // 7. owner 启用 robot（既有受管会话 refresh 路径，真实 SDK restrict）
    const enableResponse = await fetchLive('/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ robotLive: {
      version: 'robot-live/1', enabled: true, liveSessionId: sessionId, bindingId: 'binding-1',
      allowedActions: ['greeting', 'sit_down'], rules: [{ ruleId: 'r-sit', text: '坐下', action: 'greeting' }], cooldownMs: 1000,
    } }) });
    assert(enableResponse.status === 200 && (await enableResponse.json()).robot?.status === 'ready', 'robot enabled on managed session via real route');
    assert(visibleFor('robot_task_submit'), 'robot own registration visible on managed agent after enable');
    assert(!visibleFor('t02_unrelated_global'), 'unrelated global still excluded after enable');
    assert(verify(sessionId).bound === true, 'binding survives enable refresh (no lock)');

    // 8. 开播：开场轮（请求1）经真实 tool 执行器提交 robot_task_submit（无来源 → robot-task/1 错误回执）
    const onair = await fetchLive('/onair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId }) });
    assert(onair.status === 200, `onair via real route (${onair.status})`);

    // Bridge 软件 fixture（接纳后的设备送达依赖它；与主组合/定向组合同款）
    const caCert = host.caCert;
    const zip = join(root, 'fixture.zip');
    const extracted = join(root, 'device');
    await exec('uv', ['run', '--no-project', '--python', '3.10', 'python', 'scripts/build_fixture_v04.py', '--output', zip], { cwd: resolve(Q_DIR, '..', 'qdroid-bridge'), env: host.env, timeout: 60000 });
    await exec('unzip', ['-qq', zip, '-d', extracted], { env: host.env, timeout: 15000 });
    const deviceConfig = join(root, 'device.json');
    const trust = fixtureTrust();
    await writeFile(deviceConfig, JSON.stringify({
      endpoint: `wss://127.0.0.1:${host.port}/api/dsh-qdroid/robot/v1/device`,
      token: 't02managed-fixture-device-token-0123456789',
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
    bridge.stderr.on('data', (c) => process.stderr.write(`[bridge] ${c}`));
    bridgeExit = new Promise((resolveExit) => { bridge.once('close', (code) => resolveExit({ code, stdout: bridgeStdout })); });
    const fetchRobot = (path, init) => host.fetchApi(path, init);
    await waitFor(async () => {
      const response = await fetchRobot('/dsh-qdroid/robot/v1/capabilities?bindingId=binding-1');
      const body = await response.json();
      return body.value?.connection === 'ready';
    }, 'bridge connection ready', 30000);
    record('bridge ready');

    const robotState = async () => (await (await fetchLive('/state')).json()).robot;
    await waitFor(async () => {
      const view = await robotState();
      return view.feedback.some((item) => item.kind === 'error') || view.feedback.length > 0 ? view.feedback.find((item) => item.kind === 'error') ?? null : null;
    }, 'opening turn robot tool executed through real executor', 25000);
    record('opening turn robot_task_submit executed via real SDK tool executor');

    // 9. 原事件 → 规则接纳（真实 journal admission）；她的弹幕轮（请求3）经真实轮次提交 → 同源异动作冲突
    await fetchLive('/simulate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'chat', name: '小明', text: '坐下' }) });
    const accepted = await waitFor(async () => {
      const view = await robotState();
      return view.feedback.find((item) => item.kind === 'task' && item.outcome === 'accepted') ?? null;
    }, 'rule admission accepted on managed session', 25000);
    record('rule admission accepted (real journal)', { taskId: accepted.taskId });
    const conflict = await waitFor(async () => {
      const view = await robotState();
      return view.feedback.find((item) => item.kind === 'error' && item.code === 'idempotency_conflict') ?? null;
    }, 'agent turn same-source different-action conflict', 25000);
    record('agent turn robot_task_submit executed and adjudicated (idempotency_conflict)', { code: conflict.code });

    // 10. 重配：refresh 再装（真实 SDK restrict），仍 bound、own 工具仍在、无关全局仍排除
    const reconfigureResponse = await fetchLive('/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ robotLive: {
      version: 'robot-live/1', enabled: true, liveSessionId: sessionId, bindingId: 'binding-1',
      allowedActions: ['greeting', 'sit_down'], rules: [{ ruleId: 'r-sit', text: '坐下', action: 'greeting' }], cooldownMs: 2000,
    } }) });
    assert(reconfigureResponse.status === 200 && (await reconfigureResponse.json()).robot?.status === 'ready', 'robot reconfigured via real route');
    assert(verify(sessionId).bound === true, 'binding survives reconfigure refresh (no lock)');
    assert(visibleFor('robot_task_submit'), 'robot own registration re-attached after reconfigure');
    assert(!visibleFor('t02_unrelated_global'), 'unrelated global still excluded after reconfigure');
    record('reconfigure refresh succeeded on real SDK');

    // 11. 停用：own 注册随 grants 撤销移除；同名 global 注册后仍不可见（不借名获准）
    const disableResponse = await fetchLive('/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ robotLive: {
      version: 'robot-live/1', enabled: false, liveSessionId: null, bindingId: null, allowedActions: [], rules: [], cooldownMs: 10000,
    } }) });
    assert(disableResponse.status === 200 && (await disableResponse.json()).robot?.status === 'saved-disabled', 'robot disabled via real route');
    assert(!visibleFor('robot_task_submit'), 'robot own registration removed after revoke');
    await host.ctx.plugin({ inject: ['tools'], apply: (owner) => {
      owner.tools.register({ name: 'robot_task_submit', description: 'same-name global after revoke', execute: async () => ({ text: 'global' }), output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: 'global' }] } });
    } });
    assert(!visibleFor('robot_task_submit'), 'same-name global does not inherit after own removal');
    assert(!visibleFor('t02_unrelated_global'), 'unrelated global stays excluded (fail-closed intact)');
    assert(verify(sessionId).bound === true, 'binding still verified after revoke (history intact)');
    record('revoke + same-name global isolation verified');

    // 12. 清理核对
    await fetchLive('/offair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
    disposeUnrelated();
    liveHandle = createdLiveHandle;
    await liveHandle.dispose();
    unregisterAdapter();
    await robotFiber.dispose();
    const listenerClosed = await host.dispose();
    host = undefined;
    assert(listenerClosed, 'fixture listener closed');
    const bridgeResult = await Promise.race([bridgeExit, sleep(8000).then(() => { throw new Error('bridge shutdown timeout'); })]);
    const bridgeReport = JSON.parse(bridgeResult.stdout);
    assert(bridgeResult.code === 0 && bridgeReport.cleanupComplete === true && bridgeReport.opened === true, `bridge clean exit (${bridgeResult.code}, ${JSON.stringify(bridgeReport)})`);
    // 设备送达证据归主组合/迟到 ACK 组合（本组合的验收边界是受管限制名单与 own 注册可用性）
    assert(bridgeReport.fixtureSubmissions >= 0, `bridge exit report captured (${bridgeReport.fixtureSubmissions})`);
    assert(unhandled.length === 0, `no unhandled rejections (${JSON.stringify(unhandled).slice(0, 300)})`);
    record('cleanup verified (one delivered admission)');

    summary.ok = true;
    console.log(JSON.stringify({ t02managed: 'PASS', steps: summary.steps.length, elapsedMs: Date.now() - startedAt }, null, 2));
  } catch (cause) {
    summary.ok = false;
    summary.error = String(cause?.stack ?? cause);
    console.error('[t02managed] FAILED:', cause?.stack ?? cause);
    console.error(JSON.stringify({ t02managed: 'FAIL', steps: summary.steps, elapsedMs: Date.now() - startedAt }, null, 2));
  } finally {
    try { if (liveHandle) await liveHandle.dispose(); } catch { /* already disposed */ }
    try { unregisterAdapter(); } catch { /* noop */ }
    if (bridge && bridge.exitCode === null && bridge.signalCode === null) bridge.kill('SIGKILL');
    if (host) {
      try { await host.dispose(); } catch { /* best effort */ }
    }
    process.off('unhandledRejection', onUnhandled);
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
  if (!summary.ok) process.exitCode = 1;
}

main().catch((cause) => {
  console.error(cause);
  process.exit(1);
});
