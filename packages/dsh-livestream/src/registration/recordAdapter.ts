import { nativeSuccessData } from "./nativeEnvelope";
import { parseRecordMatrix } from "./recordMatrix";
import type { RegistrationConfig as BoundMapping } from "./artifactContract";

type ReadFailure =
  | "executor_unavailable"
  | "not_found"
  | "field_permission"
  | "required_field_missing"
  | "unsupported_field_shape";
interface NativeResult {
  outcome: "read" | "unavailable" | "unknown" | "revoked";
  stdout?: Uint8Array;
}
interface Dependencies {
  assertCurrent: (recordId: string, config: BoundMapping) => void;
  readExactRecord: (
    recordId: string,
    config: BoundMapping,
  ) => Promise<NativeResult>;
  projectRecord: (input: {
    config: BoundMapping;
    recordId: string;
    cells: ReadonlyMap<string, unknown>;
    readEvidenceRef: string;
    observedAt: string;
    trustedEvidence?: unknown;
  }) => unknown;
  getTrustedEvidence?: (
    recordId: string,
    config: BoundMapping,
    readEvidenceRef: string,
  ) => Promise<unknown>;
  now: () => string;
}

export function expectedRecordFields(config: BoundMapping) {
  const expected = [
    { id: config.fields.display_name, type: "text" },
    { id: config.fields.contact_text, type: "text" },
    { id: config.fields.photo, type: "attachment" },
    { id: config.fields.product_interest, type: "text" },
  ];
  const metadataTypes = {
    profile_revision: "number",
    consent_ref: "text",
    submission_ref: "text",
    source_kind: "text",
    collected_at: "datetime",
    photo_revision: "number",
    photo_sha256: "text",
    profile_operation_ref: "text",
  } as const;
  for (const key of Object.keys(metadataTypes) as Array<
    keyof typeof metadataTypes
  >) {
    const id = config.metadataFields[key];
    if (id !== null) expected.push({ id, type: metadataTypes[key] });
  }
  return expected;
}
/** Read raw native matrix only in this private adapter, never through a generic model/tool result. */
export async function readRegistrationProfile(
  config: BoundMapping,
  recordId: string,
  requestRef: string,
  readEvidenceRef: string,
  dependencies: Dependencies,
) {
  if (
    typeof requestRef !== "string" ||
    !requestRef.trim() ||
    typeof readEvidenceRef !== "string" ||
    !readEvidenceRef.trim()
  )
    throw new Error("invalid_shape");
  const header = {
    schemaVersion: "visitor-registration-profile/1" as const,
    requestRef,
  };
  try {
    dependencies.assertCurrent(recordId, config);
  } catch {
    return {
      ...header,
      outcome: "rejected" as const,
      code: "revoked" as const,
    };
  }
  let native: NativeResult;
  try {
    native = await dependencies.readExactRecord(recordId, config);
  } catch {
    return { ...header, outcome: "unknown" as const, code: "unknown" as const };
  }
  try {
    dependencies.assertCurrent(recordId, config);
  } catch {
    return {
      ...header,
      outcome: "rejected" as const,
      code: "revoked" as const,
    };
  }
  if (native.outcome === "revoked")
    return {
      ...header,
      outcome: "rejected" as const,
      code: "revoked" as const,
    };
  if (native.outcome === "unavailable")
    return {
      ...header,
      outcome: "unavailable" as const,
      code: "executor_unavailable" as const,
    };
  if (native.outcome !== "read" || !native.stdout)
    return { ...header, outcome: "unknown" as const, code: "unknown" as const };
  try {
    const data = nativeSuccessData(native.stdout);
    const cells = parseRecordMatrix(
      data,
      recordId,
      expectedRecordFields(config),
    );
    let trustedEvidence: unknown;
    if (dependencies.getTrustedEvidence) {
      trustedEvidence = await dependencies.getTrustedEvidence(
        recordId,
        config,
        readEvidenceRef,
      );
      dependencies.assertCurrent(recordId, config);
    }
    const observation = dependencies.projectRecord({
      config,
      recordId,
      cells,
      readEvidenceRef,
      observedAt: dependencies.now(),
      ...(trustedEvidence === undefined ? {} : { trustedEvidence }),
    });
    dependencies.assertCurrent(recordId, config);
    return { ...header, outcome: "read" as const, observation };
  } catch (error) {
    const code = error instanceof Error ? error.message : "unknown";
    if (code === "revoked")
      return {
        ...header,
        outcome: "rejected" as const,
        code: "revoked" as const,
      };
    if (code === "scope_mismatch")
      return {
        ...header,
        outcome: "conflict" as const,
        code: "record_changed" as const,
      };
    if (code === "metadata_conflict")
      return {
        ...header,
        outcome: "conflict" as const,
        code: "metadata_conflict" as const,
      };
    const known: ReadFailure[] = [
      "executor_unavailable",
      "not_found",
      "field_permission",
      "required_field_missing",
      "unsupported_field_shape",
    ];
    if (known.includes(code as ReadFailure))
      return {
        ...header,
        outcome: "unavailable" as const,
        code: code as ReadFailure,
      };
    return { ...header, outcome: "unknown" as const, code: "unknown" as const };
  }
}
