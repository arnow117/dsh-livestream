import { createHmac } from "node:crypto";
import type { PatchCommand } from "./artifactContract";
import type { PhotoMutationFacts } from "./patchPayload";

export interface ExecutionBinding {
  ownerRef: string;
  workspaceRef: string;
  appId: string;
  profileRef: string;
  generation: number;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}

function digest(key: Uint8Array, label: string, value: unknown): string {
  return createHmac("sha256", key)
    .update(label)
    .update("\0")
    .update(canonical(value))
    .digest("hex");
}

export function operationDigests(
  key: Uint8Array,
  command: PatchCommand,
  binding: ExecutionBinding,
  photoFacts?: PhotoMutationFacts,
) {
  if (
    key.byteLength < 32 ||
    !binding ||
    [
      binding.ownerRef,
      binding.workspaceRef,
      binding.appId,
      binding.profileRef,
    ].some((value) => typeof value !== "string" || !value.trim()) ||
    !Number.isSafeInteger(binding.generation) ||
    binding.generation <= 0
  )
    throw new Error("write_coordination_unavailable");
  return {
    recordKey: digest(key, "record", command.record),
    bindingDigest: digest(key, "mapping", {
      record: command.record,
      mapping: command.mapping,
      binding,
    }),
    patchDigest: digest(
      key,
      "patch",
      photoFacts === undefined
        ? command.changes
        : { changes: command.changes, photoFacts },
    ),
  };
}
