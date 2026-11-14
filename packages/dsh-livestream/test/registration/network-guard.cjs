const net = require("node:net");
const http = require("node:http");
const https = require("node:https");
const tls = require("node:tls");
const denied = () => {
  throw new Error("task_network_denied");
};
net.Server.prototype.listen = denied;
net.connect = denied;
net.createConnection = denied;
http.request = denied;
http.get = denied;
https.request = denied;
https.get = denied;
tls.connect = denied;
globalThis.fetch = async () => {
  throw new Error("task_network_denied");
};
