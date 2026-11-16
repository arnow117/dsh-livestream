import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { loadVerifiedSender } from './verified_sender_loader.mjs';

function argumentsFrom(argv) {
  if (argv.length % 2 !== 0) throw new Error('invalid arguments');
  const values = Object.create(null);
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!/^--[a-z-]+$/.test(key) || Object.hasOwn(values, key)) throw new Error('invalid arguments');
    values[key] = argv[index + 1];
  }
  const mode = values['--mode'];
  const expected = mode === 'existing' ? ['--mode', '--build', '--output', '--source'] :
    mode === 'first' ? ['--mode', '--build', '--output', '--data-dir', '--listen-url', '--room-id'] : [];
  if (!expected.length || Object.keys(values).length !== expected.length || expected.some((key) => !values[key])) throw new Error('invalid arguments');
  return values;
}

async function privateDirectory(path) {
  if (!isAbsolute(path) || resolve(path) !== path || await realpath(path) !== path) throw new Error('unsafe data directory');
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
    (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw new Error('unsafe data directory');
}

async function readPrivate(path) {
  if (!isAbsolute(path) || resolve(path) !== path || await realpath(path) !== path) throw new Error('unsafe private file');
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & 0o777) !== 0o600 ||
    before.size <= 0 || before.size > 1024 * 1024 || (typeof process.getuid === 'function' && before.uid !== process.getuid())) throw new Error('unsafe private file');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await file.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1 || opened.size !== before.size) throw new Error('private file changed');
    const bytes = await file.readFile();
    const after = await file.stat();
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('private file changed');
    return bytes;
  } finally { await file.close(); }
}

async function syncDirectory(path) {
  const directory = await open(path, constants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
}

async function removeCreated(path, identity, expected) {
  if (!identity) return;
  try {
    const current = await lstat(path);
    if (current.isFile() && !current.isSymbolicLink() && current.nlink === 1 &&
      current.dev === identity.dev && current.ino === identity.ino && (await readPrivate(path)).equals(expected)) await unlink(path);
  } catch { /* Only the exact file created by this invocation may be removed. */ }
}

async function main() {
  const args = argumentsFrom(process.argv.slice(2));
  const output = args['--output'];
  if (!isAbsolute(output) || resolve(output) !== output || await realpath(dirname(output)) !== dirname(output)) throw new Error('unsafe output');
  const parent = await lstat(dirname(output));
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o022) !== 0 ||
    (typeof process.getuid === 'function' && parent.uid !== process.getuid())) throw new Error('unsafe output directory');
  const sender = await loadVerifiedSender(args['--build']);
  let roomId, listenUrl, dataDir, instanceId, accountRecordId;
  if (args['--mode'] === 'existing') {
    const bytes = await readPrivate(args['--source']);
    const parsed = sender.parseStrictJSON(bytes, 1024 * 1024);
    const validation = sender.validateSenderDeploymentFile(parsed);
    if (!validation.ok) throw new Error('source deployment invalid');
    const previous = validation.value;
    ({ roomId, listenUrl, dataDir, instanceId, accountRecordId } = previous);
    await privateDirectory(dataDir);
    const journalPath = join(dataDir, 'public-chat-operations.json');
    const before = await readPrivate(journalPath);
    const journal = new sender.FrozenPublicChatOperationJournal(dataDir);
    if (journal.corrupt) throw new Error('source history unavailable');
    const after = await readPrivate(journalPath);
    if (!before.equals(after)) throw new Error('source history changed');
  } else {
    dataDir = args['--data-dir'];
    roomId = args['--room-id'];
    listenUrl = args['--listen-url'];
    await privateDirectory(dataDir);
    if ((await readdir(dataDir)).length !== 0) throw new Error('first deployment requires an explicitly empty directory');
    if (dirname(output) === dataDir) throw new Error('candidate must be outside first data directory');
    instanceId = `instance-${randomBytes(16).toString('hex')}`;
    accountRecordId = `account-${randomBytes(16).toString('hex')}`;
  }
  const candidate = { schemaVersion: 2, transportKind: 'session_http', listenUrl, token: randomBytes(32).toString('base64url'),
    roomId, accountRecordId, buildDigest: sender.buildDigest, instanceId, dataDir };
  if (!sender.validateSenderDeploymentFile(candidate).ok) throw new Error('candidate deployment invalid');
  const bytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
  let createdJournal;
  let createdOutput;
  const journalPath = join(dataDir, 'public-chat-operations.json');
  const initialJournal = Buffer.from('{"schemaVersion":4,"records":[],"controls":[]}');
  try {
    if (args['--mode'] === 'first') {
      const journal = await open(journalPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        createdJournal = await journal.stat();
        await journal.writeFile(initialJournal);
        await journal.sync();
      } finally { await journal.close(); }
      if (JSON.stringify(await readdir(dataDir)) !== JSON.stringify(['public-chat-operations.json'])) throw new Error('first data directory changed');
      await syncDirectory(dataDir);
    }
    const file = await open(output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { createdOutput = await file.stat(); await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    await syncDirectory(dirname(output));
  } catch (error) {
    await removeCreated(output, createdOutput, bytes);
    await removeCreated(journalPath, createdJournal, initialJournal);
    throw error;
  }
  console.log(`candidate_sha256=${createHash('sha256').update(bytes).digest('hex')}`);
}

main().catch(() => { console.error('session deployment preparation failed'); process.exitCode = 1; });
