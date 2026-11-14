import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const sdkRoot = '/Users/mac/hansen_agent_team/workspace/20261110-qdroid-dsh-t1/dsh-qdroid/node_modules';

describe('public chat settings through the installed connection SDK', () => {
  it('accepts an owner and rejects another peer and an unauthenticated request before the handler', async () => {
    const home = process.env.DSH_HOME;
    if (!home) throw new Error('isolated DSH_HOME required');
    const dataDir = join(home, 'dsh-livestream');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ stagePort: 0, stageToken: 'fixture-stage-token' }), { mode: 0o600 });

    const cordisPath = pathToFileURL(join(sdkRoot, '@deepseek-ai/cordis/lib/index.js')).href;
    const sdkPath = pathToFileURL(join(sdkRoot, '@deepseek-ai/dsh-client-connection/lib/index.js')).href;
    const { Context } = await import(/* @vite-ignore */ cordisPath);
    const { HostConnectionService } = await import(/* @vite-ignore */ sdkPath);
    const context = new Context();
    const connection = new HostConnectionService(context, [], {
      isAuthenticated: (request: { fixtureOwner?: boolean }) => request.fixtureOwner === true,
      authenticateApi: () => undefined,
    });
    let handlerCalls = 0;
    const registered = connection.fetch;
    const hostContext = {
      effect(effect: () => unknown, label?: string) {
        if (label === 'state' || label === 'settings' || label === 'public chat'
          || label === 'dsh-livestream public chat') return effect();
      },
      get() { return undefined; },
      provide() {},
      connection: {
        fetch: {
          register(route: { fetch: (request: Request) => Promise<Response>; [key: string]: unknown }) {
            return registered.register({ ...route, fetch: (request: Request) => { handlerCalls++; return route.fetch(request); } });
          },
        },
      },
    };
    const runtime = await import('../../src/dsh/runtime');
    const host = await import('../../src/dsh/index');
    host.apply(hostContext as any);
    const handler = connection.createSharedFetchHandler('/api');
    const original = { headers: { host: '127.0.0.1:49123' } };
    expect(connection.admit(original)).toEqual({ rejection: 401 });
    const ownerAdmission = connection.admit({ ...original, fixtureOwner: true });
    expect(ownerAdmission.peer).toBe(connection.browserPeer);
    const other = connection.createPeer({ principal: { kind: 'guest' } });
    try {
      const request = () => new Request('http://127.0.0.1:49123/api/dsh-livestream/settings', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ publicChat: { enabled: true, drafts: { manual: '普通文字' } } }),
      });
      const denied = await handler.fetch(request(), other);
      expect(denied.status).toBe(403);
      expect(handlerCalls).toBe(0);
      expect(runtime.settings.publicChat.enabled).toBe(false);
      const chatView = () => new Request('http://127.0.0.1:49123/api/dsh-livestream/public-chat');
      expect((await handler.fetch(chatView(), other)).status).toBe(403);
      expect(handlerCalls).toBe(0);
      const initialView = await handler.fetch(chatView(), ownerAdmission.peer);
      expect(initialView.status).toBe(200);
      expect((await initialView.json()).publicChat.available).toBe(false);
      expect(handlerCalls).toBe(1);
      const saved = await handler.fetch(request(), ownerAdmission.peer);
      expect(saved.status).toBe(200);
      expect(handlerCalls).toBe(2);
      const result = await saved.json();
      expect(result.publicChatSettings).toEqual({ enabled: true, reply: false, welcome: false, thanks: false,
        drafts: { manual: '普通文字' } });
      expect(JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8')).publicChat).toEqual(result.publicChatSettings);
      const invalid = await handler.fetch(new Request('http://127.0.0.1:49123/api/dsh-livestream/settings', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publicChat: { roomId: '102' } }),
      }), ownerAdmission.peer);
      expect(invalid.status).toBe(400);
      expect(runtime.settings.publicChat.drafts.manual).toBe('普通文字');
      const privateDraft = await handler.fetch(new Request('http://127.0.0.1:49123/api/dsh-livestream/settings', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ publicChat: { drafts: { manual: 'https://example.invalid/private' } } }),
      }), ownerAdmission.peer);
      expect(privateDraft.status).toBe(400);
      expect(JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8')).publicChat.drafts.manual).toBe('普通文字');
    } finally {
      await other.dispose();
      runtime.show.dispose();
      await context.fiber.dispose();
    }
  });
});
