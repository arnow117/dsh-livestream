// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const stage = vi.hoisted(() => {
  const gift = { kind: 'gift', id: '1', platform: 'douyin', user: { id: '2', name: '观众' }, gift: '花', count: 3, yuan: 0, valueKnown: false };
  return {
    character: null,
    template: { effects: { gift: ['banner'] } },
    alerts: [{ key: 'a', event: gift, at: 0 }],
    reply: [{ key: 'r', event: gift }], replySeq: 1,
    fx: [{ key: 'f', event: gift, triggers: ['gift'], at: 0 }],
  };
});
vi.mock('../src/stage/store', () => ({
  getState: () => stage,
  subscribe: () => () => {},
  dropAlert() {}, dropFx() {},
  assetUrl: () => '', energy: () => '', riceOf: () => '', litChars: () => 0,
  mediaUrl: () => '', preview: true, reportMedia() {},
}));
import { Alerts, Reply } from '../src/stage/widgets';
import { Effects } from '../src/stage/effects';

describe('unknown gift value on stage', () => {
  it('shows an unknown amount in the alert, reply and configured banner', async () => {
    const element = document.createElement('div');
    document.body.append(element);
    const root = createRoot(element);
    try {
      await act(async () => { root.render(<><Alerts /><Reply /><Effects /></>); });
      expect(element.textContent?.match(/金额未知/g)?.length).toBe(3);
      expect(element.textContent).not.toContain('¥0');
    } finally {
      await act(async () => root.unmount());
      element.remove();
    }
  });
});
