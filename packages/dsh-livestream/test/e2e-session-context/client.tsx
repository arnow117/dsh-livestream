import React from 'react';
import { createRoot } from 'react-dom/client';
import { bindConsole, bindCredentials, Console, CONSOLE_CSS } from '../../src/console/console';

const style = document.createElement('style');
style.textContent = CONSOLE_CSS;
document.head.append(style);
bindCredentials({
  describe: async () => ({ ok: true, value: {} }),
  set: async () => {},
});
bindConsole({
  workspaces: { list: { getSnapshot: () => ({ items: [{ workspaceId: 'fixture' }] }) } },
  uiWorkspace: { openSession() {} },
  sessions: {
    // 旧路径（未保存配置时的原创建）；管理路径由控制台直接 POST /api/dsh-livestream/sessions
    create: async () => (await (await fetch('/__legacy-session', { method: 'POST' })).json()).id,
    using: async (_target, _options, operation) => operation({ ready: Promise.resolve({ session: { rename: async () => {} } }) }),
  },
  remote: { agentPresets: { select: async () => ({ ok: true }) } },
  layout: { selectPanel() {} },
});
createRoot(document.getElementById('root')!).render(<Console />);
