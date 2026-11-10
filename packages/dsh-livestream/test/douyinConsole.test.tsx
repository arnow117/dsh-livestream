// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Console } from '../src/console/console';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('console platform settings with real handlers', () => {
  let dir: string;
  let element: HTMLDivElement;
  let root: Root;
  let runtime: typeof import('../src/dsh/runtime');
  const env = { ...process.env };
  let eventSource: { onmessage?: (event: { data: string }) => void };
  let holdNextQuery = false;
  let queryHeld: (() => void) | undefined;
  let releaseQuery: (() => void) | undefined;
  let roomQueries = 0;
  let roomQueriesInFlight = 0;
  let maxRoomQueriesInFlight = 0;
  let unmounted = false;
  const routes = new Map<string, (request: Request) => Response | Promise<Response>>();
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'douyin-console-'));
    process.env.DSH_HOME = dir;
    process.env.DSH_LIVESTREAM_LOCAL_REHEARSAL = '1';
    const host = await import('../src/dsh/index');
    runtime = await import('../src/dsh/runtime');
    host.apply({
      effect(effect: () => unknown, label?: string) {
        if (['state', 'settings', 'room control', 'simulate', 'disconnect'].includes(label ?? '')) effect();
      },
      provide() {},
      connection: { fetch: { register(route: { path: string; fetch: (request: Request) => Response }) { routes.set(route.path, route.fetch); return () => {}; } } },
    });
    vi.stubGlobal('EventSource', class {
      onmessage?: (event: { data: string }) => void;
      constructor() { eventSource = this; }
      addEventListener() {}
      close() {}
    });
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.hostname === '127.0.0.1') return new Response('{}', { status: 404 });
      const route = routes.get(url.pathname);
      if (!route) throw new Error(`unexpected route ${url.pathname}`);
      const isRoomQuery = url.pathname.endsWith('/room-control');
      if (isRoomQuery) {
        roomQueries++;
        roomQueriesInFlight++;
        maxRoomQueriesInFlight = Math.max(maxRoomQueriesInFlight, roomQueriesInFlight);
      }
      try {
        const response = await route(new Request(url, init));
        if (isRoomQuery && holdNextQuery) {
          holdNextQuery = false;
          await new Promise<void>((resolve) => { releaseQuery = resolve; queryHeld?.(); });
        }
        return response;
      } finally {
        if (isRoomQuery) roomQueriesInFlight--;
      }
    }));
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: () => {} });
    element = document.createElement('div');
    document.body.append(element);
    root = createRoot(element);
    await act(async () => { root.render(<Console />); });
  });
  afterAll(async () => {
    if (!unmounted) await act(async () => root.unmount());
    element.remove();
    runtime.show.dispose();
    vi.unstubAllGlobals();
    process.env = env;
    await rm(dir, { recursive: true, force: true });
  });
  const click = async (name: string) => {
    const button = [...element.querySelectorAll('button')].find((item) => item.textContent?.trim() === name);
    expect(button).toBeDefined();
    await act(async () => { button!.click(); });
  };
  const field = (id: string) => element.querySelector(`#${id}`) as HTMLInputElement | HTMLSelectElement;
  const change = async (id: string, value: string) => {
    const input = field(id);
    await act(async () => { input.value = value; Simulate.change(input); });
  };

  it('saves a validated target, preserves a failed draft and limits Douyin controls', async () => {
    await change('live-platform', 'douyin');
    expect(element.textContent).toContain('抖音房间号或完整直播间地址');
    expect(runtime.settings.livePlatform).toBe('bilibili');
    await change('live-room', 'https://v.douyin.com/invalid');
    await click('保存');
    expect(element.textContent).toContain('请输入抖音数字房间号');
    expect(field('live-room').value).toBe('https://v.douyin.com/invalid');
    await change('live-room', 'https://live.douyin.com/12345678901234567');
    await click('保存');
    expect(runtime.settings.douyinRoomId).toBe('12345678901234567');
    expect(runtime.settings.livePlatform).toBe('douyin');
    expect(element.textContent).toContain('连接状态：没连接');
    expect(element.textContent).not.toContain('推流到 B 站');
    await change('live-platform', 'bilibili');
    expect(element.textContent).toContain('本地彩排模式不能连接 B 站直播间');
    expect(runtime.settings.livePlatform).toBe('douyin');
    await change('live-platform', 'douyin');
    await click('设置');
    expect(element.textContent).toContain('礼物金额未知时仍按节奏安排感谢');
    expect([...element.querySelectorAll('textarea')].some((area) => area.value.includes('抖音只读接入'))).toBe(true);
    await click('关闭');
    await act(async () => eventSource.onmessage?.({ data: JSON.stringify({ type: 'live', event: { kind: 'chat', id: 'old', user: { id: 'u', name: '测试' }, text: '保留内容' } }) }));
    expect(element.textContent).toContain('保留内容');
    await act(async () => eventSource.onmessage?.({ data: JSON.stringify({ type: 'focus', userIds: ['u'] }) }));
    expect(element.querySelector('.dl-feed-row.dl-focus')).not.toBeNull();
    await act(async () => eventSource.onmessage?.({ data: JSON.stringify({ type: 'reload' }) }));
    expect(element.textContent).toContain('保留内容');
    expect(element.querySelector('.dl-feed-row.dl-focus')).not.toBeNull();
    await act(async () => eventSource.onmessage?.({ data: JSON.stringify({ type: 'reload', scope: 'target' }) }));
    expect(element.textContent).not.toContain('保留内容');
    await act(async () => eventSource.onmessage?.({ data: JSON.stringify({ type: 'live', event: { kind: 'chat', id: 'new', user: { id: 'u', name: '新平台' }, text: '新内容' } }) }));
    expect(element.textContent).toContain('新内容');
    expect(element.querySelector('.dl-feed-row.dl-focus')).toBeNull();
    await click('模拟观众');
    expect(element.textContent).toContain('小花 ×5');
    expect(element.textContent).not.toContain('小电视飞船');
    await click('小花 ×5');
    expect(runtime.show.hub.recentEvents()[0]).toMatchObject({ platform: 'douyin', valueKnown: false });
  });

  it('ignores an older poll and refreshes another page’s target without overwriting the draft', async () => {
    const held = new Promise<void>((resolve) => { queryHeld = resolve; });
    holdNextQuery = true;
    await act(async () => { await held; });
    await change('live-room', '222');
    await click('保存');
    expect(runtime.settings.douyinRoomId).toBe('222');
    await act(async () => { releaseQuery?.(); });
    expect(element.textContent).toContain('已保存：抖音 222');

    await change('live-room', '333');
    expect(element.textContent).toContain('确认停止抖音 222 的采集');
    const settingsRoute = routes.get('/api/dsh-livestream/settings')!;
    const external = await settingsRoute(new Request('http://localhost/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ livePlatform: 'bilibili', roomId: 42 }),
    }));
    expect(external.status).toBe(200);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_200)); });
    expect(element.textContent).toContain('已保存：B 站 42');
    expect(field('live-room').value).toBe('333');
    expect((field('live-platform') as HTMLSelectElement).value).toBe('douyin');
  });

  it('accepts a slow poll without overlapping requests and stops polling after unmount', async () => {
    const settingsRoute = routes.get('/api/dsh-livestream/settings')!;
    const external = await settingsRoute(new Request('http://localhost/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ livePlatform: 'douyin', douyinRoomId: '444' }),
    }));
    expect(external.status).toBe(200);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_200)); });
    expect(element.textContent).toContain('已保存：抖音 444');
    const held = new Promise<void>((resolve) => { queryHeld = resolve; });
    holdNextQuery = true;
    await act(async () => { await held; });
    const started = roomQueries;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2_200)); });
    expect(roomQueries).toBe(started);
    expect(maxRoomQueriesInFlight).toBe(1);
    await act(async () => { releaseQuery?.(); });
    expect(element.textContent).toContain('采集服务：可用；房间状态：未接入');
    await act(async () => root.unmount());
    unmounted = true;
    const atUnmount = roomQueries;
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(roomQueries).toBe(atUnmount);
  }, 10_000);
});
