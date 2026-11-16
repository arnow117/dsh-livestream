import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('session owner route through the connection SDK', () => {
  it('rejects guest, unauthenticated and cross-origin requests before the actual route', async () => {
    const home = process.env.DSH_HOME;
    const sdkRoot = process.env.DSH_SDK_FIXTURE_ROOT;
    if (!home || !sdkRoot) throw new Error('task-owned SDK fixture paths required');
    const dataDir = join(home, 'dsh-livestream');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ stagePort: 0, stageToken: 'synthetic-stage',
      livePlatform: 'douyin', roomId: '12345' }), { mode: 0o600 });
    const cordisPath = pathToFileURL(join(sdkRoot, '@deepseek-ai/cordis/lib/index.js')).href;
    const sdkPath = pathToFileURL(join(sdkRoot, '@deepseek-ai/dsh-client-connection/lib/index.js')).href;
    const { Context } = await import(/* @vite-ignore */ cordisPath);
    const { HostConnectionService } = await import(/* @vite-ignore */ sdkPath);
    const context = new Context();
    const connection = new HostConnectionService(context, [], {
      isAuthenticated: (request: { fixtureOwner?: boolean }) => request.fixtureOwner === true,
      authenticateApi: () => undefined,
    });
    let calls = 0;
    const registered = connection.fetch;
    const hostContext = {
      effect(effect: () => unknown, label?: string) {
        if (label === 'state' || label === 'settings' || label === 'public chat' || label === 'dsh-livestream public chat') return effect();
      },
      get() { return undefined; },
      provide() {},
      connection: { fetch: { register(route: { fetch: (request: Request) => Promise<Response>; [key: string]: unknown }) {
        return registered.register({ ...route, fetch: (request: Request) => { calls++; return route.fetch(request); } });
      } } },
    };
    const runtime = await import('../../src/dsh/runtime');
    const host = await import('../../src/dsh/index');
    host.apply(hostContext as any);
    const handler = connection.createSharedFetchHandler('/api');
    const requestInfo = { headers: { host: '127.0.0.1:49123' } };
    expect(connection.admit(requestInfo)).toEqual({ rejection: 401 });
    expect(connection.admit({ fixtureOwner: true, headers: { host: '127.0.0.1:49123', origin: 'https://example.invalid' } })).toEqual({ rejection: 403 });
    const owner = connection.admit({ ...requestInfo, fixtureOwner: true }).peer;
    const guest = connection.createPeer({ principal: { kind: 'guest' } });
    try {
      const make = (body?: object) => new Request('http://127.0.0.1:49123/api/dsh-livestream/public-chat', body
        ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
      for (const body of [undefined, { action: 'login-start' }, { action: 'login-cancel', attemptId: 'synthetic', revision: 1 },
        { action: 'confirm-session', bindingRef: 'synthetic' }, { action: 'authorize' }]) {
        expect((await handler.fetch(make(body), guest)).status).toBe(403);
      }
      expect(calls).toBe(0);
      const response = await handler.fetch(make(), owner);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(calls).toBe(1);
      expect((await response.json()).publicChat.historyAvailable).toBe(false);
    } finally {
      await guest.dispose();
      runtime.show.dispose();
      await context.fiber.dispose();
    }
  });
});
