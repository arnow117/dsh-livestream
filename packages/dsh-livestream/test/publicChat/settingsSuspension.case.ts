import { describe, expect, it } from 'vitest';
import { PublicChatSendController } from '../../src/publicChat/controller';
import { FrozenPublicChatOperationJournal } from '../../src/publicChat/frozenJournal';
import { FROZEN_TEST_DEPLOYMENT, makeFrozenTestGateway } from './frozenTestGateway';
import { makeTempDir, TEST_LIVE_EPOCH, waitFor } from './test-helpers';

describe('local suspension while saving settings', () => {
  it('sends no revoke during save and keeps the original control on hold until explicit revoke', async () => {
    const directory = makeTempDir('settings-suspension');
    try {
      const startedAt = Date.now() - 1000;
      const fixture = makeFrozenTestGateway(startedAt);
      const journal = new FrozenPublicChatOperationJournal(directory.directory);
      const controller = new PublicChatSendController({ deployment: FROZEN_TEST_DEPLOYMENT, gateway: fixture.gateway, journal });
      controller.advanceInputConnection();
      controller.setLiveEpoch(TEST_LIVE_EPOCH, startedAt);
      expect((await controller.refreshQualification()).ok).toBe(true);
      expect((await controller.authorize()).ok).toBe(true);
      controller.suspendFrozenLocally();
      expect(controller.currentFrozenGrant()).toBeNull();
      expect(controller.hold).toBe(true);
      expect(fixture.calls.revocations).toHaveLength(0);
      expect((await controller.submit({ requestId: 'after-save', sourceKey: null, text: '大家好' })).status).toBe('rejected');
      const restarted = new PublicChatSendController({ deployment: FROZEN_TEST_DEPLOYMENT, gateway: fixture.gateway,
        journal: new FrozenPublicChatOperationJournal(directory.directory) });
      expect(restarted.hold).toBe(true);
      controller.revokeGrant('owner-revoke');
      await waitFor(() => !controller.hold);
      expect(fixture.calls.revocations.length).toBeGreaterThan(0);
      expect((await controller.refreshQualification()).ok).toBe(true);
    } finally {
      directory.cleanup();
    }
  });
});
