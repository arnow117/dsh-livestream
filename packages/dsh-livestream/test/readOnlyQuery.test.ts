import { describe, expect, it, vi } from 'vitest';
import { parseSearchResponse } from '../src/body/readOnlyQuery';

const row = {
  title: 'OBS Studio',
  link: 'https://github.com/obsproject/obs-studio',
  content: 'OBS Studio is licensed under GPL version 2 or later.',
  refer: 'ref_1',
};

function response(value: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(JSON.stringify(value)) }] };
}

describe('read-only search evidence', () => {
  it('finds a Chinese subject without requiring the question to be repeated verbatim', () => {
    const query = { kind: 'public_search', query: '天安门始建于哪年' } as const;
    const relevant = [{ title: '天安门历史', link: 'https://www.gov.cn/history', content: '天安门始建于明永乐十五年（1417年）。' }];
    const unrelated = [{ title: '故宫历史', link: 'https://www.gov.cn/history', content: '故宫是明清皇宫。' }];
    expect(parseSearchResponse(response(relevant), query, '').status).toBe('evidence');
    expect(parseSearchResponse(response(unrelated), query, '').status).toBe('limited');
  });

  it('deduplicates equivalent weather observations but rejects conflicts', () => {
    const query = { kind: 'weather', location: '北京' } as const;
    const item = { title: '北京天气', link: 'https://weather.com.cn/beijing', content: '北京当前天气实况：2026-11-10 08:00 UTC+00:00 气温 20℃' };
    const duplicate = { ...item, link: 'https://weather.com.cn/beijing/duplicate', content: '北京当前天气实况：2026-11-10 16:00 UTC+08:00 气温 20°C' };
    const conflict = { ...duplicate, content: '北京当前天气实况：2026-11-10 16:00 UTC+08:00 气温 21℃' };
    expect(parseSearchResponse(response([item, duplicate]), query, '2026-11-10T08:10:00Z').status).toBe('evidence');
    expect(parseSearchResponse(response([item, conflict]), query, '2026-11-10T08:10:00Z').status).toBe('limited');
  });

  it('unwraps the observed double-encoded profile without treating refer as time', () => {
    const result = parseSearchResponse(response([row]), { kind: 'public_search', query: 'OBS Studio license' }, '2026-11-10T00:00:00.000Z');
    expect(result.status).toBe('evidence');
    expect(result.sources).toEqual([expect.objectContaining({
      title: row.title,
      url: row.link,
      providerTime: { kind: 'unknown', value: null, verbatim: null },
    })]);
    expect(result.evidenceText).toContain(row.content);
  });

  it('accepts the observed nine-row double-encoded shape while bounding shown sources', () => {
    const rows = Array.from({ length: 9 }, (_, index) => ({
      ...row,
      link: `https://github.com/obsproject/obs-studio/issues/${index}`,
      refer: `ref_${index + 1}`,
    }));
    const result = parseSearchResponse(response(rows), { kind: 'public_search', query: 'OBS Studio license' }, '2026-11-10T00:00:00Z');
    expect(result.status).toBe('evidence');
    expect(result.sources).toHaveLength(3);
    expect(result.sources.every((source) => source.providerTime.kind === 'unknown')).toBe(true);
    expect(result.evidenceText).toContain(row.content);
  });

  it('rejects an extra encoded layer and invalid rows', () => {
    const triple = { content: [{ type: 'text', text: JSON.stringify(JSON.stringify(JSON.stringify([row]))) }] };
    expect(parseSearchResponse(triple, { kind: 'public_search', query: 'OBS' }, '').status).toBe('unsupported_response');
    expect(parseSearchResponse(response([{ ...row, content: 4 }]), { kind: 'public_search', query: 'OBS' }, '').status).toBe('unsupported_response');
  });

  it('does not report stale or other-city weather as current conditions', () => {
    const weather = [
      { title: '鸡西天气', link: 'https://weather.com.cn/jixi', content: '鸡西今天气温 5℃' },
      { title: '北京昨日天气', link: 'https://weather.com.cn/beijing', content: '2026-11-09 北京今天气温 3℃' },
    ];
    const result = parseSearchResponse(response(weather), { kind: 'weather', location: '北京' }, '2026-11-10T00:00:00.000Z');
    expect(result.status).toBe('limited');
    expect(result.evidenceText).not.toContain('5℃');
    expect(result.evidenceText).not.toContain('3℃');
  });

  it('does not use private or loopback links as evidence', () => {
    const result = parseSearchResponse(response([{ ...row, link: 'http://127.0.0.1/private' }]), { kind: 'public_search', query: 'OBS' }, '');
    expect(result.status).toBe('limited');
    expect(result.sources).toEqual([]);
  });
});

