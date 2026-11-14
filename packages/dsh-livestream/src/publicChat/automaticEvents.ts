import { createHash } from 'node:crypto';
import type { LiveEvent } from '../core/live';
import type { RawObservation } from './frozenSenderRuntime';
import type { TrustedSender } from './trustedSender';
import { OutputPolicyEngine, GIFT_MERGE_WINDOW_MS } from './welcomeThanks';
import { RAW_FUTURE_DRIFT_MS, RAW_PROOF_WINDOW_MS } from './rawProof';

type Reference = NonNullable<ReturnType<TrustedSender['input']['reference']>>;
type Pending = { event: LiveEvent; reference: Reference; receivedAt: number };
type Paired = Pending & { proof: RawObservation };

/** 成对保留两个真实来源；最终发送仍由 Controller 和 sender 再核原 raw。 */
export class PublicChatAutomaticEvents {
  private readonly policy = new OutputPolicyEngine();
  private readonly sources = new Map<string, Pending>();
  private readonly raw = new Map<string, RawObservation>();
  private readonly seen = new Map<string, number>();
  private readonly gifts = new Map<string, { items: Paired[]; dueAt: number }>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly sender: TrustedSender,
    private readonly enabled: (kind: 'welcome' | 'thanks') => boolean) {}

  private key(rawType: string, rawId: string, grantId: string): string {
    return JSON.stringify([rawType, rawId, grantId]);
  }

  original(event: LiveEvent): void {
    const kind = event.kind === 'enter' ? 'welcome' : event.kind === 'gift' ? 'thanks' : null;
    if (!kind || !this.enabled(kind)) return;
    const reference = this.sender.input.reference(event);
    if (!reference || !event.user.id) return;
    const now = Date.now();
    this.prune(now);
    const identity = JSON.stringify([reference.liveEpoch, reference.inputConnectionGeneration, reference.rawType, reference.rawId]);
    if (this.seen.has(identity) || this.seen.size >= 1024 || this.sources.size >= 512) return;
    this.seen.set(identity, now + RAW_PROOF_WINDOW_MS + RAW_FUTURE_DRIFT_MS);
    const key = this.key(reference.rawType, reference.rawId, reference.grantId);
    this.sources.set(key, { event, reference, receivedAt: now });
    this.pair(key);
  }

  observed(proof: RawObservation): void {
    const now = Date.now();
    this.prune(now);
    if (this.raw.size >= 512) return;
    const key = this.key(proof.rawType, proof.rawId, proof.grantId);
    this.raw.set(key, proof);
    this.pair(key);
  }

  private valid(pair: Paired, now: number): boolean {
    const grant = this.sender.controller.currentFrozenGrant();
    const { reference, proof } = pair;
    return reference.valid() && !!grant && proof.grantId === grant.grantId && reference.grantId === grant.grantId
      && proof.rawId === reference.rawId && proof.rawType === reference.rawType && proof.roomId === grant.roomId
      && proof.liveEpoch === grant.liveEpoch && proof.rawSourceSessionId === grant.rawSourceSessionId
      && proof.rawSourceConnectionGeneration === grant.rawSourceConnectionGeneration
      && proof.platformTsMs >= Math.max(grant.authorizedAtMs, grant.liveEpochStartedAtMs)
      && proof.platformTsMs <= now + RAW_FUTURE_DRIFT_MS && now - proof.platformTsMs <= RAW_PROOF_WINDOW_MS
      && proof.receivedAt <= now && now - proof.receivedAt <= RAW_PROOF_WINDOW_MS;
  }

  private pair(key: string): void {
    const source = this.sources.get(key);
    const proof = this.raw.get(key);
    if (!source || !proof) return;
    this.sources.delete(key);
    this.raw.delete(key);
    const pair = { ...source, proof };
    const now = Date.now();
    if (!this.valid(pair, now)) return;
    const grant = this.sender.controller.currentFrozenGrant();
    if (!grant) return;
    const base = { userId: pair.event.user.id, displayNameRaw: pair.event.user.name,
      rawProofOk: true, epoch: grant.liveEpoch, grantId: grant.grantId };
    if (pair.event.kind === 'enter') {
      if (!this.enabled('welcome')) return;
      const decision = this.policy.planWelcome(base, now);
      if (decision.send && decision.text) this.submit(pair, decision.text);
    } else if (pair.event.kind === 'gift') {
      if (!this.enabled('thanks')) return;
      this.flush(now);
      const group = JSON.stringify([grant.liveEpoch, grant.grantId, pair.event.user.id]);
      const result = this.policy.mergeGiftIncrement({ ...base, giftNameRaw: pair.event.giftName, delta: pair.event.count }, now);
      if (!result.accepted) return;
      const batch = result.reason === 'opened' ? { items: [], dueAt: now + GIFT_MERGE_WINDOW_MS } : this.gifts.get(group);
      if (!batch) return;
      batch.items.push(pair);
      this.gifts.set(group, batch);
      this.schedule(now);
    }
  }

  private submit(pair: Paired, text: string): void {
    if (!this.valid(pair, Date.now())) return;
    const ref = pair.reference;
    const id = createHash('sha256').update(JSON.stringify([ref.liveEpoch, ref.inputConnectionGeneration, ref.rawType, ref.rawId])).digest('hex');
    void this.sender.controller.submit({ requestId: `auto:${id}`, sourceKey: null, text,
      autoEvent: { event: ref.sourceEvent, rawId: ref.rawId, rawType: ref.rawType } });
  }

  private flush(now: number): void {
    for (const entry of this.policy.flushDueGiftEntries(now)) {
      const items = this.gifts.get(entry.key)?.items ?? [];
      this.gifts.delete(entry.key);
      if (!this.enabled('thanks') || !entry.decision.send || !entry.decision.text || items.length === 0
        || items.some((item) => !this.valid(item, now))) continue;
      this.submit(items[0], entry.decision.text);
    }
    this.schedule(now);
  }

  private schedule(now: number): void {
    if (this.timer || !this.gifts.size) return;
    const dueAt = Math.min(...[...this.gifts.values()].map((batch) => batch.dueAt));
    this.timer = setTimeout(() => { this.timer = null; this.flush(Date.now()); }, Math.max(0, dueAt - now));
  }

  private prune(now: number): void {
    for (const [key, value] of this.seen) if (value < now) this.seen.delete(key);
    for (const [key, value] of this.sources) if (now - value.receivedAt > RAW_PROOF_WINDOW_MS) this.sources.delete(key);
    for (const [key, value] of this.raw) if (now - value.receivedAt > RAW_PROOF_WINDOW_MS) this.raw.delete(key);
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.sources.clear();
    this.raw.clear();
    for (const batch of this.gifts.values()) {
      const first = batch.items[0];
      if (first) this.policy.resetForScope(first.reference.liveEpoch, first.reference.grantId);
    }
    this.gifts.clear();
  }
}
