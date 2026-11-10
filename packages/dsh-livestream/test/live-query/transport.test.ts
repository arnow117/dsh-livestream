import { describe, expect, it } from 'vitest';
import { AcceptanceTransport, MCP_URL, MODEL_URL, YOVOICE_ORIGIN } from './transport';

const success: typeof fetch = async () => new Response('{}');
const model = (continuation = false) => ({ method: 'POST', body: JSON.stringify({ model: 'glm-5.3-flash', max_tokens: 1024, messages: continuation ? [{ role: 'user', content: [{ type: 'tool_result', content: JSON.stringify({ kind: 'public_search', status: 'limited' }) }] }] : [] }) });
const search = () => ({ method: 'POST', body: JSON.stringify({ method: 'tools/call', params: { name: 'web_search_prime' } }) });
const job = (text = '你好') => ({ method: 'PUT', body: JSON.stringify({ text }) });

describe('acceptance transport', () => {
  it('counts actual sends and stops before a third model request in one scenario', async () => {
    let sends = 0;
    const transport = new AcceptanceTransport(async () => { sends++; return new Response('{}'); });
    await transport.fetch(MODEL_URL, model());
    await transport.fetch(MCP_URL, search());
    await transport.fetch(MODEL_URL, model(true));
    await expect(transport.fetch(MODEL_URL, model())).rejects.toThrow();
    await expect(transport.fetch(MCP_URL, search())).rejects.toThrow();
    expect(sends).toBe(3);
    expect(transport.counts).toEqual({ model: 2, mcp: 1, geocode: 0, current: 0, forecast: 0, synthesis: 0 });
  });

  it('allows at most two model requests and one search for each of two scenarios', async () => {
    const transport = new AcceptanceTransport(success);
    for (let i = 0; i < 2; i++) {
      transport.nextScenario();
      await transport.fetch(MODEL_URL, model());
      await transport.fetch(MCP_URL, search());
      await transport.fetch(MODEL_URL, model(true));
    }
    transport.nextScenario();
    await expect(transport.fetch(MCP_URL, search())).rejects.toThrow();
    expect(transport.counts).toEqual({ model: 4, mcp: 2, geocode: 0, current: 0, forecast: 0, synthesis: 0 });
  });

  it.each(['http://127.0.0.1:3080/', 'http://127.0.0.1:7390/', 'http://127.0.0.1:8757/', 'https://example.com/'])('rejects %s before sending', async (url) => {
    let sends = 0;
    const transport = new AcceptanceTransport(async () => { sends++; return new Response('{}'); });
    await expect(transport.fetch(url)).rejects.toThrow();
    expect(sends).toBe(0);
    expect(transport.controller.signal.aborted).toBe(true);
  });

  it('permits the MCP event stream without counting a search', async () => {
    const transport = new AcceptanceTransport(success);
    await transport.fetch(MCP_URL, { method: 'GET' });
    expect(transport.counts.mcp).toBe(0);
  });

  it('treats only MCP GET 405 as an optional stream response', async () => {
    const optionalStream = new AcceptanceTransport(async () => new Response(null, { status: 405 }));
    expect((await optionalStream.fetch(MCP_URL, { method: 'GET' })).status).toBe(405);
    expect(optionalStream.controller.signal.aborted).toBe(false);

    const failedPost = new AcceptanceTransport(async () => new Response(null, { status: 405 }));
    await expect(failedPost.fetch(MCP_URL, search())).rejects.toThrow();
    expect(failedPost.controller.signal.aborted).toBe(true);

    const failedGet = new AcceptanceTransport(async () => new Response(null, { status: 503 }));
    await expect(failedGet.fetch(MCP_URL, { method: 'GET' })).rejects.toThrow();
    expect(failedGet.controller.signal.aborted).toBe(true);
  });

  it('limits yovoice reads to the created job and the returned audio path', async () => {
    const id = 'a'.repeat(32);
    const transport = new AcceptanceTransport(async () => new Response(JSON.stringify({ requestId: id, status: 'completed', downloadPath: '/v1/audio/owned' })));
    await transport.fetch(`${YOVOICE_ORIGIN}/v1/jobs/${id}`, job());
    await transport.fetch(`${YOVOICE_ORIGIN}/v1/audio/owned`);
    await expect(transport.fetch(`${YOVOICE_ORIGIN}/v1/jobs/${'b'.repeat(32)}`)).rejects.toThrow();
  });

  it('rejects excessive token limits and speech, and stops on failure', async () => {
    const badModel = new AcceptanceTransport(success);
    await expect(badModel.fetch(MODEL_URL, { method: 'POST', body: JSON.stringify({ model: 'glm-5.3-flash', max_tokens: 1025 }) })).rejects.toThrow();
    const badSpeech = new AcceptanceTransport(success);
    await expect(badSpeech.fetch(`${YOVOICE_ORIGIN}/v1/jobs/${'a'.repeat(32)}`, job('字'.repeat(121)))).rejects.toThrow();
    const failed = new AcceptanceTransport(async () => new Response('', { status: 503 }));
    await expect(failed.fetch(MODEL_URL, model())).rejects.toThrow();
    await expect(failed.fetch(MODEL_URL, model())).rejects.toThrow();
    expect(failed.counts.model).toBe(1);
  });

  it('does not send a model continuation after a failed or invalid tool result', async () => {
    for (const result of [{ status: 'failed' }, { status: 'unsupported_response' }, { unexpected: true }]) {
      let sends = 0;
      const transport = new AcceptanceTransport(async () => { sends++; return new Response('{}'); });
      await transport.fetch(MODEL_URL, model());
      await transport.fetch(MCP_URL, search());
      const continuation = { method: 'POST', body: JSON.stringify({ model: 'glm-5.3-flash', max_tokens: 1024, messages: [{ role: 'user', content: [{ type: 'tool_result', content: JSON.stringify(result) }] }] }) };
      await expect(transport.fetch(MODEL_URL, continuation)).rejects.toThrow();
      await expect(transport.fetch(MCP_URL, search())).rejects.toThrow();
      expect(sends).toBe(2);
    }
  });

  it('permits only one bounded synthesis job', async () => {
    const transport = new AcceptanceTransport(async () => new Response(JSON.stringify({ requestId: 'a'.repeat(32), status: 'running' })));
    await transport.fetch(`${YOVOICE_ORIGIN}/v1/jobs/${'a'.repeat(32)}`, job());
    await expect(transport.fetch(`${YOVOICE_ORIGIN}/v1/jobs/${'b'.repeat(32)}`, job())).rejects.toThrow();
    expect(transport.counts.synthesis).toBe(1);
  });
});

