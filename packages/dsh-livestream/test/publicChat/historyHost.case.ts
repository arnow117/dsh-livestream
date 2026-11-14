import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loaders = vi.hoisted(() => ({ open: vi.fn(), start: vi.fn() }));
vi.mock('../../src/publicChat/trustedSender', () => ({
  openTrustedHistory: loaders.open,
  startTrustedSender: loaders.start,
}));

import { PublicChatHost } from '../../src/publicChat/publicChatHost';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function fakeHistory() {
  const controller = {
    hold: true,
    currentFrozenGrant: () => null,
    listFrozenOperations: () => [],
    listFrozenControls: () => [],
    suspendFrozenLocally: vi.fn(),
  };
  return { controller };
}

describe('one host history controller', () => {
  beforeEach(() => {
    vi.stubEnv('DSH_PUBLIC_CHAT_BUILD_DEPLOYMENT_FILE', '/fixture/build.json');
    vi.stubEnv('DSH_PUBLIC_CHAT_DEPLOYMENT_FILE', '/fixture/deployment.json');
    vi.stubEnv('DSH_PUBLIC_CHAT_BROWSER_EXECUTABLE', '/fixture/browser');
    vi.stubEnv('DSH_PUBLIC_CHAT_HELPER_MANIFEST', '/fixture/helper.json');
    vi.stubEnv('DSH_PUBLIC_CHAT_HELPER_MANIFEST_SHA256', 'a'.repeat(64));
    vi.stubEnv('DSH_PUBLIC_CHAT_HELPER_SOURCE_DIRECTORY', '/fixture/source');
    vi.stubEnv('DSH_PUBLIC_CHAT_MATERIAL_FILE', '/fixture/material');
    vi.stubEnv('DSH_PUBLIC_CHAT_HELPER_DATA_DIR', '/fixture/data');
    loaders.open.mockReset();
    loaders.start.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it('shares initialization between concurrent history views and maintenance', async () => {
    const pending = deferred<ReturnType<typeof fakeHistory>>();
    const history = fakeHistory();
    const sender = {
      controller: history.controller,
      publicView: () => ({ roomId: '101' }),
      input: { setLive: vi.fn(), inputStateChanged: vi.fn() },
      startRaw: vi.fn(async () => {}),
      observeRaw: vi.fn(), observeInvalidation: vi.fn(), close: vi.fn(async () => {}),
    };
    loaders.open.mockReturnValue(pending.promise);
    loaders.start.mockResolvedValue(sender);
    const host = new PublicChatHost(() => true, () => false, () => null, () => false);
    host.setLive({ roomId: '101', epoch: 'live', startedAtMs: 123 });
    host.inputChanged('connected', 'idle');
    const views = Array.from({ length: 8 }, () => host.view());
    const maintenance = host.maintain();
    await vi.waitFor(() => expect(loaders.open).toHaveBeenCalledTimes(1));
    pending.resolve(history);
    expect((await Promise.all(views)).every((view) => view.historyAvailable)).toBe(true);
    expect(await maintenance).toEqual({ ok: true, reason: 'ready' });
    expect(loaders.start).toHaveBeenCalledTimes(1);
    expect(loaders.start.mock.calls[0][2]).toBe(history);
    expect((await host.view()).hold).toBe(true);
    await host.close();
    expect(sender.close).toHaveBeenCalledTimes(1);
    const liveCalls = sender.input.setLive.mock.calls.length;
    const inputCalls = sender.input.inputStateChanged.mock.calls.length;
    host.setLive({ roomId: '101', epoch: 'late', startedAtMs: 456 });
    host.inputChanged('connected', 'idle');
    host.revoke();
    expect(sender.input.setLive).toHaveBeenCalledTimes(liveCalls);
    expect(sender.input.inputStateChanged).toHaveBeenCalledTimes(inputCalls);
  });

  it('closes a sender that finishes maintenance after the host closes', async () => {
    const history = fakeHistory();
    const pending = deferred<any>();
    const sender = {
      controller: history.controller,
      publicView: () => ({ roomId: '101' }),
      input: { setLive: vi.fn(), inputStateChanged: vi.fn() },
      startRaw: vi.fn(async () => {}),
      observeRaw: vi.fn(), observeInvalidation: vi.fn(), close: vi.fn(async () => {}),
    };
    loaders.open.mockResolvedValue(history);
    loaders.start.mockReturnValue(pending.promise);
    const host = new PublicChatHost(() => true, () => false, () => null, () => false);
    host.setLive({ roomId: '101', epoch: 'live', startedAtMs: 123 });
    host.inputChanged('connected', 'idle');
    const maintenance = host.maintain();
    await vi.waitFor(() => expect(loaders.start).toHaveBeenCalledTimes(1));
    const close = host.close();
    const concurrentClose = host.close();
    expect(concurrentClose).toBe(close);
    const isCurrent = loaders.start.mock.calls[0][3] as () => boolean;
    expect(isCurrent()).toBe(false);
    pending.resolve(sender);
    expect((await maintenance).ok).toBe(false);
    await Promise.all([close, concurrentClose]);
    expect(sender.startRaw).not.toHaveBeenCalled();
    expect(sender.close).toHaveBeenCalledTimes(1);
    expect((await host.view()).historyAvailable).toBe(false);
  });

  it('does not install a late history after close', async () => {
    const pending = deferred<ReturnType<typeof fakeHistory>>();
    loaders.open.mockReturnValue(pending.promise);
    const host = new PublicChatHost(() => false, () => false, () => null, () => false);
    const view = host.view();
    await vi.waitFor(() => expect(loaders.open).toHaveBeenCalledTimes(1));
    const close = host.close();
    const isCurrent = loaders.open.mock.calls[0][1] as () => boolean;
    expect(isCurrent()).toBe(false);
    pending.resolve(fakeHistory());
    await close;
    expect((await view).historyAvailable).toBe(false);
    expect((await host.view()).hold).toBe(true);
    expect(loaders.open).toHaveBeenCalledTimes(1);
    expect(loaders.start).not.toHaveBeenCalled();
  });
});
