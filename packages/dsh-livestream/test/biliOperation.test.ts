import { afterEach, describe, expect, it, vi } from 'vitest';
import { BiliSocial } from '../src/body/biliSocial';
import { beginBiliOperation, biliOperationsActive, inBiliOperation, invalidateTarget } from '../src/shared/biliOperations';

afterEach(() => vi.unstubAllGlobals());

describe('Bilibili operation lifecycle', () => {
  it('does not issue the final publication after disconnect invalidates a deferred submit check', async () => {
    let finishCheck!: (response: Response) => void;
    const waiting = new Promise<Response>((resolve) => { finishCheck = resolve; });
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      if (url.includes('/nav')) return Response.json({ code: 0, data: { isLogin: true, mid: 1, wbi_img: { img_url: 'https://x/a.png', sub_url: 'https://x/b.png' } } });
      if (url.includes('/submit_check')) return waiting;
      throw new Error(`unexpected request: ${url}`);
    }));
    const social = new BiliSocial(async () => 'buvid3=x; bili_jct=x; SESSDATA=x');
    const lease = beginBiliOperation();
    const operation = inBiliOperation(lease, () => social.postDynamic('synthetic'));
    try {
      await vi.waitFor(() => expect(requests.some((url) => url.includes('/submit_check'))).toBe(true));
      expect(biliOperationsActive()).toBe(true);
      invalidateTarget();
      finishCheck(Response.json({ code: 0 }));
      await expect(operation).rejects.toThrow('直播目标已变化');
      expect(requests.some((url) => url.includes('/create/dyn?'))).toBe(false);
      expect(biliOperationsActive()).toBe(true);
    } finally {
      lease.release();
    }
    expect(biliOperationsActive()).toBe(false);
  });
});
