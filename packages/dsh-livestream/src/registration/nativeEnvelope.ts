import { parseStrictJson } from "./strictJson";

/** Only the user identity and native success data are admitted; notices never leave this adapter. */
export function nativeSuccessData(bytes: Uint8Array): unknown {
  const envelope = parseStrictJson(bytes);
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope))
    throw new Error("invalid_shape");
  const raw = envelope as Record<string, unknown>;
  const allowed = [
    "ok",
    "identity",
    "dry_run",
    "data",
    "meta",
    "_notice",
    "_content_safety_alert",
  ];
  if (
    Object.keys(raw).some((key) => !allowed.includes(key)) ||
    raw.ok !== true ||
    raw.identity !== "user" ||
    (raw.dry_run !== undefined && raw.dry_run !== false) ||
    !Object.hasOwn(raw, "data")
  )
    throw new Error("invalid_shape");
  return raw.data;
}
export function nativeAttachmentMetadata(bytes: Uint8Array): unknown {
  const data = nativeSuccessData(bytes);
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    !Object.hasOwn(data, "attachments")
  )
    throw new Error("invalid_shape");
  return (data as Record<string, unknown>).attachments;
}

/** A successful PUT response must identify exactly the bound record before readback. */
export function nativePutMatchesRecord(
  bytes: Uint8Array,
  recordId: string,
): boolean {
  try {
    const data = nativeSuccessData(bytes);
    if (!data || typeof data !== "object" || Array.isArray(data)) return false;
    const body = data as Record<string, unknown>;
    const record = body.record;
    if (!record || typeof record !== "object" || Array.isArray(record))
      return false;
    const row = record as Record<string, unknown>;
    if (row.record_id !== recordId) return false;
    if (Object.hasOwn(body, "records") || Object.hasOwn(body, "record_id_list"))
      return false;
    return true;
  } catch {
    return false;
  }
}

/** Extract exactly one temporary URL for the requested token; caller must validate its HTTPS origin. */
export function nativeTemporaryUrl(
  bytes: Uint8Array,
  expectedToken: string,
): { fileToken: string; url: string } {
  const data = nativeSuccessData(bytes);
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("invalid_shape");
  const urls = (data as Record<string, unknown>).tmp_download_urls;
  if (!Array.isArray(urls) || urls.length !== 1)
    throw new Error("invalid_shape");
  const item = urls[0];
  if (!item || typeof item !== "object" || Array.isArray(item))
    throw new Error("invalid_shape");
  const entry = item as Record<string, unknown>;
  if (
    Object.keys(entry).some(
      (key) => !["file_token", "tmp_download_url"].includes(key),
    ) ||
    entry.file_token !== expectedToken ||
    typeof entry.tmp_download_url !== "string" ||
    !entry.tmp_download_url
  )
    throw new Error("invalid_shape");
  return { fileToken: expectedToken, url: entry.tmp_download_url };
}
