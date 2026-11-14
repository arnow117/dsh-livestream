import { describe, expect, it, vi } from 'vitest';
import type { FrozenSenderRuntime } from '../../src/publicChat/frozenSenderRuntime';
import { RawSenderSession } from '../../src/publicChat/rawSenderSession';

describe('raw sender session ownership', () => {
  it('installs observation before navigation, forwards sockets and closes owned resources', async () => {
    const observer = { socketCreated: vi.fn(), socketClosed: vi.fn(), rawMessage: vi.fn() };
    const runtime = { createRawEvidenceObserver: vi.fn(() => observer) } as unknown as FrozenSenderRuntime;
    const page = { url: () => 'https://live.douyin.com/101', context: () => ({}) };
    const cdp = {};
    const sessionStop = vi.fn(async () => {});
    let callbacks: any;
    const createSession = vi.fn((_room, _page, _cdp, options) => {
      callbacks = options;
      return { stop: sessionStop };
    });
    const browserClose = vi.fn(async () => {});
    const openRoom = vi.fn(async (_url, options) => {
      options.beforeNavigate(page, cdp, {});
      return { streamUrl: () => 'fixture' };
    });
    const raw = new RawSenderSession({ roomId: '101', runtime,
      createBrowser: () => ({ openRoom, close: browserClose }), createSession });
    await raw.start();
    expect(openRoom).toHaveBeenCalledWith('https://live.douyin.com/101', expect.objectContaining({ clickTrigger: false }));
    expect(runtime.createRawEvidenceObserver).toHaveBeenCalledWith('101', page, cdp);
    callbacks.onRawSocketCreated('socket', 'wss://fixture');
    const message = { method: 'WebcastChatMessage', msgId: 'raw', payload: new Uint8Array([1]) };
    callbacks.onRawMessage('socket', message);
    expect(observer.socketCreated).toHaveBeenCalledWith('socket', 'wss://fixture');
    expect(observer.rawMessage).toHaveBeenCalledWith('socket', message);
    expect(callbacks.streamUrl()).toBe('fixture');
    await expect(raw.start()).rejects.toThrow('raw session already started');
    await raw.stop();
    expect(observer.socketClosed).toHaveBeenCalledWith('socket');
    expect(sessionStop).toHaveBeenCalledTimes(1);
    expect(browserClose).toHaveBeenCalledTimes(1);
    await raw.stop();
    expect(browserClose).toHaveBeenCalledTimes(1);
  });

  it('invalidates all observed sockets on error and does not close them twice', async () => {
    const observer = { socketCreated: vi.fn(), socketClosed: vi.fn(), rawMessage: vi.fn() };
    let callbacks: any;
    const raw = new RawSenderSession({ roomId: '101',
      runtime: { createRawEvidenceObserver: () => observer } as unknown as FrozenSenderRuntime,
      createBrowser: () => ({ openRoom: async (_url, options) => {
        options.beforeNavigate({ url: () => '', context: () => ({}) }, {});
        return { streamUrl: () => null };
      }, close: async () => {} }),
      createSession: (_room, _page, _cdp, options) => {
        callbacks = options;
        return { stop: async () => {} };
      },
    });
    await raw.start();
    callbacks.onRawSocketCreated('one', 'wss://fixture');
    callbacks.onRawSocketCreated('two', 'wss://fixture');
    callbacks.onRawSocketClosed('one');
    callbacks.onError();
    await raw.stop();
    expect(observer.socketClosed.mock.calls).toEqual([['one'], ['two']]);
  });

  it('closes an unsuccessful browser and rejects invalid rooms', async () => {
    const close = vi.fn(async () => {});
    const runtime = {} as FrozenSenderRuntime;
    expect(() => new RawSenderSession({ roomId: 'not-a-room', runtime,
      createBrowser: () => ({ openRoom: async () => ({ streamUrl: () => null }), close }),
      createSession: () => ({ stop: async () => {} }) })).toThrow('invalid fixed room');
    const raw = new RawSenderSession({ roomId: '101', runtime,
      createBrowser: () => ({ openRoom: async () => ({ streamUrl: () => null }), close }),
      createSession: () => ({ stop: async () => {} }) });
    await expect(raw.start()).rejects.toThrow('raw observer was not installed');
    expect(close).toHaveBeenCalledTimes(1);
    await raw.stop();
  });

  it('prevents stop while browser startup is pending', async () => {
    let release!: (value: { streamUrl: () => null }) => void;
    const pending = new Promise<{ streamUrl: () => null }>((resolve) => { release = resolve; });
    const close = vi.fn(async () => {});
    const raw = new RawSenderSession({ roomId: '101', runtime: {} as FrozenSenderRuntime,
      createBrowser: () => ({ openRoom: () => pending, close }), createSession: () => ({ stop: async () => {} }) });
    const start = raw.start();
    await expect(raw.stop()).rejects.toThrow('raw session is starting');
    release({ streamUrl: () => null });
    await expect(start).rejects.toThrow('raw observer was not installed');
    expect(close).toHaveBeenCalledTimes(1);
  });
});
