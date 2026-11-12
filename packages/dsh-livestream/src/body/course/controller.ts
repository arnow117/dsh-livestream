import { randomUUID } from 'node:crypto';
import type { DirectoryBinding } from '../../dsh/sessionContextPaths';
import type { CourseActionInput, CourseFrame, CourseStageEvent, CourseStateView } from '../../shared/course';
import { CourseAssets } from './assets';
import { CourseSpeechTurn } from './speech';
import { validateCourseAction } from './actions';

const BEAT_IDS = ['intro', 'parts', 'distance', 'arm', 'balance', 'q1', 'distance_cost', 'kinds', 'lab', 'q2', 'wrap', 'final1', 'finish'] as const;

interface CourseContext {
  sessionId: string;
  roots: Array<{ rootId: string; binding: DirectoryBinding }>;
}

interface ControllerOptions {
  current(): CourseContext | null;
  publish(event: CourseStageEvent): void;
  speakers?(): number;
  activate?(sessionId: string): boolean;
  deactivate?(sessionId: string): void;
}

export class CourseController {
  private currentAssets: CourseAssets | null = null;
  private state: CourseStateView | null = null;
  private loadRevision = 0;
  private sessionId: string | null = null;
  private loadedFrom: { rootId: string; path: string } | null = null;
  private controlRevision = 0;
  private actionRevision = 0;
  private speech: CourseSpeechTurn | null = null;
  private preparingSpeech: Promise<CourseSpeechTurn | null> | null = null;
  private readonly invalidationListeners = new Set<() => void>();
  private reporter: { instance: string; sequence: number } | null = null;
  private stageLost = false;
  private pending: { id: string; action: 'start' | 'pause' | 'resume' | 'reset' | 'step' | 'apply'; internal?: boolean; input?: CourseActionInput; index?: number; resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> } | null = null;

  constructor(private readonly options: ControllerOptions) {}

  get assets(): CourseAssets | null {
    return this.currentAssets;
  }

  onInvalidate(listener: () => void): () => void {
    this.invalidationListeners.add(listener);
    return () => this.invalidationListeners.delete(listener);
  }

  private invalidateTurns(): void {
    for (const listener of this.invalidationListeners) listener();
  }

  view(): CourseStateView | null {
    return this.state ? structuredClone(this.state) : null;
  }

  async load(rootId: string, path: string): Promise<void> {
    const revision = ++this.loadRevision;
    const context = this.options.current();
    const root = context?.roots.find((item) => item.rootId === rootId);
    if (!context || !root) throw new Error('当前直播会话没有可用的资料根');
    const next = await CourseAssets.load(root.binding, path);
    const current = this.options.current();
    const sameRoot = current?.roots.find((item) => item.rootId === rootId)?.binding;
    if (revision !== this.loadRevision || current?.sessionId !== context.sessionId
      || !sameRoot || sameRoot.path !== root.binding.path || sameRoot.dev !== root.binding.dev || sameRoot.ino !== root.binding.ino) {
      next.revoke();
      throw new Error('直播会话或课程加载已变化');
    }
    const previous = this.currentAssets;
    const previousState = this.state;
    const previousSession = this.sessionId;
    const previousLoadedFrom = this.loadedFrom;
    this.controlRevision++;
    this.cancelPending();
    const epoch = randomUUID();
    this.currentAssets = next;
    this.sessionId = context.sessionId;
    this.loadedFrom = { rootId, path };
    this.state = { phase: 'loading', courseEpoch: epoch, step: null, playUnknown: true, pauseReason: 'none', question: null, lab: null, lastAction: null, steps: [] };
    if (this.options.activate && !this.options.activate(context.sessionId)) {
      next.revoke();
      this.currentAssets = previous;
      this.state = previousState;
      this.sessionId = previousSession;
      this.loadedFrom = previousLoadedFrom;
      throw new Error('课程工具绑定失败');
    }
    if (previousSession && previousSession !== context.sessionId) this.options.deactivate?.(previousSession);
    this.reporter = null;
    this.stageLost = false;
    this.invalidateTurns();
    previous?.revoke();
    this.options.publish({ type: 'course', action: 'open', epoch, url: `/course/asset/${next.capability}/${next.entryPath}` });
  }