describe('fixed MCP executor', () => {
  it('uses the fixed tool and weather arguments through the SDK', async () => {
    const { runReadOnlyQuery } = await import('../src/body/readOnlyQuery');
    const calls: Array<{ url: string; method: string; body?: any; redirect?: RequestRedirect }> = [];
    const schema = {
      type: 'object',
      properties: Object.fromEntries(['search_query', 'search_domain_filter', 'search_recency_filter', 'content_size', 'location'].map((key) => [key, { type: 'string' }])),
      required: ['search_query'],
      additionalProperties: false,
    };
    const fakeFetch: typeof fetch = async (input, init) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ url: String(input), method: init?.method ?? 'GET', body, redirect: init?.redirect });
      if (!body?.id && body?.id !== 0) return new Response(null, { status: 202 });
      const result = body.method === 'initialize'
        ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
        : body.method === 'tools/list'
          ? { tools: [{ name: 'web_search_prime', inputSchema: schema }] }
          : response([{ title: '北京', link: 'https://weather.com.cn/beijing', content: '北京天气' }]);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { headers: { 'content-type': 'application/json' } });
    };
    const result = await runReadOnlyQuery({ kind: 'weather', location: '北京' }, 'fake-key', new AbortController().signal, fakeFetch);
    expect(result.status).toBe('limited');
    expect(calls.every((call) => call.url === 'https://open.bigmodel.cn/api/mcp/web_search_prime/mcp' && call.redirect === 'error')).toBe(true);
    const searches = calls.filter((call) => call.body?.method === 'tools/call');
    expect(searches).toHaveLength(1);
    expect(searches[0].body.params).toEqual({ name: 'web_search_prime', arguments: {
      search_query: '北京 当前天气实况 更新时间', content_size: 'medium', location: 'cn',
      search_recency_filter: 'oneDay', search_domain_filter: 'weather.com.cn',
    } });
  });
});

it('returns cancellation even if the transport ignores abort, and does not start a concurrent search', async () => {
  const { runReadOnlyQuery } = await import('../src/body/readOnlyQuery');
  let release!: (response: Response) => void;
  const stalledFetch: typeof fetch = () => new Promise((resolve) => { release = resolve; });
  const abort = new AbortController();
  const pending = runReadOnlyQuery({ kind: 'public_search', query: 'OBS' }, 'fake', abort.signal, stalledFetch);
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  expect((await runReadOnlyQuery({ kind: 'public_search', query: 'OBS' }, 'fake', new AbortController().signal, stalledFetch)).status).toBe('busy');
  abort.abort();
  expect((await pending).status).toBe('cancelled');
  expect((await runReadOnlyQuery({ kind: 'public_search', query: 'OBS' }, 'fake', new AbortController().signal, stalledFetch)).status).toBe('busy');
  release(new Response(null, { status: 500 }));
});

describe('query settings', () => {
  it('defaults closed and validates partial boolean updates', async () => {
    const { mergeQuerySettings } = await import('../src/shared/readOnlyQuery');
    expect(mergeQuerySettings(undefined, {})).toEqual({ weather: false, publicSearch: false });
    expect(mergeQuerySettings({ weather: true, publicSearch: false }, { publicSearch: true })).toEqual({ weather: true, publicSearch: true });
    expect(() => mergeQuerySettings(undefined, { weather: 'true' })).toThrow();
    expect(() => mergeQuerySettings(undefined, { url: 'https://example.com' })).toThrow();
  });
});

it('rejects oversized, malformed or URL-bearing requests before starting the transport', async () => {
  const { runReadOnlyQuery } = await import('../src/body/readOnlyQuery');
  const network = vi.fn();
  for (const request of [
    { kind: 'public_search', query: 'https://example.com' },
    { kind: 'public_search', query: 'x'.repeat(71) },
    { kind: 'weather', location: '', date: '2026-02-30' },
  ] as const) {
    const result = await runReadOnlyQuery(request, 'fake', new AbortController().signal, network);
    expect(result.status).toBe('needs_clarification');
  }
  expect(network).not.toHaveBeenCalled();
});