it('aborts work at the soft deadline and refuses further requests', async () => {
  const transport = new AcceptanceTransport(async (_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }), 30_020);
  try {
    await expect(transport.fetch(MODEL_URL, model())).rejects.toThrow();
    expect(transport.controller.signal.aborted).toBe(true);
    expect(transport.failure).toEqual({ code: 'request_cancelled', phase: 'model' });
    await expect(transport.fetch(MCP_URL, search())).rejects.toThrow();
  } finally {
    transport.close();
  }
});

it('permits only bounded public weather GETs and never forwards credentials', async () => {
  const transport = new AcceptanceTransport(success);
  const geo = new URL('https://nominatim.openstreetmap.org/search');
  for (const [name, value] of Object.entries({ format: 'jsonv2', q: '北京', countrycodes: 'cn', addressdetails: '1', limit: '3', 'accept-language': 'zh-CN', polygon_geojson: '1' })) geo.searchParams.set(name, value);
  const current = 'https://aviationweather.gov/api/data/metar?bbox=39.000%2C115.000%2C41.000%2C118.000&format=json&hours=2';
  const forecast = 'https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=40.0000&lon=116.5000';
  await transport.fetch(geo.href, { method: 'GET' });
  await transport.fetch(current, { method: 'GET' });
  await transport.fetch(forecast, { method: 'GET' });
  expect(transport.counts).toEqual({ model: 0, mcp: 0, geocode: 1, current: 1, forecast: 1, synthesis: 0 });
  await expect(transport.fetch(current, { method: 'GET' })).rejects.toThrow();

  const credentialed = new AcceptanceTransport(success);
  await expect(credentialed.fetch(current, { method: 'GET', headers: { Authorization: 'fixture-secret' } })).rejects.toThrow();
  expect(credentialed.counts.current).toBe(0);
});

it('permits a bounded weather tool continuation even when the weather result came from cache', async () => {
  const transport = new AcceptanceTransport(success);
  await transport.fetch(MODEL_URL, model());
  const continuation = { method: 'POST', body: JSON.stringify({ model: 'glm-5.3-flash', max_tokens: 1024, messages: [{ role: 'user', content: [{ type: 'tool_result', content: JSON.stringify({ kind: 'weather', status: 'evidence' }) }] }] }) };
  await transport.fetch(MODEL_URL, continuation);
  expect(transport.counts).toEqual({ model: 2, mcp: 0, geocode: 0, current: 0, forecast: 0, synthesis: 0 });
});

it('rejects voice traffic before sending when the synthesis budget is zero', async () => {
  let sends = 0;
  const transport = new AcceptanceTransport(async () => { sends++; return new Response('{}'); }, 300_000, undefined, 0);
  try {
    await expect(transport.fetch(`${YOVOICE_ORIGIN}/v1/jobs/${'a'.repeat(32)}`, job())).rejects.toThrow();
    expect(sends).toBe(0);
    expect(transport.counts.synthesis).toBe(0);
  } finally {
    transport.close();
  }
});
