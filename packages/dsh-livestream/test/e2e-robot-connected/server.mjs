/**
 * 已连接机器人插件的 E2E fixture（FEAT-DSH-004 F7/F8）：
 * 私有宿主目录经 fixtureHost.preparePackedInstall 真实打包安装两个候选包与 SDK 层，
 * 在安装产物上挂真实 robot 插件（私有 journal，无 Bridge → 能力=离线）与直播插件，
 * 再用普通 HTTP 服务把控制台静态资源和 /api/dsh-livestream/*、/api/dsh-qdroid/* 转发给
 * 同一受信 handler。证明的是真实 owner 路由 + 真实 TaskView 的控制台行为，
 * 不是缺插件分支。
 */
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { preparePackedInstall, startSdkHost, fixtureTrust } from '../robot/fixtureHost.mjs';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
const execP = promisify(execFile);
const BRIDGE = process.env.T02_BRIDGE !== '0';

const port = Number(process.argv[2]);
const PACKAGE_DIR = resolve(import.meta.dirname, '..', '..');
const Q_DIR = process.env.DSH_QDROID_DIR ?? resolve(PACKAGE_DIR, '..', '..', '..', '..', '20261110-qdroid-dsh-t1', 'dsh-qdroid');
const root = await mkdtemp(join(resolve(process.env.DSH_E2E_CONNECTED_DIR ?? '.e2e'), 't02-connected-'));
const dshHome = join(root, 'dsh-home');
await mkdir(join(dshHome, 'dsh-livestream'), { recursive: true });
await writeFile(join(dshHome, 'dsh-livestream', 'settings.json'), JSON.stringify({
  stageToken: 't02-connected', stagePort: 0,
  tts: { backend: 'doubao', doubaoVoice: 'S_t02_fixture', doubaoRate: 0, yovoiceModel: 'voxcpm2-q8', yovoiceVoice: 't02 测试音色', macosVoice: 'Tingting' },
}));
process.env.DSH_HOME = dshHome;
process.env.DSH_LIVESTREAM_LOCAL_REHEARSAL = '1';
process.env.DSH_LIVESTREAM_PACKAGE_DIR = PACKAGE_DIR;
process.env.DOUBAO_TTS_API_KEY = 't02-connected-key';

// 私有打包安装（两个候选包 + SDK 层，零网络）
const packed = preparePackedInstall({ root, packageDir: PACKAGE_DIR, qdroidDir: Q_DIR });
console.log(`[t02-connected] packed install identity qdroid=${packed.identities.qdroidFixtureSha.slice(0, 12)} live=${packed.identities.liveIndexSha.slice(0, 12)}`);

// 真实 SDK 宿主（webServer=TLS、connection、agents、tools、presets、llm、credentials）
const host = await startSdkHost({ hostDir: packed.hostDir, root });
const hostConfig = join(root, 'host.json');
await writeFile(hostConfig, JSON.stringify({
  journalDir: join(root, 'journal'),
  journalId: randomUUID(),
  setup: true,
  binding: { ownerRef: 'owner-1', bindingId: 'binding-1', deviceRef: 'device-1', bindingEpoch: 1 },
  allowedActions: ['greeting', 'sit_down', 'lie_down', 'stand_up'],
  trust: fixtureTrust(),
  deviceToken: 't02-connected-device-token-0123456789',
  hostId: 'host-t02-connected',
  agent: { presetId: 'robot', provider: 'dsh003-fixture', model: 'deterministic' },
}), { mode: 0o600 });
const { chmod } = await import('node:fs/promises');
// journal 目录必须存在且 0700（worker 打开前置条件）；必须在 robot 插件挂载前完成
await mkdir(join(root, 'journal'), { recursive: true });
await chmod(join(root, 'journal'), 0o700);
const requireHost = createRequire(join(packed.hostDir, 'package.json'));
const robotFactory = await import(pathToFileURL(requireHost.resolve('dsh-qdroid/robot')).href);
await host.ctx.plugin(robotFactory, { configFile: hostConfig });

const requireLive = createRequire(join(packed.hostDir, 'node_modules', 'dsh-livestream', 'package.json'));
const liveIndex = await import(pathToFileURL(requireLive.resolve('dsh-livestream')).href);
const liveAgent = await import(pathToFileURL(requireLive.resolve('dsh-livestream/agent')).href);
await host.ctx.plugin(liveIndex);
await host.ctx.plugin(liveAgent);

