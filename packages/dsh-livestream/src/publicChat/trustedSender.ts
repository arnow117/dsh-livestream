import { pathToFileURL, fileURLToPath } from 'node:url';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import type { PublicChatSendController } from './controller';
import type { FrozenPublicChatOperationJournal } from './frozenJournal';
import type { FrozenSenderRuntime, RawObservation } from './frozenSenderRuntime';
import type { HelperLaunchOptions, HelperProcess } from './helperLauncher';
import type { SenderService } from './senderService';
import type { SenderClient, readSenderDeploymentFile } from './senderClient';
import type { PublicChatInputBinding } from './inputBinding';
import type { createPublicChatReplyTool, AgentReplyTurnContext } from './agentReplyTool';
import type { TrustedHistoryReferences } from './trustedReferences';

type MaintenanceReferences = Omit<HelperLaunchOptions, 'authContextRevision' | 'onDisconnect'>;
type LoadedSender = {
  buildDigest: string;
  readSenderDeploymentFile: typeof readSenderDeploymentFile;
  FrozenSenderRuntime: new (options: { deployment: {
    buildDigest: string; instanceId: string; accountRecordId: string; expectedPrincipalUid: string | null; transportKind?: 'frozen_http' | 'session_http'; roomId: string;
  }; launch: (options: HelperLaunchOptions) => Promise<HelperProcess>;
    onInvalidated: (context?: { recoveryControlId: string; recoveryPayloadHash: string }) => void;
    onRawObserved: (observation: RawObservation) => void }) => FrozenSenderRuntime;
  SenderService: typeof SenderService;
  SenderClient: typeof SenderClient;
  FrozenPublicChatOperationJournal: typeof FrozenPublicChatOperationJournal;
  PublicChatSendController: typeof PublicChatSendController;
  PublicChatInputBinding: new (controller: PublicChatSendController, runtime: FrozenSenderRuntime) => PublicChatInputBinding;
  createPublicChatReplyTool: typeof createPublicChatReplyTool;
  launchHelper(options: HelperLaunchOptions): Promise<HelperProcess>;
  createFixedRawSession(options: { roomId: string; runtime: FrozenSenderRuntime; executablePath: string }): {
    start(): Promise<void>; stop(): Promise<void>;
  };
};

/** 仅受信宿主提供，不作为普通设置或模型工具参数。 */
export interface TrustedSenderReferences {
  senderBuildDeploymentFile: string;
  senderDeploymentFile: string;
  browserExecutable: string;
  helperReferences(senderProcessNonce: string, authContextRevision: number, identity: {
    buildDigest: string; instanceId: string; accountRecordId: string; expectedPrincipalUid: string | null; transportKind?: 'frozen_http' | 'session_http'; roomId: string;
  }): Promise<MaintenanceReferences>;
  releaseReferences?(): void;
}

/** One controller owns this journal throughout the host's lifetime. */
export class TrustedHistory {
  private client: SenderClient | null = null;
  private readonly pending = new Set<Promise<unknown>>();
  readonly controller: PublicChatSendController;
  readonly journal: FrozenPublicChatOperationJournal;
  private readonly currentIdentity: import('./controller').ControllerDeployment;

  constructor(readonly references: TrustedHistoryReferences, readonly loaded: LoadedSender,
    readonly deployment: ReturnType<typeof readSenderDeploymentFile>,
    sharedIdentity?: import('./controller').ControllerDeployment) {
    const identity = { buildDigest: loaded.buildDigest, instanceId: deployment.instanceId,
      accountRecordId: deployment.accountRecordId, roomId: deployment.roomId,
      expectedPrincipalUid: deployment.schemaVersion === 1 ? deployment.expectedPrincipalUid : null,
      transportKind: deployment.schemaVersion === 1 ? 'frozen_http' as const : 'session_http' as const };
    if (sharedIdentity && (sharedIdentity.buildDigest !== identity.buildDigest || sharedIdentity.instanceId !== identity.instanceId ||
      sharedIdentity.accountRecordId !== identity.accountRecordId || sharedIdentity.roomId !== identity.roomId ||
      sharedIdentity.transportKind !== identity.transportKind)) throw new Error('session deployment changed');
    this.currentIdentity = sharedIdentity ?? identity;
    const journalPath = join(deployment.dataDir, 'public-chat-operations.json');
    const before = lstatSync(journalPath);
    this.journal = new loaded.FrozenPublicChatOperationJournal(deployment.dataDir);
    const after = lstatSync(journalPath);
    if (this.journal.corrupt || !before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
      before.dev !== after.dev || before.ino !== after.ino) throw new Error('公屏操作日志不可用');
    const gateway = new Proxy(Object.create(null), {
      get: (_target, property) => {
        if (typeof property !== 'string' || property === 'then') return undefined;
        return (...args: unknown[]) => {
          const client = this.client;
          const method = client && (client as unknown as Record<string, unknown>)[property];
          if (typeof method !== 'function') {
            return Promise.resolve({ ok: false, error: 'sender-unavailable', untrusted: false });
          }
          const call = Promise.resolve().then(() => method.apply(client, args));
          this.pending.add(call);
          void call.then(() => this.pending.delete(call), () => this.pending.delete(call));
          return call;
        };
      },
    }) as ConstructorParameters<typeof PublicChatSendController>[0]['gateway'];
    this.controller = new loaded.PublicChatSendController({ deployment: this.currentIdentity, gateway, journal: this.journal });
  }

