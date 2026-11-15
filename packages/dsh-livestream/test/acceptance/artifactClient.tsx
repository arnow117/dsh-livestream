/** Harness-style module loader for the unmodified standard client artifact. */
import React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';

const root = createRoot(document.getElementById('root')!);
const context: any = {
  workspaces: { list: { getSnapshot: () => ({ items: [{ workspaceId: 'fixture' }] }) } },
  uiWorkspace: { openSession() {} },
  sessions: {
    create: async () => (await (await fetch('/__legacy-session', { method: 'POST' })).json()).id,
    using: async (_target: unknown, _options: unknown, operation: any) => operation({ ready: Promise.resolve({ session: { rename: async () => {} } }) }),
  },
  remote: { agentPresets: { select: async () => ({ ok: true }) }, credentials: { describe: async () => ({ ok: true, value: {} }), set: async () => {} } },
  layout: { selectPanel() {} },
  effect(effect: () => unknown) { effect(); },
  inject(_dependencies: string[], callback: (ctx: unknown) => void) { callback(context); },
  slots: {
    inject(_name: string, callback: () => unknown) { callback(); },
    register(spec: { name: string; key?: string }, component: React.ComponentType) {
      if (spec.name === 'main' && spec.key === 'dsh-livestream') root.render(React.createElement(component));
      return () => {};
    },
  },
};
(window as any).__ModuleLoader__ = {
  load({ id, factory }: { id: string; factory: (require: (name: string) => unknown) => { apply(ctx: unknown): void } }) {
    if (id !== 'dsh-livestream') throw new Error('unexpected standard client');
    const client = factory((name) => {
      if (name === 'react') return React;
      if (name === 'react/jsx-runtime') return jsxRuntime;
      throw new Error(`unexpected standard client dependency: ${name}`);
    });
    client.apply(context);
    (window as any).__standardClientLoaded = true;
  },
};
