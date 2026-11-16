import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import React, { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { PublicChatHost } from '../../src/publicChat/publicChatHost';
import { PublicChatSettingsPanel, type PublicChatView } from '../../src/publicChat/PublicChatSettingsPanel';
import { DEFAULT_PUBLIC_CHAT_SETTINGS } from '../../src/publicChat/settings';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function until<T>(read: () => Promise<T>, matches: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 12000;
  for (;;) {
    const result = await read();
    if (matches(result)) return result;
    if (Date.now() > deadline) throw new Error('synthetic login timed out');
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

describe('verified session loader and original private launcher', () => {
  it.each([true, false])('shows the verified target and retains the same helper (healthy history: %s)', async (healthy) => {
    const root = process.env.DSH_HOME;
    const binary = process.env.DSH_SESSION_FIXTURE_BINARY;
    const qr = process.env.DSH_QR_FIXTURE;
    const bundle = process.env.DSH_SENDER_FIXTURE_BUNDLE;
    const manifest = process.env.DSH_SENDER_FIXTURE_MANIFEST;
    const raw = process.env.DSH_RAW_FIXTURE;
    const helperSource = process.env.DSH_HELPER_SOURCE_FIXTURE;
    if (!root || !binary || !qr || !bundle || !manifest || !raw || !helperSource || binary.includes("'")) {
      throw new Error('task-owned synthetic inputs required');
    }
    const directory = mkdtempSync(join(root, 'verified-session-'));
    const dataDir = join(directory, 'data');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dataDir, { mode: 0o700 });
    copyFileSync(qr, join(dataDir, 'qr.png'));
    const journalPath = join(dataDir, 'public-chat-operations.json');
    const original = Buffer.from(healthy ? JSON.stringify({ schemaVersion: 4, records: [], controls: [] }) : '{synthetic-invalid');
    writeFileSync(journalPath, original, { mode: 0o600 });
    const wrapper = join(directory, 'synthetic-helper');
    writeFileSync(wrapper, `#!/bin/sh\nprintf '%s\\n' "$$" > "$PWD/fixture-pid"\nDSH_SESSION_FIXTURE=1 DSH_QR_FIXTURE="$PWD/qr.png" DSH_CHAT_COUNT_FILE="$PWD/chat-count.json" exec '${binary}' -test.run='^TestSessionFixtureServer$' -test.timeout=45s\n`, { mode: 0o500 });
    const files: Record<string, string> = {};
    const enumerate = (relative = '') => {
      for (const entry of readdirSync(join(helperSource, relative), { withFileTypes: true })) {
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) enumerate(name);
        else if (entry.isFile() && !name.endsWith('_test.go')) files[name] = hash(readFileSync(join(helperSource, name)));
        else if (!entry.isFile()) throw new Error('synthetic helper source unsafe');
      }
    };
    enumerate();
    const helperManifest = join(directory, 'helper-manifest.json');
    const helperManifestBytes = Buffer.from(JSON.stringify({ schemaVersion: 2, binaryPath: wrapper,
      binarySha256: hash(readFileSync(wrapper)), sourceFiles: files }));
    writeFileSync(helperManifest, helperManifestBytes, { mode: 0o600 });
    const buildDeployment = join(directory, 'build-deployment.json');
    const manifestHash = hash(readFileSync(manifest));
    writeFileSync(buildDeployment, JSON.stringify({ bundlePath: bundle, exportPath: raw, manifestPath: manifest, manifestSha256: manifestHash }), { mode: 0o600 });
    const probe = createServer();
    await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
    const address = probe.address();
    if (!address || typeof address === 'string') throw new Error('fixture port unavailable');
    const port = address.port;
    await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
    const deploymentPath = join(directory, 'deployment.json');
    writeFileSync(deploymentPath, JSON.stringify({ schemaVersion: 2, transportKind: 'session_http', listenUrl: `http://127.0.0.1:${port}`,
      token: 'synthetic-token', roomId: '12345', accountRecordId: 'fixture-account', buildDigest: manifestHash,
      instanceId: 'fixture-instance', dataDir }), { mode: 0o600 });
    const variables: Record<string, string> = { DSH_PUBLIC_CHAT_BUILD_DEPLOYMENT_FILE: buildDeployment,
      DSH_PUBLIC_CHAT_DEPLOYMENT_FILE: deploymentPath, DSH_PUBLIC_CHAT_HELPER_MANIFEST: helperManifest,
      DSH_PUBLIC_CHAT_HELPER_MANIFEST_SHA256: hash(helperManifestBytes), DSH_PUBLIC_CHAT_HELPER_SOURCE_DIRECTORY: helperSource,
      DSH_PUBLIC_CHAT_HELPER_DATA_DIR: dataDir };
    const prior = Object.fromEntries(Object.keys(variables).map((key) => [key, process.env[key]]));
    Object.assign(process.env, variables);
    let savedRoom = '12345';
    const host = new PublicChatHost(() => true, () => true, () => 'synthetic', () => false, () => savedRoom);
    let sender: { close(): Promise<void> } | null = null;
    try {
      const initial = await host.view();
      expect(initial).toMatchObject({ historyAvailable: healthy, transportKind: 'session_http' });
      if (!healthy) expect(initial.hold).toBe(true);
      expect(existsSync(join(dataDir, 'fixture-pid'))).toBe(false);
      expect((await host.loginStart()).ok).toBe(true);
      const ready = await until(() => host.view(), (view) => view.login?.state === 'confirmation_required');
      expect(ready.login?.principalUid).toBe('18446744073709551615');
      expect(ready.identity).toMatchObject({ accountRecordId: 'fixture-account', roomId: '12345', platformRoomId: null, qualified: false });
      expect(existsSync(join(dataDir, 'chat-count.json'))).toBe(false);
      savedRoom = '54321';
      expect((await host.view()).identity).toBeNull();
      expect(await host.confirmSession({ bindingRef: ready.login!.bindingRef })).toMatchObject({ ok: false, reason: 'saved-room-mismatch' });
      savedRoom = '12345';
      if (healthy) {
        const { JSDOM } = await import('jsdom');
        const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1/' });
        const globals = ['window', 'document', 'navigator', 'HTMLElement'] as const;
        const previous = new Map(globals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
        for (const name of globals) Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true });
        const { createRoot } = await import('react-dom/client');
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        const container = document.createElement('div');
        document.body.append(container);
        const panel = createRoot(container);
        const save = vi.fn(async () => {});
        const action = vi.fn(async (input: Record<string, unknown>) => input.action === 'confirm-session'
          ? host.confirmSession({ bindingRef: input.bindingRef }) : { ok: false });
        try {
          await act(async () => { panel.render(React.createElement(PublicChatSettingsPanel, {
            saved: { ...DEFAULT_PUBLIC_CHAT_SETTINGS, enabled: true }, targetKey: 'douyin:12345', onSave: save,
            onView: async () => await host.view() as unknown as PublicChatView, onAction: action,
          })); });
          await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
          expect(container.textContent).toContain('房间：12345');
          expect(container.textContent).toContain('发送账号：18446744073709551615');
          const button = [...container.querySelectorAll('button')].find((item) => item.textContent?.trim() === '确认账号和房间');
          expect(button?.disabled).toBe(false);
          await act(async () => { button!.click(); });
          expect(action).toHaveBeenCalledOnce();
          expect(save).not.toHaveBeenCalled();
          expect((await host.view()).login?.state).toBe('authenticated');
        } finally {
          await act(async () => { panel.unmount(); });
          container.remove();
          dom.window.close();
          for (const name of globals) {
            const descriptor = previous.get(name);
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else Reflect.deleteProperty(globalThis, name);
          }
        }
      } else {
        expect((await host.confirmSession({ bindingRef: ready.login!.bindingRef })).ok).toBe(true);
      }
      expect(readFileSync(journalPath)).toEqual(original);
      const pid = readFileSync(join(dataDir, 'fixture-pid'), 'utf8');
      console.info(`owned-verified-test-fixture pid=${pid.trim()} port=${port}`);
      if (!healthy) writeFileSync(journalPath, JSON.stringify({ schemaVersion: 4, records: [], controls: [] }), { mode: 0o600 });
      expect((await host.view()).historyAvailable).toBe(true);
      const internals = host as any;
      sender = internals.session.attach(internals.history);
      expect(readFileSync(join(dataDir, 'fixture-pid'), 'utf8')).toBe(pid);
      expect(existsSync(join(dataDir, 'chat-count.json'))).toBe(false);
    } finally {
      if (sender) await sender.close();
      await host.close();
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  }, 25000);
});