  identity() {
    return this.currentIdentity;
  }

  attach(client: SenderClient): void {
    if (this.client) throw new Error('sender already attached');
    this.client = client;
  }

  detach(client: SenderClient): void {
    if (this.client === client) this.client = null;
  }

  async drain(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
    await Promise.resolve();
  }
}

/** Verify the production bundle before opening the journal; no helper or material is opened. */
export async function openTrustedHistory(refs: TrustedHistoryReferences, isCurrent: () => boolean = () => true): Promise<TrustedHistory> {
  const loaderPath = fileURLToPath(new URL('./dyhub/verified_sender_loader.mjs', import.meta.url));
  const loader = await import(/* @vite-ignore */ pathToFileURL(loaderPath).href) as {
    loadVerifiedSender(path: string): Promise<LoadedSender>;
  };
  const loaded = await loader.loadVerifiedSender(refs.senderBuildDeploymentFile);
  if (!isCurrent()) throw new Error('host closed');
  const deployment = loaded.readSenderDeploymentFile(refs.senderDeploymentFile);
  if (deployment.buildDigest !== loaded.buildDigest) throw new Error('受信部署构建不匹配');
  return new TrustedHistory(refs, loaded, deployment);
}

/** Verified session preparation owns the same runtime until it is attached to history. */
export class TrustedSessionAuthentication {
  private readonly identity: import('./controller').ControllerDeployment;
  private readonly helpers = new Set<HelperProcess>();
  private readonly rawObserver: { current: ((observation: RawObservation) => void) | null } = { current: null };
  private readonly lifecycle: { invalidated: (() => void) | null; needsRawRestart: boolean } = { invalidated: null, needsRawRestart: false };
  private readonly runtime: FrozenSenderRuntime;
  private service: SenderService | null = null;
  private client: SenderClient | null = null;
  private controller: PublicChatSendController | null = null;
  private started = false;
  private transferred = false;
  private closed = false;

  constructor(readonly references: TrustedSenderReferences, private readonly loaded: LoadedSender,
    readonly deployment: ReturnType<typeof readSenderDeploymentFile>, private readonly isCurrent: () => boolean,
    sharedIdentity?: import('./controller').ControllerDeployment) {
    this.identity = sharedIdentity ?? { buildDigest: loaded.buildDigest, instanceId: deployment.instanceId, accountRecordId: deployment.accountRecordId,
      roomId: deployment.roomId, expectedPrincipalUid: null, transportKind: 'session_http' };
    this.runtime = new loaded.FrozenSenderRuntime({ deployment: this.identity,
      onInvalidated: (context) => {
        this.lifecycle.needsRawRestart = true;
        const controller = this.controller;
        if (controller && (!context || !controller.ownsPendingRecoveryInvalidation(context.recoveryControlId, context.recoveryPayloadHash)) &&
          controller.hasCurrentFrozenAuthority()) controller.revokeGrant('sender-connection-change');
        this.lifecycle.invalidated?.();
      },
      onRawObserved: (observation) => this.rawObserver.current?.(observation),
      launch: async (options) => {
        if (this.closed || !this.isCurrent()) throw new Error('session target changed');
        const helper = await loaded.launchHelper(options);
        this.helpers.add(helper);
        if (this.closed || !this.isCurrent()) throw new Error('session target changed');
        return helper;
      } });
  }

  openHistory(): TrustedHistory {
    if (this.closed || !this.isCurrent()) throw new Error('session target changed');
    const current = this.loaded.readSenderDeploymentFile(this.references.senderDeploymentFile);
    if (JSON.stringify(current) !== JSON.stringify(this.deployment)) throw new Error('session deployment changed');
    return new TrustedHistory(this.references, this.loaded, this.deployment, this.identity);
  }

