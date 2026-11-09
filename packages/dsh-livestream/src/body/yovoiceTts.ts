import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { encodeSpeech } from './audioProcess';
import type { Speech } from './tts';

const DEFAULT_VOICE = '年轻温暖的中文女声，自然亲切，像和朋友聊天，咬字清楚，语气轻松活泼';
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'timed_out']);
const REQUEST_TIMEOUT_MS = 10_000;
const CLEANUP_TIMEOUT_MS = 20_000;
const POLL_MS = 250;
const MAX_AUDIO_BYTES = 64 * 1024 * 1024;

type Job = { requestId: string; status: string; downloadPath?: string };
type QueueEntry = { signal: AbortSignal; start: () => void; reject: (reason: unknown) => void; abort: () => void };

export class YovoiceClient {
  private readonly base: URL;
  private queue: QueueEntry[] = [];
  private active = false;
  private blocked = false;

  constructor(url: string, private readonly token: string, private readonly model = 'voxcpm2-q8', private readonly voice = DEFAULT_VOICE) {
    if (!url || !token) throw new Error('yovoice 需要 YOVOICE_URL 和 YOVOICE_API_TOKEN');
    try {
      this.base = new URL(url);
      if (!['http:', 'https:'].includes(this.base.protocol) || this.base.username || this.base.password || this.base.search || this.base.hash || this.base.pathname !== '/') throw new Error();
    } catch {
      throw new Error('YOVOICE_URL 必须是没有路径或凭据的 HTTP(S) 地址');
    }
  }

  synthesize(text: string, signal: AbortSignal): Promise<Speech> {
    if (signal.aborted) return Promise.reject(signal.reason);
    signal = AbortSignal.any([signal, AbortSignal.timeout(90_000)]);
    return new Promise((resolve, reject) => {
      const entry: QueueEntry = {
        signal,
        reject,
        abort: () => {
          this.queue = this.queue.filter((item) => item !== entry);
          reject(signal.reason);
        },
        start: () => {
          void this.runJob(text, signal).then(resolve, reject).finally(() => {
            this.active = false;
            this.drain();
          });
        },
      };
      signal.addEventListener('abort', entry.abort, { once: true });
      this.queue.push(entry);
      this.drain();
    });
  }

  private drain(): void {
    if (this.active) return;
    while (this.queue.length) {
      const entry = this.queue.shift()!;
      entry.signal.removeEventListener('abort', entry.abort);
      if (entry.signal.aborted) { entry.reject(entry.signal.reason); continue; }
      if (this.blocked) { entry.reject(new Error('yovoice 上一个任务的终态无法确认，已停止提交新任务')); continue; }
      this.active = true;
      entry.start();
      return;
    }
  }

  private async request(path: string, method: string, signal: AbortSignal, body?: unknown): Promise<Response> {
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
    try {
      return await fetch(new URL(path, this.base), {
        method,
        headers: { Authorization: `Bearer ${this.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        signal: requestSignal,
      });
    } catch {
      if (signal.aborted) throw signal.reason;
      throw new Error(`yovoice ${method} 请求失败或超时`);
    }
  }

  private async bytes(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
    if (Number(response.headers.get('content-length')) > limit) throw new Error('yovoice 响应过大');
    if (!response.body) throw new Error('yovoice 响应为空');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > limit) throw new Error('yovoice 响应过大');
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return Buffer.concat(chunks);
  }

  private async job(response: Response, id: string, signal: AbortSignal): Promise<Job> {
    if (!response.ok) throw new Error(`yovoice 任务请求失败 (HTTP ${response.status})`);
    let result: Job;
    try { result = JSON.parse(new TextDecoder().decode(await this.bytes(response, 64 * 1024, signal))) as Job; }
    catch { throw new Error('yovoice 任务响应无效'); }
    if (result.requestId !== id || !['running', ...TERMINAL].includes(result.status)) throw new Error('yovoice 任务响应无效');
    return result;
  }

  private async cancelAndConfirm(path: string, id: string): Promise<boolean> {
    const signal = AbortSignal.timeout(CLEANUP_TIMEOUT_MS);
    try {
      let response = await this.request(path, 'DELETE', signal);
      if (response.status === 404) return false;
      let result = await this.job(response, id, signal);
      while (!TERMINAL.has(result.status)) {
        await delay(POLL_MS, undefined, { signal });
        response = await this.request(path, 'GET', signal);
        result = await this.job(response, id, signal);
      }
      return true;
    } catch {
      return false;
    }
  }

  private async runJob(text: string, signal: AbortSignal): Promise<Speech> {
    const id = randomBytes(16).toString('hex');
    const path = `/v1/jobs/${id}`;
    let mayExist = false;
    let terminal = false;
    try {
      signal.throwIfAborted();
      // 提交不使用调用者的取消信号：等提交结果确定后再取消服务端任务。
      mayExist = true;
      const response = await this.request(path, 'PUT', AbortSignal.timeout(REQUEST_TIMEOUT_MS), {
        text, modelId: this.model, voxMode: 'design', voiceDescription: this.voice, seed: 42,
      });
      if (response.status >= 400 && response.status < 500) mayExist = false;
      let result = await this.job(response, id, signal);
      terminal = TERMINAL.has(result.status);
      signal.throwIfAborted();
      while (!terminal) {
        await delay(POLL_MS, undefined, { signal });
        result = await this.job(await this.request(path, 'GET', signal), id, signal);
        terminal = TERMINAL.has(result.status);
      }
      if (result.status !== 'completed') throw new Error(`yovoice 任务结束: ${result.status}`);
      if (!result.downloadPath || !/^\/v1\/audio\/[A-Za-z0-9_-]+$/.test(result.downloadPath)) throw new Error('yovoice 音频下载地址无效');
      const audioSignal = AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
      const audioResponse = await this.request(result.downloadPath, 'GET', audioSignal);
      if (!audioResponse.ok) throw new Error(`yovoice 音频下载失败 (HTTP ${audioResponse.status})`);
      const wav = await this.bytes(audioResponse, MAX_AUDIO_BYTES, audioSignal);
      const dir = await mkdtemp(join(tmpdir(), 'dsh-yovoice-tts-'));
      try {
        const input = join(dir, 'speech.wav');
        await writeFile(input, wav);
        return await encodeSpeech(input, join(dir, 'speech.mp3'), text, signal);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } catch (error) {
      if (mayExist && !terminal && !(await this.cancelAndConfirm(path, id))) this.blocked = true;
      throw error;
    }
  }
}

let client: YovoiceClient | undefined;
export function synthesizeYovoice(text: string, signal: AbortSignal): Promise<Speech> {
  client ??= new YovoiceClient(
    process.env.YOVOICE_URL ?? '',
    process.env.YOVOICE_API_TOKEN ?? '',
    process.env.DSH_LIVESTREAM_YOVOICE_MODEL?.trim() || 'voxcpm2-q8',
    process.env.DSH_LIVESTREAM_YOVOICE_VOICE?.trim() || DEFAULT_VOICE,
  );
  return client.synthesize(text, signal);
}
