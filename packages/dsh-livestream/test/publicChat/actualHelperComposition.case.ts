import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import * as fs from 'node:fs';
import * as https from 'node:https';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { PublicChatSendController } from '../../src/publicChat/controller';
import type { FrozenJournalMessage, FrozenPublicChatOperationJournal } from '../../src/publicChat/frozenJournal';
import type { FrozenSenderRuntime } from '../../src/publicChat/frozenSenderRuntime';
import type { FrozenGrantProposal, FrozenGrantSnapshot } from '../../src/publicChat/frozenGrant';
import type { HelperProcess, launchHelper } from '../../src/publicChat/helperLauncher';
import type { SenderClient } from '../../src/publicChat/senderClient';
import type { SenderService } from '../../src/publicChat/senderService';
import { startTrustedSender as startSourceTrustedSender, type TrustedSender } from '../../src/publicChat/trustedSender';
import { trustedReferencesFromEnvironment } from '../../src/publicChat/trustedReferences';
import { runOwnerJourney } from './e2e/owner-journey';

const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const messageReference = (message: FrozenJournalMessage) => ({ requestId: message.requestId, sourceKey: message.sourceKey,
  requestHash: message.requestHash, helperPayloadHash: message.helperPayloadHash, textDigest: message.textDigest, grant: message.grant });

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('fixture condition timed out');
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
}

