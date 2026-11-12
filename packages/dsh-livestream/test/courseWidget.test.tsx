// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  document.body.replaceChildren();
  history.replaceState(null, '', '/');
});

it('opens a silent preview without forwarding reports or commands', async () => {
  history.replaceState(null, '', '/?preview=1');
  let source!: FakeSource;
  class FakeSource {
    onmessage?: (event: { data: string }) => void;
    constructor() { source = this; }
    send(event: unknown) { this.onmessage?.({ data: JSON.stringify(event) }); }
  }
  const fetcher = vi.fn(async () => ({}));
  vi.stubGlobal('EventSource', FakeSource);
  vi.stubGlobal('fetch', fetcher);
  const store = await import('../src/stage/store');
  const { Course } = await import('../src/stage/widgets');
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  await act(async () => {
    store.connect();
    source.send({ type: 'hello', character: {}, template: {}, outputEpoch: 'output' });
    source.send({ type: 'course', action: 'open', epoch: 'course-1', url: '/course/asset/fake/ch01/index.html' });
    root.render(<Course />);
  });
  const child = element.querySelector('iframe')!.contentWindow!;
  const post = vi.spyOn(child, 'postMessage').mockImplementation(() => {});
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'course-bridge-ready' }, origin: location.origin, source: child }));
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'course-report', epoch: 'course-1', frame: {} }, origin: location.origin, source: child }));
    source.send({ type: 'course', action: 'command', epoch: 'course-1', command: { kind: 'pause', id: 'command' } });
  });
  expect(post).toHaveBeenCalledOnce();
  expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'course-open', preview: true }), location.origin);
  expect(fetcher).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});

it('forwards only the current same-origin bridge reports and disconnects its frame', async () => {
  let source!: FakeSource;
  class FakeSource {
    onmessage?: (event: { data: string }) => void;
    onerror?: () => void;
    constructor() { source = this; }
    send(event: unknown) { this.onmessage?.({ data: JSON.stringify(event) }); }
  }
  const fetcher = vi.fn(async () => ({}));
  vi.stubGlobal('EventSource', FakeSource);
  vi.stubGlobal('fetch', fetcher);
  const store = await import('../src/stage/store');
  const { Course } = await import('../src/stage/widgets');
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  await act(async () => {
    store.connect();
    source.send({ type: 'hello', character: {}, template: {}, outputEpoch: 'output' });
    source.send({ type: 'course', action: 'open', epoch: 'course-1', url: '/course/asset/fake/ch01/index.html' });
    root.render(<Course />);
  });
  const iframe = element.querySelector('iframe')!;
  const child = iframe.contentWindow!;
  const post = vi.spyOn(child, 'postMessage').mockImplementation(() => {});
  const send = (data: unknown, origin = location.origin, from: MessageEventSource | null = child) => {
    window.dispatchEvent(new MessageEvent('message', { data, origin, source: from }));
  };
  await act(async () => {
    iframe.dispatchEvent(new Event('load'));
    send({ type: 'course-bridge-ready' }, 'https://invalid.example');
    send({ type: 'course-bridge-ready' }, location.origin, window);
  });
  expect(post).toHaveBeenCalledTimes(1);
  await act(async () => send({ type: 'course-bridge-ready' }));
  expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'course-open', epoch: 'course-1', preview: false }), location.origin);
  await act(async () => {
    send({ type: 'course-report', epoch: 'old', frame: {} });
    send({ type: 'course-report', epoch: 'course-1', frame: { index: 0 }, instance: 'bridge', sequence: 1 });
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('/course/report?token='), expect.objectContaining({ method: 'POST' }));
  await act(async () => source.send({ type: 'course', action: 'command', epoch: 'course-1', command: { kind: 'pause', id: 'command' } }));
  expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'course-command', epoch: 'course-1' }), location.origin);
  await act(async () => source.onerror?.());
  expect(post).toHaveBeenLastCalledWith({ type: 'course-disconnect', epoch: 'course-1' }, location.origin);
  await act(async () => root.unmount());
});
