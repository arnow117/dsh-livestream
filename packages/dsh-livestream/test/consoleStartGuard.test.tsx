// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Console, bindConsole, sessionContextStartBlockReason } from '../src/console/console';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 正式评审 R2：损坏的保存记录（invalid）不同于真正无配置的 legacy——
 * 开始动作的守卫在两层验证：导出的拒绝理由函数（回调层，任何副作用前拒绝）
 * 与真实组件（invalid 时按钮禁用 + 点击零 native/preset/broadcast/onair 副作用）。
 */

const corruptedBySchema = { sessionContext: { invalid: '不支持的 schemaVersion' } };
const corruptedByBindings = { sessionContext: { invalid: '损坏的绑定' } };

describe('console start action refuses a corrupted session-context record before any side effect', () => {
  it('rejects corrupted records and accepts saved and legacy states at the callback guard', () => {
    expect(sessionContextStartBlockReason(corruptedBySchema)).toContain('会话设置已损坏');
    expect(sessionContextStartBlockReason(corruptedBySchema)).toContain('修正或关闭');
    expect(sessionContextStartBlockReason(corruptedByBindings)).toContain('会话设置已损坏');
    // saved 与真正无配置 legacy 都放行（返回 null）
    expect(sessionContextStartBlockReason({ sessionContext: { saved: { revision: 1 } } } as never)).toBeNull();
    expect(sessionContextStartBlockReason({ sessionContext: undefined })).toBeNull();
    expect(sessionContextStartBlockReason(null)).toBeNull();
  });

  describe('real component action', () => {
    let dir: string;
    let element: HTMLDivElement;
    let root: Root;
    let runtime: typeof import('../src/dsh/runtime');
    const env = { ...process.env };
    const routes = new Map<string, (request: Request) => Response | Promise<Response>>();
    const calledPaths: string[] = [];
    const recorders = {
      workspacesSnapshots: 0,
      sessionsCreated: 0,
      presetSelected: 0,
      sessionsUsed: 0,
    };

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), 'console-start-guard-'));
      process.env.DSH_HOME = dir;
      process.env.DSH_LIVESTREAM_LOCAL_REHEARSAL = '1';
      const host = await import('../src/dsh/index');
      runtime = await import('../src/dsh/runtime');
      host.apply({
        effect(effect: () => unknown, label?: string) {
          if (['state', 'settings'].includes(label ?? '')) effect();
        },
        provide() {},
        connection: { fetch: { register(route: { path: string; fetch: (request: Request) => Response }) { routes.set(route.path, route.fetch); return () => {}; } } },
      });
      vi.stubGlobal('EventSource', class {
        onmessage?: (event: { data: string }) => void;
        addEventListener() {}
        close() {}
      });
      vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input), 'http://localhost');
        calledPaths.push(url.pathname);
        const route = routes.get(url.pathname);
        if (!route) throw new Error(`unexpected route ${url.pathname}`);
        return route(new Request(url, { method: 'GET' }));
      }));
      bindConsole({
        workspaces: { list: { getSnapshot() { recorders.workspacesSnapshots += 1; return { items: [{ workspaceId: 'ws-guard' }] }; } } },
        uiWorkspace: { openSession() {} },
        sessions: {
          create() { recorders.sessionsCreated += 1; return Promise.resolve('legacy-session'); },
          using<T>(_target: string, _options: { source: string }, operation: (reference: { ready: Promise<{ session: any }> }) => T | Promise<T>): Promise<T> {
            recorders.sessionsUsed += 1;
            return Promise.resolve(operation({ ready: Promise.resolve({ session: { id: 'legacy-session' } }) }));
          },
        },
        remote: { agentPresets: { select() { recorders.presetSelected += 1; return Promise.resolve({ agentPreset: 'dsh-livestream' } as never); } } },
        layout: { selectPanel() {} },
      });
      Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: () => {} });
      element = document.createElement('div');
      document.body.append(element);
      root = createRoot(element);
    });

    afterAll(async () => {
      await act(async () => root.unmount());
      element.remove();
      runtime.show.dispose();
      vi.unstubAllGlobals();
      process.env = env;
      await rm(dir, { recursive: true, force: true });
    });

    /** 卸载旧根并新建：React 根 unmount 后不可复用，重挂载必须换新 root */
    const remount = async () => {
      await act(async () => root.unmount());
      root = createRoot(element);
      await act(async () => root.render(<Console />));
    };

    const startButton = () => [...element.querySelectorAll('button')].find((item) => item.textContent?.trim().includes('开始'));

    const assertNoSideEffects = (before: number) => {
      expect(recorders).toEqual({ workspacesSnapshots: 0, sessionsCreated: 0, presetSelected: 0, sessionsUsed: 0 });
      const sideEffectPaths = calledPaths.slice(before).filter((path) => /onair|\/sessions|broadcast/.test(path));
      expect(sideEffectPaths, `no native/broadcast/onair side effects expected, got ${sideEffectPaths.join(',')}`).toEqual([]);
    };

    it('disables the start button for an unknown schemaVersion and records zero side effects on click', async () => {
      runtime.settings.sessionContext = { schemaVersion: 2, revision: 3, config: { enabled: false, cwd: '', skillSources: [], readRoots: [] }, bindings: { cwd: null, skills: [], roots: [] } };
      await remount();
      const button = startButton();
      expect(button).toBeDefined();
      expect(button!.disabled, 'corrupted record must disable the start button (supplementary guard)').toBe(true);
      const before = calledPaths.filter((path) => path !== '/api/dsh-livestream/state').length;
      await act(async () => { button!.click(); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
      assertNoSideEffects(before);
    });

    it('disables the start button for corrupted bindings and records zero side effects on click', async () => {
      runtime.settings.sessionContext = { schemaVersion: 1, revision: 4, config: { enabled: true, cwd: '/tmp/guard', skillSources: [], readRoots: [] }, bindings: { cwd: null, skills: [{ path: 'not-absolute', dev: -1, ino: 0, index: 0 }], roots: [] } };
      await remount();
      const button = startButton();
      expect(button!.disabled).toBe(true);
      const before = calledPaths.filter((path) => path !== '/api/dsh-livestream/state').length;
      await act(async () => { button!.click(); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
      assertNoSideEffects(before);
    });

    it('re-enables the managed start path after the owner explicitly replaces the corrupted record', async () => {
      runtime.settings.sessionContext = { schemaVersion: 1, revision: 0, config: { enabled: false, cwd: '', skillSources: [], readRoots: [] }, bindings: { cwd: null, skills: [], roots: [] } };
      await remount();
      const button = startButton();
      expect(button!.disabled).toBe(false);
      const before = calledPaths.filter((path) => path !== '/api/dsh-livestream/state').length;
      await act(async () => { button!.click(); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
      // 显式替换损坏记录后：走管理创建路径（POST /sessions 已发出）
      expect(calledPaths.slice(before).some((path) => path.endsWith('/api/dsh-livestream/sessions'))).toBe(true);
    });
  });
});
