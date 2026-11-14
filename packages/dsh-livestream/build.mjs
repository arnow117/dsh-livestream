// 构建：
//   宿主端 → Node ESM（lib/index.js、lib/agent.js，共用的代码拆进 lib/chunks/，两个入口拿到同一份运行时）
//   控制台 → DSH 的动态 client 模块（lib/client.js；React 由 DSH 网页外壳提供，不打进包里）
//   舞台页 → 独立的浏览器脚本（lib/stage.js，React 打进去；OBS 的浏览器源直接打开）
// --client：只重建控制台和舞台页。注意 DSH 会把控制台代码缓存在内存里，要重启 DSH 才生效
// DSH_LIVESTREAM_BUILD_OUT=<dir>：把产物写进指定目录（FEAT-DSH-004 测试用隔离输出，
// 保留默认 lib/ 的原有行为：不带该变量时仍然先删除 lib/ 再重建）。
import { build } from 'esbuild';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmod, lstat, mkdir, open, readdir, realpath, rename, rm, writeFile,
} from 'node:fs/promises';
import path from 'node:path';

const webOnly = process.argv.includes('--client');
const outDir = process.env.DSH_LIVESTREAM_BUILD_OUT ?? 'lib';
const dshQdroidExternal = ['dsh-qdroid', 'dsh-qdroid/robot'];

// This release uses one fixed, already built native; the build never executes it.
const nativeFiles = [
  {
    name: 'registration-native',
    size: 57996370,
    sha256: '154145d18732e0a1823d91be611dcff55bdda36ac46c1fce7c3354748d9e94c4',
    mode: 0o500,
  },
  {
    name: 'NOTICE.md',
    size: 704,
    sha256: 'e8e819f6f4a35bb0020c3d7dd64d31e6f75118752a26719a891641d37310060b',
    mode: 0o400,
  },
  {
    name: 'UPSTREAM-LICENSE',
    size: 1084,
    sha256: 'c969fc7e3af68e6bf40b0d8dd9c3dcc377eb685a2139535b203b39fdcad739ee',
    mode: 0o400,
  },
];
const nativeSource = path.resolve('src/registration/nativeCli');
const outputRoot = path.resolve(outDir);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function readFixedFile(file, expected) {
  if ((await realpath(file)) !== file)
    throw new Error('native asset path is not canonical');
  const original = await lstat(file);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.uid !== process.getuid?.() ||
      before.nlink !== 1 ||
      before.size !== expected.size ||
      original.dev !== before.dev ||
      original.ino !== before.ino ||
      (before.mode & 0o022) !== 0
    )
      throw new Error('native asset identity is invalid');
    const bytes = Buffer.alloc(expected.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (bytesRead === 0) throw new Error('native asset was truncated');
      offset += bytesRead;
    }
    const extra = Buffer.alloc(1);
    if ((await handle.read(extra, 0, 1, bytes.length)).bytesRead !== 0)
      throw new Error('native asset exceeded its fixed size');
    const after = await handle.stat();
    const current = await lstat(file);
    if (
      bytes.length !== expected.size ||
      digest(bytes) !== expected.sha256 ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      current.dev !== before.dev ||
      current.ino !== before.ino
    )
      throw new Error('native asset digest is invalid');
    return bytes;
  } finally {
    await handle.close();
  }
}

