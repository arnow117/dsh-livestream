import type { SharedCore } from "./artifactContract";

/** Facts must be supplied by the trusted host's original-record and upload evidence services. */
export interface PhotoMutationFacts {
  baseId: string;
  tableId: string;
  recordId: string;
  fieldId: string;
  originalReadEvidenceRef: string;
  replacement?: {
    fileToken: string;
    authorizedUploadEvidenceRef: string;
    sourceSha256: string;
    photoRevision: number;
  };
}

/** Encode only validated logical changes and host-derived metadata for the fixed v1 PUT. */
export function buildTextPatch(
  rawConfig: unknown,
  rawCommand: unknown,
  core: SharedCore,
  photoFacts?: PhotoMutationFacts,
): { recordId: string; body: Uint8Array } {
  const config = core.parseRegistrationConfig(rawConfig);
  const command = core.validatePatch(rawCommand);
  if (
    command.record.baseId !== config.baseId ||
    command.record.tableId !== config.visitorsTableId ||
    command.mapping.mappingId !== config.mapping.mappingId ||
    command.mapping.revision !== config.mapping.revision
  )
    throw new Error("scope_mismatch");
  if (
    !config.metadataFields.profile_revision ||
    !config.metadataFields.profile_operation_ref ||
    command.expectedProfileRevision === Number.MAX_SAFE_INTEGER
  )
    throw new Error("metadata_missing");
  const fields: Record<string, unknown> = Object.create(null);
  if (command.changes.displayName !== undefined)
    fields[config.fields.display_name] = command.changes.displayName;
  if (command.changes.contactText !== undefined)
    fields[config.fields.contact_text] = command.changes.contactText;
  if (command.changes.productInterest !== undefined)
    fields[config.fields.product_interest] = command.changes.productInterest;
  const photo = command.changes.photo;
  if (photo !== undefined) {
    const revisionField = config.metadataFields.photo_revision;
    const digestField = config.metadataFields.photo_sha256;
    if (!revisionField || !digestField) throw new Error("metadata_missing");
    if (
      !photoFacts ||
      photoFacts.baseId !== command.record.baseId ||
      photoFacts.tableId !== command.record.tableId ||
      photoFacts.recordId !== command.record.recordId ||
      photoFacts.fieldId !== config.fields.photo ||
      photoFacts.originalReadEvidenceRef !== command.originalReadEvidenceRef
    )
      throw new Error("attachment_unresolved");
    if (photo.action === "remove") {
      if (photoFacts.replacement !== undefined)
        throw new Error("attachment_unresolved");
      fields[config.fields.photo] = null;
      fields[revisionField] = null;
      fields[digestField] = null;
    } else {
      const replacement = photoFacts.replacement;
      if (
        !replacement ||
        photo.attachment.fieldId !== config.fields.photo ||
        replacement.fileToken !== photo.attachment.fileToken ||
        replacement.authorizedUploadEvidenceRef !==
          photo.authorizedUploadEvidenceRef ||
        !/^[a-f0-9]{64}$/.test(replacement.sourceSha256) ||
        !Number.isSafeInteger(replacement.photoRevision) ||
        replacement.photoRevision <= 0
      )
        throw new Error("attachment_unresolved");
      fields[config.fields.photo] = [{ file_token: replacement.fileToken }];
      fields[revisionField] = replacement.photoRevision;
      fields[digestField] = replacement.sourceSha256;
    }
  } else if (photoFacts !== undefined) {
    throw new Error("attachment_unresolved");
  }
  fields[config.metadataFields.profile_revision] =
    command.expectedProfileRevision + 1;
  fields[config.metadataFields.profile_operation_ref] = command.operationRef;
  const body = Buffer.from(JSON.stringify({ fields }));
  if (body.byteLength > 1024 * 1024) throw new Error("invalid_shape");
  return { recordId: command.record.recordId, body };
}
