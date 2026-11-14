import React from 'react';
import { createRoot } from 'react-dom/client';
import { Console, CONSOLE_CSS } from '../../../src/console/console';

const style = document.createElement('style');
style.textContent = CONSOLE_CSS;
document.head.append(style);
const container = document.getElementById('app');
if (!container) throw new Error('fixture container missing');
createRoot(container).render(<Console />);
