/**
 * sender-only 独立入口（FEAT-008 API-8 / P1-05 修订）。
 *
 * 只注册受保护 v1：state / qualification / grant 撤销 / send / 原操作查询。
 * 不加载原 DyHub buildApi；旧 chat、任意 rooms/connect、account cookie/login
 * 等所有写路由不存在或明确拒绝。强制数字 loopback 监听，缺部署装配拒启动；
 * 无开放 CORS；非 JSON/无凭据调用拒绝；通信核对固定实例/构建摘要与
 * processNonce。不防已取得同 OS 用户全部凭据的恶意进程，不扩建通用认证系统。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import {
  PUBLIC_CHAT_PROTOCOL, MAX_WIRE_BODY_BYTES, parseSenderListenUrl, isObject, boundedString, safeInteger,
  type SenderDeploymentFile,
} from './protocol';
import type { SenderRuntime } from './senderRuntime';
import { FrozenSenderRuntime } from './frozenSenderRuntime';
import type { FrozenAuthorizationRequest, FrozenRevokeRequest } from './frozenControl';
import { validMessageReconcileRequest } from './recoveryProtocol';
import { validateFrozenProposal, type FrozenGrantSnapshot } from './frozenGrant';
import { parseHelperJSON } from './helperProtocol';

export interface SenderServiceDeps {
  runtime: SenderRuntime | FrozenSenderRuntime;
  deployment: SenderDeploymentFile;
  /** sender token：只来自 0600 部署文件，绝不回显。 */
  token: string;
}

const ROUTES = {
  state: 'GET /v1/state',
  qualification: 'POST /v1/qualification',
  authorize: 'POST /v1/grant/authorize',
  revoke: 'POST /v1/grant/revoke',
  send: 'POST /v1/send',
} as const;

function validateFrozenSend(value: unknown): { requestId: string; sourceKey: string; grant: FrozenGrantSnapshot; text: string;
  autoEvent: { rawId: string; rawType: string } | null } | null {
  if (!isObject(value) || Object.keys(value).length !== 5 ||
    !['requestId', 'sourceKey', 'grant', 'text', 'autoEvent'].every((key) => Object.hasOwn(value, key)) ||
    !boundedString(value.requestId, 128) || !boundedString(value.sourceKey, 128) ||
    typeof value.text !== 'string' || value.text.length === 0 || value.text.length > 4096 || !isObject(value.grant)) return null;
  const { grantId, authorizedAtMs, ...proposal } = value.grant;
  if (!validateFrozenProposal(proposal) || !boundedString(grantId, 128) || !safeInteger(authorizedAtMs) || authorizedAtMs <= 0) return null;
  if (value.autoEvent !== null && (!isObject(value.autoEvent) || Object.keys(value.autoEvent).length !== 2 ||
    !boundedString(value.autoEvent.rawId, 128) || !boundedString(value.autoEvent.rawType, 64))) return null;
  return value as unknown as { requestId: string; sourceKey: string; grant: FrozenGrantSnapshot; text: string;
    autoEvent: { rawId: string; rawType: string } | null };
}

export class SenderService {
  private readonly runtime: FrozenSenderRuntime;
  private readonly deployment: SenderDeploymentFile;
  private readonly token: string;
  private server: Server | null = null;
  private boundOrigin: string | null = null;

  constructor(deps: SenderServiceDeps) {
    // 缺部署装配拒启动：runtime/token/listen 配置缺一即抛错。
    if (!(deps.runtime instanceof FrozenSenderRuntime)) throw new Error('缺少冻结 HTTP sender 运行时装配，拒绝启动');
    const initialState = deps.runtime.state();
    if (initialState.privateProtocol !== 'dsh-public-chat-http-v1' ||
      !['explicit-grant-snapshot-v1', 'frozen-http-auth-v1', 'no-replay-http1-v1', 'unknown-recovery-v1'].every((capability) => initialState.capabilities?.includes(capability))) {
      throw new Error('sender 不支持冻结 HTTP 授权，拒绝启动');
    }
    if (typeof deps.token !== 'string' || deps.token.length === 0 || deps.token.length > 256) {
      throw new Error('缺少 sender token，拒绝启动');
    }
    const listen = parseSenderListenUrl(deps.deployment.listenUrl);
    if (!listen.ok) throw new Error(`部署监听地址无效：${listen.error}`);
    if (!deps.deployment.buildDigest || !deps.deployment.instanceId) throw new Error('缺少部署构建标识，拒绝启动');
    this.runtime = deps.runtime;
    this.deployment = deps.deployment;
    this.token = deps.token;
  }

