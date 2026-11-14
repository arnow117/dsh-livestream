/**
 * 直播间事件中枢（弹幕姬的核心）：持有当前平台连接，把事件整理后分发给
 *   - 弹幕姬窗口（批量推送，见 onUpdate）
 *   - 主进程内的消费者（AI 互动等，见 subscribe）
 *
 * 整理规则：
 * - 同 id 只处理一次（重连后平台可能重发）；礼物连击共用 id，后到的累加到第一条上并以同 id 再推一次。
 * - 进场 / 点赞量大（2000 在线的房间约每分钟 90 次进场），推给窗口时每批只留最后几条，总量看 perMinute。
 */

import type {
  LiveConnection,
  LiveConnectionState,
  LiveEvent,
  LiveEventKind,
  LiveGiftEvent,
  LiveRoomInfo,
  LiveRoomStats,
  LiveStatus,
  LiveUpdate,
} from './live';
import { createLiveSource, type LiveSource } from './platforms';
import { DOUYIN_CACHE_LIMIT, DOUYIN_CACHE_TTL_MS, DouyinLiveSource } from './platforms/douyin/douyinSource';
import { markTrustedInternalIngress } from './attention/topics';
import { readSourceIngress, type SourceIngress } from '../publicChat/sourceIngress';

const RECENT_LIMIT = 300;
const SEEN_LIMIT = 4000;
const RATE_WINDOW_MS = 60_000;
/** 连击超过这么久没有新的一下，就算一次新的送礼 */
const GIFT_COMBO_MS = 30_000;
const FLUSH_MS = 150;
const AMBIENT_PER_FLUSH = 5;

const AMBIENT_KINDS: ReadonlySet<LiveEventKind> = new Set(['enter', 'like']);

export type LiveEventListener = (event: LiveEvent, isUpdate: boolean) => void;
/** 连接状态订阅（FEAT-DSH-004）：同步回调，携带来源报告的新状态与原状态。 */
export type LiveStateListener = (state: LiveConnectionState, previous: LiveConnectionState) => void;

export class LiveHub {
  private source: LiveSource | null = null;
  private config: LiveConnection | null = null;
  private state: LiveConnectionState = 'idle';
  private room: LiveRoomInfo | undefined;
  private stats: LiveRoomStats = {};
  private loggedIn = false;
  private connectedAt: number | undefined;
  private lastError: string | undefined;

  private recent: LiveEvent[] = [];
  private seen = new Set<string>();
  private seenOrder: string[] = [];
  private gifts = new Map<string, { event: LiveGiftEvent; observedAt: number }>();
  private timestamps = new Map<LiveEventKind, number[]>();

  private listeners = new Set<LiveEventListener>();
  /** 连接状态订阅者：真实 source 状态回调/disconnect 的同一同步段内通知（机器人授权撤销依赖它） */
  private stateListeners = new Set<LiveStateListener>();
  private sourceListeners = new Set<(event: LiveEvent, ingress: Readonly<SourceIngress>) => void>();
  private inputListeners = new Set<(state: LiveConnectionState, previous: LiveConnectionState) => void>();
  private updateSink: ((update: LiveUpdate) => void) | null = null;
  private pending: LiveEvent[] = [];
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(private readonly makeSource: (config: LiveConnection) => LiveSource = createLiveSource) {}

  /** 订阅连接状态（FEAT-DSH-004 元数据通道）：状态离开 connected 时在同一同步段收到通知。 */
  onStateChange(listener: LiveStateListener): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** 抖音原事件在 Hub 礼物聚合前送往输出接线；普通 ingest 不调用。 */
  onDouyinSourceEvent(listener: (event: LiveEvent, ingress: Readonly<SourceIngress>) => void): () => void {
    this.sourceListeners.add(listener);
    return () => this.sourceListeners.delete(listener);
  }

  /** 输出侧同时观察连接建立与失效，不改变机器人原有状态通知。 */
  onOutputInputState(listener: (state: LiveConnectionState, previous: LiveConnectionState) => void): () => void {
    this.inputListeners.add(listener);
    return () => this.inputListeners.delete(listener);
  }

  private notifyOutputInputState(state: LiveConnectionState, previous: LiveConnectionState): void {
    if (state === previous) return;
    for (const listener of this.inputListeners) {
      try { listener(state, previous); } catch (error) { console.error('[LiveHub] 公屏连接消费者出错：', error); }
    }
  }

  /** 连接离开 connected（源回调或主动断开）时同步通知订阅者；consumer 错误不破坏状态流转。 */
  private notifyStateLost(state: LiveConnectionState, previous: LiveConnectionState): void {
    for (const listener of this.stateListeners) {
      try {
        listener(state, previous);
      } catch (err) {
        console.error('[LiveHub] 连接状态订阅者出错：', err);
      }
    }
  }

