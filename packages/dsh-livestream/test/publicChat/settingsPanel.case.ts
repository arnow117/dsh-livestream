// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PublicChatSettingsPanel, type PublicChatView } from '../../src/publicChat/PublicChatSettingsPanel';
import { DEFAULT_PUBLIC_CHAT_SETTINGS } from '../../src/publicChat/settings';

describe('public chat settings panel', () => {
  afterEach(() => { document.body.replaceChildren(); });

  it('keeps the draft on a failed save and prevents repeated submits while pending', async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let reject!: (error: Error) => void;
    let calls = 0;
    const pending = new Promise<void>((_, rejectPromise) => { reject = rejectPromise; });
    try {
      await act(async () => {
        root.render(React.createElement(PublicChatSettingsPanel, {
          saved: DEFAULT_PUBLIC_CHAT_SETTINGS,
          targetKey: 'douyin:101',
          onSave: async () => { calls++; await pending; },
          onView: async () => ({ available: false, starting: false, hold: false, grant: null, identity: null, messages: [], controls: [] }),
          onAction: async () => ({}),
        }));
      });
      const checkbox = container.querySelector('input[type=checkbox]') as HTMLInputElement;
      await act(async () => { checkbox.click(); });
      const save = container.querySelector('button') as HTMLButtonElement;
      expect(save.disabled).toBe(false);
      await act(async () => { save.click(); });
      expect(save.disabled).toBe(true);
      await act(async () => { save.click(); });
      expect(calls).toBe(1);
      await act(async () => { reject(new Error('fixture')); await pending.catch(() => {}); });
      expect(checkbox.checked).toBe(true);
      expect(container.textContent).toContain('保存失败，草稿仍保留');
      expect(save.disabled).toBe(false);
    } finally {
      await act(async () => { root.unmount(); });
    }
  });

  it('does not display an old target response after a target change', async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let finishOld!: (value: PublicChatView) => void;
    const oldResponse = new Promise<PublicChatView>((resolve) => { finishOld = resolve; });
    const makeView = (accountRecordId: string) => ({ available: true, starting: false, hold: false, grant: null,
      identity: { accountRecordId, roomId: '101', principalUid: null, platformRoomId: null, qualified: false },
      messages: [], controls: [] });
    const onView = vi.fn().mockReturnValueOnce(oldResponse).mockResolvedValue(makeView('new-target'));
    const props = { saved: DEFAULT_PUBLIC_CHAT_SETTINGS, onView, onSave: async () => {}, onAction: async () => ({}) };
    try {
      await act(async () => { root.render(React.createElement(PublicChatSettingsPanel, { ...props, targetKey: 'douyin:101' })); });
      await act(async () => { root.render(React.createElement(PublicChatSettingsPanel, { ...props, targetKey: 'douyin:202' })); });
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(container.textContent).toContain('new-target');
      await act(async () => { finishOld(makeView('old-target')); await oldResponse; });
      expect(container.textContent).toContain('new-target');
      expect(container.textContent).not.toContain('old-target');
    } finally {
      await act(async () => { root.unmount(); });
      vi.useRealTimers();
    }
  });
});
