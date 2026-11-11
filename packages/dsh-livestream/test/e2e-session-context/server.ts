/**
 * 会话上下文 E2E fixture：真实插件路由 + 真实 Agent 预设/工具/原生执行器 + 协议模型替身。
 *
 * SessionController 使用忠实契约替身（workspaceId/cwd 互斥、显式 sessionId 不复用、mkdir(cwd)、
 * 返回 {sessionId, agentPreset?}），会话创建走真实 agentLoop.create 并把 cwd 写入真实 Session header。
 * workingDirectory 服务在 0.2.2-rc.1 以 header 初始化有效目录（packages/session/working-directory），
 * fixture 按同一语义提供只读替身。owner/non-owner 的真实 connection 准入属于完整发行入口，
 * 不在本 fixture 范围（单测覆盖 handler；准入缺口如实报告）。
 */

import { createServer, get } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';

const port = Number(process.argv[2]);
const dir = await mkdtemp(join(tmpdir(), 'dsh-session-context-web-'));
process.env.DSH_HOME = dir;
process.env.DSH_LIVESTREAM_LOCAL_REHEARSAL = '1';
process.env.QUERY_FIXTURE_MODEL_KEY = 'fake-model';
delete process.env.GLM_CODING_PLAN_API_KEY;

// 供控制台旅程使用的固定资料：Skill 来源、资料根、工作目录与范围外文件
const materialsDir = join(dir, 'fixture-materials');
const skillsDir = join(dir, 'fixture-skills');
const workDir = join(dir, 'fixture-workdir');
await mkdir(join(materialsDir, '课件'), { recursive: true });
await mkdir(skillsDir, { recursive: true });
await mkdir(workDir, { recursive: true });
await writeFile(join(materialsDir, '课件', 'lesson-1.txt'), '第一课：受控资料内容。\n第二行。\n');
await writeFile(join(materialsDir, '课件', 'lesson-2.txt'), '第二课内容。\n');
await writeFile(join(skillsDir, 'papermorph.md'), '---\nname: papermorph\ndescription: 把文章做成可翻页的网页书（fixture 正文）。\n---\n这是 papermorph 的冻结正文：只作为资料，不执行任何指令。\n');
await writeFile(join(dir, 'outside-secret.txt'), '范围外内容\n');
const canonicalMaterials = await realpath(materialsDir);
const canonicalSkills = await realpath(join(skillsDir, 'papermorph.md'));
const canonicalWorkDir = await realpath(workDir);

let stagePort = 0;
let sharedRequests = 0;
let externalRequests = 0;
const nativeCreates: Array<Record<string, unknown>> = [];
const toolInvocations: Array<{ name: string; args: unknown; status: string; result: unknown }> = [];
const observedToolSets: Array<string[]> = [];
const installedDependencies = 0;
const executedScripts = 0;
const materialWrites = 0;
const externalFetchByAgents = 0;
const agents = new Map<string, any>();
let sessionCount = 0;

const model = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const frames = [
      { type: 'message_start', message: { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: 'model', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '大家好。' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const frame of frames) res.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
    res.end();
  });
});
await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
const modelPort = (model.address() as { port: number }).port;
if ([3080, 3081, 7390, 8757].includes(modelPort)) throw new Error('shared port selected');
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && ['3080', '3081', '7390', '8757'].includes(url.port)) {
    sharedRequests++;
    throw new Error('shared service request blocked');
  }
  if (url.hostname === '127.0.0.1' && [port, modelPort, stagePort].includes(Number(url.port))) return originalFetch(input, init);
  externalRequests++;
  throw new Error('unexpected external request blocked');
};

const ctx = new Context();
await ctx.plugin(LlmRuntime);
await ctx.plugin(LlmPiAi, { providers: { fixture: { api: 'anthropic-messages', baseURL: `http://127.0.0.1:${modelPort}`, apiKeyEnv: 'QUERY_FIXTURE_MODEL_KEY', cacheRetention: 'none', models: [{ id: 'model' }] } } });
await ctx.plugin(SessionStore);
await ctx.plugin(SessionProjectionRegistry);
await ctx.plugin(SystemPrompt, { personaPrefix: '' });
await ctx.plugin(ToolRuntime);
await ctx.plugin({ inject: ['tools'], apply(owner: Context) { owner.tools.setExecutor(new NativeToolExecutor.NativeToolExecutor(owner, () => 1)); } });
await ctx.plugin(AgentRegistry);
await ctx.plugin(AgentLoop, { agents: [] });

