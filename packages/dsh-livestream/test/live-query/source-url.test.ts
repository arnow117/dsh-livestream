import { expect, it } from 'vitest';
import { sanitizeSourceUrl } from './source-url';

it('preserves public nested redirect targets and safe query parameters without fetching them', () => {
  const target = 'https://github.com/obsproject/obs-studio?tab=readme#license';
  const outer = new URL('https://www.google.com/goto');
  outer.searchParams.set('url', target);
  const result = sanitizeSourceUrl(outer.href, ['private-key']);
  expect(result.independentlyVerifiable).toBe(true);
  expect(new URL(result.url!).searchParams.get('url')).toBe(target);
});

it('removes credential fields and known secrets, including inside nested targets', () => {
  const target = 'https://github.com/obsproject/obs-studio?tab=readme&token=private-key#license';
  const outer = new URL('https://www.google.com/goto');
  outer.searchParams.set('url', target);
  outer.searchParams.set('api_key', 'private-key');
  const result = sanitizeSourceUrl(outer.href, ['private-key']);
  expect(result.independentlyVerifiable).toBe(false);
  expect(result.url).not.toContain('private-key');
  expect(result.url).not.toContain('api_key');
  expect(new URL(new URL(result.url!).searchParams.get('url')!).pathname).toBe('/obsproject/obs-studio');
  expect(new URL(new URL(result.url!).searchParams.get('url')!).searchParams.has('token')).toBe(false);
});

it('marks a URL with embedded credentials or excessive nesting unverifiable', () => {
  expect(sanitizeSourceUrl('https://user:password@example.org/path', []).url).toBeNull();
  let value = 'https://github.com/obsproject/obs-studio';
  for (let index = 0; index < 5; index++) {
    const url = new URL('https://www.google.com/goto');
    url.searchParams.set('url', value);
    value = url.href;
  }
  expect(sanitizeSourceUrl(value, []).independentlyVerifiable).toBe(false);
});

it('removes credential parameters from multiply encoded nested URLs even when the credential is unknown', () => {
  const target = 'https://github.com/obsproject/obs-studio?access_token=unregistered-token&tab=readme';
  const outer = new URL('https://www.google.com/goto');
  outer.searchParams.set('url', encodeURIComponent(target));
  const result = sanitizeSourceUrl(outer.href, []);
  expect(result.independentlyVerifiable).toBe(false);
  expect(result.url).not.toContain('unregistered-token');
  const nested = new URL(new URL(result.url!).searchParams.get('url')!);
  expect(nested.searchParams.has('access_token')).toBe(false);
  expect(nested.searchParams.get('tab')).toBe('readme');
});
