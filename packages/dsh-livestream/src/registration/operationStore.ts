import { closeSync, lstatSync, openSync, realpathSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";
import { parseStrictJson } from "./strictJson";
import { buildTextPatch } from "./patchPayload";
import { operationDigests } from "./operationDigests";
import { REGISTRATION_NATIVE_SHA256 } from "./nativeCli/nativeIdentity";
import type { Binding, WorkspaceExecutionContext } from "./workspaceExecutor";
import type { PatchCommand } from "./artifactContract";
import {
  parseRecoveryDescriptor,
  descriptorHmac,
  matchesRecoveryEffect,
  recoveryPrincipalHmac,
  recoveryConfigHmac,
  type RecoveryDescriptor,
} from "./recoveryDescriptor";

const SCHEMA = [
  "CREATE TABLE identity (id TEXT NOT NULL PRIMARY KEY CHECK(id = 'singleton'), journal_id TEXT NOT NULL, key_ref TEXT NOT NULL, key_tag TEXT NOT NULL)",
  "CREATE TABLE operations (operation_ref TEXT NOT NULL PRIMARY KEY, record_key TEXT NOT NULL, binding_digest TEXT NOT NULL, patch_digest TEXT NOT NULL, expected_revision INTEGER NOT NULL, read_ref TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('prepared', 'dispatched', 'unknown', 'verified', 'failed', 'not_dispatched', 'conflict')), result_ref TEXT, result_code TEXT, result_revision INTEGER, recovery_descriptor TEXT NOT NULL, native_end TEXT, row_mac TEXT NOT NULL)",
  "CREATE TABLE lanes (record_key TEXT NOT NULL PRIMARY KEY, operation_ref TEXT NOT NULL UNIQUE REFERENCES operations(operation_ref))",
] as const;
const DIGEST = /^[a-f0-9]{64}$/;

/** This identity must be pinned outside mutable settings and shared by every writer. */
export interface JournalIdentity {
  canonicalPath: string;
  device: number;
  inode: number;
  journalId: string;
  keyRef: string;
  keyTag: string;
}
export interface Intent {
  operationRef: string;
  recordKey: string;
  bindingDigest: string;
  patchDigest: string;
  expectedRevision: number;
  readRef: string;
  descriptor: RecoveryDescriptor;
}
export interface NativeEndFact {
  version: "registration-native-end/1";
  journalId: string;
  operationRef: string;
  nonce: string;
  recordKey: string;
  descriptorHmac: string;
  invocationRef: string;
  nativeSha256: string;
  configHmac: string;
}
export interface StoredOperation {
  operationRef: string;
  recordKey: string;
  bindingDigest: string;
  patchDigest: string;
  expectedRevision: number;
  readRef: string;
  state: OperationState;
  resultRef: string | null;
  resultCode: string | null;
  resultRevision: number | null;
  descriptor: RecoveryDescriptor;
  nativeEnd: NativeEndFact | null;
}
export type OperationState =
  | "prepared"
  | "dispatched"
  | "unknown"
  | "verified"
  | "failed"
  | "not_dispatched"
  | "conflict";

function safeRef(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 256 &&
    !!value.trim() &&
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
      value,
    )
  );
}
function keyTag(key: Uint8Array): string {
  if (key.byteLength < 32) throw new Error("journal_unavailable");
  return createHmac("sha256", key)
    .update("visitor-registration-journal-key/1")
    .digest("hex");
}
const MAC_FIELDS = [
  "operation_ref",
  "record_key",
  "binding_digest",
  "patch_digest",
  "expected_revision",
  "read_ref",
  "state",
  "result_ref",
  "result_code",
  "result_revision",
  "recovery_descriptor",
  "native_end",
] as const;
function rowMac(row: Record<string, unknown>, key: Uint8Array): string {
  const values = MAC_FIELDS.map((field) => row[field]);
  if (values.some((value) => value === undefined))
    throw new Error("journal_unavailable");
  return createHmac("sha256", key)
    .update("visitor-registration-operation/1\0")
    .update(JSON.stringify(values))
    .digest("hex");
}
function verifyRows(
  db: DatabaseSync,
  key: Uint8Array,
  identity: JournalIdentity,
): void {
  const count = db
    .prepare("SELECT COUNT(*) AS count FROM operations")
    .get() as { count: number };
  if (!Number.isSafeInteger(count.count) || count.count > 10000)
    throw new Error("journal_unavailable");
  for (const row of db.prepare("SELECT * FROM operations").all() as Record<
    string,
    unknown
  >[]) {
    if (
      typeof row.row_mac !== "string" ||
      !DIGEST.test(row.row_mac) ||
      !safeRef(row.operation_ref) ||
      !safeRef(row.read_ref) ||
      typeof row.record_key !== "string" ||
      !DIGEST.test(row.record_key) ||
      typeof row.binding_digest !== "string" ||
      !DIGEST.test(row.binding_digest) ||
      typeof row.patch_digest !== "string" ||
      !DIGEST.test(row.patch_digest) ||
      typeof row.expected_revision !== "number" ||
      !Number.isSafeInteger(row.expected_revision) ||
      row.expected_revision <= 0 ||
      (row.result_ref !== null && !safeRef(row.result_ref))
    )
      throw new Error("journal_unavailable");
    if (
      typeof row.recovery_descriptor !== "string" ||
      row.recovery_descriptor.length > 16384
    )
      throw new Error("journal_unavailable");
    const descriptor = parseRecoveryDescriptor(
      parseStrictJson(Buffer.from(row.recovery_descriptor)),
    );
    if (
      descriptor.operationRef !== row.operation_ref ||
      descriptor.recordKey !== row.record_key ||
      descriptor.bindingDigest !== row.binding_digest ||
      descriptor.patchDigest !== row.patch_digest ||
      descriptor.expectedRevision !== row.expected_revision ||
      descriptor.readRef !== row.read_ref
    )
      throw new Error("journal_unavailable");
    if (row.native_end !== null) {
      if (typeof row.native_end !== "string" || row.native_end.length > 4096)
        throw new Error("journal_unavailable");
      const end = parseStrictJson(Buffer.from(row.native_end));
      if (!end || typeof end !== "object" || Array.isArray(end))
        throw new Error("journal_unavailable");
      const fact = end as Record<string, unknown>;
      const fields = [
        "version",
        "journalId",
        "operationRef",
        "nonce",
        "recordKey",
        "descriptorHmac",
        "invocationRef",
        "nativeSha256",
        "configHmac",
      ];
      if (
        Object.keys(fact).length !== fields.length ||
        fields.some((field) => !Object.hasOwn(fact, field)) ||
        fact.version !== "registration-native-end/1" ||
        fact.journalId !== identity.journalId ||
        fact.operationRef !== descriptor.operationRef ||
        fact.nonce !== descriptor.nonce ||
        fact.recordKey !== descriptor.recordKey ||
        fact.descriptorHmac !== descriptorHmac(key, descriptor) ||
        !safeRef(fact.invocationRef) ||
        fact.nativeSha256 !== descriptor.nativeSha256 ||
        fact.configHmac !== descriptor.configHmac ||
        !["dispatched", "unknown", "verified", "failed"].includes(
          String(row.state),
        )
      )
        throw new Error("journal_unavailable");
    }
    const expected = Buffer.from(rowMac(row, key), "hex");
    if (!timingSafeEqual(expected, Buffer.from(row.row_mac, "hex")))
      throw new Error("journal_unavailable");
  }
}
function verifyParent(path: string): void {
  const parent = dirname(path);
  if (
    !isAbsolute(path) ||
    resolve(path) !== path ||
    realpathSync(parent) !== parent ||
    typeof process.getuid !== "function"
  ) {
    throw new Error("journal_unavailable");
  }
  const uid = process.getuid();
  let current = parent;
  for (;;) {
    const stat = lstatSync(current);
    const isDirectParent = current === parent;
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.uid !== uid && stat.uid !== 0) ||
      (stat.mode & 0o022) !== 0 ||
      (isDirectParent && (stat.uid !== uid || (stat.mode & 0o077) !== 0))
    ) {
      throw new Error("journal_unavailable");
    }
    const next = dirname(current);
    if (next === current) break;
    current = next;
  }
}
function fileIdentity(path: string): { device: number; inode: number } {
  verifyParent(path);
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    typeof process.getuid !== "function" ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o7777) !== 0o600 ||
    realpathSync(path) !== path
  ) {
    throw new Error("journal_unavailable");
  }
  return { device: stat.dev, inode: stat.ino };
}
function verifyFile(identity: JournalIdentity): void {
  const actual = fileIdentity(identity.canonicalPath);
  if (actual.device !== identity.device || actual.inode !== identity.inode)
    throw new Error("journal_unavailable");
}
function verifySchema(
  db: DatabaseSync,
  identity: JournalIdentity,
  key: Uint8Array,
): void {
  const version = db.prepare("PRAGMA user_version").get() as
    | { user_version: number }
    | undefined;
  const check = db.prepare("PRAGMA quick_check").all() as Array<
    Record<string, unknown>
  >;
  const tables = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as Array<{ sql: string }>;
  const extraObjects = db
    .prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type IN ('trigger', 'view') OR (type = 'index' AND name NOT LIKE 'sqlite_%')",
    )
    .get() as { count: number };
  const expected = [...SCHEMA].sort((a, b) => {
    const name = (s: string) => s.split(" ")[2];
    return name(a).localeCompare(name(b));
  });
  if (
    version?.user_version !== 2 ||
    check.length !== 1 ||
    check[0]?.quick_check !== "ok" ||
    tables.length !== expected.length ||
    extraObjects.count !== 0 ||
    tables.some((table, index) => table.sql !== expected[index])
  ) {
    throw new Error("journal_unavailable");
  }
  const mode = db.prepare("PRAGMA journal_mode").get() as
    | { journal_mode: string }
    | undefined;
  const foreign = db.prepare("PRAGMA foreign_key_check").all();
  const mismatch = db
    .prepare(
      `SELECT COUNT(*) AS count FROM operations o
    LEFT JOIN lanes l ON l.operation_ref = o.operation_ref
    WHERE (o.state IN ('prepared','dispatched','unknown') AND (l.operation_ref IS NULL OR l.record_key != o.record_key))
       OR (o.state IN ('verified','failed','not_dispatched','conflict') AND l.operation_ref IS NOT NULL)
       OR (o.state IN ('prepared','dispatched','unknown') AND (o.result_ref IS NOT NULL OR o.result_code IS NOT NULL OR o.result_revision IS NOT NULL))
       OR (o.state IN ('not_dispatched','conflict') AND (o.result_ref IS NULL OR o.result_code IS NOT NULL OR o.result_revision IS NOT NULL))
       OR (o.state = 'verified' AND (o.native_end IS NULL OR o.result_ref IS NULL OR o.result_code IS NOT NULL OR o.result_revision IS NULL OR o.result_revision <= o.expected_revision))
       OR (o.state = 'failed' AND (o.native_end IS NULL OR o.result_ref IS NULL OR o.result_code NOT IN ('platform_rejected','field_permission') OR o.result_code IS NULL OR o.result_revision IS NOT NULL))`,
    )
    .get() as { count: number };
  if (
    mode?.journal_mode !== "delete" ||
    foreign.length !== 0 ||
    mismatch.count !== 0
  )
    throw new Error("journal_unavailable");
  verifyRows(db, key, identity);
  const row = db
    .prepare("SELECT journal_id, key_ref, key_tag FROM identity WHERE id = ?")
    .get("singleton") as
    | { journal_id: string; key_ref: string; key_tag: string }
    | undefined;
  if (
    row?.journal_id !== identity.journalId ||
    row.key_ref !== identity.keyRef ||
    row.key_tag !== identity.keyTag
  )
    throw new Error("journal_unavailable");
}

