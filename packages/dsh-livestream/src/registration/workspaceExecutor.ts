import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  fstatSync,
  readFileSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  chmodSync,
  openSync,
  writeFileSync,
  closeSync,
  rmSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { buildConfigSnapshot } from "./configSnapshot";
import {
  consumeDispatchPermit,
  persistDispatchEnd,
  consumedPermitIdentity,
} from "./dispatchPermit";
import { runBoundedProcess } from "./boundedProcess";
import { buildTextPatch, type PhotoMutationFacts } from "./patchPayload";
import { verifiedNativeExecutable } from "./nativeArtifact";
import {
  nativeAttachmentMetadata,
  nativePutMatchesRecord,
  nativeSuccessData,
  nativeTemporaryUrl,
} from "./nativeEnvelope";
import { exactMetadata } from "./attachmentAdapter";
import type { SharedCore } from "./artifactContract";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const joinedWrites = new WeakMap<
  object,
  {
    key: string;
    invocationRef: string;
    journalId: string;
    nonce: string;
    descriptorHmac: string;
  }
>();
function joinedWriteKey(
  binding: Binding,
  operationRef: string,
  recordId: string,
  body: Uint8Array,
  configBytes: Uint8Array,
): string {
  return JSON.stringify({
    profile: binding.profile,
    appRef: binding.appRef,
    profileRef: binding.profileRef,
    appId: binding.appId,
    userOpenId: binding.userOpenId,
    baseId: binding.baseId,
    tableId: binding.tableId,
    fieldIds: binding.fieldIds,
    operationRef,
    recordId,
    payload: createHash("sha256").update(body).digest("hex"),
    config: createHash("sha256").update(configBytes).digest("hex"),
  });
}
/** Only a joined successful native invocation can create this process-local proof. */
export function verifyJoinedWrite(
  receipt: object,
  binding: Binding,
  rawCommand: unknown,
  context: WorkspaceExecutionContext,
): boolean {
  try {
    context.assertCurrent();
    validateBinding(binding, context);
    const command = context.core.validatePatch(rawCommand);
    const patch = buildTextPatch(
      context.profileConfig,
      command,
      context.core,
      context.photoFacts,
    );
    return (
      joinedWrites.get(receipt)?.key ===
      joinedWriteKey(
        binding,
        command.operationRef,
        patch.recordId,
        patch.body,
        context.configBytes,
      )
    );
  } catch {
    return false;
  }
}

/** Returns the original invocation identity only for an authentic joined receipt. */
export function joinedWriteInvocation(
  receipt: object,
  binding: Binding,
  command: unknown,
  context: WorkspaceExecutionContext,
  expected: { journalId: string; nonce: string; descriptorHmac: string },
): string | null {
  const proof = joinedWrites.get(receipt);
  return verifyJoinedWrite(receipt, binding, command, context) &&
    proof?.journalId === expected.journalId &&
    proof.nonce === expected.nonce &&
    proof.descriptorHmac === expected.descriptorHmac
    ? proof.invocationRef
    : null;
}

