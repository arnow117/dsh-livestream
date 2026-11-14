import { describe, expect, it } from 'vitest';
import { PublicChatInputBinding } from '../../src/publicChat/inputBinding';
import { readSourceEventMetadata } from '../../src/publicChat/eventRef';
import type { LiveEvent } from '../../src/core/live';
import type { PublicChatSendController } from '../../src/publicChat/controller';
import type { FrozenSenderRuntime } from '../../src/publicChat/frozenSenderRuntime';

describe('host input association', () => {
  it('does not upgrade an event observed before authorization and invalidates the old grant on reconnect', () => {
    let generation = 0;
    let grant: any = null;
    const updates: unknown[] = [];
    const controller = {
      hold: false,
      currentFrozenGrant: () => grant,
      revokeGrant: () => { grant = null; },
      setLiveEpoch: () => {},
      advanceInputConnection: () => { grant = null; return `token:${++generation}`; },
    } as unknown as PublicChatSendController;
    const sender = { setInputAndLive: (...args: unknown[]) => updates.push(args) } as unknown as FrozenSenderRuntime;
    const binding = new PublicChatInputBinding(controller, sender);
    const event = (): LiveEvent => ({ id: 'source', platform: 'douyin', kind: 'chat', ts: 1,
      user: { id: 'u', name: 'viewer' }, text: 'hello' });
    const ingress = { rawId: 'original-id', rawType: 'WebcastChatMessage', roomId: '101', frameTimeUntrusted: 1, receivedAt: 2 };
    binding.setLive({ roomId: '101', epoch: 'live', startedAtMs: 100 });
    binding.inputStateChanged('connected', 'connecting');
    const early = event();
    expect(binding.bindOriginal(early, ingress)).toBe(false);
    grant = { grantId: 'grant-1', roomId: '101', liveEpoch: 'live', inputConnectionGeneration: 1 };
    expect(binding.bindOriginal(early, ingress)).toBe(false);
    expect(readSourceEventMetadata(early)).toBeNull();
    const current = event();
    expect(binding.bindOriginal(current, ingress)).toBe(true);
    expect(binding.stillCurrent(current)).toBe(true);
    const reference = binding.reference(current);
    expect(reference).toMatchObject({ sourceEvent: current, rawId: 'original-id', rawType: 'WebcastChatMessage',
      inputConnectionGeneration: 1, sourceConnectionToken: 'token:1', liveEpoch: 'live' });
    expect(reference?.valid()).toBe(true);
    expect(binding.reference({ ...current })).toBeNull();
    expect(readSourceEventMetadata(current)?.rawId).toBe('original-id');
    expect(binding.bindOriginal(event(), { ...ingress, roomId: '102' })).toBe(false);
    grant = { grantId: 'replacement', roomId: '101', liveEpoch: 'live', inputConnectionGeneration: 1 };
    expect(binding.stillCurrent(current)).toBe(false);
    expect(reference?.valid()).toBe(false);
    grant = { grantId: 'grant-1', roomId: '101', liveEpoch: 'live', inputConnectionGeneration: 1 };
    binding.inputStateChanged('error', 'connected');
    expect(binding.stillCurrent(current)).toBe(false);
    binding.inputStateChanged('connected', 'error');
    grant = { grantId: 'grant-2', roomId: '101', liveEpoch: 'live', inputConnectionGeneration: 3 };
    expect(binding.stillCurrent(current)).toBe(false);
    expect(updates).toEqual([[0, null, 0], [1, 'live', 100], [2, null, 0], [3, 'live', 100]]);
  });
});
