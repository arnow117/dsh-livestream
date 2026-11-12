import { describe, expect, it } from 'vitest';
import { CourseTurns } from '../src/body/course/turns';

describe('course turn ownership', () => {
  it('binds a selected event to the real native turn, claims it once, and invalidates on owner change', () => {
    const turns = new CourseTurns();
    const agent = {};
    let current = true;
    turns.remember('message', 'event-1');
    const signal = new AbortController().signal;
    const lease = turns.begin(agent, 7, 'session', 'output', signal, [{ id: 'message' }], () => current);
    expect(turns.find(agent, signal)).toBe(lease);
    expect(turns.claim(lease)).toBe(true);
    expect(turns.claim(lease)).toBe(false);
    current = false;
    expect(lease.valid()).toBe(false);
    expect(turns.find(agent, signal)).toBeUndefined();
  });

  it('does not apply a duplicate event in another native turn', () => {
    const turns = new CourseTurns();
    const agent = {};
    const signal = new AbortController().signal;
    turns.remember('a', 'event-1');
    expect(turns.claim(turns.begin(agent, 1, 's', 'o', signal, [{ id: 'a' }], () => true))).toBe(true);
    turns.remember('b', 'event-1');
    expect(turns.claim(turns.begin(agent, 2, 's', 'o', signal, [{ id: 'b' }], () => true))).toBe(false);
  });

  it('does not guess a selected viewer when a turn contains multiple candidate events', () => {
    const turns = new CourseTurns();
    const agent = {};
    const signal = new AbortController().signal;
    turns.remember('message-a', 'viewer-a-event');
    turns.remember('message-b', 'viewer-b-event');
    const ambiguous = turns.begin(agent, 1, 's', 'o', signal, [{ id: 'message-a' }, { id: 'message-b' }], () => true);
    expect(ambiguous.eventId).toBeNull();
    expect(turns.claim(ambiguous)).toBe(false);
    turns.remember('message-c', 'viewer-c-event');
    const selected = turns.begin(agent, 2, 's', 'o', signal, [{ id: 'message-c' }], () => true);
    expect(turns.claim(selected)).toBe(true);
    turns.invalidateAll();
    expect(selected.valid()).toBe(false);
    expect(turns.claim(selected)).toBe(false);
  });

  it('clears the retired course turn history without reviving its leases', () => {
    const turns = new CourseTurns();
    const agent = {};
    const signal = new AbortController().signal;
    turns.remember('first-message', 'event-1');
    const first = turns.begin(agent, 1, 'old-session', 'old-output', signal, [{ id: 'first-message' }], () => true);
    expect(turns.claim(first)).toBe(true);
    turns.reset();
    expect(first.valid()).toBe(false);
    turns.remember('next-message', 'event-1');
    const next = turns.begin(agent, 1, 'new-session', 'new-output', signal, [{ id: 'next-message' }], () => true);
    expect(turns.claim(next)).toBe(true);
  });
});
