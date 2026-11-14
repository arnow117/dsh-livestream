import { createHash } from "node:crypto";
import type { PatchCommand } from "./artifactContract";
import type { OperationStore } from "./operationStore";
import type { PhotoMutationFacts } from "./patchPayload";
import { type RecoveryDescriptor } from "./recoveryDescriptor";
import { parseStrictJson } from "./strictJson";
import type { Binding, WorkspaceExecutionContext } from "./workspaceExecutor";

interface IntentDigests {
  recordKey: string;
  bindingDigest: string;
  patchDigest: string;
}
interface PermitState {
  store: OperationStore;
  operationRef: string;
  digests: IntentDigests;
  commandHash: string;
  appId: string;
  profileRef: string;
  used: boolean;
  descriptor: RecoveryDescriptor;
  bodyHash: string;
}
const permits = new WeakMap<object, PermitState>();
function commandHash(
  command: PatchCommand,
  photoFacts?: PhotoMutationFacts,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ command, photoFacts: photoFacts ?? null }))
    .digest("hex");
}
function matches(state: PermitState): boolean {
  const row = state.store.inspect(state.operationRef);
  return (
    row?.state === "dispatched" &&
    row.recordKey === state.digests.recordKey &&
    row.bindingDigest === state.digests.bindingDigest &&
    row.patchDigest === state.digests.patchDigest &&
    row.descriptor.nonce === state.descriptor.nonce &&
    row.descriptor.effectHmac === state.descriptor.effectHmac
  );
}
/** Internal coordinator primitive: an already-durable dispatched intent is required. */
export function issueDispatchPermit(
  store: OperationStore,
  command: PatchCommand,
  digests: IntentDigests,
  identity: { appId: string; profileRef: string },
  photoFacts: PhotoMutationFacts | undefined,
  descriptor: RecoveryDescriptor,
  body: Uint8Array,
): object {
  const parsed = parseStrictJson(body) as { fields?: Record<string, unknown> };
  if (
    !parsed?.fields ||
    !store.matchesEffect(descriptor, new Map(Object.entries(parsed.fields)))
  )
    throw new Error("write_coordination_unavailable");
  const state: PermitState = {
    store,
    operationRef: command.operationRef,
    digests: Object.freeze({ ...digests }),
    commandHash: commandHash(command, photoFacts),
    appId: identity.appId,
    profileRef: identity.profileRef,
    used: false,
    descriptor: structuredClone(descriptor),
    bodyHash: createHash("sha256").update(body).digest("hex"),
  };
  if (!matches(state) || !store.consumeDispatchRight(command.operationRef))
    throw new Error("write_coordination_unavailable");
  const permit = Object.freeze({});
  permits.set(permit, state);
  return permit;
}

/** Consume once before the executor starts; a JSON object cannot forge this permit. */
export function consumeDispatchPermit(
  permit: object | undefined,
  command: PatchCommand,
  identity: { appId: string; profileRef: string },
  photoFacts: PhotoMutationFacts | undefined,
  body: Uint8Array,
): boolean {
  if (!permit) return false;
  const state = permits.get(permit);
  if (
    !state ||
    state.used ||
    state.operationRef !== command.operationRef ||
    state.appId !== identity.appId ||
    state.profileRef !== identity.profileRef ||
    state.commandHash !== commandHash(command, photoFacts) ||
    state.bodyHash !== createHash("sha256").update(body).digest("hex")
  )
    return false;
  state.used = true;
  try {
    return matches(state);
  } catch {
    return false;
  }
}

/** Persist the original joined execution before a receipt can leave the executor. */
export async function persistDispatchEnd(
  permit: object | undefined,
  receipt: object,
  binding: Binding,
  command: PatchCommand,
  context: WorkspaceExecutionContext,
): Promise<void> {
  const state = permit && permits.get(permit);
  if (!state) throw new Error("write_coordination_unavailable");
  try {
    if (
      !state.used ||
      !matches(state) ||
      state.operationRef !== command.operationRef
    )
      throw new Error("write_coordination_unavailable");
    await state.store.recordNativeEnd(
      command.operationRef,
      receipt,
      binding,
      command,
      context,
    );
  } catch (error) {
    state.store.failNativeEndPersistence();
    throw error;
  }
}

/** Identity attached to the original consumed permit; never recreated for recovery. */
export function consumedPermitIdentity(
  permit: object | undefined,
): { journalId: string; nonce: string; descriptorHmac: string } | null {
  const state = permit && permits.get(permit);
  if (!state || !state.used || !matches(state)) return null;
  return state.store.permitIdentity(state.operationRef, state.descriptor.nonce);
}
