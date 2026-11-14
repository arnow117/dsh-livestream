/** 原 source 接收事实；frame 时间仅用于诊断，不能证明平台事件新鲜度。 */
export interface SourceIngress {
  rawId: string;
  rawType: string;
  roomId: string;
  frameTimeUntrusted: number;
  receivedAt: number;
}

const ingress = new WeakMap<object, Readonly<SourceIngress>>();

export function recordSourceIngress(event: object, value: SourceIngress): void {
  if (!ingress.has(event)) ingress.set(event, Object.freeze({ ...value }));
}

export function readSourceIngress(event: object): Readonly<SourceIngress> | null {
  return ingress.get(event) ?? null;
}
