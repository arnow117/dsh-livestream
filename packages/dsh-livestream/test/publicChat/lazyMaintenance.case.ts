import { describe, expect, it } from 'vitest';
import { FrozenSenderRuntime } from '../../src/publicChat/frozenSenderRuntime';
import type { HelperProcess } from '../../src/publicChat/helperLauncher';

describe('trusted maintenance resolver', () => {
  it('invalidates the old helper before awaiting the material reference and does not revive it on failure', async () => {
    let launches = 0;
    const helper = { recoveryVerified: true, identity: { helperNonce: 'helper', authContextId: 'context',
      authContextRevision: 1, materialDigest: 'c'.repeat(64) }, close: async () => {} } as unknown as HelperProcess;
    const runtime = new FrozenSenderRuntime({ deployment: { buildDigest: 'a'.repeat(64), instanceId: 'instance',
      accountRecordId: 'record', expectedPrincipalUid: '42', roomId: '101' }, decodeRaw: () => null,
      launch: async () => { launches++; return helper; } });
    const refs = { manifestPath: '/fixture', manifestSha256: 'a'.repeat(64), sourceDirectory: '/fixture',
      materialPath: '/fixture', deploymentPath: '/fixture', deploymentSha256: 'b'.repeat(64), dataDirectory: '/fixture' };
    expect((await runtime.beginAuthenticationMaintenance(refs)).ok).toBe(true);
    expect(runtime.state().capabilities).toContain('frozen-http-auth-v1');
    let reject!: (error: Error) => void;
    const pending = runtime.beginAuthenticationMaintenance(() => new Promise((_, fail) => { reject = fail; }));
    expect(runtime.state().capabilities).toEqual([]);
    await Promise.resolve();
    await Promise.resolve();
    reject(new Error('reference unavailable'));
    expect((await pending).ok).toBe(false);
    expect(runtime.state().capabilities).toEqual([]);
    expect(launches).toBe(1);
  });

  it('does not launch a helper after the host cancels a pending reference resolution', async () => {
    let launches = 0;
    const runtime = new FrozenSenderRuntime({ deployment: { buildDigest: 'a'.repeat(64), instanceId: 'instance',
      accountRecordId: 'record', expectedPrincipalUid: '42', roomId: '101' }, decodeRaw: () => null,
      launch: async () => { launches++; throw new Error('must not launch'); } });
    const refs = { manifestPath: '/fixture', manifestSha256: 'a'.repeat(64), sourceDirectory: '/fixture',
      materialPath: '/fixture', deploymentPath: '/fixture', deploymentSha256: 'b'.repeat(64), dataDirectory: '/fixture' };
    let finish!: (value: typeof refs) => void;
    const operation = runtime.beginAuthenticationMaintenance(() => new Promise((resolve) => { finish = resolve; }));
    runtime.cancelAuthenticationMaintenance();
    finish(refs);
    expect((await operation).ok).toBe(false);
    expect(launches).toBe(0);
    expect(runtime.state().capabilities).toEqual([]);
  });
});
