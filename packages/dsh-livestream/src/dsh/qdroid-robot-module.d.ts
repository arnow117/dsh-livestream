/**
 * 可选依赖 dsh-qdroid/robot（已安装的 dsh-qdroid 插件包）的宿主类型声明。
 * 这里只声明本插件消费的导出名与结构边界；对象能力（binding/rule/receipt）是
 * robot 模块的私有 WeakMap 登记对象，不通过 JSON/字符串恢复。
 */

declare module 'dsh-qdroid/robot' {
  export function attachRobotLiveBinding(ctx: unknown, config: unknown, expectedRevision: number): Promise<unknown>;
  export function readRobotLivePolicy(ctx: unknown, bindingId: string): Promise<unknown>;
  export function attachRobotLiveRule(ctx: unknown, handle: unknown): unknown;
  export function bindRobotLiveMessage(handle: unknown, agent: object, message: { id: string }, receipt: unknown): void;
  export function attachRobotLiveCaller(
    ctx: unknown,
    agent: object,
    allowedActions: readonly string[],
    currentInteraction: (exec: unknown) => unknown,
  ): () => void;
}
