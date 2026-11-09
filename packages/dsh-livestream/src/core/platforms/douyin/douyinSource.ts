import WebSocket from 'ws';
import type { LiveEvent, LiveRoomStats } from '../../live';
import type { LiveSource, LiveSourceListener } from '../source';

export const DOUYIN_CACHE_TTL_MS = 120_000;
export const DOUYIN_CACHE_LIMIT = 4_000;
const MAX_FRAME_BYTES = 1_048_576;
const RECOVERY = '先断开订阅，再显式连接；上游已结束或出错时，请先到采集控制台恢复或停止后重开。';

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
const text = (value: unknown, max: number): string | null => typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
const positiveInteger = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
async function readJsonLimited(response: Response): Promise<unknown> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FRAME_BYTES) {
        await reader.cancel();
        throw new Error('采集状态响应过大');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const validId = (value: unknown): string | null => {
  const id = text(value, 128);
  return id && !/^0+$/.test(id) ? id : null;
};

/** Validate a deployment-owned bridge URL without DNS resolution or redirects. */
export function normalizeDouyinBridgeUrl(value: string): string {
  if (!/^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?\/?$/.test(value)) {
    throw new Error('采集地址必须是本机 HTTP 地址');
  }
  const url = new URL(value);
  if (url.port === '0' || url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('采集地址必须是本机 HTTP 地址');
  }
  return url.origin;
}

/** A single explicitly requested subscription. It never automatically resubscribes. */
export class DouyinLiveSource implements LiveSource {
  readonly platform = 'douyin' as const;
  private listener: LiveSourceListener | null = null;
  private socket: WebSocket | null = null;
  private abort: AbortController | null = null;
  private poll: NodeJS.Timeout | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private pongDeadline: NodeJS.Timeout | null = null;
  private timeout: NodeJS.Timeout | null = null;
  private generation = 0;
  private stateVersion = 0;
  private querying = false;
  private terminal = false;
  private readonly seen = new Map<string, number>();
  private readonly groups = new Map<string, { count: number; observedAt: number; eventId: string }>();
  private groupSequence = 0;
  private readonly origin: string;

  constructor(private readonly roomId: string, bridgeUrl: string) {
    if (!/^[0-9]{1,64}$/.test(roomId)) throw new Error('抖音房间号无效');
    this.origin = normalizeDouyinBridgeUrl(bridgeUrl);
  }

  start(listener: LiveSourceListener): void {
    this.listener = listener;
    this.terminal = false;
    const generation = ++this.generation;
    listener.room({ platform: 'douyin', roomId: this.roomId });
    listener.state('connecting');
    const url = new URL('/ws', this.origin);
    url.protocol = 'ws:';
    url.searchParams.set('roomId', this.roomId);
    const socket = new WebSocket(url, { maxPayload: MAX_FRAME_BYTES, followRedirects: false });
    this.socket = socket;
    socket.on('open', () => {
      if (!this.active(generation)) return;
      void this.query(generation);
      this.poll = setInterval(() => void this.query(generation), 2_000);
      this.heartbeat = setInterval(() => {
        if (!this.active(generation) || socket.readyState !== WebSocket.OPEN) return;
        socket.ping();
        this.pongDeadline = setTimeout(() => this.fail('采集连接心跳超时'), 10_000);
      }, 20_000);
    });
    socket.on('pong', () => {
      if (this.pongDeadline) clearTimeout(this.pongDeadline);
      this.pongDeadline = null;
    });
    socket.on('message', (raw) => {
      if (!this.active(generation)) return;
      try { this.receive(JSON.parse(raw.toString())); } catch { /* Ignore malformed frames. */ }
    });
    socket.on('error', () => { if (this.active(generation)) this.fail('无法连接采集器'); });
    socket.on('close', () => { if (this.active(generation)) this.fail('采集连接已断开'); });
    this.timeout = setTimeout(() => this.fail('等待采集超时'), 45_000);
  }

  stop(): void {
    this.generation++;
    this.terminal = true;
    this.closeTransport();
    this.listener = null;
    this.seen.clear();
    this.groups.clear();
  }

  private active(generation: number): boolean {
    return generation === this.generation && !this.terminal;
  }

  private closeTransport(): void {
    this.abort?.abort();
    this.abort = null;
    if (this.poll) clearInterval(this.poll);
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.pongDeadline) clearTimeout(this.pongDeadline);
    if (this.timeout) clearTimeout(this.timeout);
    this.poll = this.heartbeat = this.pongDeadline = this.timeout = null;
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }

  private fail(reason: string): void {
    if (this.terminal) return;
    this.terminal = true;
    this.generation++;
    this.closeTransport();
    this.listener?.stats({ online: undefined, watched: undefined, likes: undefined, live: false });
    this.listener?.state('error', { error: `${reason}。${RECOVERY}` });
  }

  private async query(generation: number): Promise<void> {
    if (!this.active(generation) || this.querying) return;
    this.querying = true;
    const sequence = this.stateVersion;
    const controller = new AbortController();
    this.abort = controller;
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch(new URL(`/api/rooms/${this.roomId}`, this.origin), {
        redirect: 'error', signal: controller.signal,
      });
      if (!response.ok) return;
      const body = object(await readJsonLimited(response));
      if (this.active(generation) && sequence === this.stateVersion) this.roomState(object(body?.room));
    } catch {
      // The socket and bounded connection deadline determine transport failure.
    } finally {
      clearTimeout(timer);
      if (this.abort === controller) this.abort = null;
      this.querying = false;
    }
  }

  private roomState(room: JsonObject | null): void {
    if (!room || room.roomId !== this.roomId) return;
    const status = room.status;
    if (status === 'live') {
      if (this.timeout) clearTimeout(this.timeout);
      this.timeout = null;
      if (this.poll) clearInterval(this.poll);
      this.poll = null;
      this.listener?.stats({ live: true });
      this.listener?.state('connected');
      return;
    }
    const progress = object(room.progress);
    if (status === 'closed' || status === 'error' || status === 'stopped' || progress?.step === 'error') {
      const error = text(room.error, 500) ?? text(room.message, 500) ?? text(progress?.message, 500) ?? '采集已停止或出错';
      this.fail(error);
    } else if (status === 'connecting') {
      this.listener?.state('connecting');
    }
  }

  private receive(value: unknown): void {
    const frame = object(value);
    if (!frame || frame.roomId !== this.roomId) return;
    if (frame.type === '__connected') {
      this.stateVersion++;
      this.roomState(object(frame.room));
      return;
    }
    if (frame.type === '__error') {
      this.stateVersion++;
      this.fail(text(frame.error, 500) ?? '采集出错');
      return;
    }
    if (typeof frame.type !== 'string' || frame.type.startsWith('__')) return;
    if (frame.platform !== 'douyin' || !text(frame.id, 128)
      || typeof frame.ts !== 'number' || !Number.isFinite(frame.ts) || frame.ts <= 0) return;
    const data = object(frame.data);
    if (!data) return;
    if (frame.type === 'roomStatus') {
      this.stateVersion++;
      this.roomState({ ...data, roomId: this.roomId });
      return;
    }
    const userData = object(frame.user);
    if (frame.user !== undefined && !userData) return;
    if (userData?.id !== undefined && !text(userData.id, 128)) return;
    if (userData?.nickname !== undefined && typeof userData.nickname !== 'string') return;
    if (typeof userData?.nickname === 'string' && userData.nickname.length > 200) return;
    const now = Date.now();
    this.prune(now);
    const id = frame.id as string;
    if (this.seen.has(id)) return;
    this.seen.set(id, now);
    while (this.seen.size > DOUYIN_CACHE_LIMIT) this.seen.delete(this.seen.keys().next().value!);
    const userId = userData?.id === undefined ? '' : text(userData.id, 128);
    const name = text(userData?.nickname, 200);
    const user = { id: userId ?? '', name: name ?? '观众' };
    const base = { id, platform: 'douyin' as const, ts: now, user };
    let event: LiveEvent | undefined;
    if (frame.type === 'chat') {
      const content = text(data.content, 2000);
      if (content && userId !== null) event = { ...base, kind: 'chat', text: content };
    } else if (frame.type === 'member' || frame.type === 'follow') {
      if (userId !== null) event = { ...base, kind: frame.type === 'member' ? 'enter' : 'follow' };
    } else if (frame.type === 'like') {
      const stats: Partial<LiveRoomStats> = { likes: positiveInteger(data.total) };
      this.listener?.stats(stats);
      if (userId && positiveInteger(data.count)) event = { ...base, kind: 'like' };
    } else if (frame.type === 'room') {
      this.listener?.stats({ online: positiveInteger(data.total), watched: positiveInteger(data.totalUser) });
    } else if (frame.type === 'gift') {
      const giftId = validId(data.giftId);
      const giftName = text(data.giftName, 200);
      const count = positiveInteger(data.repeatCount);
      const groupId = validId(data.groupId);
      if (!giftId || !giftName || !count || !userId || (!groupId && data.combo !== false)) return;
      const key = JSON.stringify([this.roomId, userId, giftId, groupId ?? id]);
      const previous = this.groups.get(key);
      const delta = count - (previous?.count ?? 0);
      if (delta <= 0) return;
      const eventId = previous?.eventId ?? `${key}:${++this.groupSequence}`;
      this.groups.delete(key);
      this.groups.set(key, { count, observedAt: now, eventId });
      while (this.groups.size > DOUYIN_CACHE_LIMIT) this.groups.delete(this.groups.keys().next().value!);
      event = { ...base, id: eventId, kind: 'gift', giftName, count: delta, valueYuan: 0, valueKnown: false };
    }
    if (event) this.listener?.event(event);
  }

  private prune(now: number): void {
    for (const [id, observedAt] of this.seen) {
      if (now - observedAt > DOUYIN_CACHE_TTL_MS) this.seen.delete(id);
    }
    for (const [id, group] of this.groups) {
      if (now - group.observedAt > DOUYIN_CACHE_TTL_MS) this.groups.delete(id);
    }
    while (this.seen.size > DOUYIN_CACHE_LIMIT) this.seen.delete(this.seen.keys().next().value!);
    while (this.groups.size > DOUYIN_CACHE_LIMIT) this.groups.delete(this.groups.keys().next().value!);
  }
}
