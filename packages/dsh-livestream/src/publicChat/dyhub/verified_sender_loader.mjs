import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const baseline = '3a79c57d85c59289db3b77211b3ec01fae47d42c';
const patchDigest = '65de3588dbff5f9fa11f2cc86bbdf785c9303919113f146f8e21c7802b2d08e0';
const exportDigest = '832cbc54ed74bbe3b4467ee39aafbd3000ac9d089529ef7b8ae35cb3a400ccb1';
const archiveDigest = '127c884b84a34a59d3cd0cfcbd438d4b3a49fe3d25b6da8a7bb6490491b6881b';
const supportDirectory = dirname(fileURLToPath(import.meta.url));
const publicChatDirectory = resolve(supportDirectory, '..');
const packageDirectory = resolve(publicChatDirectory, '../..');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const isDigest = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');

function inside(root, path) {
  const name = relative(root, path);
  return name !== '' && !name.startsWith('../') && name !== '..' && !isAbsolute(name);
}

async function readVerifiedFile(path, maximum, privateFile = false) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || await realpath(path) !== path) {
    throw new Error('unsafe sender file path');
  }
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum ||
    (typeof process.getuid === 'function' && before.uid !== process.getuid()) ||
    (privateFile ? (before.mode & 0o777) !== 0o600 : (before.mode & 0o022) !== 0)) {
    throw new Error('unsafe sender file');
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await file.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new Error('sender file changed');
    const bytes = await file.readFile();
    const after = await file.stat();
    if (bytes.length !== before.size || after.dev !== before.dev || after.ino !== before.ino ||
      after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.nlink !== 1) throw new Error('sender file changed');
    return bytes;
  } finally {
    await file.close();
  }
}

function objectJSON(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  let offset = 0;
  const whitespace = () => { while (offset < text.length && /[\x20\x09\x0a\x0d]/.test(text[offset])) offset++; };
  const string = () => {
    if (text[offset++] !== '"') throw new Error('invalid sender JSON');
    const start = offset - 1;
    let escaped = false;
    while (offset < text.length) {
      const char = text[offset++];
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (char === '"') {
        const value = JSON.parse(text.slice(start, offset));
        for (let index = 0; index < value.length; index++) {
          const code = value.charCodeAt(index);
          if (code >= 0xd800 && code <= 0xdbff) {
            const next = value.charCodeAt(++index);
            if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('invalid sender Unicode');
          } else if (code >= 0xdc00 && code <= 0xdfff) throw new Error('invalid sender Unicode');
        }
        return value;
      }
    }
    throw new Error('invalid sender JSON');
  };
  const scan = (depth) => {
    if (depth > 32) throw new Error('invalid sender JSON depth');
    whitespace();
    if (text[offset] === '"') { string(); return; }
    if (text[offset] === '{') {
      offset++;
      const seen = new Set();
      whitespace();
      if (text[offset] === '}') { offset++; return; }
      for (;;) {
        whitespace();
        const key = string();
        if (seen.has(key)) throw new Error('duplicate sender JSON key');
        seen.add(key);
        whitespace();
        if (text[offset++] !== ':') throw new Error('invalid sender JSON');
        scan(depth + 1);
        whitespace();
        const next = text[offset++];
        if (next === '}') return;
        if (next !== ',') throw new Error('invalid sender JSON');
      }
    }
    if (text[offset] === '[') {
      offset++;
      whitespace();
      if (text[offset] === ']') { offset++; return; }
      for (;;) {
        scan(depth + 1);
        whitespace();
        const next = text[offset++];
        if (next === ']') return;
        if (next !== ',') throw new Error('invalid sender JSON');
      }
    }
    const literal = /^(?:true|false|null|-?(?:0|[1-9][0-9]*))/.exec(text.slice(offset));
    if (!literal) throw new Error('invalid sender JSON');
    if (/^-?\d/.test(literal[0]) && !Number.isSafeInteger(Number(literal[0]))) throw new Error('invalid sender number');
    offset += literal[0].length;
  };
  scan(0);
  whitespace();
  if (offset !== text.length) throw new Error('invalid sender JSON');
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid sender manifest');
  return value;
}

async function exportMembers(root, directory = root) {
  const members = Object.create(null);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const name = relative(root, path).split('\\').join('/');
    if (name === 'dsh-raw-export-manifest.json') continue;
    if (entry.isSymbolicLink()) throw new Error('unsafe raw export member');
    if (entry.isDirectory()) Object.assign(members, await exportMembers(root, path));
    else if (entry.isFile()) members[name] = { sha256: digest(await readVerifiedFile(path, 16 * 1024 * 1024)) };
    else throw new Error('unsupported raw export member');
  }
  return members;
}

