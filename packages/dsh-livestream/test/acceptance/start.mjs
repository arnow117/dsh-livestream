/**
 * FEAT-010-T001 同版内部组合入口的构建与启动。
 *
 * 全部产物和临时目录写入调用方指定的任务目录；任务自有的 HOME / DSH_HOME / 工作目录
 * 由本脚本创建并显式传给子进程，不改主会话的 HOME，也不读真实配置。
 */
import { build } from 'esbuild';
import { cp, mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.argv[2]);
if (!Number.isSafeInteger(port) || port <= 0 || [3080, 3081, 7390, 8757].includes(port)) {
  throw new Error('task-owned loopback port required');
}
const taskBase = process.env.DSH_ACCEPTANCE_ROOT;
if (!taskBase || !isAbsolute(taskBase)) throw new Error('absolute task root required');
const allowedRoot = await realpath('/Users/mac/hansen_agent_team/workspace/20261113-dsh-public-chat/feat010-internal-integration-103');
const canonicalBase = await realpath(taskBase);
const subdirectory = relative(allowedRoot, canonicalBase);
if (!subdirectory || subdirectory.startsWith('..') || isAbsolute(subdirectory)) throw new Error('task root is outside the authorized directory');
const output = join(taskBase, `build-${port}`);
const standardPackage = process.env.DSH_ACCEPTANCE_STANDARD_PACKAGE ?? '';
const standardMode = standardPackage !== '';
if (standardMode) {
  const canonicalPackage = await realpath(standardPackage);
  const packageRelative = relative(allowedRoot, canonicalPackage);
  if (standardPackage !== canonicalPackage || !packageRelative || packageRelative.startsWith('..') || isAbsolute(packageRelative)) {
    throw new Error('standard package outside the authorized task directory');
  }
}
const projectRequire = createRequire(new URL('../../package.json', import.meta.url));
await mkdir(`${output}/lib`, { recursive: true });
await cp('stage', `${output}/stage`, { recursive: true });
if (!standardMode) {
  await cp('package.json', `${output}/package.json`);
  await symlink(resolve('assets'), `${output}/assets`, 'dir');
}
await build({
  entryPoints: [standardMode ? 'test/acceptance/artifactClient.tsx' : 'test/acceptance/client.tsx'], outfile: `${output}/client.js`,
  bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
});
if (!standardMode) await build({
  entryPoints: ['src/stage/main.tsx'], outfile: `${output}/lib/stage.js`,
  bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
});
await build({
  entryPoints: [standardMode ? 'test/acceptance/artifactServer.ts' : 'test/acceptance/server.ts'], outfile: `${output}/server.js`,
  bundle: true, platform: 'node', format: 'esm', target: 'node22',
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  plugins: [
    {
      name: 'installed-dependencies',
      setup(buildStep) {
        buildStep.onResolve({ filter: /^(@deepseek-ai\/|@modelcontextprotocol\/client$|ws$)/ }, (args) => ({
          path: args.kind === 'require-call'
            ? projectRequire.resolve(args.path)
            : fileURLToPath(import.meta.resolve(args.path)),
          external: true,
        }));
      },
    },
    {
      name: 'acceptance-fixture-seams',
      setup(buildStep) {
        if (process.env.DSH_ACCEPTANCE_SENDER_MODE === 'offline') {
          buildStep.onResolve({ filter: /^\.\/trustedSender$/ }, (args) =>
            args.importer === resolve('src/publicChat/publicChatHost.ts')
              ? { path: resolve('test/acceptance/offlineTrustedSender.ts') }
              : undefined);
        }
        buildStep.onResolve({ filter: /^\.\/nativeArtifact$/ }, () => ({ path: 'native', namespace: 'seam' }));
        buildStep.onResolve({ filter: /^node:child_process$/ }, (args) =>
          args.importer.endsWith('/registration/boundedProcess.ts')
            ? { path: 'spawn', namespace: 'seam' }
            : undefined);
        buildStep.onLoad({ filter: /.*/, namespace: 'seam' }, (args) => ({
          contents: args.path === 'native'
            ? 'export function verifiedNativeExecutable(){return globalThis.__testExecutable;}'
            : 'export function spawn(...args){return globalThis.__testSpawn(...args);}',
          loader: 'js',
        }));
      },
    },
  ],
});

const taskRoot = await mkdtemp(join(taskBase, `run-${port}-`));
const home = join(taskRoot, 'home');
const dshHome = join(taskRoot, 'dsh-home');
const work = join(taskRoot, 'work');
await mkdir(join(home, '.lark-cli'), { recursive: true, mode: 0o700 });
await mkdir(join(dshHome, 'dsh-livestream'), { recursive: true, mode: 0o700 });
await mkdir(work, { recursive: true, mode: 0o700 });
await writeFile(join(home, '.lark-cli', 'config.json'), JSON.stringify({
  apps: [{
    name: 'selected', appId: 'app1', appSecret: { source: 'keychain', id: 'appsecret:app1' },
    brand: 'feishu', dpopMode: 'required', strictMode: 'user', users: [{ userOpenId: 'user1' }],
  }],
}), { mode: 0o600 });

const child = spawn(process.execPath, [`${output}/server.js`, port], {
  stdio: 'inherit',
  env: {
    HOME: home,
    TMPDIR: taskRoot,
    PATH: '/usr/bin:/bin',
    DSH_HOME: dshHome,
    DSH_ACCEPTANCE_WORK: work,
    DSH_ACCEPTANCE_SENDER_MODE: process.env.DSH_ACCEPTANCE_SENDER_MODE ?? '',
    DSH_ACCEPTANCE_STANDARD_PACKAGE: standardPackage,
    DSH_ACCEPTANCE_OUTPUT: output,
    DSH_ACCEPTANCE_SDK_ROOT: process.env.DSH_ACCEPTANCE_SDK_ROOT ?? '',
    DSH_ACCEPTANCE_ARTIFACT: process.env.DSH_ACCEPTANCE_ARTIFACT ?? '',
    DSH_ACCEPTANCE_COURSE_ROOT: process.env.DSH_ACCEPTANCE_COURSE_ROOT ?? '',
    DSH_LIVESTREAM_PACKAGE_DIR: process.cwd(),
    DSH_LIVESTREAM_LOCAL_REHEARSAL: '',
  },
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('exit', (code) => process.exit(code ?? 0));
