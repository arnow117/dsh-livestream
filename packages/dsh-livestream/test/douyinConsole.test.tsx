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
  const routes = new Map<string, (request: Request) => Response | Promise<Response>>();
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'douyin-console-'));
    process.env.DSH_HOME = dir;
    process.env.DSH_LIVESTREAM_LOCAL_REHEARSAL = '1';
    const host = await import('../src/dsh/index');
    runtime = await import('../src/dsh/runtime');
    host.apply({
      effect(effect: () => unknown, label?: string) {
        if (['state', 'settings', 'simulate', 'disconnect'].includes(label ?? '')) effect();
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
      const route = routes.get(url.pathname);
      if (!route) throw new Error(`unexpected route ${url.pathname}`);
      return route(new Request(url, init));
    }));
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: () => {} });
    element = document.createElement('div');
    document.body.append(element);
    root = createRoot(element);
    await act(async () => { root.render(<Console />); });
  });
  afterAll(async () => {
    await act(async () => root.unmount());
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
    await click('设置');
    await change('live-platform', 'douyin');
    expect(element.textContent).toContain('抖音房间号或完整直播间地址');
    expect(element.textContent).toContain('打开采集控制台');
    expect(element.textContent).toContain('礼物金额未知时仍按节奏安排感谢');
    expect([...element.querySelectorAll('textarea')].some((area) => area.value.includes('抖音只读接入'))).toBe(true);
    await change('live-room', 'https://v.douyin.com/invalid');
    await click('保存');
    expect(element.textContent).toContain('请输入抖音数字房间号');
    expect(field('live-room').value).toBe('https://v.douyin.com/invalid');
    await change('live-room', 'https://live.douyin.com/12345678901234567');
    await click('保存');
    expect(runtime.settings.douyinRoomId).toBe('12345678901234567');
    expect(element.textContent).toContain('连接状态：没连接');
    expect(element.textContent).not.toContain('推流到 B 站');
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
});
