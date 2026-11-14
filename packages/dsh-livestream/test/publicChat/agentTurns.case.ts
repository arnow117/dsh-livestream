import { describe, expect, it } from 'vitest';
import { PublicChatAgentTurns } from '../../src/publicChat/agentTurns';

describe('public chat turn association', () => {
  it('binds a unique pushed event to the real agent and signal, and invalidates it on scope changes', () => {
    const turns = new PublicChatAgentTurns();
    const agent = {};
    const signal = new AbortController();
    let current = true;
    const sourceEvent = {};
    const reference = { sourceEvent, rawId: 'raw', rawType: 'WebcastChatMessage', inputConnectionGeneration: 1, valid: () => current };
    expect(turns.remember('message', agent, reference)).toBe(true);
    expect(turns.pendingAvailable(agent)).toBe(true);
    expect(turns.pendingAvailable({})).toBe(false);
    const lease = turns.begin(agent, 'turn-1', 'session', signal.signal, [{ id: 'message' }], () => current);
    expect(lease?.sourceEvent).toBe(sourceEvent);
    expect(turns.find({}, signal.signal)).toBeNull();
    expect(turns.find(agent, new AbortController().signal)).toBeNull();
    expect(turns.claim(lease!)).toBe(true);
    expect(turns.claim(lease!)).toBe(false);
    current = false;
    expect(turns.find(agent, signal.signal)).toBeNull();
  });

  it('rejects ambiguous events and late additions to the same turn', () => {
    const turns = new PublicChatAgentTurns();
    const agent = {};
    const signal = new AbortController().signal;
    const reference = () => ({ sourceEvent: {}, rawId: 'raw', rawType: 'WebcastChatMessage', inputConnectionGeneration: 1, valid: () => true });
    turns.remember('one', agent, reference());
    turns.remember('two', agent, reference());
    expect(turns.pendingAvailable(agent)).toBe(false);
    expect(turns.begin(agent, '1', 'session', signal, [{ id: 'one' }, { id: 'two' }], () => true)).toBeNull();
    turns.remember('mixed', agent, reference());
    expect(turns.begin(agent, 'mixed-turn', 'session', signal, [{ id: 'mixed' }, { id: 'owner' }], () => true)).toBeNull();
    turns.remember('three', agent, reference());
    const lease = turns.begin(agent, '2', 'session', signal, [{ id: 'three' }], () => true);
    expect(lease).not.toBeNull();
    turns.remember('four', agent, reference());
    expect(turns.begin(agent, '2', 'session', signal, [{ id: 'four' }], () => true)).toBeNull();
    expect(turns.find(agent, signal)).toBeNull();
    turns.invalidate();
    expect(turns.claim(lease!)).toBe(false);
  });
});
