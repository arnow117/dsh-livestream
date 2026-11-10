import { isIP } from 'node:net';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { WeatherCache, type WeatherCacheEntry, type WeatherCacheKind } from './weatherCache';
import type { QueryRequest, QueryResult, QuerySource } from '../shared/readOnlyQuery';

const GEO_DEFAULT = 'https://nominatim.openstreetmap.org/search';
const AWC = 'https://aviationweather.gov/api/data/metar';
const MET = 'https://api.met.no/weatherapi/locationforecast/2.0/compact';
const USER_AGENT = 'dsh-livestream/0.0.1 (https://github.com/arnow117/dsh-livestream)';
const MAX_BYTES = 1024 * 1024;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

type WeatherRequest = Extract<QueryRequest, { kind: 'weather' }>;
type Area = { lat: number; lon: number; bbox: [number, number, number, number]; geometry: any };
interface WeatherOptions {
  cacheFile: string;
  geocoderUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  onDiagnostic?: (code: string) => void;
}

export function isSupportedWeatherLocation(location: string): boolean {
  if (typeof location !== 'string') return false;
  const municipality = /^(?:北京|上海|天津|重庆)(?:市(?:[\u4e00-\u9fff]{1,12}(?:区|县))?)?$/;
  const provinceAndLocality = /^[\u4e00-\u9fff]{2,8}省[\u4e00-\u9fff]{1,12}(?:市|县|区)$/;
  return municipality.test(location) || provinceAndLocality.test(location);
}

function configuredGeocoder(value: string | undefined): string {
  const url = new URL(value === undefined ? GEO_DEFAULT : value);
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/search'
    || isIP(host) || !host.includes('.') || host === 'localhost'
    || ['.localhost', '.local', '.internal', '.invalid', '.test', '.example', '.onion', '.home.arpa'].some((part) => host.endsWith(part))
    || ['example.com', 'example.org', 'example.net'].includes(host)) throw new Error('geocoder_config_invalid');
  return url.href;
}

function boundedStructure(value: unknown): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let count = 0;
  while (stack.length) {
    const item = stack.pop()!;
    if (++count > 250_000 || item.depth > 20) return false;
    if (item.value && typeof item.value === 'object') {
      for (const child of Object.values(item.value)) stack.push({ value: child, depth: item.depth + 1 });
    }
  }
  return true;
}

function matchesLocation(row: any, location: string): boolean {
  if (!row || row.category !== 'boundary' || row.type !== 'administrative' || row.address?.country_code !== 'cn') return false;
  const municipality = /^(北京|上海|天津|重庆)(?:市)?(.*)$/.exec(location);
  if (municipality) {
    const city = `${municipality[1]}市`;
    return [row.address?.city, row.address?.state].includes(city) && row.name === (municipality[2] || city);
  }
  const match = /^(.+?省)(.+)$/.exec(location);
  return !!match && row.address?.state === match[1] && row.name === match[2];
}

function geoArea(row: any): Area | null {
  if (!Array.isArray(row.boundingbox) || row.boundingbox.length !== 4) return null;
  const bbox = row.boundingbox.map(Number);
  const [south, north, west, east] = bbox;
  const lat = Number(row.lat);
  const lon = Number(row.lon);
  if (!bbox.every(Number.isFinite) || !Number.isFinite(lat) || !Number.isFinite(lon)
    || south < 18 || north > 54 || west < 73 || east > 135 || south >= north || west >= east
    || lat < south || lat > north || lon < west || lon > east) return null;
  const geometry = row.geojson;
  if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type) || !Array.isArray(geometry.coordinates)) return null;
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  if (!polygons.length || polygons.length > 10_000) return null;
  let points = 0;
  for (const polygon of polygons) {
    if (!Array.isArray(polygon) || !polygon.length || polygon.length > 10_000) return null;
    for (const ring of polygon) {
      if (!Array.isArray(ring) || ring.length < 4) return null;
      const first = ring[0];
      const last = ring.at(-1);
      if (!Array.isArray(first) || !Array.isArray(last) || first[0] !== last[0] || first[1] !== last[1]) return null;
      for (const point of ring) {
        if (++points > 50_000 || !Array.isArray(point) || point.length !== 2
          || !point.every((coordinate: unknown) => typeof coordinate === 'number' && Number.isFinite(coordinate))
          || point[0] < west - 1e-7 || point[0] > east + 1e-7 || point[1] < south - 1e-7 || point[1] > north + 1e-7) return null;
      }
    }
  }
  return { lat, lon, bbox: [south, north, west, east], geometry };
}

