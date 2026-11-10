import { randomBytes } from 'node:crypto';
import { uptime } from 'node:os';
import { normalizeDouyinBridgeUrl } from '../core/platforms/douyin/douyinSource';
import type { RoomControlSnapshot } from '../shared/roomControl';
import { DouyinControlJournal, type AdmittedMarker } from './douyinControlJournal';

const QUERY_TIMEOUT_MS = 5_000;
const MUTATION_TIMEOUT_MS = 60_000;
const WS_TIMEOUT_MS = 45_000;
const DISPATCH_WINDOW_MS = 5_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_ACCOUNTS = 256;
const ACCOUNT_PREFIX = 'dsh-livestream-anonymous-';
const BRIDGE_VERSION = 'dyhub-0.3.1-3a79c57d85c59289db3b77211b3ec01fae47d42c';
const COLLECTOR_STATES = new Set(['connecting', 'live', 'closed', 'error', 'stopped']);

type CollectorState = RoomControlSnapshot['collector'];
type JsonObject = Record<string, unknown>;
type Account = { id: string; name: string; hasCookie: false; hasLogin: false };
type Room = { roomId: string; status: Exclude<CollectorState, 'unknown' | 'missing'>; startedAt: number | null };
type Clock = { wall: () => number; monotonic: () => number; uptime: () => number };
type BridgeEpoch = { requestStart: number; responseEnd: number; uptimeSec: number; min: number; max: number; hostBootTime: number };
type Journal = Pick<DouyinControlJournal, 'marker' | 'corrupt' | 'write' | 'clear'>;
const object = (value: unknown): JsonObject | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;

async function readLimited(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('采集服务返回空响应');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('采集服务响应过大');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  const pending: { value: unknown; depth: number }[] = [{ value: parsed, depth: 0 }];
  while (pending.length) {
    const current = pending.pop()!;
    if (current.depth > 12) throw new Error('采集服务响应层级过深');
    if (typeof current.value === 'string' && current.value.length > 8_192) throw new Error('采集服务响应字段过长');
    if (current.value && typeof current.value === 'object') {
      const entries = Object.entries(current.value);
      if (entries.length > 512 || entries.some(([key]) => key.length > 256)) throw new Error('采集服务响应字段过多');
      for (const [, value] of entries) pending.push({ value, depth: current.depth + 1 });
    }
  }
  return parsed;
}

export class DouyinRoomControl {
  private readonly nonce = randomBytes(16).toString('hex');
  private counter = 0;
  private generation = 0;
  private disposed = false;
  private readonly cancellations = new Set<() => void>();
  private running = false;
  private activeOperation: { type: 'connect' | 'stop'; target: string } | null = null;
  private error: string | undefined;
  private readonly journal: Journal;
  private readonly clock: Clock;
  private readonly fetcher: typeof fetch;

  constructor(dataDir: string, options: { journal?: Journal; clock?: Clock; fetcher?: typeof fetch } = {}) {
    this.journal = options.journal ?? new DouyinControlJournal(dataDir);
    this.clock = options.clock ?? { wall: () => Date.now(), monotonic: () => performance.now(), uptime };
    this.fetcher = options.fetcher ?? ((...args) => fetch(...args));
  }

  get revision(): string { return `${this.nonce}:${this.counter}`; }
  get locked(): boolean { return this.running || this.journal.corrupt || !!this.journal.marker; }
  get hasJournal(): boolean { return this.journal.corrupt || !!this.journal.marker; }
  get operation(): RoomControlSnapshot['operation'] {
    const marker = this.journal.marker;
    if (this.running) return { state: 'running', ...(this.activeOperation ?? {}), ...(marker ? { opId: marker.opId } : {}) };
    if (this.journal.corrupt || this.journal.marker) {
      return {
        state: 'unknown',
        ...(marker ? { opId: marker.opId, type: marker.type, target: marker.roomId } : {}),
        error: this.error ?? '上次采集操作结果未确认，请检查采集服务后刷新状态。',
        recoveryHint: '结果未确认时不能重复启动或停止；检查服务后刷新状态。',
      };
    }
    return { state: 'idle', ...(this.error ? { error: this.error } : {}) };
  }

