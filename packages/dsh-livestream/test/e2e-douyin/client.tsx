import React from 'react';
import { createRoot } from 'react-dom/client';
import { bindConsole, bindCredentials, Console, CONSOLE_CSS } from '../../src/console/console';

const style = document.createElement('style');
style.textContent = CONSOLE_CSS;
document.head.append(style);
bindCredentials({ describe: async () => ({ ok: true, value: {} }), set: async () => {} });
bindConsole({
  workspaces: { list: { getSnapshot: () => ({ items: [{ workspaceId: 'test' }] }) } },
  uiWorkspace: { openSession() {} },
  sessions: {
    create: async () => 'fake-brain',
    using: async (_target, _options, operation) => operation({ ready: Promise.resolve({ session: {} }) }),
  },
  remote: { agentPresets: { select: async (_session, preset) => {
    await fetch('/__preset', { method: 'POST', body: preset });
    return { ok: true };
  } } },
  layout: { selectPanel() {} },
});
createRoot(document.getElementById('root')!).render(<Console />);
