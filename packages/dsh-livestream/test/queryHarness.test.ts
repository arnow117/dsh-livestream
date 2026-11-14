import { createServer } from 'node:http';
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

it('runs native tool calls through the real Harness loop and model adapter against protocol fixtures', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-query-harness-'));
  const env = { ...process.env };
  const requests: any[] = [];
  const weatherRequests: string[] = [];
  let externalRequests = 0;
  let holdContinuation = false;
  let releaseContinuation: (() => void) | undefined;
  let holdSynthesis = false;
  let releaseSynthesis: (() => void) | undefined;
  let holdNewTurn = false;
  let releaseNewTurn: (() => void) | undefined;
  let holdProvider = false;
  let releaseProvider: (() => void) | undefined;
  let providerReturned = false;
  const model = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      const isToolContinuation = requests.at(-1)?.messages?.at(-1)?.role === 'tool';
      if (holdContinuation && isToolContinuation) await new Promise<void>((resolve) => { releaseContinuation = resolve; });
      if (holdNewTurn && !isToolContinuation) await new Promise<void>((resolve) => { releaseNewTurn = resolve; });
      const delta = !isToolContinuation
        ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'weather_lookup', arguments: JSON.stringify({ location: '北京' }) } }] }
        : { role: 'assistant', content: '暂时无法确认北京此刻天气。' };
      const finish = isToolContinuation ? 'stop' : 'tool_calls';
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const item of [
        { choices: [{ index: 0, delta, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
      ]) res.write(`data: ${JSON.stringify(item)}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
  const port = (model.address() as { port: number }).port;
  const originalFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === '127.0.0.1' && Number(url.port) === port) return originalFetch(input, init);
    if (url.hostname === 'nominatim.openstreetmap.org' && url.pathname === '/search') {
      return Response.json([{
        name: '北京市', category: 'boundary', type: 'administrative',
        address: { city: '北京市', country_code: 'cn' }, lat: '40', lon: '116.5',
        boundingbox: ['39', '41', '115', '118'],
        geojson: { type: 'Polygon', coordinates: [[[115, 39], [118, 39], [118, 41], [115, 41], [115, 39]]] },
      }]);
    }
    if (url.hostname === 'aviationweather.gov' && url.pathname === '/api/data/metar') {
      weatherRequests.push(url.href);
      if (holdProvider) {
        await new Promise<void>((resolve) => { releaseProvider = resolve; });
        providerReturned = true;
      }
      // Failure stays uncached so later cancellation cases each exercise the real source path.
      return new Response(null, { status: 503 });
    }
    externalRequests++;
    throw new Error('unexpected external request blocked');
  });
  process.env.DSH_HOME = dir;
  process.env.GLM_CODING_PLAN_API_KEY = 'fake-mcp-key';
  process.env.QUERY_FIXTURE_MODEL_KEY = 'fake-model-key';
  process.env.DSH_LIVESTREAM_LOCAL_REHEARSAL = '1';
  const ctx = new Context();
  let runtime: typeof import('../src/dsh/runtime') | undefined;
  try {
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(LlmPiAi, { providers: { fixture: { api: 'openai-completions', baseURL: `http://127.0.0.1:${port}`, apiKeyEnv: 'QUERY_FIXTURE_MODEL_KEY', cacheRetention: 'none', models: [{ id: 'model' }] } } });
    await ctx.plugin(SessionStore);
    await ctx.plugin(SessionProjectionRegistry);
    await ctx.plugin(SystemPrompt, { personaPrefix: '' });
    await ctx.plugin(ToolRuntime);
    await ctx.plugin({ inject: ['tools'], apply(owner: Context) { owner.tools.setExecutor(new NativeToolExecutor.NativeToolExecutor(owner, () => 1)); } });
    await ctx.plugin(AgentRegistry);
    await ctx.plugin(AgentLoop, { agents: [] });
    runtime = await import('../src/dsh/runtime');
    const plugin = await import('../src/dsh/agent');
    const host = await import('../src/dsh/index');
    const routes = new Map<string, (request: Request) => Promise<Response> | Response>();
    const credentialEvents = new Map<string, (reference?: string) => void>();
    host.apply({
      effect(effect: () => unknown, label?: string) {
        if (label === 'query cancel' || label === 'dsh-livestream credentials') effect();
      },
      on(name: string, callback: (reference?: string) => void) {
        credentialEvents.set(name, callback);
        return () => credentialEvents.delete(name);
      },
      provide() {},
      connection: { fetch: { register(route: { path: string; fetch: (request: Request) => Response }) { routes.set(route.path, route.fetch); return () => {}; } } },
    });
    const cancelRoute = routes.get('/api/dsh-livestream/query/cancel')!;
    const cancel = (sessionId: string, id: string) => cancelRoute(new Request('http://fixture/', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, queryId: id }),
    }));
    await ctx.plugin(plugin);
    runtime.updateSettings({ readOnlyQueries: { weather: true, publicSearch: false } });
    const agent = await ctx.agentLoop.create(SessionId('query-fixture'), { provider: 'fixture', model: 'model' });
    const snapshots = vi.spyOn(agent.session, 'snapshotEvents');
    runtime.show.goLive('query-fixture');
    clearInterval((runtime.show as any).director);
    (runtime.show as any).director = null;
    const synthesize = vi.fn(async (_text: string, signal: AbortSignal) => {
      if (holdSynthesis) await new Promise<void>((resolve) => { releaseSynthesis = resolve; });
      return { audio: new Uint8Array([1]), timeline: [] };
    });
    (runtime.show as any).hooks.synthesize = synthesize;
    const speeches: Promise<string>[] = [];
    const originalSay = runtime.show.say.bind(runtime.show);
    vi.spyOn(runtime.show, 'say').mockImplementation((...args) => {
      const speech = originalSay(...args);
      speeches.push(speech);
      return speech;
    });
    const events: any[] = [];
    const unsubscribe = runtime.show.stage.subscribe((event) => { events.push(event); if (event.type === 'say') runtime!.show.stage.said(event.id); }, true, 'owned-live-v1');
    await vi.waitFor(() => expect(snapshots).toHaveBeenCalled(), { timeout: 2000 });
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '北京天气如何' }] }));
    await vi.waitFor(() => expect(requests.length).toBe(2), { timeout: 5000 });
    expect(requests[0].tools.map((item: any) => item.function.name)).toContain('weather_lookup');
    expect(requests[1].messages.some((message: any) => message.role === 'tool' && message.content.includes('limited'))).toBe(true);
    expect(weatherRequests).toHaveLength(1);
    await vi.waitFor(() => expect(events.some((event) => event.type === 'say')).toBe(true), { timeout: 5000 });
    expect(events.find((event) => event.type === 'say')).toMatchObject({ text: '暂时无法确认北京此刻天气。', owner: { epoch: expect.any(String), turn: expect.any(String) } });
    expect(synthesize).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(agent.status).toBe('idle'));

    holdContinuation = true;
    const priorSay = events.filter((event) => event.type === 'say').length;
    const priorSynth = synthesize.mock.calls.length;
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '北京天气如何' }] }));
    await vi.waitFor(() => expect(releaseContinuation).toBeTypeOf('function'), { timeout: 5000 });
    agent.cancel({ kind: 'user' });
    releaseContinuation!();
    holdContinuation = false;
    await vi.waitFor(() => expect(agent.status).toBe('idle'));
    expect(events.filter((event) => event.type === 'say')).toHaveLength(priorSay);
    expect(synthesize).toHaveBeenCalledTimes(priorSynth);

    releaseContinuation = undefined;
    holdContinuation = true;
    const cancelNative = vi.spyOn(agent, 'cancel');
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '北京天气如何' }] }));
    await vi.waitFor(() => expect(releaseContinuation).toBeTypeOf('function'), { timeout: 5000 });
    const activeQuery = runtime.show.status().query?.queryId;
    expect((await cancel('query-fixture', activeQuery!)).status).toBe(200);
    expect(cancelNative).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true });
    releaseContinuation!();
    holdContinuation = false;
    await vi.waitFor(() => expect(agent.status).toBe('idle'));
    expect(events.filter((event) => event.type === 'say')).toHaveLength(priorSay);
    cancelNative.mockRestore();

    holdSynthesis = true;
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '北京天气如何' }] }));
    await vi.waitFor(() => expect(releaseSynthesis).toBeTypeOf('function'), { timeout: 5000 });
    expect(agent.status).toBe('idle');
    const ttsSignal = synthesize.mock.calls.at(-1)![1];
    agent.cancel({ kind: 'user' });
    // Native cancellation is a no-op after the Agent becomes idle.
    expect(ttsSignal.aborted).toBe(false);
    const queryId = runtime.show.status().query?.queryId;
    expect(queryId).toBeTruthy();
    expect((await cancel('wrong-session', queryId!)).status).toBe(409);
    expect((await cancel('query-fixture', 'wrong-query')).status).toBe(409);
    expect(ttsSignal.aborted).toBe(false);
    expect((await cancel('query-fixture', queryId!)).status).toBe(200);
    expect(ttsSignal.aborted).toBe(true);
    expect((await cancel('query-fixture', queryId!)).status).toBe(200);
    releaseSynthesis!();
    holdSynthesis = false;
    await speeches.at(-1);
    expect(events.filter((event) => event.type === 'say')).toHaveLength(priorSay);

    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '北京天气如何' }] }));
    await vi.waitFor(() => expect(events.filter((event) => event.type === 'say').length).toBe(priorSay + 1), { timeout: 5000 });
    const previousQuery = runtime.show.status().query?.queryId;
    expect(previousQuery).toBeTruthy();
    await vi.waitFor(() => expect(agent.status).toBe('idle'));
    let newerSignal: AbortSignal | undefined;
    const offStep = ctx.on('agent/pre-step', async ({ signal }, next) => { newerSignal = signal; return next(); });
    holdNewTurn = true;
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '下一轮' }] }));
    await vi.waitFor(() => expect(releaseNewTurn).toBeTypeOf('function'), { timeout: 5000 });
    expect((await cancel('query-fixture', previousQuery!)).status).toBe(200);
    expect(agent.status).toBe('running');
    expect(newerSignal?.aborted).toBe(false);
    releaseNewTurn!();
    holdNewTurn = false;
    await vi.waitFor(() => expect(agent.status).toBe('idle'));
    offStep();
    const previousEpoch = runtime.show.stage.outputEpoch;
    runtime.show.disconnect();
    expect(runtime.show.isOnAir).toBe(true);
    expect(runtime.show.stage.outputEpoch).not.toBe(previousEpoch);
    expect((await cancel('query-fixture', previousQuery!)).status).toBe(409);
    const callsBeforeDisconnectQuery = weatherRequests.length;
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '北京天气如何' }] }));
    await vi.waitFor(() => expect(weatherRequests.length).toBe(callsBeforeDisconnectQuery + 1), { timeout: 5000 });
    await vi.waitFor(() => expect(events.some((event) => event.type === 'say' && event.owner?.epoch === runtime!.show.stage.outputEpoch)).toBe(true), { timeout: 5000 });

    // Exercise the same actual Topic → Harness → Show path for both input sources.
    runtime.show.endLive();
    (runtime.show as any).finish();
    runtime.show.setPlatform('douyin');
    runtime.show.goLive('query-fixture');
    clearInterval((runtime.show as any).director);
    (runtime.show as any).director = null;
    const disconnectCancel = vi.spyOn(agent, 'cancel');
    const deliverTopic = async (actor: 'owner' | 'viewer', id: string) => {
      const common = { id, priority: 200, heat: 'quiet' as const, createdAt: Date.now() };
      const text = '北京天气如何';
      const topic = actor === 'owner'
        ? { ...common, kind: 'owner' as const, text }
        : {
          ...common,
          kind: 'chat' as const,
          picks: [{
            event: { id, platform: 'douyin' as const, kind: 'chat' as const, ts: Date.now(), user: { id: 'viewer-1', name: '观众' }, text },
            text,
            sources: [{ id, live: false }],
            tags: ['问题'],
            score: 1,
          }],
        };
      expect(await (runtime!.show as any).deliver(topic, Date.now())).toBe(true);
    };
    for (const actor of ['owner', 'viewer'] as const) {
      for (const phase of ['provider', 'continuation', 'tts'] as const) {
        await vi.waitFor(() => expect(agent.status).toBe('idle'), { timeout: 5000 });
        releaseProvider = undefined;
        releaseContinuation = undefined;
        releaseSynthesis = undefined;
        providerReturned = false;
        holdProvider = phase === 'provider';
        holdContinuation = phase === 'continuation';
        holdSynthesis = phase === 'tts';
        const sayBefore = events.filter((event) => event.type === 'say').length;
        const synthBefore = synthesize.mock.calls.length;
        await deliverTopic(actor, `${actor}-${phase}`);
        if (phase === 'provider') {
          await vi.waitFor(() => expect(releaseProvider, JSON.stringify({
            actor,
            phase,
            agentStatus: agent.status,
            query: runtime!.show.status().query,
            recentRequests: requests.slice(-2).map((request) => request.messages?.slice(-2)),
            recentWeatherRequests: weatherRequests.length,
          })).toBeTypeOf('function'), { timeout: 5000 });
        } else if (phase === 'continuation') {
          await vi.waitFor(() => expect(releaseContinuation).toBeTypeOf('function'), { timeout: 5000 });
        } else {
          await vi.waitFor(() => expect(releaseSynthesis).toBeTypeOf('function'), { timeout: 5000 });
        }
        const scheduledBeforeDisconnect = speeches.length;
        const oldEpoch = runtime.show.stage.outputEpoch;
        const oldLines = runtime.show.status().lines;
        runtime.show.disconnect();
        expect(runtime.show.stage.outputEpoch).not.toBe(oldEpoch);
        expect(runtime.show.isOnAir).toBe(true);
        expect(runtime.show.currentSession).toBe('query-fixture');
        expect(disconnectCancel).not.toHaveBeenCalled();
        holdProvider = false;
        holdContinuation = false;
        holdSynthesis = false;
        releaseProvider?.();
        releaseContinuation?.();
        releaseSynthesis?.();
        if (phase === 'provider') await vi.waitFor(() => expect(providerReturned).toBe(true));
        if (phase === 'tts') await speeches.at(-1);
        await vi.waitFor(() => expect(agent.status).toBe('idle'), { timeout: 5000 });
        // Wait for the actual Show watcher to inspect any native assistant event.
        const snapshotsBeforeWatch = snapshots.mock.calls.length;
        await vi.waitFor(() => expect(snapshots.mock.calls.length).toBeGreaterThan(snapshotsBeforeWatch), { timeout: 2000 });
        expect(events.filter((event) => event.type === 'say'), JSON.stringify({
          actor,
          phase,
          oldEpoch,
          currentEpoch: runtime.show.stage.outputEpoch,
          newEvents: events.filter((event) => event.type === 'say').slice(sayBefore),
          recentSessionEvents: agent.session.snapshotEvents(0).slice(-8).map((event: any) => ({ type: event.type, turn: event.data?.turn })),
        })).toHaveLength(sayBefore);
        expect(speeches).toHaveLength(scheduledBeforeDisconnect);
        expect(synthesize.mock.calls.length).toBe(synthBefore + (phase === 'tts' ? 1 : 0));
        expect(runtime.show.status().lines).toEqual(oldLines);
        expect(disconnectCancel).not.toHaveBeenCalled();
        await deliverTopic('owner', `new-owner-${actor}-${phase}`);
        await vi.waitFor(() => expect(events.filter((event) => event.type === 'say')).toHaveLength(sayBefore + 1), { timeout: 5000 });
        expect(events.filter((event) => event.type === 'say').at(-1)?.owner?.epoch).toBe(runtime.show.stage.outputEpoch);
      }
    }
    for (const trigger of ['settings', 'credentials'] as const) {
      await vi.waitFor(() => expect(agent.status).toBe('idle'), { timeout: 5000 });
      releaseProvider = undefined;
      providerReturned = false;
      holdProvider = true;
      const sayBefore = events.filter((event) => event.type === 'say').length;
      const synthBefore = synthesize.mock.calls.length;
      await deliverTopic('owner', `invalidate-${trigger}`);
      await vi.waitFor(() => expect(releaseProvider).toBeTypeOf('function'), { timeout: 5000 });
      const epoch = runtime.show.stage.outputEpoch;
      if (trigger === 'settings') {
        runtime.updateSettings({ readOnlyQueries: { weather: false } });
        runtime.updateSettings({ readOnlyQueries: { weather: true } });
      } else {
        expect(credentialEvents.has('credentials/reference-updated')).toBe(true);
        credentialEvents.get('credentials/reference-updated')!('GLM_CODING_PLAN_API_KEY');
      }
      expect(runtime.show.stage.outputEpoch).toBe(epoch);
      holdProvider = false;
      releaseProvider!();
      await vi.waitFor(() => expect(providerReturned).toBe(true));
      await vi.waitFor(() => expect(agent.status).toBe('idle'), { timeout: 5000 });
      const snapshotsBeforeWatch = snapshots.mock.calls.length;
      await vi.waitFor(() => expect(snapshots.mock.calls.length).toBeGreaterThan(snapshotsBeforeWatch), { timeout: 2000 });
      expect(events.filter((event) => event.type === 'say')).toHaveLength(sayBefore);
      expect(synthesize).toHaveBeenCalledTimes(synthBefore);
      expect(disconnectCancel).not.toHaveBeenCalled();
      await deliverTopic('owner', `new-owner-after-${trigger}`);
      await vi.waitFor(() => expect(events.filter((event) => event.type === 'say')).toHaveLength(sayBefore + 1), { timeout: 5000 });
    }
    disconnectCancel.mockRestore();
    expect(externalRequests).toBe(0);
    unsubscribe();
  } finally {
    releaseContinuation?.();
    releaseSynthesis?.();
    releaseNewTurn?.();
    releaseProvider?.();
    runtime?.show.dispose();
    await ctx.fiber.dispose();
    model.closeAllConnections();
    await new Promise<void>((resolve) => model.close(() => resolve()));
    vi.unstubAllGlobals();
    process.env = env;
    await rm(dir, { recursive: true, force: true });
  }
}, 45000);
