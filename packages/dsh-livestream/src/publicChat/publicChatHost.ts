import type { LiveConnectionState, LiveEvent } from '../core/live';
import type { SourceIngress } from './sourceIngress';
import type { TrustedHistory, TrustedSender } from './trustedSender';
import type { PublicChatOwnerActions } from './ownerActions';
import { trustedHistoryReferencesFromEnvironment, trustedReferencesFromEnvironment } from './trustedReferences';
import { PublicChatAgentTurns } from './agentTurns';
import { PublicChatAutomaticEvents } from './automaticEvents';

interface LiveScope {
  roomId: string;
  epoch: string;
  startedAtMs: number;
}

/** 只由已认证的 owner 精确路由调用；同步失效先于所有异步收尾。 */
export class PublicChatHost {
  private sender: TrustedSender | null = null;
  private history: TrustedHistory | null = null;
  private historyStart: Promise<TrustedHistory | null> | null = null;
  private closed = false;
  private closing: Promise<void> | null = null;
  private readonly activeOperations = new Set<Promise<unknown>>();
  private actions: PublicChatOwnerActions | null = null;
  private starting = false;
  private startDone: Promise<void> | null = null;
  private revision = 0;
  private connected = false;
  private scope: LiveScope | null = null;
  private readonly turns = new PublicChatAgentTurns();
  private automatic: PublicChatAutomaticEvents | null = null;

  constructor(private readonly enabled: () => boolean, private readonly replyEnabled: () => boolean,
    private readonly currentSession: () => string | null,
    private readonly automaticEnabled: (kind: 'welcome' | 'thanks') => boolean) {}

  setLive(scope: LiveScope | null): void {
    if (this.closed) return;
    if (scope && this.scope && scope.roomId === this.scope.roomId && scope.epoch === this.scope.epoch
      && scope.startedAtMs === this.scope.startedAtMs) return;
    this.revision++;
    this.turns.invalidate();
    this.automatic?.clear();
    this.scope = scope;
    this.sender?.input.setLive(scope);
  }

  inputChanged(state: LiveConnectionState, previous: LiveConnectionState): void {
    if (this.closed) return;
    if (state === previous) return;
    this.revision++;
    this.turns.invalidate();
    this.automatic?.clear();
    this.connected = state === 'connected';
    this.sender?.input.inputStateChanged(state, previous);
  }

  originalEvent(event: LiveEvent, ingress: Readonly<SourceIngress>): void {
    if (this.closed) return;
    if (this.sender?.input.bindOriginal(event, ingress)) this.automatic?.original(event);
  }

  invalidate(): void {
    if (this.closed) return;
    this.invalidateState();
  }

  private invalidateState(): void {
    this.revision++;
    this.turns.invalidate();
    this.automatic?.clear();
    this.scope = null;
    this.sender?.input.setLive(null);
  }

  suspendForSettings(): void {
    if (this.closed) return;
    this.revision++;
    this.turns.invalidate();
    this.automatic?.clear();
    this.sender?.controller.suspendFrozenLocally();
  }

  invalidateForSettings(): void {
    if (this.closed) return;
    this.revision++;
    this.turns.invalidate();
    this.automatic?.clear();
    this.scope = null;
    this.sender?.controller.suspendFrozenLocally();
  }

  invalidateReplies(): void { if (!this.closed) this.turns.invalidate(); }
  invalidateAutomatic(): void { if (!this.closed) this.automatic?.clear(); }

  rememberReply(messageId: string, agent: object, event: object): boolean {
    if (this.closed || !this.enabled() || !this.replyEnabled() || !this.sender) return false;
    const reference = this.sender.input.reference(event);
    return reference ? this.turns.remember(messageId, agent, reference) : false;
  }

  forgetReply(messageId: string): void { this.turns.forget(messageId); }

  beginReply(agent: object, turn: string, signal: AbortSignal, messages: Array<{ id?: string }>): void {
    const sessionId = this.currentSession();
    if (this.closed || !sessionId || !this.enabled() || !this.replyEnabled()) return;
    this.turns.begin(agent, turn, sessionId, signal, messages,
      () => this.currentSession() === sessionId && this.enabled() && this.replyEnabled());
  }

  replyAvailable(agent: object, signal: AbortSignal): boolean {
    const lease = this.turns.find(agent, signal);
    return !this.closed && this.enabled() && this.replyEnabled() && !!this.sender && !signal.aborted
      && (!!lease && !lease.claimed || this.turns.pendingAvailable(agent));
  }

  async sendReply(agent: object, signal: AbortSignal, text: unknown) {
    const lease = this.turns.find(agent, signal);
    if (this.closed || !lease || !this.sender || !this.enabled() || !this.replyEnabled() || !this.turns.claim(lease)) {
      return { status: 'rejected' as const, reason: 'turn-unavailable' };
    }
    return this.sender.reply(lease, text);
  }

