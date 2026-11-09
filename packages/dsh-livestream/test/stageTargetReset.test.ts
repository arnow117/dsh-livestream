import { afterEach, describe, expect, it, vi } from 'vitest';

describe('stage target reset receiver', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('clears target state without interrupting the active audio or its receipt', async () => {
    const reload = vi.fn();
    const fetch = vi.fn(async () => ({}));
    let source!: FakeEventSource;
    let player!: FakeAudio;
    class FakeEventSource {
      onmessage?: (message: { data: string }) => void;
      constructor() { source = this; }
      send(event: unknown) { this.onmessage?.({ data: JSON.stringify(event) }); }
    }
    class FakeAudio {
      duration = 2;
      paused = false;
      currentTime = 0;
      onloadedmetadata?: () => void;
      onended?: () => void;
      onerror?: () => void;
      pause = vi.fn();
      constructor() { player = this; }
      play() { return Promise.resolve(); }
    }
    vi.stubGlobal('location', { search: '?token=test', reload });
    vi.stubGlobal('sessionStorage', { getItem: () => null });
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('Audio', FakeAudio);
    vi.stubGlobal('fetch', fetch);
    const store = await import('../src/stage/store');
    store.connect();
    source.send({ type: 'live', event: { kind: 'chat', id: 'chat', user: { id: '1', name: 'A' }, text: 'old' }, isUpdate: false });
    source.send({ type: 'live', event: { kind: 'gift', id: 'gift', user: { id: '1', name: 'A' }, gift: 'flower', count: 1, yuan: 5 }, isUpdate: false });
    source.send({ type: 'focus', userIds: ['1'] });
    source.send({ type: 'room', online: 9, onAir: false });
    source.send({ type: 'say', id: 'line', text: 'playing', mood: '', estimateMs: 2000, audio: 'AQ==' });
    player.onloadedmetadata?.();
    expect(store.getState().line?.id).toBe('line');
    expect(store.getState().reply).toHaveLength(1);
    source.send({ type: 'reload', scope: 'target' });
    expect(reload).not.toHaveBeenCalled();
    expect(player.pause).not.toHaveBeenCalled();
    expect(store.getState()).toMatchObject({ chats: [], alerts: [], reply: [], online: undefined, line: { id: 'line' }, stats: { chats: 0, viewers: 0, peakOnline: 0, supporters: [] } });
    expect(store.getState().focus.size).toBe(0);
    source.send({ type: 'focus', userIds: ['1'] });
    expect(store.getState().reply).toEqual([]);
    source.send({ type: 'live', event: { kind: 'chat', id: 'new', user: { id: '2', name: 'B' }, text: 'new' }, isUpdate: false });
    expect(store.getState().stats).toMatchObject({ chats: 1, viewers: 1, supporters: [] });
    player.onended?.();
    expect(fetch).toHaveBeenCalledWith('/said?id=line&token=test', { method: 'POST' });
    source.send({ type: 'reload' });
    expect(reload).toHaveBeenCalledOnce();
  });
});