function inside(area: Area, lon: number, lat: number): boolean {
  return booleanPointInPolygon([lon, lat], area.geometry, { ignoreBoundary: true });
}

function source(name: string, url: string, retrievedAt: string, providerTime: QuerySource['providerTime']): QuerySource {
  return { name, title: null, url, retrievedAt, providerTime };
}

const unknownTime: QuerySource['providerTime'] = { kind: 'unknown', value: null, verbatim: null };
const limited = (message: string): QueryResult => ({ kind: 'weather', status: 'limited', evidenceText: '', sources: [], limitation: message });

export function createWeatherSource(options: WeatherOptions) {
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? fetch;
  const cache = new WeatherCache(options.cacheFile, now);
  const diagnose = (code: string) => { try { options.onDiagnostic?.(code); } catch { /* diagnostic must not affect queries */ } };
  let requests = 0;

  async function get(url: string, kind: WeatherCacheKind, signal: AbortSignal, lifetime: number | ((data: unknown) => number)): Promise<WeatherCacheEntry> {
    const existing = await cache.get(kind, url, signal);
    if (existing && existing.validUntil > now()) return existing;
    await cache.ensureCapacity(kind, url, signal);
    if (kind === 'geo') await cache.waitForGeo(signal);
    signal.throwIfAborted();
    if (++requests > 3) throw new Error('request_limit');
    const headers: Record<string, string> = { 'User-Agent': USER_AGENT, Accept: 'application/json' };
    if (kind === 'forecast' && existing?.lastModified) headers['If-Modified-Since'] = existing.lastModified;
    const response = await fetchImpl(url, { method: 'GET', headers, redirect: 'error', signal });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      signal.throwIfAborted();
      if (response.status === 304) {
        const properties = (existing?.data as any)?.properties;
        if (kind !== 'forecast' || !existing || !validTime(existing.retrievedAt)
          || !validTime(properties?.meta?.updated_at) || !Array.isArray(properties?.timeseries)) {
          throw new Error('invalid_not_modified');
        }
        const expires = Date.parse(response.headers.get('expires') ?? '');
        const validated = { ...existing, validUntil: Math.max(now() + 3 * HOUR, Number.isFinite(expires) ? expires : 0) };
        await cache.put(kind, validated, signal);
        return validated;
      }
      if (response.status === 204 && kind === 'current') {
        const empty = { url, data: [], retrievedAt: new Date(now()).toISOString(), validUntil: now() + (typeof lifetime === 'number' ? lifetime : lifetime([])) };
        await cache.put(kind, empty, signal);
        return empty;
      }
      if (!response.ok || Number(response.headers.get('content-length')) > MAX_BYTES || !response.body) throw new Error('source_response_failed');
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        signal.throwIfAborted();
        const chunk = await reader.read();
        signal.throwIfAborted();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_BYTES) throw new Error('source_too_large');
        chunks.push(chunk.value);
      }
      let data: unknown;
      try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { throw new Error('source_invalid_json'); }
      if (!boundedStructure(data)) throw new Error('source_invalid_shape');
      if (kind === 'geo' && (!Array.isArray(data) || data.length > 3)) throw new Error('geo_invalid');
      if (kind === 'current' && (!Array.isArray(data) || data.length >= 400)) throw new Error('source_incomplete');
      if (kind === 'forecast') {
        const properties = (data as any)?.properties;
        if (!validTime(properties?.meta?.updated_at) || !properties?.meta?.units || !Array.isArray(properties?.timeseries)
          || properties.timeseries.length > 1000) throw new Error('source_invalid_shape');
      }
      const retrievedAt = new Date(now()).toISOString();
      const expires = Date.parse(response.headers.get('expires') ?? '');
      const ttl = typeof lifetime === 'number' ? lifetime : lifetime(data);
      const validUntil = Math.max(now() + ttl, Number.isFinite(expires) && kind === 'forecast' ? expires : 0);
      const lastModified = response.headers.get('last-modified');
      const entry = { url, data, retrievedAt, validUntil, ...(lastModified && lastModified.length <= 200 ? { lastModified } : {}) };
      if (ttl >= 0) await cache.put(kind, entry, signal);
      return entry;
    } finally {
      if (reader) {
        await reader.cancel().catch(() => {});
      } else if (response.body) {
        await response.body.cancel().catch(() => {});
      }
    }
  }

  async function query(request: WeatherRequest, signal: AbortSignal): Promise<QueryResult> {
    requests = 0;
    try {
      if (!isSupportedWeatherLocation(request.location)) return { ...limited('地点需要明确的行政层级。'), status: 'needs_clarification' };
      if (request.date && (!/^\d{4}-\d{2}-\d{2}$/.test(request.date) || !validTime(`${request.date}T00:00:00Z`)
        || new Date(`${request.date}T00:00:00Z`).toISOString().slice(0, 10) !== request.date)) return { ...limited('日期无效。'), status: 'needs_clarification' };
      const geoUrl = new URL(configuredGeocoder(options.geocoderUrl));
      for (const [key, value] of Object.entries({ format: 'jsonv2', q: request.location, countrycodes: 'cn', addressdetails: '1', limit: '3', 'accept-language': 'zh-CN', polygon_geojson: '1' })) geoUrl.searchParams.set(key, value);
      const geoEntry = await get(geoUrl.href, 'geo', signal, (data) => {
        if (!Array.isArray(data) || data.length > 3) return -1;
        const matches = data.filter((row) => matchesLocation(row, request.location));
        if (matches.length !== 1) return HOUR;
        return geoArea(matches[0]) ? 30 * DAY : -1;
      });
      if (!Array.isArray(geoEntry.data) || geoEntry.data.length > 3) throw new Error('geo_invalid');
      const matches = geoEntry.data.filter((row) => matchesLocation(row, request.location));
      if (matches.length !== 1) return { ...limited('无法唯一确认地点及行政区域。'), status: 'needs_clarification' };
      const area = geoArea(matches[0]);
      if (!area) {
        diagnose('geo_invalid_geometry');
        return limited('行政区域边界资料不完整。');
      }
      const osm = source('OpenStreetMap contributors / ODbL', geoUrl.href, geoEntry.retrievedAt, unknownTime);
      const copyright = source('OpenStreetMap 版权 / ODbL', 'https://www.openstreetmap.org/copyright', geoEntry.retrievedAt, unknownTime);
      if (!request.date) {
        const [south, north, west, east] = area.bbox;
        const outward = (value: number, lower: boolean) => ((lower ? Math.floor(value * 1000) : Math.ceil(value * 1000)) / 1000).toFixed(3);
        const url = new URL(AWC);
        url.searchParams.set('bbox', [outward(south, true), outward(west, true), outward(north, false), outward(east, false)].join(','));
        url.searchParams.set('format', 'json');
        url.searchParams.set('hours', '2');
        const current = await get(url.href, 'current', signal, 5 * 60_000);
        if (!Array.isArray(current.data) || current.data.length >= 400) return limited('观测数据为空或不完整。');
        const rows = current.data.filter((row: any) => row && typeof row.icaoId === 'string' && /^[A-Z0-9]{4}$/.test(row.icaoId)
          && typeof row.name === 'string' && row.name.length > 0 && row.name.length <= 200
          && typeof row.temp === 'number' && Number.isFinite(row.temp) && Number.isInteger(row.obsTime)
          && typeof row.lat === 'number' && typeof row.lon === 'number' && Number.isFinite(row.lat) && Number.isFinite(row.lon)
          && row.obsTime * 1000 >= now() - 2 * HOUR && row.obsTime * 1000 <= now() + 5 * 60_000
          && inside(area, row.lon, row.lat));
        const unique = new Map<string, any>();
        for (const row of rows) {
          const key = `${row.icaoId}|${row.obsTime}`;
          const previous = unique.get(key);
          if (previous && previous.temp !== row.temp) return limited('同一站点同一时刻的气温数据冲突。');
          if (!previous) unique.set(key, row);
        }
        const selected = [...unique.values()].sort((a, b) => b.obsTime - a.obsTime || a.icaoId.localeCompare(b.icaoId))[0];
        if (!selected) return limited('区域内没有可确认时间的气温观测站。');
        const observed = new Date(selected.obsTime * 1000).toISOString();
        return {
          kind: 'weather', status: 'evidence',
          evidenceText: `区域内 ${selected.name}（${selected.icaoId}，${selected.lat}, ${selected.lon}）附近在 ${observed} 的观测气温 ${selected.temp}℃。仅代表该站附近，不代表全市或全区平均。`,
          sources: [source('NOAA Aviation Weather Center', url.href, current.retrievedAt, { kind: 'observed', value: observed, verbatim: observed }), osm, copyright],
          limitation: '观测仅代表所标注的站点和时间。',
        };
      }
      const lat = Number(area.lat.toFixed(4));
      const lon = Number(area.lon.toFixed(4));
      if (!inside(area, lon, lat)) return limited('预报坐标不在所确认行政区域内部。');
      const url = new URL(MET);
      url.searchParams.set('lat', lat.toFixed(4));
      url.searchParams.set('lon', lon.toFixed(4));
      const forecast = await get(url.href, 'forecast', signal, 3 * HOUR);
      const properties = (forecast.data as any)?.properties;
      if (!validTime(properties?.meta?.updated_at) || properties?.meta?.units?.air_temperature !== 'celsius'
        || !Array.isArray(properties.timeseries) || properties.timeseries.length > 1000) return limited('预报来源缺少可确认的时间或单位。');
      const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
      const points = properties.timeseries.filter((point: any) => validTime(point?.time) && formatter.format(new Date(point.time)) === request.date
        && typeof point?.data?.instant?.details?.air_temperature === 'number' && Number.isFinite(point.data.instant.details.air_temperature));
      if (!points.length) return limited('该日期没有可确认的预报覆盖。');
      points.sort((a: any, b: any) => Date.parse(a.time) - Date.parse(b.time));
      const displayed = points.slice(0, 24);
      const first = new Date(displayed[0].time).toISOString();
      const text = displayed.map((point: any) => `${new Date(point.time).toISOString()}：${point.data.instant.details.air_temperature}℃`).join('；');
      return {
        kind: 'weather', status: 'evidence',
        evidenceText: `MET Norway 模型更新时间 ${properties.meta.updated_at}；${request.date} 仅列实际覆盖时点：${text}`,
        sources: [source('MET Norway / CC BY 4.0', url.href, forecast.retrievedAt, { kind: 'forecast', value: first, verbatim: first }), osm, copyright],
        limitation: '这是模式预报，仅列已有时点，不代表全天完整覆盖或实际观测。',
      };
    } catch (error) {
      if (signal.aborted) return { ...limited('查询已取消。'), status: 'cancelled' };
      const code = error instanceof Error && /^[a-z_]{1,60}$/.test(error.message) ? error.message : 'weather_failed';
      diagnose(code);
      return limited('天气来源暂时不可用或资料不足。');
    }
  }
  return { query };
}

function validTime(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 19) === value.slice(0, 19);
}
