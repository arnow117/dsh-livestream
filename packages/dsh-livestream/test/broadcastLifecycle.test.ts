import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertBiliCurrent, biliOperationsActive, invalidateTarget } from '../src/shared/biliOperations';

const mocks = vi.hoisted(() => ({
  whoami: vi.fn(), ensureRoom: vi.fn(), preLive: vi.fn(), update: vi.fn(), start: vi.fn(), stop: vi.fn(),
  connectObs: vi.fn(), prepareObs: vi.fn(), startStreaming: vi.fn(), stopStreaming: vi.fn(), streamHealth: vi.fn(),
}));
vi.mock('../src/body/biliRoom', () => ({
  BiliRoom: class {
    whoami = mocks.whoami;
    ensureRoom = mocks.ensureRoom;
    preLive = mocks.preLive;
    update = mocks.update;
    start = mocks.start;
    stop = mocks.stop;
  },
  sameCover: () => true,
}));
vi.mock('../src/body/obs', () => ({
  connectObs: mocks.connectObs, prepareObs: mocks.prepareObs, startStreaming: mocks.startStreaming,
  stopStreaming: mocks.stopStreaming, streamHealth: mocks.streamHealth,
}));
import { Broadcast } from '../src/body/broadcast';

const makeBroadcast = () => new Broadcast({
  cookie: async () => 'fake', stageUrl: () => 'http://127.0.0.1:1', areaId: () => 1,
  title: () => 'title', protocol: () => 'rtmp', kbps: () => 1000, cover: () => null, onRoom() {},
});

afterEach(() => vi.resetAllMocks());

