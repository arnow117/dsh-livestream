import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { LiveShow } from '../src/body/show';
import { CourseController } from '../src/body/course/controller';
import { bindDirectory } from '../src/dsh/sessionContextPaths';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'course-life-'));
  const root = join(dir, 'materials');
  await mkdir(join(root, 'ch01'), { recursive: true });
  await writeFile(join(root, 'ch01/index.html'), '<!doctype html><p>course</p>');
  const binding = await bindDirectory(root);
  if (typeof binding === 'string') throw new Error(binding);
  const show = new LiveShow({ push: vi.fn(async () => true), synthesize: vi.fn(async () => null) }, { dataDir: dir, names: ['角色'] });
  show.setPlatform('douyin');
  show.goLive('session-a');
  clearInterval((show as any).director);
  (show as any).director = null;
  const events: any[] = [];
  const course = new CourseController({
    current: () => show.isOnAir && show.currentSession ? { sessionId: show.currentSession, roots: [{ rootId: 'root-1', binding }] } : null,
    publish: (event) => events.push(event),
  });
  show.course = course;
  show.onCourseEnd = () => course.end();
  const off = show.stage.onOutputChange(() => course.invalidateOutput());
  await course.load('root-1', 'ch01/index.html');
  const frame = { index: 8, id: 'lab', title: '实验', playing: true, waiting: true, done: false, generation: 4, lab: { left: 2, right: 1, force: 20, balanced: false } };
  const epoch = course.view()!.courseEpoch;
  course.report(epoch, frame);
  return { dir, show, course, events, epoch, frame, cleanup: async () => { off(); show.dispose(); await rm(dir, { recursive: true, force: true }); } };
}

it.each(['session', 'platform', 'target', 'offair', 'dispose'] as const)(
  'revokes the course and late audience action on actual %s transition',
  async (transition) => {
    const { show, course, events, epoch, frame, cleanup } = await fixture();
    try {
      const assets = course.assets!;
      const stamp = course.capture('session-a')!;
      const action = course.applyAction({ kind: 'param', which: 'left', value: 1.3, unit: 'm' }, stamp.valid);
      const commandId = events.at(-1).command.id;
      if (transition === 'session') show.goLive('session-b');
      if (transition === 'platform') show.setPlatform('bilibili');
      if (transition === 'target') {
        vi.spyOn(show.hub, 'currentConfig', 'get').mockReturnValue({ platform: 'douyin', roomId: 'old', bridgeUrl: 'http://127.0.0.1:1' });
        vi.spyOn(show.hub, 'connect').mockImplementation(() => show.hub.status());
        show.connectTarget({ platform: 'douyin', roomId: 'new', bridgeUrl: 'http://127.0.0.1:1' });
      }
      if (transition === 'offair') show.endLive();
      if (transition === 'dispose') show.dispose();
      expect(await action).toContain('未确认');
      expect(assets.active).toBe(false);
      expect(await assets.read('ch01/index.html')).toBeNull();
      expect(course.view()).toBeNull();
      expect(course.report(epoch, { ...frame, lab: { ...frame.lab, left: 1.3 } }, commandId)).toBe(false);
    } finally {
      await cleanup();
    }
  },
);

it('preserves the course on subscription disconnect while invalidating the previous output', async () => {
  const { show, course, events, epoch, frame, cleanup } = await fixture();
  try {
    const assets = course.assets!;
    const outputEpoch = show.stage.outputEpoch;
    const stamp = course.capture('session-a')!;
    const action = course.applyAction({ kind: 'param', which: 'left', value: 1.3, unit: 'm' }, stamp.valid);
    const oldCommand = events.at(-1).command.id;
    show.disconnect();
    expect(await action).toContain('未确认');
    expect(show.stage.outputEpoch).not.toBe(outputEpoch);
    expect(course.view()?.courseEpoch).toBe(epoch);
    expect(await assets.read('ch01/index.html')).not.toBeNull();
    expect(course.report(epoch, { ...frame, lab: { ...frame.lab, left: 1.3 } }, oldCommand)).toBe(false);
    const owner = course.command('step', 0);
    const ownerCommand = events.at(-1).command.id;
    expect(course.report(epoch, { index: 0, id: 'intro', title: '介绍', playing: false, waiting: false, done: false, generation: 5 }, ownerCommand)).toBe(true);
    await expect(owner).resolves.toBeUndefined();
  } finally {
    await cleanup();
  }
});

