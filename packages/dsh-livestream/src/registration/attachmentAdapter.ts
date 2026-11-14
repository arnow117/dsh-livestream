import { downloadAuthorizedPhoto } from "./restrictedDownload";
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
interface Version {
  recordId: string;
  fieldId: string;
  fileToken: string;
  profileRevision: number;
  photoRevision: number;
  storedSha256: string | null;
}
interface VerifiedBytes {
  mediaType: "image/png" | "image/jpeg";
  byteLength: number;
  width: number;
  height: number;
  sourceSha256: string;
  digestOrigin: "row_and_bytes" | "bytes_only";
}
interface Dependencies {
  /** Checks exact record, recipient, photo capability and verified photo-processing consent. */
  assertCurrent: (expected: Version) => void;
  /** A native, bound get_attachments result for this exact record. */
  getAttachmentMetadata: (recordId: string) => Promise<unknown>;
  /** A fixed official temporary URL method under the same native identity; never accepts a model URL. */
  getTemporaryUrl: (
    fileToken: string,
    extra: string,
  ) => Promise<{ fileToken: string; url: string }>;
  readOriginalVersion: () => Promise<Version>;
  verifyPhotoBytes: (
    bytes: Uint8Array,
    mime: string,
    digest: string | null,
  ) => Promise<VerifiedBytes>;
  evidenceRef: (facts: {
    sourceSha256: string;
    profileRevision: number;
    photoRevision: number;
  }) => string;
  trustedDownloadHosts: readonly string[];
  signal: AbortSignal;
}
export function exactMetadata(
  raw: unknown,
  expected: Pick<Version, "recordId" | "fieldId" | "fileToken">,
): { extra: string; mime: "image/png" | "image/jpeg" | null } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("metadata_missing");
  const records = raw as Record<string, unknown>;
  if (
    Object.keys(records).length !== 1 ||
    !Object.hasOwn(records, expected.recordId)
  )
    throw new Error("metadata_missing");
  const fields = records[expected.recordId];
  if (!fields || typeof fields !== "object" || Array.isArray(fields))
    throw new Error("metadata_missing");
  let match: Record<string, unknown> | undefined;
  let occurrences = 0;
  for (const [field, value] of Object.entries(fields)) {
    if (!Array.isArray(value)) throw new Error("metadata_missing");
    for (const item of value) {
      if (!item || typeof item !== "object" || Array.isArray(item))
        throw new Error("metadata_missing");
      const row = item as Record<string, unknown>;
      if (row.file_token === expected.fileToken) {
        occurrences++;
        if (field === expected.fieldId) match = row;
      }
    }
  }
  if (
    occurrences !== 1 ||
    !match ||
    (match.extra_info !== undefined && typeof match.extra_info !== "string") ||
    (match.mime_type !== undefined &&
      match.mime_type !== "" &&
      match.mime_type !== "image/png" &&
      match.mime_type !== "image/jpeg")
  )
    throw new Error("metadata_missing");
  return {
    extra: typeof match.extra_info === "string" ? match.extra_info : "",
    mime:
      match.mime_type === "image/png" || match.mime_type === "image/jpeg"
        ? match.mime_type
        : null,
  };
}
function sameVersion(a: Version, b: Version): boolean {
  return (
    a.recordId === b.recordId &&
    a.fieldId === b.fieldId &&
    a.fileToken === b.fileToken &&
    a.profileRevision === b.profileRevision &&
    a.photoRevision === b.photoRevision &&
    a.storedSha256 === b.storedSha256
  );
}
/** All raw metadata, temporary URLs and bytes remain inside the authorized private execution. */
export async function verifyAuthorizedAttachment(
  expected: Version,
  dependencies: Dependencies,
) {
  try {
    if (
      ![expected.recordId, expected.fieldId, expected.fileToken].every(
        (value) => ID.test(value),
      ) ||
      !Number.isSafeInteger(expected.profileRevision) ||
      expected.profileRevision <= 0 ||
      !Number.isSafeInteger(expected.photoRevision) ||
      expected.photoRevision <= 0 ||
      (expected.storedSha256 !== null &&
        !/^[a-f0-9]{64}$/.test(expected.storedSha256))
    )
      return {
        outcome: "reference_only" as const,
        reason: "metadata_missing" as const,
      };
    dependencies.assertCurrent(expected);
    const metadata = exactMetadata(
      await dependencies.getAttachmentMetadata(expected.recordId),
      expected,
    );
    dependencies.assertCurrent(expected);
    const temp = await dependencies.getTemporaryUrl(
      expected.fileToken,
      metadata.extra,
    );
    dependencies.assertCurrent(expected);
    if (
      !temp ||
      temp.fileToken !== expected.fileToken ||
      typeof temp.url !== "string"
    )
      return {
        outcome: "reference_only" as const,
        reason: "photo_restricted" as const,
      };
    const downloaded = await downloadAuthorizedPhoto(
      temp.url,
      dependencies.trustedDownloadHosts,
      dependencies.signal,
    );
    dependencies.assertCurrent(expected);
    if (metadata.mime !== null && downloaded.mediaType !== metadata.mime)
      return { outcome: "invalid" as const, reason: "invalid_image" as const };
    const verified = await dependencies.verifyPhotoBytes(
      downloaded.bytes,
      downloaded.mediaType,
      expected.storedSha256,
    );
    dependencies.assertCurrent(expected);
    const current = await dependencies.readOriginalVersion();
    dependencies.assertCurrent(expected);
    if (!sameVersion(expected, current))
      return { outcome: "conflict" as const, code: "record_changed" as const };
    const evidenceRef = dependencies.evidenceRef({
      sourceSha256: verified.sourceSha256,
      profileRevision: expected.profileRevision,
      photoRevision: expected.photoRevision,
    });
    if (!evidenceRef.trim())
      return {
        outcome: "reference_only" as const,
        reason: "executor_unavailable" as const,
      };
    dependencies.assertCurrent(expected);
    return {
      outcome: "verified" as const,
      photo: {
        state: "verified" as const,
        attachment: {
          fieldId: expected.fieldId,
          fileToken: expected.fileToken,
        },
        profileRevision: expected.profileRevision,
        photoRevision: expected.photoRevision,
        ...verified,
        evidenceRef,
      },
    };
  } catch (error) {
    try {
      dependencies.assertCurrent(expected);
    } catch {
      return { outcome: "revoked" as const };
    }
    const reason = error instanceof Error ? error.message : "";
    if (reason === "revoked") return { outcome: "revoked" as const };
    if (reason === "metadata_conflict")
      return {
        outcome: "invalid" as const,
        reason: "metadata_conflict" as const,
      };
    if (reason === "invalid_image")
      return { outcome: "invalid" as const, reason: "invalid_image" as const };
    return {
      outcome: "reference_only" as const,
      reason:
        reason === "metadata_missing"
          ? ("metadata_missing" as const)
          : ("photo_restricted" as const),
    };
  }
}
