import type { PublicChatSendController } from './controller';
import { messageReference } from './frozenJournal';
import { controlPayloadHash } from './grantAuthority';

function exactObject(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** 仅注册到经过 connection SDK owner 验证的宿主路由。 */
export class PublicChatOwnerActions {
  constructor(private readonly controller: PublicChatSendController, private readonly enabled: () => boolean) {}

  view() {
    return {
      hold: this.controller.hold,
      grant: this.controller.currentFrozenGrant(),
      messages: this.controller.listFrozenOperations(),
      controls: this.controller.listFrozenControls(),
    };
  }

  async qualify() {
    if (!this.enabled()) return { ok: false, reason: 'disabled-or-invalid-target' };
    return this.controller.refreshQualification();
  }

  async authorize() {
    if (!this.enabled()) return { ok: false, reason: 'disabled-or-invalid-target' };
    return this.controller.authorize();
  }

  revoke(): void {
    this.controller.revokeGrant('owner-revoke');
  }

  async sendManual(input: unknown) {
    if (!this.enabled()) return { status: 'rejected' as const, reason: 'disabled-or-invalid-target' };
    if (!exactObject(input, ['requestId', 'text']) || typeof input.requestId !== 'string' || typeof input.text !== 'string') {
      return { status: 'rejected' as const, reason: 'invalid-input' };
    }
    return this.controller.submit({ requestId: input.requestId, sourceKey: null, text: input.text });
  }

  recordFact(input: unknown) {
    if (!exactObject(input, ['requestId', 'fact']) || typeof input.requestId !== 'string') {
      return { ok: false as const, error: 'invalid-input' };
    }
    const original = this.controller.frozenOperationView(input.requestId);
    if (!original) return { ok: false as const, error: 'original-operation-unavailable' };
    const grant = original.grant;
    let factId: string;
    try {
      factId = `fact:${controlPayloadHash({ requestId: original.requestId, fact: input.fact })}`;
    } catch {
      return { ok: false as const, error: 'invalid-input' };
    }
    return this.controller.recordVerificationFact({ requestId: original.requestId, principalUid: grant.principalUid,
      roomId: grant.roomId, grantId: grant.grantId, liveEpoch: grant.liveEpoch,
      inputConnectionGeneration: grant.inputConnectionGeneration, ref: messageReference(original), factId,
      observationSource: { source: 'owner', observerRef: null }, fact: input.fact });
  }

  async reconcileMessage(input: unknown) {
    if (!exactObject(input, ['requestId']) || typeof input.requestId !== 'string') return { ok: false, reason: 'invalid-input' };
    return this.controller.reconcileFrozenMessage(input.requestId);
  }

  async reconcileControl(input: unknown) {
    if (!exactObject(input, ['controlId']) || typeof input.controlId !== 'string') return { ok: false, reason: 'invalid-input' };
    return this.controller.reconcileControl(input.controlId);
  }
}
