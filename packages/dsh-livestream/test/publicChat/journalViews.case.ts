import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PublicChatSendController, type ControllerDeps } from '../../src/publicChat/controller';
import { FrozenPublicChatOperationJournal, type FrozenJournalMessage } from '../../src/publicChat/frozenJournal';

describe('frozen history view', () => {
  it('does not expose a stored committed bit as current adoption or return mutable journal objects', () => {
    const root = process.env.DSH_HOME;
    if (!root) throw new Error('task-local DSH_HOME required');
    const dir = mkdtempSync(join(root, 'view-case-'));
    try {
      const journal = new FrozenPublicChatOperationJournal(dir);
      const message = { requestId: 'old', state: 'unknown', conflicts: [], facts: [], factsRevision: 0,
        recovery: { state: 'committed', controlId: 'reconcile', factsRevision: 0, factsDigest: 'fixture', receipt: null } } as unknown as FrozenJournalMessage;
      journal.records.push(message);
      const unavailable = async () => ({ ok: false });
      const gateway = { frozenState: unavailable, frozenCapture: unavailable, frozenAuthorize: unavailable,
        frozenRevoke: unavailable, frozenControlOperation: unavailable, frozenSend: unavailable,
        frozenOperation: unavailable, frozenReconcileMessage: unavailable, frozenRecoveryOperation: unavailable };
      const controller = new PublicChatSendController({ deployment: { buildDigest: 'a'.repeat(64), instanceId: 'instance',
        accountRecordId: 'record', expectedPrincipalUid: '42', roomId: '101' }, gateway: gateway as unknown as ControllerDeps['gateway'], journal });
      const result = controller.listFrozenOperations();
      expect(controller.hold).toBe(true);
      expect(result[0].recovery.state).toBe('recovery_unknown');
      result[0].state = 'api_reported_success';
      expect(journal.records[0].state).toBe('unknown');
      expect(controller.listOperations()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
