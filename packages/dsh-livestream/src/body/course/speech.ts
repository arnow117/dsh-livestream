import type { AudioResult } from '../stage';

/** Tracks one native turn, including speech segments queued after the model ends. */
export class CourseSpeechTurn {
  private pending = 0;
  private segments = 0;
  private completed = false;
  private successful = true;
  private settled = false;

  constructor(private readonly options: { wasPlaying: boolean; valid(): boolean; resume(): void; onSettled?(): void }) {}

  valid(): boolean {
    return this.options.valid();
  }

  segment(): (result: AudioResult) => void {
    this.pending++;
    this.segments++;
    let finished = false;
    return (result) => {
      if (finished) return;
      finished = true;
      this.pending--;
      if (result !== 'ended') this.successful = false;
      this.maybeResume();
    };
  }

  end(completed: boolean): void {
    this.completed = true;
    if (!completed) this.successful = false;
    this.maybeResume();
  }

  private maybeResume(): void {
    if (this.settled || !this.completed || this.pending !== 0) return;
    this.settled = true;
    this.options.onSettled?.();
    if (this.segments > 0 && this.successful && this.options.wasPlaying && this.options.valid()) this.options.resume();
  }
}