  get isConnected(): boolean {
    return this.state === 'connected';
  }

  get currentConfig(): LiveConnection | null {
    return this.config;
  }

  /** 连接直播间；已连着同一个房间且参数没变时不重连 */
  connect(config: LiveConnection): LiveStatus {
    const same = this.source && this.config
      && this.config.platform === config.platform
      && this.config.roomId === config.roomId
      && (this.config.platform === 'bilibili' && config.platform === 'bilibili'
        ? this.config.cookie === config.cookie
        : this.config.platform === 'douyin' && config.platform === 'douyin'
          && this.config.bridgeUrl === config.bridgeUrl);
    if (same) return this.status();

    this.disconnect();
    this.config = { ...config };
    this.room = { platform: config.platform, roomId: config.roomId };
    this.stats = {};
    this.recent = [];
    this.seen.clear();
    this.seenOrder = [];
    this.gifts.clear();
    this.timestamps.clear();
    this.lastError = undefined;

    const source = this.makeSource(config);
    this.source = source;
    source.start({
      event: (event) => {
        if (this.source !== source) return;
        const ingress = source instanceof DouyinLiveSource ? readSourceIngress(event) : null;
        if (ingress && this.state === 'connected' && this.config?.platform === 'douyin'
          && ingress.roomId === this.config.roomId) {
          for (const listener of this.sourceListeners) {
            try { listener(event, ingress); } catch (error) { console.error('[LiveHub] 公屏来源消费者出错：', error); }
          }
        }
        this.ingest(event);
      },
      stats: (stats) => {
        if (this.source !== source) return;
        this.stats = { ...this.stats, ...stats };
        this.scheduleFlush();
      },
      room: (info) => {
        if (this.source !== source) return;
        this.room = { ...this.room, ...info, title: info.title ?? this.room?.title, anchorName: info.anchorName ?? this.room?.anchorName };
        this.scheduleFlush();
      },
      state: (state, detail) => {
        if (this.source !== source) return;
        const previous = this.state;
        this.state = state;
        this.notifyOutputInputState(state, previous);
        // FEAT-DSH-004：连接离开 connected 的真失效在真实 source 回调的同一同步段通知，
        // 不等轮询；快速重连也不会恢复已撤销的授权（撤销是粘性的）。
        if (previous === 'connected' && state !== 'connected') this.notifyStateLost(state, previous);
        if (detail?.loggedIn !== undefined) this.loggedIn = detail.loggedIn;
        if (state === 'connected') {
          this.connectedAt ??= Date.now();
          this.lastError = detail?.error;
        } else if (detail?.error) {
          this.lastError = detail.error;
        }
        this.scheduleFlush();
      },
    });
    return this.status();
  }

  disconnect(): LiveStatus {
    const source = this.source;
    this.source = null;
    const previous = this.state;
    this.config = null;
    this.state = 'idle';
    this.notifyOutputInputState('idle', previous);
    // 主动断开同样在同步段通知（与 source 回调同一语义，不产生第二种含义）
    if (previous === 'connected') this.notifyStateLost('idle', previous);
    source?.stop();
    this.connectedAt = undefined;
    this.loggedIn = false;
    this.room = undefined;
    this.stats = {};
    this.lastError = undefined;
    this.recent = [];
    this.seen.clear();
    this.seenOrder = [];
    this.gifts.clear();
    this.timestamps.clear();
    this.pending = [];
    this.scheduleFlush();
    return this.status();
  }

  status(now = Date.now()): LiveStatus {
    const perMinute: LiveStatus['perMinute'] = {};
    for (const [kind, list] of this.timestamps) {
      const count = list.filter((ts) => now - ts <= RATE_WINDOW_MS).length;
      if (count) perMinute[kind] = count;
    }
    return {
      state: this.state,
      room: this.room,
      loggedIn: this.loggedIn,
      stats: { ...this.stats },
      perMinute,
      connectedAt: this.connectedAt,
      lastError: this.lastError,
    };
  }

  /** 最近的事件（旧 → 新） */
  recentEvents(limit = RECENT_LIMIT): LiveEvent[] {
    return this.recent.slice(-limit);
  }

