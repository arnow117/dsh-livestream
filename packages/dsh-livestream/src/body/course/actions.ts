import type { CourseActionInput, CourseFrame } from '../../shared/course';

function onlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

export function validateCourseAction(input: unknown, frame: CourseFrame): input is CourseActionInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const action = input as Record<string, unknown>;
  if (action.kind === 'question') return onlyKeys(action, ['kind']);
  if (!frame.waiting || frame.done) return false;
  if (action.kind === 'param') {
    if (!onlyKeys(action, ['kind', 'which', 'value', 'unit']) || frame.id !== 'lab'
      || typeof action.value !== 'number' || !Number.isFinite(action.value)) return false;
    if (action.which === 'left' || action.which === 'right') {
      return action.unit === 'm' && action.value >= 0.5 && action.value <= 2.3
        && Math.abs(action.value * 10 - Math.round(action.value * 10)) < 1e-9;
    }
    return action.which === 'force' && action.unit === 'N' && action.value >= 10 && action.value <= 100
      && Number.isInteger(action.value) && action.value % 5 === 0;
  }
  if (action.kind !== 'answer') return false;
  if (frame.quiz?.result === 'correct') return false;
  if (action.target === 'choice') {
    return onlyKeys(action, ['kind', 'target', 'index']) && (frame.id === 'q1' || frame.id === 'q2')
      && typeof action.index === 'number' && Number.isInteger(action.index) && action.index >= 0 && action.index <= 2
      && !frame.quiz?.disabledChoices?.includes(action.index);
  }
  if (action.target === 'blank') {
    if (!onlyKeys(action, ['kind', 'target', 'value']) || frame.id !== 'final1' || typeof action.value !== 'string' || action.value.length > 32) return false;
    return /^-?\d+(?:\.\d+)?$/.test(action.value) || /^-?\d+\/[1-9]\d*$/.test(action.value);
  }
  return false;
}
