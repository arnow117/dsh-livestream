const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");
require("./network-guard.cjs");
const root = path.resolve(__dirname, "../..");
const testRoot = process.env.REGISTRATION_TEST_ROOT;
const artifact = process.env.REGISTRATION_TEST_ARTIFACT;
if (
  !testRoot ||
  !path.isAbsolute(testRoot) ||
  !artifact ||
  !path.isAbsolute(artifact) ||
  fs.realpathSync(testRoot) !== testRoot
)
  throw new Error("test_paths_unavailable");
const testInfo = fs.lstatSync(testRoot);
if (
  !testInfo.isDirectory() ||
  testInfo.isSymbolicLink() ||
  testInfo.uid !== process.getuid?.() ||
  (testInfo.mode & 0o077) !== 0
)
  throw new Error("test_paths_unavailable");
const project = createRequire(path.join(root, "package.json"));
const work = fs.mkdtempSync(path.join(testRoot, "routes-"));
const home = path.join(work, "home");
fs.mkdirSync(home, { mode: 0o700 });
process.env.HOME = home;
const configDir = path.join(home, ".lark-cli");
fs.mkdirSync(configDir, { mode: 0o700 });
fs.writeFileSync(
  path.join(configDir, "config.json"),
  JSON.stringify({
    apps: [
      {
        name: "selected",
        appId: "app1",
        appSecret: { source: "keychain", id: "appsecret:app1" },
        brand: "feishu",
        dpopMode: "required",
        strictMode: "user",
        users: [{ userOpenId: "user1" }],
      },
    ],
  }),
  { mode: 0o600 },
);
const fields = {
  f1: "synthetic-name",
  f2: "synthetic-contact",
  f3: null,
  f4: "synthetic-interest",
  rev: 1,
};
const row = (extra) =>
  fs.writeFileSync(
    path.join(work, "row.json"),
    JSON.stringify({ fields, ...extra }),
    { mode: 0o600 },
  );
row();
const active = new Set(),
  pids = [];
