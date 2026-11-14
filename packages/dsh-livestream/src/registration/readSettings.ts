/** Only deployment references and field identifiers are persisted here. */
export interface ReadSettings {
  workspaceId: string;
  profile: string;
  appId: string;
  userOpenId: string;
  artifactDirectory: string;
  baseId: string;
  tableId: string;
  recordId: string;
  mappingId: string;
  mappingRevision: number;
  displayNameField: string;
  contactField: string;
  interestField: string;
  photoField: string;
  revisionField: string | null;
  consentField: string | null;
  sourceField: string | null;
  collectedAtField: string | null;
}

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const required = [
  "workspaceId",
  "profile",
  "appId",
  "userOpenId",
  "baseId",
  "tableId",
  "recordId",
  "mappingId",
  "displayNameField",
  "contactField",
  "interestField",
  "photoField",
] as const;
const optional = [
  "revisionField",
  "consentField",
  "sourceField",
  "collectedAtField",
] as const;

export function parseReadSettings(value: unknown): ReadSettings {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_settings");
  const input = value as Record<string, unknown>;
  const keys = [
    ...required,
    ...optional,
    "artifactDirectory",
    "mappingRevision",
  ];
  if (
    Object.keys(input).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(input, key))
  )
    throw new Error("invalid_settings");
  if (
    required.some(
      (key) =>
        typeof input[key] !== "string" || !idPattern.test(input[key] as string),
    )
  )
    throw new Error("invalid_settings");
  if (
    optional.some(
      (key) =>
        input[key] !== null &&
        (typeof input[key] !== "string" ||
          !idPattern.test(input[key] as string)),
    )
  )
    throw new Error("invalid_settings");
  if (
    typeof input.artifactDirectory !== "string" ||
    !input.artifactDirectory.startsWith("/") ||
    input.artifactDirectory.includes("\0") ||
    input.artifactDirectory.length > 1024 ||
    input.artifactDirectory
      .split("/")
      .some((part) => part === "." || part === "..")
  )
    throw new Error("invalid_settings");
  if (
    typeof input.mappingRevision !== "number" ||
    !Number.isSafeInteger(input.mappingRevision) ||
    input.mappingRevision <= 0
  )
    throw new Error("invalid_settings");
  const fields = [...required.slice(-4), ...optional]
    .map((key) => input[key])
    .filter((v): v is string => typeof v === "string");
  if (new Set(fields).size !== fields.length)
    throw new Error("invalid_settings");
  return { ...input } as unknown as ReadSettings;
}
