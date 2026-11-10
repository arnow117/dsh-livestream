export interface TrustedQueryInput {
  participant: string;
  text: string;
}

export interface QueryTurn {
  agent: object;
  turn: number;
  sessionId: string;
  epoch: string;
  signal: AbortSignal;
  callerSignal: AbortSignal;
  controller: AbortController;
  inputs: TrustedQueryInput[];
  called: boolean;
  queryId?: string;
  invalidated: boolean;
  clarificationRequested: boolean;
  valid(): boolean;
}

const WEATHER_INTENT = /天气|气温|温度|几度|冷不冷|热不热|下雨|降水|下雪|预报/;
const DATE_INTENT = /\d{4}-\d{2}-\d{2}|\d{1,2}月\d{1,2}[日号]|(?:今|明|后|昨|前)(?:天|日|早|晚|夜|晨|上午|下午|中午)|下周|本周|这周|周末|星期|周[一二三四五六日天]|下个?月|明年|预报/;

/** Freezes host-attributed messages for a single agent turn. */
export class QueryTurns {
  private readonly pending = new Map<string, TrustedQueryInput[]>();
  private readonly current = new WeakMap<object, QueryTurn>();
  private readonly turns = new Map<string, QueryTurn>();
  private latest: QueryTurn | null = null;
  private clarification: { sessionId: string; epoch: string; participant: string; text: string } | null = null;

  remember(messageId: string, inputs: TrustedQueryInput[]): void {
    this.pending.set(messageId, inputs.map((input) => ({ ...input })));
    while (this.pending.size > 100) this.pending.delete(this.pending.keys().next().value!);
  }

  begin(agent: object, turn: number, sessionId: string, epoch: string, signal: AbortSignal, messages: Array<{ id?: string }>): QueryTurn {
    const old = this.current.get(agent);
    const inputs = messages.flatMap((message) => {
      const bound = message.id ? this.pending.get(message.id) : undefined;
      if (message.id) this.pending.delete(message.id);
      return bound ?? [];
    });
    if (old && old.turn === turn && old.sessionId === sessionId) {
      if (old.valid() && old.epoch === epoch && old.callerSignal === signal && !old.called) {
        old.inputs.push(...inputs);
      }
      return old;
    }
    const controller = new AbortController();
    const lease: QueryTurn = {
      agent, turn, sessionId, epoch, callerSignal: signal, controller,
      signal: AbortSignal.any([signal, controller.signal]), inputs, called: false, invalidated: false, clarificationRequested: false,
      valid() { return !this.invalidated && !this.signal.aborted; },
    };
    this.current.set(agent, lease);
    this.turns.set(`${sessionId}:${turn}`, lease);
    while (this.turns.size > 100) this.turns.delete(this.turns.keys().next().value!);
    return lease;
  }

  find(agent: object, signal: AbortSignal): QueryTurn | undefined {
    const lease = this.current.get(agent);
    return lease?.callerSignal === signal && lease.valid() ? lease : undefined;
  }

  forTurn(sessionId: string, turn: number): QueryTurn | undefined {
    return this.turns.get(`${sessionId}:${turn}`);
  }

  invalidateAll(): void {
    for (const lease of this.turns.values()) {
      if (!lease.invalidated) {
        lease.invalidated = true;
        lease.controller.abort();
      }
    }
    this.pending.clear();
    this.clarification = null;
  }

  startQuery(lease: QueryTurn, queryId: string): void {
    lease.queryId = queryId;
    this.latest = lease;
  }

  cancel(sessionId: string, queryId: string, epoch: string): { lease: QueryTurn; alreadyCancelled: boolean } | undefined {
    const lease = this.latest;
    if (!lease || lease.sessionId !== sessionId || lease.queryId !== queryId || lease.epoch !== epoch) return undefined;
    const alreadyCancelled = lease.invalidated;
    if (!alreadyCancelled) {
      lease.invalidated = true;
      lease.controller.abort();
    }
    return { lease, alreadyCancelled };
  }

  observeReply(lease: QueryTurn, text: string): void {
    if (/请.{0,12}(?:城市|地点|日期|省|市|县)|哪个城市|哪个地方|哪一天|什么日期|具体.{0,8}(?:城市|日期)/.test(text)) lease.clarificationRequested = true;
  }

  finishTurn(lease: QueryTurn): void {
    if (!lease.valid() || lease.called || !lease.clarificationRequested) return;
    const weatherInputs = lease.inputs.filter((input) => input.participant && WEATHER_INTENT.test(input.text));
    const participants = new Set(weatherInputs.map((input) => input.participant));
    const previous = this.clarification;
    const sameContext = previous?.sessionId === lease.sessionId && previous.epoch === lease.epoch;
    const canContinue = sameContext && lease.inputs.some((input) => input.participant === previous.participant)
      && (participants.size === 0 || (participants.size === 1 && participants.has(previous.participant)));
    const participant = canContinue ? previous.participant : participants.size === 1 ? [...participants][0] : null;
    if (!participant) {
      this.clarification = null;
      return;
    }
    const fragments = lease.inputs.filter((input) => input.participant === participant).map((input) => input.text);
    const text = [...(canContinue ? [previous.text] : []), ...fragments].join('\n');
    this.clarification = text.length <= 2000
      ? { sessionId: lease.sessionId, epoch: lease.epoch, participant, text }
      : null;
  }

  claim(lease: QueryTurn): boolean {
    if (!lease.valid() || lease.called) return false;
    lease.called = true;
    this.clarification = null;
    return true;
  }

  authorizesSearch(lease: QueryTurn, query: string): boolean {
    return typeof query === 'string' && !!query.trim() && lease.inputs.some((input) => input.text.includes(query));
  }

  /** A weather request is attributed as a whole; location and date never cross participants. */
  authorizesWeather(lease: QueryTurn, location: string, date?: string): boolean {
    if (typeof location !== 'string' || !location) return false;
    const byParticipant = new Map<string, string[]>();
    for (const input of lease.inputs) {
      if (!input.participant) continue;
      const texts = byParticipant.get(input.participant) ?? [];
      texts.push(input.text);
      byParticipant.set(input.participant, texts);
    }
    const previous = this.clarification;
    const candidates = [...byParticipant].map(([participant, texts]) => {
      const current = texts.join('\n');
      const canUseClarification = previous?.sessionId === lease.sessionId
        && previous.epoch === lease.epoch && previous.participant === participant;
      const context = canUseClarification ? `${previous.text}\n${current}` : current;
      return { participant, context, current, canUseClarification };
    }).filter(({ context }) => WEATHER_INTENT.test(context));
    if (candidates.length !== 1) return false;
    const candidate = candidates[0];
    if (candidate.canUseClarification && !candidate.current.includes(location)
      && !(date && candidate.current.includes(date)) && !WEATHER_INTENT.test(candidate.current)) return false;
    if (!candidate.context.includes(location)) return false;
    const dates = candidate.context.match(/\d{4}-\d{2}-\d{2}/g) ?? [];
    if (date) return dates.length > 0 && dates.every((value) => value === date);
    if (DATE_INTENT.test(candidate.context)) return false;
    if (/会.{0,3}(?:下雨|下雪|降水)/.test(candidate.context)
      && !/(?:现在|此刻|当前)/.test(candidate.context)) return false;
    return true;
  }
}

/** One process-local registry shared by the owner route and agent plugin. */
export const queryTurns = new QueryTurns();
