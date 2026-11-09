import { afterEach, describe, expect, it, vi } from 'vitest';
import { DmManager } from '../src/body/dm';
import { fetchProfile } from '../src/body/biliProfile';
import { SocialManager } from '../src/body/social';
import { beginBiliOperation, inBiliOperation, invalidateTarget } from '../src/shared/biliOperations';

afterEach(() => vi.unstubAllGlobals());

describe('stale Bili operations', () => {
  it('does not continue a DM operation after a deferred account lookup', async () => {
    let finish!: (value: number) => void;
    const account = {
      me: () => new Promise<number>((resolve) => { finish = resolve; }),
      followsMe: vi.fn(), replied: vi.fn(), send: vi.fn(),
    };
    const dm = new DmManager(account, null);
    const lease = beginBiliOperation();
    try {
      const pending = inBiliOperation(lease, () => dm.send({ uid: '123', name: '测试' }, '内容'));
      invalidateTarget();
      finish(1);
      await expect(pending).rejects.toThrow('直播目标已变化');
      expect(account.followsMe).not.toHaveBeenCalled();
      expect(account.send).not.toHaveBeenCalled();
    } finally { lease.release(); }
  });
  it('does not issue further profile requests after the first response arrives late', async () => {
    let finish!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal('fetch', fetch);
    const lease = beginBiliOperation();
    try {
      const pending = inBiliOperation(lease, () => fetchProfile('123', 'fake'));
      invalidateTarget();
      finish(Response.json({ code: 0, data: { card: { name: '测试' }, archive_count: 1 } }));
      await pending;
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { lease.release(); }
  });
  it('does not store a stale inbox snapshot', async () => {
    let finish!: (sessions: any[]) => void;
    const api = {
      dmSessions: () => new Promise<any[]>((resolve) => { finish = resolve; }),
      mentions: async () => [], names: vi.fn(),
    };
    const social = new SocialManager(api as any);
    const lease = beginBiliOperation();
    try {
      const pending = inBiliOperation(lease, () => social.newSince());
      invalidateTarget();
      finish([]);
      await expect(pending).rejects.toThrow('直播目标已变化');
      expect(api.names).not.toHaveBeenCalled();
      expect((social as any).seen).toBeNull();
    } finally { lease.release(); }
  });
});
