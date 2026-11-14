import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { LiveHub } from '../../src/core/hub';
import { readSourceIngress } from '../../src/publicChat/sourceIngress';

describe('real Douyin source ingress', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  it('exposes original frames before aggregation, without upgrading ordinary ingest', async () => {
    const server = createServer((request, response) => {
      if (request.url !== '/api/rooms/101') {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ room: { roomId: '101', status: 'live' } }));
    });
    const sockets = new WebSocketServer({ server });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string' || [3080, 3081, 7390, 8757].includes(address.port)) {
      throw new Error('unexpected fixture listener');
    }
    console.info(`owned-source-listener pid=${process.pid} port=${address.port}`);
    cleanups.push(async () => {
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve, reject) => sockets.close((error) => error ? reject(error) : resolve()));
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    });
    const hub = new LiveHub();
    cleanups.push(async () => { hub.disconnect(); });
    const seen: Array<{ event: any; rawId: string; rawType: string }> = [];
    const transitions: string[] = [];
    hub.onOutputInputState((state, previous) => transitions.push(`${previous}->${state}`));
    hub.onDouyinSourceEvent((event, meta) => seen.push({ event, rawId: meta.rawId, rawType: meta.rawType }));
    const socketReady = once(sockets, 'connection');
    hub.connect({ platform: 'douyin', roomId: '101', bridgeUrl: `http://127.0.0.1:${address.port}` });
    const [socket] = await socketReady;
    socket.send(JSON.stringify({ type: '__connected', roomId: '101', room: { roomId: '101', status: 'live' } }));
    await vi.waitFor(() => expect(hub.isConnected).toBe(true), { timeout: 2000, interval: 5 });
    const frame = (id: string, count: number) => ({ id, platform: 'douyin', roomId: '101', type: 'gift',
      rawMethod: 'WebcastGiftMessage', ts: 1000, user: { id: 'u', nickname: 'viewer' },
      data: { giftId: '2', giftName: 'flower', repeatCount: count, groupId: '3' } });
    socket.send(JSON.stringify(frame('raw-1', 2)));
    socket.send(JSON.stringify(frame('raw-2', 3)));
    await vi.waitFor(() => expect(seen).toHaveLength(2), { timeout: 2000, interval: 5 });
    expect(seen.map((item) => [item.rawId, item.rawType, item.event.count])).toEqual([
      ['raw-1', 'WebcastGiftMessage', 2], ['raw-2', 'WebcastGiftMessage', 1],
    ]);
    expect(readSourceIngress({ ...seen[0].event })).toBeNull();
    socket.send(JSON.stringify({ id: 'no-raw-method', platform: 'douyin', roomId: '101', type: 'chat', ts: 1000,
      user: { id: 'u', nickname: 'viewer' }, data: { content: 'fixture' } }));
    await vi.waitFor(() => expect(hub.recentEvents().some((event) => event.id === 'no-raw-method')).toBe(true),
      { timeout: 2000, interval: 5 });
    expect(seen).toHaveLength(2);
    hub.ingest({ id: 'fake', platform: 'douyin', kind: 'chat', ts: Date.now(), user: { id: 'u', name: 'viewer' }, text: 'hi' });
    expect(seen).toHaveLength(2);
    hub.disconnect();
    expect(transitions).toContain('connecting->connected');
    expect(transitions.at(-1)).toBe('connected->idle');
  });
});
