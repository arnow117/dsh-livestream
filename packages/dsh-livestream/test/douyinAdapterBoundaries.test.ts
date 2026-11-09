import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveSourceListener } from '../src/core/platforms/source';
import type { StageEvent } from '../src/stage/protocol';

const transport = vi.hoisted(() => ({ sockets: [] as any[] }));

vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  class Socket extends EventEmitter {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 0;
    ping = vi.fn();
    terminate = vi.fn(() => { this.readyState = Socket.CLOSED; });

    constructor() {
      super();
      transport.sockets.push(this);
    }
  }
  return { default: Socket };
});

import { LiveShow } from '../src/body/show';
import { LiveHub } from '../src/core/hub';
import { DouyinLiveSource } from '../src/core/platforms/douyin/douyinSource';

const bridgeUrl = 'http://127.0.0.1:1';
let source: DouyinLiveSource | undefined;

beforeEach(() => {
  transport.sockets.length = 0;
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ room: { roomId: '123', status: 'connecting' } })));
});

afterEach(() => {
  source?.stop();
  source = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function collector() {
  const states: Array<{ state: string; error?: string }> = [];
  const stats: unknown[] = [];
  const listener: LiveSourceListener = {
    state: (state, detail) => states.push({ state, error: detail?.error }),
    stats: (value) => stats.push(value),
    event: () => {},
    room: () => {},
  };
  source = new DouyinLiveSource('123', bridgeUrl);
  source.start(listener);
  return { socket: transport.sockets[0], states, stats };
}

function open(socket: any): void {
  socket.readyState = 1;
  socket.emit('open');
}

function message(socket: any, value: unknown): void {
  socket.emit('message', Buffer.from(JSON.stringify(value)));
}

function expectRecovery(states: Array<{ state: string; error?: string }>, reason: string): void {
  expect(states.at(-1)).toMatchObject({ state: 'error' });
  expect(states.at(-1)?.error).toContain(reason);
  expect(states.at(-1)?.error).toContain('先断开订阅，再显式连接');
  expect(states.at(-1)?.error).toContain('采集控制台恢复或停止后重开');
}

describe('Douyin adapter terminal boundaries', () => {
  it('reports an unreachable collector and never automatically resubscribes', async () => {
    const { socket, states, stats } = collector();
    socket.emit('error', new Error('ECONNREFUSED'));
    expectRecovery(states, '无法连接采集器');
    expect(stats.at(-1)).toEqual({ online: undefined, watched: undefined, likes: undefined, live: false });
    expect(socket.terminate).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(transport.sockets).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out after 45 seconds waiting for a live room without resubscribing', async () => {
    const { socket, states } = collector();
    open(socket);
    await vi.advanceTimersByTimeAsync(20_000);
    socket.emit('pong');
    await vi.advanceTimersByTimeAsync(20_000);
    socket.emit('pong');
    expect(socket.ping).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(states.at(-1)?.state).toBe('connecting');
    await vi.advanceTimersByTimeAsync(1);
    expectRecovery(states, '等待采集超时');
    expect(socket.terminate).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(transport.sockets).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails ten seconds after the 20-second heartbeat if no pong arrives', async () => {
    const { socket, states } = collector();
    open(socket);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(socket.ping).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.ping).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(states.at(-1)?.state).toBe('connecting');
    await vi.advanceTimersByTimeAsync(1);
    expectRecovery(states, '采集连接心跳超时');
    expect(socket.terminate).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(transport.sockets).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['stopped', 'closed'])('stops on upstream %s and explains manual recovery', async (status) => {
    const { socket, states } = collector();
    open(socket);
    message(socket, { type: '__connected', roomId: '123', room: { roomId: '123', status: 'live' } });
    expect(states.at(-1)?.state).toBe('connected');
    message(socket, { type: '__connected', roomId: '123', room: { roomId: '123', status } });
    expectRecovery(states, '采集已停止或出错');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(transport.sockets).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('Douyin adapter integration boundaries', () => {
  it('delivers member and follow through the real Hub and Show to the stage', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'douyin-adapter-stage-'));
    const push = vi.fn(async () => true);
    const synthesize = vi.fn(async () => ({ audio: new Uint8Array([1, 2]), timeline: [] }));
    const show = new LiveShow({ push, synthesize }, { dataDir: dir, names: ['角色'] });
    const stage: StageEvent[] = [];
    const unsubscribe = show.stage.subscribe((event) => stage.push(event), false);
    try {
      show.connectTarget({ platform: 'douyin', roomId: '123', bridgeUrl });
      const socket = transport.sockets[0];
      open(socket);
      message(socket, { type: '__connected', roomId: '123', room: { roomId: '123', status: 'live' } });
      expect(show.hub.status().state).toBe('connected');
      show.goLive('fake-brain');
      await vi.advanceTimersByTimeAsync(300);
      expect(push).toHaveBeenCalled();
      for (const [type, id] of [['member', 'm1'], ['follow', 'f1']]) {
        message(socket, {
          id, roomId: '123', platform: 'douyin', type, ts: Date.now(),
          user: { id: '42', nickname: '观众' }, data: {},
        });
      }
      expect(show.hub.recentEvents()).toEqual([
        expect.objectContaining({ id: 'm1', kind: 'enter', platform: 'douyin', user: { id: '42', name: '观众' } }),
        expect.objectContaining({ id: 'f1', kind: 'follow', platform: 'douyin', user: { id: '42', name: '观众' } }),
      ]);
      const live = stage.filter((event) => event.type === 'live');
      expect(live).toEqual([
        expect.objectContaining({ event: expect.objectContaining({ id: 'm1', kind: 'enter', platform: 'douyin', user: { id: '42', name: '观众' } }) }),
        expect.objectContaining({ event: expect.objectContaining({ id: 'f1', kind: 'follow', platform: 'douyin', user: { id: '42', name: '观众' } }) }),
      ]);
      const controller = new AbortController();
      const speech = show.say('欢迎观众', '', controller.signal);
      await vi.advanceTimersByTimeAsync(0);
      expect(synthesize).toHaveBeenCalledOnce();
      expect(stage).toContainEqual(expect.objectContaining({ type: 'say', text: '欢迎观众' }));
      controller.abort();
      await speech;
    } finally {
      unsubscribe();
      show.endLive();
      show.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores the old subscription GET even when fetch ignores abort', async () => {
    const requests: Array<{ resolve: (response: Response) => void; signal: AbortSignal }> = [];
    vi.stubGlobal('fetch', vi.fn((_url: URL, init: RequestInit) => new Promise<Response>((resolve) => {
      requests.push({ resolve, signal: init.signal as AbortSignal });
    })));
    const hub = new LiveHub();
    try {
      hub.connect({ platform: 'douyin', roomId: '123', bridgeUrl });
      const oldSocket = transport.sockets[0];
      open(oldSocket);
      expect(requests).toHaveLength(1);
      hub.disconnect();
      expect(requests[0].signal.aborted).toBe(true);
      hub.connect({ platform: 'douyin', roomId: '456', bridgeUrl });
      const newSocket = transport.sockets[1];
      open(newSocket);
      expect(requests).toHaveLength(2);
      message(newSocket, { type: '__connected', roomId: '456', room: { roomId: '456', status: 'live' } });
      expect(hub.status()).toMatchObject({ state: 'connected', room: { platform: 'douyin', roomId: '456' }, stats: { live: true } });
      requests[0].resolve(Response.json({ room: { roomId: '123', status: 'error', error: 'old' } }));
      requests[1].resolve(Response.json({ room: { roomId: '456', status: 'connecting' } }));
      await vi.advanceTimersByTimeAsync(0);
      expect(hub.status()).toMatchObject({ state: 'connected', room: { platform: 'douyin', roomId: '456' }, stats: { live: true } });
      expect(hub.status().lastError).toBeUndefined();
    } finally {
      hub.disconnect();
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});
