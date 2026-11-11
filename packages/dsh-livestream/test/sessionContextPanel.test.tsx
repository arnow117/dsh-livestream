// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionContextSettingsPanel } from '../src/console/SessionContextSettingsPanel';
import type { SessionContextStateView } from '../src/shared/sessionContext';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const viewWith = (overrides: Partial<SessionContextStateView> = {}): SessionContextStateView => ({
  saved: null,
  health: { checkedAt: 0, entries: [] },
  active: null,
  ...overrides,
});

const savedView = (revision = 1): SessionContextStateView => viewWith({
  saved: {
    revision,
    config: {
      enabled: true,
      cwd: '/tmp/workdir',
      skillSources: [{ path: '/tmp/skills/a.md', enabled: true }, { path: '/tmp/skills/gone.md', enabled: false }],
      readRoots: [{ path: '/tmp/materials', enabled: true }],
    },
  },
  health: {
    checkedAt: 1,
    entries: [
      { kind: 'cwd', index: 0, path: '/tmp/workdir', enabled: true, status: 'valid' },
      { kind: 'skill', index: 0, path: '/tmp/skills/a.md', enabled: true, status: 'valid' },
      { kind: 'skill', index: 1, path: '/tmp/skills/gone.md', enabled: false, status: 'disabled' },
      { kind: 'root', index: 0, path: '/tmp/materials', enabled: true, status: 'valid' },
    ],
  },
});

