/** 受保护 v1 客户端防护：真实 HTTP fixture 的丢响应/迟到/重定向/非 JSON/摘要不符（FEAT-008 API-8）。 */
import { describe, expect, it, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SEND_HTTP_TIMEOUT_MS } from '../../src/publicChat/protocol';
import { SenderClient } from '../../src/publicChat/senderClient';
import { TEST_BUILD_DIGEST, TEST_INSTANCE_ID } from './test-helpers';

const TOKEN = 'client-guard-token';
const cleanup: Server[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((server) => new Promise<void>((resolveClose) => {
    server.close(() => resolveClose());
    server.closeAllConnections();
  })));
});

function listen(server: Server): Promise<string> {
  return new Promise((resolveListen) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolveListen(`http://127.0.0.1:${address.port}`);
    });
  });
}

function makeClient(origin: string, timeoutMs = 800): SenderClient {
  return new SenderClient({
    url: origin,
    token: TOKEN,
    expected: { buildDigest: TEST_BUILD_DIGEST, instanceId: TEST_INSTANCE_ID },
    timeoutMs,
  });
}

function envelope(extra: Record<string, unknown>): Record<string, unknown> {
  return { protocol: 'dsh-public-chat-v1', buildDigest: TEST_BUILD_DIGEST, instanceId: TEST_INSTANCE_ID, ...extra };
}

describe('SenderClient 传输与绑定防护（真实 HTTP）', () => {
  it('丢响应：服务端不响应 → 本地超时 → 传输失败（unknown 类别）', async () => {
    const server = createServer(() => { /* 永不响应 */ });
    cleanup.push(server);
    const origin = await listen(server);
    const result = await makeClient(origin).state();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.untrusted).toBe(false);
      expect(result.error).toContain('超时');
    }
  });

  it('迟到响应：客户端超时后到达，不影响已得出的 unknown', async () => {
    let responded = false;
    const server = createServer((_request, response) => {
      setTimeout(() => {
        responded = true;
        try {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify(envelope({})));
        } catch { /* 客户端已断开 */ }
      }, 1_500);
    });
    cleanup.push(server);
    const origin = await listen(server);
    const result = await makeClient(origin).state();
    expect(result.ok).toBe(false);
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_600));
    expect(responded).toBe(true);
  });

  it('HTTP 重定向拒绝（redirect: error）', async () => {
    const target = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(envelope({})));
    });
    cleanup.push(target);
    const targetOrigin = await listen(target);
    const redirector = createServer((_request, response) => {
      response.writeHead(302, { location: targetOrigin });
      response.end();
    });
    cleanup.push(redirector);
    const origin = await listen(redirector);
    const result = await makeClient(origin).state();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.untrusted).toBe(false);
  });

  it('非 JSON 响应按不可信处理', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<html>not json</html>');
    });
    cleanup.push(server);
    const origin = await listen(server);
    const result = await makeClient(origin).state();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.untrusted).toBe(true);
  });

  it('buildDigest/instanceId 不符 → 不可信响应（拒绝伪装实例）', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ protocol: 'dsh-public-chat-v1', buildDigest: 'ff'.repeat(32), instanceId: TEST_INSTANCE_ID }));
    });
    cleanup.push(server);
    const origin = await listen(server);
    const result = await makeClient(origin).state();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.untrusted).toBe(true);
      expect(result.error).toContain('buildDigest');
    }
  });

  it('协议版本不符 → 不可信响应', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ protocol: 'dsh-public-chat-v0', buildDigest: TEST_BUILD_DIGEST, instanceId: TEST_INSTANCE_ID }));
    });
    cleanup.push(server);
    const origin = await listen(server);
    const result = await makeClient(origin).state();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.untrusted).toBe(true);
  });

  it('默认 HTTP 超时合同为 15 秒（本地限制，不冒称平台限额）', () => {
    expect(SEND_HTTP_TIMEOUT_MS).toBe(15_000);
    const defaulted = new SenderClient({
      url: 'http://127.0.0.1:1',
      token: TOKEN,
      expected: { buildDigest: TEST_BUILD_DIGEST, instanceId: TEST_INSTANCE_ID },
    });
    expect(defaulted.effectiveTimeoutMs).toBe(SEND_HTTP_TIMEOUT_MS);
    expect(defaulted.effectiveTimeoutMs).toBe(15_000);
  });
});
