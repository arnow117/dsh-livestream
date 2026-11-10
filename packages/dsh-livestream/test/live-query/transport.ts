/** Network policy for the opt-in acceptance runner. This module never reads credentials. */
export const MODEL_URL = 'https://open.bigmodel.cn/api/anthropic/v1/messages?beta=true';
export const MCP_URL = 'https://open.bigmodel.cn/api/mcp/web_search_prime/mcp';
export const YOVOICE_ORIGIN = 'http://127.0.0.1:3081';

export type Counts = { model: number; mcp: number; geocode: number; current: number; forecast: number; synthesis: number };
type FailurePhase = 'model' | 'mcp' | 'geocode' | 'current' | 'forecast' | 'synthesis' | 'destination';
export type TransportFailure = { code: string; phase: FailurePhase; httpStatus?: number };

export class AcceptanceTransport {
  readonly counts: Counts = { model: 0, mcp: 0, geocode: 0, current: 0, forecast: 0, synthesis: 0 };
  readonly controller = new AbortController();
  private scenarioModel = 0;
  private scenarioMcp = 0;
  private scenarioWeather = 0;
  private failed = false;
  private jobPath: string | undefined;
  private audioPath: string | undefined;
  cleanupTerminal = false;
  jobTerminal = false;
  failure: TransportFailure | undefined;
  private readonly deadline: AbortSignal;
  private readonly workTimer: ReturnType<typeof setTimeout>;

  close(): void {
    clearTimeout(this.workTimer);
  }

  constructor(
    private readonly send: typeof fetch,
    deadlineMs = 300_000,
    private readonly geocoder = 'https://nominatim.openstreetmap.org/search',
    private readonly synthesisBudget: 0 | 1 = 1,
  ) {
    this.deadline = AbortSignal.timeout(deadlineMs);
    this.workTimer = setTimeout(() => this.stop(), Math.max(0, deadlineMs - 30_000));
    this.workTimer.unref();
    this.deadline.addEventListener('abort', () => this.stop(), { once: true });
  }

  nextScenario(): void {
    if (this.failed) throw new Error('acceptance stopped');
    this.failure = undefined;
    this.scenarioModel = 0;
    this.scenarioMcp = 0;
    this.scenarioWeather = 0;
  }

  private reject(code: string, phase: FailurePhase, httpStatus?: number): never {
    this.failure ??= { code, phase, ...(httpStatus === undefined ? {} : { httpStatus }) };
    throw new Error('acceptance transport stopped');
  }

