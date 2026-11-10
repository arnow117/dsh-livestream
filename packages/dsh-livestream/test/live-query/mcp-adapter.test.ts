import { expect, it } from 'vitest';
import { runReadOnlyQuery } from '../../src/body/readOnlyQuery';
import { AcceptanceTransport, MCP_URL } from './transport';

it('runs the production MCP adapter under the bounded transport with an isolated protocol fixture', async () => {
  const methods: string[] = [];
  const properties = Object.fromEntries(['search_query', 'search_domain_filter', 'search_recency_filter', 'content_size', 'location'].map((name) => [name, { type: 'string' }]));
  const transport = new AcceptanceTransport(async (input, init) => {
    expect(String(input)).toBe(MCP_URL);
    const httpMethod = init?.method ?? 'GET';
    if (httpMethod === 'GET') {
      methods.push('GET');
      return new Response(null, { status: 405 });
    }
    const body = JSON.parse(String(init?.body));
    methods.push(body.method);
    if (body.id === undefined) return new Response(null, { status: 202 });
    const result = body.method === 'initialize'
      ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
      : body.method === 'tools/list'
        ? { tools: [{ name: 'web_search_prime', inputSchema: { type: 'object', properties, required: ['search_query'], additionalProperties: false } }] }
        : { content: [{ type: 'text', text: JSON.stringify([{ title: 'OBS Studio', link: 'https://github.com/obsproject/obs-studio', content: 'OBS Studio license' }]) }] };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { headers: { 'content-type': 'application/json', ...(body.method === 'initialize' ? { 'mcp-session-id': 'fixture-session' } : {}) } });
  });
  const result = await runReadOnlyQuery({ kind: 'public_search', query: 'OBS Studio license' }, 'fixture', new AbortController().signal, transport.fetch);
  expect(result.status).toBe('evidence');
  expect(methods).toContain('GET');
  expect(methods.filter((method) => method === 'tools/call')).toHaveLength(1);
  expect(transport.counts).toEqual({ model: 0, mcp: 1, geocode: 0, current: 0, forecast: 0, synthesis: 0 });
});
