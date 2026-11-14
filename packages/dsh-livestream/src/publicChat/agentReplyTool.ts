/**
 * 受限 Agent 公屏回复工具（FEAT-008 输入输出与Agent）。
 *
 * 只在当前受管会话/回合且有真实公屏事件关联时可用；模型不传 eventId
 * 自证，关联由宿主回合上下文提供。每原事件/回合最多一次；sourceKey 由
 * 宿主派生并固定，不能换请求 ID 重放。模拟事件不可触发真实发送。
 */

import { createHash } from 'node:crypto';
import { boundedString } from './protocol';
import { validatePublicText } from './textPolicy';
import { deriveSourceKey, validateAutoEvent } from './eventRef';
import type { PublicChatSendController, SubmitResult } from './controller';

export interface AgentReplyTurnContext {
  sessionId: string;
  turnId: string;
  /** 宿主回合关联的真实原公屏事件对象（带输出专用元数据）。 */
  sourceEvent: object;
  rawId: string;
  rawType: string;
  inputConnectionGeneration: number;
}

export interface AgentReplyToolDeps {
  controller: PublicChatSendController;
  /** 宿主在受管回合期间提供当前关联；无关联返回 null。 */
  getTurnContext(): AgentReplyTurnContext | null;
  /** 宿主生成的固定 sourceKey 前缀输入（直播 epoch）。 */
  liveEpoch(): string;
  /** 与 controller.setCurrentSourceConnectionToken 一致的当前来源令牌。 */
  sourceConnectionToken(): string;
}

export interface AgentReplyExecuteArgs {
  text?: unknown;
}

export type AgentReplyResult =
  | { status: 'submitted'; requestId: string }
  | { status: 'duplicate'; requestId: string }
  | { status: 'rejected'; reason: string };

export interface PublicChatReplyTool {
  name: 'send_public_chat_reply';
  /** 工具参数只有 text；事件关联来自宿主上下文，不接受模型传入。 */
  execute(args: AgentReplyExecuteArgs): Promise<AgentReplyResult>;
}

export function createPublicChatReplyTool(deps: AgentReplyToolDeps): PublicChatReplyTool {
  const usedTurnKeys = new Set<string>();
  return {
    name: 'send_public_chat_reply',
    async execute(args: AgentReplyExecuteArgs): Promise<AgentReplyResult> {
      // 只接受 {text}；任何事件 ID 自证参数都不存在。
      if (args === null || typeof args !== 'object' || Array.isArray(args)) {
        return { status: 'rejected', reason: 'args-invalid' };
      }
      const keys = Object.keys(args);
      if (keys.some((key) => key !== 'text')) return { status: 'rejected', reason: 'unknown-args' };
      const context = deps.getTurnContext();
      if (context === null) return { status: 'rejected', reason: 'unavailable:no-real-event' };
      // 模拟事件没有输出专用元数据；模拟入口不升级来源。
      const association = validateAutoEvent(context.sourceEvent, { rawId: context.rawId, rawType: context.rawType }, {
        liveEpoch: deps.liveEpoch(),
        sourceConnectionToken: deps.sourceConnectionToken(),
      });
      if (!association.ok) return { status: 'rejected', reason: association.reason };
      const text = validatePublicText(args.text);
      if (!text.ok) return { status: 'rejected', reason: `text-invalid:${text.reason}` };
      if (!boundedString(context.sessionId, 128) || !boundedString(context.turnId, 128)) {
        return { status: 'rejected', reason: 'turn-context-invalid' };
      }
      const sourceIdentity = deriveSourceKey({
        liveEpoch: deps.liveEpoch(),
        inputConnectionGeneration: context.inputConnectionGeneration,
        rawType: context.rawType,
        rawId: context.rawId,
      });
      const sourceKey = `auto:${createHash('sha256').update(sourceIdentity).digest('hex')}`;
      const onceKey = JSON.stringify([context.sessionId, context.turnId, sourceKey]);
      if (usedTurnKeys.has(onceKey)) return { status: 'rejected', reason: 'already-replied-this-turn' };
      const result: SubmitResult = await deps.controller.submit({
        requestId: `agent:${createHash('sha256').update(onceKey).digest('hex')}`,
        sourceKey,
        text: typeof args.text === 'string' ? args.text : '',
        autoEvent: { event: context.sourceEvent, rawId: context.rawId, rawType: context.rawType },
      });
      if (result.status === 'accepted') {
        usedTurnKeys.add(onceKey);
        return { status: 'submitted', requestId: result.requestId };
      }
      if (result.status === 'duplicate') return { status: 'duplicate', requestId: result.requestId };
      return { status: 'rejected', reason: result.reason };
    },
  };
}
