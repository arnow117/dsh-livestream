import React from 'react';
import { createRoot } from 'react-dom/client';
import { bindConsole, bindCredentials, Console, CONSOLE_CSS } from '../../src/console/console';

const style = document.createElement('style');
style.textContent = CONSOLE_CSS;
document.head.append(style);
bindCredentials({
  describe: async () => ({ ok: true, value: await (await fetch('/__credential')).json() }),
  set: async (_ref, value) => { await fetch('/__credential', { method: 'POST', body: value }); },
});
bindConsole({
  workspaces: { list: { getSnapshot: () => ({ items: [{ workspaceId: 'fixture' }] }) } },
  uiWorkspace: { openSession() {} },
  sessions: {
    create: async () => (await (await fetch('/__session', { method: 'POST' })).json()).id,
    using: async (target, _options, operation) => operation({ ready: Promise.resolve({ session: { cancel: async () => { await fetch('/__cancel', { method: 'POST', body: target }); } } }) }),
  },
  remote: { agentPresets: { select: async (_session, preset) => {
    await fetch('/__preset', { method: 'POST', body: preset });
    return { ok: true };
  } } },
  layout: { selectPanel() {} },
});
createRoot(document.getElementById('root')!).render(<Console />);
