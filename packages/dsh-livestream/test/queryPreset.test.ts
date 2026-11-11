import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import Group from '@deepseek-ai/cordis-plugin-group';
import LlmRuntime from '@deepseek-ai/dsh-llm';
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

describe('actual livestream preset composition', () => {
  it.each([
    { mode: 'bilibili', preset: 'dsh-livestream', local: false, hasBili: true },
    { mode: 'douyin', preset: 'dsh-livestream-douyin', local: false, hasBili: false },
    { mode: 'bilibili', preset: 'dsh-livestream', local: true, hasBili: false },
  ] as const)('$preset in $mode, local=$local', async ({ mode, preset, local, hasBili }) => {
    vi.resetModules();
    const previous = { ...process.env };
    const dir = await mkdtemp(join(tmpdir(), 'query-preset-'));
    process.env.DSH_HOME = dir;
    process.env.GLM_CODING_PLAN_API_KEY = 'fake-key';
    process.env.DSH_LIVESTREAM_LOCAL_REHEARSAL = local ? '1' : '0';
    const ctx = new Context();
    let runtime: typeof import('../src/dsh/runtime') | undefined;
    try {
      await ctx.plugin(Loader);
      ctx.loader.builtins.group = Group;
      ctx.loader.builtins.persona = Persona;
      await ctx.plugin(LlmRuntime);
      await ctx.plugin(SessionStore);
      await ctx.plugin(SessionProjectionRegistry);
      await ctx.plugin(SystemPrompt, { personaPrefix: '' });
      await ctx.plugin(ToolRuntime);
      await ctx.plugin(NativeToolExecutor);
      await ctx.plugin(AgentRegistry);
      await ctx.plugin(AgentLoop, { agents: [] });
      await ctx.plugin(AgentPresets, { default: preset });
      runtime = await import('../src/dsh/runtime');
      const actualAgent = await import('../src/dsh/agent');
      ctx.loader.builtins.livestreamAgent = actualAgent;
      const patch = parse(await readFile('cordis.patch.yml', 'utf8')) as Array<{ insert: any[] }>;
      const actual = patch.flatMap((item) => item.insert ?? []).find((item) => item.config?.id === preset);
      expect(actual).toBeDefined();
      // Only resolve the two actual modules to in-process Loader builtins, so this
      // test uses current source instead of the live installation's lib symlink.
      const config = structuredClone(actual.config);
      for (const row of config.plugins) {
        if (row.name === '@deepseek-ai/dsh-persona') row.name = 'cordis:persona';
        if (row.name === 'dsh-livestream/agent') row.name = 'cordis:livestreamAgent';
      }
      await ctx.plugin(AgentPreset, config);
      const handle = await ctx.agents.create({
        sessionId: SessionId(`preset-${mode}-${local}`),
        agentOptions: { provider: 'fixture', model: 'fixture' },
        setup: async (scope) => { await ctx.agentPresets.mount(scope, preset); },
      });
      const agent = handle.agent;
      runtime.updateSettings({ livePlatform: mode, readOnlyQueries: { weather: true, publicSearch: true } });
      runtime.show.setPlatform(mode);
      runtime.show.goLive(agent.session.id);
      const toolSet = await ctx.tools.resolve({ agent, modelSelection: { provider: 'fixture', model: 'fixture' }, signal: new AbortController().signal });
      const schemas = ctx.tools.schemas(agent, toolSet);
      const tools = schemas.map((tool) => tool.name);
      expect(tools).toEqual(expect.arrayContaining(['show_stats', 'weather_lookup', 'public_search']));
      expect(tools.includes('view_profile')).toBe(hasBili);
      const prompt = await ctx.systemPrompt.assemble(assembleContextFor(agent));
      const text = prompt.sections.map((section) => section.text).join('\n');
      expect(text).toContain('查询工具实际可用时');
      expect(text).toContain('weather_lookup');
      expect(text).toContain('原文');
      expect(text).toContain('来源名');
      expect(text).toContain('时间限制');
      expect(text).toContain('不朗读长链接');
      expect(text).toContain('实况和预报');
      expect(text).toContain('limited、unknown');
      expect(text).toContain('查询证据保留来源');
      expect(text).toContain('预报日期不明确先澄清');
      expect(text).toContain('当前天气无需预报日期');
      const publicSchema = JSON.stringify(schemas.find((tool) => tool.name === 'public_search'));
      expect(publicSchema).toContain('原文');
      expect(publicSchema).toContain('70');
      expect(publicSchema).toContain('逐字复制');
      expect(publicSchema).toContain('不得改写');
      expect(text).not.toContain('仅可用 show_stats');
      toolSet.dispose();
      runtime.updateSettings({ readOnlyQueries: { weather: false, publicSearch: false } });
      const disabled = await ctx.tools.resolve({ agent, modelSelection: { provider: 'fixture', model: 'fixture' }, signal: new AbortController().signal });
      const disabledTools = ctx.tools.schemas(agent, disabled).map((tool) => tool.name);
      expect(disabledTools).not.toContain('weather_lookup');
      expect(disabledTools).not.toContain('public_search');
      disabled.dispose();
    } finally {
      runtime?.show.dispose();
      await ctx.fiber.dispose();
      process.env = previous;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
