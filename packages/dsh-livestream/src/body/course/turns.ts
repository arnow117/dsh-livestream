export interface CourseTurn {
  agent: object;
  turn: number;
  sessionId: string;
  outputEpoch: string;
  eventId: string | null;
  signal: AbortSignal;
  callerSignal: AbortSignal;
  controller: AbortController;
  claimed: boolean;
  valid(): boolean;
  accept(): void;
}

export class CourseTurns {
  private readonly pending = new Map<string, string>();
  private readonly current = new WeakMap<object, CourseTurn>();
  private readonly turns = new Map<string, CourseTurn>();
  private readonly seen = new Set<string>();

  remember(messageId: string, eventId: string): void {
    if (!messageId || !eventId) return;
    this.pending.set(messageId, eventId);
    while (this.pending.size > 100) this.pending.delete(this.pending.keys().next().value!);
  }

  begin(agent: object, turn: number, sessionId: string, outputEpoch: string, signal: AbortSignal, messages: Array<{ id?: string }>, current: () => boolean, accept: () => void = () => {}): CourseTurn {
    const eventIds: string[] = [];
    for (const message of messages) {
      if (!message.id) continue;
      const id = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (id) eventIds.push(id);
    }
    const old = this.current.get(agent);
    if (old && old.turn === turn && old.sessionId === sessionId && old.callerSignal === signal) return old;
    old?.controller.abort();
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    const lease: CourseTurn = {
      agent, turn, sessionId, outputEpoch, eventId: eventIds.length === 1 ? eventIds[0] : null,
      signal: combined, callerSignal: signal, controller, claimed: false,
      valid: () => !combined.aborted && current(),
      accept,
    };
    this.current.set(agent, lease);
    this.turns.set(`${sessionId}:${turn}`, lease);
    while (this.turns.size > 100) {
      const key = this.turns.keys().next().value!;
      this.turns.get(key)?.controller.abort();
      this.turns.delete(key);
    }
    return lease;
  }

  find(agent: object, signal: AbortSignal): CourseTurn | undefined {
    const lease = this.current.get(agent);
    return lease?.callerSignal === signal && lease.valid() ? lease : undefined;
  }

  forTurn(sessionId: string, turn: number): CourseTurn | undefined {
    return this.turns.get(`${sessionId}:${turn}`);
  }

  claim(lease: CourseTurn): boolean {
    if (!lease.valid() || lease.claimed || !lease.eventId || this.seen.has(lease.eventId) || this.seen.size >= 5000) return false;
    lease.claimed = true;
    this.seen.add(lease.eventId);
    return true;
  }

  invalidateAll(): void {
    for (const lease of this.turns.values()) lease.controller.abort();
    this.pending.clear();
  }

  reset(): void {
    this.invalidateAll();
    this.turns.clear();
    this.seen.clear();
  }
}
