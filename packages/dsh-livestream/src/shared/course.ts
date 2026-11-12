export interface CourseFrame {
  index: number;
  id: string;
  title: string;
  playing: boolean;
  waiting: boolean;
  done: boolean;
  generation: number;
  steps?: Array<{ id: string; title: string }>;
  quiz?: { result: 'pending' | 'correct' | 'wrong'; disabledChoices?: number[] } | null;
  lab?: { left: number; right: number; force: number; balanced: boolean } | null;
}

export type CourseActionInput =
  | { kind: 'answer'; target: 'choice'; index: number }
  | { kind: 'answer'; target: 'blank'; value: string }
  | { kind: 'param'; which: 'left' | 'right' | 'force'; value: number; unit: 'm' | 'N' }
  | { kind: 'question' };

export interface CourseStateView {
  phase: 'loading' | 'ready' | 'playing' | 'paused';
  courseEpoch: string;
  step: CourseFrame | null;
  playUnknown: boolean;
  pauseReason: 'owner' | 'speech' | 'none';
  question: { open: boolean; attemptId: string; lastResult: 'pending' | 'correct' | 'wrong' } | null;
  lab: CourseFrame['lab'];
  lastAction: { kind: string; status: 'applied' | 'rejected' | 'expired' | 'unknown'; detail: string; at: number } | null;
  steps: Array<{ id: string; title: string }>;
}

export type CourseCommand =
  | { kind: 'play' | 'pause' | 'reset' | 'read'; id: string }
  | { kind: 'seek'; id: string; index: number }
  | { kind: 'apply'; id: string; generation: number; input: Exclude<CourseActionInput, { kind: 'question' }> };

export type CourseStageEvent =
  | { type: 'course'; action: 'open'; epoch: string; url: string }
  | { type: 'course'; action: 'close'; epoch: string }
  | { type: 'course'; action: 'command'; epoch: string; command: CourseCommand };
