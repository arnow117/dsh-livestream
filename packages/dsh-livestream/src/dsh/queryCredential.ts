export type QueryCredential =
  | { status: 'configured'; value: string }
  | { status: 'unconfigured' | 'error' };

/** A present credential service is authoritative, including empty/error results. */
export async function resolveQueryCredential(
  service: { resolve(name: string): Promise<{ value?: unknown } | undefined> } | undefined,
  environmentValue: string | undefined,
): Promise<QueryCredential> {
  try {
    const value = service ? (await service.resolve('GLM_CODING_PLAN_API_KEY'))?.value : environmentValue;
    if (typeof value !== 'string' || !value.trim()) return { status: 'unconfigured' };
    return { status: 'configured', value: value.trim() };
  } catch {
    return { status: 'error' };
  }
}
