import { expect, it, vi } from 'vitest';
import { YovoiceClient } from '../../src/body/yovoiceTts';
import { AcceptanceTransport, YOVOICE_ORIGIN } from './transport';

it('cleans up only the submitted yovoice job after a request failure', async () => {
  const methods: string[] = [];
  const transport = new AcceptanceTransport(async (input, init) => {
    const id = new URL(String(input)).pathname.split('/').at(-1);
    const method = init?.method ?? 'GET';
    methods.push(method);
    if (method === 'GET') return new Response('', { status: 503 });
    return new Response(JSON.stringify({ requestId: id, status: method === 'DELETE' ? 'cancelled' : 'running' }));
  });
  vi.stubGlobal('fetch', transport.fetch);
  try {
    const client = new YovoiceClient(YOVOICE_ORIGIN, 'fixture');
    await expect(client.synthesize('测试', new AbortController().signal)).rejects.toThrow();
    expect(methods).toEqual(['PUT', 'GET', 'DELETE']);
    expect(transport.counts.synthesis).toBe(1);
    expect(transport.cleanupTerminal).toBe(true);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('cancels the owned job when the caller times out during polling', async () => {
  const methods: string[] = [];
  const caller = new AbortController();
  const transport = new AcceptanceTransport(async (input, init) => {
    const id = new URL(String(input)).pathname.split('/').at(-1);
    const method = init?.method ?? 'GET';
    methods.push(method);
    if (method === 'GET') {
      caller.abort();
      throw new Error('fixture timeout');
    }
    return new Response(JSON.stringify({ requestId: id, status: method === 'DELETE' ? 'cancelled' : 'running' }));
  });
  vi.stubGlobal('fetch', transport.fetch);
  try {
    const client = new YovoiceClient(YOVOICE_ORIGIN, 'fixture');
    await expect(client.synthesize('测试', caller.signal)).rejects.toBeDefined();
    expect(methods).toEqual(['PUT', 'GET', 'DELETE']);
    expect(transport.cleanupTerminal).toBe(true);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('allows owned cancellation when the caller aborts after submission', async () => {
  const methods: string[] = [];
  const caller = new AbortController();
  const transport = new AcceptanceTransport(async (input, init) => {
    const id = new URL(String(input)).pathname.split('/').at(-1);
    const method = init?.method ?? 'GET';
    methods.push(method);
    if (method === 'PUT') caller.abort();
    return new Response(JSON.stringify({ requestId: id, status: method === 'DELETE' ? 'cancelled' : 'running' }));
  });
  vi.stubGlobal('fetch', transport.fetch);
  try {
    const client = new YovoiceClient(YOVOICE_ORIGIN, 'fixture');
    await expect(client.synthesize('测试', caller.signal)).rejects.toBeDefined();
    expect(methods).toEqual(['PUT', 'DELETE']);
    expect(transport.cleanupTerminal).toBe(true);
  } finally {
    vi.unstubAllGlobals();
  }
});
