import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { synthesizeMacos } from '../src/body/macosTts';
import { subtitleTimeline } from '../src/body/tts';

describe.skipIf(process.platform !== 'darwin')('macOS rehearsal speech', () => {
  it('produces a playable MP3 and estimated subtitle timings', async () => {
    const speech = await synthesizeMacos('你好，欢迎来到本地彩排。', AbortSignal.timeout(30_000));
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tts-test-'));
    try {
      const file = join(dir, 'speech.mp3');
      await writeFile(file, speech.audio);
      const codec = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name', '-of', 'default=noprint_wrappers=1:nokey=1', file], { encoding: 'utf8' });
      expect(codec.trim()).toBe('mp3');
      const timeline = subtitleTimeline('你好，欢迎来到本地彩排。', speech.words);
      expect(timeline.at(-1)?.chars).toBe([...('你好，欢迎来到本地彩排。')].length);
      expect(timeline.at(-1)?.atMs).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 40_000);

  it('cancels an in-flight synthesis and removes temporary files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tts-cancel-'));
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = dir;
    try {
      const controller = new AbortController();
      const promise = synthesizeMacos('本地彩排。'.repeat(1000), controller.signal);
      setTimeout(() => controller.abort(), 50);
      await expect(promise).rejects.toThrow();
      expect(await readdir(dir)).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
      await rm(dir, { recursive: true, force: true });
    }
  }, 10_000);
});
