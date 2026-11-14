#!/usr/bin/env node
/**
 * FEAT-DSH-004 DSH004-T02 定向组合（迟到 admission ACK × 真实撤销链路）：
 * 真实打包安装 + 真实 SDK 宿主 + 真实 journal worker + 真实 Bridge 的最小组合，专门证明：
 *   规则接纳的 admission 在 journal 已 committed、ACK 未达时，经真实 /disconnect 路由
 *   同步撤销原 Host grant → 释放迟到的 ACK → 任务落在 unknown/not_sent（零 Bridge 发送）。
 * 采用 Q tests/integration/robot-live-fixture.test.ts 同款 Worker.prototype.emit 截留技术
 * （finally 恢复原始 emit；串行任务私有进程；只截留本组合 journal 的 committed-admit）。
 * 与主组合（composition.mjs，完整旅程+送达证据）互补；两者共享 fixtureHost 打包安装。
 */
import { spawn, execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync } from 'node:fs';
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
const LIVE_SESSION = 'live-late-ack';
const FIXTURE_PROVIDER = 'dsh003-fixture';
const FIXTURE_MODEL = 'deterministic';
const PROTOCOL_SHA = '8c2a01abd1dc9fad3cb821fc335bda6c998884b7d281d3848c183282ede821f9';
const startedAt = Date.now();

