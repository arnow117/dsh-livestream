import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, stat, type FileHandle } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { controlPayloadHash } from './grantAuthority';
import { HELPER_PROTOCOL, HelperFrameDecoder, encodeHelperFrame, parseHelperJSON } from './helperProtocol';
import { boundedString, hexDigest64, isObject, safeInteger } from './protocol';

const START_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 16_000;
const STOP_TIMEOUT_MS = 2_000;
const MAX_PENDING = 64;
const MAX_STDERR_BYTES = 4096;

/** The caller must retain the write hold if the owned process did not close. */
export class HelperShutdownUnconfirmedError extends Error {
  constructor() {
    super('helper process shutdown unconfirmed');
    this.name = 'HelperShutdownUnconfirmedError';
  }
}

interface VerifiedFile {
  handle: FileHandle;
  dev: number;
  ino: number;
}

interface HelperManifest {
  schemaVersion: 1;
  binaryPath: string;
  binarySha256: string;
  sourceFiles: Record<string, string>;
}

export interface HelperLaunchOptions {
  manifestPath: string;
  manifestSha256: string;
  sourceDirectory: string;
  materialPath: string;
  deploymentPath: string;
  deploymentSha256: string;
  dataDirectory: string;
  authContextRevision: number;
  onDisconnect: () => void;
}

export interface HelperReply {
  protocol: string;
  seq: number;
  kind: string;
  operationId: string;
  payloadHash: string;
  helperNonce: string;
  authContextId: string;
  authContextRevision: number;
  materialDigest: string;
  status: string;
  payload: unknown;
}

type Pending = {
  kind: string;
  operationId: string;
  hash: string;
  resolve: (reply: HelperReply) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

async function safeOpen(path: string, privateFile: boolean): Promise<VerifiedFile> {
  if (!isAbsolute(path) || resolve(path) !== path || await realpath(path) !== path) throw new Error('unsafe helper file');
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
    (typeof process.getuid === 'function' && before.uid !== process.getuid()) ||
    (privateFile ? (before.mode & 0o777) !== 0o600 : (before.mode & 0o022) !== 0)) {
    throw new Error('unsafe helper file');
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const after = await handle.stat();
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.nlink !== 1 ||
      after.uid !== before.uid || after.mode !== before.mode) throw new Error('helper file changed');
    return { handle, dev: after.dev, ino: after.ino };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function readBounded(file: FileHandle, maximum: number): Promise<Buffer> {
  const info = await file.stat();
  if (!Number.isSafeInteger(info.size) || info.size <= 0 || info.size > maximum) throw new Error('invalid helper file size');
  const data = Buffer.alloc(info.size);
  let offset = 0;
  while (offset < data.length) {
    const result = await file.read(data, offset, data.length - offset, offset);
    if (result.bytesRead <= 0) throw new Error('incomplete helper file');
    offset += result.bytesRead;
  }
  const after = await file.stat();
  if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ino !== info.ino || after.dev !== info.dev) {
    throw new Error('helper file changed');
  }
  return data;
}

async function verifyFile(path: string, expected: string, maximum: number, privateFile = false): Promise<{ dev: number; ino: number }> {
  if (!hexDigest64(expected)) throw new Error('invalid helper digest');
  const file = await safeOpen(path, privateFile);
  try {
    if (sha256(await readBounded(file.handle, maximum)) !== expected) throw new Error('helper digest mismatch');
    return { dev: file.dev, ino: file.ino };
  } finally {
    await file.handle.close();
  }
}

async function verifyManifest(options: HelperLaunchOptions): Promise<{ manifest: HelperManifest; binary: { dev: number; ino: number } }> {
  if (!hexDigest64(options.manifestSha256) || !isAbsolute(options.sourceDirectory) ||
    await realpath(options.sourceDirectory) !== options.sourceDirectory) throw new Error('invalid helper manifest');
  const manifestFile = await safeOpen(options.manifestPath, true);
  let raw: Buffer;
  try {
    raw = await readBounded(manifestFile.handle, 64 * 1024);
  } finally {
    await manifestFile.handle.close();
  }
  if (sha256(raw) !== options.manifestSha256) throw new Error('helper manifest mismatch');
  const value = parseHelperJSON(raw);
  if (!isObject(value) || Object.keys(value).sort().join(',') !== 'binaryPath,binarySha256,schemaVersion,sourceFiles' ||
    value.schemaVersion !== 1 || typeof value.binaryPath !== 'string' || !hexDigest64(value.binarySha256) || !isObject(value.sourceFiles)) {
    throw new Error('invalid helper manifest');
  }
  const files = (await readdir(options.sourceDirectory, { withFileTypes: true }))
    .filter((entry) => !entry.name.endsWith('_test.go'));
  if (files.some((entry) => !entry.isFile() || entry.isSymbolicLink())) throw new Error('unsafe helper source');
  const names = files.map((entry) => entry.name).sort();
  const manifestNames = Object.keys(value.sourceFiles).sort();
  if (!names.includes('main.go') || !names.includes('protocol.schema.json') ||
    names.length !== manifestNames.length || names.some((name, index) => name !== manifestNames[index])) {
    throw new Error('helper source list mismatch');
  }
  for (const name of names) {
    const digest = value.sourceFiles[name];
    if (basename(name) !== name || !hexDigest64(digest)) throw new Error('invalid helper source');
    await verifyFile(join(options.sourceDirectory, name), digest, 1024 * 1024);
  }
  const binary = await verifyFile(value.binaryPath, value.binarySha256, 256 * 1024 * 1024);
  return { manifest: value as unknown as HelperManifest, binary };
}