globalThis.__testExecutable = process.execPath;
globalThis.__testSpawn = (exe, args, options) => {
  assert.equal(exe, process.execPath);
  assert.deepEqual(args, []);
  const child = spawn(
    process.execPath,
    [path.join(__dirname, "record-fixture.cjs")],
    {
      ...options,
      env: {
        ...options.env,
        TASK_FIXTURE_ROOT: work,
        NODE_OPTIONS: `--require=${path.join(__dirname, "network-guard.cjs")}`,
      },
    },
  );
  pids.push(child.pid);
  active.add(child);
  child.on("close", () => active.delete(child));
  return child;
};
let context, service, guest;
(async () => {
  const api = await import(
    pathToFileURL(path.join(testRoot, "read-test-bundle.mjs")).href
  );
  const { Context } = await import(
    pathToFileURL(project.resolve("@deepseek-ai/cordis")).href
  );
  const { HostConnectionService, Peer } = await import(
    pathToFileURL(project.resolve("@deepseek-ai/dsh-client-connection")).href
  );
  context = new Context();
  const connection = new HostConnectionService(context, [], {
    isAuthenticated: (request) =>
      request.headers.get("x-test-peer") === "owner",
    authenticateApi: (request) =>
      request.headers.get("x-test-peer") ?? undefined,
  });
  guest = new Peer(context, { principal: { kind: "guest" } });
  connection.peers.set(guest.id, { peer: guest, ownsSocket: false });
  const workspacePath = path.join(work, "workspace");
  fs.mkdirSync(workspacePath, { mode: 0o700 });
  const workspace = { path: workspacePath };
  const registry = {
    get: (id) => (id === "workspace" ? workspace : undefined),
  };
  const host = {
    connection,
    get: (name) => (name === "workspaceRegistry" ? registry : undefined),
    plugin: async (plugin) => {
      const fiber = await context.plugin((child) => plugin(child));
      return { dispose: async () => fiber.dispose() };
    },
  };
  let saved = null,
    saves = 0;
  service = api.createReadService(host, {
    dataDir: work,
    getSaved: () => saved,
    save: (value) => {
      saved = value;
      saves++;
    },
  });
  const route = (routePath, methods, fetch) =>
    connection.fetch.register({
      path: routePath,
      methods,
      requestBody: "buffered",
      fetch,
    });
  api.registerReadRoutes(route, service);
  const handler = connection.createSharedFetchHandler("/api");
  const send = async (endpoint, body, peer = "owner", signal) => {
    const request = new Request(
      `http://localhost/api/dsh-livestream/registration/${endpoint}`,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          host: "localhost",
          "x-test-peer": peer,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal ? { signal } : {}),
      },
    );
    const admitted = connection.admit(request);
    if ("rejection" in admitted)
      return { status: admitted.rejection, body: null };
    const response = await handler.fetch(request, admitted.peer);
    return {
      status: response.status,
      body: await response.json().catch(() => null),
    };
  };
  const config = {
    workspaceId: "workspace",
    profile: "selected",
    appId: "app1",
    userOpenId: "user1",
    artifactDirectory: artifact,
    baseId: "base1",
    tableId: "table1",
    recordId: "record1",
    mappingId: "map",
    mappingRevision: 1,
    displayNameField: "f1",
    contactField: "f2",
    interestField: "f4",
    photoField: "f3",
    revisionField: "rev",
    consentField: null,
    sourceField: null,
    collectedAtField: null,
  };
  assert.equal((await send("settings")).body.saved, null);
  assert.equal((await send("settings", config, "stranger")).status, 401);
  assert.equal((await send("settings", config, guest.id)).status, 403);
  assert.equal((await send("live/read", {})).body.code, "not_authorized");
  assert.equal((await send("settings", config)).status, 200);
  assert.equal(saves, 1);
  assert.equal(fs.existsSync(path.join(work, "actions.log")), false);
  const configFile = path.join(configDir, "config.json");
  const validConfig = fs.readFileSync(configFile);
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      apps: [{ name: "selected", appId: "app1", appSecret: "synthetic-plain" }],
    }),
    { mode: 0o600 },
  );
  assert.equal(
    (await send("authorize", {})).body.code,
    "configuration_unavailable",
  );
  fs.writeFileSync(configFile, Buffer.alloc(1024 * 1024 + 1, 32));
  assert.equal(
    (await send("authorize", {})).body.code,
    "configuration_unavailable",
  );
  fs.writeFileSync(configFile, validConfig);
  fs.renameSync(configFile, configFile + ".real");
  fs.symlinkSync(configFile + ".real", configFile);
  assert.equal(
    (await send("authorize", {})).body.code,
    "configuration_unavailable",
  );
  fs.unlinkSync(configFile);
  fs.renameSync(configFile + ".real", configFile);
  assert.equal(fs.existsSync(path.join(work, "actions.log")), false);
  const duplicate = JSON.stringify(config).replace(
    '"workspaceId":"workspace"',
    '"workspaceId":"workspace","workspaceId":"workspace"',
  );
  const duplicateRequest = new Request(
    "http://localhost/api/dsh-livestream/registration/settings",
    {
      method: "POST",
      headers: {
        host: "localhost",
        "x-test-peer": "owner",
        "content-type": "application/json",
      },
      body: duplicate,
    },
  );
  const duplicateAdmission = connection.admit(duplicateRequest);
  assert.ok(!("rejection" in duplicateAdmission));
  const duplicateResponse = await handler.fetch(
    duplicateRequest,
    duplicateAdmission.peer,
  );
  assert.equal((await duplicateResponse.json()).code, "invalid_settings");
  assert.equal(
    (await send("authorize", { ownerRef: "forged" })).body.code,
    "invalid_settings",
  );
  assert.equal((await send("authorize", {})).status, 200);
  assert.equal(
    (await send("live/read", { consumer: "robot" })).body.code,
    "invalid_settings",
  );
  assert.equal(fs.existsSync(path.join(work, "actions.log")), false);
  const live = await send("live/read", {}),
    robot = await send("robot/consume", {});
  assert.equal(live.status, 200);
  assert.equal(robot.status, 200);
  assert.equal(live.body.result.fields.contactText, "synthetic-contact");
  assert.equal(robot.body.result.fields.productInterest, "synthetic-interest");
  assert.equal(live.body.result.fields.photo.state, "absent");
  assert.equal(live.body.result.readiness.state, "pending");
  assert.equal(live.body.result.submission, "unverified");
  assert.notEqual(live.body.result.requestRef, robot.body.result.requestRef);
  let actions = fs
    .readFileSync(path.join(work, "actions.log"), "utf8")
    .trim()
    .split("\n");
  assert.deepEqual(actions, [
    "user_info",
    "record_get",
    "user_info",
    "record_get",
  ]);
  fields.rev = null;
  row();
  assert.equal(
    (await send("live/read", {})).body.result.metadata.revision,
    "missing",
  );
  fields.rev = 1;
  fields.f3 = [{ file_token: "synthetic-token" }];
  row();
  const photo = await send("robot/consume", {});
  assert.equal(photo.body.result.fields.photo.state, "reference_only");
  assert.ok(!JSON.stringify(photo.body).includes("synthetic-token"));
  row({ wrongRecord: true });
  assert.equal((await send("live/read", {})).body.code, "record_changed");
  row({ ignoredFields: true });
  assert.equal((await send("live/read", {})).body.code, "field_permission");
  row({ malformed: true });
  assert.equal((await send("robot/consume", {})).body.code, "unknown");
  row({ delay: true });
  const controller = new AbortController();
  const delayed = send("live/read", {}, "owner", controller.signal);
  const deadline = Date.now() + 5000;
  while (
    !fs.existsSync(path.join(work, "read-entered")) &&
    Date.now() < deadline
  )
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(path.join(work, "read-entered")));
  assert.equal((await send("revoke", {})).status, 200);
  const late = await delayed;
  assert.notEqual(late.status, 200);
  assert.equal((await send("robot/consume", {})).body.code, "not_authorized");
  fields.f3 = null;
  row();
  assert.equal((await send("authorize", {})).status, 200);
  fs.unlinkSync(path.join(work, "read-entered"));
  row({ delay: true });
  const stale = send("robot/consume", {});
  const changeDeadline = Date.now() + 5000;
  while (
    !fs.existsSync(path.join(work, "read-entered")) &&
    Date.now() < changeDeadline
  )
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(path.join(work, "read-entered")));
  assert.equal(
    (await send("settings", { ...config, recordId: "record2" })).status,
    200,
  );
  assert.notEqual((await stale).status, 200);
  assert.equal((await send("settings", config)).status, 200);
  row();
  assert.equal((await send("authorize", {})).status, 200);
  fs.renameSync(workspacePath, workspacePath + "-original");
  fs.mkdirSync(workspacePath, { mode: 0o700 });
  assert.notEqual((await send("live/read", {})).status, 200);
  assert.equal((await send("settings")).body.authorized, false);
  fs.rmdirSync(workspacePath);
  fs.renameSync(workspacePath + "-original", workspacePath);
  assert.equal((await send("authorize", {})).status, 200);
  registry.get = () => undefined;
  assert.notEqual((await send("live/read", {})).status, 200);
  actions = fs
    .readFileSync(path.join(work, "actions.log"), "utf8")
    .trim()
    .split("\n");
  assert.ok(
    actions.every((action) => ["user_info", "record_get"].includes(action)),
  );
  assert.equal(active.size, 0);
  console.log(
    JSON.stringify({
      pass: true,
      sdk: "real HostConnectionService/Peer/routes",
      native: "Node process fixture",
      noReadBeforeAuthorization: true,
      independentReads: true,
      revokeLateResultRejected: true,
      configChangeLateResultRejected: true,
      configSnapshotRejectsPlainOversizedSymlink: true,
      workspaceReplacementRejected: true,
      noWrite: true,
      pids,
    }),
  );
})()
  .catch((error) => {
    console.error(error.stack);
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const child of active) child.kill("SIGKILL");
    if (active.size)
      await Promise.all(
        [...active].map(
          (child) => new Promise((resolve) => child.once("close", resolve)),
        ),
      );
    if (service) await service.dispose();
    if (guest) await guest.dispose();
    if (context) await context.fiber.dispose();
    delete globalThis.__testExecutable;
    delete globalThis.__testSpawn;
    fs.rmSync(work, { recursive: true, force: false });
  });