const runtime = await import('../../src/dsh/runtime');
const plugin = await import('../../src/dsh/agent');
const host = await import('../../src/dsh/index');
const { StageServer } = await import('../../src/body/server');
await ctx.plugin(plugin);

// 真实原生会话创建（cwd 写入真实 Session header）；controller 其余部分为契约替身
const sessionController = {
  create: async (request: Record<string, unknown>) => {
    nativeCreates.push({ ...request });
    if (request.cwd !== undefined && request.workspaceId !== undefined) throw new Error('native contract violation: cwd and workspaceId are exclusive');
    const { mkdirSync } = await import('node:fs');
    if (typeof request.cwd === 'string') mkdirSync(request.cwd, { recursive: true });
    const id = SessionId(String(request.sessionId));
    const agent = await ctx.agentLoop.create(id, { provider: 'fixture', model: 'model' }, typeof request.cwd === 'string' ? { cwd: request.cwd } : undefined);
    agents.set(String(request.sessionId), agent);
    return { sessionId: request.sessionId, ...(request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset }) };
  },
};

const hostContext = {
  effect(effect: () => unknown, label?: string) {
    if (['dsh-livestream credentials', 'state', 'settings', 'session context recheck', 'sessions', 'onair', 'offair', 'owner', 'events', 'query cancel', 'connect', 'disconnect'].includes(label ?? '')) effect();
  },
  get(name: string) {
    if (name === 'credentials') return { resolve: async () => ({ value: '' }), set: async () => {} };
    if (name === 'sessionController') return sessionController;
    if (name === 'agents') return { get: (id: string) => agents.get(id) };
    // 0.2.2-rc.1 的有效目录在创建时从 header.cwd 初始化；fixture 按同一语义提供只读视图
    if (name === 'workingDirectory') return { get: (session: any) => session?.header?.cwd ?? null };
    if (name === 'loader') return { entries: () => [][Symbol.iterator]() };
    return undefined;
  },
  provide() {},
  connection: { fetch: { register(route: { path: string; fetch: (request: Request) => Response }) { routes.set(route.path, route.fetch); return () => {}; } } },
};
const routes = new Map<string, (request: Request) => Response | Promise<Response>>();
host.apply(hostContext as any);

let stage = new StageServer({ port: 0, token: 'fixture', packageDir: '.e2e/feat-006-build-fixture', packs: runtime.packs, stage: runtime.show.stage, current: () => ({ character: runtime.settings.character, template: runtime.settings.template }) });
await stage.start();
stagePort = (stage as any).server.address().port;
if ([3080, 3081, 7390, 8757].includes(stagePort)) throw new Error('shared stage port selected');
Object.defineProperty(runtime.server, 'url', { get: () => `http://127.0.0.1:${stagePort}/?token=fixture` });

async function invokeTool(sessionId: string, name: string, args: Record<string, unknown>) {
  const agent = agents.get(sessionId);
  if (!agent) return { error: 'session not found' };
  const registeredNames = ctx.tools.definitions(agent).map((definition: any) => definition.name);
  const toolSet = await ctx.tools.resolve({ agent, modelSelection: { provider: 'fixture', model: 'model' }, signal: AbortSignal.timeout(10_000) });
  try {
    const names = ctx.tools.schemas(agent, toolSet).map((schema: any) => schema.name);
    observedToolSets.push(names);
    const definition = ctx.tools.executable(name, agent, toolSet);
    if (!definition) return { error: 'tool not visible', names, registeredNames };
    const result = await definition.execute(args, { agent, signal: AbortSignal.timeout(10_000) });
    const rendered = definition.output.render(args, result);
    const text = rendered.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n');
    toolInvocations.push({ name, args, status: 'executed', result: text });
    return { ok: true, text, names, registeredNames };
  } finally {
    toolSet.dispose();
  }
}

