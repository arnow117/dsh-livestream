// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Console } from '../src/console/console';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('broadcast cleanup recovery', () => {
  it('offers a stop retry while the old owner still has uncertain activity', async () => {
    const env = { ...process.env };
    const dir = await mkdtemp(join(tmpdir(), 'broadcast-console-'));
    process.env.DSH_HOME = dir;
    delete process.env.DSH_LIVESTREAM_LOCAL_REHEARSAL;
    const host = await import('../src/dsh/index');
    const runtime = await import('../src/dsh/runtime');
    (runtime.broadcast as any).state = { ...runtime.broadcast.status(), phase: 'error', error: '清理失败' };
    (runtime.broadcast as any).mayOwnRoom = true;
    const stop = vi.spyOn(runtime.broadcast, 'stop').mockImplementation(async () => {
      (runtime.broadcast as any).mayOwnRoom = false;
      (runtime.broadcast as any).state.phase = 'idle';
    });
    const routes = new Map<string, (request: Request) => Response | Promise<Response>>();
    host.apply({
      effect(effect: () => unknown, label?: string) { if (label === 'state' || label === 'broadcast stop') effect(); },
      provide() {},
      connection: { fetch: { register(route: { path: string; fetch: (request: Request) => Response }) { routes.set(route.path, route.fetch); return () => {}; } } },
    });
    vi.stubGlobal('EventSource', class { addEventListener() {} close() {} });
    vi.stubGlobal('fetch', vi.fn((input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://localhost');
      return routes.get(url.pathname)!(new Request(url, init));
    }));
    const element = document.createElement('div');
    document.body.append(element);
    const root = createRoot(element);
    try {
      await act(async () => root.render(<Console />));
      const retry = [...element.querySelectorAll('button')].find((button) => button.textContent === '重试停止推流');
      expect(retry).toBeDefined();
      await act(async () => retry!.click());
      expect(stop).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      element.remove();
      runtime.show.dispose();
      stop.mockRestore();
      vi.unstubAllGlobals();
      process.env = env;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
