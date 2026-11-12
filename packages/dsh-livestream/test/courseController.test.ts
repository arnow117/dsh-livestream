import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CourseController } from '../src/body/course/controller';
import { bindDirectory } from '../src/dsh/sessionContextPaths';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'course-controller-'));
  dirs.push(root);
  await mkdir(join(root, 'ch01'));
  await writeFile(join(root, 'ch01', 'index.html'), '<p>course</p>');
  const binding = await bindDirectory(root);
  if (typeof binding === 'string') throw new Error(binding);
  let active = true;
  const events: unknown[] = [];
  const course = new CourseController({
    current: () => active ? { sessionId: 'session', roots: [{ rootId: 'root-1', binding }] } : null,
    publish: (event) => events.push(event),
  });
  return { course, events, deactivate: () => { active = false; } };
}

describe('course controller', () => {
  it('loads only an active snapshot root and keeps the old instance when loading fails', async () => {
    const { course, events, deactivate } = await makeFixture();
    await expect(course.load('bad-root', 'ch01/index.html')).rejects.toThrow();
    await course.load('root-1', 'ch01/index.html');
    const first = course.assets;
    expect(first).not.toBeNull();
    expect(course.view()?.phase).toBe('loading');
    expect(JSON.stringify(course.view())).not.toContain(first!.capability);
    await expect(course.load('root-1', 'missing.html')).rejects.toThrow();
    expect(course.assets).toBe(first);
    expect(first!.active).toBe(true);
    expect(events).toHaveLength(1);
    deactivate();
    await expect(course.load('root-1', 'ch01/index.html')).rejects.toThrow();
    course.end();
    expect(first!.active).toBe(false);
    expect(course.view()).toBeNull();
  });

  it('publishes commands without claiming success until the matching frame is reported', async () => {
    const { course, events } = await makeFixture();
    await course.load('root-1', 'ch01/index.html');
    const epoch = course.view()!.courseEpoch;
    const frame = { index: 0, id: 'intro', title: '介绍', playing: false, waiting: false, done: false, generation: 1 };
    expect(course.report(epoch, frame)).toBe(true);
    const pending = course.command('start');
    const commandEvent = events.at(-1) as { command: { id: string } };
    expect(course.view()?.phase).toBe('paused');
    expect(course.report('wrong-epoch', { ...frame, playing: true }, commandEvent.command.id)).toBe(false);
    expect(course.report(epoch, { ...frame, playing: true }, commandEvent.command.id)).toBe(true);
    await expect(pending).resolves.toBeUndefined();
    expect(course.view()?.phase).toBe('playing');
    const previousAssets = course.assets!;
    await course.command('reset');
    expect(previousAssets.active).toBe(false);
    expect(course.assets).not.toBe(previousAssets);
    course.end();
  });

  it('pauses before speech and resumes only after the turn and all segments end', async () => {
    const { course, events } = await makeFixture();
    await course.load('root-1', 'ch01/index.html');
    const epoch = course.view()!.courseEpoch;
    const frame = { index: 0, id: 'intro', title: '介绍', playing: true, waiting: false, done: false, generation: 1 };
    expect(course.report(epoch, frame)).toBe(true);
    const preparation = course.prepareSpeech();
    const pause = events.at(-1) as { command: { id: string; kind: string } };
    expect(pause.command.kind).toBe('pause');
    course.report(epoch, { ...frame, playing: false }, pause.command.id);
    const turn = (await preparation)!;
    const first = turn.segment();
    const second = turn.segment();
    turn.end(true);
    first('ended');
    expect((events.at(-1) as { command: { kind: string } }).command.kind).toBe('pause');
    second('ended');
    const resume = events.at(-1) as { command: { id: string; kind: string } };
    expect(resume.command.kind).toBe('play');
    course.report(epoch, frame, resume.command.id);
    course.end();
  });

  it('keeps queued segments when turn-end arrives while the pause is still in flight', async () => {
    const { course, events } = await makeFixture();
    await course.load('root-1', 'ch01/index.html');
    const epoch = course.view()!.courseEpoch;
    const frame = { index: 0, id: 'intro', title: '介绍', playing: true, waiting: false, done: false, generation: 1 };
    course.report(epoch, frame);
    const preparing = course.prepareSpeech();
    const first = preparing.then((turn) => turn!.segment());
    const second = preparing.then((turn) => turn!.segment());
    course.finishSpeechTurn(true);
    const pause = events.at(-1) as { command: { id: string } };
    course.report(epoch, { ...frame, playing: false }, pause.command.id);
    const [finishFirst, finishSecond] = await Promise.all([first, second]);
    finishFirst('ended');
    expect((events.at(-1) as { command: { kind: string } }).command.kind).toBe('pause');
    finishSecond('ended');
    expect((events.at(-1) as { command: { kind: string } }).command.kind).toBe('play');
    const resume = events.at(-1) as { command: { id: string } };
    course.report(epoch, frame, resume.command.id);
    course.end();
  });

  it('applies one validated parameter only after a matching asset readback', async () => {
    const { course, events } = await makeFixture();
    await course.load('root-1', 'ch01/index.html');
    const epoch = course.view()!.courseEpoch;
    const frame = {
      index: 8, id: 'lab', title: '实验', playing: true, waiting: true, done: false, generation: 4,
      lab: { left: 2, right: 1, force: 20, balanced: false },
    };
    course.report(epoch, frame);
    const stamp = course.capture('session')!;
    const before = events.length;
    expect(await course.applyAction({ kind: 'param', which: 'left', value: 1.35, unit: 'm' }, stamp.valid)).toContain('范围');
    expect(events).toHaveLength(before);
    const pending = course.applyAction({ kind: 'param', which: 'left', value: 1.3, unit: 'm' }, stamp.valid);
    const command = events.at(-1) as { command: { id: string; kind: string } };
    expect(command.command.kind).toBe('apply');
    course.report(epoch, { ...frame, lab: { ...frame.lab, left: 1.3 } }, command.command.id);
    expect(await pending).toContain('已回读');
    expect(stamp.valid()).toBe(false);
    stamp.accept();
    expect(stamp.valid()).toBe(true);
    expect(course.view()?.lab?.left).toBe(1.3);
    course.end();
  });

  it('does not apply an audience parameter while the owner has paused a waiting experiment', async () => {
    const { course, events } = await makeFixture();
    await course.load('root-1', 'ch01/index.html');
    const epoch = course.view()!.courseEpoch;
    const frame = { index: 8, id: 'lab', title: '实验', playing: true, waiting: true, done: false, generation: 4, lab: { left: 2, right: 1, force: 20, balanced: false } };
    course.report(epoch, frame);
    const pause = course.command('pause');
    const commandId = (events.at(-1) as { command: { id: string } }).command.id;
    course.report(epoch, { ...frame, playing: false }, commandId);
    await pause;
    const stamp = course.capture('session')!;
    const before = events.length;
    const result = course.applyAction({ kind: 'param', which: 'left', value: 1.3, unit: 'm' }, stamp.valid);
    expect(await course.applyAction({ kind: 'question' }, stamp.valid)).toContain('不改变课件');
    const after = events.length;
    course.end();
    expect(await result).toContain('主人已暂停');
    expect(after).toBe(before);
  });

  it('does not apply audience changes on a selected step that has not been started', async () => {
    const { course, events } = await makeFixture();
    await course.load('root-1', 'ch01/index.html');
    const epoch = course.view()!.courseEpoch;
    course.report(epoch, { index: 8, id: 'lab', title: '实验', playing: false, waiting: true, done: false, generation: 4, lab: { left: 2, right: 1, force: 20, balanced: false } });
    const stamp = course.capture('session')!;
    const before = events.length;
    const result = course.applyAction({ kind: 'param', which: 'left', value: 1.3, unit: 'm' }, stamp.valid);
    const after = events.length;
    course.end();
    await result;
    expect(after).toBe(before);
  });

  it('rejects an answer while the owner has paused a waiting question', async () => {
    const { course, events } = await makeFixture();
    await course.load('root-1', 'ch01/index.html');
    const epoch = course.view()!.courseEpoch;
    const frame = { index: 5, id: 'q1', title: '小测', playing: true, waiting: true, done: false, generation: 4, quiz: { result: 'pending' as const } };
    course.report(epoch, frame);
    const pause = course.command('pause');
    const commandId = (events.at(-1) as { command: { id: string } }).command.id;
    course.report(epoch, { ...frame, playing: false }, commandId);
    await pause;
    const stamp = course.capture('session')!;
    const before = events.length;
    expect(await course.applyAction({ kind: 'answer', target: 'choice', index: 0 }, stamp.valid)).toContain('主人已暂停');
    expect(events).toHaveLength(before);
    expect(course.view()?.question?.lastResult).toBe('pending');
    course.end();
  });

  it('shows a correctly answered question as closed and rejects later answers without a command', async () => {
    const { course, events } = await makeFixture();
    await course.load('root-1', 'ch01/index.html');
    const epoch = course.view()!.courseEpoch;
    course.report(epoch, { index: 5, id: 'q1', title: '小测', playing: true, waiting: true, done: false, generation: 4, quiz: { result: 'correct' } });
    expect(course.view()?.question?.open).toBe(false);
    const stamp = course.capture('session')!;
    const before = events.length;
    const result = course.applyAction({ kind: 'answer', target: 'choice', index: 1 }, stamp.valid);
    const after = events.length;
    course.end();
    await result;
    expect(after).toBe(before);
  });

  it('uses the asset readback to reject a disabled wrong choice without making the stage unknown', async () => {
    const { course, events } = await makeFixture();
    await course.load('root-1', 'ch01/index.html');
    const epoch = course.view()!.courseEpoch;
    const frame = { index: 5, id: 'q1', title: '小测', playing: true, waiting: true, done: false, generation: 4, quiz: { result: 'wrong' as const, disabledChoices: [1] } };
    expect(course.report(epoch, frame)).toBe(true);
    const stamp = course.capture('session')!;
    const before = events.length;
    expect(await course.applyAction({ kind: 'answer', target: 'choice', index: 1 }, stamp.valid)).toContain('范围');
    expect(events).toHaveLength(before);
    expect(course.view()?.playUnknown).toBe(false);
    expect(course.view()?.question?.open).toBe(true);
    expect(course.report(epoch, { ...frame, quiz: { ...frame.quiz, disabledChoices: [3] } })).toBe(false);
    course.end();
  });

  it('rejects a late audience result after an owner selects another step', async () => {
    const { course, events } = await makeFixture();
    await course.load('root-1', 'ch01/index.html');
    const epoch = course.view()!.courseEpoch;
    const frame = { index: 8, id: 'lab', title: '实验', playing: true, waiting: true, done: false, generation: 4, lab: { left: 2, right: 1, force: 20, balanced: false } };
    course.report(epoch, frame);
    const stamp = course.capture('session')!;
    const audience = course.applyAction({ kind: 'param', which: 'left', value: 1.3, unit: 'm' }, stamp.valid);
    const oldId = (events.at(-1) as { command: { id: string } }).command.id;
    const otherViewer = course.capture('session')!;
    const beforeOther = events.length;
    expect(await course.applyAction({ kind: 'param', which: 'force', value: 30, unit: 'N' }, otherViewer.valid)).toContain('未执行');
    expect(events).toHaveLength(beforeOther);
    const owner = course.command('step', 0);
    expect(await audience).toContain('未确认');
    expect(course.report(epoch, { ...frame, lab: { ...frame.lab, left: 1.3 } }, oldId)).toBe(false);
    const ownerId = (events.at(-1) as { command: { id: string } }).command.id;
    course.report(epoch, { index: 0, id: 'intro', title: '介绍', playing: false, waiting: false, done: false, generation: 5 }, ownerId);
    await expect(owner).resolves.toBeUndefined();
    expect(course.view()?.step?.id).toBe('intro');
    course.end();
  });

  it('invalidates an earlier attempt when the owner reopens the same question', async () => {
    const { course, events } = await makeFixture();
    await course.load('root-1', 'ch01/index.html');
    const epoch = course.view()!.courseEpoch;
    const frame = { index: 5, id: 'q1', title: '小测', playing: true, waiting: true, done: false, generation: 4, quiz: { result: 'pending' as const } };
    course.report(epoch, frame);
    const previous = course.capture('session')!;
    const owner = course.command('step', 5);
    const commandId = (events.at(-1) as { command: { id: string } }).command.id;
    course.report(epoch, { ...frame, playing: false, generation: 5 }, commandId);
    await owner;
    const before = course.view();
    expect(await course.applyAction({ kind: 'answer', target: 'choice', index: 0 }, previous.valid)).toContain('失效');
    expect(course.view()).toEqual(before);
    course.end();
  });

  it('does not change the owner view when an invalidated audience action finishes late', async () => {
    const { course, events } = await makeFixture();
    await course.load('root-1', 'ch01/index.html');
    const epoch = course.view()!.courseEpoch;
    const lab = { index: 8, id: 'lab', title: '实验', playing: true, waiting: true, done: false, generation: 4, lab: { left: 2, right: 1, force: 20, balanced: false } };
    course.report(epoch, lab);
    const stamp = course.capture('session')!;
    const audience = course.applyAction({ kind: 'param', which: 'left', value: 1.3, unit: 'm' }, stamp.valid);
    const owner = course.command('step', 0);
    const ownerId = (events.at(-1) as { command: { id: string } }).command.id;
    course.report(epoch, { index: 0, id: 'intro', title: '介绍', playing: false, waiting: false, done: false, generation: 5 }, ownerId);
    const ownerView = course.view();
    await owner;
    await audience;
    await course.applyAction({ kind: 'question' }, stamp.valid);
    expect(course.view()).toEqual(ownerView);
    course.end();
  });

  it('does not resume a speech turn after an owner changes the course', async () => {
    const { course, events } = await makeFixture();
    await course.load('root-1', 'ch01/index.html');
    const epoch = course.view()!.courseEpoch;
    const frame = { index: 0, id: 'intro', title: '介绍', playing: true, waiting: false, done: false, generation: 1 };
    course.report(epoch, frame);
    const preparing = course.prepareSpeech();
    const pause = events.at(-1) as { command: { id: string } };
    course.report(epoch, { ...frame, playing: false }, pause.command.id);
    const turn = (await preparing)!;
    const finish = turn.segment();
    const owner = course.command('step', 1);
    const ownerId = (events.at(-1) as { command: { id: string } }).command.id;
    course.report(epoch, { index: 1, id: 'parts', title: '认识杠杆', playing: false, waiting: false, done: false, generation: 2 }, ownerId);
    await owner;
    turn.end(true);
    finish('ended');
    expect((events.at(-1) as { command: { kind: string } }).command.kind).toBe('seek');
    course.end();
  });

  it('rejects stale frame reports and old bridge instances', async () => {
    const { course } = await makeFixture();
    await course.load('root-1', 'ch01/index.html');
    const epoch = course.view()!.courseEpoch;
    const frame = { index: 0, id: 'intro', title: '介绍', playing: false, waiting: false, done: false, generation: 1 };
    expect(course.report(epoch, frame, undefined, 'bridge-a', 2)).toBe(true);
    expect(course.report(epoch, { ...frame, playing: true }, undefined, 'bridge-a', 1)).toBe(false);
    expect(course.report(epoch, frame, undefined, 'bridge-b', 1)).toBe(false);
    course.markUnknown();
    expect(course.report(epoch, frame, undefined, 'bridge-b', 1)).toBe(false);
    await course.load('root-1', 'ch01/index.html');
    const replacement = course.view()!.courseEpoch;
    expect(course.report(replacement, frame, undefined, 'bridge-b', 1)).toBe(true);
    expect(course.report(epoch, frame, undefined, 'bridge-a', 3)).toBe(false);
    course.end();
  });
});
