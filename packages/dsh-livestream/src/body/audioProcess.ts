import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import type { Speech } from './tts';

const PROCESS_TIMEOUT_MS = 60_000;

export async function runAudioProcess(command: string, args: string[], signal: AbortSignal): Promise<string> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(PROCESS_TIMEOUT_MS)]);
  deadline.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let killTimer: NodeJS.Timeout | undefined;
    child.stdout.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(0, 4096); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4096); });
    const abort = () => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
      killTimer.unref();
    };
    deadline.addEventListener('abort', abort, { once: true });
    if (deadline.aborted) abort();
    let spawnError: Error | undefined;
    child.on('error', (error) => { spawnError = error; });
    child.on('close', (code) => {
      deadline.removeEventListener('abort', abort);
      if (killTimer) clearTimeout(killTimer);
      if (deadline.aborted) reject(deadline.reason);
      else if (spawnError) reject(spawnError);
      else if (code !== 0) reject(new Error(`${command} failed (${code}): ${stderr.trim()}`));
      else resolve(stdout);
    });
  });
}

export async function encodeSpeech(input: string, mp3: string, text: string, signal: AbortSignal): Promise<Speech> {
  await runAudioProcess('ffmpeg', ['-nostdin', '-v', 'error', '-i', input, '-codec:a', 'libmp3lame', '-y', mp3], signal);
  const durationText = await runAudioProcess('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', mp3], signal);
  const duration = Number(durationText.trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('ffprobe returned an invalid speech duration');
  const chars = [...text];
  const words = chars.map((word, i) => ({ word, start: duration * i / chars.length, end: duration * (i + 1) / chars.length }));
  signal.throwIfAborted();
  return { audio: new Uint8Array(await readFile(mp3)), words };
}
