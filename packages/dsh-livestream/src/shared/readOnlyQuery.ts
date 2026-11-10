/** Public, bounded representations shared by the host and console. */
export type QueryRequest =
  | { kind: 'weather'; location: string; date?: string }
  | { kind: 'public_search'; query: string };

export interface QuerySource {
  name: string;
  title: string | null;
  url: string;
  retrievedAt: string;
  providerTime: { kind: 'unknown'; value: null; verbatim: null }
    | { kind: 'observed' | 'forecast'; value: string; verbatim: string };
}

export type QueryStatus = 'evidence' | 'limited' | 'needs_clarification' | 'empty' | 'unavailable'
  | 'busy' | 'timeout' | 'failed' | 'unsupported_response' | 'cancelled';

export interface QueryResult {
  queryId?: string;
  kind: QueryRequest['kind'];
  status: QueryStatus;
  evidenceText: string;
  sources: QuerySource[];
  limitation?: string;
}

export interface QuerySettings {
  weather: boolean;
  publicSearch: boolean;
}

export function mergeQuerySettings(current: QuerySettings | undefined, patch: unknown): QuerySettings {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('查询设置无效');
  const values = patch as Record<string, unknown>;
  for (const [name, value] of Object.entries(values)) {
    if (!['weather', 'publicSearch'].includes(name) || typeof value !== 'boolean') throw new Error('查询设置无效');
  }
  return {
    weather: values.weather as boolean | undefined ?? current?.weather ?? false,
    publicSearch: values.publicSearch as boolean | undefined ?? current?.publicSearch ?? false,
  };
}
