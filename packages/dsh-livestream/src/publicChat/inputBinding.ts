import type { LiveEvent, LiveConnectionState } from '../core/live';
import type { PublicChatSendController } from './controller';
import type { FrozenSenderRuntime } from './frozenSenderRuntime';
import { registerSourceEventMetadata } from './eventRef';
import type { SourceIngress } from './sourceIngress';

interface LiveScope {
  roomId: string;
  epoch: string;
  startedAtMs: number;
}

interface EventBinding {
  grantId: string;
  token: string;
  inputGeneration: number;
  epoch: string;
  rawId: string;
  rawType: string;
}

/** 内部装配只处理 Hub 原 source 对象；模拟入口不能调用其订阅通道。 */
export class PublicChatInputBinding {
  private live: LiveScope | null = null;
  private connected = false;
  private generation = 0;
  private token = '';
  private readonly seen = new WeakSet<object>();
  private readonly events = new WeakMap<object, EventBinding>();

  constructor(private readonly controller: PublicChatSendController, private readonly sender: FrozenSenderRuntime) {}

  setLive(scope: LiveScope | null): void {
    const valid = scope !== null && /^[0-9]{1,64}$/.test(scope.roomId) && scope.epoch.length > 0
      && scope.epoch.length <= 128 && Number.isSafeInteger(scope.startedAtMs) && scope.startedAtMs > 0;
    if (valid && this.live?.roomId === scope.roomId && this.live.epoch === scope.epoch
      && this.live.startedAtMs === scope.startedAtMs) return;
    this.controller.revokeGrant('live-epoch-changed');
    this.live = valid ? { ...scope } : null;
    if (this.live) this.controller.setLiveEpoch(this.live.epoch, this.live.startedAtMs);
    this.syncSender();
  }

  inputStateChanged(state: LiveConnectionState, previous: LiveConnectionState): void {
    if (state === previous) return;
    this.token = this.controller.advanceInputConnection();
    this.generation++;
    this.connected = state === 'connected';
    this.syncSender();
  }

  private syncSender(): void {
    const scope = this.connected ? this.live : null;
    this.sender.setInputAndLive(this.generation, scope?.epoch ?? null, scope?.startedAtMs ?? 0);
  }

  bindOriginal(event: LiveEvent, ingress: Readonly<SourceIngress>): boolean {
    if (this.seen.has(event)) return false;
    this.seen.add(event);
    const grant = this.controller.currentFrozenGrant();
    if (!this.connected || !this.live || !grant || this.controller.hold || ingress.roomId !== this.live.roomId
      || grant.roomId !== this.live.roomId || grant.liveEpoch !== this.live.epoch
      || grant.inputConnectionGeneration !== this.generation || !this.token) return false;
    registerSourceEventMetadata(event, { rawId: ingress.rawId, rawType: ingress.rawType,
      rawFrameTsUntrusted: ingress.frameTimeUntrusted, receivedAt: ingress.receivedAt,
      sourceConnectionToken: this.token, roomId: ingress.roomId, liveEpoch: this.live.epoch });
    this.events.set(event, { grantId: grant.grantId, token: this.token, inputGeneration: this.generation,
      epoch: this.live.epoch, rawId: ingress.rawId, rawType: ingress.rawType });
    return true;
  }

  stillCurrent(event: object): boolean {
    const binding = this.events.get(event);
    const grant = this.controller.currentFrozenGrant();
    return !!binding && !!grant && !this.controller.hold && this.connected && !!this.live
      && binding.grantId === grant.grantId && binding.token === this.token
      && binding.inputGeneration === this.generation && binding.epoch === this.live.epoch;
  }

  reference(event: object) {
    const binding = this.events.get(event);
    if (!binding || !this.stillCurrent(event)) return null;
    return { sourceEvent: event, rawId: binding.rawId, rawType: binding.rawType,
      inputConnectionGeneration: binding.inputGeneration, sourceConnectionToken: binding.token,
      liveEpoch: binding.epoch, grantId: binding.grantId, valid: () => this.stillCurrent(event) };
  }
}
