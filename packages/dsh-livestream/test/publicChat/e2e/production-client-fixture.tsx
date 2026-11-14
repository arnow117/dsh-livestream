import React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';

const container = document.getElementById('app');
if (!container) throw new Error('fixture container missing');
const root = createRoot(container);
const context = {
  workspaces: { list: { getSnapshot: () => ({ items: [] }) } },
  uiWorkspace: { openSession: () => {} },
  sessions: {},
  remote: { agentPresets: {}, credentials: null },
  layout: { selectPanel: () => {} },
  effect(effect: () => unknown) { effect(); },
  inject(_deps: string[], callback: (value: unknown) => void) { callback(context); },
  slots: {
    inject(_name: string, callback: () => unknown) { callback(); },
    register(spec: { name: string; key?: string }, component: React.ComponentType) {
      if (spec.name === 'main' && spec.key === 'dsh-livestream') root.render(React.createElement(component));
      return () => {};
    },
  },
};
(window as unknown as { __ModuleLoader__: unknown }).__ModuleLoader__ = {
  load({ id, factory }: { id: string; factory: (load: (name: string) => unknown) => { apply(ctx: unknown): void } }) {
    if (id !== 'dsh-livestream') throw new Error('unexpected client module');
    const client = factory((name) => {
      if (name === 'react') return React;
      if (name === 'react/jsx-runtime') return jsxRuntime;
      throw new Error(`unexpected client import: ${name}`);
    });
    client.apply(context);
  },
};
