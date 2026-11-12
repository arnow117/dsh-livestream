// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoursePanel, type HostState } from '../src/console/console';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('course console', () => {
  const rootElement = document.createElement('div');
  document.body.append(rootElement);
  const root = createRoot(rootElement);
  afterEach(async () => {
    await act(async () => root.render(null));
    vi.unstubAllGlobals();
  });

  it('loads a selected authorized root and displays confirmed lab values', async () => {
    const state = {
      ok: true, show: { onAir: true },
      sessionContext: { active: { rootIds: ['root-1'] } },
      course: {
        phase: 'paused', courseEpoch: 'epoch', playUnknown: false, pauseReason: 'owner',
        step: { index: 8, id: 'lab', title: '实验', playing: false, waiting: true, done: false, generation: 1 },
        lab: { left: 1.3, right: 1, force: 20, balanced: false }, question: null,
        lastAction: { kind: 'param', status: 'applied', detail: '已应用', at: 1 }, steps: [],
      },
    } as unknown as HostState;
    const save = vi.fn();
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(state));
    vi.stubGlobal('fetch', fetcher);
    await act(async () => root.render(<CoursePanel host={state} setHost={save} />));
    expect(rootElement.textContent).toContain('动力臂 1.3 m');
    expect(rootElement.textContent).toContain('等待互动');
    expect(rootElement.textContent).toContain('已应用');
    const load = [...rootElement.querySelectorAll('button')].find((button) => button.textContent === '加载课程')!;
    await act(async () => load.click());
    expect(fetcher).toHaveBeenCalledWith('/api/dsh-livestream/course', expect.objectContaining({ method: 'POST' }));
    const request = fetcher.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({ action: 'load', rootId: 'root-1', path: 'ch01/index.html' });
    expect(save).toHaveBeenCalled();
  });

  it('disables controls and shows an unknown state when the stage is unavailable', async () => {
    const state = { show: { onAir: false }, sessionContext: { active: null }, course: { playUnknown: true, steps: [] } } as unknown as HostState;
    await act(async () => root.render(<CoursePanel host={state} setHost={() => {}} />));
    expect(rootElement.textContent).toContain('舞台状态未确认');
    const start = [...rootElement.querySelectorAll('button')].find((button) => button.textContent === '开始')!;
    expect(start.disabled).toBe(true);
  });

  it('merges a course poll without replacing newer host settings', async () => {
    vi.useFakeTimers();
    try {
      const state = { show: { onAir: true }, sessionContext: { active: null }, course: null, settings: { marker: 'old' } } as unknown as HostState;
      const newer = { ...state, settings: { marker: 'new' } } as unknown as HostState;
      const save = vi.fn();
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...state, course: { phase: 'paused' } })));
      await act(async () => root.render(<CoursePanel host={state} setHost={save} />));
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      const update = save.mock.calls[0][0];
      expect(update).toBeTypeOf('function');
      expect(update(newer)).toMatchObject({ settings: { marker: 'new' }, course: { phase: 'paused' } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a poll that finishes after an owner course command', async () => {
    vi.useFakeTimers();
    try {
      const state = { show: { onAir: true }, sessionContext: { active: { rootIds: ['root-1'] } }, course: null } as unknown as HostState;
      const updated = { ...state, course: { phase: 'loading', steps: [] } };
      let releasePoll!: (response: Response) => void;
      const poll = new Promise<Response>((resolve) => { releasePoll = resolve; });
      const fetcher = vi.fn((url: RequestInfo | URL) => String(url).endsWith('/state') ? poll : Promise.resolve(Response.json(updated)));
      const save = vi.fn();
      vi.stubGlobal('fetch', fetcher);
      await act(async () => root.render(<CoursePanel host={state} setHost={save} />));
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      const load = [...rootElement.querySelectorAll('button')].find((button) => button.textContent === '加载课程')!;
      await act(async () => load.click());
      expect(save).toHaveBeenCalledTimes(1);
      await act(async () => releasePoll(Response.json(state)));
      expect(save).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
