const assert = require("node:assert/strict");
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
const work = fs.mkdtempSync(path.join(testRoot, "output-symlink-"));
try {
  const out = path.join(work, "out"),
    target = path.join(work, "target");
  fs.mkdirSync(out, { mode: 0o700 });
  fs.mkdirSync(target, { mode: 0o700 });
  fs.writeFileSync(path.join(target, "sentinel"), "unchanged");
  fs.symlinkSync(target, path.join(out, "nativeCli"));
  const argv = ["build.mjs"];
  const result = spawnSync(process.execPath, argv, {
    cwd: pkg,
    env: { ...process.env, DSH_LIVESTREAM_BUILD_OUT: out },
    encoding: "utf8",
    timeout: 60000,
  });
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /previous native asset directory is not owned output/,
  );
  assert.ok(fs.lstatSync(path.join(out, "nativeCli")).isSymbolicLink());
  assert.equal(
    fs.readFileSync(path.join(target, "sentinel"), "utf8"),
    "unchanged",
  );
  console.log(
    JSON.stringify({
      pass: true,
      argv: [process.execPath, ...argv],
      cwd: pkg,
      childPid: result.pid,
      childExit: result.status,
      nativeExecuted: false,
      outputSymlinkRejected: true,
    }),
  );
} finally {
  fs.rmSync(work, { recursive: true, force: false });
}
