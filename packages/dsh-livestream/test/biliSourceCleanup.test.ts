import { describe, expect, it, vi } from 'vitest';
import { biliOperationsActive, invalidateTarget } from '../src/shared/biliOperations';

const mocks = vi.hoisted(() => ({ sockets: [] as any[] }));
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  class Socket extends EventEmitter {
    static OPEN = 1;
    readyState = 1;
    terminated = false;
    constructor() { super(); mocks.sockets.push(this); }
    send() {}
    terminate() { this.terminated = true; }
  }
  return { default: Socket };
});
vi.mock('../src/core/platforms/bilibili/biliApi', () => ({
  createBiliSession: async () => ({ uid: 1, buvid: 'x', loggedIn: false }),
  getRoom: async () => ({ realRoomId: 42, anchorId: 'a', live: true }),
  getDanmuInfo: async () => ({ token: 'x', servers: [{ host: 'fake', wss_port: 443 }] }),
}));
vi.mock('../src/core/platforms/bilibili/biliProtocol', () => ({
  makeAuthPacket: () => Buffer.alloc(0),
  makeHeartbeatPacket: () => Buffer.alloc(0),
  OP: { AUTH_REPLY: 8, MESSAGE: 5 },
  readFrame: () => [{ op: 8, ok: true }],
}));
import { BiliLiveSource } from '../src/core/platforms/bilibili/biliSource';

describe('retired Bili source', () => {
  it('holds its operation until a stopped pending handshake closes and ignores late auth', async () => {
    const source = new BiliLiveSource(42, '');
    source.start({ state() {}, room() {}, stats() {}, event() {} });
    await vi.waitFor(() => expect(mocks.sockets).toHaveLength(1));
    const socket = mocks.sockets[0];
    expect(biliOperationsActive()).toBe(true);
    invalidateTarget();
    source.stop();
    expect(socket.terminated).toBe(true);
    socket.emit('message', Buffer.alloc(0));
    expect(biliOperationsActive()).toBe(true);
    expect((source as any).ws).toBeNull();
    expect((source as any).heartbeat).toBeNull();
    socket.emit('close', 1006);
    await vi.waitFor(() => expect(biliOperationsActive()).toBe(false));
  });
});
