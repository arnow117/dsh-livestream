/** Frozen HTTP control, replay and cancellation integration. The helper is a substitute. */
import { afterEach, describe, expect, it } from 'vitest';
import { FrozenPublicChatOperationJournal } from '../../src/publicChat/frozenJournal';
import { PublicChatSendController } from '../../src/publicChat/controller';
import type { FrozenAuthorizationRequest } from '../../src/publicChat/frozenControl';
import type { FrozenSendInput } from '../../src/publicChat/frozenSenderRuntime';
import { startFrozenHttpFixture } from './frozenHttpTestFixture';
import { TEST_ACCOUNT_RECORD_ID, TEST_BUILD_DIGEST, TEST_INSTANCE_ID, TEST_LIVE_EPOCH, TEST_PRINCIPAL_UID, TEST_ROOM_ID, waitFor } from './test-helpers';

const fixtures: Array<Awaited<ReturnType<typeof startFrozenHttpFixture>>> = [];
async function fixture() {
  const value = await startFrozenHttpFixture();
  fixtures.push(value);
  return value;
}
afterEach(async () => { for (const value of fixtures.splice(0)) await value.close(); });

async function authorize(value: Awaited<ReturnType<typeof startFrozenHttpFixture>>) {
  expect((await value.controller.refreshQualification()).ok).toBe(true);
  expect((await value.controller.authorize()).ok).toBe(true);
  const control = value.journal.controls.find((entry) => entry.kind === 'authorize' && entry.state === 'active');
  if (!control || control.kind !== 'authorize' || !control.grant) throw new Error('missing active grant');
  return control.grant;
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((done) => { release = done; });
  return { promise, release };
}

