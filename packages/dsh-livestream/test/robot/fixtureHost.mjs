/**
 * T02 组合验收的宿主准备（FEAT-DSH-004）：
 *  - preparePackedInstall：两个候选包各自真实 npm pack，再在私有宿主目录
 *    从 tarball 解包安装（SDK 层按字节拷贝既有安装树），并核对
 *    安装身份与模块解析（同一 dsh-qdroid 实例）。
 *  - startSdkHost：在安装产物上挂真实 SDK 服务（cordis/llm/session/agent/tools/
 *    webserver/client-connection/credentials-local），返回受信 fetch 与清理。
 * 只使用动态 loopback 端口与 OS mkdtemp 私有目录；无网络安装、无共享 node_modules 写入。
 */
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function run(cmd, args, options = {}) {
  const { cwd, env, timeout = 120000 } = options;
  return execFileSync(cmd, args, { cwd, env, timeout, encoding: 'utf8' });
}

function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else if (entry.isFile()) cpSync(from, to);
  }
}

const HOST_SDK_DEPS = {
  '@deepseek-ai/cordis': '4.1.0',
  '@deepseek-ai/cordis-plugin-loader': '1.1.0',
  '@deepseek-ai/dsh-llm': '0.2.2-rc.1',
  '@deepseek-ai/dsh-session': '0.2.2-rc.1',
  '@deepseek-ai/dsh-session-projection': '0.2.2-rc.1',
  '@deepseek-ai/dsh-system-prompt': '0.2.2-rc.1',
  '@deepseek-ai/dsh-tools': '0.2.2-rc.1',
  '@deepseek-ai/dsh-tool-executor-native': '0.2.2-rc.1',
  '@deepseek-ai/dsh-agent': '0.2.2-rc.1',
  '@deepseek-ai/dsh-agent-loop': '0.2.2-rc.1',
  '@deepseek-ai/dsh-agent-preset-registry': '0.2.2-rc.1',
  '@deepseek-ai/dsh-host-webserver': '0.2.2-rc.1',
  '@deepseek-ai/dsh-client-connection': '0.2.2-rc.1',
  '@deepseek-ai/dsh-credentials-local': '0.2.2-rc.1',
  'react': '18.3.1',
  'react-dom': '18.3.1',
};

/**
 * 打包并离线安装两个候选包。返回 hostDir 与安装身份摘要。
 * 保留候选包的清单原文，并核对解包后的构建与清单身份。
 */
