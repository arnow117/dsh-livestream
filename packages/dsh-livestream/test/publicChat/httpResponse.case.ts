import { describe, expect, it } from 'vitest';
import { helperHttpResponse, isHttpResponseEvidence } from '../../src/publicChat/httpResponse';

describe('original HTTP response metadata', () => {
  it('retains only complete bounded joined response evidence', () => {
    expect(helperHttpResponse({ httpStatus: 0, responseLength: 0, responseDigest: '',
      writeAttempted: false, executionEnded: false })).toBeNull();
    const fields = { httpStatus: 302, responseLength: 17, responseDigest: 'a'.repeat(64),
      writeAttempted: true, executionEnded: true };
    expect(helperHttpResponse(fields)).toEqual({ version: 'dsh-public-chat-http-response-v1',
      status: 302, length: 17, digest: 'a'.repeat(64) });
    for (const invalid of [
      { ...fields, executionEnded: false }, { ...fields, writeAttempted: false },
      { ...fields, responseLength: 1_048_577 }, { ...fields, responseDigest: '' },
      { ...fields, httpStatus: 0 }, { ...fields, httpStatus: 101 },
    ]) expect(helperHttpResponse(invalid)).toBeUndefined();
    expect(isHttpResponseEvidence({ version: 'dsh-public-chat-http-response-v1', status: 200,
      length: 1, digest: 'a'.repeat(64), receipt: true })).toBe(false);
  });
});
