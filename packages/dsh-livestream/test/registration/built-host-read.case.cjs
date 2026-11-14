const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");
const { spawn } = childProcess;
const { syncBuiltinESMExports } = require("node:module");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");
require("./network-guard.cjs");
const root = path.resolve(__dirname, "../..");
const testRoot = process.env.REGISTRATION_TEST_ROOT;
const artifact = process.env.REGISTRATION_TEST_ARTIFACT;
if (
  !testRoot ||
  !path.isAbsolute(testRoot) ||
  fs.realpathSync(testRoot) !== testRoot ||
  !artifact ||
  !path.isAbsolute(artifact)
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
const work = fs.mkdtempSync(path.join(testRoot, "fullhost-"));
const home = path.join(work, "home"),
  dshHome = path.join(work, "dsh-home");
fs.mkdirSync(path.join(home, ".lark-cli"), { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(dshHome, "dsh-livestream"), {
  recursive: true,
  mode: 0o700,
});
fs.writeFileSync(
  path.join(home, ".lark-cli/config.json"),
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
fs.writeFileSync(
  path.join(dshHome, "dsh-livestream/settings.json"),
  JSON.stringify({ stagePort: 0, stageToken: "fixture-stage-token" }),
  { mode: 0o600 },
);
process.env.HOME = home;
process.env.DSH_HOME = dshHome;
process.env.DSH_LIVESTREAM_LOCAL_REHEARSAL = "1";
process.env.DSH_LIVESTREAM_PACKAGE_DIR = root;
fs.writeFileSync(
  path.join(work, "row.json"),
  JSON.stringify({
    fields: {
      f1: "synthetic-name",
      f2: "synthetic-contact",
      f3: null,
      f4: "synthetic-interest",
      rev: 1,
    },
  }),
  { mode: 0o600 },
);
const active = new Set(),
  pids = [];
let context, fiber;
const nativePath = path.join(
  testRoot,
  "asset-build/nativeCli/registration-native",
);
childProcess.spawn = (exe, args, options) => {
  assert.equal(exe, nativePath);
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
  active.add(child);
  pids.push(child.pid);
  child.on("close", () => active.delete(child));
  return child;
};
syncBuiltinESMExports();
(async () => {
  const { Context } = await import(
    pathToFileURL(project.resolve("@deepseek-ai/cordis")).href
  );
  const { HostConnectionService } = await import(
    pathToFileURL(project.resolve("@deepseek-ai/dsh-client-connection")).href
  );
  context = new Context();
  const connection = new HostConnectionService(context, [], {
    isAuthenticated: (request) =>
      request.headers.get("x-test-peer") === "owner",
    authenticateApi: () => undefined,
  });
  const workspace = { path: work };
  const registry = {
    get: (id) => (id === "workspace" ? workspace : undefined),
  };
  context.provide("workspaceRegistry", registry);
  const host = await import(
    pathToFileURL(path.join(testRoot, "asset-build/index.js")).href
  );
  fiber = await context.plugin((child) => host.apply(child));
  const handler = connection.createSharedFetchHandler("/api");
  const send = async (endpoint, body, peer = "owner") => {
    const request = new Request(
      `http://localhost/api/dsh-livestream/${endpoint}`,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          host: "localhost",
          "x-test-peer": peer,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
  assert.equal((await send("registration/settings")).status, 200);
  assert.equal(
    (await send("registration/settings", config, "guest")).status,
    401,
  );
  assert.equal((await send("registration/settings", config)).status, 200);
  assert.equal(fs.existsSync(path.join(work, "actions.log")), false);
  const publicState = await send("state");
  assert.equal(publicState.status, 200);
  assert.equal(JSON.stringify(publicState.body).includes("record1"), false);
  assert.equal(
    JSON.stringify(publicState.body).includes("synthetic-contact"),
    false,
  );
  const authorized = await send("registration/authorize", {});
  if (authorized.status !== 200)
    console.error("authorization-code", authorized.body?.code);
  assert.equal(authorized.status, 200);
  assert.equal(fs.existsSync(path.join(work, "actions.log")), false);
  const live = await send("registration/live/read", {}),
    robot = await send("registration/robot/consume", {});
  assert.equal(live.body.result.fields.displayName, "synthetic-name");
  assert.equal(robot.body.result.fields.contactText, "synthetic-contact");
  assert.notEqual(live.body.result.requestRef, robot.body.result.requestRef);
  assert.deepEqual(
    fs.readFileSync(path.join(work, "actions.log"), "utf8").trim().split("\n"),
    ["user_info", "record_get", "user_info", "record_get"],
  );
  const persisted = fs.readFileSync(
    path.join(dshHome, "dsh-livestream/settings.json"),
    "utf8",
  );
  assert.ok(
    !persisted.includes("synthetic-contact") &&
      !persisted.includes("synthetic-name"),
  );
  assert.equal((await send("registration/revoke", {})).status, 200);
  assert.equal(
    (await send("registration/live/read", {})).body.code,
    "not_authorized",
  );
  assert.equal(active.size, 0);
  console.log(
    JSON.stringify({
      pass: true,
      realHostApply: true,
      actualSettingsPersistence: true,
      realSDKConnection: true,
      stageListenDenied: true,
      nativeVerifier: "actual built verifier and fixed binary hash",
      native: "Node synthetic process; binary not executed",
      actions: 4,
      noPublicValues: true,
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
    if (fiber) await fiber.dispose();
    if (context) await context.fiber.dispose();
    childProcess.spawn = spawn;
    syncBuiltinESMExports();
    fs.rmSync(work, { recursive: true, force: false });
  });