// Only unlock a previous asset directory after proving it is exactly our prior output.
async function removePreviousOutput() {
  let asset;
  try {
    asset = await lstat(path.join(outputRoot, 'nativeCli'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!asset) {
    await rm(outputRoot, { recursive: true, force: true });
    return;
  }
  const directory = path.join(outputRoot, 'nativeCli');
  if (
    !asset.isDirectory() ||
    asset.isSymbolicLink() ||
    asset.uid !== process.getuid?.() ||
    (asset.mode & 0o7777) !== 0o500 ||
    (await realpath(directory)) !== directory
  )
    throw new Error('previous native asset directory is not owned output');
  const members = (await readdir(directory)).sort();
  if (
    JSON.stringify(members) !==
    JSON.stringify(nativeFiles.map((item) => item.name).sort())
  )
    throw new Error('previous native asset members changed');
  for (const item of nativeFiles) {
    const file = path.join(directory, item.name);
    const info = await lstat(file);
    if ((info.mode & 0o7777) !== item.mode)
      throw new Error('previous native asset mode changed');
    await readFixedFile(file, item);
  }
  const handle = await open(
    directory,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const current = await handle.stat();
    if (current.dev !== asset.dev || current.ino !== asset.ino)
      throw new Error('previous native asset identity changed');
    await handle.chmod(0o700);
    try {
      await rm(outputRoot, { recursive: true, force: true });
    } catch (error) {
      await handle.chmod(0o500);
      throw error;
    }
  } finally {
    await handle.close();
  }
}

async function installNativeAssets(files) {
  const temporary = path.join(outputRoot, `.nativeCli-${randomUUID()}`);
  await mkdir(temporary, { mode: 0o700 });
  const handle = await open(
    temporary,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  const identity = await handle.stat();
  let installed = false;
  try {
    for (const item of nativeFiles) {
      const file = path.join(temporary, item.name);
      await writeFile(file, files.get(item.name), { flag: 'wx', mode: 0o600 });
      await chmod(file, item.mode);
      await readFixedFile(file, item);
      if (((await lstat(file)).mode & 0o7777) !== item.mode)
        throw new Error('native asset mode is invalid');
    }
    const members = (await readdir(temporary)).sort();
    if (
      JSON.stringify(members) !==
      JSON.stringify(nativeFiles.map((item) => item.name).sort())
    )
      throw new Error('native asset members changed');
    await handle.chmod(0o500);
    const current = await lstat(temporary);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.uid !== process.getuid?.() ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino ||
      (current.mode & 0o7777) !== 0o500
    )
      throw new Error('native asset directory identity is invalid');
    await rename(temporary, path.join(outputRoot, 'nativeCli'));
    installed = true;
  } finally {
    if (!installed) {
      await handle.chmod(0o700).catch(() => {});
      const current = await lstat(temporary).catch(() => undefined);
      if (
        current &&
        current.isDirectory() &&
        !current.isSymbolicLink() &&
        current.dev === identity.dev &&
        current.ino === identity.ino
      )
        await rm(temporary, { recursive: true, force: true });
    }
    await handle.close();
  }
}

// These files are the fixed sender entry's local source closure and its build support.
// Keeping the original layout lets the verified loader check actual packaged bytes.
const publicChatFiles = [
  'agentReplyTool.ts', 'binding.ts', 'controller.ts', 'eventRef.ts',
  'frozenControl.ts', 'frozenControlEvidence.ts', 'frozenController.ts',
  'frozenGrant.ts', 'frozenJournal.ts', 'frozenRecovery.ts',
  'frozenSenderRuntime.ts', 'grantAuthority.ts', 'grantManager.ts',
  'helperLauncher.ts', 'helperProtocol.ts', 'httpResponse.ts', 'identity.ts',
  'inputBinding.ts', 'operations.ts', 'protocol.ts', 'rawProof.ts',
  'rawSenderSession.ts', 'recoveryFacts.ts', 'recoveryProtocol.ts',
  'roomBinding.ts', 'senderClient.ts', 'senderService.ts', 'textPolicy.ts',
  'dyhub/sender_entry.mjs', 'dyhub/build_raw.mjs', 'dyhub/prepare_raw.py',
  'dyhub/raw-only.patch', 'dyhub/verified_sender_loader.mjs',
];

async function readPublicChatAsset(file) {
  if (await realpath(file) !== file) throw new Error('public chat asset path is not canonical');
  const original = await lstat(file);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.uid !== process.getuid?.() || before.nlink !== 1 ||
        (before.mode & 0o022) !== 0 || before.dev !== original.dev || before.ino !== original.ino) {
      throw new Error('public chat asset identity is invalid');
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const current = await lstat(file);
    if (bytes.length !== before.size || before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
        current.dev !== before.dev || current.ino !== before.ino) {
      throw new Error('public chat asset changed during read');
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function verifyPublicChatClosure(assets) {
  const graph = await build({
    entryPoints: ['src/publicChat/dyhub/sender_entry.mjs'],
    bundle: true, write: false, metafile: true, platform: 'node', format: 'esm',
    target: 'node20', packages: 'external', logLevel: 'silent',
  });
  const sourceRoot = path.resolve('src/publicChat');
  const actual = Object.keys(graph.metafile.inputs).map((name) => {
    const relative = path.relative(sourceRoot, path.resolve(name));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('unexpected sender source outside public chat');
    }
    return relative.split(path.sep).join('/');
  }).sort();
  const support = new Set(['dyhub/build_raw.mjs', 'dyhub/prepare_raw.py',
    'dyhub/raw-only.patch', 'dyhub/verified_sender_loader.mjs']);
  const expected = publicChatFiles.filter((name) => !support.has(name)).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('public chat source closure changed');
  }
  for (const [name, bytes] of assets) {
    const current = await readPublicChatAsset(path.join(sourceRoot, name));
    if (digest(current) !== digest(bytes)) throw new Error('public chat asset changed during build preparation');
  }
}

async function installPublicChatAssets(metafile, assets) {
  const entries = Object.entries(metafile.outputs).filter(([, output]) =>
    output.entryPoint === 'src/publicChat/trustedSender.ts');
  if (entries.length !== 1) throw new Error('trusted sender build output is missing or ambiguous');
  const chunkFile = path.resolve(entries[0][0]);
  const chunkRoot = path.dirname(chunkFile);
  const relative = path.relative(outputRoot, chunkRoot);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) ||
      await realpath(chunkRoot) !== chunkRoot) {
    throw new Error('trusted sender output root is invalid');
  }
  const chunkStat = await lstat(chunkRoot);
  if (!chunkStat.isDirectory() || chunkStat.isSymbolicLink() || chunkStat.uid !== process.getuid?.()) {
    throw new Error('trusted sender output directory is invalid');
  }
  const temporary = path.join(path.dirname(chunkRoot), `.public-chat-${randomUUID()}`);
  await rename(chunkRoot, temporary);
  let installed = false;
  try {
    for (const [name, bytes] of assets) {
      const target = path.join(temporary, name);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
      const copied = await readPublicChatAsset(target);
      if (digest(copied) !== digest(bytes)) throw new Error('public chat asset copy mismatch');
    }
    await rename(temporary, chunkRoot);
    installed = true;
    console.log(`public-chat-assets=${chunkRoot}`);
  } finally {
    if (!installed) {
      // The directory is this build's new output, never an installed or shared asset.
      await rm(temporary, { recursive: true, force: true });
    }
  }
}

