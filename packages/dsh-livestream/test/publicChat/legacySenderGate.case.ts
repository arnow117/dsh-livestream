import { describe, expect, it } from 'vitest';
import { PUBLIC_CHAT_PROTOCOL, validateSenderStateWire, type SenderDeploymentFile, type SenderStateWire } from '../../src/publicChat/protocol';
import { SenderService } from '../../src/publicChat/senderService';
import type { SenderRuntime } from '../../src/publicChat/senderRuntime';

const legacy: SenderStateWire = {
  protocol: PUBLIC_CHAT_PROTOCOL, buildDigest: 'a'.repeat(64), instanceId: 'instance', processNonce: 'sender',
  senderConnectionGeneration: 1, capabilities: ['explicit-grant-snapshot-v1'], activeAuthorizationId: null,
  session: null, qualification: { state: 'none', capturedAt: null, principalUid: null, qualificationToken: null }, hold: false,
};

describe('legacy sender incompatibility', () => {
  it('rejects a sender missing frozen transport and private protocol capabilities', () => {
    expect(validateSenderStateWire(legacy).ok).toBe(false);
    expect(validateSenderStateWire({ ...legacy, privateProtocol: 'dsh-public-chat-http-v1',
      capabilities: ['explicit-grant-snapshot-v1', 'frozen-http-auth-v1', 'no-replay-http1-v1'] }).ok).toBe(true);
  });

  it('refuses to expose legacy browser runtime through the sender service', () => {
    const runtime = { state: () => legacy } as unknown as SenderRuntime;
    expect(() => new SenderService({ runtime, deployment: {} as SenderDeploymentFile, token: 'fixture' })).toThrow();
  });
});