/** Provisioning is explicit; callers must persist the returned identity in trusted deployment policy. */
export function provisionJournal(
  canonicalPath: string,
  keyRef: string,
  key: Uint8Array,
): JournalIdentity {
  if (!safeRef(keyRef)) throw new Error("journal_unavailable");
  const tag = keyTag(key);
  verifyParent(canonicalPath);
  const fd = openSync(canonicalPath, "wx", 0o600);
  closeSync(fd);
  const file = fileIdentity(canonicalPath);
  const identity = {
    canonicalPath,
    ...file,
    journalId: randomUUID(),
    keyRef,
    keyTag: tag,
  };
  const db = new DatabaseSync(canonicalPath);
  try {
    db.exec(
      "PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; BEGIN IMMEDIATE",
    );
    for (const statement of SCHEMA) db.exec(statement);
    db.prepare(
      "INSERT INTO identity(id, journal_id, key_ref, key_tag) VALUES (?, ?, ?, ?)",
    ).run("singleton", identity.journalId, identity.keyRef, identity.keyTag);
    db.exec("PRAGMA user_version = 2; COMMIT");
    verifyFile(identity);
    verifySchema(db, identity, key);
    return identity;
  } finally {
    db.close();
  }
}

export class OperationStore {
  readonly #db: DatabaseSync;
  private readonly identity: JournalIdentity;
  readonly #key: Buffer;
  readonly #dispatchRights = new Set<string>();
  #nativeEndPersistenceFailed = false;
  constructor(identity: JournalIdentity, key: Uint8Array) {
    this.identity = Object.freeze({ ...identity });
    this.#key = Buffer.from(key);
    identity = this.identity;
    if (keyTag(key) !== identity.keyTag || !safeRef(identity.keyRef))
      throw new Error("journal_unavailable");
    verifyFile(identity);
    const probe = new DatabaseSync(identity.canonicalPath, { readOnly: true });
    try {
      probe.exec("PRAGMA busy_timeout = 3000; PRAGMA foreign_keys = ON; BEGIN");
      verifySchema(probe, identity, this.#key);
      probe.exec("COMMIT");
    } finally {
      probe.close();
    }
    verifyFile(identity);
    this.#db = new DatabaseSync(identity.canonicalPath);
    this.#db.exec(
      "PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000; PRAGMA synchronous = FULL",
    );
    try {
      verifyFile(identity);
      this.#db.exec("BEGIN");
      verifySchema(this.#db, identity, this.#key);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }
  permitIdentity(
    operationRef: string,
    nonce: string,
  ): { journalId: string; nonce: string; descriptorHmac: string } | null {
    const row = this.inspect(operationRef);
    if (!row || row.state !== "dispatched" || row.descriptor.nonce !== nonce)
      return null;
    return {
      journalId: this.identity.journalId,
      nonce,
      descriptorHmac: descriptorHmac(this.#key, row.descriptor),
    };
  }
  matchesEffect(
    descriptor: RecoveryDescriptor,
    cells: ReadonlyMap<string, unknown>,
  ): boolean {
    return matchesRecoveryEffect(this.#key, descriptor, cells);
  }
  assertKey(key: Uint8Array): void {
    if (keyTag(key) !== this.identity.keyTag)
      throw new Error("journal_unavailable");
  }
  close(): void {
    try {
      this.#db.close();
    } finally {
      this.#key.fill(0);
    }
  }
  private verifyFresh(): void {
    verifyFile(this.identity);
    const probe = new DatabaseSync(this.identity.canonicalPath, {
      readOnly: true,
    });
    try {
      probe.exec("PRAGMA busy_timeout = 3000; PRAGMA foreign_keys = ON; BEGIN");
      verifySchema(probe, this.identity, this.#key);
      probe.exec("COMMIT");
    } finally {
      probe.close();
    }
    verifyFile(this.identity);
  }
  private transaction<T>(callback: () => T): T {
    this.verifyFresh();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      verifyFile(this.identity);
      verifySchema(this.#db, this.identity, this.#key);
      const result = callback();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }
  reserve(intent: Intent): "reserved" | "existing" | "occupied" {
    if (this.#nativeEndPersistenceFailed)
      throw new Error("journal_unavailable");
    if (
      !safeRef(intent.operationRef) ||
      !safeRef(intent.readRef) ||
      !DIGEST.test(intent.recordKey) ||
      !DIGEST.test(intent.bindingDigest) ||
      !DIGEST.test(intent.patchDigest) ||
      !Number.isSafeInteger(intent.expectedRevision) ||
      intent.expectedRevision <= 0
    )
      throw new Error("invalid_shape");
    const descriptor = parseRecoveryDescriptor(intent.descriptor);
    if (
      descriptor.operationRef !== intent.operationRef ||
      descriptor.recordKey !== intent.recordKey ||
      descriptor.bindingDigest !== intent.bindingDigest ||
      descriptor.patchDigest !== intent.patchDigest ||
      descriptor.expectedRevision !== intent.expectedRevision ||
      descriptor.readRef !== intent.readRef
    )
      throw new Error("invalid_shape");
    const descriptorJson = JSON.stringify(descriptor);
    if (Buffer.byteLength(descriptorJson) > 16384)
      throw new Error("invalid_shape");
    const reserved = this.transaction(() => {
      const existing = this.#db
        .prepare("SELECT * FROM operations WHERE operation_ref = ?")
        .get(intent.operationRef) as Record<string, unknown> | undefined;
      if (existing) {
        if (typeof existing.recovery_descriptor !== "string")
          throw new Error("journal_unavailable");
        const prior = parseRecoveryDescriptor(
          parseStrictJson(Buffer.from(existing.recovery_descriptor)),
        );
        const {
          nonce: _priorNonce,
          effectHmac: _priorEffect,
          ...priorIdentity
        } = prior;
        const {
          nonce: _nextNonce,
          effectHmac: _nextEffect,
          ...nextIdentity
        } = descriptor;
        if (
          JSON.stringify(priorIdentity) !== JSON.stringify(nextIdentity) ||
          existing.record_key !== intent.recordKey ||
          existing.binding_digest !== intent.bindingDigest ||
          existing.patch_digest !== intent.patchDigest ||
          existing.expected_revision !== intent.expectedRevision ||
          existing.read_ref !== intent.readRef
        ) {
          throw new Error("operation_conflict");
        }
        return "existing";
      }
      if (
        this.#db
          .prepare("SELECT operation_ref FROM lanes WHERE record_key = ?")
          .get(intent.recordKey)
      )
        return "occupied";
      const count = this.#db
        .prepare("SELECT COUNT(*) AS count FROM operations")
        .get() as { count: number };
      if (count.count >= 10000) throw new Error("journal_capacity");
      const row = {
        operation_ref: intent.operationRef,
        record_key: intent.recordKey,
        binding_digest: intent.bindingDigest,
        patch_digest: intent.patchDigest,
        expected_revision: intent.expectedRevision,
        read_ref: intent.readRef,
        state: "prepared",
        result_ref: null,
        result_code: null,
        result_revision: null,
        recovery_descriptor: descriptorJson,
        native_end: null,
      };
      this.#db
        .prepare(
          "INSERT INTO operations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          intent.operationRef,
          intent.recordKey,
          intent.bindingDigest,
          intent.patchDigest,
          intent.expectedRevision,
          intent.readRef,
          "prepared",
          null,
          null,
          null,
          descriptorJson,
          null,
          rowMac(row, this.#key),
        );
      this.#db
        .prepare("INSERT INTO lanes VALUES (?, ?)")
        .run(intent.recordKey, intent.operationRef);
      return "reserved" as const;
    });
    if (reserved === "reserved") this.#dispatchRights.add(intent.operationRef);
    return reserved;
  }
  /** Only the process that created this prepared intent may issue its original permit. */
  consumeDispatchRight(operationRef: string): boolean {
    return (
      !this.#nativeEndPersistenceFailed &&
      this.#dispatchRights.delete(operationRef)
    );
  }
  private advance(
    operationRef: string,
    from: OperationState,
    to: OperationState,
  ): void {
    this.transaction(() => {
      const row = this.#db
        .prepare("SELECT * FROM operations WHERE operation_ref = ?")
        .get(operationRef) as Record<string, unknown> | undefined;
      if (!row || row.state !== from) throw new Error("invalid_transition");
      const mac = rowMac({ ...row, state: to }, this.#key);
      const result = this.#db
        .prepare(
          "UPDATE operations SET state = ?, row_mac = ? WHERE operation_ref = ? AND state = ?",
        )
        .run(to, mac, operationRef, from);
      if (result.changes !== 1) throw new Error("invalid_transition");
    });
  }
  markDispatched(operationRef: string): void {
    this.advance(operationRef, "prepared", "dispatched");
  }
  markUnknown(operationRef: string): void {
    this.advance(operationRef, "dispatched", "unknown");
  }
  /** An interrupted end-fact write makes this instance unavailable for new writes. */
  failNativeEndPersistence(): void {
    this.#nativeEndPersistenceFailed = true;
    this.#dispatchRights.clear();
  }
  /** Only the original joined invocation can create a durable, MAC-covered end fact. */
  async recordNativeEnd(
    operationRef: string,
    receipt: object,
    binding: Binding,
    command: PatchCommand,
    context: WorkspaceExecutionContext,
  ): Promise<void> {
    const { joinedWriteInvocation } = await import("./workspaceExecutor");
    const stored = this.inspect(operationRef);
    if (!stored) throw new Error("write_coordination_unavailable");
    const originalIdentity = this.permitIdentity(
      operationRef,
      stored.descriptor.nonce,
    );
    if (!originalIdentity) throw new Error("write_coordination_unavailable");
    const invocationRef = joinedWriteInvocation(
      receipt,
      binding,
      command,
      context,
      originalIdentity,
    );
    if (!invocationRef) throw new Error("write_coordination_unavailable");
    const patch = buildTextPatch(
      context.profileConfig,
      command,
      context.core,
      context.photoFacts,
    );
    const raw = parseStrictJson(patch.body) as {
      fields?: Record<string, unknown>;
    };
    const fields = raw?.fields;
    if (!fields) throw new Error("write_coordination_unavailable");
    try {
      this.transaction(() => {
        const row = this.#db
          .prepare("SELECT * FROM operations WHERE operation_ref = ?")
          .get(operationRef) as Record<string, unknown> | undefined;
        if (
          !row ||
          row.state !== "dispatched" ||
          row.native_end !== null ||
          typeof row.recovery_descriptor !== "string"
        )
          throw new Error("invalid_transition");
        const descriptor = parseRecoveryDescriptor(
          parseStrictJson(Buffer.from(row.recovery_descriptor)),
        );
        const digests = operationDigests(
          this.#key,
          command,
          descriptor.authority,
          context.photoFacts,
        );
        if (
          command.operationRef !== operationRef ||
          descriptor.recordKey !== digests.recordKey ||
          descriptor.bindingDigest !== digests.bindingDigest ||
          descriptor.patchDigest !== digests.patchDigest ||
          descriptor.principalHmac !==
            recoveryPrincipalHmac(this.#key, binding) ||
          descriptor.configHmac !==
            recoveryConfigHmac(this.#key, context.configBytes, binding) ||
          descriptor.nativeSha256 !== REGISTRATION_NATIVE_SHA256 ||
          !matchesRecoveryEffect(
            this.#key,
            descriptor,
            new Map(Object.entries(fields)),
          ) ||
          joinedWriteInvocation(
            receipt,
            binding,
            command,
            context,
            originalIdentity,
          ) !== invocationRef
        )
          throw new Error("write_coordination_unavailable");
        const fact: NativeEndFact = {
          version: "registration-native-end/1",
          journalId: this.identity.journalId,
          operationRef,
          nonce: descriptor.nonce,
          recordKey: descriptor.recordKey,
          descriptorHmac: descriptorHmac(this.#key, descriptor),
          invocationRef,
          nativeSha256: descriptor.nativeSha256,
          configHmac: descriptor.configHmac,
        };
        const nativeEnd = JSON.stringify(fact);
        const updated = { ...row, native_end: nativeEnd };
        this.#db
          .prepare(
            "UPDATE operations SET native_end = ?, row_mac = ? WHERE operation_ref = ?",
          )
          .run(nativeEnd, rowMac(updated, this.#key), operationRef);
      });
    } catch (error) {
      this.#nativeEndPersistenceFailed = true;
      this.#dispatchRights.clear();
      throw error;
    }
  }

  /** Caller must supply only a trusted outcome; this method performs no remote verification. */
  settle(
    operationRef: string,
    outcome: "not_dispatched" | "conflict" | "failed" | "verified",
    proofRef: string,
    details?: {
      code?: "platform_rejected" | "field_permission";
      revision?: number;
    },
  ): void {
    if (
      !safeRef(proofRef) ||
      !["not_dispatched", "conflict", "failed", "verified"].includes(outcome) ||
      (outcome === "failed" &&
        (!["platform_rejected", "field_permission"].includes(
          details?.code ?? "",
        ) ||
          details?.revision !== undefined)) ||
      (outcome === "verified" &&
        (details?.code !== undefined ||
          !Number.isSafeInteger(details?.revision) ||
          (details?.revision ?? 0) <= 0)) ||
      ((outcome === "not_dispatched" || outcome === "conflict") &&
        (details?.code !== undefined || details?.revision !== undefined))
    )
      throw new Error("invalid_shape");
    this.transaction(() => {
      const allowed =
        outcome === "not_dispatched" || outcome === "conflict"
          ? ["prepared"]
          : ["dispatched", "unknown"];
      const operation = this.#db
        .prepare("SELECT * FROM operations WHERE operation_ref = ?")
        .get(operationRef) as
        | (Record<string, unknown> & {
            state: string;
            expected_revision: number;
          })
        | undefined;
      if (
        !operation ||
        !allowed.includes(operation.state) ||
        ((outcome === "verified" || outcome === "failed") &&
          operation.native_end === null) ||
        (outcome === "verified" &&
          (details?.revision ?? 0) <= operation.expected_revision)
      )
        throw new Error("invalid_transition");
      const updated = {
        ...operation,
        state: outcome,
        result_ref: proofRef,
        result_code: details?.code ?? null,
        result_revision: details?.revision ?? null,
      };
      this.#db
        .prepare(
          "UPDATE operations SET state = ?, result_ref = ?, result_code = ?, result_revision = ?, row_mac = ? WHERE operation_ref = ?",
        )
        .run(
          outcome,
          proofRef,
          details?.code ?? null,
          details?.revision ?? null,
          rowMac(updated, this.#key),
          operationRef,
        );
      this.#db
        .prepare("DELETE FROM lanes WHERE operation_ref = ?")
        .run(operationRef);
    });
  }
  /** Atomically settle only the same durable original end fact and exact next revision. */
  settleRecoveredVerified(
    operationRef: string,
    nonce: string,
    expectedEnd: string,
    revision: number,
    readRef: string,
  ): void {
    if (this.#nativeEndPersistenceFailed)
      throw new Error("journal_unavailable");
    if (
      !safeRef(readRef) ||
      !DIGEST.test(nonce) ||
      !DIGEST.test(expectedEnd) ||
      !Number.isSafeInteger(revision)
    )
      throw new Error("invalid_shape");
    this.transaction(() => {
      const row = this.#db
        .prepare("SELECT * FROM operations WHERE operation_ref = ?")
        .get(operationRef) as Record<string, unknown> | undefined;
      if (
        !row ||
        !["dispatched", "unknown"].includes(String(row.state)) ||
        typeof row.recovery_descriptor !== "string" ||
        typeof row.native_end !== "string"
      )
        throw new Error("invalid_transition");
      const descriptor = parseRecoveryDescriptor(
        parseStrictJson(Buffer.from(row.recovery_descriptor)),
      );
      const fact = parseStrictJson(
        Buffer.from(row.native_end),
      ) as NativeEndFact;
      if (
        descriptor.nonce !== nonce ||
        fact.descriptorHmac !== expectedEnd ||
        descriptorHmac(this.#key, descriptor) !== expectedEnd ||
        revision !== descriptor.expectedRevision + 1
      )
        throw new Error("invalid_transition");
      const updated = {
        ...row,
        state: "verified",
        result_ref: readRef,
        result_code: null,
        result_revision: revision,
      };
      this.#db
        .prepare(
          "UPDATE operations SET state = ?, result_ref = ?, result_code = NULL, result_revision = ?, row_mac = ? WHERE operation_ref = ?",
        )
        .run(
          "verified",
          readRef,
          revision,
          rowMac(updated, this.#key),
          operationRef,
        );
      this.#db
        .prepare("DELETE FROM lanes WHERE operation_ref = ?")
        .run(operationRef);
    });
  }

  inspect(operationRef: string): StoredOperation | null {
    this.verifyFresh();
    const row = this.#db
      .prepare("SELECT * FROM operations WHERE operation_ref = ?")
      .get(operationRef) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      operationRef: row.operation_ref as string,
      recordKey: row.record_key as string,
      bindingDigest: row.binding_digest as string,
      patchDigest: row.patch_digest as string,
      expectedRevision: row.expected_revision as number,
      readRef: row.read_ref as string,
      state: row.state as OperationState,
      resultRef: row.result_ref as string | null,
      resultCode: row.result_code as string | null,
      resultRevision: row.result_revision as number | null,
      descriptor: parseRecoveryDescriptor(
        parseStrictJson(Buffer.from(row.recovery_descriptor as string)),
      ),
      nativeEnd:
        row.native_end === null
          ? null
          : (parseStrictJson(
              Buffer.from(row.native_end as string),
            ) as NativeEndFact),
    };
  }
  get(operationRef: string): OperationState | null {
    this.verifyFresh();
    const row = this.#db
      .prepare("SELECT state FROM operations WHERE operation_ref = ?")
      .get(operationRef) as { state: OperationState } | undefined;
    return row?.state ?? null;
  }
}