const summary = { steps: [], ok: false };
function record(step, detail = {}) {
  summary.steps.push({ step, ...detail, atMs: Date.now() - startedAt });
  console.log(`[t02late] ${step} ${JSON.stringify(detail)}`);
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

/** 确定性模型替身：她的轮次永远以正常文本收尾（零真实模型/TTS；轮次不参与本组合断言）。 */
function createQuietAdapter(llmModule) {
  const { LlmAdapter } = llmModule;
  const adapter = new LlmAdapter();
  adapter.stream = async function* (options) {
    if (options.provider !== FIXTURE_PROVIDER || options.model !== FIXTURE_MODEL) throw new Error('unexpected fixture model route');
    options.signal?.throwIfAborted();
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: '好的，先不动。' };
    yield { type: 'block-end', index: 0 };
    yield { type: 'finish', reason: { kind: 'stop' } };
  };
  return adapter;
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
  const root = await mkdtemp(join(RUN_BASE, 't02late-'));
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

  try {
    // 0. 私有环境（零真实模型/TTS/账号）
    await mkdir(join(dshHome, 'dsh-livestream'), { recursive: true });
    await writeFile(join(dshHome, 'dsh-livestream', 'settings.json'), JSON.stringify({ stageToken: 't02late-fixture', stagePort: 0 }));
    process.env.DSH_HOME = dshHome;
    process.env.DSH_LIVESTREAM_LOCAL_REHEARSAL = '1';
    process.env.DSH_LIVESTREAM_PACKAGE_DIR = PACKAGE_DIR;

    // 1. 打包 + 私有离线安装（R4：root README/LICENSE 必需且字节一致）
    const packed = preparePackedInstall({ root, packageDir: PACKAGE_DIR, qdroidDir: Q_DIR });
    record('packed install', packed.identities);
    assert(packed.identities.qdroidFixtureSha === packed.identities.qdroidSourceSha, 'installed dsh-qdroid matches accepted candidate');
    assert(packed.identities.liveIndexSha === packed.identities.liveCandidateSha, 'installed dsh-livestream matches candidate build');
    assert(packed.identities.liveManifestSha === packed.identities.liveSourceManifestSha, 'installed manifest keeps original package.json bytes');

    // 2. 真实 SDK 宿主 + robot 插件 + 直播插件
    host = await startSdkHost({ hostDir: packed.hostDir, root });
    caCert = host.caCert;
    record('sdk host mounted', { port: host.port });
    const binding = { ownerRef: 'owner-1', bindingId: 'binding-1', deviceRef: 'device-1', bindingEpoch: 1 };
    const journalDir = join(root, 'journal');
    await mkdir(journalDir, { recursive: true });
    await chmod(journalDir, 0o700);
    const journalIdValue = randomUUID();
    const hostConfig = join(root, 'host.json');
    await writeFile(hostConfig, JSON.stringify({
      journalDir,
      journalId: journalIdValue,
      setup: true,
      binding,
      allowedActions: ['greeting', 'sit_down', 'lie_down', 'stand_up'],
      trust: fixtureTrust(),
      deviceToken: 't02late-fixture-device-token-012345678901',
      hostId: 'host-t02late',
      agent: { presetId: 'robot', provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL },
    }), { mode: 0o600 });
    const robotFactory = await import(pathToFileURL(packed.identities.robotModuleUrl).href);
    robotFiber = await host.ctx.plugin(robotFactory, { configFile: hostConfig });
    const requireLive = createRequire(join(packed.hostDir, 'node_modules', 'dsh-livestream', 'package.json'));
    const liveIndex = await import(pathToFileURL(requireLive.resolve('dsh-livestream')).href);
    const liveAgent = await import(pathToFileURL(requireLive.resolve('dsh-livestream/agent')).href);
    await host.ctx.plugin(liveIndex);
    await host.ctx.plugin(liveAgent);
    record('plugins mounted (installed copy)');
    const fetchLive = (path, init) => host.fetchApi(`/dsh-livestream${path}`, init);
    const fetchRobot = (path, init) => host.fetchApi(path, init);

    // 3. 建会话 → 启用 → 开播（真实路由）
    unregisterAdapter = host.ctx.llm.registerAdapter([FIXTURE_PROVIDER], createQuietAdapter(host.modules.llmModule));
    liveHandle = await host.ctx.agents.create({ sessionId: host.modules.sessionModule.SessionId(LIVE_SESSION), agentOptions: { provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL } });
    const saveResponse = await fetchLive('/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ robotLive: {
      version: 'robot-live/1', enabled: true, liveSessionId: LIVE_SESSION, bindingId: 'binding-1',
      allowedActions: ['greeting', 'sit_down'], rules: [{ ruleId: 'r-sit', text: '坐下', action: 'greeting' }], cooldownMs: 1000,
    } }) });
    assert(saveResponse.status === 200 && (await saveResponse.json()).robot?.status === 'ready', 'enabled assembly ready via real route');
    const onair = await fetchLive('/onair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: LIVE_SESSION }) });
    assert(onair.status === 200, `onair via real route (${onair.status})`);

    // 4. Bridge 软件 fixture
    const zip = join(root, 'fixture.zip');
    const extracted = join(root, 'device');
    await exec('uv', ['run', '--no-project', '--python', '3.10', 'python', 'scripts/build_fixture_v04.py', '--output', zip], { cwd: resolve(Q_DIR, '..', 'qdroid-bridge'), env: host.env, timeout: 60000 });
    await exec('unzip', ['-qq', zip, '-d', extracted], { env: host.env, timeout: 15000 });
    const deviceConfig = join(root, 'device.json');
    const trust = fixtureTrust();
    await writeFile(deviceConfig, JSON.stringify({
      endpoint: `wss://127.0.0.1:${host.port}/api/dsh-qdroid/robot/v1/device`,
      token: 't02late-fixture-device-token-012345678901',
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
    await waitFor(async () => {
      const response = await fetchRobot(`/dsh-qdroid/robot/v1/capabilities?bindingId=binding-1`);
      const body = await response.json();
      return body.value?.connection === 'ready';
    }, 'bridge connection ready', 30000);
    record('bridge ready');

    // 5. 截留 journal worker 的 committed-admit ACK（Q T01 同款技术；finally 恢复原 emit）
    const { Worker } = await import('node:worker_threads');
    const originalEmit = Worker.prototype.emit;
    let held;
    let inFlightTaskId;
    Worker.prototype.emit = function (event, ...args) {
      const message = args[0];
      if (event === 'message' && !held && message?.status === 'committed' && message.result?.kind === 'admit' && message.result?.decision === 'accepted' && message.result?.task) {
        held = { worker: this, message };
        return true;
      }
      return originalEmit.call(this, event, ...args);
    };
    try {
      // 6. 原事件 → 规则接纳 → admission committed 但 ACK 被截留（evaluate 悬在 ACK 上）
      await fetchLive('/simulate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'chat', name: '小在途', text: '坐下' }) });
      await waitFor(async () => (held ?? null), 'committed admission ack to hold (fresh env first admission)', 20000);
      inFlightTaskId = held.message.result.task.taskId;
      record('admission ack held in flight', { taskId: inFlightTaskId });

      // 7. ACK 未达时经真实 /disconnect 路由同步撤权
      const disconnectResponse = await fetchLive('/disconnect', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ controlRevision: (await (await fetchLive('/state')).json()).roomControl?.controlRevision }),
      });
      assert(disconnectResponse.status === 200, `disconnect via real route while ack pending (${disconnectResponse.status})`);
      const duringAckView = await (await fetchLive('/state')).json().then((state) => state.robot);
      assert(duringAckView.binding === null, 'live grant synchronously revoked while admission ack pending');
      record('grant revoked while ack pending');

      // 8. 释放迟到的 ACK：撤销已先行，零设备发送（任务终态在收尾用 journal 直接核对——
      // 撤销后 owner 任务路由按合同不再可用，与 Q T01 的 journal 重开核对方式一致）
      originalEmit.call(held.worker, 'message', held.message);
      await sleep(2000);
      record('late admission ack released after revocation', { taskId: inFlightTaskId });
    } finally {
      Worker.prototype.emit = originalEmit;
      if (held && held.message) {
        // 兜底释放，避免 worker 提交 promise 悬挂影响清理
        originalEmit.call(held.worker, 'message', held.message);
      }
    }

    // 9. 收尾核对：Bridge 零发送干净退出 + journal 直接核对任务终态
    await fetchLive('/offair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
    await liveHandle.dispose();
    unregisterAdapter();
    await robotFiber.dispose();
    const listenerClosed = await host.dispose();
    host = undefined;
    assert(listenerClosed, 'fixture listener closed');
    const result = await Promise.race([bridgeExit, sleep(8000).then(() => { throw new Error('bridge shutdown timeout'); })]);
    const report = JSON.parse(result.stdout);
    assert(result.code === 0 && report.cleanupComplete === true && report.opened === true, `bridge clean exit (${result.code}, ${JSON.stringify(report)})`);
    assert(report.fixtureSubmissions === 0, `zero device submissions across the whole late-ack run (${report.fixtureSubmissions})`);
    // 核对迟到 ACK 任务终态：journal 是真实 SQLite（robot-journal.sqlite），只读直查
    // （与 Q robot-live-fixture 的撤销后终态核对同义；安装包不导出 RobotJournal，路径一致即可核对）
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(journalDir, 'robot-journal.sqlite'), { readOnly: true });
    let taskRow;
    let operationRow;
    try {
      taskRow = db.prepare('SELECT phase, job_state, view_json FROM tasks WHERE task_id = ?').get(inFlightTaskId);
      operationRow = db.prepare('SELECT send_state FROM operations WHERE task_id = ?').get(inFlightTaskId);
    } finally {
      db.close();
    }
    const taskView = taskRow ? JSON.parse(taskRow.view_json) : null;
    assert(taskRow?.phase === 'unknown' && taskRow?.job_state === 'unknown', `held task lands unknown (phase=${taskRow?.phase}, job=${taskRow?.job_state})`);
    assert(operationRow?.send_state === 'not_sent' && taskView?.operations?.[0]?.nativeAccepted === false, `held task never sent (sendState=${operationRow?.send_state}, nativeAccepted=${taskView?.operations?.[0]?.nativeAccepted})`);
    record('late ack task terminal state verified via journal sqlite', { taskId: inFlightTaskId, phase: taskRow.phase, job: taskRow.job_state, sendState: operationRow.send_state });
    assert(unhandled.length === 0, `no unhandled rejections (${JSON.stringify(unhandled).slice(0, 300)})`);
    record('cleanup verified (zero bridge traffic)');

    summary.ok = true;
    console.log(JSON.stringify({ t02lateack: 'PASS', steps: summary.steps.length, elapsedMs: Date.now() - startedAt }, null, 2));
  } catch (cause) {
    summary.ok = false;
    summary.error = String(cause?.stack ?? cause);
    console.error('[t02late] FAILED:', cause?.stack ?? cause);
    console.error(JSON.stringify({ t02lateack: 'FAIL', steps: summary.steps, elapsedMs: Date.now() - startedAt }, null, 2));
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
