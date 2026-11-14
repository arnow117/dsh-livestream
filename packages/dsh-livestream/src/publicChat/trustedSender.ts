import { pathToFileURL, fileURLToPath } from 'node:url';
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
    buildDigest: string; instanceId: string; accountRecordId: string; expectedPrincipalUid: string; roomId: string;
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
    buildDigest: string; instanceId: string; accountRecordId: string; expectedPrincipalUid: string; roomId: string;
  }): Promise<MaintenanceReferences>;
  releaseReferences?(): void;
}

/** One controller owns this journal throughout the host's lifetime. */
export class TrustedHistory {
  private client: SenderClient | null = null;
  private readonly pending = new Set<Promise<unknown>>();
  readonly controller: PublicChatSendController;
  readonly journal: FrozenPublicChatOperationJournal;

  constructor(readonly references: TrustedHistoryReferences, readonly loaded: LoadedSender,
    readonly deployment: ReturnType<typeof readSenderDeploymentFile>) {
    const identity = this.identity();
    this.journal = new loaded.FrozenPublicChatOperationJournal(deployment.dataDir);
    if (this.journal.corrupt) throw new Error('公屏操作日志不可用');
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
    this.controller = new loaded.PublicChatSendController({ deployment: identity, gateway, journal: this.journal });
  }

  identity() {
    const { instanceId, accountRecordId, expectedPrincipalUid, roomId } = this.deployment;
    return { buildDigest: this.loaded.buildDigest, instanceId, accountRecordId, expectedPrincipalUid, roomId };
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
      if (!context || !controller?.ownsPendingRecoveryInvalidation(context.recoveryControlId, context.recoveryPayloadHash)) {
        controller?.revokeGrant('sender-connection-change');
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
    service = new loaded.SenderService({ runtime, deployment: { ...deployment, schemaVersion: 1 }, token: deployment.token });
    const origin = await service.start();
    client = new loaded.SenderClient({ url: origin, token: deployment.token,
      expected: { buildDigest: loaded.buildDigest, instanceId: deployment.instanceId } });
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
    buildDigest: string; instanceId: string; accountRecordId: string; expectedPrincipalUid: string; roomId: string;
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