describe('actual helper process and TLS recovery composition', () => {
  it('retains the original unknown until its actual helper receipt is published and saved', async () => {
    const fixtureRoot = process.env.DSH_PUBLIC_CHAT_FIXTURE_ROOT;
    if (!fixtureRoot) throw new Error('isolated fixture root required');
    const bundlePath = process.env.DSH_PUBLIC_CHAT_SENDER_BUNDLE;
    const manifestPath = process.env.DSH_PUBLIC_CHAT_SENDER_MANIFEST;
    const expectedManifestSha256 = process.env.DSH_PUBLIC_CHAT_SENDER_MANIFEST_SHA256;
    const exportPath = process.env.DSH_PUBLIC_CHAT_RAW_EXPORT;
    if (!bundlePath || !manifestPath || !expectedManifestSha256 || !exportPath) throw new Error('verified sender fixture required');
    const root = fs.mkdtempSync(join(fixtureRoot, 'actual-helper-'));
    const senderDeploymentPath = join(root, 'sender-deployment.json');
    fs.writeFileSync(senderDeploymentPath, JSON.stringify({ bundlePath, manifestPath, exportPath,
      manifestSha256: expectedManifestSha256 }), { flag: 'wx', mode: 0o600 });
    const builtRoot = process.env.DSH_PUBLIC_CHAT_BUILT_ROOT;
    const loaderPath = builtRoot ? join(builtRoot, 'chunks/dyhub/verified_sender_loader.mjs')
      : fileURLToPath(new URL('../../src/publicChat/dyhub/verified_sender_loader.mjs', import.meta.url));
    const startTrustedSender: typeof startSourceTrustedSender = builtRoot
      ? (await import(/* @vite-ignore */ pathToFileURL(process.env.DSH_PUBLIC_CHAT_BUILT_SENDER!).href)).startTrustedSender
      : startSourceTrustedSender;
    const loader = await import(/* @vite-ignore */ pathToFileURL(loaderPath).href) as {
      loadVerifiedSender(path: string): Promise<unknown>;
    };
    const bundle = await loader.loadVerifiedSender(senderDeploymentPath) as {
      buildDigest: string;
      FrozenSenderRuntime: new (options: Omit<ConstructorParameters<typeof FrozenSenderRuntime>[0], 'decodeRaw'>) => FrozenSenderRuntime;
      SenderService: typeof SenderService;
      SenderClient: typeof SenderClient;
      FrozenPublicChatOperationJournal: typeof FrozenPublicChatOperationJournal;
      PublicChatSendController: typeof PublicChatSendController;
      launchHelper: typeof launchHelper;
      createFixedRawSession: (options: { roomId: string; runtime: FrozenSenderRuntime; executablePath: string }) =>
        { start(): Promise<void>; stop(): Promise<void> };
      decodeFixedRaw: (raw: { method: string; msgId: string; payload: Uint8Array }) =>
        { common?: { roomId?: unknown; createTime?: unknown } } | null;
    };
    const Runtime = bundle.FrozenSenderRuntime;
    const Service = bundle.SenderService;
    const Client = bundle.SenderClient;
    const Journal = bundle.FrozenPublicChatOperationJournal;
    const Controller = bundle.PublicChatSendController;
    const startHelper = bundle.launchHelper;
    console.info(`sender-bundle-sha256=${digest(fs.readFileSync(bundlePath))} sender-build-digest=${bundle.buildDigest}`);
    const helperSource = resolve(fileURLToPath(new URL('../../src/publicChat/httpHelper/', import.meta.url)));
    const copiedSource = join(root, 'helper-source');
    const cert = join(root, 'fixture.crt');
    const key = join(root, 'fixture.key');
    let helper: HelperProcess | null = null;
    let maintenanceHelper: HelperProcess | null = null;
    const maintenancePids: number[] = [];
    let browserServer: { process(): { pid?: number }; wsEndpoint(): string; close(): Promise<void> } | null = null;
    let browser: { close(): Promise<void> } | null = null;
    let browserPid = 0;
    let rawSession: { start(): Promise<void>; stop(): Promise<void> } | null = null;
    const rawBrowserPids: number[] = [];
    let rawSocket: { send(data: Uint8Array | string): void; terminate(): void } | null = null;
    let rawSockets: { clients: Set<{ terminate(): void }>; close(callback: () => void): void } | null = null;
    let rawFrame: Uint8Array = new Uint8Array();
    const platformRoomId = '18446744073709551615';
    let service: SenderService | null = null;
    let trusted: TrustedSender | null = null;
    let listener: https.Server | null = null;
    let helperPid = 0;
    let releaseThirdResponse: (() => void) | undefined;
    const paths: string[] = [];
    const chatRoomIds: string[] = [];
    const chatTexts: string[] = [];
    const profileCookies: string[] = [];
    const browserABACookies: string[] = [];
    try {
      execFileSync('/opt/homebrew/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key,
        '-out', cert, '-days', '1', '-subj', '/CN=www.douyin.com', '-addext',
        'subjectAltName=DNS:www.douyin.com,DNS:live.douyin.com'], { stdio: 'ignore' });
      listener = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert), ALPNProtocols: ['http/1.1'] },
        (request, response) => {
          const url = new URL(request.url!, 'https://fixture.invalid');
          const path = url.pathname;
          if (request.headers.host === 'live.douyin.com' && path === '/101') {
            response.setHeader('Content-Type', 'text/html');
            response.end(`<title>fixture</title><script>const socket = new WebSocket('wss://webcast100-ws-web-lq.douyin.com/webcast/im/push/v2/?room_id=${platformRoomId}'); socket.onmessage = event => { if (event.data === 'navigate') location.href = 'https://live.douyin.com/other'; };</script>`);
            return;
          }
          if (request.headers.host === 'live.douyin.com' && path === '/other') {
            response.setHeader('Content-Type', 'text/html');
            response.end('<title>other</title>');
            return;
          }
          const browserABASend = path === '/webcast/room/chat/' && url.searchParams.get('content') === 'browser ABA fixture';
          if (browserABASend) browserABACookies.push(request.headers.cookie ?? '');
          else {
            paths.push(path);
            if (path === '/webcast/room/chat/') {
              chatRoomIds.push(url.searchParams.get('room_id') ?? '');
              chatTexts.push(url.searchParams.get('content') ?? '');
            }
          }
          if (path.startsWith('/aweme/')) profileCookies.push(request.headers.cookie ?? '');
          if (path === '/webcast/room/chat/' && url.searchParams.get('content') === 'fixture message') {
            request.socket.destroy();
            return;
          }
          if (path === '/webcast/room/chat/' && url.searchParams.get('content') === 'third fixture') {
            releaseThirdResponse = () => response.end('{"status_code":0}');
            return;
          }
          response.setHeader('Content-Type', 'application/json');
          response.setHeader('Set-Cookie', 'fixture=server-suggestion; Path=/; Secure');
          if (path === '/webcast/room/chat/' && url.searchParams.get('content') === 'redirect fixture') {
            response.statusCode = 302;
            response.setHeader('Location', '/must-not-follow');
            response.end('redirect');
            return;
          }
          response.end(path === '/aweme/v1/web/query/user/' ? '{"status_code":0,"user_uid":"42"}' : '{"status_code":0}');
        });
      await new Promise<void>((done) => listener!.listen(0, '127.0.0.1', done));
      const address = listener.address();
      if (!address || typeof address === 'string' || [3080, 3081, 7390, 8757].includes(address.port)) throw new Error('bad fixture port');
      console.info(`owned-tls-listener pid=${process.pid} port=${address.port}`);

      fs.cpSync(helperSource, copiedSource, { recursive: true });
      const mainPath = join(copiedSource, 'main.go');
      const main = fs.readFileSync(mainPath, 'utf8');
      const productionPreparation = 'targets, err := prepareFixedTargets(nil)';
      if (main.split(productionPreparation).length !== 2) throw new Error('fixture source mismatch');
      fs.writeFileSync(mainPath, main.replace(productionPreparation, 'targets, err := fixtureTargets()'));
      const fixtureGo = `package main\n\nimport (\n  "crypto/tls"\n  "crypto/x509"\n  "errors"\n)\n\nfunc fixtureTargets() (map[string]tlsTarget, error) {\n  roots := x509.NewCertPool()\n  if !roots.AppendCertsFromPEM([]byte(${JSON.stringify(fs.readFileSync(cert, 'utf8'))})) {\n    return nil, errors.New("fixture certificate invalid")\n  }\n  targets := make(map[string]tlsTarget)\n  for _, operation := range []string{"profile_self", "query_user", "chat"} {\n    target, err := productionTarget(operation)\n    if err != nil { return nil, err }\n    target.address = "127.0.0.1:${address.port}"\n    target.config = &tls.Config{RootCAs: roots}\n    targets[operation] = target\n  }\n  return targets, nil\n}\n`;
      fs.writeFileSync(join(copiedSource, 'fixture_targets.go'), fixtureGo);
      const binary = join(root, 'fixture-helper');
      const goEnv = { ...process.env, GOTOOLCHAIN: 'local', GOWORK: 'off', GOPROXY: 'off',
        GOMODCACHE: join(fixtureRoot, 'gomodcache'), GOCACHE: join(fixtureRoot, 'gocache'), GOTMPDIR: join(fixtureRoot, 'gotmp') };
      for (const name of ['gomodcache', 'gocache', 'gotmp']) fs.mkdirSync(join(fixtureRoot, name), { recursive: true });
      execFileSync('go', ['build', '-mod=readonly', '-trimpath', '-buildvcs=false', '-o', binary, '.'],
        { cwd: copiedSource, env: goEnv, stdio: 'pipe' });
      fs.chmodSync(binary, 0o700);
      const sourceFiles: Record<string, string> = {};
      for (const name of fs.readdirSync(copiedSource).filter((name) => !name.endsWith('_test.go')).sort()) {
        sourceFiles[name] = digest(fs.readFileSync(join(copiedSource, name)));
      }
      const manifestBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, binaryPath: binary,
        binarySha256: digest(fs.readFileSync(binary)), sourceFiles }));
      console.info(`fixture-helper-sha256=${digest(fs.readFileSync(binary))} fixture-source-manifest-sha256=${digest(manifestBytes)}`);
      const manifestPath = join(root, 'manifest.json');
      fs.writeFileSync(manifestPath, manifestBytes, { mode: 0o600 });
      const now = Date.now();
      const credentials = generateKeyPairSync('ec', { namedCurve: 'prime256v1',
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
      const material = { cookies: [{ name: 'fixture', value: 'synthetic', domain: '.douyin.com', path: '/', secure: true,
        httpOnly: true, sameSite: 'Lax', expiresAtMs: now + 600_000, hostOnly: false, partitioned: false }],
        userAgent: 'fixture', browserName: 'fixture', browserVersion: '1', browserLanguage: 'fixture', engineName: 'fixture',
        engineVersion: '1', osName: 'fixture', osVersion: '1', cpuCoreNum: '1', deviceMemory: '1', platform: 'fixture',
        screenWidth: 1, screenHeight: 1, geo: [1, 2, 3, 4, 5, 6, 7, 8], msToken: 'fixture', webId: 'fixture',
        verifyFp: 'fixture', uifid: 'fixture', ticket: 'fixture', tsSign: 'fixture', privateKey: credentials.privateKey,
        serverCert: '', bdMode: 'ecdsa', csrfToken: 'fixture', csrfOrigin: 'https://live.douyin.com',
        csrfPath: '/webcast/room/chat/', csrfExpiresMs: now + 600_000, expiresAtMs: now + 600_000 };
      const materialPath = join(root, 'material.json');
      fs.writeFileSync(materialPath, JSON.stringify(material), { mode: 0o600 });
      const materialBPath = join(root, 'material-b.json');
      const materialB = { ...material, cookies: material.cookies.map((cookie) => ({ ...cookie, value: 'synthetic-b' })) };
      fs.writeFileSync(materialBPath, JSON.stringify(materialB), { mode: 0o600 });
      const deployment = { buildDigest: bundle.buildDigest, instanceId: 'instance', accountRecordId: 'record',
        expectedPrincipalUid: '42', roomId: '101' };

      const browserBinary = process.env.DSH_PUBLIC_CHAT_BROWSER_BINARY;
      if (!browserBinary) throw new Error('isolated browser binary required');
      const { chromium } = createRequire(join(fixtureRoot, 'fixture-runner.cjs'))('playwright-core');
      const protobuf = createRequire(join(fixtureRoot, 'fixture-runner.cjs'))('protobufjs');
      const pako = createRequire(join(fixtureRoot, 'fixture-runner.cjs'))('pako');
      const { WebSocketServer } = createRequire(join(fixtureRoot, 'fixture-runner.cjs'))('ws');
      const websocketServer = new WebSocketServer({ noServer: true });
      rawSockets = websocketServer;
      listener.on('upgrade', (request, socket, head) => {
        if (request.headers.host !== 'webcast100-ws-web-lq.douyin.com' ||
          request.url !== `/webcast/im/push/v2/?room_id=${platformRoomId}`) {
          socket.destroy();
          return;
        }
        websocketServer.handleUpgrade(request, socket, head, (websocket: { send(data: Uint8Array): void; terminate(): void }) => {
          rawSocket = websocket;
          websocketServer.emit('connection', websocket, request);
          websocket.send(rawFrame);
        });
      });
      const makeRawFrame = (roomId: string, messageId: number, rawType = 'WebcastChatMessage') => {
        const rawCommon = protobuf.Writer.create().uint32(24).uint64(roomId).uint32(32).uint64(String(Date.now())).finish();
        const rawBody = protobuf.Writer.create().uint32(10).bytes(rawCommon).finish();
        const rawMessage = protobuf.Writer.create().uint32(10).string(rawType).uint32(18).bytes(rawBody)
          .uint32(24).int64(messageId).finish();
        const rawResponse = protobuf.Writer.create().uint32(10).bytes(rawMessage).finish();
        const compressionHeader = protobuf.Writer.create()
          .uint32(10).string('compress_type').uint32(18).string('gzip').finish();
        return Buffer.from(protobuf.Writer.create().uint32(42).bytes(compressionHeader)
          .uint32(58).string('msg').uint32(66).bytes(pako.gzip(rawResponse)).finish());
      };
      const wrapper = join(root, 'chrome-raw-fixture.sh');
      const rawPidFile = join(root, 'chrome-raw-fixture.pid');
      const rules = `MAP live.douyin.com 127.0.0.1:${address.port}, MAP webcast100-ws-web-lq.douyin.com 127.0.0.1:${address.port}, MAP * ~NOTFOUND`;
      fs.writeFileSync(wrapper, `#!/bin/sh\nprintf '%s' "$$" > '${rawPidFile}'\nexec '${browserBinary}' --no-proxy-server --ignore-certificate-errors --disable-background-networking '--host-resolver-rules=${rules}' "$@"\n`, { flag: 'wx', mode: 0o700 });
      const common = protobuf.Writer.create().uint32(24).uint64('202').uint32(32).uint64(String(Date.now())).finish();
      const rawPayload: Uint8Array = protobuf.Writer.create().uint32(10).bytes(common).finish();
      const decodedLong = bundle.decodeFixedRaw({ method: 'WebcastChatMessage', msgId: '1', payload: rawPayload });
      expect(String(decodedLong?.common?.roomId)).toBe('202');
      const maximumLongCommon = protobuf.Writer.create().uint32(24).uint64(platformRoomId).finish();
      const maximumLongPayload = protobuf.Writer.create().uint32(10).bytes(maximumLongCommon).finish();
      const maximumLong = bundle.decodeFixedRaw({ method: 'WebcastChatMessage', msgId: '2', payload: maximumLongPayload });
      expect(String(maximumLong?.common?.roomId)).toBe(platformRoomId);
      expect(typeof maximumLong?.common?.roomId).toBe('object');
      browserServer = await chromium.launchServer({ executablePath: browserBinary, headless: true, host: '127.0.0.1',
        env: { PATH: '/usr/bin:/bin', TMPDIR: fixtureRoot },
        args: ['--no-proxy-server', '--disable-background-networking', '--disable-sync', '--disable-breakpad',
          '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'] });
      browserPid = browserServer!.process().pid ?? 0;
      const browserEndpoint = new URL(browserServer!.wsEndpoint());
      console.info(`owned-browser-endpoint-host=${browserEndpoint.hostname} port=${browserEndpoint.port}`);
      if (!browserPid || !['127.0.0.1', '[::1]'].includes(browserEndpoint.hostname) ||
        ['3080', '3081', '7390', '8757'].includes(browserEndpoint.port)) throw new Error('unsafe owned browser endpoint');
      console.info(`owned-browser pid=${browserPid} port=${browserEndpoint.port}`);
      const connectedBrowser = await chromium.connect(browserServer!.wsEndpoint());
      browser = connectedBrowser;
      const browserContext = await connectedBrowser.newContext();
      await browserContext.route('**/*', async (route: { request(): { url(): string }; fulfill(options: object): Promise<void>; abort(): Promise<void> }) => {
        if (route.request().url() === 'https://live.douyin.com/101') {
          await route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>fixture</body></html>' });
        } else {
          await route.abort();
        }
      });
      const browserPage = await browserContext.newPage();
      await browserPage.goto('https://live.douyin.com/101');

      // These are real helper processes and real loopback profile requests.
      // Reinstalling a previous byte-identical synthetic material file still
      // creates a new private context and cannot restore its previous grant.
      const maintenanceRuntime = new Runtime({ deployment,
        launch: async (options) => {
          const launched = await startHelper(options);
          maintenanceHelper = launched;
          maintenancePids.push(launched.pid);
          return launched;
        } });
      maintenanceRuntime.setInputAndLive(1, 'maintenance-live', now - 1000);
      const maintenanceObserver = maintenanceRuntime.createRawEvidenceObserver('101', browserPage, {});
      maintenanceObserver.socketCreated('maintenance-socket', 'wss://webcast100-ws-web-lq.douyin.com/webcast/im/push/v2/?room_id=202');
      maintenanceObserver.rawMessage('maintenance-socket', { method: 'WebcastChatMessage', msgId: 'maintenance-raw', payload: rawPayload });

      const maintenanceSettings = (revision: number, source: string, validManifest = true) => {
        const bytes = Buffer.from(JSON.stringify({ buildDigest: deployment.buildDigest, instanceId: deployment.instanceId,
          senderProcessNonce: maintenanceRuntime.processNonce, accountRecordId: deployment.accountRecordId,
          principalUid: deployment.expectedPrincipalUid, roomId: deployment.roomId, authContextRevision: revision }));
        const path = join(root, `maintenance-deployment-${revision}.json`);
        fs.writeFileSync(path, bytes, { mode: 0o600 });
        return { manifestPath, manifestSha256: validManifest ? digest(manifestBytes) : '0'.repeat(64), sourceDirectory: copiedSource,
          materialPath: source, deploymentPath: path, deploymentSha256: digest(bytes), dataDirectory: root };
      };
      const grantForMaintenance = async (revision: number): Promise<FrozenGrantSnapshot> => {
        const captured = await maintenanceRuntime.captureQualification(`maintenance-capture-${revision}`, maintenanceRuntime.processNonce);
        if (!captured?.qualification) throw new Error('maintenance fixture qualification failed');
        const state = maintenanceRuntime.state();
        if (!state.helper || !state.raw?.proof) throw new Error('maintenance fixture identity missing');
        const q = captured.qualification;
        const target: FrozenGrantProposal = { version: 'dsh-public-chat-v1', transportKind: 'frozen_http',
          buildDigest: deployment.buildDigest, instanceId: deployment.instanceId, senderProcessNonce: maintenanceRuntime.processNonce,
          senderConnectionGeneration: state.senderConnectionGeneration, authorizationId: `maintenance-auth-${revision}`,
          captureId: q.captureId, qualificationDigest: q.qualificationDigest, qualificationRevision: q.qualificationRevision,
          identityEpoch: q.identityEpoch, accountRecordId: deployment.accountRecordId, principalUid: q.principalUid,
          roomId: deployment.roomId, platformRoomId: state.raw.proof.platformRoomId, helperProcessNonce: state.helper.helperNonce,
          authContextId: state.helper.authContextId, authContextRevision: state.helper.authContextRevision,
          materialDigest: state.helper.materialDigest, rawSourceSessionId: state.raw.sessionId,
          rawSourceConnectionGeneration: state.raw.generation, rawBrowserContextId: state.raw.contextId,
          roomBindingProofDigest: state.raw.proof.digest, inputConnectionGeneration: 1, liveEpoch: 'maintenance-live',
          liveEpochStartedAtMs: now - 1000 };
        const result = await maintenanceRuntime.authorizeGrant({ authorizationId: target.authorizationId,
          expectedSenderProcessNonce: maintenanceRuntime.processNonce, qualificationToken: q.qualificationToken,
          localRevision: `maintenance-local-${revision}`, target });
        if (!result.registered || result.record.kind !== 'authorize' || !result.record.grant) {
          throw new Error('maintenance fixture grant failed');
        }
        return result.record.grant;
      };
      expect((await maintenanceRuntime.beginAuthenticationMaintenance(maintenanceSettings(1, materialPath))).ok).toBe(true);
      const contexts = [maintenanceRuntime.state().helper!.authContextId];
      let maintenanceGrant = await grantForMaintenance(1);
      for (const value of ['browser-a', 'browser-b', 'browser-a']) {
        await browserContext.addCookies([{ name: 'fixture', value, domain: '.douyin.com', path: '/', secure: true }]);
      }
      expect(maintenanceRuntime.state().activeAuthorizationId).toBe(maintenanceGrant.authorizationId);
      const browserABA = await maintenanceRuntime.send({ requestId: 'browser-aba', sourceKey: 'browser-aba',
        grant: maintenanceGrant, text: 'browser ABA fixture', autoEvent: null });
      expect(browserABA?.state).toBe('api_reported_success');
      expect(browserABACookies).toEqual(['fixture=synthetic']);
      for (const [revision, source] of [[2, materialBPath], [3, materialPath], [4, materialPath]] as const) {
        const replacing = maintenanceRuntime.beginAuthenticationMaintenance(maintenanceSettings(revision, source));
        expect(maintenanceRuntime.state().activeAuthorizationId).toBeNull();
        expect(await maintenanceRuntime.send({ requestId: `stale-maintenance-${revision}`, sourceKey: `stale-maintenance-${revision}`,
          grant: maintenanceGrant, text: 'fixture', autoEvent: null })).toBeNull();
        expect((await replacing).ok).toBe(true);
        const identity = maintenanceRuntime.state().helper!;
        expect(identity.authContextRevision).toBe(revision);
        contexts.push(identity.authContextId);
        maintenanceGrant = await grantForMaintenance(revision);
      }
      expect(new Set(contexts).size).toBe(4);
      expect(profileCookies.slice(0, 8)).toEqual(['fixture=synthetic', 'fixture=synthetic', 'fixture=synthetic-b', 'fixture=synthetic-b',
        'fixture=synthetic', 'fixture=synthetic', 'fixture=synthetic', 'fixture=synthetic']);
      const failedReplacement = maintenanceRuntime.beginAuthenticationMaintenance(maintenanceSettings(5, materialPath, false));
      expect(maintenanceRuntime.state().activeAuthorizationId).toBeNull();
      expect(await maintenanceRuntime.send({ requestId: 'failed-maintenance', sourceKey: 'failed-maintenance',
        grant: maintenanceGrant, text: 'fixture', autoEvent: null })).toBeNull();
      expect((await failedReplacement).ok).toBe(false);
      for (const pid of maintenancePids) expect(() => process.kill(pid, 0)).toThrow();
      console.info(`owned-maintenance-helper-pids=${maintenancePids.join(',')} reaped`);
      maintenanceHelper = null;

      const runtime = new Runtime({ deployment,
        launch: async (options) => {
          let launched: HelperProcess;
          try {
            launched = await startHelper(options);
          } catch (error) {
            console.info('fixture helper launch failed:', error instanceof Error ? error.message : 'unknown error');
            throw error;
          }
          helper = launched;
          helperPid = launched.pid;
          return launched;
        } });
      runtime.setInputAndLive(1, 'live', now - 1000);
      const startRawSession = async (frame: Uint8Array) => {
        rawFrame = frame;
        rawSocket = null;
        const session = bundle.createFixedRawSession({ roomId: '101', runtime, executablePath: wrapper });
        rawSession = session;
        try {
          await session.start();
        } finally {
          if (fs.existsSync(rawPidFile)) {
            const pid = Number(fs.readFileSync(rawPidFile, 'utf8'));
            if (!rawBrowserPids.includes(pid)) rawBrowserPids.push(pid);
          }
        }
        return session;
      };
      const stopRawSession = async () => {
        if (!rawSession) return;
        await rawSession.stop();
        rawSession = null;
        const pid = rawBrowserPids[rawBrowserPids.length - 1];
        expect(() => process.kill(pid, 0)).toThrow();
      };
      await startRawSession(makeRawFrame('203', 91));
      expect(runtime.state().raw?.proof ?? null).toBeNull();
      const wrongSessionGeneration = runtime.state().raw?.generation;
      await stopRawSession();
      await startRawSession(makeRawFrame(platformRoomId, 92));
      const previousRaw = runtime.state().raw;
      expect(previousRaw?.proof?.platformRoomId).toBe(platformRoomId);
      expect(previousRaw!.generation).toBeGreaterThan(wrongSessionGeneration!);
      if (!rawSocket) throw new Error('raw socket missing');
      (rawSocket as { send(data: string): void }).send('navigate');
      await waitFor(() => runtime.state().raw?.proof === null);
      await stopRawSession();
      await startRawSession(makeRawFrame(platformRoomId, 99));
      const currentRaw = runtime.state().raw;
      expect(currentRaw?.proof?.platformRoomId).toBe(platformRoomId);
      expect(currentRaw!.generation).toBeGreaterThan(previousRaw!.generation);
      expect(currentRaw!.sessionId).not.toBe(previousRaw!.sessionId);
      expect(currentRaw!.contextId).not.toBe(previousRaw!.contextId);
      const deploymentBytes = Buffer.from(JSON.stringify({ buildDigest: deployment.buildDigest, instanceId: deployment.instanceId,
        senderProcessNonce: runtime.processNonce, accountRecordId: deployment.accountRecordId, principalUid: deployment.expectedPrincipalUid,
        roomId: deployment.roomId, authContextRevision: 1 }));
      const deploymentPath = join(root, 'deployment.json');
      fs.writeFileSync(deploymentPath, deploymentBytes, { mode: 0o600 });
      const maintenance = await runtime.beginAuthenticationMaintenance({ manifestPath, manifestSha256: digest(manifestBytes),
        sourceDirectory: copiedSource, materialPath, deploymentPath, deploymentSha256: digest(deploymentBytes), dataDirectory: root });
      expect(maintenance).toEqual({ ok: true, reason: 'ready' });
      const currentService = new Service({ runtime, token: 'fixture-token', deployment: { schemaVersion: 1,
        listenUrl: 'http://127.0.0.1:0', token: 'fixture-token', expectedPrincipalUid: '42', roomId: '101', accountRecordId: 'record',
        buildDigest: bundle.buildDigest, instanceId: 'instance', profileOrigin: 'https://www.douyin.com', dataDir: root } });
      service = currentService;
      const origin = await currentService.start();
      console.info(`owned-http-listener pid=${process.pid} port=${new URL(origin).port}`);
      let holdAuthorization = false;
      let releaseAuthorization: (() => void) | undefined;
      let announceAuthorization: (() => void) | undefined;
      const authorizationArrived = new Promise<void>((done) => { announceAuthorization = done; });
      const guardedFetch: typeof fetch = async (resource, options) => {
        const url = new URL(resource instanceof Request ? resource.url : String(resource));
        if (url.origin !== origin || url.hostname !== '127.0.0.1' || ['3080', '3081', '7390', '8757'].includes(url.port)) {
          throw new Error('unexpected fixture target');
        }
        const response = await fetch(resource, options);
        if (holdAuthorization && url.pathname === '/v1/grant/authorize') {
          await new Promise<void>((done) => {
            releaseAuthorization = done;
            announceAuthorization?.();
          });
        }
        return response;
      };
      const client = new Client({ url: origin, token: 'fixture-token', expected: { buildDigest: bundle.buildDigest, instanceId: 'instance' },
        fetcher: guardedFetch });
      let journal = new Journal(root);
      let controller = new Controller({ deployment, gateway: client, journal, bounds: { dispatchIntervalMs: 0 } });
      controller.setLiveEpoch('live', now - 1000);
      controller.advanceInputConnection();
      expect((await controller.refreshQualification()).ok).toBe(true);
      expect((await controller.submit({ requestId: 'before-auth', sourceKey: 'before-auth', text: 'fixture' })).status).toBe('rejected');
      expect(paths.filter((path) => path === '/webcast/room/chat/')).toHaveLength(0);
      holdAuthorization = true;
      const pendingAuthorization = controller.authorize();
      await authorizationArrived;
      expect((await controller.submit({ requestId: 'before-ack', sourceKey: 'before-ack', text: 'fixture' })).status).toBe('rejected');
      expect(paths.filter((path) => path === '/webcast/room/chat/')).toHaveLength(0);
      holdAuthorization = false;
      releaseAuthorization!();
      expect((await pendingAuthorization).ok).toBe(true);
      const firstAuthorization = journal.controls.find((entry) => entry.kind === 'authorize' && entry.state === 'active');
      if (!firstAuthorization || firstAuthorization.kind !== 'authorize' || !firstAuthorization.grant) throw new Error('fixture grant missing');
      expect((await client.frozenSend({ requestId: 'before-grant-raw', sourceKey: 'before-grant-raw',
        grant: firstAuthorization.grant, text: 'fixture', autoEvent: { rawId: '99', rawType: 'WebcastChatMessage' } })).ok).toBe(false);
      expect(paths.filter((path) => path === '/webcast/room/chat/')).toHaveLength(0);
      expect((await controller.submit({ requestId: 'original', sourceKey: 'source-original', text: 'fixture message' })).status).toBe('accepted');
      await waitFor(() => controller.frozenOperationView('original')?.state === 'unknown');
      const original = controller.frozenOperationView('original');
      if (!original) throw new Error('original operation missing');
      expect(paths.filter((path) => path === '/webcast/room/chat/')).toHaveLength(1);
      expect(controller.hold).toBe(true);
      expect((await controller.submit({ requestId: 'same-source', sourceKey: 'source-original', text: 'different fixture' })).status).toBe('duplicate');
      expect(paths.filter((path) => path === '/webcast/room/chat/')).toHaveLength(1);
      const observedAtMs = Date.now();
      expect(controller.recordVerificationFact({ requestId: original.requestId, principalUid: '42', roomId: '101', grantId: original.grant.grantId,
        liveEpoch: 'live', inputConnectionGeneration: 1, ref: messageReference(original), factId: 'observation',
        observationSource: { source: 'owner', observerRef: null }, fact: { kind: 'positive_observation', attributionStrength: 'direct',
          observedAtMs, textDigest: original.textDigest, principalUid: '42', roomId: '101', platformRoomId } }).ok).toBe(true);
      const originalReconcile = client.frozenReconcileMessage.bind(client);
      let releaseRecovery!: () => void;
      let announceRecovery!: () => void;
      const recoveryArrived = new Promise<void>((done) => { announceRecovery = done; });
      const recoveryWait = new Promise<void>((done) => { releaseRecovery = done; });
      client.frozenReconcileMessage = async (request) => {
        const response = await originalReconcile(request);
        if (!response.ok || response.value.state !== 'committed') throw new Error('fixture recovery did not commit');
        announceRecovery();
        await recoveryWait;
        return { ok: false, error: 'fixture lost ACK', untrusted: false };
      };
      const oldRecovery = controller.reconcileFrozenMessage('original');
      await recoveryArrived;
      const oldControl = journal.controls.find((entry) => entry.kind === 'message_reconcile' && entry.state === 'pending');
      if (!oldControl || oldControl.kind !== 'message_reconcile') throw new Error('original recovery control missing');
      expect(controller.recordVerificationFact({ requestId: original.requestId, principalUid: '42', roomId: '101', grantId: original.grant.grantId,
        liveEpoch: 'live', inputConnectionGeneration: 1, ref: messageReference(original), factId: 'later-note',
        fact: { kind: 'note', note: 'fixture follow-up' } }).ok).toBe(true);
      expect((await controller.reconcileFrozenMessage('original')).ok).toBe(false);
      releaseRecovery();
      expect((await oldRecovery).ok).toBe(false);
      expect(controller.hold).toBe(true);
      const oldQuery = await controller.reconcileControl(oldControl.id);
      expect(oldQuery.ok).toBe(false);
      expect(controller.hold).toBe(true);
      client.frozenReconcileMessage = originalReconcile;
      expect((await controller.reconcileFrozenMessage('original')).ok).toBe(true);
      expect(controller.frozenOperationView('original')?.state).toBe('unknown');
      await waitFor(() => !controller.hold);
      const recoveryId = controller.frozenOperationView('original')?.recovery.controlId;
      if (!recoveryId) throw new Error('published recovery control missing');
      for (const failure of ['write', 'rename', 'fsync', 'close'] as const) {
        let inject = false;
        let renamed = false;
        const io = new Proxy(fs, { get(target, key) {
          if (key === 'writeFileSync') return (...args: Parameters<typeof fs.writeFileSync>) => {
            if (inject && failure === 'write') throw new Error('fixture adoption write failure');
            return fs.writeFileSync(...args);
          };
          if (key === 'renameSync') return (...args: Parameters<typeof fs.renameSync>) => {
            if (inject && failure === 'rename') throw new Error('fixture adoption rename failure');
            fs.renameSync(...args);
            if (inject) renamed = true;
          };
          if (key === 'fsyncSync') return (fd: number) => {
            if (inject && renamed && failure === 'fsync' && fs.fstatSync(fd).isDirectory()) throw new Error('fixture adoption fsync failure');
            return fs.fsyncSync(fd);
          };
          if (key === 'closeSync') return (fd: number) => {
            const fail = inject && renamed && failure === 'close' && fs.fstatSync(fd).isDirectory();
            fs.closeSync(fd);
            if (fail) throw new Error('fixture adoption close failure');
          };
          return Reflect.get(target, key);
        } }) as typeof fs;
        const failingJournal = new Journal(root, io);
        expect(failingJournal.corrupt).toBe(false);
        const failingController = new Controller({ deployment, gateway: client, journal: failingJournal, bounds: { dispatchIntervalMs: 0 } });
        inject = true;
        expect((await failingController.reconcileControl(recoveryId)).ok).toBe(false);
        expect(failingController.hold).toBe(true);
        const afterFailure = new Journal(root);
        expect(afterFailure.corrupt).toBe(false);
        const afterFailureController = new Controller({ deployment, gateway: client, journal: afterFailure, bounds: { dispatchIntervalMs: 0 } });
        expect(afterFailureController.hold).toBe(true);
        expect(afterFailureController.frozenOperationView('original')?.recovery.state).toBe('recovery_unknown');
        expect(paths.filter((path) => path === '/webcast/room/chat/')).toHaveLength(1);
      }
      journal = new Journal(root);
      expect(journal.corrupt).toBe(false);
      controller = new Controller({ deployment, gateway: client, journal, bounds: { dispatchIntervalMs: 0 } });
      expect(controller.hold).toBe(true);
      const historicalControls = journal.controls.filter((entry) => entry.kind !== 'message_reconcile' &&
        (entry.state === 'revoked' || entry.state === 'rejected'));
      for (const entry of historicalControls) expect((await controller.reconcileControl(entry.id)).ok).toBe(true);
      expect(controller.hold).toBe(true);
      expect((await controller.reconcileControl(recoveryId)).ok).toBe(true);
      expect(controller.hold).toBe(false);
      expect(controller.frozenOperationView('original')?.state).toBe('unknown');
      expect(paths.filter((path) => path === '/webcast/room/chat/')).toHaveLength(1);
      expect((await controller.submit({ requestId: 'original', sourceKey: 'source-original', text: 'fixture message' })).status).toBe('duplicate');
      expect((await client.frozenSend({ requestId: 'old-grant', sourceKey: 'old-grant', grant: original.grant,
        text: 'old fixture', autoEvent: null })).ok).toBe(false);
      expect(paths.filter((path) => path === '/webcast/room/chat/')).toHaveLength(1);
      controller.setLiveEpoch('live', now - 1000);
      controller.advanceInputConnection();
      expect((await controller.refreshQualification()).ok).toBe(true);
      expect((await controller.authorize()).ok).toBe(true);
      expect((await controller.submit({ requestId: 'new', sourceKey: 'source-new', text: 'second fixture' })).status).toBe('accepted');
      await waitFor(() => controller.frozenOperationView('new')?.state === 'api_reported_success');
      expect(controller.frozenOperationView('new')?.httpResponse).toMatchObject({
        version: 'dsh-public-chat-http-response-v1', status: 200, length: 17,
      });
      expect(paths.filter((path) => path === '/webcast/room/chat/')).toHaveLength(2);
      expect((await controller.submit({ requestId: 'redirect', sourceKey: 'redirect', text: 'redirect fixture' })).status).toBe('accepted');
      await waitFor(() => controller.frozenOperationView('redirect')?.state === 'unknown');
      const redirect = controller.frozenOperationView('redirect')!;
      expect(redirect.httpResponse).toMatchObject({ version: 'dsh-public-chat-http-response-v1', status: 302, length: 8 });
      expect(new Journal(root).records.find((record) => record.requestId === 'redirect')?.httpResponse).toEqual(redirect.httpResponse);
      expect(paths).not.toContain('/must-not-follow');
      expect(controller.recordVerificationFact({ requestId: redirect.requestId, principalUid: '42', roomId: '101',
        grantId: redirect.grant.grantId, liveEpoch: 'live', inputConnectionGeneration: 1, ref: messageReference(redirect),
        factId: 'redirect-observation', observationSource: { source: 'owner', observerRef: null },
        fact: { kind: 'positive_observation', attributionStrength: 'direct', observedAtMs: Date.now(),
          textDigest: redirect.textDigest, principalUid: '42', roomId: '101', platformRoomId } }).ok).toBe(true);
      expect((await controller.reconcileFrozenMessage('redirect')).ok).toBe(true);
      await waitFor(() => !controller.hold);
      expect((await controller.refreshQualification()).ok).toBe(true);
      expect((await controller.authorize()).ok).toBe(true);
      const rawBoundControl = [...journal.controls].reverse().find((entry) => entry.kind === 'authorize' && entry.state === 'active');
      if (!rawBoundControl || rawBoundControl.kind !== 'authorize' || !rawBoundControl.grant || !rawSocket) {
        throw new Error('raw-bound fixture grant missing');
      }
      (rawSocket as { terminate(): void }).terminate();
      await waitFor(() => runtime.state().raw?.proof === null);
      expect((await client.frozenSend({ requestId: 'stale-raw-grant', sourceKey: 'stale-raw-grant', grant: rawBoundControl.grant,
        text: 'closed raw fixture', autoEvent: null })).ok).toBe(false);
      expect(paths.filter((path) => path === '/webcast/room/chat/')).toHaveLength(3);
      controller.revokeGrant('owner-revoke');
      await waitFor(() => !controller.hold);
      await stopRawSession();
      await startRawSession(makeRawFrame(platformRoomId, 100));
      expect(runtime.state().raw?.proof?.platformRoomId).toBe(platformRoomId);
      expect((await controller.refreshQualification()).ok).toBe(true);
      expect((await controller.authorize()).ok).toBe(true);
      const activeControl = [...journal.controls].reverse().find((entry) => entry.kind === 'authorize' && entry.state === 'active');
      if (!activeControl || activeControl.kind !== 'authorize' || !activeControl.grant) throw new Error('new fixture grant missing');
      const newGrant = activeControl.grant;
      expect((await controller.submit({ requestId: 'in-flight', sourceKey: 'source-in-flight', text: 'third fixture' })).status).toBe('accepted');
      await waitFor(() => releaseThirdResponse !== undefined);
      expect((await controller.submit({ requestId: 'queued', sourceKey: 'source-queued', text: 'queued fixture' })).status).toBe('accepted');
      controller.revokeGrant('owner-revoke');
      releaseThirdResponse?.();
      await waitFor(() => journal.controls.some((entry) => entry.kind === 'revoke' && entry.state === 'revoked' &&
        entry.target.kind === 'authorization' && entry.target.authorizationId === newGrant.authorizationId));
      expect((await client.frozenSend({ requestId: 'after-revoke', sourceKey: 'after-revoke', grant: newGrant,
        text: 'revoked fixture', autoEvent: null })).ok).toBe(false);
      expect(controller.frozenOperationView('queued')?.state).toBe('cancelled_before_dispatch');
      expect(paths.filter((path) => path === '/webcast/room/chat/')).toHaveLength(4);
      expect(chatRoomIds).toEqual([platformRoomId, platformRoomId, platformRoomId, platformRoomId]);
      if (!rawSocket) throw new Error('raw socket missing before close');
      (rawSocket as { terminate(): void }).terminate();
      await waitFor(() => runtime.state().raw?.proof === null);
      expect((await client.frozenSend({ requestId: 'after-raw-close', sourceKey: 'after-raw-close', grant: newGrant,
        text: 'closed fixture', autoEvent: null })).ok).toBe(false);
      expect(paths.filter((path) => path === '/webcast/room/chat/')).toHaveLength(4);
      await waitFor(() => controller.frozenOperationView('in-flight')?.state !== 'dispatching');
      const inFlightState = controller.frozenOperationView('in-flight')?.state;
      expect(['api_reported_success', 'unknown']).toContain(inFlightState);
      await currentService.close();
      service = null;
      if (helper) await (helper as HelperProcess).close();
      helper = null;
      const offlineJournal = new Journal(root);
      expect(offlineJournal.corrupt).toBe(false);
      const offlineController = new Controller({ deployment, gateway: client, journal: offlineJournal, bounds: { dispatchIntervalMs: 0 } });
      expect(offlineController.hold).toBe(true);
      for (const entry of offlineJournal.controls) {
        if (entry.kind !== 'message_reconcile' && (entry.state === 'revoked' || entry.state === 'rejected')) {
          expect((await offlineController.reconcileControl(entry.id)).ok).toBe(true);
        }
      }
      for (const record of offlineJournal.records) {
        if (record.recovery.state === 'committed' && record.recovery.controlId) {
          expect((await offlineController.reconcileControl(record.recovery.controlId)).ok).toBe(true);
        }
      }
      expect(offlineController.frozenOperationView('original')?.state).toBe('unknown');
      expect(offlineController.frozenOperationView('original')?.recovery.state).toBe('committed');
      expect(offlineController.hold).toBe(inFlightState === 'unknown');
      expect((await offlineController.submit({ requestId: 'original', sourceKey: 'source-original', text: 'fixture message' })).status).toBe('duplicate');
      expect(paths.filter((path) => path === '/webcast/room/chat/')).toHaveLength(4);

      // Exercise the host's actual verified composition after the original
      // sender is closed, with a new isolated journal and helper context.
      await stopRawSession();
      const trustedData = join(root, 'trusted-data');
      fs.mkdirSync(trustedData, { mode: 0o700 });
      const reservation = createServer();
      await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done));
      const reservedAddress = reservation.address();
      if (!reservedAddress || typeof reservedAddress === 'string') throw new Error('fixture reservation failed');
      await new Promise<void>((done, fail) => reservation.close((error) => error ? fail(error) : done()));
      const trustedDeployment = join(root, 'trusted-deployment.json');
      fs.writeFileSync(trustedDeployment, JSON.stringify({ schemaVersion: 1, listenUrl: `http://127.0.0.1:${reservedAddress.port}`,
        token: 'fixture-token', expectedPrincipalUid: '42', roomId: '101', accountRecordId: 'record',
        buildDigest: bundle.buildDigest, instanceId: 'instance', profileOrigin: 'https://www.douyin.com', dataDir: trustedData }),
      { mode: 0o600, flag: 'wx' });
      const refs = trustedReferencesFromEnvironment({
        DSH_PUBLIC_CHAT_BUILD_DEPLOYMENT_FILE: senderDeploymentPath,
        DSH_PUBLIC_CHAT_DEPLOYMENT_FILE: trustedDeployment,
        DSH_PUBLIC_CHAT_BROWSER_EXECUTABLE: wrapper,
        DSH_PUBLIC_CHAT_HELPER_MANIFEST: manifestPath,
        DSH_PUBLIC_CHAT_HELPER_MANIFEST_SHA256: digest(manifestBytes),
        DSH_PUBLIC_CHAT_HELPER_SOURCE_DIRECTORY: copiedSource,
        DSH_PUBLIC_CHAT_MATERIAL_FILE: materialPath,
        DSH_PUBLIC_CHAT_HELPER_DATA_DIR: trustedData,
      });
      if (!refs) throw new Error('trusted fixture references rejected');
      rawFrame = makeRawFrame(platformRoomId, 101);
      trusted = await startTrustedSender(refs, '101');
      const trustedPids = [...(trusted as unknown as { helpers: Set<HelperProcess> }).helpers].map((owned) => owned.pid);
      trusted.input.setLive({ roomId: '101', epoch: 'live', startedAtMs: now - 1000 });
      trusted.input.inputStateChanged('connected', 'idle');
      await trusted.startRaw();
      if (fs.existsSync(rawPidFile)) rawBrowserPids.push(Number(fs.readFileSync(rawPidFile, 'utf8')));
      expect(trusted.publicView().platformRoomId).toBe(platformRoomId);
      expect(fs.readdirSync(trustedData).filter((name) => name.startsWith('.public-chat-helper-'))).toEqual([]);
      expect((await trusted.controller.refreshQualification()).ok).toBe(true);
      expect((await trusted.controller.authorize()).ok).toBe(true);
      expect((await trusted.controller.submit({ requestId: 'trusted-manual', sourceKey: null, text: 'manual fixture' })).status).toBe('accepted');
      await waitFor(() => trusted?.controller.frozenOperationView('trusted-manual')?.state === 'api_reported_success');
      expect(trusted.controller.frozenOperationView('trusted-manual')?.state).toBe('api_reported_success');
      expect(paths.filter((path) => path === '/webcast/room/chat/')).toHaveLength(5);
      if (!rawSocket) throw new Error('trusted raw socket missing');
      (rawSocket as { terminate(): void }).terminate();
      await waitFor(() => trusted?.controller.currentFrozenGrant() === null);
      expect((await trusted.controller.submit({ requestId: 'after-trusted-disconnect', sourceKey: null,
        text: 'closed fixture' })).status).toBe('rejected');
      expect(paths.filter((path) => path === '/webcast/room/chat/')).toHaveLength(5);
      await trusted.close();
      trusted = null;
      for (const pid of trustedPids) {
        expect(() => process.kill(pid, 0)).toThrow();
        console.info(`owned-trusted-helper-pid=${pid} reaped`);
      }
      rawFrame = makeRawFrame(platformRoomId, 102);
      rawSocket = null;
      await runOwnerJourney({ root, fixtureRoot, bundlePath, senderManifest: process.env.DSH_PUBLIC_CHAT_SENDER_MANIFEST!,
        senderManifestSha256: expectedManifestSha256, exportPath, helperManifest: join(root, 'manifest.json'),
        helperManifestSha256: digest(manifestBytes), helperSource: copiedSource, material: materialPath,
        browserExecutable: wrapper, rawPidFile, browser: connectedBrowser,
        presetPath: join(fixtureRoot, 'output/preset-input.yml'),
        emitRaw(id, rawType) {
          if (!rawSocket) throw new Error('sender raw socket unavailable');
          (rawSocket as { send(data: Uint8Array): void }).send(makeRawFrame(platformRoomId, id, rawType));
        },
        chatCount: () => paths.filter((path) => path === '/webcast/room/chat/').length,
        wireCount: () => paths.length, chatTexts: () => [...chatTexts] });
    } finally {
      releaseThirdResponse?.();
      if (trusted) await trusted.close();
      if (rawSession) await (rawSession as { stop(): Promise<void> }).stop();
      if (rawSockets) {
        for (const socket of rawSockets.clients) socket.terminate();
        await new Promise<void>((done) => rawSockets!.close(done));
      }
      for (const pid of rawBrowserPids) {
        expect(() => process.kill(pid, 0)).toThrow();
        console.info(`owned-raw-browser-pid=${pid} reaped`);
      }
      console.info(`fixture-cleanup transport-start=${Date.now()}`);
      if (service) await service.close();
      if (helper) await (helper as HelperProcess).close();
      if (maintenanceHelper) await (maintenanceHelper as HelperProcess).close();
      console.info(`fixture-cleanup browser-start=${Date.now()}`);
      if (browser) await browser.close();
      if (browserServer) await browserServer.close();
      console.info(`fixture-cleanup browser-end=${Date.now()}`);
      if (browserPid) {
        expect(() => process.kill(browserPid, 0)).toThrow();
        console.info(`owned-browser-pid=${browserPid} reaped`);
      }
      if (helperPid) {
        expect(() => process.kill(helperPid, 0)).toThrow();
        console.info(`owned-helper-pid=${helperPid} reaped`);
      }
      console.info(`fixture-cleanup listener-start=${Date.now()}`);
      if (listener) await new Promise<void>((done, fail) => listener!.close((error) => error ? fail(error) : done()));
      console.info(`fixture-cleanup listener-end=${Date.now()}`);
      if (process.env.DSH_PUBLIC_CHAT_KEEP_FIXTURE !== '1') fs.rmSync(root, { recursive: true, force: true });
      else console.info(`owned-fixture-artifacts=${root}`);
    }
  }, 120_000);
});