  matches(expected: unknown): boolean { return expected === undefined || expected === this.revision; }
  advance(): void { this.counter += 1; }
  detach(): void { this.generation += 1; this.advance(); }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    for (const cancel of this.cancellations) cancel();
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('直播插件已卸载');
  }

  private ownsMarker(marker: AdmittedMarker): boolean {
    return !this.disposed && !this.running && this.journal.marker === marker;
  }

  private wait<T>(work: () => Promise<T>, timeoutMs: number, timeoutMessage: string, abort?: AbortController): Promise<T> {
    this.assertActive();
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (complete: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.cancellations.delete(cancel);
        complete();
      };
      const cancel = () => {
        abort?.abort();
        finish(() => reject(new Error('直播插件已卸载')));
      };
      const timer = setTimeout(() => {
        abort?.abort();
        finish(() => reject(new Error(timeoutMessage)));
      }, timeoutMs);
      this.cancellations.add(cancel);
      try {
        this.assertActive();
        work().then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)));
      } catch (error) {
        finish(() => reject(error));
      }
    });
  }

  private origin(): string {
    return normalizeDouyinBridgeUrl(process.env.DSH_LIVESTREAM_DOUYIN_BRIDGE_URL ?? 'http://127.0.0.1:8757');
  }

  private async request(origin: string, path: string, data?: unknown): Promise<{ status: number; value: unknown }> {
    const abort = new AbortController();
    try {
      const work = async () => {
        const response = await this.fetcher(new URL(path, origin), {
          redirect: 'error', signal: abort.signal,
          ...(data === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }),
        });
        this.assertActive();
        return { status: response.status, value: await readLimited(response) };
      };
      return await this.wait(work, data === undefined ? QUERY_TIMEOUT_MS : MUTATION_TIMEOUT_MS, 'request timed out', abort);
    } catch {
      this.assertActive();
      throw new Error('采集服务请求失败或超时，请检查服务状态');
    }
  }

  private async room(origin: string, roomId: string): Promise<Room | null> {
    const response = await this.request(origin, `/api/rooms/${roomId}`);
    if (response.status === 404) return null;
    const value = object(response.value);
    const room = object(value?.room);
    if (response.status !== 200 || !room || room.roomId !== roomId || typeof room.status !== 'string' || !COLLECTOR_STATES.has(room.status)) {
      throw new Error('采集服务返回的房间状态无效');
    }
    const startedAt = room.startedAt;
    if (startedAt !== undefined && (typeof startedAt !== 'number' || !Number.isSafeInteger(startedAt) || startedAt <= 0)) {
      throw new Error('采集服务返回的房间状态无效');
    }
    return { roomId, status: room.status as Room['status'], startedAt: typeof startedAt === 'number' ? startedAt : null };
  }

  private async accounts(origin: string): Promise<Account[]> {
    const response = await this.request(origin, '/api/accounts');
    const accounts = object(response.value)?.accounts;
    if (response.status !== 200 || !Array.isArray(accounts) || accounts.length > MAX_ACCOUNTS) throw new Error('无法确认匿名采集账号，请使用独立匿名采集目录');
    return accounts.map((value) => {
      const account = object(value);
      if (!account || typeof account.id !== 'string' || !account.id || account.id.length > 128
        || typeof account.name !== 'string' || account.name.length > 128 || account.hasCookie !== false || account.hasLogin !== false) {
        throw new Error('采集目录含登录账号或账号状态未知，请使用独立匿名采集目录');
      }
      return { id: account.id, name: account.name, hasCookie: false, hasLogin: false };
    });
  }

  private async bridgeEpoch(origin: string): Promise<BridgeEpoch | null> {
    const start = { wall: this.clock.wall(), monotonic: this.clock.monotonic() };
    try {
      const response = await this.request(origin, '/api/stats');
      const seconds = object(response.value)?.uptimeSec;
      const end = this.clock.wall();
      const systemUptime = this.clock.uptime();
      if (response.status !== 200 || typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds < 0
        || !Number.isFinite(systemUptime) || systemUptime < 0 || end < start.wall || !this.clockContinuous(start)) return null;
      return {
        requestStart: start.wall,
        responseEnd: end,
        uptimeSec: seconds,
        min: Math.floor(start.wall - (seconds + 1) * 1_000),
        max: Math.ceil(end - seconds * 1_000),
        hostBootTime: Math.round(end - systemUptime * 1_000),
      };
    } catch {
      return null;
    }
  }

  private marker(type: AdmittedMarker['type'], phase: AdmittedMarker['phase'], origin: string, roomId: string, preflight: Room | null, accounts: Account[], accountName: string | null, epoch: BridgeEpoch | null): AdmittedMarker {
    const now = this.clock.wall();
    return {
      schemaVersion: 1, opId: randomBytes(16).toString('hex'), type, phase, settled: false, roomId, revision: this.revision, origin,
      admittedAt: now, dispatchNotAfter: now + DISPATCH_WINDOW_MS,
      activeUntil: now + DISPATCH_WINDOW_MS + MUTATION_TIMEOUT_MS + WS_TIMEOUT_MS,
      preflightStartedAt: preflight?.startedAt ?? null,
      preflightMissing: preflight === null,
      bridgeVersion: BRIDGE_VERSION,
      bridgeRequestStart: epoch?.requestStart ?? null,
      bridgeResponseEnd: epoch?.responseEnd ?? null,
      bridgeUptimeSec: epoch?.uptimeSec ?? null,
      bridgeStartMin: epoch?.min ?? null,
      bridgeStartMax: epoch?.max ?? null,
      hostBootTime: epoch?.hostBootTime ?? null,
      accountName, accountIds: accounts.map((account) => account.id),
    };
  }

  private clockContinuous(start: { wall: number; monotonic: number }): boolean {
    const elapsed = this.clock.monotonic() - start.monotonic;
    return elapsed >= 0 && Math.abs((this.clock.wall() - start.wall) - elapsed) <= 1_000;
  }

  private async dispatch(marker: AdmittedMarker, path: string, data: unknown, start: { wall: number; monotonic: number }): Promise<{ status: number; value: unknown }> {
    this.assertActive();
    if (!this.clockContinuous(start)) throw new Error('系统时间变化，无法安全发送采集操作');
    this.journal.write(marker);
    if (this.clock.wall() > marker.dispatchNotAfter || !this.clockContinuous(start)) {
      this.journal.clear();
      throw new Error('采集操作发送时限已过，请重试');
    }
    return this.request(marker.origin, path, data);
  }

  async query(roomId: string): Promise<{ bridge: RoomControlSnapshot['bridge']; collector: CollectorState }> {
    try {
      this.assertActive();
      const marker = this.journal.marker;
      let origin: string | null = null;
      try { origin = this.origin(); } catch { /* The persisted origin remains the only safe read target. */ }
      if (!this.running && marker && marker.origin !== origin) {
        // Inspect the original target only. A changed deployment cannot establish
        // that the old operation settled, so this observation never unlocks it.
        if (marker.type === 'account') await this.accounts(marker.origin);
        else await this.room(marker.origin, marker.roomId);
      }
      if (!origin) return { bridge: 'offline', collector: 'unknown' };
      if (!this.running && marker && marker.origin === origin) {
        if (marker.settled && this.ownsMarker(marker)) {
          this.journal.clear();
        } else if (marker.type === 'account' && marker.accountName) {
          const accounts = await this.accounts(origin);
          const created = accounts.find((account) => account.name === marker.accountName && !marker.accountIds.includes(account.id));
          if (created && this.ownsMarker(marker)) this.journal.clear();
        } else if (marker.type === 'connect' && marker.phase === 'http') {
          const observed = await this.room(origin, marker.roomId);
          const isNew = observed?.startedAt && (marker.preflightMissing
            || (marker.preflightStartedAt !== null && observed.startedAt > marker.preflightStartedAt));
          if (isNew && this.ownsMarker(marker)) this.journal.clear();
        }
        // Uptime is derived from the bridge wall clock. Endpoint samples cannot
        // establish that clock stayed continuous while this process was down.
        // Without that proof a restart observation cannot clear this marker.
      }
      if (!roomId) {
        const response = await this.request(origin, '/api/stats');
        const uptime = object(response.value)?.uptimeSec;
        if (response.status !== 200 || typeof uptime !== 'number' || !Number.isFinite(uptime) || uptime < 0) throw new Error('invalid stats');
        return { bridge: 'online', collector: 'unknown' };
      }
      const room = await this.room(origin, roomId);
      return { bridge: 'online', collector: room?.status ?? 'missing' };
    } catch {
      return { bridge: 'offline', collector: 'unknown' };
    }
  }

  async connect(roomId: string, subscribe: (origin: string) => Promise<'connected' | 'error'>): Promise<void> {
    this.assertActive();
    if (this.locked) throw new Error('采集操作尚未确认，不能再次连接');
    this.running = true;
    this.activeOperation = { type: 'connect', target: roomId };
    this.error = undefined;
    const start = { wall: this.clock.wall(), monotonic: this.clock.monotonic() };
    const generation = ++this.generation;
    this.advance();
    try {
      const origin = this.origin();
      const epoch = await this.bridgeEpoch(origin);
      const preflight = await this.room(origin, roomId);
      let accounts = await this.accounts(origin);
      if (generation !== this.generation) return;
      const requiresStart = !preflight || !['live', 'connecting'].includes(preflight.status);
      let account = accounts.find((item) => item.name.startsWith(ACCOUNT_PREFIX));
      if (!account && (requiresStart || accounts.length === 0)) {
        const name = `${ACCOUNT_PREFIX}${randomBytes(12).toString('hex')}`;
        const marker = this.marker('account', 'account', origin, roomId, preflight, accounts, name, epoch);
        const response = await this.dispatch(marker, '/api/accounts', { name }, start);
        this.assertActive();
        const created = object(object(response.value)?.account);
        if (response.status !== 200 || object(response.value)?.ok !== true || !created || created.name !== name
          || typeof created.id !== 'string' || !created.id || created.id.length > 128
          || accounts.some((existing) => existing.id === created.id) || created.hasCookie !== false || created.hasLogin !== false) {
          throw new Error('创建匿名账号的结果未确认');
        }
        this.journal.clear();
        accounts = await this.accounts(origin);
        account = accounts.find((item) => item.id === created.id && item.name === name);
        if (!account) throw new Error('无法确认匿名采集账号，请使用独立匿名采集目录');
      }
      if (generation !== this.generation) return;
      if (requiresStart) {
        if (!account) throw new Error('无法确认匿名采集账号，请使用独立匿名采集目录');
        const marker = this.marker('connect', 'http', origin, roomId, preflight, accounts, null, epoch);
        const response = await this.dispatch(marker, '/api/rooms/connect', { roomId, accountId: account.id }, start);
        this.assertActive();
        const result = object(response.value);
        const handlerError = [400, 409, 500].includes(response.status) && result
          && Object.keys(result).length === 1 && typeof result.error === 'string'
          && result.error.length > 0 && result.error.length <= 500;
        if (handlerError) {
          this.journal.clear();
          throw new Error('采集服务未能连接该房间，请检查状态后重试');
        }
        const room = object(result?.room);
        if (response.status !== 200 || result?.ok !== true || !room || room.roomId !== roomId
          || typeof room.status !== 'string' || !COLLECTOR_STATES.has(room.status)) throw new Error('连接采集的结果未确认');
        if (!['live', 'connecting'].includes(room.status)) {
          this.journal.clear();
          throw new Error('直播间已结束或采集出错，请检查后重试');
        }
        if (generation !== this.generation) {
          this.journal.clear();
          return;
        }
      }
      accounts = await this.accounts(origin);
      this.assertActive();
      if (generation !== this.generation) {
        if (this.journal.marker) this.journal.clear();
        return;
      }
      const marker = this.marker('connect', 'ws', origin, roomId, preflight, accounts, null, epoch);
      const previous = this.journal.marker;
      if (previous?.type === 'connect' && previous.phase === 'http') {
        marker.opId = previous.opId;
        marker.admittedAt = previous.admittedAt;
      }
      if (!this.clockContinuous(start)) throw new Error('系统时间变化，无法安全建立订阅');
      this.journal.write(marker);
      if (this.clock.wall() > marker.dispatchNotAfter || !this.clockContinuous(start)) {
        this.journal.clear();
        throw new Error('采集操作发送时限已过，请重试');
      }
      const initialized = await this.wait(() => subscribe(origin), WS_TIMEOUT_MS, '采集订阅初始化结果未确认');
      this.assertActive();
      this.journal.clear();
      if (initialized === 'error') throw new Error('采集订阅初始化失败，请检查后重试');
    } catch (error) {
      if (!this.disposed) this.error = (error as Error).message;
      throw error;
    } finally {
      if (!this.disposed) {
        this.running = false;
        this.activeOperation = null;
      }
    }
  }

  async stop(roomId: string): Promise<void> {
    this.assertActive();
    if (this.locked) throw new Error('采集操作尚未确认，不能停止');
    this.running = true;
    this.activeOperation = { type: 'stop', target: roomId };
    this.error = undefined;
    const start = { wall: this.clock.wall(), monotonic: this.clock.monotonic() };
    this.advance();
    try {
      const origin = this.origin();
      const epoch = await this.bridgeEpoch(origin);
      const marker = this.marker('stop', 'stop', origin, roomId, null, [], null, epoch);
      const response = await this.dispatch(marker, `/api/rooms/${roomId}/disconnect`, {}, start);
      this.assertActive();
      if (response.status !== 200 || object(response.value)?.ok !== true) throw new Error('停止采集的结果未确认');
      this.journal.clear();
    } catch (error) {
      if (!this.disposed) this.error = (error as Error).message;
      throw error;
    } finally {
      if (!this.disposed) {
        this.running = false;
        this.activeOperation = null;
      }
    }
  }
}
