/**
 * FEAT-010-T001 同版内部组合 fixture 的控制台客户端。
 *
 * 复用控制台原组件（src/console/console）与原样式，只把宿主能力换成 fixture 内的最小实现：
 * 工作区、会话创建、凭据、远端预置。绘制与交互逻辑完全走原组件，便于核对 1440/375 的可达性。
 */
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
    create: async () => (await (await fetch('/__legacy-session', { method: 'POST' })).json()).id,
    using: async (_target, _options, operation) => operation({ ready: Promise.resolve({ session: { rename: async () => {} } }) }),
  },
  remote: { agentPresets: { select: async () => ({ ok: true }) } },
  layout: { selectPanel() {} },
});
createRoot(document.getElementById('root')!).render(<Console />);
