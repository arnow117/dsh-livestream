import { afterEach, describe, expect, it, vi } from 'vitest';
import { AsyncResource } from 'node:async_hooks';
import { connectObs } from '../src/body/obs';
import { beginBiliCleanup, beginBiliOperation, inBiliOperation, invalidateTarget } from '../src/shared/biliOperations';

class FakeSocket {
  static instances: FakeSocket[] = [];
  onmessage?: (event: { data: string }) => void;
  onerror?: () => void;
  onclose?: () => void;
  close = vi.fn();
  send = vi.fn();
  constructor(_url: string) { FakeSocket.instances.push(this); }
}

afterEach(() => {
  FakeSocket.instances = [];
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('OBS operation epoch', () => {
  it('closes a pending handshake after target invalidation', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    const lease = beginBiliOperation();
    try {
      const connection = inBiliOperation(lease, () => connectObs(false));
      const socket = FakeSocket.instances[0];
      invalidateTarget();
      inBiliOperation(lease, () => socket.onmessage?.({ data: JSON.stringify({ op: 0, d: {} }) }));
      await expect(connection).rejects.toThrow('直播目标已变化');
      expect(socket.close).toHaveBeenCalledOnce();
      expect(socket.send).not.toHaveBeenCalled();
    } finally { lease.release(); }
  });
  it('refuses an OBS request after the target has changed', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    const lease = beginBiliOperation();
    try {
      const connection = inBiliOperation(lease, () => connectObs(false));
      const socket = FakeSocket.instances[0];
      inBiliOperation(lease, () => socket.onmessage?.({ data: JSON.stringify({ op: 0, d: {} }) }));
      inBiliOperation(lease, () => socket.onmessage?.({ data: JSON.stringify({ op: 2, d: {} }) }));
      const obs = await connection;
      expect(socket.send).toHaveBeenCalledTimes(1);
      invalidateTarget();
      expect(() => inBiliOperation(lease, () => obs.call('StartStream'))).toThrow('直播目标已变化');
      expect(socket.send).toHaveBeenCalledTimes(1);
      obs.close();
    } finally { lease.release(); }
  });
  it('settles a cleanup reply delivered in the original stale socket context', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    const old = beginBiliOperation();
    const connection = inBiliOperation(old, () => connectObs(false));
    const socket = FakeSocket.instances[0];
    const oldContext = inBiliOperation(old, () => new AsyncResource('obs-test'));
    const receive = (data: unknown) => oldContext.runInAsyncScope(() => socket.onmessage?.({ data: JSON.stringify(data) }));
    receive({ op: 0, d: {} });
    receive({ op: 2, d: {} });
    const obs = await connection;
    invalidateTarget();
    const cleanup = beginBiliCleanup();
    try {
      const pending = inBiliOperation(cleanup, () => obs.call('StopStream'));
      const request = JSON.parse(socket.send.mock.calls.at(-1)![0]);
      receive({ op: 7, d: { requestId: request.d.requestId, requestStatus: { result: true }, responseData: { stopped: true } } });
      await expect(Promise.race([pending, Promise.resolve('pending')])).resolves.toEqual({ stopped: true });
      expect(socket.close).not.toHaveBeenCalled();
      obs.close();
    } finally {
      cleanup.release();
      old.release();
      oldContext.emitDestroy();
    }
  });
  it('settles an already-sent start reply after the original lease is invalidated', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    const lease = beginBiliOperation();
    const oldContext = inBiliOperation(lease, () => new AsyncResource('obs-start-test'));
    try {
      const connection = inBiliOperation(lease, () => connectObs(false));
      const socket = FakeSocket.instances[0];
      const receive = (data: unknown) => oldContext.runInAsyncScope(() => socket.onmessage?.({ data: JSON.stringify(data) }));
      receive({ op: 0, d: {} });
      receive({ op: 2, d: {} });
      const obs = await connection;
      const pending = inBiliOperation(lease, () => obs.call('StartStream'));
      const request = JSON.parse(socket.send.mock.calls.at(-1)![0]);
      invalidateTarget();
      receive({ op: 7, d: { requestId: request.d.requestId, requestStatus: { result: true } } });
      await expect(pending).resolves.toEqual({});
      expect(() => inBiliOperation(lease, () => obs.call('GetStreamStatus'))).toThrow('直播目标已变化');
      obs.close();
    } finally {
      lease.release();
      oldContext.emitDestroy();
    }
  });
  it.each(['close', 'error', 'explicit close', 'timeout'])('settles and clears pending requests on %s', async (ending) => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeSocket);
    const connection = connectObs(false);
    const socket = FakeSocket.instances[0];
    socket.onmessage?.({ data: JSON.stringify({ op: 0, d: {} }) });
    socket.onmessage?.({ data: JSON.stringify({ op: 2, d: {} }) });
    const obs = await connection;
    const first = obs.call('One');
    const second = obs.call('Two');
    const results = Promise.allSettled([first, second]);
    if (ending === 'close') socket.onclose?.();
    if (ending === 'error') socket.onerror?.();
    if (ending === 'explicit close') obs.close();
    if (ending === 'timeout') await vi.advanceTimersByTimeAsync(10_000);
    expect((await results).map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(vi.getTimerCount()).toBe(0);
    obs.close();
  });
  it('registers a request before sending when a reply arrives synchronously', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    const connection = connectObs(false);
    const socket = FakeSocket.instances[0];
    socket.onmessage?.({ data: JSON.stringify({ op: 0, d: {} }) });
    socket.onmessage?.({ data: JSON.stringify({ op: 2, d: {} }) });
    const obs = await connection;
    socket.send.mockImplementation((raw: string) => {
      const request = JSON.parse(raw);
      socket.onmessage?.({ data: JSON.stringify({ op: 7, d: { requestId: request.d.requestId, requestStatus: { result: true } } }) });
    });
    await expect(obs.call('Immediate')).resolves.toEqual({});
    obs.close();
  });
});
