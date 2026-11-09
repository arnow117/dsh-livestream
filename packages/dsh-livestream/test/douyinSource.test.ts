import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LiveShow } from '../src/body/show';
import { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { DouyinLiveSource } from '../src/core/platforms/douyin/douyinSource';
import type { LiveSourceListener } from '../src/core/platforms/source';

let server: Server | undefined;
let wss: WebSocketServer | undefined;
let source: DouyinLiveSource | undefined;
afterEach(async () => {
  source?.stop();
  if (wss) await new Promise<void>((resolve) => wss!.close(() => resolve()));
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  source = undefined;
  wss = undefined;
  server = undefined;
});

async function bridge(): Promise<{ url: string; send: (value: unknown) => void; connections: () => number; requests: () => string[] }> {
  let connections = 0;
  const requests: string[] = [];
  server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ room: { roomId: '123', status: 'connecting' } }));
  });
  wss = new WebSocketServer({ server });
  wss.on('connection', () => { connections++; });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  return {
    url: `http://127.0.0.1:${address.port}`,
    send: (value) => { for (const socket of wss!.clients) socket.send(JSON.stringify(value)); },
    connections: () => connections,
    requests: () => requests,
  };
}

function listener() {
  const states: string[] = [];
  const events: Parameters<LiveSourceListener['event']>[0][] = [];
  const stats: Parameters<LiveSourceListener['stats']>[0][] = [];
  return { states, events, stats, sink: {
    state: (state) => states.push(state),
    event: (event) => events.push(event),
    stats: (value) => stats.push(value),
    room: () => {},
  } satisfies LiveSourceListener };
}

const frame = (type: string, id: string, data: object) => ({
  id, roomId: '123', platform: 'douyin', type, ts: Date.now(),
  user: { id: '90071992547409931234', nickname: '观众' }, data,
});

async function eventually(check: () => void): Promise<void> {
  const deadline = Date.now() + 2000;
  for (;;) {
    try { check(); return; } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

describe('DouyinLiveSource', () => {

  it('feeds the real Show path and a local fake voice without treating socket open as live', async () => {
    const b = await bridge();
    const dir = mkdtempSync(join(tmpdir(), 'douyin-show-'));
    const prompts: string[] = [];
    const stage: string[] = [];
    const spoken: string[] = [];
    const show = new LiveShow({
      push: async (_session, prompt) => { prompts.push(prompt); return true; },
      synthesize: async (sentence) => { spoken.push(sentence); return null; },
    }, { dataDir: dir, names: ['角色'] });
    const unsubscribe = show.stage.subscribe((event) => stage.push(JSON.stringify(event)), false);
    try {
      show.connectTarget({ platform: 'douyin', roomId: '123', bridgeUrl: b.url });
      await eventually(() => expect(wss!.clients.size).toBe(1));
      expect(show.hub.status().state).not.toBe('connected');
      b.send({ type: '__connected', roomId: '123', room: { roomId: '123', status: 'live' } });
      await eventually(() => expect(show.hub.status().state).toBe('connected'));
      show.goLive('fake-brain');
      await eventually(() => expect(prompts.length).toBeGreaterThan(0));
      show.turnEnded('fake-brain');
      b.send(frame('chat', 'show-message', { content: '你好，角色' }));
      await eventually(() => expect(stage.some((event) => event.includes('你好，角色') && event.includes('\"platform\":\"douyin\"'))).toBe(true));
      await eventually(() => expect(prompts.some((prompt) => prompt.includes('你好，角色'))).toBe(true));
      expect(prompts.every((prompt) => prompt.includes('抖音只读接入 / 本地舞台'))).toBe(true);
      const speech = show.say('你好', '', new AbortController().signal);
      await eventually(() => expect(spoken).toContain('你好'));
      await speech;
    } finally {
      unsubscribe();
      show.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

  it('does not report a socket as live and processes only the selected room', async () => {
    const b = await bridge();
    const received = listener();
    source = new DouyinLiveSource('123', b.url);
    source.start(received.sink);
    await eventually(() => expect(wss!.clients.size).toBe(1));
    expect(received.states).not.toContain('connected');
    b.send({ type: '__connected', roomId: '123', room: { roomId: '123', status: 'live', progress: { step: 'error' } } });
    b.send(frame('chat', 'a', { content: '你好' }));
    b.send({ ...frame('chat', 'b', { content: 'foreign' }), roomId: '456' });
    await eventually(() => expect(received.events).toHaveLength(1));
    expect(received.states).toContain('connected');
    expect(received.events[0]).toMatchObject({ platform: 'douyin', kind: 'chat', text: '你好', user: { id: '90071992547409931234' } });
  });


  it('stops its own transport after a terminal state and never resubscribes', async () => {
    const b = await bridge();
    const received = listener();
    source = new DouyinLiveSource('123', b.url);
    source.start(received.sink);
    await eventually(() => expect(b.connections()).toBe(1));
    b.send({ type: '__connected', roomId: '123', room: { roomId: '123', status: 'live' } });
    await eventually(() => expect(received.states).toContain('connected'));
    b.send(frame('roomStatus', 'ended', { status: 'closed', message: '结束' }));
    await eventually(() => expect(received.states.at(-1)).toBe('error'));
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    expect(b.connections()).toBe(1);
    expect(b.requests().every((request) => request === 'GET /api/rooms/123')).toBe(true);
  });

  it('counts only positive combo increments, including the end frame', async () => {
    const b = await bridge();
    const received = listener();
    source = new DouyinLiveSource('123', b.url);
    source.start(received.sink);
    await eventually(() => expect(wss!.clients.size).toBe(1));
    [1, 3, 3, 2, 4].forEach((repeatCount, index) => b.send(frame('gift', `m${index}`, {
      giftId: '91', giftName: '花', groupId: '5', combo: true, repeatCount,
      repeatEnd: index === 4,
    })));
    b.send(frame('gift', 'bad', { giftId: '91', giftName: '花', groupId: '0', combo: true, repeatCount: 1 }));
    await eventually(() => expect(received.events).toHaveLength(3));
    expect(received.events.map((event) => event.kind === 'gift' && event.count)).toEqual([1, 2, 1]);
    expect(received.events.every((event) => event.kind === 'gift' && event.valueKnown === false)).toBe(true);
  });
});