describe('broadcast operation ownership', () => {
  it('holds the preparation lease and prevents later work after target invalidation', async () => {
    let finish!: (value: unknown) => void;
    mocks.whoami.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const broadcast = makeBroadcast();
    broadcast.start();
    await vi.waitFor(() => expect(mocks.whoami).toHaveBeenCalled());
    expect(broadcast.hasActivity).toBe(true);
    expect(biliOperationsActive()).toBe(true);
    invalidateTarget();
    finish({ loggedIn: true });
    await vi.waitFor(() => expect(broadcast.status().phase).toBe('error'));
    await vi.waitFor(() => expect(biliOperationsActive()).toBe(false));
    expect(mocks.ensureRoom).not.toHaveBeenCalled();
    expect(mocks.connectObs).not.toHaveBeenCalled();
  });

  it('keeps adoption active until a late OBS connection is closed', async () => {
    let resolve!: (value: unknown) => void;
    mocks.connectObs.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const obs = { close: vi.fn() };
    const broadcast = makeBroadcast();
    const adopting = broadcast.adopt(88);
    expect(broadcast.hasActivity).toBe(true);
    expect(biliOperationsActive()).toBe(true);
    invalidateTarget();
    resolve(obs);
    expect(await adopting).toBe(false);
    expect(obs.close).toHaveBeenCalledOnce();
    expect(mocks.streamHealth).not.toHaveBeenCalled();
    expect(broadcast.hasActivity).toBe(false);
    expect(biliOperationsActive()).toBe(false);
  });

  it('keeps ownership until a pending OBS health check settles after stop', async () => {
    let finish!: (value: unknown) => void;
    mocks.streamHealth.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    mocks.stopStreaming.mockResolvedValue(undefined);
    const obs = { close: vi.fn() };
    const broadcast = makeBroadcast();
    (broadcast as any).obs = obs;
    const polling = (broadcast as any).poll();
    await broadcast.stop();
    expect(broadcast.hasActivity).toBe(true);
    finish({ active: false });
    await polling;
    expect(broadcast.hasActivity).toBe(false);
  });

  it('retains ownership if a room start completes after invalidation until explicitly stopped', async () => {
    let finish!: (value: unknown) => void;
    mocks.whoami.mockResolvedValue({ loggedIn: true });
    mocks.ensureRoom.mockResolvedValue(88);
    mocks.preLive.mockResolvedValue({ areaId: 1 });
    mocks.update.mockResolvedValue(undefined);
    mocks.start.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    mocks.stop.mockResolvedValue(undefined);
    const broadcast = makeBroadcast();
    broadcast.start();
    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalled());
    invalidateTarget();
    finish({ kind: 'live', stream: { addr: 'fake', code: 'fake', protocol: 'rtmp' } });
    await vi.waitFor(() => expect(broadcast.status().phase).toBe('error'));
    expect(broadcast.hasActivity).toBe(true);
    await broadcast.stop();
    expect(mocks.stop).toHaveBeenCalledWith(88);
    expect(broadcast.hasActivity).toBe(false);
  });

  it('waits for a pending room start before cleanup and shares concurrent stops', async () => {
    let finish!: (value: unknown) => void;
    mocks.whoami.mockResolvedValue({ loggedIn: true });
    mocks.ensureRoom.mockResolvedValue(88);
    mocks.preLive.mockResolvedValue({ areaId: 1 });
    mocks.update.mockResolvedValue(undefined);
    mocks.start.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    mocks.stop.mockResolvedValue(undefined);
    const broadcast = makeBroadcast();
    broadcast.start();
    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalled());
    const firstStop = broadcast.stop();
    const secondStop = broadcast.stop();
    expect(firstStop).toBe(secondStop);
    invalidateTarget();
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(broadcast.hasActivity).toBe(true);
    finish({ kind: 'live', stream: { addr: 'fake', code: 'fake', protocol: 'rtmp' } });
    await firstStop;
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    expect(broadcast.hasActivity).toBe(false);
  });

  it('retains uncertain room ownership after cleanup failure until a retry succeeds', async () => {
    mocks.whoami.mockResolvedValue({ loggedIn: true });
    mocks.ensureRoom.mockResolvedValue(88);
    mocks.preLive.mockResolvedValue({ areaId: 1 });
    mocks.update.mockResolvedValue(undefined);
    mocks.start.mockRejectedValue(new Error('unknown start outcome'));
    mocks.stop.mockRejectedValueOnce(new Error('temporary')).mockResolvedValueOnce(undefined);
    const broadcast = makeBroadcast();
    broadcast.start();
    await vi.waitFor(() => expect(broadcast.status().phase).toBe('error'));
    expect(broadcast.hasActivity).toBe(true);
    expect(broadcast.status().ownedActivity).toBe(true);
    await broadcast.stop();
    expect(broadcast.status().phase).toBe('error');
    expect(broadcast.hasActivity).toBe(true);
    await broadcast.stop();
    expect(mocks.stop).toHaveBeenCalledTimes(2);
    expect(broadcast.hasActivity).toBe(false);
    expect(broadcast.status().ownedActivity).toBe(false);
  });

  it('retains and stops an OBS stream whose start response arrives after invalidation', async () => {
    let finish!: () => void;
    const obs = { close: vi.fn() };
    mocks.whoami.mockResolvedValue({ loggedIn: true });
    mocks.ensureRoom.mockResolvedValue(88);
    mocks.preLive.mockResolvedValue({ areaId: 1 });
    mocks.update.mockResolvedValue(undefined);
    mocks.start.mockResolvedValue({ kind: 'live', stream: { addr: 'fake', code: 'fake', protocol: 'rtmp' } });
    mocks.connectObs.mockResolvedValue(obs);
    mocks.prepareObs.mockResolvedValue(undefined);
    mocks.startStreaming.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    mocks.stopStreaming.mockResolvedValue(undefined);
    mocks.stop.mockResolvedValue(undefined);
    const broadcast = makeBroadcast();
    broadcast.start();
    await vi.waitFor(() => expect(mocks.startStreaming).toHaveBeenCalled());
    invalidateTarget();
    finish();
    await vi.waitFor(() => expect(broadcast.status().phase).toBe('error'));
    expect(broadcast.hasActivity).toBe(true);
    expect(obs.close).not.toHaveBeenCalled();
    await broadcast.stop();
    expect(mocks.stopStreaming).toHaveBeenCalledWith(obs);
    expect(mocks.stop).toHaveBeenCalledWith(88);
    expect(obs.close).toHaveBeenCalled();
    expect(broadcast.hasActivity).toBe(false);
  });

  it('continues owner cleanup even if disconnect invalidates the previous operation', async () => {
    let resolveCookie!: (value: string) => void;
    let calls = 0;
    const cookie = vi.fn(async () => {
      calls++;
      if (calls === 1) return 'fake';
      const value = await new Promise<string>((resolve) => { resolveCookie = resolve; });
      assertBiliCurrent();
      return value;
    });
    mocks.whoami.mockResolvedValue({ loggedIn: true });
    mocks.ensureRoom.mockResolvedValue(88);
    mocks.preLive.mockResolvedValue({ areaId: 1 });
    mocks.update.mockResolvedValue(undefined);
    mocks.start.mockRejectedValue(new Error('unknown start outcome'));
    mocks.stop.mockResolvedValue(undefined);
    const broadcast = new Broadcast({
      cookie, stageUrl: () => 'http://127.0.0.1:1', areaId: () => 1,
      title: () => 'title', protocol: () => 'rtmp', kbps: () => 1000, cover: () => null, onRoom() {},
    });
    broadcast.start();
    await vi.waitFor(() => expect(broadcast.status().phase).toBe('error'));
    const stopping = broadcast.stop();
    await vi.waitFor(() => expect(cookie).toHaveBeenCalledTimes(2));
    invalidateTarget();
    resolveCookie('fake');
    await stopping;
    expect(mocks.stop).toHaveBeenCalledWith(88);
    expect(broadcast.hasActivity).toBe(false);
  });

  it('retries an OBS stop failure without losing ownership', async () => {
    const obs = { close: vi.fn() };
    mocks.whoami.mockResolvedValue({ loggedIn: true });
    mocks.ensureRoom.mockResolvedValue(88);
    mocks.preLive.mockResolvedValue({ areaId: 1 });
    mocks.update.mockResolvedValue(undefined);
    mocks.start.mockResolvedValue({ kind: 'live', stream: { addr: 'fake', code: 'fake', protocol: 'rtmp' } });
    mocks.connectObs.mockResolvedValue(obs);
    mocks.prepareObs.mockResolvedValue(undefined);
    mocks.startStreaming.mockResolvedValue(undefined);
    mocks.stopStreaming.mockRejectedValueOnce(new Error('temporary')).mockResolvedValueOnce(undefined);
    mocks.stop.mockResolvedValue(undefined);
    const broadcast = makeBroadcast();
    broadcast.start();
    await vi.waitFor(() => expect(broadcast.status().phase).toBe('streaming'));
    await broadcast.stop();
    expect(broadcast.hasActivity).toBe(true);
    await broadcast.stop();
    expect(mocks.stopStreaming).toHaveBeenCalledTimes(2);
    expect(broadcast.hasActivity).toBe(false);
  });

  it('owns OBS through streaming and complete stop', async () => {
    const obs = { close: vi.fn() };
    mocks.whoami.mockResolvedValue({ loggedIn: true });
    mocks.ensureRoom.mockResolvedValue(88);
    mocks.preLive.mockResolvedValue({ areaId: 1 });
    mocks.update.mockResolvedValue(undefined);
    mocks.start.mockResolvedValue({ kind: 'live', stream: { addr: 'fake', code: 'fake', protocol: 'rtmp' } });
    mocks.connectObs.mockResolvedValue(obs);
    mocks.prepareObs.mockResolvedValue(undefined);
    mocks.startStreaming.mockResolvedValue(undefined);
    mocks.stopStreaming.mockResolvedValue(undefined);
    mocks.stop.mockResolvedValue(undefined);
    const broadcast = makeBroadcast();
    broadcast.start();
    await vi.waitFor(() => expect(broadcast.status().phase).toBe('streaming'));
    expect(broadcast.hasActivity).toBe(true);
    await broadcast.stop();
    expect(broadcast.status().phase).toBe('idle');
    expect(broadcast.hasActivity).toBe(false);
    expect(obs.close).toHaveBeenCalled();
  });
});
