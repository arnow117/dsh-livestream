import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

it('requires an explicit real flag and complete reviewed budget before starting', async () => {
  for (const args of [
    ['--real'],
    ['--real', '--approve=search:99,model:4,tts:1,seconds:300'],
    ['--real', '--approve=search:2,model:4,tts:1,seconds:300'],
  ]) {
    await expect(execFileAsync(process.execPath, ['test/live-query/run.mjs', ...args], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '' },
    })).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('no work started') });
  }
});

it('does not expose ambient credential values in the default offline result', async () => {
  const { stdout } = await execFileAsync(process.execPath, ['test/live-query/run.mjs'], {
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? '', GLM_CODING_PLAN_API_KEY: 'secret-model-sentinel', YOVOICE_API_TOKEN: 'secret-voice-sentinel' },
  });
  expect(stdout).not.toContain('secret-model-sentinel');
  expect(stdout).not.toContain('secret-voice-sentinel');
  const [result, cleanup] = stdout.trim().split('\n').map((line) => JSON.parse(line));
  expect(result.mode).toBe('offline');
  expect(result.presetId).toBe('dsh-livestream-douyin');
  expect(result.scopesDisposed).toBe(2);
  expect(result.scenarios.map((scenario: any) => scenario.status)).toEqual(['limited', 'evidence']);
  expect(result.counts).toEqual({ model: 4, mcp: 1, geocode: 1, current: 1, forecast: 0, synthesis: 0 });
  for (const scenario of result.scenarios) {
    expect(scenario.presetId).toBe('dsh-livestream-douyin');
    expect(scenario.toolSchemas).toEqual(['public_search', 'show_stats', 'weather_lookup']);
    expect(scenario.personaChecks).toEqual({ originalQuery: true, sourceTime: true, limited: true, noLongUrl: true });
    expect(scenario.schemaChecks).toEqual({ publicQueryOriginal: true, publicQueryLimit: true, weatherLocation: true });
    expect(scenario.fixtureWire).toEqual({
      toolSchemas: ['public_search', 'show_stats', 'weather_lookup'],
      schemaChecks: { publicQueryOriginal: true, publicQueryLimit: true, weatherLocation: true },
      fixedQuestionPresent: true,
      unforcedToolChoice: true,
      personaChecks: { originalQuery: true, sourceTime: true, limited: true, noLongUrl: true },
    });
  }
  expect(cleanup.homeRemoved).toBe(true);
  expect(cleanup.hardDeadlineTerminated).toBe(false);
});

it('recognizes a zero-synthesis real budget before requiring the model credential', async () => {
  await expect(execFileAsync(process.execPath, [
    'test/live-query/run.mjs', '--real', '--approve=search:2,model:4,tts:0,seconds:300',
  ], { cwd: process.cwd(), env: { PATH: process.env.PATH ?? '' } })).rejects.toMatchObject({
    code: 2,
    stderr: expect.stringContaining('Required credential references are not configured'),
  });
});


it('still requires a voice token for the one-synthesis real budget', async () => {
  await expect(execFileAsync(process.execPath, [
    'test/live-query/run.mjs', '--real', '--approve=search:2,model:4,tts:1,seconds:300',
  ], { cwd: process.cwd(), env: { PATH: process.env.PATH ?? '', GLM_CODING_PLAN_API_KEY: 'fixture-only-key' } })).rejects.toMatchObject({
    code: 2,
    stderr: expect.stringContaining('Required credential references are not configured'),
  });
});
