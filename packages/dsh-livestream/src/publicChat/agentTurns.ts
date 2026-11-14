import type { AgentReplyTurnContext } from './agentReplyTool';

interface EventReference {
  sourceEvent: object;
  rawId: string;
  rawType: string;
  inputConnectionGeneration: number;
  valid(): boolean;
}

export interface PublicChatTurnLease extends AgentReplyTurnContext {
  agent: object;
  callerSignal: AbortSignal;
  valid(): boolean;
  claimed: boolean;
}

/** 将宿主实际 push 的 message ID 与唯一原事件关联；不接模型提供的 event ID。 */
export class PublicChatAgentTurns {
  private readonly pending = new Map<string, { agent: object; reference: EventReference }>();
  private readonly current = new WeakMap<object, PublicChatTurnLease>();
  private readonly active = new Set<PublicChatTurnLease>();

  remember(messageId: string, agent: object, reference: EventReference): boolean {
    if (!messageId || messageId.length > 128 || !reference.rawId || reference.rawId.length > 128
      || !reference.rawType || reference.rawType.length > 64 || !Number.isSafeInteger(reference.inputConnectionGeneration)
      || reference.inputConnectionGeneration <= 0 || this.pending.has(messageId) || this.pending.size >= 100 || !reference.valid()) return false;
    this.pending.set(messageId, { agent, reference });
    return true;
  }

  forget(messageId: string): void { this.pending.delete(messageId); }

  pendingAvailable(agent: object): boolean {
    const references = [...this.pending.values()].filter((entry) => entry.agent === agent && entry.reference.valid());
    return references.length === 1;
  }

  begin(agent: object, turnId: string, sessionId: string, signal: AbortSignal,
    messages: Array<{ id?: string }>, currentSession: () => boolean): PublicChatTurnLease | null {
    const previous = this.current.get(agent);
    if (previous && previous.turnId === turnId && previous.sessionId === sessionId && previous.callerSignal === signal) {
      let newAssociation = false;
      for (const message of messages) {
        if (message.id && this.pending.get(message.id)?.agent === agent && this.pending.delete(message.id)) newAssociation = true;
      }
      if (newAssociation) {
        this.active.delete(previous);
        return null;
      }
      return previous.valid() ? previous : null;
    }
    if (previous) this.active.delete(previous);
    const matches: EventReference[] = [];
    for (const message of messages) {
      if (!message.id) continue;
      const entry = this.pending.get(message.id);
      if (entry?.agent === agent) {
        this.pending.delete(message.id);
        matches.push(entry.reference);
      }
    }
    if (matches.length !== 1 || messages.length !== 1 || signal.aborted || !sessionId || sessionId.length > 128
      || !turnId || turnId.length > 128 || this.active.size >= 100) return null;
    const reference = matches[0];
    const lease: PublicChatTurnLease = {
      agent, turnId, sessionId, callerSignal: signal, sourceEvent: reference.sourceEvent,
      rawId: reference.rawId, rawType: reference.rawType, inputConnectionGeneration: reference.inputConnectionGeneration,
      claimed: false,
      valid: () => this.current.get(agent) === lease && this.active.has(lease) && !signal.aborted
        && currentSession() && reference.valid(),
    };
    this.current.set(agent, lease);
    this.active.add(lease);
    if (lease.valid()) return lease;
    this.active.delete(lease);
    return null;
  }

  find(agent: object, signal: AbortSignal): PublicChatTurnLease | null {
    const lease = this.current.get(agent);
    return lease && lease.callerSignal === signal && lease.valid() ? lease : null;
  }

  claim(lease: PublicChatTurnLease): boolean {
    if (!lease.valid() || lease.claimed) return false;
    lease.claimed = true;
    return true;
  }

  invalidate(): void {
    this.pending.clear();
    this.active.clear();
  }
}
