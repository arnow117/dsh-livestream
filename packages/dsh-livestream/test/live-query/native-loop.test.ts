import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm';
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import { AcceptanceTransport, MCP_URL, MODEL_URL } from './transport';

it('rehearses both isolated native Harness turns and plugin tools through the bounded transport', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-live-query-'));
  const previous = { ...process.env };
  const ctx = new Context();
  const calls: string[] = [];
  const attempted: string[] = [];
  const properties = Object.fromEntries(['search_query', 'search_domain_filter', 'search_recency_filter', 'content_size', 'location'].map((name) => [name, { type: 'string' }]));
  let scenario = 0;
  let modelRound = 0;
  const transport = new AcceptanceTransport(async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url === MODEL_URL) {
      modelRound++;
      calls.push(`model-${scenario}-${modelRound}`);
      const tool = scenario === 0 ? { name: 'weather_lookup', input: { location: '北京' } } : { name: 'public_search', input: { query: 'OBS Studio 许可证' } };
      const frames: unknown[] = [
        { type: 'message_start', message: { id: `msg_${scenario}_${modelRound}`, type: 'message', role: 'assistant', model: 'glm-5.3-flash', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } },
        ...(modelRound === 1 ? [
          { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `call_${scenario}`, name: tool.name, input: {} } },
          { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } },
        ] : [
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'fixture answer' } },
        ]),
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: modelRound === 1 ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
        { type: 'message_stop' },
      ];
      return new Response(frames.map((frame: any) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    }
    const target = new URL(url);
    if (target.hostname === 'nominatim.openstreetmap.org') {
      return Response.json([{
        name: '北京市', category: 'boundary', type: 'administrative',
        address: { city: '北京市', country_code: 'cn' }, lat: '40', lon: '116.5',
        boundingbox: ['39', '41', '115', '118'],
        geojson: { type: 'Polygon', coordinates: [[[115, 39], [118, 39], [118, 41], [115, 41], [115, 39]]] },
      }]);
    }
    if (target.hostname === 'aviationweather.gov') return Response.json([]);
    expect(url).toBe(MCP_URL);
    if ((init?.method ?? 'GET') === 'GET') return new Response(null, { status: 202 });
    calls.push(body.method);
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
  });
  process.env.DSH_HOME = dir;
  process.env.DSH_LIVESTREAM_LOCAL_REHEARSAL = '1';
  process.env.GLM_CODING_PLAN_API_KEY = 'fixture';
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    attempted.push(`${init?.method ?? 'GET'} ${String(input)}`);
    return transport.fetch(input, init);
  });
  let runtime: typeof import('../../src/dsh/runtime') | undefined;
  try {
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(LlmPiAi, { providers: { 'glm-coding-plan': { api: 'anthropic-messages', baseURL: 'https://open.bigmodel.cn/api/anthropic', apiKeyEnv: 'GLM_CODING_PLAN_API_KEY', cacheRetention: 'none', models: [{ id: 'glm-5.3-flash' }] } } });
    await ctx.plugin(SessionStore);
    await ctx.plugin(SessionProjectionRegistry);
    await ctx.plugin(SystemPrompt, { personaPrefix: '' });
    await ctx.plugin(ToolRuntime);
    await ctx.plugin({ inject: ['tools'], apply(owner: Context) { owner.tools.setExecutor(new NativeToolExecutor.NativeToolExecutor(owner, () => 1)); } });
    await ctx.plugin(AgentRegistry);
    await ctx.plugin(AgentLoop, { agents: [] });
    runtime = await import('../../src/dsh/runtime');
    const plugin = await import('../../src/dsh/agent');
    await ctx.plugin(plugin);
    runtime.updateSettings({ readOnlyQueries: { weather: true, publicSearch: true } });
    (runtime.show as any).hooks.synthesize = async () => ({ audio: new Uint8Array([1]), timeline: [] });
    for (scenario = 0; scenario < 2; scenario++) {
      if (scenario > 0) {
        runtime.show.endLive();
        (runtime.show as any).finish();
      }
      transport.nextScenario();
      modelRound = 0;
      const id = `bounded-query-${scenario}`;
      const agent = await ctx.agentLoop.create(SessionId(id), { provider: 'glm-coding-plan', model: 'glm-5.3-flash', maxTokens: 1024 });
      runtime.show.goLive(id);
      clearInterval((runtime.show as any).director);
      (runtime.show as any).director = null;
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: scenario === 0 ? '北京当前天气' : 'OBS Studio 许可证' }] }));
      await agent.whenIdle();
      expect(modelRound, JSON.stringify({ attempted, events: agent.session.snapshotEvents(0).map((event: any) => event.type) })).toBe(2);
      expect(runtime.show.status().query?.status, JSON.stringify({ calls, events: agent.session.snapshotEvents(0).filter((event: any) => event.type === 'tool/result') })).toBe(scenario === 0 ? 'limited' : 'evidence');
    }
    expect(transport.counts).toEqual({ model: 4, mcp: 1, geocode: 1, current: 1, forecast: 0, synthesis: 0 });
    expect(calls.filter((item) => item === 'tools/call')).toHaveLength(1);
  } finally {
    runtime?.show.dispose();
    await ctx.fiber.dispose();
    vi.unstubAllGlobals();
    process.env = previous;
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);
