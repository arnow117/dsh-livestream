/** Narrow static interfaces for consuming the canonical Q artifact; runtime decoding stays in that artifact. */
export interface RegistrationConfig {
  schemaVersion: "visitor-registration-profile/1";
  mapping: { mappingId: string; revision: number };
  appRef: string;
  profileRef: string;
  baseId: string;
  visitorsTableId: string;
  formId: string | null;
  fields: {
    display_name: string;
    contact_text: string;
    photo: string;
    product_interest: string;
  };
  metadataFields: {
    profile_revision: string | null;
    consent_ref: string | null;
    submission_ref: string | null;
    source_kind: string | null;
    collected_at: string | null;
    photo_revision: string | null;
    photo_sha256: string | null;
    profile_operation_ref: string | null;
  };
}
export interface PatchCommand {
  schemaVersion: "visitor-registration-profile/1";
  operationRef: string;
  record: { baseId: string; tableId: string; recordId: string };
  mapping: { mappingId: string; revision: number };
  expectedProfileRevision: number;
  originalReadEvidenceRef: string;
  changes: {
    displayName?: string;
    contactText?: string;
    productInterest?: string | null;
    photo?:
      | { action: "remove" }
      | {
          action: "replace";
          attachment: { fieldId: string; fileToken: string };
          authorizedUploadEvidenceRef: string;
        };
  };
}
export interface SharedCore {
  parseRegistrationConfig(value: unknown): RegistrationConfig;
  validatePatch(value: unknown): PatchCommand;
}

export interface ChildContext {
  effect(callback: () => () => void, label?: string): unknown;
}
export interface ParentContext {
  plugin(
    plugin: (context: ChildContext) => void,
  ): Promise<{ dispose(): Promise<unknown> }>;
}
export interface PrivateRead<T> {
  requestRef: string;
  observation: T;
}
export interface PrivateDependencies<T> {
  assertCurrent: (grant: object, request: Request, component: object) => void;
  readOriginal: (
    grant: object,
    request: Request,
    component: object,
  ) => Promise<PrivateRead<T>>;
}
export interface RobotHost<T> {
  component: object;
  consume(grant: object, request: Request): Promise<PrivateRead<T>>;
  dispose(): Promise<unknown>;
}
export interface LoadedCore extends SharedCore {
  CONTRACT_VERSION: "visitor-registration-profile/1";
  sharedCoreIdentity: object;
  projectRecord(input: {
    config: RegistrationConfig;
    recordId: string;
    cells: ReadonlyMap<string, unknown>;
    readEvidenceRef: string;
    observedAt: string;
    trustedEvidence?: unknown;
  }): unknown;
  mountRobotPrivateHost<T>(
    context: ParentContext,
    dependencies: PrivateDependencies<T>,
  ): Promise<RobotHost<T>>;
  verifyPhotoBytes(
    bytes: Uint8Array,
    mime: string,
    digest: string | null,
  ): Promise<{
    mediaType: "image/png" | "image/jpeg";
    byteLength: number;
    width: number;
    height: number;
    sourceSha256: string;
    digestOrigin: "row_and_bytes" | "bytes_only";
  }>;
  createRobotPrivateHost: (...args: never[]) => unknown;
}
