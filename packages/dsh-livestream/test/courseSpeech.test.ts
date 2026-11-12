import { describe, expect, it, vi } from 'vitest';
import { CourseSpeechTurn } from '../src/body/course/speech';

describe('course speech completion', () => {
  it('waits for the real turn and every audio segment before resuming', async () => {
    const resume = vi.fn();
    const turn = new CourseSpeechTurn({ wasPlaying: true, valid: () => true, resume });
    const first = turn.segment();
    const second = turn.segment();
    first('ended');
    turn.end(true);
    expect(resume).not.toHaveBeenCalled();
    second('ended');
    expect(resume).toHaveBeenCalledOnce();
  });

  it.each(['unknown', 'error', 'cancelled', 'timeout'] as const)('does not resume after %s', (result) => {
    const resume = vi.fn();
    const turn = new CourseSpeechTurn({ wasPlaying: true, valid: () => true, resume });
    turn.segment()(result);
    turn.end(true);
    expect(resume).not.toHaveBeenCalled();
  });

  it('does not resume with no audio, an unfinished turn, changed ownership, or an already paused course', () => {
    const resume = vi.fn();
    const noAudio = new CourseSpeechTurn({ wasPlaying: true, valid: () => true, resume });
    noAudio.end(true);
    const interrupted = new CourseSpeechTurn({ wasPlaying: true, valid: () => true, resume });
    interrupted.segment()('ended');
    interrupted.end(false);
    const changed = new CourseSpeechTurn({ wasPlaying: true, valid: () => false, resume });
    changed.segment()('ended');
    changed.end(true);
    const paused = new CourseSpeechTurn({ wasPlaying: false, valid: () => true, resume });
    paused.segment()('ended');
    paused.end(true);
    expect(resume).not.toHaveBeenCalled();
  });
});