  subscribe(listener: LiveEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 弹幕姬窗口的推送出口（由 IPC 层设置） */
  onUpdate(sink: ((update: LiveUpdate) => void) | null): void {
    this.updateSink = sink;
  }

  /**
   * 平台事件入口：普通平台回调与重连补发走这里。首次本地接收不是实时资格证明——
   * 这里不写受信进入标记，机器人来源按未知拒绝（FEAT-DSH-004 fail closed）；
   * 事件本身照常进入直播整理管线，直播自身行为不变。
   */
  ingest(event: LiveEvent, now = Date.now()): void {
    this.processIngest(event, now, false);
  }

  /**
   * 受控离线注入的唯一可信入口（控制台模拟观众/确定性测试）：先写内部进入证明，
   * 再走同一条整理管线。只有这里收进的事件才可能成为机器人动作来源。
   */
  ingestTrustedInternal(event: LiveEvent, now = Date.now()): void {
    this.processIngest(event, now, true);
  }

  private processIngest(event: LiveEvent, now: number, trustedInternal: boolean): void {
    let isUpdate = false;
    let out: LiveEvent = event;

    if (event.kind === 'gift') {
      const previous = this.gifts.get(event.id);
      const prev = previous?.event;
      const comboWindow = event.platform === 'douyin' ? DOUYIN_CACHE_TTL_MS : GIFT_COMBO_MS;
      const previousAt = event.platform === 'douyin' ? previous?.observedAt : prev?.ts;
      if (prev && previousAt !== undefined && now - previousAt <= comboWindow) {
        prev.count += event.count;
        prev.valueYuan = Math.round((prev.valueYuan + event.valueYuan) * 1000) / 1000;
        prev.ts = event.ts;
        out = prev;
        isUpdate = true;
        this.gifts.delete(event.id);
        this.gifts.set(event.id, { event: prev, observedAt: now });
      } else {
        out = { ...event, id: prev ? `${event.id}:${now}` : event.id };
        this.gifts.delete(event.id);
        this.gifts.set(event.id, { event: out as LiveGiftEvent, observedAt: now });
      }
      this.pruneGifts(now);
    } else {
      if (this.seen.has(event.id)) return;
      this.remember(event.id);
    }

    // FEAT-DSH-004 元数据：只有受控离线注入（内部可信入口）写进入证明与平台原始 id；
    // 展示 id 的时间后缀只属于本进程；机器人来源必须用适配器原始 id，不换算、不重建。
    if (!isUpdate && trustedInternal) markTrustedInternalIngress(out, { rawId: event.id, ingestedAt: now });

    this.count(event.kind, now);
    if (!isUpdate) {
      this.recent.push(out);
      if (this.recent.length > RECENT_LIMIT * 1.2) this.recent = this.recent.slice(-RECENT_LIMIT);
    }
    this.pending.push(out);
    this.scheduleFlush();
    for (const listener of this.listeners) {
      try {
        listener(out, isUpdate);
      } catch (err) {
        console.error('[LiveHub] 事件消费者出错：', err);
      }
    }
  }

  private remember(id: string): void {
    this.seen.add(id);
    this.seenOrder.push(id);
    if (this.seenOrder.length > SEEN_LIMIT) {
      for (const old of this.seenOrder.splice(0, SEEN_LIMIT / 4)) this.seen.delete(old);
    }
  }

  private count(kind: LiveEventKind, now: number): void {
    const list = this.timestamps.get(kind) ?? [];
    list.push(now);
    while (list.length && now - list[0] > RATE_WINDOW_MS) list.shift();
    this.timestamps.set(kind, list);
  }

  private pruneGifts(now: number): void {
    for (const [id, entry] of this.gifts) {
      const gift = entry.event;
      const comboWindow = gift.platform === 'douyin' ? DOUYIN_CACHE_TTL_MS : GIFT_COMBO_MS;
      const observedAt = gift.platform === 'douyin' ? entry.observedAt : gift.ts;
      if (now - observedAt > comboWindow) this.gifts.delete(id);
    }
    while (this.gifts.size > DOUYIN_CACHE_LIMIT) this.gifts.delete(this.gifts.keys().next().value!);
  }

  private scheduleFlush(): void {
    if (this.flushTimer || !this.updateSink) return;
    this.flushTimer = setTimeout(() => this.flush(), FLUSH_MS);
  }

  private flush(): void {
    this.flushTimer = null;
    const batch = this.pending;
    this.pending = [];
    // 进场 / 点赞每批只推最后几条，其余的只体现在计数里
    let ambientLeft = AMBIENT_PER_FLUSH;
    const events: LiveEvent[] = [];
    const seenIds = new Set<string>();
    for (let i = batch.length - 1; i >= 0; i--) {
      const e = batch[i];
      if (seenIds.has(e.id)) continue; // 同一批里礼物连击只推最新的累计值
      seenIds.add(e.id);
      if (AMBIENT_KINDS.has(e.kind) && ambientLeft-- <= 0) continue;
      events.push({ ...e, user: { ...e.user } });
    }
    events.reverse();
    this.updateSink?.({ events, status: this.status() });
  }
}

export const liveHub = new LiveHub();