export interface Binding {
  profile: string;
  appRef: string;
  profileRef: string;
  appId: string;
  userOpenId: string;
  baseId: string;
  tableId: string;
  fieldIds: readonly string[];
}
export interface WorkspaceExecutionContext {
  core: SharedCore;
  configBytes: Uint8Array;
  profileConfig: unknown;
  tempRoot: string;
  signal: AbortSignal;
  assertCurrent: () => void;
  /** Must attest the same deployed writer coverage and actual native fault-wire proof. */
  managedWriteReady?: () => boolean;
  /** Issued only after the coordinator persists this exact dispatched intent. */
  dispatchPermit?: object;
  /** Supplied only by a trusted host evidence resolver, never by request JSON. */
  photoFacts?: PhotoMutationFacts;
  onSpawn?: (pid: number) => void;
}
export function recordGetArgv(binding: Binding, recordId: string): string[] {
  if (
    !binding.profile.trim() ||
    !ID.test(binding.baseId) ||
    !ID.test(binding.tableId) ||
    !ID.test(recordId) ||
    binding.fieldIds.length === 0 ||
    new Set(binding.fieldIds).size !== binding.fieldIds.length ||
    binding.fieldIds.some((id) => !ID.test(id))
  )
    throw new Error("configuration_unavailable");
  return [
    "base",
    "+record-get",
    "--base-token",
    binding.baseId,
    "--table-id",
    binding.tableId,
    "--record-id",
    recordId,
    ...binding.fieldIds.flatMap((id) => ["--field-id", id]),
    "--format",
    "json",
    "--profile",
    binding.profile,
    "--as",
    "user",
  ];
}
function validateBinding(
  binding: Binding,
  context: WorkspaceExecutionContext,
): void {
  const config = context.core.parseRegistrationConfig(context.profileConfig);
  const fields = [
    ...Object.values(config.fields),
    ...Object.values(config.metadataFields).filter(
      (value): value is string => value !== null,
    ),
  ];
  if (
    binding.appRef !== config.appRef ||
    binding.profileRef !== config.profileRef ||
    binding.baseId !== config.baseId ||
    binding.tableId !== config.visitorsTableId ||
    binding.fieldIds.length !== fields.length ||
    fields.some((id) => !binding.fieldIds.includes(id))
  )
    throw new Error("scope_mismatch");
}
function checkRoot(root: string): void {
  if (
    !path.isAbsolute(root) ||
    path.resolve(root) !== root ||
    realpathSync(root) !== root ||
    typeof process.getuid !== "function"
  )
    throw new Error("executor_unavailable");
  let current = root;
  for (;;) {
    const info = lstatSync(current);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.uid !== 0 && info.uid !== process.getuid()) ||
      (info.mode & 0o022) !== 0 ||
      (current === root &&
        (info.uid !== process.getuid() || (info.mode & 0o077) !== 0))
    )
      throw new Error("executor_unavailable");
    const next = path.dirname(current);
    if (next === current) break;
    current = next;
  }
}
function privateWrite(filename: string, bytes: Uint8Array): void {
  const fd = openSync(filename, "wx", 0o600);
  try {
    writeFileSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
  chmodSync(filename, 0o400);
}
async function runNativeInternal(
  binding: Binding,
  action:
    | "record_get"
    | "record_patch"
    | "attachment_metadata"
    | "attachment_url",
  recordId: string,
  context: WorkspaceExecutionContext,
  body?: Uint8Array,
  mode: "read" | "write" = "read",
  attachment?: { fileToken: string; extra: string },
): Promise<
  | { outcome: "read"; stdout: Buffer; actionJoined: true }
  | { outcome: "unavailable" | "unknown" | "revoked"; actionJoined?: true }
> {
  context.assertCurrent();
  if (mode === "write" && !context.managedWriteReady?.())
    return { outcome: "unavailable" };
  const snapshot = buildConfigSnapshot(context.configBytes, {
    profile: binding.profile,
    expectedAppId: binding.appId,
    expectedUserOpenId: binding.userOpenId,
  });
  const executable = verifiedNativeExecutable();
  context.assertCurrent();
  checkRoot(context.tempRoot);
  const directory = mkdtempSync(
    path.join(context.tempRoot, "registration-native-"),
  );
  let safeToRemove = true;
  try {
    const configDir = path.join(directory, "config");
    const configPath = path.join(configDir, "config.json");
    const tmp = path.join(directory, "tmp");
    mkdirSync(configDir, { mode: 0o700 });
    mkdirSync(tmp, { mode: 0o700 });
    privateWrite(configPath, snapshot);
    const config = context.core.parseRegistrationConfig(context.profileConfig);
    const writableFields = [
      config.fields.display_name,
      config.fields.contact_text,
      config.fields.product_interest,
      config.fields.photo,
      config.metadataFields.profile_revision,
      config.metadataFields.profile_operation_ref,
      config.metadataFields.photo_revision,
      config.metadataFields.photo_sha256,
    ].filter((field): field is string => field !== null);
    const snapshotObject = JSON.parse(
      Buffer.from(snapshot).toString("utf8"),
    ) as {
      apps: Array<{ brand: string }>;
    };
    const nativeBinding = {
      profile: binding.profile,
      brand: snapshotObject.apps[0].brand,
      base: binding.baseId,
      table: binding.tableId,
      record: recordId,
      fields: binding.fieldIds,
      writableFields,
      numericFields: [
        config.metadataFields.profile_revision,
        config.metadataFields.photo_revision,
      ].filter((field): field is string => field !== null),
      photoField: config.fields.photo,
    };
    const bindingPath = path.join(directory, "registration-binding.json");
    const snapshotIdentity = lstatSync(configPath);
    const snapshotUnchanged = () => {
      const fd = openSync(
        configPath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const after = fstatSync(fd);
        return (
          after.isFile() &&
          after.nlink === 1 &&
          after.dev === snapshotIdentity.dev &&
          after.ino === snapshotIdentity.ino &&
          (after.mode & 0o7777) === 0o400 &&
          after.uid === process.getuid?.() &&
          after.size === snapshot.byteLength &&
          createHash("sha256").update(readFileSync(fd)).digest("hex") ===
            createHash("sha256").update(snapshot).digest("hex")
        );
      } finally {
        closeSync(fd);
      }
    };
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin",
      LANG: "C",
      TMPDIR: tmp,
      LARKSUITE_CLI_CONFIG_DIR: configDir,
    };
    if (process.env.HOME !== undefined) env.HOME = process.env.HOME;
    if (process.env.USER !== undefined) env.USER = process.env.USER;
    const invoke = async (
      invocation: "user_info" | typeof action,
      payload?: Uint8Array,
    ) => {
      context.assertCurrent();
      if (!snapshotUnchanged()) throw new Error("executor_unavailable");
      privateWrite(
        bindingPath,
        Buffer.from(
          JSON.stringify({
            ...nativeBinding,
            action: invocation,
            ...(invocation === "attachment_url" && attachment
              ? {
                  attachmentToken: attachment.fileToken,
                  attachmentExtra: attachment.extra,
                }
              : {}),
          }),
        ),
      );
      const request = payload
        ? {
            action: invocation,
            patch: JSON.parse(Buffer.from(payload).toString("utf8")),
          }
        : { action: invocation };
      safeToRemove = false;
      const result = await runBoundedProcess({
        executable,
        argv: [],
        stdin: Buffer.from(JSON.stringify(request)),
        cwd: directory,
        env,
        signal: context.signal,
        timeoutMs: 30_000,
        onSpawn: context.onSpawn,
      });
      safeToRemove = result.joined;
      if (result.joined) rmSync(bindingPath);
      return result;
    };
    const identity = await invoke("user_info");
    if (!identity.joined || identity.stopped) return { outcome: "unknown" };
    context.assertCurrent();
    if (!snapshotUnchanged()) return { outcome: "unknown" };
    if (identity.exitCode !== 0) return { outcome: "unavailable" };
    const identityData = nativeSuccessData(identity.stdout);
    if (
      !identityData ||
      typeof identityData !== "object" ||
      Array.isArray(identityData) ||
      (identityData as Record<string, unknown>).open_id !== binding.userOpenId
    )
      return { outcome: "unavailable" };
    context.assertCurrent();
    if (mode === "write" && !context.managedWriteReady?.())
      return { outcome: "unavailable" };
    const result = await invoke(action, body);
    if (!result.joined || result.authIndeterminate || !snapshotUnchanged())
      return { outcome: "unknown" };
    if (result.stopped) return { outcome: "unknown", actionJoined: true };
    try {
      context.assertCurrent();
    } catch {
      return { outcome: "revoked", actionJoined: true };
    }
    if (result.exitCode !== 0)
      return { outcome: "unavailable", actionJoined: true };
    return { outcome: "read", stdout: result.stdout, actionJoined: true };
  } finally {
    if (safeToRemove) rmSync(directory, { recursive: true, force: false });
  }
}

