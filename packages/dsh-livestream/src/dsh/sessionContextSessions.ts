/**
 * 原生会话适配：控制台显式新会话 → 捕获保存版本 → 冻结快照 → native sessionController.create()。
 *
 * 由 index.ts 的 owner 路由调用；不接收模型提交的 sessionId、cwd、根路径或设置。
 * native create 的 mkdir 不作为校验或目录创建功能：prepare 之前目录必须已存在且绑定一致。
 */

import { randomUUID } from 'node:crypto';
import {
  captureSaved,
  checkHostComposition,
  prepareSnapshot,
  registerActiveSession,
  registerObservationSession,
  snapshotView,
  writeSnapshot,
  type SessionContextSnapshot,
} from './sessionContext';
import { verifyDirectory } from './sessionContextPaths';
import { PRESET_ID } from './runtime';

export interface AdapterContext {
  get?(name: string): any;
}

export interface CreateSessionInput {
  workspaceId?: unknown;
  platform: 'bilibili' | 'douyin';
}

export type CreateSessionOutcome =
  | { ok: true; sessionId: string; sessionContext: ReturnType<typeof snapshotView> }
  | { ok: false; status: number; error: string };

/** douyin 走只读预设，其余平台用 B 站直播预设；游戏线不使用本路由 */
export function presetForPlatform(platform: 'bilibili' | 'douyin'): string {
  return platform === 'douyin' ? 'dsh-livestream-douyin' : PRESET_ID;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 生成宿主可作快照文件名的全新 SessionId */
export function generateSessionId(): string {
  return `livestream-${randomUUID()}`;
}

/** 本轮（本插件进程）内创建过的会话：native 返回别的 id 时可判定为复用/串号 */
const requestedSessionIds = new Set<string>();

/**
 * 管理会话创建的完整流程（工程上下文时序第 2 步）。
 * 捕获点在任何 await 之前：之后保存 B 不修改正在准备的 A。
 */
export async function createManagedSession(ctx: AdapterContext, input: CreateSessionInput): Promise<CreateSessionOutcome> {
  const controller = ctx.get?.('sessionController');
  if (!controller || typeof controller.create !== 'function') {
    return { ok: false, status: 503, error: '宿主缺少公开会话创建服务，无法创建管理会话' };
  }
  if (typeof input.workspaceId !== 'undefined' && (typeof input.workspaceId !== 'string' || !input.workspaceId || input.workspaceId.length > 128)) {
    return { ok: false, status: 400, error: '工作区标识无效' };
  }
  const preset = presetForPlatform(input.platform);
  // 线性化点：同步取得最近成功发布的完整保存记录
  const record = captureSaved();
  if (!record) return { ok: false, status: 409, error: '没有已成功保存的会话设置；请先保存或使用原有创建方式' };
  const composition = checkHostComposition(ctx.get?.('loader'));
  const sessionId = generateSessionId();
  requestedSessionIds.add(sessionId);
  const prepared = await prepareSnapshot(record, sessionId, input.platform, preset);
  if (!prepared.ok) return { ok: false, status: prepared.status, error: prepared.error };
  const snapshot: SessionContextSnapshot = prepared.snapshot;
  if (record.config.enabled && !composition.ok) {
    return { ok: false, status: 503, error: `宿主组合不支持受限会话：${composition.reason}` };
  }
  const persisted = writeSnapshot(snapshot);
  if (!persisted.ok) {
    // 快照落盘失败：没有可用的无快照授权，直接拒绝创建
    return { ok: false, status: 503, error: `会话快照无法保存：${persisted.error}` };
  }
  const nativeRequest = snapshot.effectiveCwd
    ? { sessionId, cwd: snapshot.effectiveCwd, agentPreset: preset }
    : { sessionId, workspaceId: input.workspaceId, agentPreset: preset };
  let native: unknown;
  try {
    native = await controller.create(nativeRequest);
  } catch {
    // 保存校验与调用之间目录消失等情况下：该次创建失败并禁止 onair，不把 native 的创建结果当成有效已选目录
    return { ok: false, status: 503, error: '宿主会话创建失败，未修改既有会话' };
  }
  if (!isRecord(native) || native.sessionId !== sessionId) {
    // native API 返回另一个 id：拒绝复用，不事后改旧 header
    return { ok: false, status: 409, error: '宿主返回的会话标识与请求不一致，已拒绝本次会话' };
  }
  if (native.agentPreset !== undefined && native.agentPreset !== preset) {
    return { ok: false, status: 409, error: '宿主返回的预设与请求不一致，已拒绝本次会话' };
  }
  // 成功后核对返回 id/preset、Agent 的 header.cwd 与 effective workingDirectory
  if (snapshot.effectiveCwd) {
    const verification = await verifyNativeSession(ctx, sessionId, snapshot.effectiveCwd);
    if (!verification.ok) return { ok: false, status: verification.status, error: verification.error };
    const bindingFailure = await verifyDirectory(snapshot.cwdBinding!);
    if (bindingFailure) {
      return { ok: false, status: 409, error: '工作目录在创建过程中失效，已拒绝本次会话' };
    }
  }
  registerActiveSession(snapshot, composition);
  registerObservationSession(sessionId);
  return { ok: true, sessionId, sessionContext: snapshotView(snapshot) };
}

async function verifyNativeSession(ctx: AdapterContext, sessionId: string, expectedCwd: string): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const agents = ctx.get?.('agents');
  const found = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined;
  const agent = found?.session ? found : found?.agent;
  if (!agent?.session) return { ok: false, status: 409, error: '无法核对创建后的会话，已拒绝本次会话' };
  const headerCwd = agent.session.header?.cwd;
  if (headerCwd !== expectedCwd) return { ok: false, status: 409, error: '会话 header 的工作目录与所选目录不一致，已拒绝本次会话' };
  const workingDirectory = ctx.get?.('workingDirectory');
  if (!workingDirectory || typeof workingDirectory.get !== 'function') {
    return { ok: false, status: 409, error: '宿主缺少工作目录服务，无法核对实际生效目录' };
  }
  const effective = workingDirectory.get(agent.session);
  if (effective !== expectedCwd) return { ok: false, status: 409, error: '实际生效的工作目录与所选目录不一致，已拒绝本次会话' };
  return { ok: true };
}

/** 创建流程结束后：本轮外的会话集合不保留；仅用于重复/串号判定 */
export function forgetRequestedSession(sessionId: string): void {
  requestedSessionIds.delete(sessionId);
}