export function preparePackedInstall({ root: rootInput, packageDir, qdroidDir }) {
  const root = resolve(rootInput);
  const hostDir = join(root, 'host');
  const stageLib = join(root, 'livestream-lib');
  const stagePkg = join(root, 'livestream-pkg');
  const tarballs = join(root, 'tarballs');
  mkdirSync(tarballs, { recursive: true });

  // 1. 候选构建（隔离输出）
  run(process.execPath, ['build.mjs'], { cwd: packageDir, env: { ...process.env, DSH_LIVESTREAM_BUILD_OUT: stageLib } });

  // 2. 候选打包目录：包内运行时资产与仓库根的必需说明/许可文件。
  mkdirSync(stagePkg, { recursive: true });
  cpSync(join(packageDir, 'package.json'), join(stagePkg, 'package.json'));
  copyDir(stageLib, join(stagePkg, 'lib'));
  for (const entry of ['stage', 'assets', 'cordis.patch.yml']) {
    const src = join(packageDir, entry);
    if (!existsSync(src)) continue;
    if (statSync(src).isDirectory()) copyDir(src, join(stagePkg, entry));
    else cpSync(src, join(stagePkg, entry));
  }
  const repositoryRoot = resolve(packageDir, '..', '..');
  for (const entry of ['README.md', 'LICENSE']) {
    const src = join(repositoryRoot, entry);
    if (!existsSync(src) || !statSync(src).isFile()) {
      throw new Error(`required package document missing: ${src}`);
    }
    cpSync(src, join(stagePkg, entry));
  }
  const liveTgzPath = join(tarballs, 'dsh-livestream-candidate.tgz');
  run('npm', ['pack', stagePkg, '--pack-destination', tarballs]);
  const livePacked = readdirSync(tarballs).find((n) => n.startsWith('dsh-livestream-') && n.endsWith('.tgz'));
  cpSync(join(tarballs, livePacked), liveTgzPath);
  const qdTgzPath = join(tarballs, 'dsh-qdroid-candidate.tgz');
  run('npm', ['pack', qdroidDir, '--pack-destination', tarballs]);
  const qdPacked = readdirSync(tarballs).find((n) => n.startsWith('dsh-qdroid-') && n.endsWith('.tgz'));
  cpSync(join(tarballs, qdPacked), qdTgzPath);

  // 3. 私有宿主：SDK 层用 Q 仓 npm 安装树的按字节拷贝（同版本锁定、只读使用，
  //    APFS clone 优先），两个候选包再从各自 tarball 真实解包安装到 host/node_modules。
  //    候选包是 fresh pack + fresh unpack；SDK 层不经过 registry（离线、零网络安装）。
  const hostNodeModules = join(hostDir, 'node_modules');
  mkdirSync(hostNodeModules, { recursive: true });
  try {
    execFileSync('cp', ['-c', '-R', join(qdroidDir, 'node_modules', '.'), hostNodeModules], { timeout: 300000 });
  } catch {
    cpSync(join(qdroidDir, 'node_modules'), hostNodeModules, { recursive: true });
  }
  for (const [name, tgz] of [['dsh-qdroid', qdTgzPath], ['dsh-livestream', liveTgzPath]]) {
    const target = join(hostNodeModules, name);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    run('tar', ['-xzf', tgz, '-C', target, '--strip-components', '1'], { timeout: 120000 });
  }

  // 5. 安装身份与模块解析核对
  const installedQdroidLib = join(hostDir, 'node_modules', 'dsh-qdroid', 'lib', 'fixture.mjs');
  const installedLiveIndex = join(hostDir, 'node_modules', 'dsh-livestream', 'lib', 'index.js');
  if (!existsSync(installedQdroidLib) || !existsSync(installedLiveIndex)) throw new Error('packed install missing plugin entries');
  const identities = {
    qdroidFixtureSha: sha256File(installedQdroidLib),
    qdroidSourceSha: sha256File(join(qdroidDir, 'lib', 'fixture.mjs')),
    liveIndexSha: sha256File(installedLiveIndex),
    liveCandidateSha: sha256File(join(stageLib, 'index.js')),
    liveManifestSha: sha256File(join(hostNodeModules, 'dsh-livestream', 'package.json')),
    liveSourceManifestSha: sha256File(join(packageDir, 'package.json')),
  };
  if (identities.qdroidFixtureSha !== identities.qdroidSourceSha) throw new Error('installed dsh-qdroid lib differs from accepted Q candidate');
  if (identities.liveIndexSha !== identities.liveCandidateSha) throw new Error('installed dsh-livestream lib differs from candidate build');
  if (identities.liveManifestSha !== identities.liveSourceManifestSha) throw new Error('installed dsh-livestream manifest differs from source package');
  for (const entry of ['README.md', 'LICENSE']) {
    const installed = join(hostNodeModules, 'dsh-livestream', entry);
    if (!existsSync(installed) || sha256File(installed) !== sha256File(join(repositoryRoot, entry))) {
      throw new Error(`installed dsh-livestream ${entry} differs from repository source`);
    }
  }
  // 同一 robot 模块实例：安装的直播 lib 解析到的 dsh-qdroid/robot 必须就是宿主安装的那份
  const requireLive = createRequire(join(hostDir, 'node_modules', 'dsh-livestream', 'package.json'));
  const robotFromLive = requireLive.resolve('dsh-qdroid/robot');
  const requireHost = createRequire(join(hostDir, 'package.json'));
  const robotFromHost = requireHost.resolve('dsh-qdroid/robot');
  if (robotFromLive !== robotFromHost) throw new Error(`robot module resolution diverges: ${robotFromLive} vs ${robotFromHost}`);
  identities.robotModuleUrl = robotFromLive;
  return { hostDir, identities };
}