/** Errors never expose native output, filesystem paths, or configuration. */
export async function readBoundRecord(
  binding: Binding,
  recordId: string,
  context: WorkspaceExecutionContext,
): Promise<
  | { outcome: "read"; stdout: Buffer }
  | { outcome: "unavailable" | "unknown" | "revoked" }
> {
  try {
    validateBinding(binding, context);
    recordGetArgv(binding, recordId);
    return await runNativeInternal(binding, "record_get", recordId, context);
  } catch (error) {
    return {
      outcome:
        error instanceof Error && error.message === "revoked"
          ? "revoked"
          : "unknown",
    };
  }
}

/** A dispatched nonzero or uncertain native result is unknown until trusted original evidence resolves it. */
export async function patchBoundRecord(
  binding: Binding,
  rawCommand: unknown,
  context: WorkspaceExecutionContext,
): Promise<
  | { outcome: "returned"; receipt: object }
  | { outcome: "unavailable" | "unknown" | "revoked"; receipt?: object }
> {
  try {
    if (!context.managedWriteReady?.()) return { outcome: "unavailable" };
    validateBinding(binding, context);
    const command = context.core.validatePatch(rawCommand);
    const patch = buildTextPatch(
      context.profileConfig,
      command,
      context.core,
      context.photoFacts,
    );
    if (
      !consumeDispatchPermit(
        context.dispatchPermit,
        command,
        binding,
        context.photoFacts,
        patch.body,
      )
    )
      return { outcome: "unavailable" };
    recordGetArgv(binding, patch.recordId);
    const permitIdentity = consumedPermitIdentity(context.dispatchPermit);
    if (!permitIdentity) return { outcome: "unknown" };
    const invocationRef = randomUUID();
    const result = await runNativeInternal(
      binding,
      "record_patch",
      patch.recordId,
      context,
      patch.body,
      "write",
    );
    let receipt: object | undefined;
    if (result.actionJoined) {
      receipt = Object.freeze({});
      joinedWrites.set(receipt, {
        key: joinedWriteKey(
          binding,
          command.operationRef,
          patch.recordId,
          patch.body,
          context.configBytes,
        ),
        invocationRef,
        ...permitIdentity,
      });
      await persistDispatchEnd(
        context.dispatchPermit,
        receipt,
        binding,
        command,
        context,
      );
    }
    if (
      result.outcome === "read" &&
      receipt &&
      nativePutMatchesRecord(result.stdout, patch.recordId)
    )
      return { outcome: "returned", receipt };
    return {
      outcome: result.outcome === "revoked" ? "revoked" : "unknown",
      ...(receipt ? { receipt } : {}),
    };
  } catch (error) {
    return {
      outcome:
        error instanceof Error && error.message === "revoked"
          ? "revoked"
          : "unknown",
    };
  }
}