let publicChatAssets;
let nativeAssets;
if (!webOnly) {
  // Validate the complete input before touching an existing output.
  nativeAssets = new Map();
  for (const item of nativeFiles) {
    nativeAssets.set(item.name, await readFixedFile(path.join(nativeSource, item.name), item));
  }
  publicChatAssets = new Map();
  for (const name of publicChatFiles) {
    publicChatAssets.set(name, await readPublicChatAsset(path.resolve('src/publicChat', name)));
  }
  await verifyPublicChatClosure(publicChatAssets);
  await removePreviousOutput();
  await mkdir(outDir, { recursive: true });
  const hostBuild = await build({
    entryPoints: { index: 'src/dsh/index.ts', agent: 'src/dsh/agent.ts' },
    metafile: true,
    outdir: outDir,
    splitting: true,
    chunkNames: 'chunks/[name]-[hash]',
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    sourcemap: true,
    // ws 的可选原生加速包：没有就用纯 JS。
    // dsh-qdroid 是可选的运行时依赖（动态 import），必须保持 external：
    // 由宿主里安装的同一份机器人插件模块提供，不打包第二份（WeakMap 状态共享）。
    external: ['@deepseek-ai/*', 'bufferutil', 'utf-8-validate', ...dshQdroidExternal],
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  });
  await installPublicChatAssets(hostBuild.metafile, publicChatAssets);
}

await build({
  entryPoints: ['src/console/client.tsx'],
  outfile: `${outDir}/client.js`,
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'],
  minify: true,
  banner: { js: 'window.__ModuleLoader__.load({id:"dsh-livestream",factory:(require)=>{var module={exports:{}};var exports=module.exports;' },
  footer: { js: 'return module.exports;}});' },
  define: { 'process.env.NODE_ENV': '"production"' },
});

await build({
  entryPoints: ['src/stage/main.tsx'],
  outfile: `${outDir}/stage.js`,
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
});

if (!webOnly) {
  await installNativeAssets(nativeAssets);
}

console.log(webOnly ? 'built lib/client.js and lib/stage.js' : 'built lib/index.js, lib/agent.js, lib/client.js and lib/stage.js');