export class HelperProcess {
  private readonly pending = new Map<number, Pending>();
  private readonly decoder = new HelperFrameDecoder();
  private sequence = 0;
  private dead = false;
  private stderrBytes = 0;
  private helperNonce = '';
  private authContextId = '';
  private materialDigest = '';
  private killTimer: NodeJS.Timeout | undefined;
  private recoveryCapabilityVerified = false;
  private readonly closed: Promise<void>;

  constructor(private readonly child: ChildProcess, private readonly revision: number, private readonly onDisconnect: () => void) {
    if (!child.stdin || !child.stdout || !child.stderr) throw new Error('helper pipes unavailable');
    this.closed = new Promise((done) => child.once('close', () => {
      if (this.killTimer) clearTimeout(this.killTimer);
      this.disconnect();
      done();
    }));
    child.once('error', () => this.disconnect());
    child.once('exit', () => this.disconnect());
    child.stdin.on('error', () => this.disconnect());
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderrBytes += chunk.length;
      if (this.stderrBytes > MAX_STDERR_BYTES) this.disconnect();
    });
    child.stdout.on('data', (chunk: Buffer) => {
      try {
        for (const value of this.decoder.push(chunk)) this.receive(value);
      } catch {
        this.disconnect();
      }
    });
    child.stdout.on('end', () => {
      try { this.decoder.finish(); } catch { this.disconnect(); }
    });
  }

  get pid(): number {
    if (!this.child.pid) throw new Error('helper process unavailable');
    return this.child.pid;
  }

  get recoveryVerified(): boolean { return this.recoveryCapabilityVerified && !this.dead; }

  get identity(): Readonly<{ helperNonce: string; authContextId: string; materialDigest: string; authContextRevision: number }> {
    return Object.freeze({ helperNonce: this.helperNonce, authContextId: this.authContextId,
      materialDigest: this.materialDigest, authContextRevision: this.revision });
  }

  private disconnect(): void {
    if (this.dead) return;
    this.dead = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('helper unavailable'));
    }
    this.pending.clear();
    try { this.onDisconnect(); } catch { /* preserve fail-closed state */ }
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill('SIGTERM');
      this.killTimer = setTimeout(() => {
        if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
      }, STOP_TIMEOUT_MS);
      this.killTimer.unref();
    }
  }

  private receive(value: unknown): void {
    const keys = ['protocol', 'seq', 'kind', 'operationId', 'payloadHash', 'helperNonce', 'authContextId',
      'authContextRevision', 'materialDigest', 'status', 'payload'];
    if (!isObject(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)) ||
      value.protocol !== HELPER_PROTOCOL || !safeInteger(value.seq) ||
      !boundedString(value.kind, 128) || !boundedString(value.operationId, 128) || typeof value.payloadHash !== 'string' ||
      !boundedString(value.helperNonce, 128) || !boundedString(value.authContextId, 128) ||
      value.authContextRevision !== this.revision || !hexDigest64(value.materialDigest) || !boundedString(value.status, 128) ||
      !Object.hasOwn(value, 'payload')) throw new Error('invalid helper reply');
    const pending = this.pending.get(value.seq);
    if (!pending || pending.kind !== value.kind || pending.operationId !== value.operationId || pending.hash !== value.payloadHash) {
      throw new Error('unmatched helper reply');
    }
    if (this.helperNonce && (value.helperNonce !== this.helperNonce || value.authContextId !== this.authContextId || value.materialDigest !== this.materialDigest)) {
      throw new Error('helper identity changed');
    }
    this.pending.delete(value.seq);
    clearTimeout(pending.timer);
    pending.resolve(value as unknown as HelperReply);
  }

  /** The guard runs synchronously immediately before the original IPC write. */
  request(kind: string, operationId: string, payload: unknown, guard: () => boolean = () => true, timeout = REQUEST_TIMEOUT_MS): Promise<HelperReply> {
    if (this.dead || !this.child.stdin || !this.child.stdin.writable || this.pending.size >= MAX_PENDING ||
      !boundedString(kind, 128) || !boundedString(operationId, 128) || !isObject(payload) || this.sequence >= Number.MAX_SAFE_INTEGER) {
      return Promise.reject(new Error('helper unavailable'));
    }
    const seq = ++this.sequence;
    const hash = kind === 'hello' ? '' : controlPayloadHash(payload);
    const frame = encodeHelperFrame({ protocol: HELPER_PROTOCOL, seq, kind, operationId, payloadHash: hash,
      expectedHelperNonce: this.helperNonce, authContextId: this.authContextId, authContextRevision: this.revision,
      materialDigest: this.materialDigest, payload });
    parseHelperJSON(frame.subarray(4));
    return new Promise((resolveReply, rejectReply) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        rejectReply(new Error('helper response timeout'));
        this.disconnect();
      }, timeout);
      this.pending.set(seq, { kind, operationId, hash, resolve: resolveReply, reject: rejectReply, timer });
      try {
        if (!guard() || this.dead || !this.child.stdin?.writable) throw new Error('helper authorization changed');
        this.child.stdin.write(frame, (error) => { if (error) this.disconnect(); });
      } catch {
        clearTimeout(timer);
        this.pending.delete(seq);
        rejectReply(new Error('helper authorization changed'));
      }
    });
  }

  async initialize(): Promise<void> {
    const hello = await this.request('hello', 'hello', {}, () => true, START_TIMEOUT_MS);
    if (hello.status !== 'ready' || !isObject(hello.payload) || !Array.isArray(hello.payload.capabilities) ||
      !['private-framing-v1', 'frozen-http-auth-v1', 'no-replay-http1-v1', 'unknown-recovery-v1'].every((capability) => (hello.payload as { capabilities: unknown[] }).capabilities.includes(capability))) {
      this.disconnect();
      throw new Error('helper capability unavailable');
    }
    this.helperNonce = hello.helperNonce;
    this.authContextId = hello.authContextId;
    this.materialDigest = hello.materialDigest;
    this.recoveryCapabilityVerified = true;
  }

  async close(): Promise<void> {
    this.disconnect();
    let timer: NodeJS.Timeout | undefined;
    const closedImmediately = await Promise.race([
      this.closed.then(() => true),
      new Promise<boolean>((done) => {
        timer = setTimeout(() => {
          if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
          done(false);
        }, STOP_TIMEOUT_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (!closedImmediately) {
      let forceTimer: NodeJS.Timeout | undefined;
      const closed = await Promise.race([
        this.closed.then(() => true),
        new Promise<boolean>((done) => { forceTimer = setTimeout(() => done(false), STOP_TIMEOUT_MS); }),
      ]);
      if (forceTimer) clearTimeout(forceTimer);
      if (!closed) throw new Error('helper process did not close');
    }
  }
}

export async function launchHelper(options: HelperLaunchOptions): Promise<HelperProcess> {
  if (!safeInteger(options.authContextRevision) || typeof options.onDisconnect !== 'function') throw new Error('invalid helper deployment');
  const verified = await verifyManifest(options);
  if (!isAbsolute(options.dataDirectory) || resolve(options.dataDirectory) !== options.dataDirectory ||
    await realpath(options.dataDirectory) !== options.dataDirectory) throw new Error('invalid helper data directory');
  const dataDirectory = await lstat(options.dataDirectory);
  if (!dataDirectory.isDirectory() || dataDirectory.isSymbolicLink() || (dataDirectory.mode & 0o022) !== 0 ||
    (typeof process.getuid === 'function' && dataDirectory.uid !== process.getuid())) throw new Error('invalid helper data directory');
  const material = await safeOpen(options.materialPath, true);
  let deployment: VerifiedFile | undefined;
  let child: ChildProcess | undefined;
  let helper: HelperProcess | undefined;
  let materialClosed = false;
  let deploymentClosed = false;
  try {
    deployment = await safeOpen(options.deploymentPath, true);
    if (!hexDigest64(options.deploymentSha256) || sha256(await readBounded(deployment.handle, 64 * 1024)) !== options.deploymentSha256) {
      throw new Error('helper deployment mismatch');
    }
    child = spawn(verified.manifest.binaryPath, [], {
      cwd: options.dataDirectory,
      env: {},
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe', material.handle.fd, deployment.handle.fd],
    });
    helper = new HelperProcess(child, options.authContextRevision, options.onDisconnect);
    await new Promise<void>((ready, fail) => {
      child!.once('spawn', ready);
      child!.once('error', () => fail(new Error('helper startup failed')));
    });
    await material.handle.close();
    materialClosed = true;
    await deployment.handle.close();
    deploymentClosed = true;
    const binary = await stat(verified.manifest.binaryPath);
    if (binary.dev !== verified.binary.dev || binary.ino !== verified.binary.ino) throw new Error('helper binary changed');
    await helper.initialize();
    return helper;
  } catch {
    if (helper) {
      try {
        await helper.close();
      } catch {
        throw new HelperShutdownUnconfirmedError();
      }
    } else if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGTERM');
      } catch {
        // The process still has no confirmed close.
      }
      throw new HelperShutdownUnconfirmedError();
    }
    throw new Error('helper unavailable');
  } finally {
    // These descriptors remain open only on the failure path. Preserve an
    // unconfirmed child shutdown if a descriptor close also fails.
    if (!materialClosed) {
      try {
        await material.handle.close();
      } catch {
        // Startup has already failed.
      }
    }
    if (deployment && !deploymentClosed) {
      try {
        await deployment.handle.close();
      } catch {
        // Startup has already failed.
      }
    }
  }
}