/** Read attachment metadata only for the same exact record; the extra info remains private. */
export async function getBoundAttachmentMetadata(
  binding: Binding,
  recordId: string,
  context: WorkspaceExecutionContext,
): Promise<
  | { outcome: "read"; stdout: Buffer }
  | { outcome: "unavailable" | "unknown" | "revoked" }
> {
  try {
    validateBinding(binding, context);
    recordGetArgv(binding, recordId);
    return await runNativeInternal(
      binding,
      "attachment_metadata",
      recordId,
      context,
    );
  } catch (error) {
    return {
      outcome:
        error instanceof Error && error.message === "revoked"
          ? "revoked"
          : "unknown",
    };
  }
}

/** Resolve a temporary URL only after a fresh exact-record attachment metadata read. */
export async function getBoundTemporaryUrl(
  binding: Binding,
  recordId: string,
  fieldId: string,
  fileToken: string,
  context: WorkspaceExecutionContext,
  expectedExtra?: string,
): Promise<
  | { outcome: "read"; fileToken: string; url: string }
  | { outcome: "unavailable" | "unknown" | "revoked" }
> {
  try {
    validateBinding(binding, context);
    recordGetArgv(binding, recordId);
    const config = context.core.parseRegistrationConfig(context.profileConfig);
    if (fieldId !== config.fields.photo || !ID.test(fileToken))
      return { outcome: "unavailable" };
    context.assertCurrent();
    const response = await getBoundAttachmentMetadata(
      binding,
      recordId,
      context,
    );
    context.assertCurrent();
    if (response.outcome !== "read") return response;
    const metadata = exactMetadata(nativeAttachmentMetadata(response.stdout), {
      recordId,
      fieldId,
      fileToken,
    });
    context.assertCurrent();
    if (expectedExtra !== undefined && metadata.extra !== expectedExtra)
      return { outcome: "unavailable" };
    const result = await runNativeInternal(
      binding,
      "attachment_url",
      recordId,
      context,
      undefined,
      "read",
      { fileToken, extra: metadata.extra },
    );
    context.assertCurrent();
    if (result.outcome !== "read") return result;
    const value = nativeTemporaryUrl(result.stdout, fileToken);
    context.assertCurrent();
    return { outcome: "read", ...value };
  } catch (error) {
    return {
      outcome:
        error instanceof Error && error.message === "revoked"
          ? "revoked"
          : "unavailable",
    };
  }
}
