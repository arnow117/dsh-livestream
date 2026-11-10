import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import Group from '@deepseek-ai/cordis-plugin-group';
import { parse } from 'yaml';
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm';
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native';
import AgentRegistry, { assembleContextFor, type AgentHandle } from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry';
import AgentPreset from '@deepseek-ai/dsh-agent-preset';
import * as Persona from '@deepseek-ai/dsh-persona';
import { YovoiceClient } from '../../src/body/yovoiceTts';
import { createWeatherSource } from '../../src/body/weather';
import { AcceptanceTransport, YOVOICE_ORIGIN } from './transport';
import { createFixture, type FixtureMode } from './fixture';
import { observeComposition, PRESET_ID, validComposition } from './preset-evidence';
import { sanitizeSourceUrl } from './source-url';

interface AcceptanceOptions {
  mode: 'offline' | 'real';
  dshHome: string;
  audioDir: string;
  modelKey: string;
  ttsToken?: string;
  ttsBudget?: 0 | 1;
  deadlineMs?: number;
  signal?: AbortSignal;
  fixtureMode?: FixtureMode;
  weatherCacheFile?: string;
  geocoderUrl?: string;
}

export async function runAcceptance(options: AcceptanceOptions) {
  if (options.mode === 'real' && options.fixtureMode) throw new Error('fixture mode is offline only');
  const fixture = createFixture(options.mode === 'offline' ? options.fixtureMode : undefined);
  const originalFetch = globalThis.fetch;
  const ttsBudget = options.mode === 'real' ? options.ttsBudget ?? 1 : 0;
  const transport = new AcceptanceTransport(
    options.mode === 'offline' ? fixture.fetch : originalFetch,
    options.deadlineMs,
    options.geocoderUrl,
    ttsBudget,
  );
  const ctx = new Context();
  type ScenarioEvidence = {
    question: string;
    presetId: string;
    toolSchemas: string[];
    schemaChecks: ReturnType<typeof observeComposition>['schemaChecks'];
    personaChecks: ReturnType<typeof observeComposition>['personaChecks'];
    fixtureWire?: ReturnType<ReturnType<typeof createFixture>['observation']>;
    tool: string;
    expectedTool: string;
    actualTool: string | null;
    toolArguments: Record<string, string> | null;
    toolArgumentTypes: Record<string, string> | null;
    unexpectedArgumentFields: number;
    toolCallCount: number;
    status: string;
    queryStatus: string;
    turnEndKind: string;
    failureCode: string | null;
    failurePhase?: string;
    httpStatus?: number;
    sources: Array<{ url: string | null; independentlyVerifiable: boolean; retrievedAt: string; providerTime: unknown }>;
    limitation: string;
    answer: string;
    modelRequests: number;
    searches: number;
    geocodeRequests: number;
    currentRequests: number;
    forecastRequests: number;
    synthesisJobs: number;
  };
  const scenarios: ScenarioEvidence[] = [];
  const cleanText = (value: unknown, limit: number): string => {
    let text = typeof value === 'string' ? value : '';
    for (const secret of [options.modelKey, options.ttsToken]) {
      if (secret) text = text.split(secret).join('[redacted]');
    }
    return [...text.replace(/[\u0000-\u001f\u007f]/g, ' ')].slice(0, limit).join('');
  };
  let runtime: typeof import('../../src/dsh/runtime') | undefined;
  let activeAgent: any;
  let activeHandle: AgentHandle | undefined;
  let scopesDisposed = 0;
  let answer = '';
  let audio = 'not_requested';
  let failure: string | undefined;
  let phase = 'setup';
  const abort = () => activeAgent?.cancel({ kind: 'user' });
  const stop = () => transport.stop();
  options.signal?.addEventListener('abort', stop, { once: true });
  if (options.signal?.aborted) stop();
  transport.controller.signal.addEventListener('abort', abort);
  globalThis.fetch = transport.fetch;
  process.env.DSH_HOME = options.dshHome;
  process.env.DSH_LIVESTREAM_LOCAL_REHEARSAL = '1';
  process.env.GLM_CODING_PLAN_API_KEY = options.modelKey;
  try {
    await ctx.plugin(Loader);
    ctx.loader.builtins.group = Group;
    ctx.loader.builtins.persona = Persona;
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(LlmPiAi, { providers: { 'glm-coding-plan': { api: 'anthropic-messages', baseURL: 'https://open.bigmodel.cn/api/anthropic', apiKeyEnv: 'GLM_CODING_PLAN_API_KEY', retryPolicy: { mode: 'normal', maxRetries: 0 }, cacheRetention: 'none', models: [{ id: 'glm-5.3-flash' }] } } });
    await ctx.plugin(SessionStore);
    await ctx.plugin(SessionProjectionRegistry);
    await ctx.plugin(SystemPrompt, { personaPrefix: '' });
    await ctx.plugin(ToolRuntime);
    await ctx.plugin({ inject: ['tools'], apply(owner: Context) { owner.tools.setExecutor(new NativeToolExecutor.NativeToolExecutor(owner, () => 1)); } });
    await ctx.plugin(AgentRegistry);
    await ctx.plugin(AgentLoop, { agents: [] });
    await ctx.plugin(AgentPresets, { default: PRESET_ID });
    runtime = await import('../../src/dsh/runtime');
    const plugin = await import('../../src/dsh/agent');
    const weather = createWeatherSource({
      cacheFile: options.weatherCacheFile ?? join(options.dshHome, 'dsh-livestream', 'weather-cache-v1.json'),
      geocoderUrl: options.geocoderUrl,
      fetchImpl: transport.fetch,
    });
    ctx.loader.builtins.livestreamAgent = plugin.createAgentPlugin(weather);
    const patch = parse(await readFile('cordis.patch.yml', 'utf8')) as Array<{ insert?: any[] }>;
    const definition = patch.flatMap((item) => item.insert ?? []).find((item) => item.config?.id === PRESET_ID);
    if (!definition) throw new Error('preset missing');
    const config = structuredClone(definition.config);
    const moduleNames = config.plugins.map((row: any) => row.name);
    const allowedNames = ['@deepseek-ai/dsh-persona', 'dsh-livestream/agent'];
    if (moduleNames.length !== allowedNames.length || !allowedNames.every((name) => moduleNames.filter((item: string) => item === name).length === 1)) {
      throw new Error('unexpected preset modules');
    }
    for (const row of config.plugins) {
      if (row.name === '@deepseek-ai/dsh-persona') row.name = 'cordis:persona';
      if (row.name === 'dsh-livestream/agent') row.name = 'cordis:livestreamAgent';
    }
    await ctx.plugin(AgentPreset, config);
    runtime.updateSettings({ livePlatform: 'douyin', readOnlyQueries: { weather: true, publicSearch: true } });
    runtime.show.setPlatform('douyin');
    // Show is an in-memory sink. The watcher must never synthesize or play audio.
    runtime.show.say = async () => '';
    const questions = ['北京当前天气', 'OBS Studio许可证'];
    for (let index = 0; index < questions.length; index++) {
      phase = `scenario_${index + 1}`;
      transport.nextScenario();
      fixture.beginScenario(index);
      const before = { ...transport.counts };
      const expectedTool = index === 0 ? 'weather_lookup' : 'public_search';
      const record: ScenarioEvidence = {
        question: questions[index],
        presetId: 'not_mounted',
        toolSchemas: [],
        schemaChecks: { publicQueryOriginal: false, publicQueryLimit: false, weatherLocation: false },
        personaChecks: { originalQuery: false, sourceTime: false, limited: false, noLongUrl: false },
        tool: expectedTool,
        expectedTool,
        actualTool: null,
        toolArguments: null,
        toolArgumentTypes: null,
        unexpectedArgumentFields: 0,
        toolCallCount: 0,
        status: 'not_started',
        queryStatus: 'not_started',
        turnEndKind: 'unknown',
        failureCode: null,
        sources: [],
        limitation: '',
        answer: '',
        modelRequests: 0,
        searches: 0,
        geocodeRequests: 0,
        currentRequests: 0,
        forecastRequests: 0,
        synthesisJobs: 0,
      };
      scenarios.push(record);
      activeAgent = undefined;
      try {
        const id = `acceptance-${index}`;
        activeHandle = await ctx.agents.create({
          sessionId: SessionId(id),
          agentOptions: { provider: 'glm-coding-plan', model: 'glm-5.3-flash', maxTokens: 1024 },
          setup: async (scope) => { await ctx.agentPresets.mount(scope, PRESET_ID); },
        });
        activeAgent = activeHandle.agent;
        // goLive needs in-memory ownership, but this runner never starts the director.
        const directorSentinel = {};
        (runtime.show as any).director = directorSentinel;
        try {
          runtime.show.goLive(id);
          if ((runtime.show as any).director !== directorSentinel) throw new Error('director started');
        } finally {
          (runtime.show as any).director = null;
        }
        const mountedPreset = ctx.agentPresets.composedPreset(activeAgent.ctx);
        if (mountedPreset !== PRESET_ID) throw new Error('preset not mounted');
        record.presetId = mountedPreset;
        const toolSet = await ctx.tools.resolve({
          agent: activeAgent,
          modelSelection: { provider: 'glm-coding-plan', model: 'glm-5.3-flash' },
          signal: transport.controller.signal,
        });
        try {
          const schemas = ctx.tools.schemas(activeAgent, toolSet);
          const prompt = await ctx.systemPrompt.assemble(assembleContextFor(activeAgent));
          const composition = observeComposition(prompt.sections.map((section) => section.text).join('\n'), schemas);
          record.toolSchemas = composition.toolSchemas;
          record.schemaChecks = composition.schemaChecks;
          record.personaChecks = composition.personaChecks;
          if (!validComposition(composition)) throw new Error('preset composition rejected');
        } finally {
          toolSet.dispose();
        }
        activeAgent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: questions[index] }] }));
        await activeAgent.whenIdle();
        if (transport.controller.signal.aborted) throw new Error('transport stopped');
        const result = runtime.show.status().query;
        const events = activeAgent.session.snapshotEvents(0) as any[];
        const last = events.filter((event) => event.type === 'assistant/message').at(-1);
        const turn = events.filter((event) => event.type === 'turn/end').at(-1);
        answer = (last?.data?.message?.content ?? []).filter((item: any) => item.type === 'text' && typeof item.text === 'string').map((item: any) => item.text).join('\n').trim();
        if (!result || !['limited', 'evidence'].includes(result.status) || !answer
          || turn?.data?.reason?.kind !== 'completed' || transport.counts.model - before.model !== 2
          || (expectedTool === 'public_search' && transport.counts.mcp - before.mcp !== 1)) throw new Error('scenario did not complete');
        const toolCalls = events.filter((event) => event.type === 'assistant/message')
          .flatMap((event) => event.data?.message?.content ?? [])
          .filter((item: any) => item.type === 'tool-call');
        if (toolCalls.length !== 1 || toolCalls[0].name !== expectedTool) throw new Error('unexpected tool');
        record.sources = 'sources' in result ? result.sources.map((source: any) => {
          const safeUrl = sanitizeSourceUrl(source.url, [options.modelKey, options.ttsToken ?? '']);
          return {
            ...safeUrl,
            retrievedAt: cleanText(source.retrievedAt, 40),
            providerTime: {
              kind: cleanText(source.providerTime?.kind, 20),
              value: cleanText(source.providerTime?.value, 100),
              verbatim: cleanText(source.providerTime?.verbatim, 100),
            },
          };
        }) : [];
        record.limitation = cleanText('limitation' in result ? result.limitation : '', 300);
        record.answer = cleanText(answer, 2000);
      } catch {
        record.failureCode = 'scenario_incomplete';
        throw new Error('scenario stopped');
      } finally {
        const events = (activeAgent?.session?.snapshotEvents(0) ?? []) as any[];
        const toolCalls = events.filter((event) => event.type === 'assistant/message')
          .flatMap((event) => event.data?.message?.content ?? [])
          .filter((item: any) => item.type === 'tool-call');
        record.toolCallCount = toolCalls.length;
        const toolCall = toolCalls[0];
        if (toolCall) {
          record.actualTool = ['weather_lookup', 'public_search', 'show_stats'].includes(toolCall.name) ? toolCall.name : 'other';
          try {
            const args = JSON.parse(toolCall.arguments);
            if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('invalid arguments');
            const names = ['location', 'query', 'date'];
            const allowed: Record<string, string> = {};
            const types: Record<string, string> = {};
            record.unexpectedArgumentFields = Object.keys(args).filter((name) => !names.includes(name)).length;
            for (const name of names) {
              if (!(name in args)) continue;
              types[name] = args[name] === null ? 'null' : Array.isArray(args[name]) ? 'array' : typeof args[name];
              if (typeof args[name] !== 'string') continue;
              const value = args[name];
              const publicQuestion = questions[index].replace(/\s/g, '');
              const publicValue = value.replace(/\s/g, '');
              allowed[name] = publicValue && publicQuestion.includes(publicValue) && [...value].length <= 70
                ? cleanText(value, 70) : '[not fixed question text]';
            }
            record.toolArguments = allowed;
            record.toolArgumentTypes = types;
          } catch {
            record.toolArguments = null;
          }
        }
        const turn = events.filter((event) => event.type === 'turn/end').at(-1);
        const kind = turn?.data?.reason?.kind;
        record.turnEndKind = ['completed', 'aborted', 'blocked', 'error', 'max-tokens'].includes(kind) ? kind : 'unknown';
        const result = runtime.show.status().query;
        const status = result?.status;
        record.queryStatus = ['searching', 'evidence', 'limited', 'empty', 'failed', 'unsupported_response', 'timeout', 'cancelled', 'busy', 'unavailable', 'needs_clarification'].includes(status)
          ? status : 'not_started';
        record.status = record.queryStatus;
        if (options.mode === 'offline') record.fixtureWire = fixture.observation(index);
        record.modelRequests = transport.counts.model - before.model;
        record.searches = transport.counts.mcp - before.mcp;
        record.geocodeRequests = transport.counts.geocode - before.geocode;
        record.currentRequests = transport.counts.current - before.current;
        record.forecastRequests = transport.counts.forecast - before.forecast;
        record.synthesisJobs = transport.counts.synthesis - before.synthesis;
        if (record.failureCode) {
          const toolResults = events.filter((event) => event.type === 'tool/result');
          const rejectedInput = toolResults.some((event) => (event.data?.message?.content ?? [])
            .some((item: any) => item.type === 'text' && item.text === '请明确要查询的公开资料。'));
          const toolExecutionError = toolResults.some((event) => event.data?.message?.isError === true);
          if (rejectedInput) {
            record.failureCode = 'tool_input_rejected';
            record.failurePhase = 'tool';
          } else if (transport.failure && ['http_error', 'network_error'].includes(transport.failure.code)) {
            record.failureCode = transport.failure.code;
            record.failurePhase = transport.failure.phase;
          } else if (toolExecutionError) {
            record.failureCode = 'tool_execution_error';
            record.failurePhase = 'tool';
          } else if (transport.failure) {
            record.failureCode = transport.failure.code;
            record.failurePhase = transport.failure.phase;
          } else if (!record.actualTool) {
            record.failureCode = 'tool_not_called';
          } else if (record.actualTool !== expectedTool || record.toolCallCount !== 1) {
            record.failureCode = 'unexpected_tool';
          } else if (record.queryStatus === 'not_started') {
            record.failureCode = 'query_not_started';
          } else if (record.turnEndKind !== 'completed') {
            record.failureCode = 'turn_incomplete';
          }
          if (transport.failure) {
            if (transport.failure.httpStatus !== undefined) record.httpStatus = transport.failure.httpStatus;
          }
        }
        const evidencePath = join(options.audioDir, `scenario-${index + 1}.json`);
        const temporaryPath = `${evidencePath}.tmp`;
        try {
          await writeFile(temporaryPath, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
          await rename(temporaryPath, evidencePath);
        } catch {
          await rm(temporaryPath, { force: true }).catch(() => {});
          record.failureCode = 'diagnostic_write_failed';
          throw new Error('diagnostic write failed');
        } finally {
          try {
            if (runtime.show.isOnAir) {
              runtime.show.endLive();
              (runtime.show as any).finish();
            }
          } finally {
            if (activeHandle) {
              const handle = activeHandle;
              activeHandle = undefined;
              activeAgent = undefined;
              await handle.dispose();
              scopesDisposed++;
            }
          }
        }
      }
    }
    if (options.mode === 'real' && ttsBudget === 1) {
      phase = 'synthesis';
      if (!options.ttsToken) throw new Error('missing voice credential');
      const speechText = cleanText(answer, 120);
      const client = new YovoiceClient(YOVOICE_ORIGIN, options.ttsToken);
      const speech = await client.synthesize(speechText, transport.controller.signal);
      await writeFile(join(options.audioDir, 'acceptance.mp3'), speech.audio, { flag: 'wx', mode: 0o600 });
      audio = 'acquired_not_played';
    } else if (options.mode === 'offline') {
      audio = 'offline_not_requested';
    }
  } catch {
    transport.stop();
    failure = 'stopped';
  } finally {
    try {
      activeAgent?.cancel({ kind: 'user' });
      if (activeHandle) {
        await activeHandle.dispose();
        scopesDisposed++;
      }
    } finally {
      try {
        runtime?.show.dispose();
      } finally {
        try {
          await ctx.fiber.dispose();
        } finally {
          transport.controller.signal.removeEventListener('abort', abort);
          options.signal?.removeEventListener('abort', stop);
          transport.close();
          globalThis.fetch = originalFetch;
        }
      }
    }
  }
  return { mode: options.mode, presetId: PRESET_ID, scopesDisposed, scenarios, counts: transport.counts, audio, stagePlayback: 'not_tested', audiencePlayback: 'not_tested', cleanup: transport.counts.synthesis === 0 || !failure ? 'not_needed' : transport.jobTerminal ? 'confirmed' : 'unknown', phase, failure };
}
