import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it('revokes pending owned audio when the SSE connection drops and never reauthorizes it on reconnect', async () => {
  let source!: FakeSource;
  let player!: FakeAudio;
  let resolvePlay!: () => void;
  class FakeSource {
    onmessage?: (message: { data: string }) => void;
    onerror?: () => void;
    constructor(public url: string) { source = this; }
    send(event: unknown) { this.onmessage?.({ data: JSON.stringify(event) }); }
  }
  class FakeAudio {
    duration = 2;
    onloadedmetadata?: () => void;
    onplaying?: () => void;
    onended?: () => void;
    onerror?: () => void;
    pause = vi.fn();
    constructor() { player = this; }
    play() { return new Promise<void>((resolve) => { resolvePlay = resolve; }); }
  }
  vi.stubGlobal('location', { search: '?token=test', reload: vi.fn() });
  vi.stubGlobal('sessionStorage', { getItem: () => null });
  vi.stubGlobal('EventSource', FakeSource);
  vi.stubGlobal('Audio', FakeAudio);
  vi.stubGlobal('fetch', vi.fn(async () => ({})));
  const store = await import('../src/stage/store');
  store.connect();
  expect(source.url).toContain('outputProtocol=owned-live-v1');
  const hello = { type: 'hello', build: 'same', character: {}, template: {}, outputEpoch: 'epoch' };
  source.send(hello);
  source.send({ type: 'say', id: 'old', text: 'late', mood: '', audio: 'AQ==', estimateMs: 1000, owner: { epoch: 'epoch', turn: 'turn' } });
  source.onerror?.();
  source.send(hello);
  player.onloadedmetadata?.();
  resolvePlay();
  await Promise.resolve();
  player.onplaying?.();
  player.onerror?.();
  expect(player.pause).toHaveBeenCalled();
  expect(store.getState().line).toBeNull();
  expect(store.getState().needsClick).toBe(false);
});

it('lets an owned line already playing finish across a disconnect', async () => {
  let source!: FakeSource;
  let player!: FakeAudio;
  const receipts = vi.fn(async () => ({}));
  class FakeSource {
    onmessage?: (message: { data: string }) => void;
    onerror?: () => void;
    constructor() { source = this; }
    send(event: unknown) { this.onmessage?.({ data: JSON.stringify(event) }); }
  }
  class FakeAudio {
    duration = 2;
    onloadedmetadata?: () => void;
    onplaying?: () => void;
    onended?: () => void;
    onerror?: () => void;
    pause = vi.fn();
    constructor() { player = this; }
    play() { return Promise.resolve(); }
  }
  vi.stubGlobal('location', { search: '?token=test', reload: vi.fn() });
  vi.stubGlobal('sessionStorage', { getItem: () => null });
  vi.stubGlobal('EventSource', FakeSource);
  vi.stubGlobal('Audio', FakeAudio);
  vi.stubGlobal('fetch', receipts);
  const store = await import('../src/stage/store');
  store.connect();
  source.send({ type: 'hello', character: {}, template: {}, outputEpoch: 'epoch' });
  source.send({ type: 'say', id: 'started', text: 'already playing', mood: '', audio: 'AQ==', estimateMs: 1000, owner: { epoch: 'epoch', turn: 'turn' } });
  player.onplaying?.();
  expect(store.getState().line?.id).toBe('started');
  source.onerror?.();
  expect(player.pause).not.toHaveBeenCalled();
  player.onended?.();
  expect(store.getState().line).toBeNull();
  expect(receipts).toHaveBeenCalledWith('/said?id=started&token=test', { method: 'POST' });
});
