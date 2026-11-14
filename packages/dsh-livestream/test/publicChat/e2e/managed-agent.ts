import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import Group from '@deepseek-ai/cordis-plugin-group';
import { parse } from 'yaml';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry';
import AgentPreset from '@deepseek-ai/dsh-agent-preset';
import * as Persona from '@deepseek-ai/dsh-persona';
import { expect } from 'vitest';

interface Inputs {
  presetPath: string;
  builtAgent?: string;
  runtime: typeof import('../../../src/dsh/runtime');
  emitRaw(id: number): void;
  emitSource(id: number, text: string): void;
  chatCount(): number;
}

/** The real managed preset and native executor use only a task-local protocol model. */
export async function runManagedAgent(input: Inputs): Promise<void> {
  let modelRequests = 0;
  let requestedTool = false;
  let matchedSchema = false;
  let matchedPersona = false;
  let cancelledTurnRequested = false;
  let cancelledToolAvailable = false;
  let simulatedTurnWithoutTool = false;
  let releaseCancelled!: () => void;
  let markCancelled!: () => void;
  const cancelledResponse = new Promise<void>((resolve) => { releaseCancelled = resolve; });
  const cancelledRequest = new Promise<void>((resolve) => { markCancelled = resolve; });
  const model = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      modelRequests++;
      const source = JSON.stringify(body.messages ?? []);
      const isAudienceTurn = source.includes('fixture audience question');
      const tool = (body.tools ?? []).find((entry: { name?: string }) => entry.name === 'send_public_chat_reply');
      const isCancelledTurn = source.includes('fixture cancellation question') && !cancelledTurnRequested;
      const isSimulatedTurn = source.includes('fixture simulated question');
      if (isCancelledTurn) {
        cancelledTurnRequested = true;
        cancelledToolAvailable = !!tool;
        markCancelled();
        await cancelledResponse;
        if (response.destroyed) return;
      }
      if (isSimulatedTurn) simulatedTurnWithoutTool = !tool;
      const call = isAudienceTurn && !requestedTool && !!tool;
      if (isAudienceTurn && !requestedTool) {
        matchedSchema = !!tool && Object.keys(tool.input_schema?.properties ?? {}).join(',') === 'text';
        const system = JSON.stringify(body.system ?? '');
        matchedPersona = system.includes('仅在 send_public_chat_reply 对当前唯一原弹幕可用时')
          && !system.includes('不向抖音发言或推流');
      }
      if (call) requestedTool = true;
      const frames: unknown[] = [
        { type: 'message_start', message: { id: `fixture_${modelRequests}`, type: 'message', role: 'assistant',
          model: 'model', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
        ...(call ? [
          { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'fixture_reply', name: 'send_public_chat_reply', input: {} } },
          { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ text: '你好，欢迎来聊天' }) } },
        ] : [
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '本地舞台回复' } },
        ]),
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: call ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ];
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(frames.map((frame: any) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''));
    })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
  });
  await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
  const address = model.address();
  if (!address || typeof address === 'string') throw new Error('model fixture listener unavailable');
  const oldKey = process.env.PUBLIC_CHAT_FIXTURE_MODEL_KEY;
  process.env.PUBLIC_CHAT_FIXTURE_MODEL_KEY = 'fixture';
  const ctx = new Context();
  let handle: any;
  const oldSay = input.runtime.show.say;
  input.runtime.show.say = async () => '';
  const showInternal = input.runtime.show as any;
  if (showInternal.director) clearInterval(showInternal.director);
  showInternal.director = null;
  let sourceSeen = false;
  const offSource = input.runtime.show.hub.subscribe((event) => { if (event.kind === 'chat' && event.id === '901') sourceSeen = true; });
  try {
    await ctx.plugin(Loader);
    ctx.loader.builtins.group = Group;
    ctx.loader.builtins.persona = Persona;
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(LlmPiAi, { providers: { fixture: { api: 'anthropic-messages', baseURL: `http://127.0.0.1:${address.port}`,
      apiKeyEnv: 'PUBLIC_CHAT_FIXTURE_MODEL_KEY', cacheRetention: 'none', models: [{ id: 'model' }] } } });
    await ctx.plugin(SessionStore);
    await ctx.plugin(SessionProjectionRegistry);
    await ctx.plugin(SystemPrompt, { personaPrefix: '' });
    await ctx.plugin(ToolRuntime);
    await ctx.plugin({ inject: ['tools'], apply(owner: Context) { owner.tools.setExecutor(new NativeToolExecutor.NativeToolExecutor(owner, () => 1)); } });
    await ctx.plugin(AgentRegistry);
    await ctx.plugin(AgentLoop, { agents: [] });
    await ctx.plugin(AgentPresets, { default: 'dsh-livestream-douyin' });
    const plugin = input.builtAgent
      ? await import(/* @vite-ignore */ pathToFileURL(input.builtAgent).href)
      : await import('../../../src/dsh/agent');
    ctx.loader.builtins.livestreamAgent = plugin;
    const patch = parse(readFileSync(input.presetPath, 'utf8')) as Array<{ insert?: any[] }>;
    const row = patch.flatMap((item) => item.insert ?? []).find((item) => item.config?.id === 'dsh-livestream-douyin');
    if (!row) throw new Error('actual preset missing');
    const config = structuredClone(row.config);
    for (const entry of config.plugins) {
      if (entry.name === '@deepseek-ai/dsh-persona') entry.name = 'cordis:persona';
      if (entry.name === 'dsh-livestream/agent') entry.name = 'cordis:livestreamAgent';
    }
    await ctx.plugin(AgentPreset, config);
    const session = await import('../../../src/dsh/sessionContext');
    const record = { schemaVersion: 1, revision: 1, config: { enabled: false, cwd: '', skillSources: [], readRoots: [] },
      bindings: { cwd: null, skills: [], roots: [] } };
    const prepared = await session.prepareSnapshot(record, 'fixture-session', 'douyin', 'dsh-livestream-douyin');
    if (!prepared.ok || !session.writeSnapshot(prepared.snapshot).ok) throw new Error('managed fixture snapshot failed');
    handle = await ctx.agents.create({ sessionId: SessionId('fixture-session'),
      agentOptions: { provider: 'fixture', model: 'model', maxTokens: 256 },
      setup: async (scope: any) => { await ctx.agentPresets.mount(scope, 'dsh-livestream-douyin'); } });
    // Let the real session watcher establish its cursor before the first turn.
    await new Promise((resolve) => setTimeout(resolve, 700));
    showInternal.director = setInterval(() => void showInternal.direct(), 200);
    const deadline = Date.now() + 15000;
    while (modelRequests === 0) {
      if (Date.now() > deadline) throw new Error('opening turn did not reach local model');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await handle.agent.whenIdle();
    const settled = Date.now() + 5000;
    while (showInternal.turnRunning) {
      if (Date.now() > settled) throw new Error('opening turn did not settle in show watcher');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const before = input.chatCount();
    input.emitRaw(901);
    await new Promise((resolve) => setTimeout(resolve, 300));
    input.emitSource(901, 'fixture audience question');
    while (input.chatCount() === before) {
      if (Date.now() > deadline) throw new Error(`managed reply unavailable: model=${modelRequests} schema=${matchedSchema} persona=${matchedPersona} requested=${requestedTool} source=${sourceSeen} pending=${JSON.stringify(input.runtime.show.status().pending)}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await handle.agent.whenIdle();
    expect(requestedTool).toBe(true);
    expect(matchedSchema).toBe(true);
    expect(matchedPersona).toBe(true);
    expect(input.chatCount()).toBe(before + 1);

    // Cancel the actual managed turn while its local model response is in flight.
    const turnSettled = Date.now() + 5000;
    while (showInternal.turnRunning) {
      if (Date.now() > turnSettled) throw new Error('audience turn did not settle');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    input.emitRaw(906);
    await new Promise((resolve) => setTimeout(resolve, 300));
    input.emitSource(906, 'fixture cancellation question');
    let cancelTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([cancelledRequest, new Promise<never>((_, reject) => {
        cancelTimeout = setTimeout(() => reject(new Error('cancelled turn did not reach local model')), 15000);
      })]);
    } finally {
      if (cancelTimeout) clearTimeout(cancelTimeout);
    }
    handle.agent.cancel({ kind: 'user' });
    releaseCancelled();
    await handle.agent.whenIdle();
    expect(cancelledTurnRequested).toBe(true);
    expect(cancelledToolAvailable).toBe(true);
    expect(input.chatCount()).toBe(before + 1);

    // Ordinary ingest is not upgraded to a trusted source by the real AgentLoop.
    const afterCancel = Date.now() + 5000;
    while (showInternal.turnRunning) {
      if (Date.now() > afterCancel) throw new Error('cancelled turn did not settle');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    input.runtime.show.hub.ingest({ id: 'fixture-simulated', platform: 'douyin', kind: 'chat', ts: Date.now(),
      user: { id: 'simulated-viewer', name: '模拟观众' }, text: 'fixture simulated question' });
    const simulatedDeadline = Date.now() + 15000;
    while (!simulatedTurnWithoutTool) {
      if (Date.now() > simulatedDeadline) throw new Error('simulated turn did not run without the public chat tool');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await handle.agent.whenIdle();
    expect(input.chatCount()).toBe(before + 1);
    console.info(`managed-agent model-requests=${modelRequests} chat-before=${before} chat-after=${input.chatCount()} cancelled=true simulated-no-tool=true model-port=${address.port}`);
  } finally {
    releaseCancelled();
    offSource();
    if (handle) await handle.dispose();
    await ctx.fiber.dispose();
    input.runtime.show.say = oldSay;
    await new Promise<void>((resolve, reject) => model.close((error) => error ? reject(error) : resolve()));
    if (oldKey === undefined) delete process.env.PUBLIC_CHAT_FIXTURE_MODEL_KEY;
    else process.env.PUBLIC_CHAT_FIXTURE_MODEL_KEY = oldKey;
  }
}
