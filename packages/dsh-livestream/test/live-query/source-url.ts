const SECRET_PARAMETER = /token|secret|key|auth|signature|credential|password|cookie|session|^sig$|^code$/i;
const MAX_URL_LENGTH = 2048;
const MAX_NESTING = 3;

export function sanitizeSourceUrl(value: string, secrets: string[]) {
  const knownSecrets = secrets.filter(Boolean);
  const containsSecret = (text: string) => {
    let decoded = text;
    for (let depth = 0; depth <= MAX_NESTING; depth++) {
      if (knownSecrets.some((secret) => decoded.includes(secret))) return true;
      try {
        const next = decodeURIComponent(decoded);
        if (next === decoded) break;
        decoded = next;
      } catch {
        break;
      }
    }
    return false;
  };

  function sanitize(input: string, depth: number): { url: string | null; independentlyVerifiable: boolean } {
    if (depth > MAX_NESTING || input.length > MAX_URL_LENGTH) {
      return { url: null, independentlyVerifiable: false };
    }
    let url: URL;
    try { url = new URL(input); } catch { return { url: null, independentlyVerifiable: false }; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || containsSecret(url.hostname) || containsSecret(url.pathname)) {
      return { url: null, independentlyVerifiable: false };
    }
    let independentlyVerifiable = true;
    const params = new URLSearchParams();
    for (const [name, item] of url.searchParams) {
      if (SECRET_PARAMETER.test(name) || containsSecret(name)) {
        independentlyVerifiable = false;
        continue;
      }
      let nestedValue = item;
      if (/^https?(?::|%3a|%25)/i.test(item)) {
        for (let index = 0; index < MAX_NESTING && !/^https?:\/\//i.test(nestedValue); index++) {
          const decoded = decodeURIComponent(nestedValue);
          if (decoded === nestedValue) break;
          nestedValue = decoded;
        }
        if (!/^https?:\/\//i.test(nestedValue)) {
          independentlyVerifiable = false;
          continue;
        }
        const nested = sanitize(nestedValue, depth + 1);
        if (nested.url) params.append(name, nested.url);
        if (!nested.independentlyVerifiable) independentlyVerifiable = false;
      } else if (containsSecret(item)) {
        independentlyVerifiable = false;
      } else {
        params.append(name, item);
      }
    }
    url.search = params.toString();
    if (url.hash && (SECRET_PARAMETER.test(url.hash) || containsSecret(decodeURIComponent(url.hash)))) {
      url.hash = '';
      independentlyVerifiable = false;
    }
    if (url.href.length > MAX_URL_LENGTH) return { url: null, independentlyVerifiable: false };
    return { url: url.href, independentlyVerifiable };
  }

  try { return sanitize(value, 0); } catch { return { url: null, independentlyVerifiable: false }; }
}