describe('session context settings panel', () => {
  let element: HTMLDivElement;
  let root: Root;
  let resolveFetch: (response: Response) => void;
  const onSaved = vi.fn();

  const button = (text: string) => [...element.querySelectorAll('button')].find((item) => item.textContent === text)!;
  const inputs = () => [...element.querySelectorAll('input[type="text"], input:not([type])')] as HTMLInputElement[];
  const fieldByLabel = (label: string) =>
    [...element.querySelectorAll('label')].find((item) => item.textContent?.startsWith(label))!.querySelector('input') as HTMLInputElement;
  const cwdField = () => document.getElementById('session-context-cwd') as HTMLInputElement;
  const change = async (field: HTMLInputElement, value: string) => {
    await act(async () => { field.value = value; Simulate.change(field); });
  };
  const click = async (text: string) => act(async () => { button(text).click(); });

  beforeEach(async () => {
    element = document.createElement('div');
    document.body.append(element);
    root = createRoot(element);
    vi.stubGlobal('fetch', vi.fn((_url: string, _init?: RequestInit) => new Promise<Response>((resolve) => { resolveFetch = resolve; })));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    element.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    onSaved.mockReset();
  });

  it('renders an empty draft for legacy installations and shows no active session', async () => {
    await act(async () => root.render(<SessionContextSettingsPanel view={viewWith()} onSaved={onSaved} />));
    expect(element.querySelector('#session-context-title')?.textContent).toBe('新直播会话');
    expect(cwdField().value).toBe('');
    expect(element.textContent).toContain('未保存过');
    expect(element.textContent).toContain('当前没有使用这些设置的活动直播会话。');
    expect(button('重查路径有效性').disabled).toBe(true);
  });

  it('adds and removes list entries and keeps the draft on view refresh', async () => {
    await act(async () => root.render(<SessionContextSettingsPanel view={viewWith()} onSaved={onSaved} />));
    await click('添加 Skill 来源');
    await change(inputs()[1]!, '/skills/from-draft.md');
    await click('添加资料根');
    await change(inputs()[2]!, '/materials/from-draft.md');
    expect(inputs()).toHaveLength(3);
    // 轮询带来的 view 更新不能覆盖未保存草稿
    await act(async () => root.render(<SessionContextSettingsPanel view={savedView(2)} onSaved={onSaved} />));
    expect(inputs()[1]!.value).toBe('/skills/from-draft.md');
    expect(inputs()[2]!.value).toBe('/materials/from-draft.md');
    await click('删除');
    expect(inputs()).toHaveLength(2);
  });

  it('submits the whole config with the current revision and syncs the draft after success', async () => {
    await act(async () => root.render(<SessionContextSettingsPanel view={savedView(3)} onSaved={onSaved} />));
    await change(cwdField(), '/tmp/new-workdir');
    await click('保存会话设置');
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('/api/dsh-livestream/settings');
    const payload = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]!.body));
    expect(payload.sessionContext.expectedRevision).toBe(3);
    expect(payload.sessionContext.config).toEqual({
      enabled: true,
      cwd: '/tmp/new-workdir',
      skillSources: [{ path: '/tmp/skills/a.md', enabled: true }, { path: '/tmp/skills/gone.md', enabled: false }],
      readRoots: [{ path: '/tmp/materials', enabled: true }],
    });
    await act(async () => resolveFetch(Response.json({ ok: true, sessionContext: savedView(4), settings: {} })));
    expect(onSaved).toHaveBeenCalled();
    expect(cwdField().value).toBe('/tmp/workdir');
    expect(element.textContent).toContain('已保存：将在此后新建的直播会话生效');
    // 视图 revision 仍来自当前 props（父组件收到 onSaved 后再刷新）；草稿已同步为已保存状态
    expect(element.textContent).toContain('已保存（第 3 版');
  });

  it('keeps inputs and shows the failing field when the save is rejected', async () => {
    await act(async () => root.render(<SessionContextSettingsPanel view={savedView(3)} onSaved={onSaved} />));
    await change(cwdField(), '/does/not/exist');
    await click('保存会话设置');
    await act(async () => resolveFetch(Response.json({ ok: false, error: '工作目录无效：/does/not/exist（config.cwd：not_found）' }, { status: 400 })));
    expect(cwdField().value).toBe('/does/not/exist');
    expect(element.textContent).toContain('工作目录无效');
    expect(cwdField().getAttribute('aria-invalid')).toBe('true');
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('shows health per entry including closed-not-checked for disabled items', async () => {
    await act(async () => root.render(<SessionContextSettingsPanel view={savedView()} onSaved={onSaved} />));
    expect(element.textContent).toContain('来源 1：已验证可用');
    expect(element.textContent).toContain('来源 2：已关闭，未检查');
    expect(element.textContent).toContain('资料根 1：已验证可用');
  });

  it('displays the active session snapshot or the explicit empty state', async () => {
    const active = viewWith({
      saved: savedView().saved,
      active: {
        sessionId: 'livestream-abc',
        revision: 2,
        platform: 'bilibili',
        presetId: 'dsh-livestream',
        effectiveCwd: '/tmp/workdir',
        cwdReady: true,
        skills: [{ name: 'papermorph', description: '示例', status: 'available', loadedAt: 5, contentHash: 'hash' }],
        rootIds: ['root-1'],
        issues: ['资料根 /gone 已失效'],
        createdAt: 1,
      },
    });
    await act(async () => root.render(<SessionContextSettingsPanel view={active} onSaved={onSaved} />));
    expect(element.textContent).toContain('活动会话 livestream-abc：第 2 版');
    expect(element.textContent).toContain('实际工作目录：/tmp/workdir');
    expect(element.textContent).toContain('papermorph（已加载）');
    expect(element.textContent).toContain('资料根 /gone 已失效');
    await act(async () => root.render(<SessionContextSettingsPanel view={viewWith()} onSaved={onSaved} />));
    expect(element.textContent).toContain('当前没有使用这些设置的活动直播会话。');
  });

  it('surfaces a corrupt persisted record and the resume hint', async () => {
    await act(async () => root.render(<SessionContextSettingsPanel view={viewWith({ invalid: '不支持的 schemaVersion', recheck: '已恢复直播会话设置，请手动开始新会话' })} onSaved={onSaved} />));
    expect(element.textContent).toContain('已保存的会话设置损坏');
    expect(element.textContent).toContain('已恢复直播会话设置，请手动开始新会话');
  });

  it('rechecks without saving and reports the result', async () => {
    await act(async () => root.render(<SessionContextSettingsPanel view={savedView(1)} onSaved={onSaved} />));
    await click('重查路径有效性');
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('/api/dsh-livestream/session-context/recheck');
    await act(async () => resolveFetch(Response.json({ ok: true, sessionContext: savedView(1), settings: {} })));
    expect(onSaved).toHaveBeenCalled();
    expect(element.textContent).toContain('重查完成');
  });
});
