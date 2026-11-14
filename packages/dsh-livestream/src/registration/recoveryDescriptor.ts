import { createHmac, randomBytes } from "node:crypto";
import type { PatchCommand, RegistrationConfig } from "./artifactContract";
import type { ExecutionBinding } from "./operationDigests";
import type { Binding } from "./workspaceExecutor";
import { parseStrictJson } from "./strictJson";
import { buildConfigSnapshot } from "./configSnapshot";
import { REGISTRATION_NATIVE_SHA256 } from "./nativeCli/nativeIdentity";

export type RecoveryFieldKind = "text" | "number" | "attachment";
export interface RecoveryDescriptor {
  version: "registration-recovery/1";
  operationRef: string;
  nonce: string;
  record: PatchCommand["record"];
  mapping: PatchCommand["mapping"];
  authority: ExecutionBinding;
  principalHmac: string;
  configHmac: string;
  nativeSha256: string;
  recordKey: string;
  bindingDigest: string;
  patchDigest: string;
  readRef: string;
  expectedRevision: number;
  fields: Array<{ id: string; kind: RecoveryFieldKind }>;
  revisionField: string;
  operationField: string;
  effectHmac: string;
}

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
    .join(",")}}`;
}
function mac(key: Uint8Array, label: string, value: unknown): string {
  if (key.byteLength < 32) throw new Error("journal_unavailable");
  return createHmac("sha256", key)
    .update(label)
    .update("\0")
    .update(stable(value))
    .digest("hex");
}
export function recoveryPrincipalHmac(
  key: Uint8Array,
  binding: Binding,
): string {
  return mac(key, "registration-principal/1", {
    appId: binding.appId,
    userOpenId: binding.userOpenId,
  });
}
export function recoveryConfigHmac(
  key: Uint8Array,
  bytes: Uint8Array,
  binding: Binding,
): string {
  const snapshot = buildConfigSnapshot(bytes, {
    profile: binding.profile,
    expectedAppId: binding.appId,
    expectedUserOpenId: binding.userOpenId,
  });
  return createHmac("sha256", key)
    .update("registration-config/1\0")
    .update(snapshot)
    .digest("hex");
}
function normalize(value: unknown, kind: RecoveryFieldKind): unknown {
  if (kind === "text") {
    if (value === null || typeof value === "string") return value;
    throw new Error("unsupported_field_shape");
  }
  if (kind === "number") {
    if (
      value === null ||
      (typeof value === "number" && Number.isSafeInteger(value) && value > 0)
    )
      return value;
    throw new Error("unsupported_field_shape");
  }
  if (value === null || (Array.isArray(value) && value.length === 0))
    return null;
  if (
    !Array.isArray(value) ||
    value.length !== 1 ||
    !value[0] ||
    typeof value[0] !== "object" ||
    Array.isArray(value[0])
  )
    throw new Error("unsupported_field_shape");
  const token = (value[0] as Record<string, unknown>).file_token;
  if (typeof token !== "string" || !ID.test(token))
    throw new Error("unsupported_field_shape");
  return [{ file_token: token }];
}
function effectPayload(
  descriptor: Omit<RecoveryDescriptor, "effectHmac"> | RecoveryDescriptor,
  fields: Record<string, unknown>,
) {
  return {
    version: descriptor.version,
    operationRef: descriptor.operationRef,
    nonce: descriptor.nonce,
    record: descriptor.record,
    mapping: descriptor.mapping,
    authority: descriptor.authority,
    principalHmac: descriptor.principalHmac,
    configHmac: descriptor.configHmac,
    nativeSha256: descriptor.nativeSha256,
    recordKey: descriptor.recordKey,
    bindingDigest: descriptor.bindingDigest,
    patchDigest: descriptor.patchDigest,
    readRef: descriptor.readRef,
    expectedRevision: descriptor.expectedRevision,
    changedFields: descriptor.fields,
    revisionField: descriptor.revisionField,
    operationField: descriptor.operationField,
    fields,
  };
}
export function createRecoveryDescriptor(options: {
  key: Uint8Array;
  command: PatchCommand;
  config: RegistrationConfig;
  binding: Binding;
  configBytes: Uint8Array;
  authority: ExecutionBinding;
  digests: { recordKey: string; bindingDigest: string; patchDigest: string };
  body: Uint8Array;
}): RecoveryDescriptor {
  const { command, config, binding, key } = options;
  const parsed = parseStrictJson(options.body);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 1 ||
    !(parsed as Record<string, unknown>).fields ||
    typeof (parsed as Record<string, unknown>).fields !== "object" ||
    Array.isArray((parsed as Record<string, unknown>).fields)
  )
    throw new Error("invalid_shape");
  const input = (parsed as { fields: Record<string, unknown> }).fields;
  const revisionField = config.metadataFields.profile_revision;
  const operationField = config.metadataFields.profile_operation_ref;
  if (
    !revisionField ||
    !operationField ||
    input[revisionField] !== command.expectedProfileRevision + 1 ||
    input[operationField] !== command.operationRef
  )
    throw new Error("metadata_missing");
  const types = new Map<string, RecoveryFieldKind>([
    [config.fields.display_name, "text"],
    [config.fields.contact_text, "text"],
    [config.fields.product_interest, "text"],
    [config.fields.photo, "attachment"],
    [revisionField, "number"],
    [operationField, "text"],
  ]);
  if (config.metadataFields.photo_revision)
    types.set(config.metadataFields.photo_revision, "number");
  if (config.metadataFields.photo_sha256)
    types.set(config.metadataFields.photo_sha256, "text");
  const fields = Object.keys(input)
    .sort()
    .map((id) => {
      const kind = types.get(id);
      if (!kind || !ID.test(id)) throw new Error("scope_mismatch");
      return { id, kind };
    });
  if (fields.length === 0 || fields.length > 8)
    throw new Error("invalid_shape");
  const values: Record<string, unknown> = Object.create(null);
  for (const field of fields)
    values[field.id] = normalize(input[field.id], field.kind);
  const descriptor: Omit<RecoveryDescriptor, "effectHmac"> = {
    version: "registration-recovery/1",
    operationRef: command.operationRef,
    nonce: randomBytes(32).toString("hex"),
    record: { ...command.record },
    mapping: { ...command.mapping },
    authority: { ...options.authority },
    principalHmac: recoveryPrincipalHmac(key, binding),
    configHmac: recoveryConfigHmac(key, options.configBytes, binding),
    nativeSha256: REGISTRATION_NATIVE_SHA256,
    ...options.digests,
    readRef: command.originalReadEvidenceRef,
    expectedRevision: command.expectedProfileRevision,
    fields,
    revisionField,
    operationField,
  };
  return {
    ...descriptor,
    effectHmac: mac(
      key,
      "registration-effect/1",
      effectPayload(descriptor, values),
    ),
  };
}
/** Strictly compare only the original physical fields, operation marker and exact next revision. */
export function matchesRecoveryEffect(
  key: Uint8Array,
  descriptor: RecoveryDescriptor,
  cells: ReadonlyMap<string, unknown>,
): boolean {
  try {
    if (
      cells.get(descriptor.revisionField) !== descriptor.expectedRevision + 1 ||
      cells.get(descriptor.operationField) !== descriptor.operationRef
    )
      return false;
    const values: Record<string, unknown> = Object.create(null);
    for (const field of descriptor.fields) {
      if (!cells.has(field.id)) return false;
      values[field.id] = normalize(cells.get(field.id), field.kind);
    }
    return (
      HASH.test(descriptor.effectHmac) &&
      mac(key, "registration-effect/1", effectPayload(descriptor, values)) ===
        descriptor.effectHmac
    );
  } catch {
    return false;
  }
}

function exactObject(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function ref(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
      value,
    )
  );
}
/** Reject unknown keys, malformed historical metadata and any noncanonical field list. */
export function parseRecoveryDescriptor(value: unknown): RecoveryDescriptor {
  const keys = [
    "version",
    "operationRef",
    "nonce",
    "record",
    "mapping",
    "authority",
    "principalHmac",
    "configHmac",
    "nativeSha256",
    "recordKey",
    "bindingDigest",
    "patchDigest",
    "readRef",
    "expectedRevision",
    "fields",
    "revisionField",
    "operationField",
    "effectHmac",
  ];
  if (
    !exactObject(value, keys) ||
    value.version !== "registration-recovery/1" ||
    !ref(value.operationRef) ||
    !ref(value.readRef) ||
    ![
      value.nonce,
      value.principalHmac,
      value.configHmac,
      value.nativeSha256,
      value.recordKey,
      value.bindingDigest,
      value.patchDigest,
      value.effectHmac,
    ].every((item) => typeof item === "string" && HASH.test(item)) ||
    typeof value.expectedRevision !== "number" ||
    !Number.isSafeInteger(value.expectedRevision) ||
    value.expectedRevision <= 0 ||
    value.expectedRevision === Number.MAX_SAFE_INTEGER
  )
    throw new Error("journal_unavailable");
  if (
    !exactObject(value.record, ["baseId", "tableId", "recordId"]) ||
    !Object.values(value.record).every(
      (x) => typeof x === "string" && ID.test(x),
    ) ||
    !exactObject(value.mapping, ["mappingId", "revision"]) ||
    !ref(value.mapping.mappingId) ||
    typeof value.mapping.revision !== "number" ||
    !Number.isSafeInteger(value.mapping.revision) ||
    value.mapping.revision <= 0 ||
    !exactObject(value.authority, [
      "ownerRef",
      "workspaceRef",
      "appId",
      "profileRef",
      "generation",
    ]) ||
    ![
      value.authority.ownerRef,
      value.authority.workspaceRef,
      value.authority.appId,
      value.authority.profileRef,
    ].every(ref) ||
    typeof value.authority.generation !== "number" ||
    !Number.isSafeInteger(value.authority.generation) ||
    value.authority.generation <= 0
  )
    throw new Error("journal_unavailable");
  if (
    !Array.isArray(value.fields) ||
    value.fields.length === 0 ||
    value.fields.length > 8 ||
    typeof value.revisionField !== "string" ||
    typeof value.operationField !== "string"
  )
    throw new Error("journal_unavailable");
  let previous = "";
  for (const item of value.fields) {
    if (
      !exactObject(item, ["id", "kind"]) ||
      typeof item.id !== "string" ||
      !ID.test(item.id) ||
      item.id <= previous ||
      !["text", "number", "attachment"].includes(String(item.kind))
    )
      throw new Error("journal_unavailable");
    previous = item.id;
  }
  const fields = value.fields as Array<{ id: string; kind: RecoveryFieldKind }>;
  if (
    !fields.some(
      (field) => field.id === value.revisionField && field.kind === "number",
    ) ||
    !fields.some(
      (field) => field.id === value.operationField && field.kind === "text",
    ) ||
    value.revisionField === value.operationField
  )
    throw new Error("journal_unavailable");
  return value as unknown as RecoveryDescriptor;
}
export function descriptorHmac(
  key: Uint8Array,
  descriptor: RecoveryDescriptor,
): string {
  return mac(
    key,
    "registration-descriptor/1",
    parseRecoveryDescriptor(descriptor),
  );
}
