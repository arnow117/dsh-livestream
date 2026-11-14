/**
 * 输出专用来源元数据与 sourceKey（FEAT-008 输入输出与Agent / P2-01 修订）。
 *
 * 输出专用 WeakMap 由宿主（T002 的 Source 接线）登记原事件元数据；
 * 普通 ingest/模拟入口不升级来源。相同 event 复制/序列化不继承资格。
 * 名称/文本不是关联凭据；sourceKey 由宿主以输入连接代、原 rawId/类型、
 * 直播 epoch 产生并固定，不能换请求 ID 重放。
 */

export interface SourceEventMetadata {
  /** 原始平台消息 ID（字符串，无损）。 */
  rawId: string;
  /** 原始平台消息类型（chat/member/gift 等，sender 原始语义）。 */
  rawType: string;
  /** 原始帧携带的时间戳：不可信，只作展示，绝不冒充新鲜度证明。 */
  rawFrameTsUntrusted: number | null;
  /** 本进程接收时间。 */
  receivedAt: number;
  /** 来源连接令牌：由宿主在输入连接代次推进时重新生成。 */
  sourceConnectionToken: string;
  roomId: string;
  liveEpoch: string;
}

const registry = new WeakMap<object, SourceEventMetadata>();

/** T002 的 Source 接线调用；同一 event 对象只登记一次。 */
export function registerSourceEventMetadata(event: object, metadata: SourceEventMetadata): void {
  if (registry.has(event)) return;
  registry.set(event, metadata);
}

export function readSourceEventMetadata(event: object): SourceEventMetadata | null {
  return registry.get(event) ?? null;
}

export interface SourceKeyParts {
  liveEpoch: string;
  inputConnectionGeneration: number;
  rawType: string;
  rawId: string;
}

/** 确定性 sourceKey：同事件在宿主重放/重试中保持稳定，换事件必不同。 */
export function deriveSourceKey(parts: SourceKeyParts): string {
  return `pubchat:${parts.liveEpoch}:${parts.inputConnectionGeneration}:${parts.rawType}:${parts.rawId}`;
}

export interface AutoEventExpectation {
  liveEpoch: string;
  sourceConnectionToken: string;
}

export type AutoEventCheck =
  | { ok: true; metadata: SourceEventMetadata }
  | { ok: false; reason: 'unavailable:no-metadata' | 'unavailable:type-mismatch' | 'unavailable:rawid-mismatch' | 'unavailable:stale-input-generation' | 'unavailable:stale-epoch' };

/**
 * controller 提交自动动作前的进程内校验：事件必须带输出专用元数据，
 * 且 rawId/原类型/当前输入连接代次/当前直播 epoch 全部精确匹配。
 * 缺失/模糊/过期身份或 raw 证据都 unavailable；昵称/文字自报不是证明。
 */
export function validateAutoEvent(
  event: object,
  claim: { rawId: string; rawType: string },
  expectation: AutoEventExpectation,
): AutoEventCheck {
  const metadata = readSourceEventMetadata(event);
  if (metadata === null) return { ok: false, reason: 'unavailable:no-metadata' };
  if (metadata.sourceConnectionToken !== expectation.sourceConnectionToken) {
    return { ok: false, reason: 'unavailable:stale-input-generation' };
  }
  if (metadata.liveEpoch !== expectation.liveEpoch) return { ok: false, reason: 'unavailable:stale-epoch' };
  if (metadata.rawType !== claim.rawType) return { ok: false, reason: 'unavailable:type-mismatch' };
  if (metadata.rawId !== claim.rawId) return { ok: false, reason: 'unavailable:rawid-mismatch' };
  return { ok: true, metadata };
}
