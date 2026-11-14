'use strict';
const net = require('node:net');
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