  end(): void {
    this.loadRevision++;
    this.controlRevision++;
    this.cancelPending();
    const epoch = this.state?.courseEpoch;
    const sessionId = this.sessionId;
    this.currentAssets?.revoke();
    this.currentAssets = null;
    this.state = null;
    this.reporter = null;
    this.stageLost = false;
    this.sessionId = null;
    this.loadedFrom = null;
    if (sessionId) this.options.deactivate?.(sessionId);
    this.invalidateTurns();
    if (epoch) this.options.publish({ type: 'course', action: 'close', epoch });
  }

  async command(action: 'start' | 'pause' | 'resume' | 'reset' | 'step', index?: number): Promise<void> {
    this.controlRevision++;
    this.invalidateTurns();
    if ((action === 'start' || action === 'resume') && this.speech) throw new Error('当前正在说话，暂时不能继续课程');
    return this.issueCommand(action, index);
  }

  private async issueCommand(action: 'start' | 'pause' | 'resume' | 'reset' | 'step', index?: number, internal = false): Promise<void> {
    const state = this.state;
    if (!state || this.options.current()?.sessionId !== this.sessionId || state.playUnknown) throw new Error('课程状态未知或会话已变化');
    if (this.options.speakers && this.options.speakers() === 0) throw new Error('舞台未连接，无法确认课程操作');
    if (action === 'reset') {
      if (!this.loadedFrom) throw new Error('课程加载信息不可用');
      await this.load(this.loadedFrom.rootId, this.loadedFrom.path);
      return;
    }
    if (action === 'step' && (!Number.isInteger(index) || index! < 0 || index! >= 13)) throw new Error('课程步骤无效');
    this.cancelPending();
    const id = randomUUID();
    const kind = action === 'start' || action === 'resume' ? 'play' : action === 'step' ? 'seek' : action;
    const command = kind === 'seek' ? { kind, id, index: index! } as const : { kind, id } as const;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending?.id !== id) return;
        this.pending = null;
        if (this.state?.courseEpoch === state.courseEpoch) this.state = { ...this.state, playUnknown: true };
        reject(new Error('舞台没有确认课程状态'));
      }, 5000);
      this.pending = { id, action, index, internal, resolve, reject, timer };
      this.options.publish({ type: 'course', action: 'command', epoch: state.courseEpoch, command });
    });
  }

  private cancelPending(): void {
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('课程操作已失效'));
    }
  }

  markUnknown(): void {
    this.controlRevision++;
    this.invalidateTurns();
    this.speech?.end(false);
    if (this.state && this.reporter) this.stageLost = true;
    this.reporter = null;
    this.cancelPending();
    if (this.state) this.state = { ...this.state, playUnknown: true };
  }

  prepareSpeech(): Promise<CourseSpeechTurn | null> {
    if (!this.state) return Promise.resolve(null);
    if (this.preparingSpeech) return this.preparingSpeech;
    if (this.speech) {
      if (!this.speech.valid()) return Promise.reject(new Error('原来的课程话题已失效'));
      return Promise.resolve(this.speech);
    }
    const prepare = async () => {
      const state = this.state;
      if (!state?.step || state.playUnknown) throw new Error('课程状态未知，不能开口');
      const epoch = state.courseEpoch;
      const step = state.step.index;
      const generation = state.step.generation;
      const revision = this.controlRevision;
      const wasPlaying = state.step.playing && !state.step.waiting;
      if (wasPlaying) await this.issueCommand('pause', undefined, true);
      const valid = () => this.state?.courseEpoch === epoch && this.state.step?.index === step && this.state.step.generation === generation
        && (!this.state.step.playing || this.state.step.waiting)
        && !this.state.playUnknown && this.controlRevision === revision && this.options.current()?.sessionId === this.sessionId;
      if (!valid() || (this.state?.step?.playing && !this.state.step.waiting)) throw new Error('未能确认课件旁白暂停');
      let turn: CourseSpeechTurn;
      turn = new CourseSpeechTurn({
        wasPlaying,
        valid,
        onSettled: () => { if (this.speech === turn) this.speech = null; },
        resume: () => { if (valid()) void this.issueCommand('resume', undefined, true).catch(() => this.markUnknown()); },
      });
      this.speech = turn;
      return turn;
    };
    const pending = prepare();
    this.preparingSpeech = pending;
    void pending.finally(() => { if (this.preparingSpeech === pending) this.preparingSpeech = null; }).catch(() => {});
    return pending;
  }

  get speechTurn(): CourseSpeechTurn | null {
    return this.speech;
  }

  finishSpeechTurn(completed: boolean): void {
    const preparing = this.preparingSpeech;
    if (preparing) {
      void preparing.then((turn) => turn?.end(completed)).catch(() => {});
      return;
    }
    const turn = this.speech;
    queueMicrotask(() => turn?.end(completed));
  }

  capture(sessionId: string): { valid(): boolean; accept(): void } | null {
    const state = this.state;
    if (!state?.step || state.playUnknown || sessionId !== this.sessionId) return null;
    const { courseEpoch } = state;
    const { index, generation } = state.step;
    const control = this.controlRevision;
    let action = this.actionRevision;
    const baseValid = () => this.sessionId === sessionId && this.state?.courseEpoch === courseEpoch
      && this.state.step?.index === index && this.state.step.generation === generation
      && !this.state.playUnknown && this.controlRevision === control;
    return {
      valid: () => baseValid() && this.actionRevision === action,
      accept: () => { if (baseValid() && this.actionRevision === action + 1) action = this.actionRevision; },
    };
  }

  async applyAction(input: unknown, valid: () => boolean): Promise<string> {
    const state = this.state;
    if (!valid()) return '动作已失效。';
    if (!state?.step || !validateCourseAction(input, state.step)) {
      if (this.state) this.state = { ...this.state, lastAction: { kind: 'action', status: 'rejected', detail: '动作已失效或不在当前题目和参数范围内', at: Date.now() } };
      return '动作已失效或不在当前题目和参数范围内：力臂为 0.5–2.3 m（步长 0.1 m），动力为 10–100 N（步长 5 N）；选择题索引为 0–2。';
    }
    if (input.kind === 'question') return '可以回答当前课程问题，不改变课件。';
    if (!state.step.playing || state.pauseReason === 'owner') {
      const detail = state.pauseReason === 'owner'
        ? '主人已暂停课程，请继续课程后再作答或调参。'
        : '课程尚未播放，请继续课程后再作答或调参。';
      this.state = { ...state, lastAction: { kind: input.kind, status: 'rejected', detail, at: Date.now() } };
      return detail;
    }
    if (this.pending || (this.options.speakers && this.options.speakers() !== 1)) return '舞台忙或状态未知，未执行动作。';
    const id = randomUUID();
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (this.pending?.id !== id) return;
          this.pending = null;
          if (this.state?.courseEpoch === state.courseEpoch) this.state = { ...this.state, playUnknown: true };
          reject(new Error('舞台未确认'));
        }, 5000);
        this.pending = { id, action: 'apply', input, resolve, reject, timer };
        this.options.publish({ type: 'course', action: 'command', epoch: state.courseEpoch, command: { kind: 'apply', id, generation: state.step!.generation, input } });
      });
      if (!valid()) return '动作结果已过期。';
      this.actionRevision++;
      if (this.state?.question && this.state.step) {
        this.state = { ...this.state, question: { ...this.state.question, attemptId: `${state.courseEpoch}:${this.state.step.generation}:${this.actionRevision}` } };
      }
      const frame = this.state?.step;
      const detail = input.kind === 'answer' ? frame?.quiz?.result === 'correct' ? '课件判定正确。' : frame?.quiz?.result === 'wrong' ? '课件判定错误，可以继续作答。' : '课件结果未知。' : '课件已回读并应用该参数。';
      if (this.state) this.state = { ...this.state, lastAction: { kind: input.kind, status: 'applied', detail, at: Date.now() } };
      return detail;
    } catch {
      if (valid() && this.state?.courseEpoch === state.courseEpoch) this.state = { ...this.state, lastAction: { kind: input.kind, status: 'unknown', detail: '动作未确认或已失效', at: Date.now() } };
      return '动作未确认或已失效。';
    }
  }

  allowsSpeech(turn: CourseSpeechTurn | null | undefined): boolean {
    if (!this.state) return true;
    return !!turn && turn === this.speech && turn.valid();
  }

  invalidateOutput(): void {
    this.controlRevision++;
    this.invalidateTurns();
    this.speech?.end(false);
    this.cancelPending();
  }

  report(epoch: string, frame: CourseFrame, commandId?: string, instance?: string, sequence?: number): boolean {
    if (!this.state || this.state.courseEpoch !== epoch || this.options.current()?.sessionId !== this.sessionId) return false;
    if (this.stageLost) return false;
    if (instance !== undefined && sequence !== undefined) {
      if (this.reporter && this.reporter.instance !== instance && !this.state.playUnknown) return false;
      if (this.reporter?.instance === instance && sequence <= this.reporter.sequence) return false;
    }
    if ((commandId && commandId !== this.pending?.id) || (this.pending && commandId !== this.pending.id)) return false;
    if (!frame || typeof frame !== 'object' || !Number.isInteger(frame.index) || frame.index < 0 || frame.index >= BEAT_IDS.length
      || frame.id !== BEAT_IDS[frame.index] || typeof frame.title !== 'string' || frame.title.length > 120
      || typeof frame.playing !== 'boolean' || typeof frame.waiting !== 'boolean' || typeof frame.done !== 'boolean'
      || !Number.isSafeInteger(frame.generation) || frame.generation < 0) return false;
    const clean: CourseFrame = {
      index: frame.index, id: frame.id, title: frame.title, playing: frame.playing,
      waiting: frame.waiting, done: frame.done, generation: frame.generation,
    };
    let steps = this.state.steps;
    if (frame.steps !== undefined) {
      if (!Array.isArray(frame.steps) || frame.steps.length !== BEAT_IDS.length
        || frame.steps.some((item, index) => !item || item.id !== BEAT_IDS[index] || typeof item.title !== 'string' || item.title.length > 120)) return false;
      steps = frame.steps.map((item) => ({ id: item.id, title: item.title }));
    }
    if (frame.quiz && ['pending', 'correct', 'wrong'].includes(frame.quiz.result)) {
      const disabled = frame.quiz.disabledChoices;
      if (disabled !== undefined && (!Array.isArray(disabled) || disabled.length > 3
        || disabled.some((index) => !Number.isInteger(index) || index < 0 || index > 2)
        || new Set(disabled).size !== disabled.length)) return false;
      clean.quiz = { result: frame.quiz.result, ...(disabled ? { disabledChoices: [...disabled] } : {}) };
    }
    if (frame.lab && [frame.lab.left, frame.lab.right, frame.lab.force].every(Number.isFinite) && typeof frame.lab.balanced === 'boolean') {
      clean.lab = { left: frame.lab.left, right: frame.lab.right, force: frame.lab.force, balanced: frame.lab.balanced };
    }
    if (instance !== undefined && sequence !== undefined) this.reporter = { instance, sequence };
    const previousReason = this.state.pauseReason;
    const reason = clean.playing ? 'none' : this.pending?.action === 'pause' ? (this.pending.internal ? 'speech' : 'owner') : previousReason;
    const question = ['q1', 'q2', 'final1'].includes(clean.id) && clean.quiz
      ? { open: clean.waiting && clean.quiz.result !== 'correct', attemptId: `${epoch}:${clean.generation}:${this.actionRevision}`, lastResult: clean.quiz.result }
      : null;
    this.state = { ...this.state, phase: clean.playing ? 'playing' : 'paused', step: clean, playUnknown: false, pauseReason: reason, question, lab: clean.lab ?? null, steps };
    if (commandId && this.pending?.id === commandId) {
      const pending = this.pending;
      this.pending = null;
      clearTimeout(pending.timer);
      const matches = pending.action === 'apply' ? pending.input?.kind === 'param'
        ? clean.lab?.[pending.input.which] === pending.input.value
        : pending.input?.kind === 'answer' && (clean.quiz?.result === 'correct' || clean.quiz?.result === 'wrong')
        : pending.action === 'start' || pending.action === 'resume' ? frame.playing
        : pending.action === 'pause' ? !frame.playing
          : pending.action === 'step' ? frame.index === pending.index
            : frame.index === 0 && !frame.playing;
      if (matches) pending.resolve();
      else pending.reject(new Error('课件未确认所请求的状态'));
    }
    return true;
  }
}
