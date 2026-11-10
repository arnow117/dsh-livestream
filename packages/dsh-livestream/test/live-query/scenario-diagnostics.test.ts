import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

it.each([
  { mode: 'rejected_parameter', code: 'tool_input_rejected', model: 1, search: 0 },
  { mode: 'secret_parameter', code: 'tool_input_rejected', model: 1, search: 0 },
  { mode: 'model_http_error', code: 'http_error', model: 1, search: 0 },
  { mode: 'mcp_http_error', code: 'http_error', model: 1, search: 0 },
  { mode: 'invalid_type', code: 'tool_execution_error', model: 1, search: 0 },
] as const)('preserves sanitized scenario 2 diagnostics for $mode', async ({ mode, code, model, search }) => {
  vi.resetModules();
  const previous = { ...process.env };
  const dir = await mkdtemp(join(tmpdir(), 'dsh-query-diagnostics-'));
  try {
    const { runAcceptance } = await import('./scenario');
    const result = await runAcceptance({
      mode: 'offline',
      dshHome: dir,
      audioDir: dir,
      modelKey: 'diagnostic-secret-sentinel',
      fixtureMode: mode,
    });
    expect(result.failure).toBe('stopped');
    expect(result.scenarios).toHaveLength(2);
    expect(result.presetId).toBe('dsh-livestream-douyin');
    expect(result.scopesDisposed).toBe(2);
    expect(result.scenarios[0]).toMatchObject({ question: '北京当前天气', status: 'limited' });
    expect(result.scenarios[1]).toMatchObject({
      question: 'OBS Studio许可证',
      expectedTool: 'public_search',
      presetId: 'dsh-livestream-douyin',
      toolSchemas: ['public_search', 'show_stats', 'weather_lookup'],
      personaChecks: { originalQuery: true, sourceTime: true, limited: true, noLongUrl: true },
      failureCode: code,
      modelRequests: model,
      searches: search,
      synthesisJobs: 0,
    });
    expect(['aborted', 'error']).toContain(result.scenarios[1].turnEndKind);
    if (mode === 'rejected_parameter') {
      expect(result.scenarios[1]).toMatchObject({ actualTool: 'public_search', toolArguments: { query: 'OBS Studio 许可证' }, toolArgumentTypes: { query: 'string' }, unexpectedArgumentFields: 0, queryStatus: 'not_started' });
    } else if (mode === 'secret_parameter') {
      expect(result.scenarios[1]).toMatchObject({ actualTool: 'public_search', toolArguments: { query: '[not fixed question text]' } });
    } else if (mode === 'model_http_error') {
      expect(result.scenarios[1]).toMatchObject({ actualTool: null, queryStatus: 'not_started', httpStatus: 503, failurePhase: 'model' });
    } else if (mode === 'mcp_http_error') {
      expect(result.scenarios[1]).toMatchObject({ actualTool: 'public_search', httpStatus: 503, failurePhase: 'mcp' });
    } else {
      expect(result.scenarios[1]).toMatchObject({ actualTool: 'public_search', toolArguments: {}, toolArgumentTypes: { query: 'number' }, unexpectedArgumentFields: 1, failurePhase: 'tool' });
    }
    expect(result.counts).toEqual({ model: 3, mcp: 0, geocode: 1, current: 1, forecast: 0, synthesis: 0 });
    expect(JSON.stringify(result)).not.toContain('diagnostic-secret-sentinel');
    const saved = await readFile(join(dir, 'scenario-2.json'), 'utf8');
    expect(JSON.parse(saved)).toEqual(result.scenarios[1]);
    expect(saved).not.toContain('diagnostic-secret-sentinel');
  } finally {
    process.env = previous;
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

it('rejects an offline fixture mode in real mode before any request', async () => {
  vi.resetModules();
  const { runAcceptance } = await import('./scenario');
  await expect(runAcceptance({
    mode: 'real',
    dshHome: '/unused',
    audioDir: '/unused',
    modelKey: 'fixture',
    fixtureMode: 'rejected_parameter',
  })).rejects.toThrow('fixture mode is offline only');
});

it('completes both real-mode scenarios with a zero voice budget and no voice request', async () => {
  vi.resetModules();
  const previous = { ...process.env };
  const previousFetch = globalThis.fetch;
  const dir = await mkdtemp(join(tmpdir(), 'dsh-query-no-voice-'));
  const { createFixture } = await import('./fixture');
  const { MODEL_URL, YOVOICE_ORIGIN } = await import('./transport');
  const fixture = createFixture();
  let modelRequests = 0;
  const targets: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    targets.push(url);
    if (url === MODEL_URL) {
      if (modelRequests === 0 || modelRequests === 2) fixture.beginScenario(modelRequests / 2);
      modelRequests++;
    }
    return fixture.fetch(input, init);
  };
  try {
    const { runAcceptance } = await import('./scenario');
    const result = await runAcceptance({
      mode: 'real',
      dshHome: dir,
      audioDir: dir,
      modelKey: 'fixture-model-key',
      ttsBudget: 0,
    });
    expect(result.failure).toBeUndefined();
    expect(result.scenarios.map((scenario) => scenario.status)).toEqual(['limited', 'evidence']);
    expect(result.scenarios.map((scenario) => scenario.actualTool)).toEqual(['weather_lookup', 'public_search']);
    expect(result.audio).toBe('not_requested');
    expect(result.counts).toEqual({ model: 4, mcp: 1, geocode: 1, current: 1, forecast: 0, synthesis: 0 });
    expect(result.scopesDisposed).toBe(2);
    expect(targets.some((target) => target.startsWith(YOVOICE_ORIGIN))).toBe(false);
  } finally {
    globalThis.fetch = previousFetch;
    process.env = previous;
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);