it('creates a new output epoch when an on-air course session is switched', async () => {
  const { show, course, cleanup } = await fixture();
  try {
    const previousOutput = show.stage.outputEpoch;
    const previousAssets = course.assets!;
    show.goLive('session-b');
    expect(course.view()).toBeNull();
    expect(previousAssets.active).toBe(false);
    expect(show.currentSession).toBe('session-b');
    expect(show.stage.outputEpoch).toBeTruthy();
    expect(show.stage.outputEpoch).not.toBe(previousOutput);
    await course.load('root-1', 'ch01/index.html');
    expect(course.view()).not.toBeNull();
  } finally {
    await cleanup();
  }
});

it('does not replay an old audience event after an explicit subscription reconnect', async () => {
  const { show, course, cleanup } = await fixture();
  const seen: string[] = [];
  const off = show.stage.subscribe((event) => { if (event.type === 'live') seen.push(event.event.id); }, false);
  const message = { platform: 'douyin' as const, kind: 'chat' as const, id: 'old-message', ts: Date.now(), user: { id: 'viewer', name: '观众' }, text: '原来的问题？' };
  try {
    show.inject(message);
    expect(seen).toEqual(['old-message']);
    show.disconnect();
    vi.spyOn(show.hub, 'connect').mockImplementation(() => show.hub.status());
    show.connectTarget({ platform: 'douyin', roomId: 'same', bridgeUrl: 'http://127.0.0.1:1' });
    expect(course.view()).not.toBeNull();
    show.inject(message);
    expect(seen).toEqual(['old-message']);
    show.inject({ ...message, id: 'new-message', text: '新的问题？' });
    expect(seen).toEqual(['old-message', 'new-message']);
    course.end();
    show.disconnect();
    show.connectTarget({ platform: 'douyin', roomId: 'same', bridgeUrl: 'http://127.0.0.1:1' });
    show.inject(message);
    expect(seen).toEqual(['old-message', 'new-message', 'old-message']);
  } finally {
    off();
    await cleanup();
  }
});

it('fails closed at the bounded replay limit and clears it for a new session', async () => {
  const { show, course, cleanup } = await fixture();
  const seen: string[] = [];
  const off = show.stage.subscribe((event) => { if (event.type === 'live') seen.push(event.event.id); }, false);
  const log = vi.fn();
  (show as any).hooks.log = log;
  const ids = (show as any).courseAudienceEvents as Set<string>;
  for (let index = 0; index < 5000; index++) ids.add(`douyin:old-${index}`);
  const message = { platform: 'douyin' as const, kind: 'chat' as const, id: 'blocked-1', ts: Date.now(), user: { id: 'viewer', name: '观众' }, text: '问题？' };
  try {
    show.inject(message);
    show.inject({ ...message, id: 'blocked-2' });
    expect(seen).toEqual([]);
    expect(log).toHaveBeenCalledTimes(1);
    show.goLive('session-b');
    expect(ids.size).toBe(0);
    await course.load('root-1', 'ch01/index.html');
    show.inject({ ...message, id: 'new-session-event' });
    expect(seen).toEqual(['new-session-event']);
  } finally {
    off();
    await cleanup();
  }
});

it('ending the course does not cancel an unrelated owned speech already being prepared', async () => {
  const { show, course, cleanup } = await fixture();
  let synthesisStarted!: () => void;
  const started = new Promise<void>((resolve) => { synthesisStarted = resolve; });
  let releaseSynthesis!: (result: { audio: Uint8Array; timeline: [] }) => void;
  (show as any).hooks.synthesize = () => {
    synthesisStarted();
    return new Promise((resolve) => { releaseSynthesis = resolve; });
  };
  const spoken: string[] = [];
  const off = show.stage.subscribe((event) => {
    if (event.type === 'say') {
      spoken.push(event.text);
      show.stage.said(event.id);
    }
  }, false, 'owned-live-v1');
  try {
    const signal = new AbortController().signal;
    const epoch = show.stage.outputEpoch!;
    const speech = show.say('独立查询回复', '', signal, 'live', { owner: { epoch, turn: 'query' }, signal, valid: () => true });
    await started;
    course.end();
    expect(show.stage.outputEpoch).toBe(epoch);
    releaseSynthesis({ audio: new Uint8Array([1]), timeline: [] });
    expect(await speech).toBe('独立查询回复');
    expect(spoken).toEqual(['独立查询回复']);
  } finally {
    off();
    await cleanup();
  }
});