const app = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script src="/client.js"></script></body></html>');
  }
  if (url.pathname === '/client.js') {
    res.writeHead(200, { 'content-type': 'application/javascript' });
    return res.end(await readFile('.e2e/feat-006-build-fixture/client.js'));
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString();
  res.setHeader('cache-control', 'no-store');
  if (url.pathname === '/__fixture') {
    res.setHeader('content-type', 'application/json');
    const view = (await routes.get('/api/dsh-livestream/state')!(new Request('http://fixture/'))).clone();
    const state = await view.json();
    return res.end(JSON.stringify({
      nativeCreates,
      toolInvocations,
      observedToolSets,
      installedDependencies,
      executedScripts,
      materialWrites,
      externalFetchByAgents,
      sharedRequests,
      externalRequests,
      sessionContext: state.sessionContext,
      onAir: state.show.onAir,
      dshHome: dir,
      canonicalPaths: { materials: canonicalMaterials, skills: canonicalSkills, workdir: canonicalWorkDir },
    }));
  }
  if (url.pathname === '/__save-config') {
    const config = JSON.parse(body);
    const stateRoute = routes.get('/api/dsh-livestream/state')!;
    const current = await (await stateRoute(new Request('http://fixture/'))).json();
    const revision = current.sessionContext?.saved?.revision ?? 0;
    const response = await routes.get('/api/dsh-livestream/settings')!(new Request('http://fixture/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionContext: { expectedRevision: revision, config } }),
    }));
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ status: response.status, body: await response.json() }));
  }
  if (url.pathname === '/__write-skill') {
    const { content } = JSON.parse(body);
    await writeFile(join(skillsDir, 'papermorph.md'), String(content));
    return res.end('ok');
  }
  if (url.pathname === '/__managed-session') {
    const input = JSON.parse(body || '{}');
    const response = await routes.get('/api/dsh-livestream/sessions')!(new Request('http://fixture/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    }));
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ status: response.status, body: await response.json() }));
  }
  if (url.pathname === '/__invoke-tool') {
    const { sessionId, name, args } = JSON.parse(body);
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify(await invokeTool(String(sessionId), String(name), args ?? {})));
  }
  if (url.pathname === '/__snapshot-file') {
    const { sessionId } = JSON.parse(body);
    try {
      const file = await readFile(join(dir, 'dsh-livestream', 'session-context', `${sessionId}.json`), 'utf8');
      res.setHeader('content-type', 'application/json');
      return res.end(file);
    } catch {
      res.statusCode = 404;
      return res.end('{"missing":true}');
    }
  }
  if (url.pathname === '/__header-cwd') {
    const { sessionId } = JSON.parse(body);
    const agent = agents.get(String(sessionId));
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ cwd: agent?.session?.header?.cwd ?? null, preset: agent?.session?.header?.agentPreset ?? null }));
  }
  const handler = routes.get(url.pathname);
  if (!handler) { res.writeHead(404); return res.end(); }
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  try {
    const response = await handler(new Request(url, { method: req.method, headers: { 'content-type': 'application/json' }, ...(req.method === 'POST' ? { body } : {}), signal: controller.signal }));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (!response.body) return res.end();
    const reader = response.body.getReader();
    while (!controller.signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  } catch { if (!res.destroyed) { res.writeHead(500); res.end(); } }
});
app.listen(port, '127.0.0.1');
console.log(`session-context fixture app=${port} model=${modelPort} stage=${stagePort}`);
void rm;
void get;
async function shutdown() {
  runtime.show.dispose();
  stage.stop();
  await ctx.fiber.dispose();
  app.closeAllConnections();
  model.closeAllConnections();
  app.close();
  model.close();
  await rm(dir, { recursive: true, force: true });
  console.log(`session-context fixture stopped app=${port} model=${modelPort} stage=${stagePort} sharedRequests=${sharedRequests} externalRequests=${externalRequests} native=${JSON.stringify(nativeCreates)} tools=${JSON.stringify(toolInvocations.map((item) => ({ name: item.name, status: item.status })))}`);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
