/**
 * 欢迎/礼物感谢输出策略（FEAT-008 FR-2）。
 *
 * 只接受真实原事件 + raw 证明齐全的输入；欢迎每用户 60 秒最多一次；
 * 礼物感谢按短窗合并输入增量，不跨 epoch/grant，不把 Hub 累计 count
 * 当增量，不把 unknown 金额写成 0 元，也不重复感谢同一批增量。
 * 模板固定、名称只允许短安全文本。
 */

import { renderWelcome, renderGiftThanks, sanitizeTemplateVariable, validateTemplateOutput } from './textPolicy';

export const WELCOME_THROTTLE_MS = 60_000;
export const GIFT_MERGE_WINDOW_MS = 8_000;
export const POLICY_STATE_LIMIT = 4_000;

export interface PolicyEventInput {
  userId: string;
  displayNameRaw: unknown;
  /** raw 证明齐全并已消费（sender 侧 take 成功）。 */
  rawProofOk: boolean;
  epoch: string;
  grantId: string;
}

export interface PolicyDecision {
  send: boolean;
  text: string | null;
  reason: string;
}

interface WelcomeState {
  lastSentAt: number;
  epoch: string;
}

interface GiftMergeState {
  text: string;
  displayName: string | null;
  giftName: string | null;
  mergedDelta: number;
  firstAt: number;
  flushAt: number;
  epoch: string;
  grantId: string;
}

export class OutputPolicyEngine {
  private readonly welcome = new Map<string, WelcomeState>();
  private readonly gift = new Map<string, GiftMergeState>();

  /**
   * 欢迎决策：必须真实进场事件且 raw 证明齐全；同用户 60 秒一次；
   * 名字未通过安全校验时退回不含名字的固定模板。
   */
  planWelcome(input: PolicyEventInput, now: number): PolicyDecision {
    if (!input.rawProofOk) return { send: false, text: null, reason: 'unavailable:no-raw-proof' };
    const key = JSON.stringify([input.epoch, input.userId]);
    const previous = this.welcome.get(key);
    if (previous !== undefined) {
      if (previous.epoch !== input.epoch) {
        // 跨 epoch 不继承旧节流状态。
        this.welcome.delete(key);
      } else if (now - previous.lastSentAt < WELCOME_THROTTLE_MS) {
        return { send: false, text: null, reason: 'throttled' };
      }
    }
    const displayName = sanitizeTemplateVariable(input.displayNameRaw);
    const text = renderWelcome(displayName);
    const validation = validateTemplateOutput(text);
    if (!validation.ok) return { send: false, text: null, reason: `template-invalid:${validation.reason}` };
    this.welcome.set(key, { lastSentAt: now, epoch: input.epoch });
    this.pruneWelcome(now);
    return { send: true, text, reason: 'ok' };
  }

  /**
   * 礼物增量合并：调用方必须传输入增量（delta），不传累计 count。
   * 短窗内同 (epoch, grant, user) 合并；合并窗到期 flush 出一条感谢。
   */
  mergeGiftIncrement(input: PolicyEventInput & { giftNameRaw: unknown; delta: number }, now: number): { accepted: boolean; reason: string } {
    if (!input.rawProofOk) return { accepted: false, reason: 'unavailable:no-raw-proof' };
    if (!Number.isSafeInteger(input.delta) || input.delta <= 0) return { accepted: false, reason: 'invalid-increment' };
    const key = JSON.stringify([input.epoch, input.grantId, input.userId]);
    const existing = this.gift.get(key);
    const displayName = sanitizeTemplateVariable(input.displayNameRaw);
    const giftName = sanitizeTemplateVariable(input.giftNameRaw);
    if (existing !== undefined && existing.epoch === input.epoch && existing.grantId === input.grantId && now - existing.firstAt <= GIFT_MERGE_WINDOW_MS) {
      existing.mergedDelta += input.delta;
      existing.flushAt = existing.firstAt + GIFT_MERGE_WINDOW_MS;
      this.gift.set(key, existing);
      return { accepted: true, reason: 'merged' };
    }
    if (existing !== undefined) this.gift.delete(key);
    this.gift.set(key, {
      text: '',
      displayName,
      giftName,
      mergedDelta: input.delta,
      firstAt: now,
      flushAt: now + GIFT_MERGE_WINDOW_MS,
      epoch: input.epoch,
      grantId: input.grantId,
    });
    this.pruneGift(now);
    return { accepted: true, reason: 'opened' };
  }

  /** 到期的合并窗产出一条感谢文本；不足窗不产出。 */
  flushDueGiftThanks(now: number): PolicyDecision[] {
    return this.flushDueGiftEntries(now).map((entry) => entry.decision);
  }

  /** 保留合并所属原 epoch/grant/user，供宿主关联原始事件和证明。 */
  flushDueGiftEntries(now: number): Array<{ key: string; epoch: string; grantId: string; decision: PolicyDecision }> {
    const decisions: Array<{ key: string; epoch: string; grantId: string; decision: PolicyDecision }> = [];
    for (const [key, state] of this.gift) {
      if (now < state.flushAt) continue;
      this.gift.delete(key);
      const text = renderGiftThanks(state.displayName, state.giftName);
      const validation = validateTemplateOutput(text);
      if (!validation.ok) {
        decisions.push({ key, epoch: state.epoch, grantId: state.grantId,
          decision: { send: false, text: null, reason: `template-invalid:${validation.reason}` } });
        continue;
      }
      decisions.push({ key, epoch: state.epoch, grantId: state.grantId, decision: { send: true, text, reason: 'ok' } });
    }
    return decisions;
  }

  /** 目标切换/撤权/下播时清空在途合并；不跨 epoch/grant。 */
  resetForScope(epoch: string, grantId: string): void {
    for (const [key, state] of this.gift) {
      if (state.epoch === epoch && state.grantId === grantId) this.gift.delete(key);
    }
  }

  private pruneWelcome(now: number): void {
    if (this.welcome.size <= POLICY_STATE_LIMIT) return;
    for (const [key, state] of this.welcome) {
      if (now - state.lastSentAt > WELCOME_THROTTLE_MS) this.welcome.delete(key);
      if (this.welcome.size <= POLICY_STATE_LIMIT) return;
    }
  }

  private pruneGift(now: number): void {
    if (this.gift.size <= POLICY_STATE_LIMIT) return;
    for (const [key, state] of this.gift) {
      if (now - state.flushAt > GIFT_MERGE_WINDOW_MS) this.gift.delete(key);
      if (this.gift.size <= POLICY_STATE_LIMIT) return;
    }
  }
}
