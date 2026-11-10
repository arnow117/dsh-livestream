import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createWeatherSource } from '../src/body/weather';

it('uses one verified region for a current station and a dated forecast', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-weather-test-'));
  const urls: string[] = [];
  const now = Date.parse('2026-11-11T04:00:00Z');
  const geo = [{
    name: '北京市', category: 'boundary', type: 'administrative',
    address: { city: '北京市', country_code: 'cn' },
    lat: '40.0', lon: '116.5', boundingbox: ['39', '41', '115', '118'],
    geojson: { type: 'Polygon', coordinates: [[[115, 39], [118, 39], [118, 41], [115, 41], [115, 39]]] },
  }];
  const stations = [
    { icaoId: 'ZBAA', name: 'Beijing Intl', lat: 40.1, lon: 116.6, temp: 0, obsTime: now / 1000 - 60, wdir: 'VRB' },
    { icaoId: 'ZBAD', name: 'Older', lat: 40.2, lon: 116.4, temp: 5, obsTime: now / 1000 - 3600 },
  ];
  const forecast = { properties: { meta: { updated_at: '2026-11-11T00:00:00Z', units: { air_temperature: 'celsius' } }, timeseries: [{ time: '2026-11-11T04:00:00Z', data: { instant: { details: { air_temperature: 8 } } } }] } };
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    urls.push(url.href);
    expect(init?.method).toBe('GET');
    expect(init?.redirect).toBe('error');
    const headers = new Headers(init?.headers);
    expect(headers.has('authorization')).toBe(false);
    expect(headers.has('cookie')).toBe(false);
    if (url.hostname === 'nominatim.openstreetmap.org') return Response.json(geo);
    if (url.hostname === 'aviationweather.gov') return Response.json(stations);
    if (url.hostname === 'api.met.no') return Response.json(forecast);
    throw new Error('unexpected fixture request');
  };
  try {
    const weather = createWeatherSource({ cacheFile: join(dir, 'weather-cache-v1.json'), fetchImpl: fakeFetch, now: () => now });
    const current = await weather.query({ kind: 'weather', location: '北京' }, new AbortController().signal);
    expect(current.status).toBe('evidence');
    expect(current.evidenceText).toContain('0℃');
    expect(current.sources.some((source) => source.providerTime.kind === 'observed')).toBe(true);
    const dated = await weather.query({ kind: 'weather', location: '北京', date: '2026-11-11' }, new AbortController().signal);
    expect(dated.status).toBe('evidence');
    expect(dated.evidenceText).toContain('8');
    expect(dated.sources.some((source) => source.providerTime.kind === 'forecast')).toBe(true);
    expect(urls).toHaveLength(3);
    expect(urls.filter((url) => url.includes('nominatim'))).toHaveLength(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it.each([
  {
    name: 'outside polygon', lat: '39.5', lon: '115.5',
    coordinates: [[[116, 40], [117, 40], [117, 41], [116, 41], [116, 40]]],
  },
  {
    name: 'inside a polygon hole', lat: '40.5', lon: '116.5',
    coordinates: [
      [[115, 39], [118, 39], [118, 41], [115, 41], [115, 39]],
      [[116, 40], [117, 40], [117, 41], [116, 41], [116, 40]],
    ],
  },
  {
    name: 'rounded onto boundary', lat: '40.000049', lon: '116.000049',
    coordinates: [[[116, 40], [117, 40], [117, 41], [116, 41], [116, 40]]],
  },
] as const)('does not query MET when the rounded center is $name', async ({ lat, lon, coordinates }) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-weather-pip-'));
  const urls: string[] = [];
  const fakeFetch: typeof fetch = async (input) => {
    const url = String(input);
    urls.push(url);
    if (!url.startsWith('https://nominatim.openstreetmap.org/')) throw new Error('unexpected forecast request');
    return Response.json([{
      name: '北京市', category: 'boundary', type: 'administrative',
      address: { city: '北京市', country_code: 'cn' }, lat, lon,
      boundingbox: ['39', '41', '115', '118'], geojson: { type: 'Polygon', coordinates },
    }]);
  };
  try {
    const weather = createWeatherSource({ cacheFile: join(dir, 'weather-cache-v1.json'), fetchImpl: fakeFetch });
    const result = await weather.query({ kind: 'weather', location: '北京', date: '2026-11-11' }, new AbortController().signal);
    expect(result.status).toBe('limited');
    expect(result.limitation).toContain('坐标');
    expect(urls).toHaveLength(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('reuses a 304-confirmed forecast for three hours without changing source data times', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-weather-304-'));
  let now = Date.parse('2026-11-11T04:00:00Z');
  const methods: string[] = [];
  const geo = [{
    name: '北京市', category: 'boundary', type: 'administrative',
    address: { city: '北京市', country_code: 'cn' },
    lat: '40.0', lon: '116.5', boundingbox: ['39', '41', '115', '118'],
    geojson: { type: 'Polygon', coordinates: [[[115, 39], [118, 39], [118, 41], [115, 41], [115, 39]]] },
  }];
  const forecast = { properties: { meta: { updated_at: '2026-11-11T00:00:00Z', units: { air_temperature: 'celsius' } }, timeseries: [{ time: '2026-11-11T04:00:00Z', data: { instant: { details: { air_temperature: 8 } } } }] } };
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    methods.push(url.hostname);
    if (url.hostname === 'nominatim.openstreetmap.org') return Response.json(geo);
    if (methods.filter((name) => name === 'api.met.no').length === 1) {
      return Response.json(forecast, { headers: { 'last-modified': 'Wed, 11 Nov 2026 00:00:00 GMT' } });
    }
    expect(new Headers(init?.headers).get('if-modified-since')).toBe('Wed, 11 Nov 2026 00:00:00 GMT');
    return new Response(null, { status: 304 });
  };
  try {
    const weather = createWeatherSource({ cacheFile: join(dir, 'weather-cache-v1.json'), fetchImpl: fakeFetch, now: () => now });
    const request = { kind: 'weather', location: '北京', date: '2026-11-11' } as const;
    const first = await weather.query(request, new AbortController().signal);
    now += 3 * 60 * 60 * 1000 + 1;
    const validated = await weather.query(request, new AbortController().signal);
    const again = await weather.query(request, new AbortController().signal);
    expect(first.status).toBe('evidence');
    expect(validated).toEqual(first);
    expect(again).toEqual(first);
    expect(methods).toEqual(['nominatim.openstreetmap.org', 'api.met.no', 'api.met.no']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('uses a one-hour negative cache for an unrecognized administrative location', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-weather-negative-'));
  let now = Date.parse('2026-11-11T04:00:00Z');
  let calls = 0;
  const fakeFetch: typeof fetch = async () => { calls++; return Response.json([]); };
  try {
    const weather = createWeatherSource({ cacheFile: join(dir, 'weather-cache-v1.json'), fetchImpl: fakeFetch, now: () => now });
    const request = { kind: 'weather', location: '北京' } as const;
    expect((await weather.query(request, new AbortController().signal)).status).toBe('needs_clarification');
    expect((await weather.query(request, new AbortController().signal)).status).toBe('needs_clarification');
    expect(calls).toBe(1);
    now += 60 * 60 * 1000 + 1;
    expect((await weather.query(request, new AbortController().signal)).status).toBe('needs_clarification');
    expect(calls).toBe(2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('does not commit an aborted geocoder response or launch a second source request', async () => {
  const { runReadOnlyQuery } = await import('../src/body/readOnlyQuery');
  const { access } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-weather-abort-'));
  const cacheFile = join(dir, 'weather-cache-v1.json');
  let release!: (response: Response) => void;
  let calls = 0;
  const fakeFetch: typeof fetch = () => { calls++; return new Promise((resolve) => { release = resolve; }); };
  try {
    const weather = createWeatherSource({ cacheFile, fetchImpl: fakeFetch });
    const controller = new AbortController();
    const pending = runReadOnlyQuery({ kind: 'weather', location: '北京' }, 'fake', controller.signal, fakeFetch, weather);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    controller.abort();
    expect((await pending).status).toBe('cancelled');
    expect((await runReadOnlyQuery({ kind: 'public_search', query: 'OBS' }, 'fake', new AbortController().signal, fakeFetch)).status).toBe('busy');
    release(Response.json([]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toBe(1);
    await expect(access(cacheFile)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it.each(['entry capacity', 'byte capacity'])('does not request an uncachable forecast when %s is exhausted', async (capacity) => {
  const { WeatherCache } = await import('../src/body/weatherCache');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-weather-capacity-'));
  const cacheFile = join(dir, 'weather-cache-v1.json');
  const now = Date.parse('2026-11-11T04:00:00Z');
  const signal = new AbortController().signal;
  const geoUrl = new URL('https://nominatim.openstreetmap.org/search');
  for (const [key, value] of Object.entries({ format: 'jsonv2', q: '北京', countrycodes: 'cn', addressdetails: '1', limit: '3', 'accept-language': 'zh-CN', polygon_geojson: '1' })) geoUrl.searchParams.set(key, value);
  const geo = [{
    name: '北京市', category: 'boundary', type: 'administrative',
    address: { city: '北京市', country_code: 'cn' }, lat: '40', lon: '116.5',
    boundingbox: ['39', '41', '115', '118'],
    geojson: { type: 'Polygon', coordinates: [[[115, 39], [118, 39], [118, 41], [115, 41], [115, 39]]] },
  }];
  let requests = 0;
  try {
    const cache = new WeatherCache(cacheFile, () => now);
    await cache.put('geo', { url: geoUrl.href, data: geo, retrievedAt: new Date(now).toISOString(), validUntil: now + 100_000 }, signal);
    const count = capacity === 'entry capacity' ? 8 : 3;
    for (let index = 0; index < count; index++) {
      const data = { properties: { meta: { updated_at: '2026-11-11T00:00:00Z', units: {} }, timeseries: [] }, padding: capacity === 'byte capacity' ? 'x'.repeat(1_048_000) : '' };
      await cache.put('forecast', { url: `https://api.met.no/other/${index}`, data, retrievedAt: new Date(now).toISOString(), validUntil: now + 100_000 }, signal);
    }
    const weather = createWeatherSource({ cacheFile, now: () => now, fetchImpl: async () => { requests++; return Response.json({}); } });
    const request = { kind: 'weather', location: '北京', date: '2026-11-11' } as const;
    expect((await weather.query(request, signal)).status).toBe('limited');
    expect((await weather.query(request, signal)).status).toBe('limited');
    expect(requests).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('selects the latest valid station inside the complete polygon and ignores holes and boundaries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-weather-stations-'));
  const now = Date.parse('2026-11-11T04:00:00Z');
  const geo = [{
    name: '北京市', category: 'boundary', type: 'administrative',
    address: { state: '北京市', country_code: 'cn' }, lat: '40', lon: '116',
    boundingbox: ['39', '41', '115', '118'],
    geojson: { type: 'Polygon', coordinates: [
      [[115, 39], [118, 39], [118, 41], [115, 41], [115, 39]],
      [[116.2, 40.2], [116.4, 40.2], [116.4, 40.4], [116.2, 40.4], [116.2, 40.2]],
    ] },
  }];
  const obs = now / 1000 - 60;
  const stations = [
    { icaoId: 'ZBAD', name: 'B station', lat: 40.1, lon: 116.6, temp: 9, obsTime: obs },
    { icaoId: 'ZBAA', name: 'A station', lat: 40.1, lon: 116.5, temp: 0, obsTime: obs, wdir: 'VRB' },
    { icaoId: 'ZBAA', name: 'A station', lat: 40.1, lon: 116.5, temp: -1, obsTime: obs - 3600 },
    { icaoId: 'ZHOL', name: 'Hole', lat: 40.3, lon: 116.3, temp: 77, obsTime: obs },
    { icaoId: 'ZBDY', name: 'Boundary', lat: 39, lon: 116, temp: 77, obsTime: obs },
    { icaoId: 'ZOUT', name: 'Outside', lat: 42, lon: 116, temp: 77, obsTime: obs },
    { icaoId: 'ZOLD', name: 'Old', lat: 40, lon: 116, temp: 77, obsTime: obs - 3 * 3600 },
  ];
  try {
    const weather = createWeatherSource({
      cacheFile: join(dir, 'weather-cache-v1.json'), now: () => now,
      fetchImpl: async (input) => new URL(String(input)).hostname === 'nominatim.openstreetmap.org' ? Response.json(geo) : Response.json(stations),
    });
    const result = await weather.query({ kind: 'weather', location: '北京' }, new AbortController().signal);
    expect(result.status).toBe('evidence');
    expect(result.evidenceText).toContain('ZBAA');
    expect(result.evidenceText).toContain('0℃');
    expect(result.evidenceText).not.toContain('77');
    expect(result.evidenceText).toContain('不代表全市或全区平均');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('returns limited for conflicting temperatures from the same station and instant', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-weather-conflict-'));
  const now = Date.parse('2026-11-11T04:00:00Z');
  const geo = [{
    name: '北京市', category: 'boundary', type: 'administrative', address: { city: '北京市', country_code: 'cn' },
    lat: '40', lon: '116', boundingbox: ['39', '41', '115', '118'],
    geojson: { type: 'Polygon', coordinates: [[[115, 39], [118, 39], [118, 41], [115, 41], [115, 39]]] },
  }];
  const observation = { icaoId: 'ZBAA', name: 'A station', lat: 40, lon: 116, temp: 0, obsTime: now / 1000 };
  try {
    const weather = createWeatherSource({
      cacheFile: join(dir, 'weather-cache-v1.json'), now: () => now,
      fetchImpl: async (input) => new URL(String(input)).hostname === 'nominatim.openstreetmap.org'
        ? Response.json(geo) : Response.json([observation, { ...observation, temp: 1 }]),
    });
    const result = await weather.query({ kind: 'weather', location: '北京' }, new AbortController().signal);
    expect(result.status).toBe('limited');
    expect(result.limitation).toContain('冲突');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('does not match a district merely because its parent city matches', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-weather-identity-'));
  let calls = 0;
  try {
    const weather = createWeatherSource({
      cacheFile: join(dir, 'weather-cache-v1.json'),
      fetchImpl: async () => {
        calls++;
        return Response.json([{ name: '朝阳区', category: 'boundary', type: 'administrative', address: { city: '北京市', country_code: 'cn' } }]);
      },
    });
    const result = await weather.query({ kind: 'weather', location: '北京' }, new AbortController().signal);
    expect(result.status).toBe('needs_clarification');
    expect(calls).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('holds the shared busy state while an aborted geocoder body ignores cancellation', async () => {
  const { runReadOnlyQuery } = await import('../src/body/readOnlyQuery');
  const { access } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-weather-body-abort-'));
  const cacheFile = join(dir, 'weather-cache-v1.json');
  let release!: () => void;
  let calls = 0;
  const fakeFetch: typeof fetch = async () => {
    calls++;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        return new Promise<void>((resolve) => {
          release = () => { controller.enqueue(new TextEncoder().encode('[]')); controller.close(); resolve(); };
        });
      },
    });
    return new Response(stream, { headers: { 'content-type': 'application/json' } });
  };
  try {
    const weather = createWeatherSource({ cacheFile, fetchImpl: fakeFetch });
    const controller = new AbortController();
    const pending = runReadOnlyQuery({ kind: 'weather', location: '北京' }, 'fake', controller.signal, fakeFetch, weather);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    controller.abort();
    expect((await pending).status).toBe('cancelled');
    expect((await runReadOnlyQuery({ kind: 'public_search', query: 'OBS' }, 'fake', new AbortController().signal, fakeFetch)).status).toBe('busy');
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toBe(1);
    await expect(access(cacheFile)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('rechecks observation age when reusing a still-fresh station response', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-weather-stale-'));
  let now = Date.parse('2026-11-11T04:00:00Z');
  let calls = 0;
  const geo = [{
    name: '北京市', category: 'boundary', type: 'administrative', address: { city: '北京市', country_code: 'cn' },
    lat: '40', lon: '116', boundingbox: ['39', '41', '115', '118'],
    geojson: { type: 'Polygon', coordinates: [[[115, 39], [118, 39], [118, 41], [115, 41], [115, 39]]] },
  }];
  const observation = { icaoId: 'ZBAA', name: 'A station', lat: 40, lon: 116, temp: 0, obsTime: (now - 2 * 60 * 60 * 1000 + 60_000) / 1000 };
  try {
    const weather = createWeatherSource({ cacheFile: join(dir, 'weather-cache-v1.json'), now: () => now, fetchImpl: async (input) => {
      calls++;
      return new URL(String(input)).hostname === 'nominatim.openstreetmap.org' ? Response.json(geo) : Response.json([observation]);
    } });
    const request = { kind: 'weather', location: '北京' } as const;
    expect((await weather.query(request, new AbortController().signal)).status).toBe('evidence');
    now += 120_000;
    expect((await weather.query(request, new AbortController().signal)).status).toBe('limited');
    expect(calls).toBe(2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it.each(['missing unit', 'missing date coverage', 'bad timestamp', '304 without cache'])('returns limited for %s without substituting another source', async (mode) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-weather-forecast-invalid-'));
  const calls: string[] = [];
  const geo = [{
    name: '北京市', category: 'boundary', type: 'administrative', address: { city: '北京市', country_code: 'cn' },
    lat: '40', lon: '116', boundingbox: ['39', '41', '115', '118'],
    geojson: { type: 'Polygon', coordinates: [[[115, 39], [118, 39], [118, 41], [115, 41], [115, 39]]] },
  }];
  try {
    const weather = createWeatherSource({ cacheFile: join(dir, 'weather-cache-v1.json'), fetchImpl: async (input) => {
      const host = new URL(String(input)).hostname;
      calls.push(host);
      if (host === 'nominatim.openstreetmap.org') return Response.json(geo);
      if (mode === '304 without cache') return new Response(null, { status: 304 });
      return Response.json({ properties: { meta: { updated_at: mode === 'bad timestamp' ? '2026-02-30T00:00:00Z' : '2026-11-11T00:00:00Z', units: mode === 'missing unit' ? {} : { air_temperature: 'celsius' } }, timeseries: [{ time: mode === 'missing date coverage' ? '2026-11-12T04:00:00Z' : '2026-11-11T04:00:00Z', data: { instant: { details: { air_temperature: 5 } } } }] } });
    } });
    const result = await weather.query({ kind: 'weather', location: '北京', date: '2026-11-11' }, new AbortController().signal);
    expect(result.status).toBe('limited');
    expect(calls).toEqual(['nominatim.openstreetmap.org', 'api.met.no']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it.each(['http://geo.example.com/search', 'https://127.0.0.1/search', 'https://localhost/search', 'https://geo.internal/search', 'https://user:password@geo.example.org/search', 'https://geo.example.org/search?token=secret'])('rejects invalid owner geocoder %s without a request', async (geocoderUrl) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-weather-geocoder-config-'));
  const fetchImpl = vi.fn();
  const codes: string[] = [];
  try {
    const weather = createWeatherSource({ cacheFile: join(dir, 'weather-cache-v1.json'), geocoderUrl, fetchImpl, onDiagnostic: (code) => codes.push(code) });
    expect((await weather.query({ kind: 'weather', location: '北京' }, new AbortController().signal)).status).toBe('limited');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(codes).toContain('geocoder_config_invalid');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('rejects malformed UTF-8 from the geocoder without retry or fallback', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-weather-utf8-'));
  const codes: string[] = [];
  const fetchImpl = vi.fn(async () => new Response(new Uint8Array([0xff])));
  try {
    const weather = createWeatherSource({ cacheFile: join(dir, 'weather-cache-v1.json'), fetchImpl, onDiagnostic: (code) => codes.push(code) });
    expect((await weather.query({ kind: 'weather', location: '北京' }, new AbortController().signal)).status).toBe('limited');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(codes).toContain('source_invalid_json');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('holds shared busy until the late response body finishes cancellation', async () => {
  const { runReadOnlyQuery } = await import('../src/body/readOnlyQuery');
  const { access } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-weather-late-response-'));
  const cacheFile = join(dir, 'weather-cache-v1.json');
  let resolveFetch!: (response: Response) => void;
  let releaseCancel: (() => void) | undefined;
  let calls = 0;
  const fakeFetch: typeof fetch = () => {
    calls++;
    return new Promise((resolve) => { resolveFetch = resolve; });
  };
  try {
    const weather = createWeatherSource({ cacheFile, fetchImpl: fakeFetch });
    const controller = new AbortController();
    const pending = runReadOnlyQuery({ kind: 'weather', location: '北京' }, 'fake', controller.signal, fakeFetch, weather);
    await vi.waitFor(() => expect(resolveFetch).toBeTypeOf('function'));
    controller.abort();
    expect((await pending).status).toBe('cancelled');
    const body = new ReadableStream<Uint8Array>({ cancel: () => new Promise<void>((resolve) => { releaseCancel = resolve; }) });
    resolveFetch(new Response(body));
    await vi.waitFor(() => expect(releaseCancel).toBeTypeOf('function'));
    expect((await runReadOnlyQuery({ kind: 'public_search', query: 'OBS' }, 'fake', new AbortController().signal, fakeFetch)).status).toBe('busy');
    releaseCancel!();
    await vi.waitFor(async () => {
      const result = await runReadOnlyQuery({ kind: 'public_search', query: 'OBS' }, 'fake', new AbortController().signal, async () => new Response(null, { status: 503 }));
      expect(result.status).not.toBe('busy');
    });
    expect(calls).toBe(1);
    await expect(access(cacheFile)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    releaseCancel?.();
    await rm(dir, { recursive: true, force: true });
  }
});

it.each(['http error', 'oversized header'])('cancels unread response bodies on %s', async (mode) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-weather-response-cleanup-'));
  let cancelled = false;
  const fakeFetch: typeof fetch = async () => new Response(new ReadableStream({
    cancel() { cancelled = true; },
  }), mode === 'http error' ? { status: 503 } : { headers: { 'content-length': String(1024 * 1024 + 1) } });
  try {
    const weather = createWeatherSource({ cacheFile: join(dir, 'weather-cache-v1.json'), fetchImpl: fakeFetch });
    expect((await weather.query({ kind: 'weather', location: '北京' }, new AbortController().signal)).status).toBe('limited');
    expect(cancelled).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it.each(['outside', 'hole', 'boundary'])('filters a bbox station in %s using the multipolygon', async (excluded) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-weather-multipolygon-'));
  const now = Date.parse('2026-11-11T04:00:00Z');
  const geo = [{
    name: '上海市', category: 'boundary', type: 'administrative', addresstype: 'state',
    address: { state: '上海市', country_code: 'cn' }, lat: '31', lon: '121',
    boundingbox: ['30', '33', '120', '123'],
    geojson: { type: 'MultiPolygon', coordinates: [
      [[[120, 30], [121, 30], [121, 31], [120, 31], [120, 30]]],
      [
        [[121, 31], [123, 31], [123, 33], [121, 33], [121, 31]],
        [[121.2, 31.2], [121.4, 31.2], [121.4, 31.4], [121.2, 31.4], [121.2, 31.2]],
      ],
    ] },
  }];
  const stamp = now / 1000 - 30;
  const station = (icaoId: string, lat: number, lon: number, obsTime = stamp) => ({ icaoId, name: icaoId, lat, lon, temp: 8, obsTime });
  const rows = [
    ...(excluded === 'outside' ? [station('ZA01', 30.5, 122.5, stamp + 10)] : []),
    ...(excluded === 'hole' ? [station('ZA02', 31.3, 121.3, stamp + 10)] : []),
    ...(excluded === 'boundary' ? [station('ZA03', 31, 122, stamp + 10)] : []),
    station('ZBBB', 31.5, 121.5),
    station('ZAAA', 30.5, 120.5),
    station('ZAAA', 30.5, 120.5),
  ];
  try {
    const weather = createWeatherSource({ cacheFile: join(dir, 'cache.json'), now: () => now, fetchImpl: async (input) =>
      new URL(String(input)).hostname === 'nominatim.openstreetmap.org' ? Response.json(geo) : Response.json(rows) });
    const result = await weather.query({ kind: 'weather', location: '上海' }, new AbortController().signal);
    expect(result.status).toBe('evidence');
    expect(result.evidenceText).toContain('ZAAA');
    expect(result.evidenceText).not.toContain('ZA01');
    expect(result.evidenceText).not.toContain('ZA02');
    expect(result.evidenceText).not.toContain('ZA03');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it.each(['expired', 'future', 'missing'])('rejects observations with %s observation time', async (mode) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-weather-time-'));
  const now = Date.parse('2026-11-11T04:00:00Z');
  const geo = [{ name: '北京市', category: 'boundary', type: 'administrative', address: { city: '北京市', country_code: 'cn' },
    lat: '40', lon: '116', boundingbox: ['39', '41', '115', '118'],
    geojson: { type: 'Polygon', coordinates: [[[115, 39], [118, 39], [118, 41], [115, 41], [115, 39]]] } }];
  const obsTime = mode === 'expired' ? now / 1000 - 7201 : mode === 'future' ? now / 1000 + 301 : undefined;
  try {
    const weather = createWeatherSource({ cacheFile: join(dir, 'cache.json'), now: () => now, fetchImpl: async (input) =>
      new URL(String(input)).hostname === 'nominatim.openstreetmap.org' ? Response.json(geo)
        : Response.json([{ icaoId: 'ZBAA', name: 'station', lat: 40, lon: 116, temp: 0, obsTime }]) });
    expect((await weather.query({ kind: 'weather', location: '北京' }, new AbortController().signal)).status).toBe('limited');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it.each(['wrong province', 'wrong leaf', 'ambiguous'])('rejects administrative identity with %s', async (mode) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-weather-identity-'));
  let calls = 0;
  const match = { name: '朝阳市', category: 'boundary', type: 'administrative', address: { state: '辽宁省', country_code: 'cn' } };
  const rows = mode === 'ambiguous' ? [match, match] : [{ ...match,
    name: mode === 'wrong leaf' ? '沈阳市' : match.name,
    address: { ...match.address, state: mode === 'wrong province' ? '吉林省' : match.address.state },
  }];
  try {
    const weather = createWeatherSource({ cacheFile: join(dir, 'cache.json'), fetchImpl: async () => { calls++; return Response.json(rows); } });
    expect((await weather.query({ kind: 'weather', location: '辽宁省朝阳市' }, new AbortController().signal)).status).toBe('needs_clarification');
    expect(calls).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('selects forecast points by Shanghai date across UTC midnight', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-weather-shanghai-date-'));
  const geo = [{ name: '北京市', category: 'boundary', type: 'administrative', address: { city: '北京市', country_code: 'cn' },
    lat: '40', lon: '116', boundingbox: ['39', '41', '115', '118'],
    geojson: { type: 'Polygon', coordinates: [[[115, 39], [118, 39], [118, 41], [115, 41], [115, 39]]] } }];
  const point = (time: string, temperature: number) => ({ time, data: { instant: { details: { air_temperature: temperature } } } });
  const forecast = { properties: { meta: { updated_at: '2026-11-10T12:00:00Z', units: { air_temperature: 'celsius' } }, timeseries: [
    point('2026-11-10T15:00:00Z', 1), point('2026-11-10T16:00:00Z', 2), point('2026-11-11T15:00:00Z', 3), point('2026-11-11T16:00:00Z', 4),
  ] } };
  try {
    const weather = createWeatherSource({ cacheFile: join(dir, 'cache.json'), fetchImpl: async (input) =>
      new URL(String(input)).hostname === 'nominatim.openstreetmap.org' ? Response.json(geo) : Response.json(forecast) });
    const result = await weather.query({ kind: 'weather', location: '北京', date: '2026-11-11' }, new AbortController().signal);
    expect(result.status).toBe('evidence');
    expect(result.evidenceText).toContain('2026-11-10T16:00:00.000Z');
    expect(result.evidenceText).toContain('2026-11-11T15:00:00.000Z');
    expect(result.evidenceText).not.toContain('2026-11-10T15:00:00.000Z');
    expect(result.evidenceText).not.toContain('2026-11-11T16:00:00.000Z');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it.each([
  { label: 'date-only', value: '2026-11-11' },
  { label: 'without zone', value: '2026-11-11T04:00:00' },
  { label: 'normalized invalid date', value: '2026-02-30T04:00:00Z' },
])('does not invent an absolute MET time for $label', async ({ value }) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-weather-absolute-time-'));
  const geo = [{ name: '北京市', category: 'boundary', type: 'administrative',
    address: { city: '北京市', country_code: 'cn' }, lat: '40', lon: '116',
    boundingbox: ['39', '41', '115', '118'],
    geojson: { type: 'Polygon', coordinates: [[[115, 39], [118, 39], [118, 41], [115, 41], [115, 39]]] } }];
  const point = (time: string) => ({ time, data: { instant: { details: { air_temperature: 8 } } } });
  try {
    for (const field of ['meta', 'point'] as const) {
      const weather = createWeatherSource({
        cacheFile: join(dir, `${field}.json`),
        fetchImpl: async (input) => new URL(String(input)).hostname === 'nominatim.openstreetmap.org'
          ? Response.json(geo)
          : Response.json({ properties: {
            meta: { updated_at: field === 'meta' ? value : '2026-11-11T00:00:00Z', units: { air_temperature: 'celsius' } },
            timeseries: [point(field === 'point' ? value : '2026-11-11T04:00:00Z')],
          } }),
      });
      const result = await weather.query({ kind: 'weather', location: '北京', date: '2026-11-11' }, new AbortController().signal);
      expect(result.status).toBe('limited');
      expect(result.sources).toEqual([]);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('refuses 304 revalidation when the cached MET update time lacks a zone', async () => {
  const { WeatherCache } = await import('../src/body/weatherCache');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-weather-304-time-'));
  const cacheFile = join(dir, 'cache.json');
  const now = Date.parse('2026-11-11T04:00:00Z');
  const signal = new AbortController().signal;
  const geoUrl = new URL('https://nominatim.openstreetmap.org/search');
  for (const [key, value] of Object.entries({ format: 'jsonv2', q: '北京', countrycodes: 'cn', addressdetails: '1', limit: '3', 'accept-language': 'zh-CN', polygon_geojson: '1' })) geoUrl.searchParams.set(key, value);
  const geo = [{ name: '北京市', category: 'boundary', type: 'administrative',
    address: { city: '北京市', country_code: 'cn' }, lat: '40', lon: '116',
    boundingbox: ['39', '41', '115', '118'],
    geojson: { type: 'Polygon', coordinates: [[[115, 39], [118, 39], [118, 41], [115, 41], [115, 39]]] } }];
  const forecastUrl = 'https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=40.0000&lon=116.0000';
  const retrievedAt = new Date(now - 4 * 60 * 60 * 1000).toISOString();
  const codes: string[] = [];
  let calls = 0;
  try {
    const cache = new WeatherCache(cacheFile, () => now);
    await cache.put('geo', { url: geoUrl.href, data: geo, retrievedAt, validUntil: now + 100_000 }, signal);
    await cache.put('forecast', { url: forecastUrl, retrievedAt, validUntil: now - 1,
      data: { properties: { meta: { updated_at: '2026-11-11T00:00:00', units: { air_temperature: 'celsius' } }, timeseries: [] } },
      lastModified: 'Wed, 11 Nov 2026 00:00:00 GMT' }, signal);
    const weather = createWeatherSource({ cacheFile, now: () => now, onDiagnostic: (code) => codes.push(code),
      fetchImpl: async () => { calls++; return new Response(null, { status: 304 }); } });
    const result = await weather.query({ kind: 'weather', location: '北京', date: '2026-11-11' }, signal);
    expect(result.status).toBe('limited');
    expect(result.sources).toEqual([]);
    expect(codes).toContain('invalid_not_modified');
    expect(calls).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
