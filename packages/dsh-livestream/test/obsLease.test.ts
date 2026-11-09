import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectObs } from '../src/body/obs';
import { beginBiliOperation, inBiliOperation, invalidateTarget } from '../src/shared/biliOperations';

class FakeSocket {
  static instances: FakeSocket[] = [];
  onmessage?: (event: { data: string }) => void;
  onerror?: () => void;
  close = vi.fn();
  send = vi.fn();
  constructor(_url: string) { FakeSocket.instances.push(this); }
}

afterEach(() => {
  FakeSocket.instances = [];
  vi.unstubAllGlobals();
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
});