  /** 启动数字 loopback 监听；返回实际 origin（端口 0 仅测试用）。 */
  start(): Promise<string> {
    const listen = parseSenderListenUrl(this.deployment.listenUrl);
    if (!listen.ok) return Promise.reject(new Error(listen.error));
    if ([3080, 3081, 7390, 8757].includes(listen.value.port)) return Promise.reject(new Error('shared port is forbidden'));
    if (this.server !== null) return Promise.resolve(this.boundOrigin ?? listen.value.origin);
    const host = listen.value.origin.includes('[::1]') ? '::1' : '127.0.0.1';
    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server = server;
    return new Promise<string>((resolveListen, rejectListen) => {
      server.once('error', (error: Error) => {
        this.server = null;
        rejectListen(error);
      });
      server.listen(listen.value.port, host, () => {
        const address = server.address();
        if (address === null || typeof address === 'string') {
          rejectListen(new Error('sender 监听地址异常'));
          return;
        }
        if ([3080, 3081, 7390, 8757].includes(address.port)) {
          server.close();
          this.server = null;
          rejectListen(new Error('allocated shared port is forbidden'));
          return;
        }
        this.boundOrigin = `http://127.0.0.1:${address.port}`;
        resolveListen(this.boundOrigin);
      });
    });
  }

  /** 关闭监听；测试用 finally 收尾依据。 */
  close(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.boundOrigin = null;
    if (server === null) return Promise.resolve();
    return new Promise((resolveClose, rejectClose) => {
      server.close((error) => {
        if (error) rejectClose(error);
        else resolveClose();
      });
      server.closeAllConnections();
    });
  }

  get origin(): string | null {
    return this.boundOrigin;
  }