  private async ensureHistory(): Promise<TrustedHistory | null> {
    if (this.closed) return null;
    if (this.history) return this.history;
    if (this.historyStart) return this.historyStart;
    const refs = trustedHistoryReferencesFromEnvironment(process.env);
    if (!refs) return null;
    const pending = (async () => {
      try {
        const [{ openTrustedHistory }, { PublicChatOwnerActions }] = await Promise.all([
          import('./trustedSender'), import('./ownerActions'),
        ]);
        if (this.closed) return null;
        const history = await openTrustedHistory(refs, () => !this.closed);
        if (this.closed) return null;
        this.history = history;
        this.actions = new PublicChatOwnerActions(history.controller, () => this.enabled() && !!this.sender
          && !!this.scope && this.connected && this.scope.roomId === this.sender.publicView().roomId);
        return history;
      } catch {
        return null;
      }
    })();
    this.historyStart = pending;
    try { return await pending; } finally { if (this.historyStart === pending) this.historyStart = null; }
  }

  private async operation<T>(run: () => Promise<T>, unavailable: T): Promise<T> {
    if (this.closed) return unavailable;
    const pending = (async () => {
      if (!await this.ensureHistory() || this.closed) return unavailable;
      return run();
    })();
    this.activeOperations.add(pending);
    try { return await pending; } finally { this.activeOperations.delete(pending); }
  }

  async view() {
    const history = await this.ensureHistory();
    if (!history || !this.actions || this.closed) {
      return { available: false, historyAvailable: false, starting: this.starting, identity: null,
        hold: true, grant: null, messages: [], controls: [] };
    }
    return { available: !!this.sender, historyAvailable: true, starting: this.starting,
      identity: this.sender?.publicView() ?? null, ...this.actions.view() };
  }

  async maintain(): Promise<{ ok: boolean; reason: string }> {
    if (this.closed || this.starting || !this.enabled() || !this.scope || !this.connected) {
      return { ok: false, reason: 'sender-or-live-unavailable' };
    }
    if (this.sender) {
      if (this.sender.publicView().roomId !== this.scope.roomId) return { ok: false, reason: 'fixed-target-mismatch' };
      this.automatic?.clear();
      return this.sender.maintain();
    }
    const refs = trustedReferencesFromEnvironment(process.env);
    if (!refs) return { ok: false, reason: 'deployment-unavailable' };
    const revision = this.revision;
    const scope = this.scope;
    this.starting = true;
    let finishStart!: () => void;
    this.startDone = new Promise<void>((resolve) => { finishStart = resolve; });
    let sender: TrustedSender | null = null;
    try {
      const history = await this.ensureHistory();
      if (!history || this.closed) return { ok: false, reason: 'history-unavailable' };
      const { startTrustedSender } = await import('./trustedSender');
      if (this.closed) return { ok: false, reason: 'host-closed' };
      sender = await startTrustedSender(refs, scope.roomId, history,
        () => !this.closed && revision === this.revision, () => !this.closed);
      if (this.closed || revision !== this.revision || !this.enabled() || !this.connected || this.scope !== scope) {
        return { ok: false, reason: 'live-changed' };
      }
      sender.input.setLive(scope);
      sender.input.inputStateChanged('connected', 'idle');
      await sender.startRaw();
      if (this.closed || revision !== this.revision || !this.enabled() || !this.connected || this.scope !== scope) {
        return { ok: false, reason: 'live-changed' };
      }
      this.sender = sender;
      this.automatic = new PublicChatAutomaticEvents(sender, (kind) => this.enabled() && this.automaticEnabled(kind));
      const automatic = this.automatic;
      sender.observeRaw((observation) => automatic.observed(observation));
      sender.observeInvalidation(() => {
        this.revision++;
        this.turns.invalidate();
        automatic.clear();
      });
      sender = null;
      return { ok: true, reason: 'ready' };
    } catch {
      return { ok: false, reason: 'sender-unavailable' };
    } finally {
      try {
        if (sender) await sender.close();
      } finally {
        this.starting = false;
        finishStart();
        this.startDone = null;
      }
    }
  }

  async qualify() { return this.operation(() => this.actions!.qualify(), { ok: false, reason: 'history-unavailable' }); }
  async authorize() { return this.operation(() => this.actions!.authorize(), { ok: false, reason: 'history-unavailable' }); }
  revoke(): void {
    if (this.closed) return;
    this.revision++;
    this.turns.invalidate();
    this.automatic?.clear();
    this.actions?.revoke();
  }
  async sendManual(input: unknown) {
    return this.operation(() => this.actions!.sendManual(input), { status: 'rejected' as const, reason: 'history-unavailable' });
  }
  async recordFact(input: unknown) {
    return this.operation(async () => this.actions!.recordFact(input), { ok: false as const, error: 'history-unavailable' });
  }
  async reconcileMessage(input: unknown) {
    return this.operation(() => this.actions!.reconcileMessage(input), { ok: false, reason: 'history-unavailable' });
  }
  async reconcileControl(input: unknown) {
    return this.operation(() => this.actions!.reconcileControl(input), { ok: false, reason: 'history-unavailable' });
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.history?.controller.suspendFrozenLocally();
    this.invalidateState();
    const closing = (async () => {
      if (this.historyStart) await this.historyStart;
      await Promise.allSettled([...this.activeOperations]);
      if (this.startDone) await this.startDone;
      const sender = this.sender;
      this.sender = null;
      this.actions = null;
      this.automatic = null;
      if (sender) await sender.close();
    })();
    this.closing = closing;
    return closing;
  }
}
