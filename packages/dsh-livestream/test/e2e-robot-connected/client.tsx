import React from 'react';
import { createRoot } from 'react-dom/client';
import { Console, CONSOLE_CSS, bindCredentials } from '../../src/console/console';

const style = document.createElement('style');
style.textContent = CONSOLE_CSS;
document.head.append(style);
bindCredentials({
  describe: async () => ({ ok: true, value: {} }),
  set: async () => {},
});
createRoot(document.getElementById('root')!).render(<Console />);