  private envelope(extra: Record<string, unknown>): Record<string, unknown> {
    return {
      protocol: PUBLIC_CHAT_PROTOCOL,
      buildDigest: this.deployment.buildDigest,
      instanceId: this.deployment.instanceId,
      ...extra,
    };
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? '/', 'http://invalid.local');
      const method = request.method ?? '';
      // 无开放 CORS：不接受预检，不返回任何 CORS 头。
      if (method === 'OPTIONS') {
        this.reply(response, 405, this.envelope({ error: 'method not allowed' }));
        return;
      }
      if (!this.authorize(request)) {
        this.reply(response, 401, this.envelope({ error: 'unauthorized' }));
        return;
      }
      const routeKey = `${method} ${url.pathname}`;
      if (routeKey === ROUTES.state && method === 'GET') {
        const state = this.runtime.state();
        this.reply(response, 200, this.envelope({ ...state }));
        return;
      }
      if (routeKey === ROUTES.qualification && method === 'POST') {
        const bodyError = await this.readJsonBody(request);
        if (bodyError.ok === false) {
          this.reply(response, bodyError.status, this.envelope({ error: bodyError.error }));
          return;
        }
        const value = bodyError.value;
        if (!isObject(value) || Object.keys(value).length !== 2 || typeof value.captureId !== 'string' || typeof value.expectedSenderProcessNonce !== 'string') {
          this.reply(response, 400, this.envelope({ error: 'invalid capture request' }));
          return;
        }
        const record = await this.runtime.captureQualification(value.captureId, value.expectedSenderProcessNonce);
        if (!record) { this.reply(response, 503, this.envelope({ error: 'capture unavailable' })); return; }
        const state = this.runtime.state();
        this.reply(response, 200, this.envelope({ captureId: value.captureId, record,
          senderProcessNonce: state.processNonce, senderConnectionGeneration: state.senderConnectionGeneration,
          helper: state.helper, raw: state.raw }));
        return;
      }
      if (routeKey === ROUTES.authorize && method === 'POST') {
        const body = await this.readJsonBody(request);
        if (!body.ok) { this.reply(response, body.status, this.envelope({ error: body.error })); return; }
        const value = body.value;
        if (!isObject(value) || Object.keys(value).length !== 5 || typeof value.authorizationId !== 'string'
          || typeof value.expectedSenderProcessNonce !== 'string' || typeof value.qualificationToken !== 'string'
          || typeof value.localRevision !== 'string' || !isObject(value.target)) {
          this.reply(response, 400, this.envelope({ error: 'invalid authorization request' })); return;
        }
        const result = await this.runtime.authorizeGrant(value as unknown as FrozenAuthorizationRequest);
        this.reply(response, 200, this.envelope(result));
        return;
      }
      if (routeKey === ROUTES.revoke && method === 'POST') {
        const body = await this.readJsonBody(request);
        if (!body.ok) { this.reply(response, body.status, this.envelope({ error: body.error })); return; }
        const value = body.value;
        if (!isObject(value) || Object.keys(value).length !== 3 || typeof value.revokeId !== 'string'
          || typeof value.expectedSenderProcessNonce !== 'string' || !isObject(value.target)) {
          this.reply(response, 400, this.envelope({ error: 'invalid revoke request' })); return;
        }
        const result = await this.runtime.revokeControl(value as unknown as FrozenRevokeRequest);
        this.reply(response, 200, this.envelope(result));
        return;
      }
      if (method === 'GET' && url.pathname.startsWith('/v1/grant/operations/')) {
        const id = decodeURIComponent(url.pathname.slice('/v1/grant/operations/'.length));
        const record = await this.runtime.reconcileControlOperation(id);
        this.reply(response, 200, this.envelope(record === null ? { found: false } : { found: true, record }));
        return;
      }
      if (routeKey === ROUTES.send && method === 'POST') {
        const body = await this.readJsonBody(request);
        if (body.ok === false) {
          this.reply(response, body.status, this.envelope({ error: body.error }));
          return;
        }
        const parsed = validateFrozenSend(body.value);
        if (parsed === null) {
          this.reply(response, 400, this.envelope({ error: 'send 请求形状无效' }));
          return;
        }
        const wire = await this.runtime.send(parsed);
        if (!wire) { this.reply(response, 503, this.envelope({ error: 'send unavailable' })); return; }
        this.reply(response, 200, this.envelope({ ...wire }));
        return;
      }
      const reconciliationPath = /^\/v1\/operations\/([^/]+)\/reconcile$/.exec(url.pathname);
      if (method === 'POST' && reconciliationPath) {
        const body = await this.readJsonBody(request);
        if (!body.ok) { this.reply(response, body.status, this.envelope({ error: body.error })); return; }
        const id = decodeURIComponent(reconciliationPath[1]);
        if (!validMessageReconcileRequest(body.value) || body.value.ref.requestId !== id) {
          this.reply(response, 400, this.envelope({ error: 'invalid recovery request' }));
          return;
        }
        const record = await this.runtime.reconcileMessage(body.value);
        if (!record) { this.reply(response, 503, this.envelope({ error: 'recovery unavailable' })); return; }
        this.reply(response, 200, this.envelope({ registered: true, record }));
        return;
      }
      if (method === 'GET' && url.pathname.startsWith('/v1/operations/')) {
        const requestId = decodeURIComponent(url.pathname.slice('/v1/operations/'.length));
        const wire = await this.runtime.reconcileOperation(requestId) ?? this.runtime.operation(requestId);
        this.reply(response, 200, this.envelope(wire ? { found: true, record: wire } : { found: false }));
        return;
      }
      // 旧路由与一切未注册路径：明确拒绝，零副作用。
      this.reply(response, 404, this.envelope({ error: 'route disabled' }));
    } catch {
      this.reply(response, 500, this.envelope({ error: 'internal error' }));
    }
  }

  /** 常数时间 token 比较；无凭据调用一律拒绝。 */
  private authorize(request: IncomingMessage): boolean {
    const header = request.headers.authorization ?? '';
    const match = /^Bearer ([^\s]+)$/.exec(Array.isArray(header) ? header.join(',') : header);
    if (match === null) return false;
    const provided = Buffer.from(match[1], 'utf8');
    const expected = Buffer.from(this.token, 'utf8');
    if (provided.length !== expected.length) return false;
    return timingSafeEqual(provided, expected);
  }

  private async readJsonBody(request: IncomingMessage): Promise<
    { ok: true; value: unknown } | { ok: false; status: number; error: string }
  > {
    const contentType = request.headers['content-type'];
    const value = Array.isArray(contentType) ? contentType.join(';') : contentType;
    if (value === undefined || !value.includes('application/json')) {
      return { ok: false, status: 400, error: 'content-type 必须是 application/json' };
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const body = await new Promise<Buffer | null>((resolveBody) => {
      request.on('data', (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > MAX_WIRE_BODY_BYTES) {
          resolveBody(null);
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.on('end', () => resolveBody(Buffer.concat(chunks)));
      request.on('error', () => resolveBody(null));
    });
    if (body === null) return { ok: false, status: 400, error: '请求体超过本地上限' };
    try {
      const parsed: unknown = parseHelperJSON(body);
      if (!isObject(parsed)) return { ok: false, status: 400, error: '请求体必须是 JSON 对象' };
      return { ok: true, value: parsed };
    } catch {
      return { ok: false, status: 400, error: '请求体不是合法 JSON' };
    }
  }

  private reply(response: ServerResponse, status: number, body: Record<string, unknown>): void {
    if (response.writableEnded) return;
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(JSON.stringify(body));
  }
}
