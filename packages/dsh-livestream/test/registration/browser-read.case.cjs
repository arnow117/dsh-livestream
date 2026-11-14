const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");
const root = path.resolve(__dirname, "../..");
const testRoot = process.env.REGISTRATION_TEST_ROOT;
const artifact = process.env.REGISTRATION_TEST_ARTIFACT;
const browserExecutable = process.env.REGISTRATION_TEST_BROWSER;
if (
  !testRoot ||
  !path.isAbsolute(testRoot) ||
  fs.realpathSync(testRoot) !== testRoot ||
  !artifact ||
  !path.isAbsolute(artifact) ||
  !browserExecutable ||
  !path.isAbsolute(browserExecutable)
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
const playwrightPath = process.env.REGISTRATION_TEST_PLAYWRIGHT;
if (!playwrightPath || !path.isAbsolute(playwrightPath))
  throw new Error("test_paths_unavailable");
const playwright = require(playwrightPath);
const work = fs.mkdtempSync(path.join(testRoot, "browser-"));
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
let context, service, server, browser, page, port;
const active = new Set(),
  pids = [],
  publicOutputs = [],
  errors = [];
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
(async () => {
  const api = await import(
    pathToFileURL(path.join(testRoot, "read-test-bundle.mjs")).href
  );
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
  const host = {
    connection,
    get: (name) => (name === "workspaceRegistry" ? registry : undefined),
    plugin: async (plugin) => {
      const fiber = await context.plugin((child) => plugin(child));
      return { dispose: async () => fiber.dispose() };
    },
  };
  let saved = null;
  service = api.createReadService(host, {
    dataDir: work,
    getSaved: () => saved,
    save: (value) => {
      saved = value;
    },
  });
  api.registerReadRoutes(
    (routePath, methods, fetch) =>
      connection.fetch.register({
        path: routePath,
        methods,
        requestBody: "buffered",
        fetch,
      }),
    service,
  );
  const handler = connection.createSharedFetchHandler("/api");
  server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname.startsWith("/api/dsh-livestream/registration/")) {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const controller = new AbortController();
        res.on("close", () => {
          if (!res.writableEnded) controller.abort();
        });
        const request = new Request("http://localhost" + req.url, {
          method: req.method,
          headers: {
            host: "localhost",
            "x-test-peer": req.headers["x-test-peer"] || "",
            "content-type": "application/json",
          },
          ...(req.method === "GET" ? {} : { body: Buffer.concat(chunks) }),
          signal: controller.signal,
        });
        const admission = connection.admit(request);
        if ("rejection" in admission) {
          res.writeHead(admission.rejection).end();
          return;
        }
        const response = await handler.fetch(request, admission.peer);
        res.writeHead(
          response.status,
          Object.fromEntries(response.headers.entries()),
        );
        res.end(Buffer.from(await response.arrayBuffer()));
        return;
      }
      if (url.pathname === "/browser.js") {
        res.writeHead(200, { "content-type": "text/javascript" });
        res.end(fs.readFileSync(path.join(testRoot, "browser.js")));
        return;
      }
      if (url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(
          '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script src="/browser.js"></script></body></html>',
        );
        return;
      }
      publicOutputs.push(url.pathname);
      if (url.pathname.endsWith("/events")) {
        res.writeHead(204).end();
        return;
      }
      res
        .writeHead(503, { "content-type": "application/json" })
        .end('{"ok":false}');
    } catch (error) {
      errors.push(error.message);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
  assert.ok(![3080, 3081, 7390, 8757].includes(port));
  browser = await playwright.chromium.launch({
    executablePath: browserExecutable,
    headless: true,
    args: ["--disable-background-networking"],
  });
  const browserContext = await browser.newContext({
    viewport: { width: 375, height: 800 },
    extraHTTPHeaders: { "x-test-peer": "owner" },
  });
  page = await browserContext.newPage();
  const origin = `http://127.0.0.1:${port}`;
  await page.route("**/*", (route) =>
    new URL(route.request().url()).origin === origin
      ? route.continue()
      : route.abort(),
  );
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("heading", { name: "登记资料私有读取" }).waitFor();
  await page.getByText("尚未配置", { exact: true }).waitFor();
  const pairs = [
    ["工作区标识", "workspace"],
    ["身份配置名称", "selected"],
    ["应用标识", "app1"],
    ["用户标识", "user1"],
    ["共享组件目录", artifact],
    ["Base 标识", "base1"],
    ["数据表标识", "table1"],
    ["确切记录标识", "record1"],
    ["映射标识", "map"],
    ["用户名字段 ID", "f1"],
    ["联系方式字段 ID", "f2"],
    ["意向商品字段 ID", "f4"],
    ["照片字段 ID", "f3"],
    ["资料版本字段 ID（可留空）", "rev"],
  ];
  for (const [label, value] of pairs)
    await page.getByLabel(label, { exact: true }).fill(value);
  await page.getByLabel("工作区标识", { exact: true }).focus();
  await page.keyboard.press("Tab");
  assert.equal(
    await page.evaluate(() =>
      document.activeElement?.parentElement?.textContent?.trim(),
    ),
    "身份配置名称",
  );
  await page.getByRole("button", { name: "保存配置" }).click();
  await page.getByText("已保存记录：record1").waitFor();
  assert.equal(fs.existsSync(path.join(work, "actions.log")), false);
  await page.getByRole("button", { name: "授权当前记录" }).click();
  await page.getByText("当前记录已授权，仅本次私有读取可用").waitFor();
  assert.equal(fs.existsSync(path.join(work, "actions.log")), false);
  await page
    .getByRole("region", { name: "Live 私有读取" })
    .getByRole("button", { name: "读取" })
    .click();
  await page.getByText("用户名：synthetic-name", { exact: true }).waitFor();
  await page
    .getByRole("region", { name: "Robot 私有读取" })
    .getByRole("button", { name: "读取" })
    .click();
  await page
    .getByRole("region", { name: "Robot 私有读取" })
    .getByText("用户名：synthetic-name", { exact: true })
    .waitFor();
  assert.equal(
    await page.getByText("用户名：synthetic-name", { exact: true }).count(),
    2,
  );
  assert.equal(
    await page.getByText("照片：无照片", { exact: true }).count(),
    2,
  );
  assert.equal(
    await page
      .getByText("资料状态：记录已读取，元数据待核对", { exact: true })
      .count(),
    2,
  );
  assert.equal(
    await page.getByText("用途依据尚未核实", { exact: true }).count(),
    2,
  );
  assert.equal(
    await page.getByText("收集来源或时间尚未核实", { exact: true }).count(),
    2,
  );
  assert.equal(
    await page.getByText("资料状态：已核无照片", { exact: true }).count(),
    0,
  );
  const actions = fs
    .readFileSync(path.join(work, "actions.log"), "utf8")
    .trim()
    .split("\n");
  assert.deepEqual(actions, [
    "user_info",
    "record_get",
    "user_info",
    "record_get",
  ]);
  fields.f3 = [{ file_token: "synthetic-photo-token" }];
  row();
  await page
    .getByRole("region", { name: "Robot 私有读取" })
    .getByRole("button", { name: "读取" })
    .click();
  await page
    .getByText("照片：有照片引用，未核验内容", { exact: true })
    .waitFor();
  assert.equal(await page.getByText("synthetic-photo-token").count(), 0);
  row({ wrongRecord: true });
  await page
    .getByRole("region", { name: "Robot 私有读取" })
    .getByRole("button", { name: "读取" })
    .click();
  await page
    .getByRole("alert")
    .getByText("记录或映射已变化，请重新核对")
    .waitFor();
  row({ ignoredFields: true });
  await page
    .getByRole("region", { name: "Robot 私有读取" })
    .getByRole("button", { name: "读取" })
    .click();
  await page.getByRole("alert").getByText("字段权限不足").waitFor();
  row({ malformed: true });
  await page
    .getByRole("region", { name: "Robot 私有读取" })
    .getByRole("button", { name: "读取" })
    .click();
  await page.getByRole("alert").getByText("读取失败或结果未知").waitFor();
  fields.f3 = null;
  for (const width of [375, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    const dimensions = await page.locator(".dl-drawer").evaluate((node) => ({
      client: node.clientWidth,
      scroll: node.scrollWidth,
    }));
    assert.ok(
      dimensions.scroll <= dimensions.client + 1,
      `horizontal overflow at ${width}`,
    );
  }
  row({ delay: true });
  await page
    .getByRole("region", { name: "Live 私有读取" })
    .getByRole("button", { name: "读取" })
    .click();
  const until = Date.now() + 5000;
  while (!fs.existsSync(path.join(work, "read-entered")) && Date.now() < until)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(path.join(work, "read-entered")));
  assert.equal(
    await page
      .getByRole("region", { name: "Live 私有读取" })
      .getByRole("button", { name: "读取" })
      .isDisabled(),
    true,
  );
  assert.equal(
    await page.getByRole("button", { name: "撤销授权并清除" }).isEnabled(),
    true,
  );
  await page.getByRole("button", { name: "撤销授权并清除" }).click();
  await page.getByText("尚未授权读取").waitFor();
  assert.equal(
    await page.getByText("用户名：synthetic-name", { exact: true }).count(),
    0,
  );
  await new Promise((resolve) => setTimeout(resolve, 2200));
  assert.equal(
    await page.getByText("用户名：synthetic-name", { exact: true }).count(),
    0,
  );
  row();
  await page.getByRole("button", { name: "授权当前记录" }).click();
  await page.getByText("当前记录已授权，仅本次私有读取可用").waitFor();
  await page
    .getByRole("region", { name: "Live 私有读取" })
    .getByRole("button", { name: "读取" })
    .click();
  await page.getByText("用户名：synthetic-name", { exact: true }).waitFor();
  await page.getByLabel("确切记录标识", { exact: true }).fill("record2");
  assert.equal(
    await page.getByText("用户名：synthetic-name", { exact: true }).count(),
    0,
  );
  assert.equal(
    await page
      .getByRole("region", { name: "Live 私有读取" })
      .getByRole("button", { name: "读取" })
      .isDisabled(),
    true,
  );
  assert.ok(
    fs
      .readFileSync(path.join(work, "actions.log"), "utf8")
      .trim()
      .split("\n")
      .every((action) => ["user_info", "record_get"].includes(action)),
  );
  assert.ok(publicOutputs.every((item) => !item.includes("synthetic")));
  assert.deepEqual(errors, []);
  await browserContext.close();
  console.log(
    JSON.stringify({
      pass: true,
      port,
      viewportWidths: [375, 1440],
      actualConsoleDrawer: true,
      keyboardLabels: true,
      saveAndAuthorizeZeroReads: true,
      independentLiveRobot: true,
      readRevokeClears: true,
      photoTokenHidden: true,
      recordChangeShown: true,
      loadingPreventsRepeat: true,
      configChangeClears: true,
      pendingReasonsShown: true,
      native: "Node synthetic child",
      publicOutputsExercised: publicOutputs,
      childPids: pids,
      qrcode: "real installed 1.5.4; login not called",
    }),
  );
})()
  .catch((error) => {
    console.error(error.stack);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (page) await page.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    for (const child of active) child.kill("SIGKILL");
    if (active.size)
      await Promise.all(
        [...active].map(
          (child) => new Promise((resolve) => child.once("close", resolve)),
        ),
      );
    if (service) await service.dispose();
    if (context) await context.fiber.dispose();
    if (server) await new Promise((resolve) => server.close(resolve));
    delete globalThis.__testExecutable;
    delete globalThis.__testSpawn;
    fs.rmSync(work, { recursive: true, force: false });
  });
