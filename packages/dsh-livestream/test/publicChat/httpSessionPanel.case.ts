// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PublicChatSettingsPanel, type PublicChatView } from '../../src/publicChat/PublicChatSettingsPanel';
import { DEFAULT_PUBLIC_CHAT_SETTINGS } from '../../src/publicChat/settings';

describe('session owner controls', () => {
  afterEach(() => { document.body.replaceChildren(); vi.useRealTimers(); });

  it('keeps save separate from login and confirms the captured account before authorization', async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const calls: Array<Record<string, unknown>> = [];
    const view: PublicChatView = { available: true, historyAvailable: true, starting: false, transportKind: 'session_http',
      liveConnected: true, login: { state: 'idle', revision: 0 }, hold: false, grant: null,
      identity: { accountRecordId: 'fixture', roomId: '12345', principalUid: null, platformRoomId: null, qualified: false },
      messages: [], controls: [] };
    const onAction = vi.fn(async (input: Record<string, unknown>) => {
      calls.push(input);
      if (input.action === 'login-start') view.login = { state: 'waiting', revision: 1, attemptId: 'a'.repeat(32), qrDataUrl: 'data:image/png;base64,ZmFrZQ==' };
      if (input.action === 'confirm-session') view.login = { state: 'authenticated', revision: 2, attemptId: 'a'.repeat(32), principalUid: '42' };
      if (input.action === 'maintain') view.identity!.platformRoomId = '987654321';
      if (input.action === 'authorize') view.grant = { grantId: 'grant' };
      return { ok: true };
    });
    const onSave = vi.fn(async () => {});
    const onView = async () => structuredClone(view);
    const saved = { ...DEFAULT_PUBLIC_CHAT_SETTINGS, enabled: true, reply: true };
    const button = (label: string) => {
      const found = [...container.querySelectorAll('button')].find((element) => element.textContent?.trim() === label);
      if (!found) throw new Error(`missing ${label}`);
      return found;
    };
    try {
      await act(async () => { root.render(React.createElement(PublicChatSettingsPanel, { saved, targetKey: 'douyin:12345', onSave, onView, onAction })); });
      expect(onAction).not.toHaveBeenCalled();
      await act(async () => { button('登录发送账号').click(); });
      expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,ZmFrZQ==');
      view.login = { state: 'confirmation_required', revision: 1, attemptId: 'a'.repeat(32), principalUid: '42', bindingRef: 'b'.repeat(32) };
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      await act(async () => { button('确认账号和房间').click(); });
      expect(calls[1]).toEqual({ action: 'confirm-session', bindingRef: 'b'.repeat(32) });
      expect(calls.some((call) => call.action === 'authorize')).toBe(false);
      await act(async () => { button('开启本次公屏回复').click(); });
      expect(calls.map((call) => call.action)).toEqual(['login-start', 'confirm-session', 'maintain', 'qualify', 'authorize']);
      expect(onSave).not.toHaveBeenCalled();
    } finally {
      await act(async () => { root.unmount(); });
    }
  });
});