it('waits for a confirmed narration pause before guest speech and does not resume after missing audio', async () => {
  const { show, course, events, epoch, cleanup } = await fixture();
  const intro = { index: 0, id: 'intro', title: '介绍', playing: true, waiting: false, done: false, generation: 5 };
  course.report(epoch, intro);
  let pauseSent!: () => void;
  const pauseBarrier = new Promise<void>((resolve) => { pauseSent = resolve; });
  const options = (course as any).options;
  const publish = options.publish;
  options.publish = (event: any) => {
    publish(event);
    if (event.action === 'command' && event.command.kind === 'pause') pauseSent();
  };
  const synthesize = vi.fn(async () => null);
  (show as any).hooks.synthesize = synthesize;
  const off = show.stage.subscribe((event) => {
    if (event.type === 'say') show.stage.said(event.id);
  }, true, 'owned-live-v1');
  try {
    const speech = show.guestSay('嘉宾', '一段话', 'voice', new AbortController().signal);
    await pauseBarrier;
    expect(synthesize).not.toHaveBeenCalled();
    const commandId = events.at(-1).command.id;
    expect(course.report(epoch, { ...intro, playing: false }, commandId)).toBe(true);
    expect(await speech).toBe('一段话');
    expect(synthesize).toHaveBeenCalled();
    expect(events.at(-1).command.kind).toBe('pause');
  } finally {
    off();
    await cleanup();
  }
});

it.each(['pause', 'step', 'reset', 'end', 'disconnect', 'session', 'target'] as const)(
  'discards a late course-owned synthesis after %s',
  async (transition) => {
    const { show, course, events, epoch, cleanup } = await fixture();
    const intro = { index: 0, id: 'intro', title: '介绍', playing: true, waiting: false, done: false, generation: 5 };
    course.report(epoch, intro);
    const stamp = course.capture('session-a')!;
    const abort = new AbortController();
    const offInvalidation = course.onInvalidate(() => abort.abort());
    let pauseSent!: () => void;
    const pauseBarrier = new Promise<void>((resolve) => { pauseSent = resolve; });
    const options = (course as any).options;
    const publish = options.publish;
    options.publish = (event: any) => {
      publish(event);
      if (event.action === 'command' && event.command.kind === 'pause') pauseSent();
    };
    let synthesisStarted!: () => void;
    const started = new Promise<void>((resolve) => { synthesisStarted = resolve; });
    let releaseSynthesis!: (result: { audio: Uint8Array; timeline: [] }) => void;
    (show as any).hooks.synthesize = () => {
      synthesisStarted();
      return new Promise((resolve) => { releaseSynthesis = resolve; });
    };
    const spoken: string[] = [];
    const offStage = show.stage.subscribe((event) => { if (event.type === 'say') spoken.push(event.text); }, true, 'owned-live-v1');
    try {
      const outputEpoch = show.stage.outputEpoch!;
      const speech = show.say('过期课程回复', '', abort.signal, 'live', {
        owner: { epoch: outputEpoch, turn: 'viewer' }, signal: abort.signal, valid: stamp.valid,
      });
      await pauseBarrier;
      course.report(epoch, { ...intro, playing: false }, events.at(-1).command.id);
      await started;
      if (transition === 'pause' || transition === 'step') {
        const command = transition === 'pause' ? course.command('pause') : course.command('step', 1);
        const commandId = events.at(-1).command.id;
        const ownerFrame = transition === 'pause' ? { ...intro, playing: false }
          : { index: 1, id: 'parts', title: '部件', playing: false, waiting: false, done: false, generation: 6 };
        course.report(epoch, ownerFrame, commandId);
        await command;
      } else if (transition === 'reset') await course.command('reset');
      else if (transition === 'end') course.end();
      else if (transition === 'disconnect') show.disconnect();
      else if (transition === 'session') show.goLive('session-b');
      else {
        vi.spyOn(show.hub, 'currentConfig', 'get').mockReturnValue({ platform: 'douyin', roomId: 'old', bridgeUrl: 'http://127.0.0.1:1' });
        vi.spyOn(show.hub, 'connect').mockImplementation(() => show.hub.status());
        show.connectTarget({ platform: 'douyin', roomId: 'new', bridgeUrl: 'http://127.0.0.1:1' });
      }
      releaseSynthesis({ audio: new Uint8Array([1]), timeline: [] });
      expect(await speech).toBe('');
      expect(spoken).toEqual([]);
      expect(show.status().lines).toEqual([]);
    } finally {
      offInvalidation();
      offStage();
      await cleanup();
    }
  },
);
