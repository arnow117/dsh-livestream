import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DouyinControlJournal, type AdmittedMarker } from '../src/dsh/douyinControlJournal';
import { DouyinRoomControl } from '../src/dsh/douyinRoomControl';

const directories: string[] = [];
const environment = { ...process.env };
const anonymous = { id: 'anon', name: 'dsh-livestream-anonymous-test', hasCookie: false, hasLogin: false };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), 'douyin-ownership-'));
  directories.push(dir);
  process.env.DSH_LIVESTREAM_DOUYIN_BRIDGE_URL = 'http://127.0.0.1:1234';
  return dir;
}
function marker(type: 'account' | 'connect'): AdmittedMarker {
  return {
    schemaVersion: 1, opId: 'old-operation', type, phase: type === 'account' ? 'account' : 'http', settled: false,
    roomId: '123', revision: 'old-revision', origin: 'http://127.0.0.1:1234', admittedAt: 100,
    dispatchNotAfter: 200, activeUntil: 300, preflightStartedAt: null, preflightMissing: true,
    bridgeVersion: 'dyhub-0.3.1-3a79c57d85c59289db3b77211b3ec01fae47d42c', bridgeRequestStart: null,
    bridgeResponseEnd: null, bridgeUptimeSec: null, bridgeStartMin: null, bridgeStartMax: null, hostBootTime: null,
    accountName: type === 'account' ? 'old-account' : null, accountIds: ['before'],
  };
}
afterEach(async () => {
  vi.unstubAllGlobals();
  process.env = { ...environment };
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('operation and lifecycle ownership', () => {
  it.each(['account', 'connect'] as const)('does not let a second old %s query erase a newer unknown operation', async (type) => {
    const dir = await directory();
    const journal = new DouyinControlJournal(dir);
    journal.write(marker(type));
    const responses = [deferred<Response>(), deferred<Response>()];
    let held = 0;
    let holdReconcile = true;
    const fetcher: typeof fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      const reconcilePath = type === 'account' ? '/api/accounts' : '/api/rooms/123';
      if (holdReconcile && path === reconcilePath && !init?.method && held < 2) return responses[held++].promise;
      if (path === '/api/stats') return Response.json({ uptimeSec: 1 });
      if (path === '/api/accounts') return Response.json({ accounts: [anonymous] });
      if (path === '/api/rooms/123') return Response.json({}, { status: 404 });
      throw new Error('lost response');
    };
    const controller = new DouyinRoomControl(dir, { journal, fetcher });
    const first = controller.query('');
    const second = controller.query('');
    await vi.waitFor(() => expect(held).toBe(2));
    const proof = type === 'account'
      ? { accounts: [{ ...anonymous, id: 'new-account', name: 'old-account' }] }
      : { room: { roomId: '123', status: 'connecting', startedAt: 1234 } };
    responses[0].resolve(Response.json(proof));
    await first;
    expect(journal.marker).toBeNull();
    holdReconcile = false;
    await expect(controller.connect('123', async () => 'connected')).rejects.toThrow();
    const newer = journal.marker;
    expect(newer?.opId).not.toBe('old-operation');
    responses[1].resolve(Response.json(proof));
    await second;
    expect(journal.marker).toBe(newer);
    expect(new DouyinControlJournal(dir).marker?.opId).toBe(newer?.opId);
    controller.dispose();
  });

  it('does not clear the WS phase using an old HTTP observation with the same operation ID', async () => {
    const dir = await directory();
    const journal = new DouyinControlJournal(dir);
    const old = marker('connect');
    journal.write(old);
    const response = deferred<Response>();
    let requested = false;
    const fetcher: typeof fetch = async (input) => {
      if (new URL(String(input)).pathname === '/api/rooms/123') {
        requested = true;
        return response.promise;
      }
      return Response.json({ uptimeSec: 1 });
    };
    const controller = new DouyinRoomControl(dir, { journal, fetcher });
    const query = controller.query('');
    await vi.waitFor(() => expect(requested).toBe(true));
    const wsMarker = { ...old, phase: 'ws' as const };
    journal.write(wsMarker);
    response.resolve(Response.json({ room: { roomId: '123', status: 'connecting', startedAt: 1234 } }));
    await query;
    expect(journal.marker).toEqual(wsMarker);
    controller.dispose();
  });

  it('does not let a disposed query clear a marker loaded by a later instance', async () => {
    const dir = await directory();
    const journal = new DouyinControlJournal(dir);
    journal.write(marker('connect'));
    const response = deferred<Response>();
    let requested = false;
    const fetcher: typeof fetch = async () => { requested = true; return response.promise; };
    const old = new DouyinRoomControl(dir, { journal, fetcher });
    const query = old.query('');
    await vi.waitFor(() => expect(requested).toBe(true));
    old.dispose();
    await query;
    const newer = new DouyinControlJournal(dir);
    const newMarker = { ...marker('connect'), opId: 'new-operation' };
    newer.write(newMarker);
    const next = new DouyinRoomControl(dir, { fetcher });
    response.resolve(Response.json({ room: { roomId: '123', status: 'connecting', startedAt: 1234 } }));
    await Promise.resolve();
    expect(new DouyinControlJournal(dir).marker).toEqual(newMarker);
    expect(next.operation.state).toBe('unknown');
    next.dispose();
  });

  it('cancels preflight on disposal without sending a mutation or subscribing', async () => {
    const dir = await directory();
    const pending = deferred<Response>();
    let preflightStarted = false;
    const methods: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      methods.push(init?.method ?? 'GET');
      if (new URL(String(input)).pathname === '/api/stats') {
        preflightStarted = true;
        return pending.promise;
      }
      throw new Error('unexpected request');
    };
    const controller = new DouyinRoomControl(dir, { fetcher });
    const subscribe = vi.fn(async () => 'connected' as const);
    const result = controller.connect('123', subscribe).catch((error: Error) => error.message);
    await vi.waitFor(() => expect(preflightStarted).toBe(true));
    controller.dispose();
    expect(await result).toContain('卸载');
    pending.resolve(Response.json({ uptimeSec: 1 }));
    await Promise.resolve();
    expect(methods).toEqual(['GET']);
    expect(subscribe).not.toHaveBeenCalled();
    expect(new DouyinControlJournal(dir).marker).toBeNull();
  });

  it('does not dispatch a stop when disposed during preflight', async () => {
    const dir = await directory();
    const pending = deferred<Response>();
    const methods: string[] = [];
    const fetcher: typeof fetch = async (_input, init) => {
      methods.push(init?.method ?? 'GET');
      return pending.promise;
    };
    const controller = new DouyinRoomControl(dir, { fetcher });
    const result = controller.stop('123').catch((error: Error) => error.message);
    await vi.waitFor(() => expect(methods).toEqual(['GET']));
    controller.dispose();
    expect(await result).toContain('卸载');
    pending.resolve(Response.json({ uptimeSec: 1 }));
    await Promise.resolve();
    expect(methods).toEqual(['GET']);
    expect(new DouyinControlJournal(dir).marker).toBeNull();
  });

  it('keeps an admitted HTTP marker across disposal and ignores its late result', async () => {
    const dir = await directory();
    const pending = deferred<Response>();
    let dispatched = false;
    const fetcher: typeof fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/stats') return Response.json({ uptimeSec: 1 });
      if (path === '/api/accounts') return Response.json({ accounts: [anonymous] });
      if (path === '/api/rooms/123') return Response.json({}, { status: 404 });
      dispatched = true;
      return pending.promise;
    };
    const old = new DouyinRoomControl(dir, { fetcher });
    const subscribe = vi.fn(async () => 'connected' as const);
    const result = old.connect('123', subscribe).catch((error: Error) => error.message);
    await vi.waitFor(() => expect(dispatched).toBe(true));
    const original = new DouyinControlJournal(dir).marker;
    expect(original?.phase).toBe('http');
    old.dispose();
    expect(await result).toContain('卸载');
    const next = new DouyinRoomControl(dir, { fetcher });
    expect(next.operation.state).toBe('unknown');
    pending.resolve(Response.json({ ok: true, room: { roomId: '123', status: 'connecting', startedAt: 200 } }));
    await Promise.resolve();
    expect(new DouyinControlJournal(dir).marker).toEqual(original);
    expect(next.operation.state).toBe('unknown');
    expect(subscribe).not.toHaveBeenCalled();
    next.dispose();
  });

  it('does not start WS after disposal during the post-HTTP account recheck', async () => {
    const dir = await directory();
    const pending = deferred<Response>();
    let accountReads = 0;
    const fetcher: typeof fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/stats') return Response.json({ uptimeSec: 1 });
      if (path === '/api/accounts') {
        accountReads++;
        return accountReads === 1 ? Response.json({ accounts: [anonymous] }) : pending.promise;
      }
      if (path === '/api/rooms/123') return Response.json({}, { status: 404 });
      return Response.json({ ok: true, room: { roomId: '123', status: 'connecting', startedAt: 200 } });
    };
    const old = new DouyinRoomControl(dir, { fetcher });
    const subscribe = vi.fn(async () => 'connected' as const);
    const result = old.connect('123', subscribe).catch((error: Error) => error.message);
    await vi.waitFor(() => expect(accountReads).toBe(2));
    const original = new DouyinControlJournal(dir).marker;
    expect(original?.phase).toBe('http');
    old.dispose();
    expect(await result).toContain('卸载');
    pending.resolve(Response.json({ accounts: [anonymous] }));
    await Promise.resolve();
    expect(subscribe).not.toHaveBeenCalled();
    expect(new DouyinControlJournal(dir).marker).toEqual(original);
  });

  it('keeps the WS marker when disposal precedes a late acknowledgement', async () => {
    const dir = await directory();
    const acknowledgement = deferred<'connected' | 'error'>();
    let subscribed = false;
    const fetcher: typeof fetch = async (input) => new URL(String(input)).pathname === '/api/accounts'
      ? Response.json({ accounts: [anonymous] })
      : new URL(String(input)).pathname === '/api/stats'
        ? Response.json({ uptimeSec: 1 })
        : Response.json({ room: { roomId: '123', status: 'live', startedAt: 100 } });
    const old = new DouyinRoomControl(dir, { fetcher });
    const result = old.connect('123', () => { subscribed = true; return acknowledgement.promise; }).catch((error: Error) => error.message);
    await vi.waitFor(() => expect(subscribed).toBe(true));
    const original = new DouyinControlJournal(dir).marker;
    expect(original?.phase).toBe('ws');
    old.dispose();
    expect(await result).toContain('卸载');
    acknowledgement.resolve('connected');
    await Promise.resolve();
    const next = new DouyinRoomControl(dir, { fetcher });
    expect(next.operation.state).toBe('unknown');
    expect(new DouyinControlJournal(dir).marker).toEqual(original);
    next.dispose();
  });
});