/** Trusted deployment supplies a 0600 file; no model or ordinary setting calls this entry. */
export async function loadVerifiedSender(deploymentFile) {
  const deployment = objectJSON(await readVerifiedFile(deploymentFile, 16 * 1024, true));
  const keys = ['bundlePath', 'exportPath', 'manifestPath', 'manifestSha256'];
  if (Object.keys(deployment).sort().join(',') !== keys.sort().join(',') || !isDigest(deployment.manifestSha256)) {
    throw new Error('invalid sender deployment');
  }
  const manifestBytes = await readVerifiedFile(deployment.manifestPath, 1024 * 1024, true);
  if (digest(manifestBytes) !== deployment.manifestSha256) throw new Error('sender manifest mismatch');
  const manifest = objectJSON(manifestBytes);
  if (!exactKeys(manifest, ['schemaVersion', 'baseline', 'patchSha256', 'exportManifestSha256', 'bundleSha256',
    'esbuildVersion', 'buildSupport', 'sources', 'metafile']) || manifest.schemaVersion !== 1 ||
    manifest.baseline !== baseline || manifest.patchSha256 !== patchDigest || typeof manifest.esbuildVersion !== 'string' ||
    !isDigest(manifest.bundleSha256) || manifest.exportManifestSha256 !== exportDigest ||
    !manifest.sources || typeof manifest.sources !== 'object' || Array.isArray(manifest.sources) ||
    !manifest.buildSupport || typeof manifest.buildSupport !== 'object' || Array.isArray(manifest.buildSupport)) {
    throw new Error('invalid sender build identity');
  }
  const exportPath = deployment.exportPath;
  if (typeof exportPath !== 'string' || !isAbsolute(exportPath) || resolve(exportPath) !== exportPath ||
    await realpath(exportPath) !== exportPath || !(await lstat(exportPath)).isDirectory()) throw new Error('unsafe raw export');
  const exportBytes = await readVerifiedFile(join(exportPath, 'dsh-raw-export-manifest.json'), 1024 * 1024);
  if (digest(exportBytes) !== manifest.exportManifestSha256) throw new Error('raw export manifest mismatch');
  const exported = objectJSON(exportBytes);
  if (!exactKeys(exported, ['archiveSha256', 'baseline', 'files', 'patchSha256']) ||
    exported.baseline !== baseline || exported.archiveSha256 !== archiveDigest || exported.patchSha256 !== patchDigest ||
    !exported.files || typeof exported.files !== 'object' || Array.isArray(exported.files) ||
    JSON.stringify(Object.entries(await exportMembers(exportPath)).sort()) !== JSON.stringify(Object.entries(exported.files).sort())) {
    throw new Error('raw export mismatch');
  }
  const supportNames = ['build_raw.mjs', 'prepare_raw.py', 'raw-only.patch', 'verified_sender_loader.mjs'];
  if (Object.keys(manifest.buildSupport).sort().join(',') !== supportNames.sort().join(',')) throw new Error('sender build support missing');
  for (const name of supportNames) {
    if (!isDigest(manifest.buildSupport[name]) || digest(await readVerifiedFile(join(supportDirectory, name), 16 * 1024 * 1024)) !== manifest.buildSupport[name]) {
      throw new Error('sender build support mismatch');
    }
  }
  const entry = join(supportDirectory, 'sender_entry.mjs');
  if (!Object.hasOwn(manifest.sources, entry)) throw new Error('sender entry missing');
  const outputs = Object.values(manifest.metafile?.outputs ?? {});
  if (outputs.length !== 1 || outputs[0]?.entryPoint !== relative(packageDirectory, entry)) throw new Error('sender build entry mismatch');
  const inputNames = Object.keys(manifest.metafile?.inputs ?? {}).map((name) => isAbsolute(name) ? name : resolve(packageDirectory, name)).sort();
  if (JSON.stringify(inputNames) !== JSON.stringify(Object.keys(manifest.sources).sort())) throw new Error('sender source list mismatch');
  for (const [path, expected] of Object.entries(manifest.sources)) {
    if ((!inside(publicChatDirectory, path) && !inside(exportPath, path)) || !isDigest(expected) ||
      digest(await readVerifiedFile(path, 16 * 1024 * 1024)) !== expected) throw new Error('sender source mismatch');
  }
  const bundle = await readVerifiedFile(deployment.bundlePath, 16 * 1024 * 1024, true);
  if (digest(bundle) !== manifest.bundleSha256) throw new Error('sender bundle mismatch');
  const bundleDirectory = dirname(deployment.bundlePath);
  const directory = await lstat(bundleDirectory);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o022) !== 0 ||
    (typeof process.getuid === 'function' && directory.uid !== process.getuid())) throw new Error('unsafe sender bundle directory');
  const verifiedCopy = join(bundleDirectory, `.verified-sender-${randomBytes(16).toString('hex')}.mjs`);
  const output = await open(verifiedCopy, 'wx', 0o600);
  let loaded;
  try {
    try {
      await output.writeFile(bundle);
      await output.sync();
    } finally {
      await output.close();
    }
    if (digest(await readVerifiedFile(verifiedCopy, 16 * 1024 * 1024, true)) !== manifest.bundleSha256 ||
      digest(await readVerifiedFile(deployment.bundlePath, 16 * 1024 * 1024, true)) !== manifest.bundleSha256) {
      throw new Error('sender bundle changed');
    }
    loaded = await import(pathToFileURL(verifiedCopy).href);
  } finally {
    await unlink(verifiedCopy);
  }
  const buildDigest = deployment.manifestSha256;
  const checkDeployment = (value) => {
    if (!value || value.buildDigest !== buildDigest) throw new Error('unverified sender build identity');
  };
  class VerifiedRuntime extends loaded.FrozenSenderRuntime {
    constructor(options) {
      checkDeployment(options?.deployment);
      if (Object.hasOwn(options, 'decodeRaw')) throw new Error('sender decoder is fixed');
      super({ ...options, decodeRaw: loaded.decodeFixedRaw });
    }
  }
  class VerifiedService extends loaded.SenderService {
    constructor(options) {
      checkDeployment(options?.deployment);
      if (!(options.runtime instanceof VerifiedRuntime)) throw new Error('unverified sender runtime');
      super(options);
    }
  }
  const createFixedRawSession = (options) => {
    if (!(options?.runtime instanceof VerifiedRuntime)) throw new Error('unverified sender runtime');
    return loaded.createFixedRawSession(options);
  };
  return Object.freeze({ ...loaded, FrozenSenderRuntime: VerifiedRuntime, SenderService: VerifiedService,
    createFixedRawSession, buildDigest });
}
