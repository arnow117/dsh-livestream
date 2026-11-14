import { createHash } from 'node:crypto';
import { open, readFile, readdir, realpath, lstat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, version as esbuildVersion } from 'esbuild';

const sourceDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(sourceDir, '../../..');
const baseline = '3a79c57d85c59289db3b77211b3ec01fae47d42c';
const patchDigest = '65de3588dbff5f9fa11f2cc86bbdf785c9303919113f146f8e21c7802b2d08e0';
const exportDigest = '832cbc54ed74bbe3b4467ee39aafbd3000ac9d089529ef7b8ae35cb3a400ccb1';
const hash = (data) => createHash('sha256').update(data).digest('hex');

function argumentsFrom(argv) {
  if (argv.length !== 8 || argv[0] !== '--fixed-d' || argv[2] !== '--export-sha256' || argv[4] !== '--output' || argv[6] !== '--manifest') {
    throw new Error('expected --fixed-d, --export-sha256, --output and --manifest');
  }
  return { fixed: argv[1], exportSha256: argv[3], output: argv[5], manifest: argv[7] };
}

async function checkOutput(path) {
  if (!isAbsolute(path) || resolve(path) !== path || await realpath(dirname(path)) !== dirname(path)) throw new Error('unsafe output');
  try { await lstat(path); throw new Error('output already exists'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function enumerate(root, relative = '') {
  const result = Object.create(null);
  const directory = join(root, relative);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (name === 'dsh-raw-export-manifest.json') continue;
    const path = join(root, name);
    if (entry.isSymbolicLink()) {
      const { readlink } = await import('node:fs/promises');
      result[name] = { symlink: await readlink(path) };
    } else if (entry.isDirectory()) {
      Object.assign(result, await enumerate(root, name));
    } else if (entry.isFile()) {
      result[name] = { sha256: hash(await readFile(path)) };
    } else {
      throw new Error('unsupported export member');
    }
  }
  return result;
}

async function writeExclusive(path, bytes) {
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
}

async function main() {
  const args = argumentsFrom(process.argv.slice(2));
  if (!isAbsolute(args.fixed) || resolve(args.fixed) !== args.fixed || await realpath(args.fixed) !== args.fixed) throw new Error('unsafe fixed export');
  await checkOutput(args.output);
  await checkOutput(args.manifest);
  if (args.output === args.manifest) throw new Error('outputs must differ');
  const rawManifest = await readFile(join(args.fixed, 'dsh-raw-export-manifest.json'));
  if (args.exportSha256 !== exportDigest || hash(rawManifest) !== exportDigest) throw new Error('export manifest mismatch');
  const manifest = JSON.parse(rawManifest.toString('utf8'));
  if (manifest.baseline !== baseline || manifest.patchSha256 !== patchDigest ||
    hash(await readFile(join(sourceDir, 'raw-only.patch'))) !== patchDigest) throw new Error('export identity mismatch');
  const actualFiles = await enumerate(args.fixed);
  if (JSON.stringify(Object.entries(actualFiles).sort()) !== JSON.stringify(Object.entries(manifest.files).sort())) {
    throw new Error('export contents changed');
  }
  const result = await build({
    absWorkingDir: packageRoot,
    entryPoints: [join(sourceDir, 'sender_entry.mjs')],
    alias: {
      '@dsh-fixed-d/browser': join(args.fixed, 'src/collector/browser.ts'),
      '@dsh-fixed-d/session': join(args.fixed, 'src/collector/liveSession.ts'),
      '@dsh-fixed-d/proto': join(args.fixed, 'src/proto/douyin.proto.ts'),
    },
    bundle: true,
    write: false,
    metafile: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    packages: 'external',
    logLevel: 'silent',
  });
  const names = Object.keys(result.metafile.inputs);
  if (names.some((name) => /(?:^|\/)(?:accountStore|collector|server)\.(?:ts|js)$/.test(name))) {
    throw new Error('legacy collector or server included');
  }
  const sources = {};
  for (const name of names.sort()) {
    const path = isAbsolute(name) ? name : resolve(packageRoot, name);
    sources[path] = hash(await readFile(path));
  }
  const bundle = result.outputFiles[0].contents;
  const buildSupport = {};
  for (const name of ['build_raw.mjs', 'prepare_raw.py', 'raw-only.patch', 'verified_sender_loader.mjs']) {
    buildSupport[name] = hash(await readFile(join(sourceDir, name)));
  }
  const buildManifest = { schemaVersion: 1, baseline, patchSha256: patchDigest, exportManifestSha256: hash(rawManifest),
    bundleSha256: hash(bundle), esbuildVersion, buildSupport, sources, metafile: result.metafile };
  await writeExclusive(args.output, bundle);
  await writeExclusive(args.manifest, Buffer.from(JSON.stringify(buildManifest, null, 2) + '\n'));
  console.log(`bundle_sha256=${buildManifest.bundleSha256}`);
  console.log(`export_manifest_sha256=${buildManifest.exportManifestSha256}`);
}

main().catch((error) => { console.error(error instanceof Error ? error.message : 'build failed'); process.exitCode = 1; });
