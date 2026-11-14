/**
 * 注意力层的输出：一个「现在可以开口说的话题」。说话本身由 LLM 生成，这里只决定说什么、对谁说。
 */

import type {
  LiveChatEvent,
  LiveEvent,
  LiveGiftEvent,
  LiveMembershipEvent,
  LiveSuperChatEvent,
  LiveUser,
} from '../live';

/**
 * 可信进入标记（FEAT-DSH-004 元数据接线）：只由受控离线注入的内部可信入口写入，
 * 私有 WeakMap 承载；不进用户/模型可见字段，任何展示文本都不能伪造它。
 * 普通平台回调、重连补发、历史回放不写标记（读不到即未知）——平台首次本地接收、
 * 连接在线或事件时间都不能证明实时资格；真实平台证明归 T03，在此之前机器人来源 fail closed。
 */
export interface LiveIngressMeta {
  /** 该事件带受信进入证明（目前只有本进程受控离线注入这一种来源） */
  live: boolean;
  /** 进入证明来源：受控离线注入走内部可信入口；普通 ingest 不得写标记 */
  provenance: 'internal-controlled';
  /** 平台适配器给出的原始稳定 id（礼物连击超窗后 hub 展示 id 会加时间后缀，这里保留原值） */
  rawId: string;
  /** 首次收进的本地时刻 */
  ingestedAt: number;
}

const ingressMeta = new WeakMap<LiveEvent, LiveIngressMeta>();

/**
 * 受控离线注入的内部可信入口（唯一能把 live 置真的入口）：控制台模拟观众、确定性测试注入
 * 走这里；普通 ingest（平台回调/重连补发）不得调用。只写一次，后续覆盖忽略。
 */
export function markTrustedInternalIngress(event: LiveEvent, meta: { rawId: string; ingestedAt: number }): void {
  if (ingressMeta.has(event)) return;
  ingressMeta.set(event, { live: true, provenance: 'internal-controlled', ...meta });
}

/** 读进入标记：读不到（普通平台回调、重放、展示复制、伪造对象）一律按未知处理。 */
export function liveIngress(event: LiveEvent): LiveIngressMeta | null {
  return ingressMeta.get(event) ?? null;
}

/**
 * ChatPick 组成登记（FEAT-DSH-004，私有）：attention 组装 pick 时登记它聚合的全部原事件对象。
 * 事件对象引用不可跨进程/序列化复制；手工构造或复制的 pick 读不到登记，不能继承来源。
 * 公开的 `sources` 数组只是展示 metadata，不作为机器人来源依据。
 */
const pickCompositions = new WeakMap<ChatPick, readonly LiveEvent[]>();

/** attention 层组装 pick 时登记组成；同一 pick 只登记一次，后续覆盖忽略。 */
export function registerPickComposition(pick: ChatPick, events: readonly LiveEvent[]): void {
  if (pickCompositions.has(pick)) return;
  pickCompositions.set(pick, events);
}

/** 读 pick 的私有组成登记：伪造/复制/重建的 pick 读不到（返回 null）。 */
export function pickCompositionOf(pick: ChatPick): readonly LiveEvent[] | null {
  return pickCompositions.get(pick) ?? null;
}

/** 房间热度：决定她能顾得上多少，以及值不值得点名 */
export type RoomHeat = 'quiet' | 'normal' | 'busy';

export interface ChatPick {
  event: LiveChatEvent;
  /** 同一个人连发的几条合在一起 */
  text: string;
  /**
   * 组成这条 pick 的全部原事件身份（展示 metadata）：按发生顺序列出每条的
   * 平台原始 id 与进入标记。这不是来源凭据——机器人来源以私有组成登记
   * （registerPickComposition/pickCompositionOf）与事件对象上的进入标记为准；
   * 复制这份数组不构成任何授权。
   */
  sources: Array<{ id: string; live: boolean }>;
  /** 给 LLM 看的标签：问题 / 点名 / 舰长 / 新观众 / 接她的话 … */
  tags: string[];
  score: number;
}

export type TopicBody =
  /** 醒目留言：单独念、单独回 */
  | { kind: 'superchat'; event: LiveSuperChatEvent }
  /** 上舰与大额礼物：逐个点名感谢 */
  | { kind: 'thanks'; events: Array<LiveGiftEvent | LiveMembershipEvent> }
  /** 小礼物：攒一批一起谢；more 是没点名的人数 */
  | { kind: 'gifts'; events: LiveGiftEvent[]; more: number }
  | { kind: 'chat'; picks: ChatPick[] }
  /** 很多人在刷同一句 */
  | { kind: 'trend'; key: string; samples: string[]; users: number }
  | { kind: 'welcome'; users: LiveUser[]; more: number }
  | { kind: 'follow'; users: LiveUser[]; more: number }
  /** 一段时间没人说话：她自己找话说 */
  | { kind: 'idle'; silentMs: number }
  /** 开播：跟大家打招呼 */
  | { kind: 'opening' }
  /** 谢幕：道别，可以提一下本场 */
  | { kind: 'ending'; summary: string }
  /** 主人（搭档）开口跟她说话：interrupted 是她被打断时正在说的那句 */
  | { kind: 'owner'; text: string; interrupted?: string; who?: string }
  /** 她在舞台上放的视频放完了（error：没放出来）；playedSec 是放了多久 */
  | { kind: 'video'; title: string; how: 'ended' | 'error'; playedSec: number }
  /** 直播插件重启了（主人在更新），断了 gapSec 秒，这场接着播 */
  | { kind: 'resumed'; gapSec: number; playing?: boolean }
  /** 她在直播里开着的游戏：这一轮她停下了、直播间也没事，叫她接着玩 */
  | { kind: 'game' }
  /** 开播账号收到了新私信、评论回复、@（只有她看得到；lines 已经写好、内容包在标签里） */
  | { kind: 'inbox'; lines: string[] }
  /**
   * 边看边聊：她放的视频 from–to 秒这段里说了什么、原视频的弹幕在刷什么（没别的事要回时才有）。
   * source：字幕从哪来（human UP 主做的、ai B 站官方 AI、asr Whisper 听写；null 没有）
   */
  | {
    kind: 'watching';
    title: string;
    fromSec: number;
    toSec: number;
    lines: Array<{ from: number; text: string }>;
    source: 'human' | 'ai' | 'asr' | null;
    engine?: string;
    danmaku: string[];
  };

export type Topic = TopicBody & {
  id: string;
  priority: number;
  heat: RoomHeat;
  createdAt: number;
};

export type TopicKind = Topic['kind'];
