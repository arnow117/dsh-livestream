import type { LiveConnectionState, LiveEvent } from '../core/live';
import type { SourceIngress } from './sourceIngress';
import type { TrustedHistory, TrustedSender, TrustedSessionAuthentication } from './trustedSender';
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
  private session: TrustedSessionAuthentication | null = null;
  private sessionPreparation: Promise<TrustedSessionAuthentication | null> | null = null;
  private sessionRetirement: Promise<void> = Promise.resolve();
  private sessionEpoch = 0;
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
    private readonly automaticEnabled: (kind: 'welcome' | 'thanks') => boolean,
    private readonly savedRoom: () => string | null = () => null) {}

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
    this.retireSession();
  }

  private retireSession(): void {
    this.sessionEpoch++;
    const session = this.session;
    this.session = null;
    if (session) this.sessionRetirement = this.sessionRetirement.then(() => session.close());
  }

  invalidateReplies(): void {
    if (this.closed) return;
    this.turns.invalidate();
    (this.history?.controller ?? this.sender?.controller)?.invalidateChannel('reply');
  }

  invalidateAutomatic(kind: 'welcome' | 'thanks'): void {
    if (this.closed) return;
    this.automatic?.clear(kind);
    (this.history?.controller ?? this.sender?.controller)?.invalidateChannel(kind);
  }

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
        if (this.sessionPreparation) await this.sessionPreparation;
        const history = this.session ? this.session.openHistory() : await openTrustedHistory(refs, () => !this.closed);
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

  private async inspectSession(): Promise<TrustedSessionAuthentication | null> {
    if (this.closed) return null;
    if (this.session) return this.session;
    if (this.sessionPreparation) return this.sessionPreparation;
    const refs = trustedReferencesFromEnvironment(process.env, 'session_http');
    const room = this.savedRoom();
    if (!refs || !room) return null;
    const epoch = this.sessionEpoch;
    const current = () => !this.closed && this.sessionEpoch === epoch && this.savedRoom() === room;
    const pending = (async () => {
      try {
        await this.sessionRetirement;
        if (!current()) return null;
        const { inspectTrustedSession } = await import('./trustedSender');
        const session = await inspectTrustedSession(refs, room, current, this.history ?? undefined);
        if (!current()) { await session.close(); return null; }
        this.session = session;
        return session;
      } catch { return null; }
    })();
    this.sessionPreparation = pending;
    try { return await pending; } finally { if (this.sessionPreparation === pending) this.sessionPreparation = null; }
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
      const inspected = await this.inspectSession();
      const session = inspected && inspected.deployment.roomId === this.savedRoom() ? inspected : null;
      return { available: false, historyAvailable: false, starting: this.starting,
        identity: session ? { accountRecordId: session.deployment.accountRecordId, roomId: session.deployment.roomId,
          principalUid: null, platformRoomId: null, qualified: false } : null,
        transportKind: session ? 'session_http' as const : undefined,
        login: session ? (await session.loginStatus()) ?? { state: 'idle' as const, revision: 0 } : null,
        hold: true, grant: null, messages: [], controls: [] };
    }
    const sessionMode = history.deployment?.schemaVersion === 2;
    const login = sessionMode ? (await (this.sender?.sessionLoginStatus() ?? this.session?.loginStatus())) ?? { state: 'idle', revision: 0 } : null;
    const savedRoom = this.savedRoom();
    const target = sessionMode && savedRoom && history.deployment.roomId === savedRoom
      ? { accountRecordId: history.deployment.accountRecordId, roomId: history.deployment.roomId,
        principalUid: null, platformRoomId: null, qualified: false }
      : null;
    return { available: !!this.sender, historyAvailable: true, starting: this.starting,
      transportKind: sessionMode ? 'session_http' as const : 'frozen_http' as const, login,
      liveConnected: this.connected && !!this.scope && this.scope.roomId === this.savedRoom(),
      identity: this.sender?.publicView() ?? target, ...this.actions.view() };
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
    if (this.session) {
      const history = await this.ensureHistory();
      if (!history) return { ok: false, reason: 'history-unavailable' };
      try {
        const sender = this.session.attach(history);
        sender.input.setLive(this.scope);
        sender.input.inputStateChanged('connected', 'idle');
        this.attachSender(sender);
        return await sender.maintain();
      } catch { return { ok: false, reason: 'session-unavailable' }; }
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
      this.attachSender(sender);
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

  private attachSender(sender: TrustedSender): void {
    this.sender = sender;
    this.automatic = new PublicChatAutomaticEvents(sender, (kind) => this.enabled() && this.automaticEnabled(kind));
    const automatic = this.automatic;
    sender.observeRaw((observation) => automatic.observed(observation));
    sender.observeInvalidation(() => {
      this.revision++;
      this.turns.invalidate();
      automatic.clear();
    });
  }

  async loginStart() {
    if (this.closed) return { ok: false, reason: 'session-unavailable' };
    const pending = (async () => {
      if (this.sender) return this.sender.sessionLoginStart();
      if (this.starting) return { ok: false, reason: 'sender-busy' };
      this.starting = true;
      let finishStart!: () => void;
      this.startDone = new Promise<void>((resolve) => { finishStart = resolve; });
      try {
        await this.ensureHistory();
        const session = await this.inspectSession();
        if (!session || this.closed) return { ok: false, reason: 'session-unavailable' };
        const existing = await session.loginStatus();
        if (!existing) await session.start();
        return await session.loginStart();
      } catch {
        this.retireSession();
        return { ok: false, reason: 'session-unavailable' };
      } finally {
        this.starting = false;
        finishStart();
        this.startDone = null;
      }
    })();
    this.activeOperations.add(pending);
    try { return await pending; } finally { this.activeOperations.delete(pending); }
  }

  async loginCancel(input: unknown) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).sort().join(',') !== 'attemptId,revision') return { ok: false, reason: 'invalid-input' };
    const value = input as { attemptId?: unknown; revision?: unknown };
    if (typeof value.attemptId !== 'string' || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision)) return { ok: false, reason: 'invalid-input' };
    return this.sender?.sessionLoginCancel(value.attemptId, value.revision) ?? this.session?.loginCancel(value.attemptId, value.revision) ?? { ok: false, reason: 'session-unavailable' };
  }

  async confirmSession(input: unknown) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).join(',') !== 'bindingRef') return { ok: false, reason: 'invalid-input' };
    const value = input as { bindingRef?: unknown };
    const room = this.sender?.publicView().roomId ?? this.session?.deployment.roomId;
    if (typeof value.bindingRef !== 'string' || !room || room !== this.savedRoom()) return { ok: false, reason: 'saved-room-mismatch' };
    return this.sender?.sessionConfirm(value.bindingRef) ?? this.session?.confirm(value.bindingRef) ?? { ok: false, reason: 'session-unavailable' };
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
      if (this.sessionPreparation) await this.sessionPreparation;
      const sender = this.sender;
      this.sender = null;
      this.actions = null;
      this.automatic = null;
      if (sender) await sender.close();
      this.retireSession();
      await this.sessionRetirement;
    })();
    this.closing = closing;
    return closing;
  }
}