  async start(): Promise<void> {
    if (this.started || this.closed || !this.isCurrent()) throw new Error('session unavailable');
    try {
      // Reserve the existing fixed sender endpoint before starting a helper.
      // A previous holder therefore prevents another authentication instance.
      this.service = new this.loaded.SenderService({ runtime: this.runtime, deployment: this.deployment,
        token: this.deployment.token, allowSessionPreparation: true });
      const origin = await this.service.start();
      if (this.closed || !this.isCurrent()) throw new Error('session target changed');
      this.client = new this.loaded.SenderClient({ url: origin, token: this.deployment.token,
        expected: { buildDigest: this.loaded.buildDigest, instanceId: this.deployment.instanceId, transportKind: 'session_http' } });
      let maintained: { ok: boolean; reason: string };
      try {
        maintained = await this.runtime.beginAuthenticationMaintenance(async (revision) => {
          if (this.closed || !this.isCurrent()) throw new Error('session target changed');
          return this.references.helperReferences(this.runtime.processNonce, revision, this.identity);
        });
      } finally {
        this.references.releaseReferences?.();
      }
      if (!maintained.ok || this.closed || !this.isCurrent()) throw new Error('session unavailable');
      this.started = true;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  loginStatus() { return this.runtime.sessionLoginStatus(); }
  loginStart() { return this.runtime.sessionLoginStart(); }
  loginCancel(id: string, revision: number) { return this.runtime.sessionLoginCancel(id, revision); }
  confirm(bindingRef: string) { return this.runtime.sessionConfirm(bindingRef); }

  attach(history: TrustedHistory): TrustedSender {
    if (!this.started || this.closed || this.transferred || !this.isCurrent() || !this.service || !this.client ||
      history.loaded !== this.loaded || history.identity() !== this.identity ||
      JSON.stringify(this.loaded.readSenderDeploymentFile(this.references.senderDeploymentFile)) !== JSON.stringify(this.deployment)) {
      throw new Error('session attachment unavailable');
    }
    const raw = this.loaded.createFixedRawSession({ roomId: this.deployment.roomId, runtime: this.runtime,
      executablePath: this.references.browserExecutable });
    const input = new this.loaded.PublicChatInputBinding(history.controller, this.runtime);
    history.attach(this.client);
    this.controller = history.controller;
    this.transferred = true;
    return new TrustedSender(this.references, this.identity, this.runtime, this.service, raw, history.controller,
      history.journal, this.helpers, input, this.loaded.createPublicChatReplyTool, this.rawObserver, this.lifecycle, history, this.client);
  }

  async close(): Promise<void> {
    if (this.closed || this.transferred) return;
    this.closed = true;
    this.runtime.cancelAuthenticationMaintenance();
    try {
      for (const helper of this.helpers) await helper.close();
    } finally {
      if (this.service) await this.service.close();
    }
  }
}

export async function inspectTrustedSession(refs: TrustedSenderReferences, room: string,
  isCurrent: () => boolean, history?: TrustedHistory): Promise<TrustedSessionAuthentication> {
  const loaderPath = fileURLToPath(new URL('./dyhub/verified_sender_loader.mjs', import.meta.url));
  const loader = await import(/* @vite-ignore */ pathToFileURL(loaderPath).href) as {
    loadVerifiedSender(path: string): Promise<LoadedSender>;
  };
  if (history && (history.references.senderBuildDeploymentFile !== refs.senderBuildDeploymentFile ||
    history.references.senderDeploymentFile !== refs.senderDeploymentFile)) throw new Error('session deployment changed');
  const loaded = history?.loaded ?? await loader.loadVerifiedSender(refs.senderBuildDeploymentFile);
  if (!isCurrent()) throw new Error('session target changed');
  const deployment = loaded.readSenderDeploymentFile(refs.senderDeploymentFile);
  if (deployment.schemaVersion !== 2 || deployment.buildDigest !== loaded.buildDigest || deployment.roomId !== room) {
    throw new Error('session deployment unavailable');
  }
  if (history && JSON.stringify(history.deployment) !== JSON.stringify(deployment)) throw new Error('session deployment changed');
  return new TrustedSessionAuthentication(refs, loaded, deployment, isCurrent, history?.identity());
}

/** 仅显式主人维护操作调用；复用历史控制器，再启动 helper 和 Service。 */
export async function startTrustedSender(refs: TrustedSenderReferences, currentRoomId: string,
  existingHistory?: TrustedHistory, isCurrent: () => boolean = () => true,
  isHostOpen: () => boolean = () => true): Promise<TrustedSender> {
  const history = existingHistory ?? await openTrustedHistory(refs, isCurrent);
  if (history.references.senderBuildDeploymentFile !== refs.senderBuildDeploymentFile ||
    history.references.senderDeploymentFile !== refs.senderDeploymentFile) throw new Error('受信部署引用已变化');
  const { loaded, deployment } = history;
  const currentDeployment = loaded.readSenderDeploymentFile(refs.senderDeploymentFile);
  if (JSON.stringify(currentDeployment) !== JSON.stringify(deployment) || deployment.roomId !== currentRoomId) {
    throw new Error('受信部署或房间不匹配');
  }
  const identity = history.identity();
  const ownedHelpers = new Set<HelperProcess>();
  const controller = history.controller;
  let initialized = false;
  const canLaunch = () => isHostOpen() && (initialized || isCurrent());
  const rawObserver: { current: ((observation: RawObservation) => void) | null } = { current: null };
  const lifecycle: { invalidated: (() => void) | null; needsRawRestart: boolean } = { invalidated: null, needsRawRestart: false };
  const runtime = new loaded.FrozenSenderRuntime({ deployment: identity,
    onInvalidated: (context) => {
      lifecycle.needsRawRestart = true;
      if ((!context || !controller?.ownsPendingRecoveryInvalidation(context.recoveryControlId, context.recoveryPayloadHash)) &&
        (identity.transportKind !== 'session_http' || controller.hasCurrentFrozenAuthority())) {
        controller.revokeGrant('sender-connection-change');
      }
      lifecycle.invalidated?.();
    },
    onRawObserved: (observation) => rawObserver.current?.(observation), launch: async (options) => {
      if (!canLaunch()) throw new Error('host closed');
      const helper = await loaded.launchHelper(options);
      ownedHelpers.add(helper);
      if (!canLaunch()) throw new Error('host closed');
      return helper;
    } });
  let service: SenderService | null = null;
  let raw: ReturnType<LoadedSender['createFixedRawSession']> | null = null;
  let client: SenderClient | null = null;
  try {
    let maintained: { ok: boolean; reason: string };
    try {
      maintained = await runtime.beginAuthenticationMaintenance(async (revision) => {
        if (!isCurrent()) throw new Error('host closed');
        const options = await refs.helperReferences(runtime.processNonce, revision, identity);
        if (!isCurrent()) throw new Error('host closed');
        return options;
      });
    } finally {
      refs.releaseReferences?.();
    }
    if (!maintained.ok || !isCurrent()) throw new Error('sender maintenance unavailable');
    service = new loaded.SenderService({ runtime, deployment, token: deployment.token });
    const origin = await service.start();
    client = new loaded.SenderClient({ url: origin, token: deployment.token,
      expected: { buildDigest: loaded.buildDigest, instanceId: deployment.instanceId, transportKind: identity.transportKind } });
    if (!isCurrent()) throw new Error('host closed');
    history.attach(client);
    raw = loaded.createFixedRawSession({ roomId: deployment.roomId, runtime, executablePath: refs.browserExecutable });
    const input = new loaded.PublicChatInputBinding(controller, runtime);
    const sender = new TrustedSender(refs, identity, runtime, service, raw, controller, history.journal, ownedHelpers, input,
      loaded.createPublicChatReplyTool, rawObserver, lifecycle, history, client);
    initialized = true;
    return sender;
  } catch (error) {
    if (client) {
      history.detach(client);
      await history.drain();
    }
    if (raw) await raw.stop();
    runtime.cancelAuthenticationMaintenance();
    for (const helper of ownedHelpers) await helper.close();
    if (service) await service.close();
    throw error;
  }
}

export class TrustedSender {
  private starting: Promise<void> | null = null;
  private stopped = false;
  private rawStarted = false;

  constructor(private readonly refs: TrustedSenderReferences, private readonly identity: {
    buildDigest: string; instanceId: string; accountRecordId: string; expectedPrincipalUid: string | null; transportKind?: 'frozen_http' | 'session_http'; roomId: string;
  }, private readonly runtime: FrozenSenderRuntime,
    private readonly service: SenderService, private readonly raw: { start(): Promise<void>; stop(): Promise<void> },
    readonly controller: PublicChatSendController, readonly journal: FrozenPublicChatOperationJournal,
    private readonly helpers: Set<HelperProcess>, readonly input: PublicChatInputBinding,
    private readonly createReplyTool: typeof createPublicChatReplyTool,
    private readonly rawObserver: { current: ((observation: RawObservation) => void) | null },
    private readonly lifecycle: { invalidated: (() => void) | null; needsRawRestart: boolean },
    private readonly history: TrustedHistory, private readonly client: SenderClient) {}

  observeRaw(listener: ((observation: RawObservation) => void) | null): void {
    this.rawObserver.current = listener;
  }

  observeInvalidation(listener: (() => void) | null): void { this.lifecycle.invalidated = listener; }

  publicView() {
    const state = this.runtime.state();
    return {
      accountRecordId: this.identity.accountRecordId,
      roomId: this.identity.roomId,
      principalUid: state.qualification?.principalUid ?? null,
      platformRoomId: state.raw?.proof?.platformRoomId ?? null,
      qualified: state.qualification !== null,
    };
  }

  sessionLoginStatus() { return this.runtime.sessionLoginStatus(); }
  sessionLoginStart() { return this.runtime.sessionLoginStart(); }
  sessionLoginCancel(attemptId: string, revision: number) { return this.runtime.sessionLoginCancel(attemptId, revision); }
  sessionConfirm(bindingRef: string) { return this.runtime.sessionConfirm(bindingRef); }

  async reply(context: AgentReplyTurnContext & { valid(): boolean }, text: unknown) {
    const reference = this.input.reference(context.sourceEvent);
    if (!reference || !context.valid()) return { status: 'rejected' as const, reason: 'event-unavailable' };
    const tool = this.createReplyTool({ controller: this.controller,
      getTurnContext: () => context.valid() && reference.valid() ? context : null,
      liveEpoch: () => reference.liveEpoch, sourceConnectionToken: () => reference.sourceConnectionToken });
    return tool.execute({ text });
  }

  /** 完成宿主的真实 live/input 同步后，再建立固定房间的只读 raw 来源。 */
  async startRaw(): Promise<void> {
    if (this.stopped || this.starting || this.rawStarted) throw new Error('sender raw unavailable');
    const task = (async () => {
      await this.raw.start();
      if (this.stopped) throw new Error('sender stopped');
      this.rawStarted = true;
      this.lifecycle.needsRawRestart = false;
    })();
    this.starting = task;
    try {
      await task;
    } finally {
      this.starting = null;
    }
  }

  /** 显式维护才启动 raw source 与认证 helper。 */
  async maintain(): Promise<{ ok: boolean; reason: string }> {
    if (this.stopped || this.starting) return { ok: false, reason: 'sender-unavailable' };
    if (this.identity.transportKind === 'session_http') {
      const login = await this.runtime.sessionLoginStatus();
      if (login?.state !== 'authenticated') return { ok: false, reason: 'session-unavailable' };
      try {
        if (this.rawStarted && this.lifecycle.needsRawRestart) { await this.raw.stop(); this.rawStarted = false; }
        if (!this.rawStarted) await this.startRaw();
        return { ok: true, reason: 'ready' };
      } catch { return { ok: false, reason: 'sender-unavailable' }; }
    }
    this.controller.revokeGrant('login-maintenance-start');
    const maintenance = this.runtime.beginAuthenticationMaintenance((revision) =>
      this.refs.helperReferences(this.runtime.processNonce, revision, this.identity));
    const task = (async () => {
      const result = await maintenance;
      if (!result.ok || this.stopped) throw new Error('sender maintenance unavailable');
      if (this.rawStarted && this.lifecycle.needsRawRestart) {
        await this.raw.stop();
        this.rawStarted = false;
      }
      if (!this.rawStarted) {
        await this.raw.start();
        this.rawStarted = true;
        this.lifecycle.needsRawRestart = false;
      }
      if (this.stopped) throw new Error('sender stopped');
    })();
    this.starting = task;
    try {
      await task;
      return { ok: true, reason: 'ready' };
    } catch {
      return { ok: false, reason: 'sender-unavailable' };
    } finally {
      this.refs.releaseReferences?.();
      this.starting = null;
    }
  }

  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.rawObserver.current = null;
    this.lifecycle.invalidated = null;
    this.controller.revokeGrant('owner-revoke');
    this.runtime.cancelAuthenticationMaintenance();
    await this.history.drain();
    this.history.detach(this.client);
    if (this.starting) await this.starting.catch(() => {});
    try {
      await this.raw.stop();
    } finally {
      try {
        for (const helper of this.helpers) await helper.close();
      } finally {
        await this.service.close();
      }
    }
  }
}
