import { describe, expect, it } from 'vitest';
import { validateCourseAction } from '../src/body/course/actions';

const frame = (id: string, waiting = true) => ({ index: 0, id, title: '', playing: false, waiting, done: false, generation: 1 });

describe('bounded course actions', () => {
  it('accepts only valid unit, range and step for the active lab', () => {
    expect(validateCourseAction({ kind: 'param', which: 'left', value: 1.3, unit: 'm' }, frame('lab'))).toBe(true);
    expect(validateCourseAction({ kind: 'param', which: 'force', value: 25, unit: 'N' }, frame('lab'))).toBe(true);
    expect(validateCourseAction({ kind: 'param', which: 'left', value: 1.35, unit: 'm' }, frame('lab'))).toBe(false);
    expect(validateCourseAction({ kind: 'param', which: 'left', value: 2.4, unit: 'm' }, frame('lab'))).toBe(false);
    expect(validateCourseAction({ kind: 'param', which: 'force', value: 25, unit: 'm' }, frame('lab'))).toBe(false);
    expect(validateCourseAction({ kind: 'param', which: 'force', value: 26, unit: 'N' }, frame('lab'))).toBe(false);
    expect(validateCourseAction({ kind: 'param', which: 'force', value: 25, unit: 'N' }, frame('intro'))).toBe(false);
    expect(validateCourseAction({ kind: 'param', which: 'force', value: 25, unit: 'N' }, frame('lab', false))).toBe(false);
    expect(validateCourseAction({ kind: 'param', which: 'left', value: 3, unit: 'm' }, frame('lab'))).toBe(false);
    expect(validateCourseAction({ kind: 'param', which: 'force', value: 32, unit: 'N' }, frame('lab'))).toBe(false);
    expect(validateCourseAction({ kind: 'param', which: 'load', value: 80, unit: 'N' }, frame('lab'))).toBe(false);
    expect(validateCourseAction({ kind: 'param', value: 30, unit: 'N' }, frame('lab'))).toBe(false);
  });

  it('permits only the current question form and rejects ambiguous numeric answers', () => {
    expect(validateCourseAction({ kind: 'answer', target: 'choice', index: 2 }, frame('q1'))).toBe(true);
    expect(validateCourseAction({ kind: 'answer', target: 'choice', index: 3 }, frame('q1'))).toBe(false);
    expect(validateCourseAction({ kind: 'answer', target: 'blank', value: '2' }, frame('final1'))).toBe(true);
    expect(validateCourseAction({ kind: 'answer', target: 'blank', value: '2 m' }, frame('final1'))).toBe(false);
    expect(validateCourseAction({ kind: 'answer', target: 'blank', value: '1/0' }, frame('final1'))).toBe(false);
    expect(validateCourseAction({ kind: 'answer', target: 'choice', index: 0 }, frame('final1'))).toBe(false);
    expect(validateCourseAction({ kind: 'question' }, frame('intro'))).toBe(true);
    expect(validateCourseAction({ kind: 'param', which: 'load', value: 10, unit: 'N' }, frame('lab'))).toBe(false);
  });

  it('rejects an already resolved question and an option disabled by the asset', () => {
    const resolved = { ...frame('q1'), quiz: { result: 'correct' as const } };
    const wrong = { ...frame('q1'), quiz: { result: 'wrong' as const, disabledChoices: [1] } };
    expect(validateCourseAction({ kind: 'answer', target: 'choice', index: 0 }, resolved)).toBe(false);
    expect(validateCourseAction({ kind: 'answer', target: 'choice', index: 1 }, wrong)).toBe(false);
    expect(validateCourseAction({ kind: 'answer', target: 'choice', index: 0 }, wrong)).toBe(true);
  });
});
