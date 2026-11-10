import { MCP_URL, MODEL_URL } from './transport';
import { observeComposition } from './preset-evidence';

/** Synthetic protocol responses; never contacts a server. */
export type FixtureMode = 'normal' | 'rejected_parameter' | 'secret_parameter' | 'model_http_error' | 'mcp_http_error' | 'invalid_type';

export function createFixture(mode: FixtureMode = 'normal') {
  let scenario = 0;
  let round = 0;
  const wire: Array<(ReturnType<typeof observeComposition> & { fixedQuestionPresent: boolean; unforcedToolChoice: boolean }) | undefined> = [];
  const properties = Object.fromEntries(['search_query', 'search_domain_filter', 'search_recency_filter', 'content_size', 'location'].map((name) => [name, { type: 'string' }]));
  return {
    beginScenario(index: number) { scenario = index; round = 0; },
    observation(index: number) { return wire[index]; },
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (url === MODEL_URL) {
        round++;
        if (round === 1) {
          const system = typeof body.system === 'string' ? body.system : JSON.stringify(body.system ?? '');
          const expectedQuestion = scenario === 0 ? '北京当前天气' : 'OBS Studio许可证';
          const fixedQuestionPresent = (body.messages ?? []).some((message: any) =>
            message.role === 'user' && (message.content === expectedQuestion
              || (Array.isArray(message.content)
                && message.content.some((item: any) => item.type === 'text' && item.text === expectedQuestion))),
          );
          const unforcedToolChoice = body.tool_choice === undefined || body.tool_choice?.type === 'auto';
          wire[scenario] = { ...observeComposition(system, body.tools ?? []), fixedQuestionPresent, unforcedToolChoice };
        }
        if (scenario === 1 && mode === 'model_http_error') return new Response(null, { status: 503 });
        let publicQuery = 'OBS Studio许可证';
        if (mode === 'rejected_parameter') publicQuery = 'OBS Studio 许可证';
        if (mode === 'secret_parameter') publicQuery = 'diagnostic-secret-sentinel';
        const publicInput = mode === 'invalid_type'
          ? { query: 17, unexpected: 'diagnostic-secret-sentinel' }
          : { query: publicQuery };
        const tool = scenario === 0
          ? { name: 'weather_lookup', input: { location: '北京' } }
          : { name: 'public_search', input: publicInput };
        const frames: any[] = [
          { type: 'message_start', message: { id: `msg_${scenario}_${round}`, type: 'message', role: 'assistant', model: 'glm-5.3-flash', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } },
          ...(round === 1 ? [
            { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `call_${scenario}`, name: tool.name, input: {} } },
            { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } },
          ] : [
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '这是离线替身回答。' } },
          ]),
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: round === 1 ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
          { type: 'message_stop' },
        ];
        return new Response(frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
      }
      const target = new URL(url);
      if (target.hostname === 'nominatim.openstreetmap.org' && target.pathname === '/search') {
        return Response.json([{
          name: '北京市', category: 'boundary', type: 'administrative',
          address: { city: '北京市', country_code: 'cn' }, lat: '40', lon: '116.5',
          boundingbox: ['39', '41', '115', '118'],
          geojson: { type: 'Polygon', coordinates: [[[115, 39], [118, 39], [118, 41], [115, 41], [115, 39]]] },
        }]);
      }
      if (target.hostname === 'aviationweather.gov' && target.pathname === '/api/data/metar') return Response.json([]);
      if (url !== MCP_URL) throw new Error('fixture destination rejected');
      if (scenario === 1 && mode === 'mcp_http_error') return new Response(null, { status: 503 });
      if ((init?.method ?? 'GET') === 'GET') return new Response(null, { status: 202 });
      if (body.id === undefined) return new Response(null, { status: 202 });
      const rows = scenario === 0
        ? [{ title: '北京天气', link: 'https://weather.com.cn/beijing', content: '北京天气资料' }]
        : [{ title: 'OBS Studio', link: 'https://github.com/obsproject/obs-studio', content: 'OBS Studio GPL license' }];
      const result = body.method === 'initialize'
        ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
        : body.method === 'tools/list'
          ? { tools: [{ name: 'web_search_prime', inputSchema: { type: 'object', properties, required: ['search_query'], additionalProperties: false } }] }
          : { content: [{ type: 'text', text: JSON.stringify(rows) }] };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { headers: { 'content-type': 'application/json' } });
    },
  };
}
