/** Test-only dependency composition: original history, sender, controller and input binding.
 * The gateway and raw transport are synthetic; this does not exercise the production loader.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { TrustedHistory, TrustedSender } from '../../src/publicChat/trustedSender';
import { FrozenPublicChatOperationJournal } from '../../src/publicChat/frozenJournal';
import { PublicChatSendController } from '../../src/publicChat/controller';
import { PublicChatInputBinding } from '../../src/publicChat/inputBinding';
import { createPublicChatReplyTool } from '../../src/publicChat/agentReplyTool';
import { RawProofStore } from '../../src/publicChat/rawProof';
import { defaultClock } from '../../src/publicChat/protocol';
import type { RawObservation } from '../../src/publicChat/frozenSenderRuntime';
import { FROZEN_TEST_DEPLOYMENT, makeFrozenTestGateway, successfulOperation } from '../publicChat/frozenTestGateway';

const deployment = { ...FROZEN_TEST_DEPLOYMENT, roomId: '101' };
const gateway = makeFrozenTestGateway(Date.now());
gateway.state.raw.proof.webRoomId = deployment.roomId;
const observations = {
  gateway,
  unknownNext: false,
  proofAccepted: 0,
  proofRejected: 0,
  captureRaw: (_rawId: string, _rawType: string, _timestamp: number) => {},
};
(globalThis as any).__acceptanceSender = observations;
const loaded = {
  buildDigest: deployment.buildDigest,
  FrozenPublicChatOperationJournal,
  PublicChatSendController,
};

export async function openTrustedHistory(refs: any, isCurrent: () => boolean) {
  if (!isCurrent()) throw new Error('host closed');
  const directory = join(process.env.DSH_ACCEPTANCE_WORK!, 'same-host-sender-journal');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return new TrustedHistory(refs, loaded as any, { ...deployment, dataDir: directory } as any);
}

export async function startTrustedSender(refs: any, roomId: string, history: TrustedHistory,
  isCurrent: () => boolean, isHostOpen: () => boolean) {
  if (!isCurrent() || !isHostOpen() || roomId !== deployment.roomId) throw new Error('fixture scope mismatch');
  const client = gateway.gateway;
  let qualification: unknown = null;
  const capture = client.frozenCapture.bind(client);
  client.frozenCapture = async (...args: Parameters<typeof capture>) => {
    const result = await capture(...args);
    if (result.ok && result.value.record.state === 'qualified') {
      qualification = result.value.record.qualification;
    }
    return result;
  };
  const revoke = client.frozenRevoke.bind(client);
  client.frozenRevoke = async (...args: Parameters<typeof revoke>) => {
    const result = await revoke(...args);
    if (result.ok) qualification = null;
    return result;
  };
  history.attach(client);
  const rawProofs = new RawProofStore(defaultClock());
  const rawObserver: { current: ((observation: RawObservation) => void) | null } = { current: null };
  observations.captureRaw = (rawId, rawType, timestamp) => {
    const grant = history.controller.currentFrozenGrant();
    const receivedAt = Date.now();
    const captured = rawProofs.capture({ rawId, rawType, roomId: deployment.roomId,
      senderConnectionGeneration: gateway.state.raw.generation, grantId: grant?.grantId ?? null,
      rawCreateTime: timestamp, receivedAt });
    if (captured.trusted && grant) {
      rawObserver.current?.({ rawId, rawType, grantId: grant.grantId, roomId: grant.roomId,
        liveEpoch: grant.liveEpoch, rawSourceSessionId: grant.rawSourceSessionId,
        rawSourceConnectionGeneration: grant.rawSourceConnectionGeneration,
        platformTsMs: timestamp, receivedAt });
    }
  };
  gateway.setSend(async (request) => {
    if (request.autoEvent) {
      const proof = rawProofs.take(request.autoEvent.rawId, {
        rawType: request.autoEvent.rawType,
        senderConnectionGeneration: request.grant.rawSourceConnectionGeneration,
        roomId: request.grant.roomId,
        grantId: request.grant.grantId,
        authBoundaryMs: Math.max(request.grant.authorizedAtMs, request.grant.liveEpochStartedAtMs),
        now: Date.now(),
      });
      if (!proof.ok) {
        observations.proofRejected++;
        return { ok: false, error: `synthetic-raw-proof-${proof.reason}`, untrusted: false };
      }
      observations.proofAccepted++;
    }
    const result = successfulOperation(request);
    if (observations.unknownNext) {
      observations.unknownNext = false;
      return { ok: true, value: { ...result, state: 'unknown' } };
    }
    return { ok: true, value: result };
  });
  const runtime = {
    state: () => ({ qualification, raw: gateway.state.raw }),
    setInputAndLive: (_generation: number, epoch: string | null) => {
      gateway.state.raw.proof.liveEpoch = epoch ?? '';
    },
    cancelAuthenticationMaintenance: () => {},
  };
  const raw = { start: async () => {}, stop: async () => {} };
  const service = { close: async () => {} };
  const input = new PublicChatInputBinding(history.controller, runtime as any);
  return new TrustedSender(refs, history.identity(), runtime as any, service as any, raw,
    history.controller, history.journal, new Set(), input, createPublicChatReplyTool,
    rawObserver, { invalidated: null, needsRawRestart: false }, history, client);
}