/** 在安装宿主上挂真实 SDK 服务；返回受信 fetch 与按序清理。 */
export async function startSdkHost({ hostDir, root }) {
  const requireHost = createRequire(join(hostDir, 'package.json'));
  const importFromHost = async (name) => import(pathToFileURL(requireHost.resolve(name)).href);

  const { Context } = await importFromHost('@deepseek-ai/cordis');
  const llmModule = await importFromHost('@deepseek-ai/dsh-llm');
  const sessionModule = await importFromHost('@deepseek-ai/dsh-session');
  const sessionProjection = await importFromHost('@deepseek-ai/dsh-session-projection');
  const systemPrompt = await importFromHost('@deepseek-ai/dsh-system-prompt');
  const toolRuntime = await importFromHost('@deepseek-ai/dsh-tools');
  const nativeExecutor = await importFromHost('@deepseek-ai/dsh-tool-executor-native');
  const agentRegistry = await importFromHost('@deepseek-ai/dsh-agent');
  const agentLoop = await importFromHost('@deepseek-ai/dsh-agent-loop');
  const presetRegistry = await importFromHost('@deepseek-ai/dsh-agent-preset-registry');
  const loader = await importFromHost('@deepseek-ai/cordis-plugin-loader');
  const webserver = await importFromHost('@deepseek-ai/dsh-host-webserver');
  const clientConnection = await importFromHost('@deepseek-ai/dsh-client-connection');
  const credentialsLocal = await importFromHost('@deepseek-ai/dsh-credentials-local');

  const ctx = new Context();
  await ctx.plugin(llmModule.default);
  await ctx.plugin(sessionModule.default);
  await ctx.plugin(sessionProjection.default);
  await ctx.plugin(systemPrompt.default, { personaPrefix: '' });
  await ctx.plugin(toolRuntime.default);
  await ctx.plugin({ inject: ['tools'], apply: (owner) => { owner.tools.setExecutor(new nativeExecutor.NativeToolExecutor(owner, () => 1)); } });
  await ctx.plugin(agentRegistry.default);
  await ctx.plugin(agentLoop.default, { agents: [] });
  await ctx.plugin(loader.default);
  await ctx.plugin(presetRegistry.default, { default: 'robot' });
  await ctx.agentPresets.register({ id: 'robot', plugins: [] });
  await ctx.plugin(credentialsLocal.default, { path: join(root, 'credentials.yaml'), dshHome: root, watch: false });

  // TLS（私有 CA + 127.0.0.1 证书）
  const caCert = join(root, 'ca.crt');
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', UV_CACHE_DIR: join(root, 'uv-cache'), UV_PYTHON_DOWNLOADS: 'never' };
  run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(root, 'ca.key'), '-out', caCert, '-days', '1', '-subj', '/CN=t02-test-ca', '-addext', 'basicConstraints=critical,CA:TRUE'], { env, timeout: 15000 });
  run('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(root, 'server.key'), '-out', join(root, 'server.csr'), '-subj', '/CN=t02-test-server'], { env, timeout: 15000 });
  const fs = await import('node:fs/promises');
  await fs.writeFile(join(root, 'server.ext'), 'subjectAltName=IP:127.0.0.1\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n');
  run('openssl', ['x509', '-req', '-in', join(root, 'server.csr'), '-CA', caCert, '-CAkey', join(root, 'ca.key'), '-CAcreateserial', '-out', join(root, 'server.crt'), '-days', '1', '-extfile', join(root, 'server.ext')], { env, timeout: 15000 });
  await ctx.plugin(webserver.default, { host: '127.0.0.1', port: 0, tls: { certFile: join(root, 'server.crt'), keyFile: join(root, 'server.key') } });
  const port = ctx.webServer.port;
  if (!Number.isInteger(port) || port <= 0) throw new Error(`webserver dynamic port (${port})`);
  await ctx.plugin(clientConnection);

  const shared = ctx.connection.createSharedFetchHandler('/api');
  const peer = ctx.connection.browserPeer;
  const fetchApi = (path, init) => shared.fetch(new Request(`https://127.0.0.1:${port}/api${path}`, init), peer);

  return {
    ctx, port, caCert, env,
    modules: { llmModule, sessionModule },
    fetchApi,
    dispose: async () => {
      await ctx.fiber.dispose();
      const { createConnection } = await import('node:net');
      const closed = await new Promise((resolveClosed) => {
        const socket = createConnection({ host: '127.0.0.1', port });
        socket.once('connect', () => { socket.destroy(); resolveClosed(false); });
        socket.once('error', () => resolveClosed(true));
        socket.setTimeout(2000, () => { socket.destroy(); resolveClosed(false); });
      });
      return closed;
    },
  };
}

export { spawn };

/** 组合/旅程共用的软件 fixture 受信配置（与 T01 factory 相同形态）。 */
export function fixtureTrust() {
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
    artifactSha256: '8c2a01abd1dc9fad3cb821fc335bda6c998884b7d281d3848c183282ede821f9',
    control: {
      version: 'robot-control/1',
      protocolArtifactSha256: '8c2a01abd1dc9fad3cb821fc335bda6c998884b7d281d3848c183282ede821f9',
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
