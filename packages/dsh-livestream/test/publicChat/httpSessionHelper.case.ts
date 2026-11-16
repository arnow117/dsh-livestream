import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { HelperProcess } from '../../src/publicChat/helperLauncher';
import { encodeHelperFrame, HelperFrameDecoder, SESSION_HELPER_PROTOCOL } from '../../src/publicChat/helperProtocol';

class SyntheticChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 12345;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  private readonly decoder = new HelperFrameDecoder();
  private revision = 0;
  private context = 'initial';
  private digest = 'a'.repeat(64);
  readonly received: string[] = [];
  pauseQuery = false;
  finishQuery: (() => void) | null = null;

  constructor() {
    super();
    this.stdin.on('data', (chunk: Buffer) => {
      for (const raw of this.decoder.push(chunk)) {
        const frame = raw as Record<string, unknown>;
        this.received.push(String(frame.kind));
        let status = 'ok';
        let payload: unknown = {};
        if (frame.kind === 'hello') {
          status = 'available';
          payload = { capabilities: ['private-framing-v1', 'session-http-auth-v1', 'no-replay-http1-v1', 'unknown-recovery-v1'] };
        } else if (frame.kind === 'login-start') {
          status = 'accepted';
          this.revision++;
          this.context = 'attempt-context';
          this.digest = 'b'.repeat(64);
        } else if (frame.kind === 'confirm-session') {
          status = 'authenticated';
          this.revision++;
          this.context = 'confirmed-context';
          this.digest = 'c'.repeat(64);
        }
        const response = encodeHelperFrame({ protocol: SESSION_HELPER_PROTOCOL, seq: frame.seq, kind: frame.kind,
          operationId: frame.operationId, payloadHash: frame.payloadHash, helperNonce: 'helper',
          authContextId: this.context, authContextRevision: this.revision, materialDigest: this.digest, status, payload });
        if (this.pauseQuery && frame.kind === 'query') this.finishQuery = () => { this.stdout.write(response); };
        else this.stdout.write(response);
      }
    });
  }

  kill(signal: NodeJS.Signals) {
    this.signalCode = signal;
    queueMicrotask(() => this.emit('close'));
    return true;
  }
}

describe('session helper protocol', () => {
  it('advances identity only on matching session controls without claiming an authenticated hello', async () => {
    const child = new SyntheticChild();
    const helper = new HelperProcess(child as unknown as ChildProcess, 0, () => {}, 'session_http');
    try {
      await helper.initialize();
      expect(helper.recoveryVerified).toBe(true);
      expect(helper.identity.authContextId).toBe('initial');
      await helper.request('login-start', 'start', {});
      expect(helper.identity).toMatchObject({ authContextId: 'attempt-context', authContextRevision: 1 });
      await helper.request('confirm-session', 'confirm', { bindingRef: 'fixture-ref' });
      expect(helper.identity).toMatchObject({ authContextId: 'confirmed-context', authContextRevision: 2 });
    } finally {
      await helper.close();
    }
  });

  it('waits for an existing frame before dispatching one session control', async () => {
    const child = new SyntheticChild();
    const helper = new HelperProcess(child as unknown as ChildProcess, 0, () => {}, 'session_http');
    try {
      await helper.initialize();
      child.pauseQuery = true;
      const original = helper.request('query', 'original', {});
      const login = helper.request('login-start', 'start-after-original', {});
      await expect(helper.request('login-status', 'concurrent', {})).rejects.toThrow('helper unavailable');
      expect(child.received).toEqual(['hello', 'query']);
      expect(child.finishQuery).not.toBeNull();
      child.finishQuery!();
      await original;
      expect((await login).status).toBe('accepted');
      expect(child.received).toEqual(['hello', 'query', 'login-start']);
      expect(helper.identity.authContextRevision).toBe(1);
    } finally {
      await helper.close();
    }
  });
});
