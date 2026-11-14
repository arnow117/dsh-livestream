const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "../..");
const testRoot = process.env.REGISTRATION_TEST_ROOT;
if (
  !testRoot ||
  !path.isAbsolute(testRoot) ||
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
const pkg = root;
const source = path.join(pkg, "src/registration/nativeCli");
const output = path.join(testRoot, "asset-build");
const node = process.execPath;
const expected =
  "154145d18732e0a1823d91be611dcff55bdda36ac46c1fce7c3354748d9e94c4";
const sha = (file) =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const commands = [];
function build(cwd, destination, args = []) {
  const env = { ...process.env, DSH_LIVESTREAM_BUILD_OUT: destination };
  const argv = ["build.mjs", ...args];
  const result = spawnSync(node, argv, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 60000,
  });
  commands.push({
    argv: [node, ...argv],
    cwd,
    outdir: destination,
    pid: result.pid,
    exit_code: result.status,
    signal: result.signal,
    stderr: result.stderr?.slice(0, 1200),
  });
  return result;
}
function verify() {
  const asset = path.join(output, "nativeCli"),
    binary = path.join(asset, "registration-native");
  const info = fs.lstatSync(binary),
    dir = fs.lstatSync(asset);
  assert.equal(sha(binary), expected);
  assert.equal(info.size, 57996370);
  assert.equal(info.mode & 0o7777, 0o500);
  assert.equal(dir.mode & 0o7777, 0o500);
  assert.equal(info.nlink, 1);
  assert.equal(info.uid, process.getuid());
  assert.deepEqual(
    fs.readdirSync(asset).sort(),
    ["NOTICE.md", "UPSTREAM-LICENSE", "registration-native"].sort(),
  );
  assert.equal(
    sha(path.join(asset, "NOTICE.md")),
    sha(path.join(source, "NOTICE.md")),
  );
  assert.equal(
    sha(path.join(asset, "UPSTREAM-LICENSE")),
    sha(path.join(source, "UPSTREAM-LICENSE")),
  );
  const index = fs.readFileSync(path.join(output, "index.js"), "utf8");
  assert.ok(
    index.includes(
      'new URL("./nativeCli/registration-native", import.meta.url)',
    ),
  );
  return {
    inode: info.ino,
    digest: sha(binary),
    mtimeMs: info.mtimeMs,
    dirMode: dir.mode & 0o7777,
  };
}
let faultRoot;
try {
  assert.equal(build(pkg, output).status, 0);
  const first = verify();
  assert.equal(build(pkg, output).status, 0);
  const second = verify();
  const beforeClient = verify();
  assert.equal(build(pkg, output, ["--client"]).status, 0);
  const afterClient = verify();
  assert.deepEqual(afterClient, beforeClient);
  faultRoot = fs.mkdtempSync(path.join(testRoot, "assets-"));
  const modules = path.join(faultRoot, "node_modules");
  fs.mkdirSync(modules, { mode: 0o700 });
  const esbuildRoot = path.dirname(
    fs.realpathSync(require.resolve("esbuild/package.json")),
  );
  fs.symlinkSync(esbuildRoot, path.join(modules, "esbuild"));
  for (const kind of ["missing", "wronghash", "symlink"]) {
    const dir = path.join(faultRoot, kind),
      native = path.join(dir, "src/registration/nativeCli"),
      dest = path.join(dir, "out");
    fs.mkdirSync(native, { recursive: true, mode: 0o700 });
    fs.mkdirSync(dest, { mode: 0o700 });
    fs.copyFileSync(path.join(pkg, "build.mjs"), path.join(dir, "build.mjs"));
    fs.copyFileSync(
      path.join(source, "NOTICE.md"),
      path.join(native, "NOTICE.md"),
    );
    fs.copyFileSync(
      path.join(source, "UPSTREAM-LICENSE"),
      path.join(native, "UPSTREAM-LICENSE"),
    );
    fs.writeFileSync(path.join(dest, "sentinel"), "unchanged");
    const candidate = path.join(native, "registration-native");
    if (kind === "wronghash") {
      const fd = fs.openSync(candidate, "wx", 0o500);
      fs.ftruncateSync(fd, 57996370);
      fs.closeSync(fd);
    }
    if (kind === "symlink")
      fs.symlinkSync(path.join(source, "registration-native"), candidate);
    const result = build(dir, dest);
    assert.notEqual(result.status, 0);
    assert.equal(
      fs.readFileSync(path.join(dest, "sentinel"), "utf8"),
      "unchanged",
    );
    assert.equal(fs.existsSync(path.join(dest, "nativeCli")), false);
  }
  console.log(
    JSON.stringify({
      pass: true,
      first,
      second,
      clientPreserved: afterClient,
      negativeCases: ["missing", "wronghash", "symlink"],
      nativeExecuted: false,
      commands,
    }),
  );
} finally {
  if (faultRoot) fs.rmSync(faultRoot, { recursive: true, force: false });
}
