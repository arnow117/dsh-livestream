import { isIP } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { QueryRequest, QueryResult, QuerySource } from '../shared/readOnlyQuery';
import { isSupportedWeatherLocation } from './weather';
export { isSupportedWeatherLocation } from './weather';

const MAX_BYTES = 1024 * 1024;
const MAX_ROWS = 32;
const MAX_SOURCES = 3;
const MAX_EXCERPT = 2000;

function boundedText(value: string, max: number): string {
  const chars = [...value];
  return chars.length > max ? `${chars.slice(0, max).join('')}…（截断）` : value;
}

interface SearchRow {
  title: string;
  link: string;
  content: string;
  refer?: string;
}

function publicUrl(value: string): URL | null {
  try {
    if (value.length > 2048) return null;
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    // Literal IPs are intentionally excluded: a hostname is enough for source display,
    // and this avoids accidentally accepting reserved, mapped or alternate IP forms.
    if (isIP(host) || !host.includes('.') || host === 'localhost' || host.endsWith('.localhost')
      || ['example.com', 'example.org', 'example.net'].includes(host)
      || ['.local', '.internal', '.localhost', '.invalid', '.test', '.example', '.onion', '.home.arpa'].some((suffix) => host.endsWith(suffix))) return null;
    return url;
  } catch {
    return null;
  }
}

function decodeRows(response: unknown): SearchRow[] | null {
  if (!response || typeof response !== 'object') return null;
  const envelope = response as { content?: unknown; structuredContent?: unknown };
  let value: unknown;
  if (envelope.structuredContent !== undefined) {
    value = envelope.structuredContent;
    try {
      if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_BYTES) return null;
    } catch {
      return null;
    }
  } else {
    if (!Array.isArray(envelope.content) || !envelope.content.every((item) => item?.type === 'text' && typeof item.text === 'string')) return null;
    value = envelope.content.map((item) => item.text).join('\n');
    if (Buffer.byteLength(value as string, 'utf8') > MAX_BYTES) return null;
    const text = (value as string).trim();
    const looksJson = /^["{]/.test(text) || (text.startsWith('[') && !/^\[[^\]]+\]\(https?:\/\//.test(text));
    if (!looksJson) {
      const rows: SearchRow[] = [];
      const seen = new Set<string>();
      for (const match of text.matchAll(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g)) {
        rows.push({ title: match[1], link: match[2], content: text });
        seen.add(match[2]);
      }
      for (const match of text.matchAll(/https?:\/\/[^\s<>)\]]+/g)) {
        if (!seen.has(match[0])) rows.push({ title: '', link: match[0], content: text });
      }
      if (text && rows.length === 0) rows.push({ title: '', link: '', content: text });
      return rows.length <= MAX_ROWS ? rows : null;
    }
  }
  for (let depth = 0; depth < 2 && typeof value === 'string'; depth++) {
    if (Buffer.byteLength(value, 'utf8') > MAX_BYTES) return null;
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(value) || value.length > MAX_ROWS) return null;
  if (!value.every((row) => row && typeof row === 'object'
    && typeof row.title === 'string' && typeof row.link === 'string'
    && typeof row.content === 'string' && (row.refer === undefined || typeof row.refer === 'string'))) return null;
  return value as SearchRow[];
}

function relatesToQuestion(row: SearchRow, question: string): boolean {
  const text = `${row.title} ${row.content} ${row.link}`.toLowerCase();
  const words = question.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? [];
  const meaningful = words.filter((word) => !['the', 'what', 'license', 'licence', 'version', 'for', 'and'].includes(word));
  if (meaningful.length) return meaningful.some((word) => text.includes(word));
  const segments = new Intl.Segmenter('zh', { granularity: 'word' }).segment(question);
  const subject = [...segments]
    .filter((segment) => segment.isWordLike && /^[\u4e00-\u9fff]{2,}$/.test(segment.segment))
    .map((segment) => segment.segment)
    .find((word) => !['请问', '查询', '搜索', '关于', '什么', '如何', '多少', '哪些'].includes(word));
  return !!subject && text.includes(subject);
}

