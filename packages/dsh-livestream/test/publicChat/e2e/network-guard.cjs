'use strict';
const net = require('node:net');
// Optional task-owned process evidence: record only identities, never argv or environment.
if (process.env.DSH_PUBLIC_CHAT_PROCESS_LOG) {
  const childProcess = require('node:child_process');
  const { appendFileSync } = require('node:fs');
  const originalSpawn = childProcess.spawn;
  const spawnSync = childProcess.spawnSync;
  childProcess.spawn = function (...args) {
    const child = originalSpawn.apply(this, args);
    const executable = String(args[0]);
    if (child.pid && /chrome|chromium|helper|vitest|e2e/i.test(executable)) {
      const result = spawnSync('/bin/ps', ['-o', 'pgid=', '-p', String(child.pid)], { encoding: 'utf8' });
      const group = result.status === 0 ? result.stdout.trim() : 'unavailable';
      const label = /chrome|chromium/i.test(executable) ? 'browser' : /helper/i.test(executable) ? 'helper' : 'runner';
      const log = process.env.DSH_PUBLIC_CHAT_PROCESS_LOG;
      appendFileSync(log, `spawn kind=${label} pid=${child.pid} pgid=${group} parent=${process.pid}\n`);
      child.once('exit', (code, signal) => {
        appendFileSync(log, `exit kind=${label} pid=${child.pid} code=${code} signal=${signal}\n`);
      });
    }
    return child;
  };
  require('node:module').syncBuiltinESMExports();
}
const forbidden = new Set([3080, 3081, 7390, 8757]);
const reserved = new Set();
const allowedHost = (host) => host === '127.0.0.1' || host === '::1' || host === '[::1]';
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  const first = args[0];
  const port = typeof first === 'object' && first ? first.port : first;
  const host = typeof first === 'object' && first ? first.host : args[1];
  if ((port !== 0 && !reserved.has(Number(port)) && Number(port) !== Number(process.env.DSH_E2E_PORT)) || forbidden.has(Number(port)) || !allowedHost(host)) {
    throw new Error('fixture listener denied');
  }
  if (port === 0) {
    this.once('listening', () => {
      const address = this.address();
      if (address && typeof address !== 'string' && !forbidden.has(address.port)) reserved.add(address.port);
    });
  }
  return listen.apply(this, args);
};
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = args[0];
  const options = Array.isArray(first) ? first[0] : first;
  const port = typeof options === 'object' && options ? Number(options.port) : Number(options);
  const host = typeof options === 'object' && options ? options.host : args[1];
  if (!Number.isInteger(port) || port <= 0 || forbidden.has(port) || !allowedHost(host)) {
    throw new Error('fixture connection denied');
  }
  return connect.apply(this, args);
};
const originalFetch = globalThis.fetch;
globalThis.fetch = function (resource, options) {
  const url = new URL(resource instanceof Request ? resource.url : String(resource));
  if (!allowedHost(url.hostname) || !url.port || forbidden.has(Number(url.port))) {
    throw new Error('fixture request denied');
  }
  return originalFetch.call(this, resource, options);
};