describe('frozen HTTP authorization and revocation', () => {
  it('persists the sender nonce and complete grant before one dispatch', async () => {
    const value = await fixture();
    const grant = await authorize(value);
    expect((await value.controller.submit({ requestId: 'message', sourceKey: 'source', text: 'fixture' })).status).toBe('accepted');
    await waitFor(() => value.controller.frozenOperationView('message')?.state === 'api_reported_success');
    const original = value.controller.frozenOperationView('message')!;
    expect(original.grant).toEqual(grant);
    expect(original.senderProcessNonce).toBe(value.runtime.processNonce);
    expect(value.mock.calls.filter((kind) => kind === 'send')).toHaveLength(1);
  });

  it('does not publish a late profile result after targeted capture cancellation', async () => {
    const value = await fixture();
    const waiting = deferred();
    let entered = false;
    const original = value.mock.helper.request.bind(value.mock.helper);
    value.mock.helper.request = async (kind, id, payload, guard, timeout) => {
      if (kind === 'profile') { entered = true; await waiting.promise; }
      return original(kind, id, payload, guard, timeout);
    };
    const pending = value.controller.refreshQualification();
    await waitFor(() => entered);
    value.controller.revokeGrant('owner-revoke');
    waiting.release();
    expect((await pending).ok).toBe(false);
    expect((await value.controller.authorize()).ok).toBe(false);
    expect(value.mock.calls.filter((kind) => kind === 'send')).toHaveLength(0);
  });

  it('rejects an old grant after revocation and a new qualification', async () => {
    const value = await fixture();
    const old = await authorize(value);
    value.controller.revokeGrant('owner-revoke');
    await waitFor(() => !value.controller.hold);
    await authorize(value);
    const result = await value.sender.frozenSend({ requestId: 'stale', sourceKey: 'stale', grant: old, text: 'fixture', autoEvent: null });
    expect(result.ok).toBe(false);
    expect(value.mock.calls.filter((kind) => kind === 'send')).toHaveLength(0);
  });

  it('does not dispatch an old queued entry after revocation', async () => {
    const value = await fixture();
    await authorize(value);
    const waiting = deferred();
    let entered = false;
    const sendIds: string[] = [];
    const original = value.mock.helper.request.bind(value.mock.helper);
    value.mock.helper.request = async (kind, id, payload, guard, timeout) => {
      if (kind === 'send') { sendIds.push(id); entered = true; await waiting.promise; }
      return original(kind, id, payload, guard, timeout);
    };
    await value.controller.submit({ requestId: 'first', sourceKey: 'first', text: 'fixture' });
    await waitFor(() => entered);
    expect((await value.controller.submit({ requestId: 'queued', sourceKey: 'queued', text: 'fixture two' })).status).toBe('accepted');
    value.controller.revokeGrant('owner-revoke');
    waiting.release();
    await waitFor(() => value.controller.frozenOperationView('queued')?.state === 'cancelled_before_dispatch');
    await waitFor(() => value.controller.frozenOperationView('first')?.state !== 'dispatching');
    expect(sendIds).toEqual(['first']);
  });

  it('qualification alone does not authorize sending', async () => {
    const value = await fixture();
    expect((await value.controller.refreshQualification()).ok).toBe(true);
    expect((await value.controller.submit({ requestId: 'before', sourceKey: 'before', text: 'fixture' })).status).toBe('rejected');
    expect(value.mock.calls.filter((kind) => kind === 'send')).toHaveLength(0);
  });

  it('returns the same original grant and time for the same authorization ID', async () => {
    const value = await fixture();
    const grant = await authorize(value);
    const control = value.journal.controls.find((entry) => entry.kind === 'authorize' && entry.id === grant.authorizationId);
    if (!control || control.kind !== 'authorize') throw new Error('missing control');
    const qualification = value.runtime.state().qualification;
    if (!qualification) throw new Error('missing qualification');
    const request: FrozenAuthorizationRequest = { authorizationId: control.id, expectedSenderProcessNonce: control.senderProcessNonce,
      qualificationToken: qualification.qualificationToken, localRevision: control.localRevision, target: control.target };
    const repeated = await value.sender.frozenAuthorize(request, qualification.capturedAtMs);
    expect(repeated.ok && repeated.value.kind === 'authorize' && repeated.value.grant).toEqual(grant);
    const conflict = await value.sender.frozenAuthorize({ ...request, localRevision: 'different' }, qualification.capturedAtMs);
    expect(conflict.ok).toBe(false);
    expect(value.mock.calls.filter((kind) => kind === 'bindGrant')).toHaveLength(1);
  });

  it('journals authorization before HTTP and blocks submit until its ACK returns', async () => {
    const value = await fixture();
    expect((await value.controller.refreshQualification()).ok).toBe(true);
    const waiting = deferred();
    let arrived = false;
    const original = value.sender.frozenAuthorize.bind(value.sender);
    value.sender.frozenAuthorize = async (...args) => {
      const result = await original(...args);
      arrived = true;
      await waiting.promise;
      return result;
    };
    const pending = value.controller.authorize();
    await waitFor(() => arrived);
    expect(value.journal.controls.some((entry) => entry.kind === 'authorize' && entry.state === 'authorizing')).toBe(true);
    expect((await value.controller.submit({ requestId: 'early', sourceKey: 'early', text: 'fixture' })).status).toBe('rejected');
    expect(value.mock.calls.filter((kind) => kind === 'send')).toHaveLength(0);
    waiting.release();
    expect((await pending).ok).toBe(true);
  });

  it('keeps a lost authorization ACK held until the original control is queried', async () => {
    const value = await fixture();
    expect((await value.controller.refreshQualification()).ok).toBe(true);
    const original = value.sender.frozenAuthorize.bind(value.sender);
    value.sender.frozenAuthorize = async (...args) => {
      await original(...args);
      return { ok: false, error: 'lost ACK', untrusted: false };
    };
    expect((await value.controller.authorize()).ok).toBe(false);
    const control = value.journal.controls.find((entry) => entry.kind === 'authorize');
    if (!control || control.kind !== 'authorize') throw new Error('missing original control');
    expect(control.state).toBe('authorizing_unknown');
    expect(value.controller.hold).toBe(true);
    await value.controller.reconcileControl(control.id);
    await waitFor(() => value.journal.controls.some((entry) => entry.kind === 'revoke' && entry.target.kind === 'authorization' && entry.state === 'revoked'));
    expect(value.journal.controls.filter((entry) => entry.kind === 'authorize')).toHaveLength(1);
    expect(value.mock.calls.filter((kind) => kind === 'bindGrant')).toHaveLength(1);
  });

  it('does not restore a grant from a late authorization ACK after revoke', async () => {
    const value = await fixture();
    expect((await value.controller.refreshQualification()).ok).toBe(true);
    const waiting = deferred();
    let arrived = false;
    const original = value.sender.frozenAuthorize.bind(value.sender);
    value.sender.frozenAuthorize = async (...args) => {
      const result = await original(...args);
      arrived = true;
      await waiting.promise;
      return result;
    };
    const pending = value.controller.authorize();
    await waitFor(() => arrived);
    value.controller.revokeGrant('owner-revoke');
    waiting.release();
    expect((await pending).ok).toBe(false);
    expect((await value.controller.submit({ requestId: 'late', sourceKey: 'late', text: 'fixture' })).status).toBe('rejected');
    expect(value.mock.calls.filter((kind) => kind === 'send')).toHaveLength(0);
  });

  it('an old capture revoke does not invalidate a later grant', async () => {
    const value = await fixture();
    const old = await authorize(value);
    value.controller.revokeGrant('owner-revoke');
    await waitFor(() => !value.controller.hold);
    const current = await authorize(value);
    const result = await value.sender.frozenRevoke({ revokeId: 'old-capture-again', expectedSenderProcessNonce: old.senderProcessNonce,
      target: { kind: 'capture', captureId: old.captureId } });
    expect(result.ok).toBe(true);
    expect(value.runtime.state().activeAuthorizationId).toBe(current.authorizationId);
  });

  it('never upgrades an event first seen before grant publication', async () => {
    const value = await fixture();
    const grant = await authorize(value);
    const old: FrozenSendInput = { requestId: 'old-raw', sourceKey: 'old-raw', grant, text: 'fixture',
      autoEvent: { rawId: 'raw', rawType: 'WebcastChatMessage' } };
    expect(await value.runtime.send(old)).toBeNull();
    value.observer.rawMessage('socket', { method: 'WebcastChatMessage', msgId: 'fresh', payload: new Uint8Array() });
    const fresh = await value.runtime.send({ ...old, requestId: 'fresh-raw', sourceKey: 'fresh-raw',
      autoEvent: { rawId: 'fresh', rawType: 'WebcastChatMessage' } });
    expect(fresh?.state).toBe('api_reported_success');
    expect(value.mock.calls.filter((kind) => kind === 'send')).toHaveLength(1);
  });

  it('queries the original revoke after an ACK is lost', async () => {
    const value = await fixture();
    await authorize(value);
    const original = value.sender.frozenRevoke.bind(value.sender);
    let lose = true;
    value.sender.frozenRevoke = async (...args) => {
      const result = await original(...args);
      if (lose && args[0].target.kind === 'authorization') {
        lose = false;
        return { ok: false, error: 'lost revoke ACK', untrusted: false };
      }
      return result;
    };
    value.controller.revokeGrant('owner-revoke');
    await waitFor(() => value.journal.controls.some((entry) => entry.kind === 'revoke' && entry.state === 'revoking_unknown'));
    const control = value.journal.controls.find((entry) => entry.kind === 'revoke' && entry.state === 'revoking_unknown');
    if (!control || control.kind !== 'revoke') throw new Error('missing revoke control');
    expect(value.controller.hold).toBe(true);
    expect((await value.controller.reconcileControl(control.id)).ok).toBe(true);
    expect(value.journal.controls.filter((entry) => entry.kind === 'revoke' && entry.id === control.id)).toHaveLength(1);
  });

  it('does not treat a new sender empty table as the old authorization terminal', async () => {
    const value = await fixture();
    expect((await value.controller.refreshQualification()).ok).toBe(true);
    const original = value.sender.frozenAuthorize.bind(value.sender);
    value.sender.frozenAuthorize = async (...args) => { await original(...args); return { ok: false, error: 'lost', untrusted: false }; };
    await value.controller.authorize();
    const control = value.journal.controls.find((entry) => entry.kind === 'authorize');
    if (!control || control.kind !== 'authorize') throw new Error('missing original control');
    const empty = await fixture();
    const restarted = new PublicChatSendController({ deployment: { buildDigest: TEST_BUILD_DIGEST, instanceId: TEST_INSTANCE_ID,
      accountRecordId: TEST_ACCOUNT_RECORD_ID, expectedPrincipalUid: TEST_PRINCIPAL_UID, roomId: TEST_ROOM_ID }, gateway: empty.sender,
      journal: new FrozenPublicChatOperationJournal(value.directory) });
    expect((await restarted.reconcileControl(control.id)).ok).toBe(false);
    expect(restarted.hold).toBe(true);
  });

  it('revoke ACK does not settle an active send or permit a new application request', async () => {
    const value = await fixture();
    const grant = await authorize(value);
    const waiting = deferred();
    let entered = false;
    const original = value.mock.helper.request.bind(value.mock.helper);
    value.mock.helper.request = async (kind, id, payload, guard, timeout) => {
      if (kind === 'send') { entered = true; await waiting.promise; }
      return original(kind, id, payload, guard, timeout);
    };
    await value.controller.submit({ requestId: 'in-flight', sourceKey: 'in-flight', text: 'fixture' });
    await waitFor(() => entered);
    value.controller.revokeGrant('owner-revoke');
    await waitFor(() => value.journal.controls.some((entry) => entry.kind === 'revoke' && entry.state === 'revoked' &&
      entry.target.kind === 'authorization' && entry.target.authorizationId === grant.authorizationId));
    expect(value.runtime.state().hold).toBe(true);
    expect(value.controller.frozenOperationView('in-flight')?.state).toBe('dispatching');
    waiting.release();
    await waitFor(() => value.controller.frozenOperationView('in-flight')?.state === 'unknown');
    expect(value.mock.calls.filter((kind) => kind === 'send')).toHaveLength(0);
  });
});
