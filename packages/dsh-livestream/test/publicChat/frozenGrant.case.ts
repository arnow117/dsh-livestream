import { describe, expect, it } from 'vitest';
import { validateCommittedGrant, validateFrozenProposal, type FrozenGrantProposal } from '../../src/publicChat/frozenGrant';

const proposal: FrozenGrantProposal = {
  version: 'dsh-public-chat-v1', transportKind: 'frozen_http', buildDigest: 'a'.repeat(64), instanceId: 'instance',
  senderProcessNonce: 'sender', senderConnectionGeneration: 1, authorizationId: 'authorization', captureId: 'capture',
  qualificationDigest: 'b'.repeat(64), qualificationRevision: 1, identityEpoch: 1, accountRecordId: 'record',
  principalUid: '18446744073709551615', roomId: '00101', platformRoomId: '202', helperProcessNonce: 'helper',
  authContextId: 'context', authContextRevision: 1, materialDigest: 'c'.repeat(64), rawSourceSessionId: 'raw-session',
  rawSourceConnectionGeneration: 1, rawBrowserContextId: 'raw-context', roomBindingProofDigest: 'd'.repeat(64),
  inputConnectionGeneration: 1, liveEpoch: 'live', liveEpochStartedAtMs: 1000,
};

describe('frozen grant proposal and commit', () => {
  it('requires the complete proposal and rejects final grant fields before commit', () => {
    expect(validateFrozenProposal(proposal)).toBe(true);
    expect(validateFrozenProposal({ ...proposal, grantId: 'preissued' })).toBe(false);
    expect(validateFrozenProposal({ ...proposal, authorizedAtMs: 1000 })).toBe(false);
    expect(validateFrozenProposal({ ...proposal, platformRoomId: '18446744073709551616' })).toBe(false);
  });

  it('requires the exact committed tuple, independent ID and actual time bounds', () => {
    const grant = { ...proposal, grantId: 'grant', authorizedAtMs: 1200 };
    expect(validateCommittedGrant(grant, proposal, 'qualification-token', 1100, 1300)).toBe(true);
    expect(validateCommittedGrant({ ...grant, grantId: 'qualification-token' }, proposal, 'qualification-token', 1100, 1300)).toBe(false);
    expect(validateCommittedGrant({ ...grant, authorizedAtMs: 1099 }, proposal, 'qualification-token', 1100, 1300)).toBe(false);
    expect(validateCommittedGrant({ ...grant, authContextRevision: 2 }, proposal, 'qualification-token', 1100, 1300)).toBe(false);
  });
});