  stop(): void {
    this.failed = true;
    this.controller.abort();
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const ownedJob = !!this.jobPath && url === `${YOVOICE_ORIGIN}${this.jobPath}`;
    const cleanup = !this.deadline.aborted && ownedJob
      && (method === 'DELETE' || (this.failed && method === 'GET'));
    if (cleanup && method === 'DELETE') this.stop();
    if (this.failed && !cleanup) throw new Error('acceptance stopped');
    const body = typeof init?.body === 'string' ? init.body : '';
    let target: URL;
    let configuredGeo: URL;
    try {
      target = new URL(url);
      configuredGeo = new URL(this.geocoder);
    } catch {
      this.failure ??= { code: 'request_rejected', phase: 'destination' };
      this.stop();
      throw new Error('acceptance transport stopped');
    }
    const failurePhase: FailurePhase = url === MODEL_URL ? 'model' : url === MCP_URL ? 'mcp'
      : target.origin === configuredGeo.origin && target.pathname === configuredGeo.pathname ? 'geocode'
        : target.origin === 'https://aviationweather.gov' && target.pathname === '/api/data/metar' ? 'current'
          : target.origin === 'https://api.met.no' && target.pathname === '/weatherapi/locationforecast/2.0/compact' ? 'forecast'
            : url.startsWith(`${YOVOICE_ORIGIN}/`) ? 'synthesis' : 'destination';
    let sending = false;
    try {
      if (url === MODEL_URL && method === 'POST') {
        const request = JSON.parse(body);
        if (this.scenarioModel === 1) {
          const toolResults = (request.messages ?? []).flatMap((message: any) =>
            Array.isArray(message.content) ? message.content.filter((item: any) => item?.type === 'tool_result') : [],
          );
          if (toolResults.length !== 1 || toolResults[0].is_error) {
            throw new Error('missing successful query result');
          }
          const content = toolResults[0].content;
          const text = typeof content === 'string' ? content
            : Array.isArray(content) ? content.map((item: any) => item?.text ?? '').join('') : '';
          const start = text.indexOf('{');
          if (start < 0) this.reject('invalid_tool_result', 'model');
          let result: { status?: unknown; kind?: unknown };
          try {
            result = JSON.parse(text.slice(start));
          } catch {
            this.reject('invalid_tool_result', 'model');
          }
          if (!['evidence', 'limited'].includes(String(result.status))) this.reject('query_status_rejected', 'model');
          if (result.kind === 'public_search' && this.scenarioMcp !== 1) this.reject('missing_search', 'model');
          if (!['weather', 'public_search'].includes(String(result.kind))) this.reject('invalid_tool_result', 'model');
        }
        if (request.model !== 'glm-5.3-flash' || !Number.isInteger(request.max_tokens)
          || request.max_tokens < 1 || request.max_tokens > 1024
          || this.counts.model >= 4 || this.scenarioModel >= 2) throw new Error('model budget or request rejected');
        this.counts.model++;
        this.scenarioModel++;
      } else if (url === MCP_URL && method === 'GET') {
        // Streamable HTTP may open an SSE stream; it is not a search call.
      } else if (url === MCP_URL && method === 'POST') {
        const request = JSON.parse(body);
        if (request.method === 'tools/call') {
          if (request.params?.name !== 'web_search_prime' || this.counts.mcp >= 2 || this.scenarioMcp >= 1) {
            throw new Error('search budget or tool rejected');
          }
          this.counts.mcp++;
          this.scenarioMcp++;
        } else if (!['initialize', 'notifications/initialized', 'tools/list'].includes(request.method)) {
          throw new Error('MCP method rejected');
        }
      } else if (['geocode', 'current', 'forecast'].includes(failurePhase) && method === 'GET') {
        const headers = new Headers(init?.headers);
        if (target.protocol !== 'https:' || target.username || target.password || target.hash
          || headers.has('authorization') || headers.has('cookie')) throw new Error('weather destination rejected');
        const expectedParams = failurePhase === 'geocode'
          ? ['accept-language', 'addressdetails', 'countrycodes', 'format', 'limit', 'polygon_geojson', 'q']
          : failurePhase === 'current' ? ['bbox', 'format', 'hours'] : ['lat', 'lon'];
        if (JSON.stringify([...target.searchParams.keys()].sort()) !== JSON.stringify(expectedParams.sort())) throw new Error('weather parameters rejected');
        if (failurePhase === 'geocode' && (target.searchParams.get('q') !== '北京' || target.searchParams.get('format') !== 'jsonv2'
          || target.searchParams.get('countrycodes') !== 'cn' || target.searchParams.get('addressdetails') !== '1'
          || target.searchParams.get('limit') !== '3' || target.searchParams.get('accept-language') !== 'zh-CN'
          || target.searchParams.get('polygon_geojson') !== '1')) throw new Error('geocoder parameters rejected');
        if (failurePhase === 'current' && (target.searchParams.get('format') !== 'json' || target.searchParams.get('hours') !== '2'
          || !/^-?\d+\.\d{3}(,-?\d+\.\d{3}){3}$/.test(target.searchParams.get('bbox') ?? ''))) throw new Error('current parameters rejected');
        if (failurePhase === 'forecast' && (!/^-?\d+\.\d{4}$/.test(target.searchParams.get('lat') ?? '')
          || !/^-?\d+\.\d{4}$/.test(target.searchParams.get('lon') ?? ''))) throw new Error('forecast parameters rejected');
        if (++this.scenarioWeather > 3 || this.counts[failurePhase as 'geocode' | 'current' | 'forecast'] >= 1) throw new Error('weather budget exceeded');
        this.counts[failurePhase as 'geocode' | 'current' | 'forecast']++;
      } else if (url.startsWith(`${YOVOICE_ORIGIN}/`)) {
        if (this.synthesisBudget === 0) throw new Error('synthesis budget rejected');
        const parsed = new URL(url);
        const path = parsed.pathname;
        if (parsed.origin !== YOVOICE_ORIGIN || parsed.search || parsed.hash) throw new Error('yovoice destination rejected');
        if (method === 'PUT' && /^\/v1\/jobs\/[a-f0-9]{32}$/.test(path)) {
          const request = JSON.parse(body);
          if (this.counts.synthesis >= this.synthesisBudget || typeof request.text !== 'string'
            || [...request.text].length < 1 || [...request.text].length > 120) throw new Error('synthesis budget rejected');
          this.counts.synthesis++;
          this.jobPath = path;
        } else if (!(method === 'GET' && (path === this.jobPath || path === this.audioPath))
          && !(cleanup && method === 'DELETE' && path === this.jobPath)) {
          throw new Error('yovoice request rejected');
        }
      } else {
        throw new Error('destination rejected');
      }
      const signals = [this.deadline, ...(cleanup ? [] : [this.controller.signal]), ...(init?.signal ? [init.signal] : [])];
      const signal = AbortSignal.any(signals);
      sending = true;
      const response = await this.send(input, { ...init, redirect: 'error', signal });
      sending = false;
      const optionalMcpStreamUnsupported = url === MCP_URL && method === 'GET' && response.status === 405;
      if (!response.ok && !optionalMcpStreamUnsupported) this.reject('http_error', failurePhase, response.status);
      if (url === `${YOVOICE_ORIGIN}${this.jobPath}` && ['PUT', 'GET', 'DELETE'].includes(method)) {
        const clone = response.clone();
        if (Number(clone.headers.get('content-length')) > 64 * 1024 || !clone.body) throw new Error('invalid job response');
        const reader = clone.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > 64 * 1024) throw new Error('job response too large');
            chunks.push(chunk.value);
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
        const result = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { requestId?: unknown; status?: unknown; downloadPath?: unknown };
        const expectedId = this.jobPath?.split('/').at(-1);
        if (result.requestId !== expectedId || !['running', 'completed', 'failed', 'cancelled', 'timed_out'].includes(String(result.status))) {
          throw new Error('invalid yovoice job response');
        }
        if (result.status !== 'running') this.jobTerminal = true;
        if (result.status === 'completed' && !cleanup) {
          if (typeof result.downloadPath !== 'string' || !/^\/v1\/audio\/[A-Za-z0-9_-]+$/.test(result.downloadPath)) {
            throw new Error('invalid yovoice audio path');
          }
          this.audioPath = result.downloadPath;
        } else if (result.status !== 'running') {
          if (!cleanup) throw new Error('yovoice job failed');
          this.cleanupTerminal = true;
        }
      }
      if (url === MODEL_URL && response.body) {
        if (Number(response.headers.get('content-length')) > 1024 * 1024) throw new Error('model response too large');
        const reader = response.body.getReader();
        let size = 0;
        const policy = this;
        const bounded = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const chunk = await reader.read();
              if (chunk.done) return controller.close();
              size += chunk.value.byteLength;
              if (size > 1024 * 1024) throw new Error('model response too large');
              controller.enqueue(chunk.value);
            } catch {
              const code = policy.controller.signal.aborted ? 'request_cancelled' : 'response_stream_error';
              policy.failure ??= { code, phase: 'model' };
              policy.stop();
              await reader.cancel().catch(() => {});
              controller.error(new Error('model response failed'));
            }
          },
          async cancel() { await reader.cancel().catch(() => {}); },
        });
        return new Response(bounded, { status: response.status, statusText: response.statusText, headers: response.headers });
      }
      return response;
    } catch {
      const cancelled = this.controller.signal.aborted || this.deadline.aborted || !!init?.signal?.aborted;
      const code = cancelled ? 'request_cancelled' : sending ? 'network_error' : 'request_rejected';
      this.failure ??= { code, phase: failurePhase };
      this.stop();
      throw new Error('acceptance transport stopped');
    }
  };
}
