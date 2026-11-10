import { describe, expect, it, vi } from 'vitest';
import { Stage } from '../src/body/stage';

describe('owned stage output', () => {
  it('sends owned live events only to explicitly capable subscribers and never replays speech', () => {
    const stage = new Stage();
    const old: any[] = [];
    const current: any[] = [];
    const preview: any[] = [];
    stage.subscribe((event) => old.push(event), true);
    stage.subscribe((event) => current.push(event), true, 'owned-live-v1');
    stage.subscribe((event) => preview.push(event), false, 'owned-live-v1');
    stage.broadcast({ type: 'say', id: 'old', text: 'game', mood: '', audio: null, estimateMs: 1 });
    stage.broadcast({ type: 'say', id: 'owned', text: 'answer', mood: '', audio: null, estimateMs: 1, owner: { epoch: 'e1', turn: 't1' } });
    stage.broadcast({ type: 'invalidate', owner: { epoch: 'e1', turn: 't1' } });
    expect(old.map((event) => event.type)).toEqual(['say']);
    expect(current.map((event) => event.type)).toEqual(['say', 'say', 'invalidate']);
    expect(preview.map((event) => event.type)).toEqual(['say', 'say', 'invalidate']);
    expect(stage.outputCapabilities()).toEqual({ capableSpeakers: 1, legacySpeakers: 1, capablePreviews: 1, legacyPreviews: 0 });
    const reconnected: any[] = [];
    stage.subscribe((event) => reconnected.push(event), true, 'owned-live-v1');
    expect(reconnected).toEqual([]);
  });
});

it('filters capabilities at the real SSE handler, including preview and unknown clients', async () => {
  const { StageServer } = await import('../src/body/server');
  const { get } = await import('node:http');
  const stage = new Stage();
  stage.outputEpoch = 'epoch';
  const packs = { character: () => ({ id: 'c' }), template: () => ({ id: 't' }) } as any;
  const server = new StageServer({ port: 0, token: 'fixture', packageDir: '.', packs, stage, current: () => ({ character: 'c', template: 't' }) });
  await server.start();
  const port = (server as any).server.address().port;
  const clients: Array<{ request: ReturnType<typeof get>; events: any[] }> = [];
  async function connect(query: string) {
    const events: any[] = [];
    const request = get(`http://127.0.0.1:${port}/events?token=fixture${query}`);
    clients.push({ request, events });
    await new Promise<void>((resolve, reject) => {
      request.on('error', reject);
      request.on('response', (response) => {
        let text = '';
        response.on('data', (chunk) => {
          text += String(chunk);
          const blocks = text.split('\n\n');
          text = blocks.pop() ?? '';
          for (const block of blocks) {
            if (block.startsWith('data: ')) events.push(JSON.parse(block.slice(6)));
          }
          if (events.some((event) => event.type === 'hello')) resolve();
        });
      });
    });
    return events;
  }
  try {
    const legacy = await connect('');
    const unknown = await connect('&outputProtocol=unknown');
    const capable = await connect('&outputProtocol=owned-live-v1');
    const preview = await connect('&outputProtocol=owned-live-v1&preview=1');
    stage.broadcast({ type: 'say', id: 'owned', text: 'answer', mood: '', audio: null, estimateMs: 1, owner: { epoch: 'epoch', turn: 't' } });
    stage.broadcast({ type: 'say', id: 'guest', text: 'legacy', mood: '', audio: null, estimateMs: 1 });
    await vi.waitFor(() => expect(capable.filter((event) => event.type === 'say')).toHaveLength(2));
    expect(legacy.filter((event) => event.type === 'say').map((event) => event.id)).toEqual(['guest']);
    expect(unknown.filter((event) => event.type === 'say').map((event) => event.id)).toEqual(['guest']);
    expect(preview.filter((event) => event.type === 'say').map((event) => event.id)).toEqual(['owned', 'guest']);
    expect(capable[0].outputEpoch).toBe('epoch');
    expect(stage.outputCapabilities()).toEqual({ capableSpeakers: 1, legacySpeakers: 2, capablePreviews: 1, legacyPreviews: 0 });
  } finally {
    for (const client of clients) client.request.destroy();
    server.stop();
  }
});