/** Converts the observed MCP text profile to evidence; it never fetches source URLs. */
export function parseSearchResponse(response: unknown, request: QueryRequest, retrievedAt: string): QueryResult {
  const rows = decodeRows(response);
  const result: QueryResult = { kind: request.kind, status: 'unsupported_response', evidenceText: '', sources: [] };
  if (request.kind !== 'public_search' || !rows) return result;
  if (!rows.length) return { ...result, status: 'empty' };

  const excerpts: string[] = [];
  const sources: QuerySource[] = [];
  const terms = (request.query.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? [])
    .filter((word) => !['the', 'what', 'license', 'licence', 'version', 'for', 'and'].includes(word));
  const candidates = [...rows].sort((left, right) => {
    const score = (row: SearchRow) => terms.filter((term) => row.link.toLowerCase().includes(term)).length;
    return score(right) - score(left);
  });
  for (const row of candidates) {
    const url = publicUrl(row.link);
    if (!url || !relatesToQuestion(row, request.query) || sources.length >= MAX_SOURCES) continue;
    sources.push({
      name: url.hostname,
      title: row.title ? boundedText(row.title, 500) : null,
      url: url.href,
      retrievedAt,
      providerTime: { kind: 'unknown', value: null, verbatim: null },
    });
    const title = boundedText(row.title, 500);
    const excerpt = boundedText(row.content, MAX_EXCERPT);
    excerpts.push(`${title}\n${excerpt}`);
  }
  if (!sources.length) return { ...result, status: 'limited', limitation: '没有可核对的来源。' };
  return { ...result, status: 'evidence', sources, evidenceText: excerpts.join('\n\n') };
}

const ENDPOINT = 'https://open.bigmodel.cn/api/mcp/web_search_prime/mcp';
const REMOTE_TOOL = 'web_search_prime';
const SEARCH_PROPERTIES = ['search_query', 'search_domain_filter', 'search_recency_filter', 'content_size', 'location'];
let searchActive = false;

function compatibleSchema(schema: unknown): boolean {
  if (!schema || typeof schema !== 'object') return false;
  const input = schema as Record<string, any>;
  if (input.type !== 'object' || input.additionalProperties !== false
    || !Array.isArray(input.required) || input.required.length !== 1 || input.required[0] !== 'search_query'
    || !input.properties || typeof input.properties !== 'object') return false;
  const names = Object.keys(input.properties);
  return names.length === SEARCH_PROPERTIES.length
    && SEARCH_PROPERTIES.every((name) => input.properties[name]?.type === 'string');
}

function validRequest(request: QueryRequest): boolean {
  const text = request.kind === 'weather' ? request.location : request.query;
  const limit = request.kind === 'weather' ? 40 : 70;
  if (typeof text !== 'string' || !text.trim() || [...text].length > limit
    || /(?:https?:\/\/|www\.)/i.test(text)) return false;
  if (request.kind === 'weather' && !isSupportedWeatherLocation(request.location)) return false;
  if (request.kind === 'weather' && request.date !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(request.date)) return false;
    const date = new Date(`${request.date}T00:00:00Z`);
    if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== request.date) return false;
  }
  return true;
}

