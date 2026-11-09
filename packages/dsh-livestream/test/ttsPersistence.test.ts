import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const errors = vi.hoisted(() => ({ write: false, rename: false }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (errors.write) throw new Error('injected write failure');
      return actual.writeFileSync(...args);
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (errors.rename) throw new Error('injected rename failure');
      return actual.renameSync(...args);
    },
  };
});

describe('atomic settings persistence', () => {
  let dir: string;
  let file: string;
  let runtime: typeof import('../src/dsh/runtime');
  const previous = { ...process.env };
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-voice-save-'));
    process.env.DSH_HOME = dir;
    const data = join(dir, 'dsh-livestream');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(data));
    file = join(data, 'settings.json');
    await writeFile(file, JSON.stringify({ stageToken: 'test', voice: 'legacy', unknownField: 'preserved' }));
    runtime = await import('../src/dsh/runtime');
  });
  afterAll(async () => {
    process.env = previous;
    await rm(dir, { recursive: true, force: true });
  });
  it('preserves unknown fields and legacy voice when saving', async () => {
    expect(runtime.settings.tts.doubaoVoice).toBe('legacy');
    runtime.updateSettings({ tts: { ...runtime.settings.tts, doubaoRate: 5 } });
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ unknownField: 'preserved', voice: 'legacy', tts: { doubaoRate: 5 } });
  });
  it.each(['write', 'rename'] as const)('keeps file and memory unchanged after %s failure', async (failure) => {
    const before = await readFile(file, 'utf8');
    errors[failure] = true;
    try {
      expect(() => runtime.updateSettings({ tts: { ...runtime.settings.tts, doubaoRate: 9 } })).toThrow();
    } finally {
      errors[failure] = false;
    }
    expect(runtime.settings.tts.doubaoRate).toBe(5);
    expect(await readFile(file, 'utf8')).toBe(before);
  });
});