it('asks for administrative context before contacting the provider', async () => {
  const { isSupportedWeatherLocation, runReadOnlyQuery } = await import('../src/body/readOnlyQuery');
  for (const location of ['朝阳', '杭州市', '朝阳区', '巴黎', '不存在的城市']) {
    expect(isSupportedWeatherLocation(location)).toBe(false);
    const network = vi.fn();
    const result = await runReadOnlyQuery({ kind: 'weather', location }, 'fake', new AbortController().signal, network);
    expect(result.status).toBe('needs_clarification');
    expect(network).not.toHaveBeenCalled();
  }
  for (const location of ['北京', '北京市朝阳区', '重庆市渝中区', '辽宁省朝阳市', '浙江省杭州市']) {
    expect(isSupportedWeatherLocation(location)).toBe(true);
  }
  expect(parseSearchResponse(response([]), { kind: 'weather', location: '辽宁省朝阳市' }, '').status).toBe('empty');
});

it('never falls back to an environment credential when the credential service exists', async () => {
  const { resolveQueryCredential } = await import('../src/dsh/queryCredential');
  expect(await resolveQueryCredential(undefined, 'env-key')).toEqual({ status: 'configured', value: 'env-key' });
  expect(await resolveQueryCredential({ resolve: async () => undefined }, 'env-key')).toEqual({ status: 'unconfigured' });
  expect(await resolveQueryCredential({ resolve: async () => { throw new Error('secret'); } }, 'env-key')).toEqual({ status: 'error' });
  expect(await resolveQueryCredential({ resolve: async () => ({ value: '  service-key  ' }) }, 'env-key')).toEqual({ status: 'configured', value: 'service-key' });
});

it('reports explicit matching weather evidence with its source time and distinguishes a forecast', () => {
  const current = response([{ title: '北京天气实况', link: 'https://weather.com.cn/beijing', content: '北京当前天气实况：2026-11-10 16:00 UTC+08:00 气温 12℃' }]);
  const observed = parseSearchResponse(current, { kind: 'weather', location: '北京' }, '2026-11-10T08:10:00.000Z');
  expect(observed.status).toBe('evidence');
  expect(observed.evidenceText).toContain('气温 12℃');
  expect(observed.sources[0].providerTime).toEqual({ kind: 'observed', value: '2026-11-10T08:00:00.000Z', verbatim: '2026-11-10 16:00 UTC+08:00' });
  const forecast = response([{ title: '北京天气预报', link: 'https://weather.com.cn/beijing', content: '北京 2026-11-12 天气预报：多云' }]);
  expect(parseSearchResponse(forecast, { kind: 'weather', location: '北京', date: '2026-11-12' }, '2026-11-10T08:10:00.000Z')).toMatchObject({ status: 'evidence', evidenceText: expect.stringContaining('多云'), sources: [{ providerTime: { kind: 'forecast', value: '2026-11-12', verbatim: '2026-11-12' } }] });
  expect(parseSearchResponse(forecast, { kind: 'weather', location: '北京', date: '2026-11-13' }, '2026-11-10T08:10:00.000Z').status).toBe('limited');
});

it('parses standard plain text and rejects unrelated or overlarge profiles', () => {
  const query = { kind: 'public_search', query: 'OBS Studio license' } as const;
  const plain = { content: [{ type: 'text', text: 'OBS Studio license: [Official repository](https://github.com/obsproject/obs-studio)' }] };
  expect(parseSearchResponse(plain, query, '2026-11-10T00:00:00Z')).toMatchObject({ status: 'evidence', sources: [{ title: 'Official repository' }] });
  const structured = { structuredContent: [row], content: [] };
  expect(parseSearchResponse(structured, query, '2026-11-10T00:00:00Z').status).toBe('evidence');
  expect(parseSearchResponse(response([{ ...row, title: 'Unrelated', content: 'Different topic', link: 'https://example.org/' }]), query, '').status).toBe('limited');
  expect(parseSearchResponse(response(Array(33).fill(row)), query, '').status).toBe('unsupported_response');
  expect(parseSearchResponse({ content: [{ type: 'text', text: 'x'.repeat(1024 * 1024 + 1) }] }, query, '').status).toBe('unsupported_response');
});

