import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runAcceptance } from './scenario';

const controller = new AbortController();
process.on('SIGTERM', () => controller.abort());
process.on('SIGINT', () => controller.abort());
const mode = process.env.DSH_ACCEPTANCE_MODE === 'real' ? 'real' : 'offline';
const result = await runAcceptance({
  mode,
  signal: controller.signal,
  dshHome: process.env.DSH_HOME!,
  audioDir: process.env.DSH_ACCEPTANCE_ARTIFACT_DIR!,
  weatherCacheFile: process.env.DSH_ACCEPTANCE_WEATHER_CACHE_FILE!,
  geocoderUrl: process.env.DSH_LIVESTREAM_WEATHER_GEOCODER_URL,
  deadlineMs: Math.max(0, Number(process.env.DSH_ACCEPTANCE_DEADLINE) - Date.now()),
  modelKey: mode === 'real' ? process.env.GLM_CODING_PLAN_API_KEY! : 'offline-fixture',
  ttsBudget: process.env.DSH_ACCEPTANCE_TTS_BUDGET === '1' ? 1 : 0,
  ...(mode === 'real' && process.env.DSH_ACCEPTANCE_TTS_BUDGET === '1'
    ? { ttsToken: process.env.YOVOICE_API_TOKEN! } : {}),
});
await writeFile(join(process.env.DSH_ACCEPTANCE_ARTIFACT_DIR!, 'result.json'), JSON.stringify(result), { flag: 'wx', mode: 0o600 });
if (result.failure) process.exitCode = 1;
