import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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
import AgentRegistry, { assembleContextFor } from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry';
import AgentPreset from '@deepseek-ai/dsh-agent-preset';
import * as Persona from '@deepseek-ai/dsh-persona';

describe('actual preset prompt scope', () => {
  it('keeps the original persona outside an eligible managed turn and narrows it only for the verified scope', async () => {
    const home = process.env.DSH_HOME;
    const presetFile = process.env.DSH_PUBLIC_CHAT_PRESET_FILE;
    if (!home || !presetFile) throw new Error('isolated fixture inputs required');
    const dataDir = join(home, 'dsh-livestream');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ stagePort: 0, stageToken: 'fixture-stage-token',
      livePlatform: 'douyin', douyinRoomId: '101' }), { mode: 0o600 });
    process.env.PUBLIC_CHAT_FIXTURE_MODEL_KEY = 'fixture';
    const ctx = new Context();
    let runtime: typeof import('../../src/dsh/runtime') | undefined;
    let handle: any;
    try {
      await ctx.plugin(Loader);
      ctx.loader.builtins.group = Group;
      ctx.loader.builtins.persona = Persona;
      await ctx.plugin(LlmRuntime);
      await ctx.plugin(LlmPiAi, { providers: { fixture: { api: 'anthropic-messages', baseURL: 'http://127.0.0.1:1',
        apiKeyEnv: 'PUBLIC_CHAT_FIXTURE_MODEL_KEY', cacheRetention: 'none', models: [{ id: 'model' }] } } });
      await ctx.plugin(SessionStore);
      await ctx.plugin(SessionProjectionRegistry);
      await ctx.plugin(SystemPrompt, { personaPrefix: '' });
      await ctx.plugin(ToolRuntime);
      await ctx.plugin({ inject: ['tools'], apply(owner: Context) { owner.tools.setExecutor(new NativeToolExecutor.NativeToolExecutor(owner, () => 1)); } });
      await ctx.plugin(AgentRegistry);
      await ctx.plugin(AgentLoop, { agents: [] });
      await ctx.plugin(AgentPresets, { default: 'dsh-livestream-douyin' });
      runtime = await import('../../src/dsh/runtime');
      const plugin = await import('../../src/dsh/agent');
      ctx.loader.builtins.livestreamAgent = plugin;
      const patch = parse(readFileSync(presetFile, 'utf8')) as Array<{ insert?: any[] }>;
      const definition = patch.flatMap((item) => item.insert ?? []).find((item) => item.config?.id === 'dsh-livestream-douyin');
      if (!definition) throw new Error('preset missing');
      const config = structuredClone(definition.config);
      for (const row of config.plugins) {
        if (row.name === '@deepseek-ai/dsh-persona') row.name = 'cordis:persona';
        if (row.name === 'dsh-livestream/agent') row.name = 'cordis:livestreamAgent';
      }
      await ctx.plugin(AgentPreset, config);
      const session = await import('../../src/dsh/sessionContext');
      const record = { schemaVersion: 1, revision: 1, config: { enabled: false, cwd: '', skillSources: [], readRoots: [] },
        bindings: { cwd: null, skills: [], roots: [] } };
      const prepared = await session.prepareSnapshot(record, 'public-chat-preset-probe', 'douyin', 'dsh-livestream-douyin');
      if (!prepared.ok || !session.writeSnapshot(prepared.snapshot).ok) throw new Error('fixture snapshot failed');
      handle = await ctx.agents.create({ sessionId: SessionId('public-chat-preset-probe'),
        agentOptions: { provider: 'fixture', model: 'model', maxTokens: 256 },
        setup: async (scope: any) => { await ctx.agentPresets.mount(scope, 'dsh-livestream-douyin'); } });
      const agent = handle.agent;
      const original = await ctx.systemPrompt.assemble(assembleContextFor(agent));
      const section = original.sections.find((entry: { name: string }) => entry.name === 'deployment:persona-prefix');
      expect(section?.text).toContain('不向抖音发言');
      if (!section) throw new Error('preset persona section unavailable');
      const signal = new AbortController();
      const sentinel = {};
      (runtime.show as any).director = sentinel;
      try {
        runtime.show.goLive('public-chat-preset-probe');
      } finally {
        (runtime.show as any).director = null;
      }
      runtime.publicChatBridge.replyAvailable = (candidate, currentSignal) => candidate === agent && !currentSignal.aborted;
      const overridden = await ctx.systemPrompt.assemble(assembleContextFor(agent, signal.signal));
      expect(overridden.sections[0].text).toContain('仅在 send_public_chat_reply 对当前唯一原弹幕可用时');
      expect(overridden.sections[0].text).not.toContain('不向抖音发言或推流');
      runtime.publicChatBridge.replyAvailable = () => false;
      const restored = await ctx.systemPrompt.assemble(assembleContextFor(agent, signal.signal));
      expect(restored.sections[0].text).toBe(section.text);
    } finally {
      if (runtime) runtime.publicChatBridge.replyAvailable = null;
      if (handle) await handle.dispose();
      runtime?.show.dispose();
      await ctx.fiber.dispose();
      delete process.env.PUBLIC_CHAT_FIXTURE_MODEL_KEY;
    }
  }, 15000);
});
