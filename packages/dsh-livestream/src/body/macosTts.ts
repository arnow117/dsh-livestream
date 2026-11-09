/** Local macOS speech for rehearsals. No shell is involved in handling text. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Speech } from './tts';
import { encodeSpeech, runAudioProcess } from './audioProcess';

export async function synthesizeMacos(text: string, signal: AbortSignal, voice = process.env.DSH_LIVESTREAM_MACOS_VOICE?.trim() || 'Tingting'): Promise<Speech> {
  signal.throwIfAborted();
  const dir = await mkdtemp(join(tmpdir(), 'dsh-livestream-tts-'));
  const input = join(dir, 'input.txt');
  const aiff = join(dir, 'speech.aiff');
  const mp3 = join(dir, 'speech.mp3');
  try {
    await writeFile(input, text, 'utf8');
    await runAudioProcess('/usr/bin/say', ['-v', voice, '-f', input, '-o', aiff], signal);
    return await encodeSpeech(aiff, mp3, text, signal);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