it('does not attribute another city or extra text in a weather excerpt to the requested city', () => {
  const mixed = response([{ title: '北京天气', link: 'https://weather.com.cn/beijing', content: '北京当前天气实况：2026-11-10 16:00 UTC+08:00 气温 12℃，鸡西气温 5℃' }]);
  const result = parseSearchResponse(mixed, { kind: 'weather', location: '北京' }, '2026-11-10T08:10:00.000Z');
  expect(result.status).toBe('limited');
  expect(result.evidenceText).not.toContain('5℃');
});

it('considers all candidates and prefers a source whose host or path identifies the subject', () => {
  const rows = [
    { title: 'OBS Studio', link: 'https://news-one.org/story', content: 'OBS Studio license summary' },
    { title: 'OBS Studio', link: 'https://news-two.org/story', content: 'OBS Studio license summary' },
    { title: 'OBS Studio', link: 'https://news-three.org/story', content: 'OBS Studio license summary' },
    row,
  ];
  const result = parseSearchResponse(response(rows), { kind: 'public_search', query: 'OBS Studio license' }, '');
  expect(result.sources).toHaveLength(3);
  expect(result.sources[0].url).toBe(row.link);
});

it('bounds long source titles and excerpts and marks truncation', () => {
  const result = parseSearchResponse(response([{ ...row, title: `OBS ${'a'.repeat(20000)}`, content: `OBS ${'b'.repeat(10000)}` }]), { kind: 'public_search', query: 'OBS Studio license' }, '');
  expect(result.status).toBe('evidence');
  expect(result.evidenceText.length).toBeLessThanOrEqual(12000);
  expect(result.evidenceText).toContain('截断');
  expect(result.sources[0].title!.length).toBeLessThanOrEqual(520);
});

it('keeps the single-search limit while an aborted response body is still being read', async () => {
  const { runReadOnlyQuery } = await import('../src/body/readOnlyQuery');
  let releaseBody!: () => void;
  const schema = { type: 'object', properties: Object.fromEntries(['search_query', 'search_domain_filter', 'search_recency_filter', 'content_size', 'location'].map((key) => [key, { type: 'string' }])), required: ['search_query'], additionalProperties: false };
  const stalled: typeof fetch = async (_input, init) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    if (body?.id === undefined) return new Response(null, { status: 202 });
    if (body.method === 'tools/call') {
      const stream = new ReadableStream({ start(controller) { releaseBody = () => controller.close(); } });
      return new Response(stream, { headers: { 'content-type': 'application/json' } });
    }
    const result = body.method === 'initialize'
      ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
      : { tools: [{ name: 'web_search_prime', inputSchema: schema }] };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { headers: { 'content-type': 'application/json' } });
  };
  const controller = new AbortController();
  const pending = runReadOnlyQuery({ kind: 'public_search', query: 'OBS Studio' }, 'fake', controller.signal, stalled);
  await vi.waitFor(() => expect(releaseBody).toBeTypeOf('function'));
  controller.abort();
  const outcome = await Promise.race([pending, new Promise<'stalled'>((resolve) => setTimeout(() => resolve('stalled'), 250))]);
  expect(outcome).not.toBe('stalled');
  expect((outcome as any).status).toBe('cancelled');
  expect((await runReadOnlyQuery({ kind: 'public_search', query: 'OBS Studio' }, 'fake', new AbortController().signal, stalled)).status).toBe('busy');
  releaseBody();
});

it('enforces the total 15-second deadline even when the transport ignores abort', async () => {
  const { runReadOnlyQuery } = await import('../src/body/readOnlyQuery');
  let release!: (response: Response) => void;
  const stalled: typeof fetch = () => new Promise((resolve) => { release = resolve; });
  const started = Date.now();
  const result = await runReadOnlyQuery({ kind: 'public_search', query: 'OBS Studio' }, 'fake', new AbortController().signal, stalled);
  expect(result.status).toBe('timeout');
  expect(Date.now() - started).toBeGreaterThanOrEqual(14_500);
  expect(Date.now() - started).toBeLessThan(17_000);
  release(new Response(null, { status: 500 }));
}, 20_000);
