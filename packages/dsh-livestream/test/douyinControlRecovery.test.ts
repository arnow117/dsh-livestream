import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DouyinRoomControl } from '../src/dsh/douyinRoomControl';
import { DouyinControlJournal } from '../src/dsh/douyinControlJournal';

const directories: string[] = [];
const originalOrigin = process.env.DSH_LIVESTREAM_DOUYIN_BRIDGE_URL;
const anonymous = { id: 'anonymous', name: 'dsh-livestream-anonymous-test', hasCookie: false, hasLogin: false };
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), 'douyin-recovery-'));
  directories.push(dir);
  process.env.DSH_LIVESTREAM_DOUYIN_BRIDGE_URL = 'http://127.0.0.1:1234';
  return dir;
}
afterEach(async () => {
  vi.useRealTimers();
  if (originalOrigin === undefined) delete process.env.DSH_LIVESTREAM_DOUYIN_BRIDGE_URL;
  else process.env.DSH_LIVESTREAM_DOUYIN_BRIDGE_URL = originalOrigin;
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('uncertain collector operations', () => {
  it('preserves a late create after 404 across restart and does not replay it', async () => {
    const dir = await directory();
    const calls: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
      if (url.pathname === '/api/accounts') return Response.json({ accounts: [anonymous] });
      if (url.pathname === '/api/rooms/123') return Response.json({ error: 'missing' }, { status: 404 });
      if (url.pathname === '/api/rooms/123/disconnect') return Response.json({ ok: true });
      if (url.pathname === '/api/rooms/connect') throw new Error('lost response');
      throw new Error('unexpected request');
    };
    const first = new DouyinRoomControl(dir, { fetcher });
    await expect(first.connect('123', async () => 'connected')).rejects.toThrow('采集服务请求失败或超时');
    expect(first.operation.state).toBe('unknown');
    const restarted = new DouyinRoomControl(dir, { fetcher });
    expect(restarted.operation.state).toBe('unknown');
    await restarted.query('123');
    expect(restarted.operation.state).toBe('unknown');
    const externalStop = await fetcher('http://127.0.0.1:1234/api/rooms/123/disconnect', { method: 'POST' });
    expect(externalStop.status).toBe(200);
    await restarted.query('123');
    expect(restarted.operation.state).toBe('unknown');
    await expect(restarted.stop('123')).rejects.toThrow('尚未确认');
    expect(calls.filter((call) => call.startsWith('POST'))).toEqual(['POST /api/rooms/connect', 'POST /api/rooms/123/disconnect']);
  });

  it('does not treat the old terminal session as a new session', async () => {
    const dir = await directory();
    let startedAt = 100;
    const fetcher: typeof fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/accounts') return Response.json({ accounts: [anonymous] });
      if (path === '/api/rooms/123') return Response.json({ room: { roomId: '123', status: 'error', startedAt } });
      throw new Error('lost response');
    };
    const controller = new DouyinRoomControl(dir, { fetcher });
    await expect(controller.connect('123', async () => 'connected')).rejects.toThrow('采集服务请求失败或超时');
    await controller.query('123');
    expect(controller.operation.state).toBe('unknown');
    startedAt = 101;
    await controller.query('123');
    expect(controller.operation.state).toBe('idle');
  });

  it('keeps the WS initialization marker after missing acknowledgement', async () => {
    const dir = await directory();
    const fetcher: typeof fetch = async (input) => new URL(String(input)).pathname === '/api/accounts'
      ? Response.json({ accounts: [anonymous] })
      : Response.json({ room: { roomId: '123', status: 'live', startedAt: 100 } });
    vi.useFakeTimers();
    const controller = new DouyinRoomControl(dir, { fetcher });
    const pending = controller.connect('123', () => new Promise(() => {}));
    const result = expect(pending).rejects.toThrow('初始化结果未确认');
    await vi.advanceTimersByTimeAsync(45_000);
    await result;
    expect(controller.operation.state).toBe('unknown');
    const restarted = new DouyinRoomControl(dir, { fetcher });
    await restarted.query('123');
    expect(restarted.operation.state).toBe('unknown');
  });

  it('rejects missing anonymous evidence before any mutation', async () => {
    const dir = await directory();
    const methods: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      methods.push(init?.method ?? 'GET');
      return new URL(String(input)).pathname === '/api/accounts'
        ? Response.json({ accounts: [{ id: 'a', name: 'unknown', hasCookie: false }] })
        : Response.json({ room: { roomId: '123', status: 'live', startedAt: 100 } });
    };
    const controller = new DouyinRoomControl(dir, { fetcher });
    const subscribe = vi.fn(async () => 'connected' as const);
    await expect(controller.connect('123', subscribe)).rejects.toThrow('账号状态未知');
    expect(methods.every((method) => method === 'GET')).toBe(true);
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('rechecks anonymity between HTTP start and WS initialization', async () => {
    const dir = await directory();
    let accountReads = 0;
    const fetcher: typeof fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/stats') return Response.json({ uptimeSec: 1 });
      if (path === '/api/accounts') {
        accountReads++;
        return Response.json({ accounts: [accountReads === 1 ? anonymous : { ...anonymous, hasCookie: true }] });
      }
      if (path === '/api/rooms/123') return Response.json({}, { status: 404 });
      return Response.json({ ok: true, room: { roomId: '123', status: 'connecting', startedAt: 200 } });
    };
    const controller = new DouyinRoomControl(dir, { fetcher });
    const subscribe = vi.fn(async () => 'connected' as const);
    await expect(controller.connect('123', subscribe)).rejects.toThrow('登录账号');
    expect(subscribe).not.toHaveBeenCalled();
    expect(controller.operation.state).toBe('unknown');
  });

  it('reconciles only a positively identified new anonymous account', async () => {
    const dir = await directory();
    let name = '';
    let created = false;
    const fetcher: typeof fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/stats') return Response.json({ uptimeSec: 1 });
      if (path === '/api/rooms/123') return Response.json({}, { status: 404 });
      if (path === '/api/accounts' && init?.method === 'POST') {
        name = JSON.parse(String(init.body)).name;
        throw new Error('response lost');
      }
      if (path === '/api/accounts') return Response.json({ accounts: created ? [{ ...anonymous, id: 'new-account', name }] : [] });
      throw new Error('unexpected request');
    };
    const controller = new DouyinRoomControl(dir, { fetcher });
    await expect(controller.connect('123', async () => 'connected')).rejects.toThrow('采集服务请求失败');
    await controller.query('123');
    expect(controller.operation.state).toBe('unknown');
    created = true;
    await controller.query('123');
    expect(controller.operation.state).toBe('idle');
  });

  it('keeps the account marker when a create response reuses an existing account ID', async () => {
    const dir = await directory();
    const fetcher: typeof fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/stats') return Response.json({ uptimeSec: 1 });
      if (path === '/api/rooms/123') return Response.json({}, { status: 404 });
      if (path === '/api/accounts' && init?.method === 'POST') {
        return Response.json({ ok: true, account: { ...anonymous, id: 'existing', name: JSON.parse(String(init.body)).name } });
      }
      return Response.json({ accounts: [{ ...anonymous, id: 'existing', name: 'other' }] });
    };
    const controller = new DouyinRoomControl(dir, { fetcher });
    await expect(controller.connect('123', async () => 'connected')).rejects.toThrow('创建匿名账号的结果未确认');
    expect(controller.operation.state).toBe('unknown');
  });

  it('does not subscribe when HTTP returns a terminal room', async () => {
    const dir = await directory();
    const fetcher: typeof fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/stats') return Response.json({ uptimeSec: 1 });
      if (path === '/api/accounts') return Response.json({ accounts: [anonymous] });
      if (path === '/api/rooms/123') return Response.json({}, { status: 404 });
      return Response.json({ ok: true, room: { roomId: '123', status: 'closed' } });
    };
    const controller = new DouyinRoomControl(dir, { fetcher });
    const subscribe = vi.fn(async () => 'connected' as const);
    await expect(controller.connect('123', subscribe)).rejects.toThrow('已结束');
    expect(subscribe).not.toHaveBeenCalled();
    expect(controller.operation.state).toBe('idle');
  });

  it.each([400, 409, 500])('clears a settled pinned connect error response (%i)', async (status) => {
    const dir = await directory();
    const fetcher: typeof fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/stats') return Response.json({ uptimeSec: 1 });
      if (path === '/api/accounts') return Response.json({ accounts: [anonymous] });
      if (path === '/api/rooms/123') return Response.json({}, { status: 404 });
      return Response.json({ error: 'fixture failure' }, { status });
    };
    const controller = new DouyinRoomControl(dir, { fetcher });
    const subscribe = vi.fn(async () => 'connected' as const);
    await expect(controller.connect('123', subscribe)).rejects.toThrow('未能连接该房间');
    expect(controller.operation.state).toBe('idle');
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('retains the marker for a malformed 500 response', async () => {
    const dir = await directory();
    const fetcher: typeof fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/stats') return Response.json({ uptimeSec: 1 });
      if (path === '/api/accounts') return Response.json({ accounts: [anonymous] });
      if (path === '/api/rooms/123') return Response.json({}, { status: 404 });
      return new Response('{', { status: 500 });
    };
    const controller = new DouyinRoomControl(dir, { fetcher });
    await expect(controller.connect('123', async () => 'connected')).rejects.toThrow('请求失败或超时');
    expect(controller.operation.state).toBe('unknown');
  });

  it('keeps a marker when the HTTP deadline expires even if fetch ignores abort', async () => {
    const dir = await directory();
    const fetcher: typeof fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/stats') return Response.json({ uptimeSec: 1 });
      if (path === '/api/accounts') return Response.json({ accounts: [anonymous] });
      if (path === '/api/rooms/123') return Response.json({}, { status: 404 });
      return new Promise(() => {});
    };
    vi.useFakeTimers();
    const controller = new DouyinRoomControl(dir, { fetcher });
    const result = expect(controller.connect('123', async () => 'connected')).rejects.toThrow('请求失败或超时');
    await vi.advanceTimersByTimeAsync(60_000);
    await result;
    expect(controller.operation.state).toBe('unknown');
    expect(new DouyinRoomControl(dir, { fetcher }).operation.state).toBe('unknown');
  });

  it('does not dispatch after the durable write exceeds its deadline', async () => {
    const dir = await directory();
    let wall = 100_000;
    let monotonic = 0;
    const clock = { wall: () => wall, monotonic: () => monotonic, uptime: () => 10 };
    const actual = new DouyinControlJournal(dir);
    const journal = {
      get marker() { return actual.marker; },
      get corrupt() { return actual.corrupt; },
      write(value: Parameters<typeof actual.write>[0]) { actual.write(value); wall += 6_000; monotonic += 6_000; },
      clear() { actual.clear(); },
    };
    const calls: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      if (path === '/api/stats') return Response.json({ uptimeSec: 1 });
      if (path === '/api/accounts') return Response.json({ accounts: [anonymous] });
      return Response.json({}, { status: 404 });
    };
    const controller = new DouyinRoomControl(dir, { fetcher, clock, journal });
    await expect(controller.connect('123', async () => 'connected')).rejects.toThrow('发送时限已过');
    expect(calls.every((call) => call.startsWith('GET'))).toBe(true);
    expect(controller.operation.state).toBe('idle');
  });

  it('sends no mutation if the journal cannot be written', async () => {
    const dir = await directory();
    const journal = {
      marker: null,
      corrupt: false,
      write() { throw new Error('journal unavailable'); },
      clear() { throw new Error('unexpected cleanup'); },
    };
    const methods: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      methods.push(init?.method ?? 'GET');
      const path = new URL(String(input)).pathname;
      if (path === '/api/stats') return Response.json({ uptimeSec: 1 });
      if (path === '/api/accounts') return Response.json({ accounts: [anonymous] });
      return Response.json({}, { status: 404 });
    };
    const controller = new DouyinRoomControl(dir, { fetcher, journal });
    const subscribe = vi.fn(async () => 'connected' as const);
    await expect(controller.connect('123', subscribe)).rejects.toThrow('journal unavailable');
    expect(methods.every((method) => method === 'GET')).toBe(true);
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('does not dispatch if the wall clock jumps relative to the monotonic clock', async () => {
    const dir = await directory();
    let wall = 100_000;
    const methods: string[] = [];
    const clock = { wall: () => wall, monotonic: () => 0, uptime: () => 10 };
    const fetcher: typeof fetch = async (input, init) => {
      methods.push(init?.method ?? 'GET');
      const path = new URL(String(input)).pathname;
      if (path === '/api/stats') return Response.json({ uptimeSec: 1 });
      if (path === '/api/accounts') {
        wall += 60_000;
        return Response.json({ accounts: [anonymous] });
      }
      return Response.json({}, { status: 404 });
    };
    const controller = new DouyinRoomControl(dir, { fetcher, clock });
    await expect(controller.connect('123', async () => 'connected')).rejects.toThrow('系统时间变化');
    expect(methods.every((method) => method === 'GET')).toBe(true);
    expect(controller.operation.state).toBe('idle');
  });
});