/** Fixed-endpoint MCP client. The injectable fetch is for isolated protocol tests. */
export async function runReadOnlyQuery(
  request: QueryRequest,
  credential: string,
  callerSignal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
  weatherSource?: { query(request: Extract<QueryRequest, { kind: 'weather' }>, signal: AbortSignal): Promise<QueryResult> },
): Promise<QueryResult> {
  const initial: QueryResult = { kind: request.kind, status: 'failed', evidenceText: '', sources: [] };
  if (callerSignal.aborted) return { ...initial, status: 'cancelled' };
  if (!validRequest(request)) return { ...initial, status: 'needs_clarification' };
  if (!credential.trim()) return { ...initial, status: 'unavailable' };
  if (searchActive) return { ...initial, status: 'busy' };
  searchActive = true;

  const timeout = AbortSignal.timeout(15_000);
  const signal = AbortSignal.any([callerSignal, timeout]);
  if (request.kind === 'weather') {
    if (!weatherSource) {
      searchActive = false;
      return { ...initial, status: 'unavailable' };
    }
    const work = Promise.resolve().then(() => weatherSource.query(request, signal)).finally(() => { searchActive = false; });
    let removeAbort = () => {};
    const aborted = new Promise<QueryResult>((resolve) => {
      const finish = () => resolve({ ...initial, status: callerSignal.aborted ? 'cancelled' : 'timeout' });
      signal.addEventListener('abort', finish, { once: true });
      removeAbort = () => signal.removeEventListener('abort', finish);
      if (signal.aborted) finish();
    });
    try {
      return await Promise.race([work, aborted]);
    } catch {
      return { ...initial, status: callerSignal.aborted ? 'cancelled' : timeout.aborted ? 'timeout' : 'failed' };
    } finally {
      removeAbort();
    }
  }
  const client = new Client({ name: 'dsh-livestream', version: '0.0.1' });
  let pendingFetches = 0;
  let finished = false;
  const safeFetch: typeof fetch = async (input, init) => {
    if (String(input) !== ENDPOINT) throw new Error('Unexpected MCP destination');
    pendingFetches++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      pendingFetches--;
      if (finished && pendingFetches === 0) searchActive = false;
    };
    try {
      const response = await fetchImpl(input, { ...init, redirect: 'error', signal });
      const length = Number(response.headers.get('content-length'));
      if (length > MAX_BYTES) throw new Error('MCP response too large');
      if (!response.body) {
        release();
        return response;
      }
      let bytes = 0;
      const reader = response.body.getReader();
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const chunk = await reader.read();
            if (chunk.done) {
              release();
              controller.close();
              return;
            }
            bytes += chunk.value.byteLength;
            if (bytes > MAX_BYTES) {
              await reader.cancel();
              release();
              controller.error(new Error('MCP response too large'));
              return;
            }
            controller.enqueue(chunk.value);
          } catch (error) {
            release();
            controller.error(error);
          }
        },
        async cancel() {
          try { await reader.cancel(); } finally { release(); }
        },
      });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) {
      release();
      throw error;
    }
  };
  const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
    requestInit: { headers: { Authorization: `Bearer ${credential}` } },
    fetch: safeFetch,
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
  });

  try {
    await client.connect(transport, { signal, timeout: 15_000 });
    const listing = await client.listTools(undefined, { cacheMode: 'refresh', signal });
    const matches = listing.tools.filter((tool) => tool.name === REMOTE_TOOL);
    if (matches.length !== 1 || !compatibleSchema(matches[0].inputSchema)) return { ...initial, status: 'unsupported_response' };
    const arguments_ = {
      search_query: request.query,
      content_size: 'medium',
      location: 'cn',
      search_recency_filter: 'noLimit',
    };
    const response = await client.callTool({ name: REMOTE_TOOL, arguments: arguments_ }, { signal, timeout: 15_000, toolDefinition: matches[0] });
    if (signal.aborted) return { ...initial, status: callerSignal.aborted ? 'cancelled' : 'timeout' };
    if (response.isError) return initial;
    return parseSearchResponse(response, request, new Date().toISOString());
  } catch {
    return { ...initial, status: callerSignal.aborted ? 'cancelled' : timeout.aborted ? 'timeout' : 'failed' };
  } finally {
    finished = true;
    if (pendingFetches === 0) searchActive = false;
    await client.close().catch(() => {});
  }
}
