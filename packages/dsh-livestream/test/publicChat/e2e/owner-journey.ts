import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect } from 'vitest';
import { runManagedAgent } from './managed-agent';

interface Inputs {
  root: string;
  fixtureRoot: string;
  bundlePath: string;
  senderManifest: string;
  senderManifestSha256: string;
  exportPath: string;
  helperManifest: string;
  helperManifestSha256: string;
  helperSource: string;
  material: string;
  browserExecutable: string;
  rawPidFile: string;
  presetPath: string;
  emitRaw(id: number, rawType?: string): void;
  browser: any;
  chatCount(): number;
  wireCount(): number;
  chatTexts(): string[];
}

async function listen(server: ReturnType<typeof createServer>, port = 0): Promise<number> {
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture listener unavailable');
  return address.port;
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeIdleConnections();
  });
}

/** Original Console and actual connection SDK, with only task-owned synthetic endpoints. */
export async function runOwnerJourney(input: Inputs): Promise<void> {
  const requireFixture = createRequire(join(input.fixtureRoot, 'fixture-runner.cjs'));
  const { WebSocketServer } = requireFixture('ws');
  const requirePackage = createRequire(join(process.cwd(), 'package.json'));
  const esbuild = requirePackage('esbuild');
  const jsPath = join(input.root, 'console-fixture.js');
  await esbuild.build({ entryPoints: [join(process.cwd(), 'test/publicChat/e2e/console-fixture.tsx')],
    outfile: jsPath, bundle: true, platform: 'browser', format: 'iife', target: 'chrome120', logLevel: 'silent' });
  const sdkRoot = '/Users/mac/hansen_agent_team/workspace/20261110-qdroid-dsh-t1/dsh-qdroid/node_modules';
  const { Context } = await import(/* @vite-ignore */ pathToFileURL(join(sdkRoot, '@deepseek-ai/cordis/lib/index.js')).href);
  const { HostConnectionService } = await import(/* @vite-ignore */ pathToFileURL(join(sdkRoot, '@deepseek-ai/dsh-client-connection/lib/index.js')).href);
  const context = new Context();
  const connection = new HostConnectionService(context, [], {
    isAuthenticated: (request: IncomingMessage) => request.headers['x-fixture-owner'] === 'owner-fixture',
    authenticateApi: () => undefined,
  });
  const registered = connection.fetch;
  let calls = 0;
  const disposers: Array<{ label: string; dispose: () => void | Promise<void> }> = [];
  const hostContext = {
    effect(effect: () => unknown, label?: string) {
      if (!['state', 'settings', 'public chat', 'dsh-livestream public chat'].includes(label ?? '')) return;
      const dispose = effect();
      if (typeof dispose === 'function') disposers.push({ label: label ?? '', dispose: dispose as () => void | Promise<void> });
    },
    get() { return undefined; },
    provide() {},
    connection: {
      fetch: {
        register(route: { fetch: (request: Request) => Promise<Response>; [key: string]: unknown }) {
          return registered.register({ ...route, fetch: (request: Request) => { calls++; return route.fetch(request); } });
        },
      },
    },
  };
  const home = process.env.DSH_HOME;
  if (!home) throw new Error('fixture home missing');
  const dataDir = join(home, 'dsh-livestream');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ stagePort: 0, stageToken: 'fixture-stage-token',
    livePlatform: 'douyin', douyinRoomId: '101' }), { mode: 0o600 });

  const bridge = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ room: { roomId: '101', status: 'live' } }));
  });
  const sockets = new WebSocketServer({ noServer: true });
  let bridgeSocket: { send(value: string): void } | null = null;
  bridge.on('upgrade', (request, socket, head) => {
    if (request.url !== '/ws?roomId=101') { socket.destroy(); return; }
    sockets.handleUpgrade(request, socket, head, (ws: { send(value: string): void }) => {
      bridgeSocket = ws;
      ws.send(JSON.stringify({ type: '__connected', roomId: '101', room: { roomId: '101', status: 'live' } }));
    });
  });
  const bridgePort = await listen(bridge);
  const reserved = createServer();
  const senderPort = await listen(reserved);
  await closeServer(reserved);
  const trustedData = join(input.root, 'owner-journey-data');
  mkdirSync(trustedData, { mode: 0o700 });
  const deployment = join(input.root, 'owner-journey-deployment.json');
  writeFileSync(deployment, JSON.stringify({ schemaVersion: 1, listenUrl: `http://127.0.0.1:${senderPort}`,
    token: 'fixture-token', expectedPrincipalUid: '42', roomId: '101', accountRecordId: 'record',
    buildDigest: input.senderManifestSha256, instanceId: 'instance', profileOrigin: 'https://www.douyin.com', dataDir: trustedData }),
  { flag: 'wx', mode: 0o600 });
  const senderBuild = join(input.root, 'owner-journey-build.json');
  writeFileSync(senderBuild, JSON.stringify({ bundlePath: input.bundlePath, manifestPath: input.senderManifest,
    manifestSha256: input.senderManifestSha256, exportPath: input.exportPath }), { flag: 'wx', mode: 0o600 });
  const env = {
    DSH_PUBLIC_CHAT_BUILD_DEPLOYMENT_FILE: senderBuild,
    DSH_PUBLIC_CHAT_DEPLOYMENT_FILE: deployment,
    DSH_PUBLIC_CHAT_BROWSER_EXECUTABLE: input.browserExecutable,
    DSH_PUBLIC_CHAT_HELPER_MANIFEST: input.helperManifest,
    DSH_PUBLIC_CHAT_HELPER_MANIFEST_SHA256: input.helperManifestSha256,
    DSH_PUBLIC_CHAT_HELPER_SOURCE_DIRECTORY: input.helperSource,
    DSH_PUBLIC_CHAT_MATERIAL_FILE: input.material,
    DSH_PUBLIC_CHAT_HELPER_DATA_DIR: trustedData,
  };
  const prior = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  const helperBinary = JSON.parse(readFileSync(input.helperManifest, 'utf8')).binaryPath;
  const helperPids = () => (process as unknown as {
    _getActiveHandles(): Array<{ spawnfile?: string; pid?: number }>;
  })._getActiveHandles().filter((handle) => handle.spawnfile === helperBinary && handle.pid).map((handle) => handle.pid!);
  const originalFetch = globalThis.fetch;
  let releaseAuthorization: (() => void) | undefined;
  const externalPort = Number(process.env.DSH_PUBLIC_CHAT_E2E_PORT ?? 0);
  const externalJourney = Number.isSafeInteger(externalPort) && externalPort > 0;
  let holdFirstAuthorization = !externalJourney;
  let finishExternal!: () => void;
  const externalFinished = new Promise<void>((resolve) => { finishExternal = resolve; });
  const initialChatCount = input.chatCount();
  const initialWireCount = input.wireCount();
  let senderRequests = 0;
  let announceAuthorization!: () => void;
  const authorizationArrived = new Promise<void>((resolve) => { announceAuthorization = resolve; });
  globalThis.fetch = async (resource, options) => {
    const url = new URL(resource instanceof Request ? resource.url : String(resource));
    if (url.hostname === '127.0.0.1' && Number(url.port) === senderPort) senderRequests++;
    const response = await originalFetch(resource, options);
    if (holdFirstAuthorization && url.hostname === '127.0.0.1' && Number(url.port) === senderPort && url.pathname === '/v1/grant/authorize') {
      holdFirstAuthorization = false;
      await new Promise<void>((resolve) => { releaseAuthorization = resolve; announceAuthorization(); });
    }
    return response;
  };
  let app: ReturnType<typeof createServer> | null = null;
  let browserContext: any = null;
  let runtime: typeof import('../../../src/dsh/runtime') | null = null;
  const ownedHelperPids: number[] = [];
  try {
    const builtRoot = process.env.DSH_PUBLIC_CHAT_COVERAGE_SOURCE === '1' ? undefined : process.env.DSH_PUBLIC_CHAT_BUILT_ROOT;
    runtime = builtRoot
      ? await import(/* @vite-ignore */ pathToFileURL(process.env.DSH_PUBLIC_CHAT_BUILT_RUNTIME!).href)
      : await import('../../../src/dsh/runtime');
    const host = builtRoot
      ? await import(/* @vite-ignore */ pathToFileURL(join(builtRoot, 'index.js')).href)
      : await import('../../../src/dsh/index');
    if (externalJourney && builtRoot) {
      const senderModule = await import(/* @vite-ignore */ pathToFileURL(process.env.DSH_PUBLIC_CHAT_BUILT_SENDER!).href);
      const originalClose = senderModule.TrustedSender.prototype.close;
      senderModule.TrustedSender.prototype.close = async function () {
        const wrap = (owner: any, method: string, label: string) => {
          const original = owner[method];
          owner[method] = async function (...args: unknown[]) {
            console.info(`owner-journey-cleanup ${label}-start`);
            try {
              const result = await original.apply(this, args);
              if (label.startsWith('helper-')) expect(() => process.kill(Number(label.slice(7)), 0)).toThrow();
              return result;
            } finally { console.info(`owner-journey-cleanup ${label}-end`); }
          };
        };
        wrap(this.raw, 'stop', 'raw');
        wrap(this.service, 'close', 'service');
        for (const helper of this.helpers) wrap(helper, 'close', `helper-${helper.pid}`);
        return originalClose.call(this);
      };
    }
    host.apply(hostContext as any);
    const handler = connection.createSharedFetchHandler('/api');
    const guest = connection.createPeer({ principal: { kind: 'guest' } });
    const denied = await handler.fetch(new Request('http://127.0.0.1/api/dsh-livestream/public-chat'), guest);
    expect(denied.status).toBe(403);
    const deniedSend = await handler.fetch(new Request('http://127.0.0.1/api/dsh-livestream/public-chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'send', requestId: 'guest', text: '普通文字' }),
    }), guest);
    expect(deniedSend.status).toBe(403);
    expect(connection.admit({ headers: { host: '127.0.0.1' } })).toEqual({ rejection: 401 });
    expect(calls).toBe(0);
    await guest.dispose();

    runtime.show.connectTarget({ platform: 'douyin', roomId: '101', bridgeUrl: `http://127.0.0.1:${bridgePort}` });
    const deadline = Date.now() + 5000;
    while (!runtime.show.hub.isConnected) {
      if (Date.now() > deadline) throw new Error('actual source did not connect');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    runtime.show.goLive('fixture-session');
    app = createServer((request: IncomingMessage, response: ServerResponse) => {
      void (async () => {
        if (externalJourney && request.url === '/fixture-counts') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ initialChatCount, initialWireCount, chatCount: input.chatCount(),
            wireCount: input.wireCount(), senderRequests, helperCount: helperPids().length }));
          return;
        }
        if (externalJourney && request.url === '/fixture-restart-host') {
          for (const item of disposers.splice(0).reverse()) await item.dispose();
          if (!runtime) throw new Error('runtime unavailable');
          runtime.show.endLive();
          (runtime.show as any).finish();
          runtime.show.disconnect();
          delete process.env.DSH_PUBLIC_CHAT_MATERIAL_FILE;
          host.apply(hostContext as any);
          const peer = connection.createPeer({ principal: { kind: 'owner' } });
          try {
            const reads = Array.from({ length: 12 }, () => handler.fetch(
              new Request('http://127.0.0.1/api/dsh-livestream/public-chat'), peer));
            const action = (body: object) => handler.fetch(new Request('http://127.0.0.1/api/dsh-livestream/public-chat', {
              method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
            }), peer);
            const [views, maintain, missingControl] = await Promise.all([
              Promise.all(reads).then((responses) => Promise.all(responses.map((entry) => entry.json()))),
              action({ action: 'maintain' }).then((entry) => entry.json()),
              action({ action: 'reconcile-control', controlId: 'fixture-missing-control' }).then((entry) => entry.json()),
            ]);
            expect(views.every((entry: any) => entry.publicChat.historyAvailable && entry.publicChat.hold)).toBe(true);
            expect(maintain.ok).toBe(false);
            expect(missingControl.ok).toBe(false);
            expect(helperPids()).toEqual([]);
          } finally { await peer.dispose(); }
          response.writeHead(204); response.end(); return;
        }
        if (externalJourney && request.url === '/fixture-missing-history') {
          for (const item of disposers.splice(0).reverse()) await item.dispose();
          delete process.env.DSH_PUBLIC_CHAT_BUILD_DEPLOYMENT_FILE;
          host.apply(hostContext as any);
          response.writeHead(204); response.end(); return;
        }
        if (externalJourney && request.url === '/fixture-corrupt-history') {
          for (const item of disposers.splice(0).reverse()) await item.dispose();
          process.env.DSH_PUBLIC_CHAT_BUILD_DEPLOYMENT_FILE = env.DSH_PUBLIC_CHAT_BUILD_DEPLOYMENT_FILE;
          writeFileSync(join(trustedData, 'public-chat-operations.json'), '{invalid fixture journal', { mode: 0o600 });
          host.apply(hostContext as any);
          response.writeHead(204); response.end(); return;
        }
        if (externalJourney && request.url === '/fixture-resume-live') {
          if (!runtime) throw new Error('runtime unavailable');
          process.env.DSH_PUBLIC_CHAT_MATERIAL_FILE = env.DSH_PUBLIC_CHAT_MATERIAL_FILE;
          runtime.show.connectTarget({ platform: 'douyin', roomId: '101', bridgeUrl: `http://127.0.0.1:${bridgePort}` });
          const deadline = Date.now() + 5000;
          while (!runtime.show.hub.isConnected) {
            if (Date.now() > deadline) throw new Error('source did not reconnect');
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          runtime.show.goLive('fixture-session-next');
          response.writeHead(204); response.end(); return;
        }
        if (externalJourney && request.url === '/fixture-finish') {
          response.once('finish', finishExternal);
          response.writeHead(204); response.end(); return;
        }
        if (request.url === '/') {
          response.writeHead(200, { 'content-type': 'text/html' });
          response.end('<!doctype html><html><body><div id="app"></div><script src="/console.js"></script></body></html>');
          return;
        }
        if (request.url === '/console.js') {
          response.writeHead(200, { 'content-type': 'text/javascript' });
          response.end(readFileSync(jsPath));
          return;
        }
        const admission = connection.admit(request);
        if ('rejection' in admission) { response.writeHead(admission.rejection); response.end(); return; }
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks);
        const result = await handler.fetch(new Request(`http://127.0.0.1${request.url}`, {
          method: request.method, headers: { 'content-type': 'application/json' },
          ...(body.length ? { body } : {}),
        }), admission.peer);
        response.writeHead(result.status, Object.fromEntries(result.headers.entries()));
        response.end(Buffer.from(await result.arrayBuffer()));
      })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
    });
    const appPort = await listen(app, externalJourney ? externalPort : 0);
    if (externalJourney) {
      console.info(`owned-e2e-journey-listener pid=${process.pid} port=${appPort}`);
      await externalFinished;
      return;
    }
    browserContext = await input.browser.newContext({ viewport: { width: 1440, height: 900 },
      extraHTTPHeaders: { 'x-fixture-owner': 'owner-fixture' } });
    await browserContext.tracing.start({ screenshots: true, snapshots: true, sources: true });
    const page = await browserContext.newPage();
    await page.goto(`http://127.0.0.1:${appPort}/`);
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const panel = page.locator('.dl-drawer').getByRole('heading', { name: '公屏文字' }).locator('..');
    const before = input.chatCount();
    const wireBeforeSave = input.wireCount();
    expect(senderRequests).toBe(0);
    expect(helperPids()).toEqual([]);
    await panel.getByLabel('启用公屏发送').check();
    await panel.getByLabel('允许当前公屏事件的 Agent 回复').check();
    await panel.getByLabel('欢迎观众进场').check();
    await panel.getByLabel('感谢礼物').check();
    await panel.getByLabel('手动文字草稿').fill('普通文字');
    await panel.getByRole('button', { name: '保存公屏设置' }).click();
    await panel.getByText('设置已保存；尚未核查或授权发送').waitFor();
    expect(input.chatCount()).toBe(before);
    expect(input.wireCount()).toBe(wireBeforeSave);
    expect(senderRequests).toBe(0);
    expect(helperPids()).toEqual([]);
    expect(readFileSync(join(dataDir, 'settings.json'), 'utf8')).toContain('普通文字');
    await panel.getByRole('button', { name: '维护发送材料' }).click();
    await panel.getByText('发送服务：已装配').waitFor({ timeout: 30000 });
    ownedHelperPids.push(...helperPids());
    expect(ownedHelperPids.length).toBe(1);
    expect(input.chatCount()).toBe(before);
    await panel.getByRole('button', { name: '核查资格' }).click();
    await panel.getByText(/资格：已核查/).waitFor();
    expect(input.chatCount()).toBe(before);
    await panel.getByRole('button', { name: '明确授权' }).click();
    await authorizationArrived;
    expect(input.chatCount()).toBe(before);
    expect(await panel.getByRole('button', { name: '发送这条文字' }).isDisabled()).toBe(true);
    const owner = connection.admit({ headers: { host: '127.0.0.1', 'x-fixture-owner': 'owner-fixture' } });
    if ('rejection' in owner) throw new Error('fixture owner admission failed');
    const early = await handler.fetch(new Request('http://127.0.0.1/api/dsh-livestream/public-chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'send', requestId: 'before-owner-ack', text: '普通文字' }),
    }), owner.peer);
    expect((await early.json()).result.status).toBe('rejected');
    expect(input.chatCount()).toBe(before);
    releaseAuthorization?.();
    await panel.getByText(/授权：已授权/).waitFor();
    expect(input.chatCount()).toBe(before);
    await panel.getByRole('button', { name: '发送这条文字' }).click();
    await panel.getByText(/接口返回成功码，观众未核对/).waitFor({ timeout: 10000 });
    expect(input.chatCount()).toBe(before + 1);
    const [duplicate] = await Promise.all([
      page.waitForResponse((response: any) => response.url().endsWith('/api/dsh-livestream/public-chat')
        && response.request().method() === 'POST' && response.request().postDataJSON()?.action === 'send'),
      panel.getByRole('button', { name: '发送这条文字' }).click(),
    ]);
    expect((await duplicate.json()).result.status).toBe('duplicate');
    expect(input.chatCount()).toBe(before + 1);
    if (!runtime) throw new Error('host runtime unavailable');
    await runManagedAgent({ presetPath: input.presetPath, runtime,
      builtAgent: builtRoot ? join(builtRoot, 'agent.js') : undefined,
      emitRaw: input.emitRaw,
      emitSource(id, text) {
        if (!bridgeSocket) throw new Error('source socket unavailable');
        bridgeSocket.send(JSON.stringify({ type: 'chat', roomId: '101', platform: 'douyin', id: String(id),
          ts: Date.now(), rawMethod: 'WebcastChatMessage', data: { content: text }, user: { id: 'viewer', nickname: '观众' } }));
      },
      chatCount: input.chatCount });
    expect(input.chatCount()).toBe(before + 2);
    const emitSource = (id: number, type: 'member' | 'gift', data: Record<string, unknown>) => {
      if (!bridgeSocket) throw new Error('source socket unavailable');
      bridgeSocket.send(JSON.stringify({ type, roomId: '101', platform: 'douyin', id: String(id), ts: Date.now(),
        rawMethod: type === 'member' ? 'WebcastMemberMessage' : 'WebcastGiftMessage',
        data, user: { id: 'viewer-auto', nickname: '观众' } }));
    };
    const waitCount = async (count: number, timeout = 10000) => {
      const deadline = Date.now() + timeout;
      while (input.chatCount() < count) {
        if (Date.now() > deadline) throw new Error(`automatic chat count ${input.chatCount()} expected ${count}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    input.emitRaw(902, 'WebcastMemberMessage');
    await new Promise((resolve) => setTimeout(resolve, 200));
    emitSource(902, 'member', {});
    await waitCount(before + 3);
    input.emitRaw(903, 'WebcastMemberMessage');
    await new Promise((resolve) => setTimeout(resolve, 200));
    emitSource(903, 'member', {});
    input.emitRaw(904, 'WebcastGiftMessage');
    input.emitRaw(905, 'WebcastGiftMessage');
    await new Promise((resolve) => setTimeout(resolve, 200));
    emitSource(904, 'gift', { giftId: '1', giftName: '小星星', repeatCount: 1, groupId: '9' });
    emitSource(905, 'gift', { giftId: '1', giftName: '小星星', repeatCount: 3, groupId: '9' });
    await waitCount(before + 4, 15000);
    expect(input.chatTexts().slice(-2)).toEqual(['欢迎 观众 来到直播间', '谢谢 观众 送的 小星星']);
    // A dropped response after the real helper Write stays unknown until the
    // owner records a matching observation and reconciles that original ID.
    await panel.getByLabel('手动文字草稿').fill('fixture message');
    await panel.getByRole('button', { name: '发送这条文字' }).click();
    await panel.getByText(/结果未知，需核对原请求/).waitFor({ timeout: 20000 });
    expect(input.chatCount()).toBe(before + 5);
    const readView = async () => {
      const result = await handler.fetch(new Request('http://127.0.0.1/api/dsh-livestream/public-chat'), owner.peer);
      return (await result.json()).publicChat;
    };
    let currentView = await readView();
    const unknown = currentView.messages.find((message: { state: string }) => message.state === 'unknown');
    if (!unknown) throw new Error('original unknown not exposed');
    expect(currentView.hold).toBe(true);
    const recovery = panel.getByRole('heading', { name: `核对原请求 ${unknown.requestId}` }).locator('..');
    await page.screenshot({ path: join(input.fixtureRoot, `output/owner-unknown-${process.pid}-1440.png`) });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({ path: join(input.fixtureRoot, `output/owner-unknown-${process.pid}-375.png`) });
    await recovery.getByLabel('备注或未看到').fill('没有看到');
    await recovery.getByLabel('备注或未看到').press('Tab');
    expect(await recovery.getByRole('button', { name: '记录备注' }).evaluate((element: Element) => document.activeElement === element)).toBe(true);
    const [noteResponse] = await Promise.all([
      page.waitForResponse((response: any) => response.url().endsWith('/api/dsh-livestream/public-chat')
        && response.request().method() === 'POST' && response.request().postDataJSON()?.action === 'record-fact'),
      recovery.getByRole('button', { name: '记录备注' }).click(),
    ]);
    expect((await noteResponse.json()).ok).toBe(true);
    currentView = await readView();
    expect(currentView.hold).toBe(true);
    expect(input.chatCount()).toBe(before + 5);
    await recovery.getByLabel('观察到的 UID').fill('999');
    await recovery.getByLabel('观察到的房间').fill(unknown.grant.roomId);
    await recovery.getByLabel('观察到的内部房间').fill(unknown.grant.platformRoomId);
    await recovery.getByLabel('观察到的内容摘要').fill(unknown.textDigest);
    await recovery.getByLabel('观察时间（毫秒）').fill(String(Date.now()));
    const [wrongResponse] = await Promise.all([
      page.waitForResponse((response: any) => response.url().endsWith('/api/dsh-livestream/public-chat')
        && response.request().method() === 'POST' && response.request().postDataJSON()?.action === 'record-fact'),
      recovery.getByRole('button', { name: '记录正面观察' }).click(),
    ]);
    expect((await wrongResponse.json()).ok).toBe(false);
    expect((await readView()).hold).toBe(true);
    await recovery.getByLabel('观察到的 UID').fill(unknown.grant.principalUid);
    const [observationResponse] = await Promise.all([
      page.waitForResponse((response: any) => response.url().endsWith('/api/dsh-livestream/public-chat')
        && response.request().method() === 'POST' && response.request().postDataJSON()?.action === 'record-fact'),
      recovery.getByRole('button', { name: '记录正面观察' }).click(),
    ]);
    expect((await observationResponse.json()).ok).toBe(true);
    const [reconcileResponse] = await Promise.all([
      page.waitForResponse((response: any) => response.url().endsWith('/api/dsh-livestream/public-chat')
        && response.request().method() === 'POST' && response.request().postDataJSON()?.action === 'reconcile-message'),
      recovery.getByRole('button', { name: '按原请求核对' }).click(),
    ]);
    const reconciled = await reconcileResponse.json();
    console.info(`owner-reconcile result=${JSON.stringify(reconciled)}`);
    expect(reconciled.ok).toBe(true);
    currentView = await readView();
    const original = currentView.messages.find((message: { requestId: string }) => message.requestId === unknown.requestId);
    expect(original.state).toBe('unknown');
    expect(original.recovery.state).toBe('committed');
    expect(currentView.hold).toBe(false);
    expect(input.chatCount()).toBe(before + 5);
    console.info(`owner-unknown-recovery request=${unknown.requestId} original=unknown recovery=committed chat-count=${input.chatCount()}`);
    await page.screenshot({ path: join(input.fixtureRoot, `output/owner-drawer-${process.pid}-1440.png`) });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({ path: join(input.fixtureRoot, `output/owner-drawer-${process.pid}-375.png`) });
    const beforeDisableSave = senderRequests;
    await panel.getByLabel('启用公屏发送').uncheck();
    await panel.getByRole('button', { name: '保存公屏设置' }).click();
    await panel.getByText('设置已保存；尚未核查或授权发送').waitFor();
    expect(senderRequests).toBe(beforeDisableSave);
    await panel.getByRole('button', { name: '撤权' }).click();
    await panel.getByText(/授权：未授权/).waitFor();
    const afterRevoke = await handler.fetch(new Request('http://127.0.0.1/api/dsh-livestream/public-chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'send', requestId: 'after-owner-revoke', text: '普通文字' }),
    }), owner.peer);
    expect((await afterRevoke.json()).result.status).toBe('rejected');
    expect(input.chatCount()).toBe(before + 5);
    console.info(`owner-sdk-drawer chat-before=${before} chat-after=${input.chatCount()} app-port=${appPort} bridge-port=${bridgePort}`);
  } finally {
    releaseAuthorization?.();
    globalThis.fetch = originalFetch;
    if (externalJourney && app) {
      app.closeAllConnections();
      await closeServer(app);
      app = null;
      console.info('owner-journey-cleanup external-app-end');
    }
    if (browserContext) {
      await browserContext.tracing.stop({ path: join(input.fixtureRoot, `output/owner-journey-${process.pid}-trace.zip`) });
      await browserContext.close();
    }
    console.info('owner-journey-cleanup disposers-start');
    for (const item of disposers.reverse()) {
      console.info(`owner-journey-cleanup effect-start=${item.label}`);
      const result = item.dispose();
      console.info(`owner-journey-cleanup effect-return=${item.label} type=${typeof result} then=${typeof (result as any)?.then}`);
      await result;
      console.info(`owner-journey-cleanup effect-end=${item.label}`);
    }
    console.info('owner-journey-cleanup disposers-end');
    runtime?.show.dispose();
    await context.fiber.dispose();
    console.info('owner-journey-cleanup context-end');
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve) => sockets.close(resolve));
    console.info('owner-journey-cleanup sockets-end');
    if (app) await closeServer(app);
    console.info('owner-journey-cleanup app-end');
    await closeServer(bridge);
    console.info('owner-journey-cleanup bridge-end');
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    for (const pid of ownedHelperPids) {
      expect(() => process.kill(pid, 0)).toThrow();
      console.info(`owner-journey-helper-pid=${pid} reaped`);
    }
    if (existsSync(input.rawPidFile)) {
      const pid = Number(readFileSync(input.rawPidFile, 'utf8'));
      expect(() => process.kill(pid, 0)).toThrow();
      console.info(`owner-journey-raw-browser-pid=${pid} reaped`);
    }
  }
}
