import { hexDigest64, isObject, safeInteger } from './protocol';

/** Complete bounded HTTP response metadata, never a platform delivery receipt. */
export interface HttpResponseEvidence {
  version: 'dsh-public-chat-http-response-v1';
  status: number;
  length: number;
  digest: string;
}

export function isHttpResponseEvidence(value: unknown): value is HttpResponseEvidence {
  if (!isObject(value) || Object.keys(value).sort().join(',') !== 'digest,length,status,version') return false;
  return value.version === 'dsh-public-chat-http-response-v1' && safeInteger(value.status) &&
    value.status >= 200 && value.status <= 999 && safeInteger(value.length) && value.length <= (1 << 20) && hexDigest64(value.digest);
}

/** Decode the original helper's complete response fields; undefined means a conflicting record. */
export function helperHttpResponse(fields: Record<string, unknown>): HttpResponseEvidence | null | undefined {
  if (fields.httpStatus === 0 && fields.responseLength === 0 && fields.responseDigest === '') return null;
  const result = { version: 'dsh-public-chat-http-response-v1' as const,
    status: fields.httpStatus, length: fields.responseLength, digest: fields.responseDigest };
  return isHttpResponseEvidence(result) && fields.writeAttempted === true && fields.executionEnded === true ? result : undefined;
}