// 可选 Python Bridge 软件 fixture（默认开）：无 Bridge 时机器人正确显示离线并拒动作提交
let bridge = undefined;
let bridgeExit = undefined;
if (BRIDGE) {
  const { execFile } = await import('node:child_process');
  const exe = promisify(execFile);
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', UV_CACHE_DIR: join(root, 'uv-cache'), UV_PYTHON_DOWNLOADS: 'never' };
  const zip = join(root, 'fixture.zip');
  const extracted = join(root, 'device');
  await exe('uv', ['run', '--no-project', '--python', '3.10', 'python', 'scripts/build_fixture_v04.py', '--output', zip], { cwd: resolve(Q_DIR, '..', 'qdroid-bridge'), env, timeout: 60000 });
  await exe('unzip', ['-qq', zip, '-d', extracted], { env, timeout: 15000 });
  const deviceConfig = join(root, 'device.json');
  const trust = fixtureTrust();
  await writeFile(deviceConfig, JSON.stringify({
    endpoint: `wss://127.0.0.1:${host.port}/api/dsh-qdroid/robot/v1/device`,
    token: 't02-connected-device-token-0123456789',
    deviceId: trust.deviceId,
    runId: trust.runId,
    package: { packageId: 'fixture', version: '1', artifactSha256: 'c'.repeat(64) },
    control: trust.control,
    runPolicy: trust.runPolicy,
    runSupport: trust.runSupport,
    protocolArtifactSha256: trust.artifactSha256,
    protocolBundle: join(Q_DIR, 'assets', 'qdroid-io-0.4-fixture-8c2a01abd1dc.tar'),
    allowLoopbackWs: false,
    caFile: host.caCert,
  }), { mode: 0o600 });
  bridge = spawn('uv', ['run', '--no-project', '--python', '3.10', 'python', '-I', 'scripts/run_fixture_v04.py', '--config', deviceConfig], { cwd: extracted, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let bridgeStdout = '';
  bridge.stdout.on('data', (c) => { bridgeStdout += c; });
  bridge.stderr.on('data', (c) => { process.stderr.write(`[bridge] ${c}`); });
  bridgeExit = new Promise((resolveExit, rejectExit) => { bridge.once('error', rejectExit); bridge.once('close', (code) => resolveExit({ code, stdout: bridgeStdout })); });
  void bridgeExit;
}

const shared = host.ctx.connection.createSharedFetchHandler('/api');
const peer = host.ctx.connection.browserPeer;
// 由 start.mjs 从 src/console 构建的 fixture 控制台 bundle（见 start.mjs 说明）
const clientPath = resolve(process.env.DSH_T02_CLIENT_BUNDLE ?? '');

let sharedRequests = 0;
const app = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  res.setHeader('cache-control', 'no-store');
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script src="/client.js"></script></body></html>');
  }
  if (url.pathname === '/client.js') {
    res.writeHead(200, { 'content-type': 'application/javascript' });
    return res.end(await readFile(clientPath, 'utf8'));
  }
  if (url.pathname === '/__fixture') {
    res.writeHead(200, { 'content-type': 'application/json' });
    const stateRoute = shared.fetch(new Request(`https://127.0.0.1:${host.port}/api/dsh-livestream/state`), peer);
    const state = await (await stateRoute).json();
    return res.end(JSON.stringify({
      robot: state.robot,
      onAir: state.show.onAir,
      sharedRequests,
      dshHome,
      installedIdentity: { qdroid: packed.identities.qdroidFixtureSha.slice(0, 12), live: packed.identities.liveIndexSha.slice(0, 12) },
    }));
  }
  if (url.pathname.startsWith('/api/')) {
    // 本机共享服务（舞台/OBS/采集端口）不允许被触及
    if (['127.0.0.1', 'localhost'].includes(url.hostname) && ['3080', '3081', '7390', '8757'].includes(url.port)) {
      sharedRequests++;
      res.writeHead(503); return res.end();
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    try {
      const response = await shared.fetch(new Request(`https://127.0.0.1:${host.port}${url.pathname}${url.search}`, {
        method: req.method, headers: { 'content-type': 'application/json' },
        ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}),
        signal: controller.signal,
      }), peer);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      if (!res.destroyed) { res.writeHead(500); res.end(); }
    }
    return;
  }
  res.writeHead(404); res.end();
});
if (BRIDGE && bridge) {
  const deadline = Date.now() + 60000;
  for (;;) {
    const probe = await shared.fetch(new Request(`https://127.0.0.1:${host.port}/api/dsh-qdroid/robot/v1/capabilities?bindingId=binding-1`), peer);
    const body = await probe.json();
    if (body.value?.connection === 'ready') { console.log('[t02-connected] bridge ready'); break; }
    if (Date.now() > deadline) throw new Error('bridge readiness timeout');
    await new Promise((r) => setTimeout(r, 100));
  }
}
app.listen(port, '127.0.0.1');
const shutdown = () => {
  if (bridge && bridge.exitCode === null && bridge.signalCode === null) bridge.kill('SIGKILL');
  app.closeAllConnections();
  app.close(() => {
    void host.dispose().then(async () => {
      console.log(`[t02-connected] stopped identity qdroid=${packed.identities.qdroidFixtureSha.slice(0, 12)} live=${packed.identities.liveIndexSha.slice(0, 12)} sharedRequests=${sharedRequests}`);
      await rm(root, { recursive: true, force: true }).catch(() => {});
      process.exit(0);
    });
  });
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
console.log(`[t02-connected] app=${port} tls=${host.port}`);
