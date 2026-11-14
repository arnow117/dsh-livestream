const path = require("node:path");
const esbuild = require("esbuild");
const fs = require("node:fs");
const testRoot = process.env.REGISTRATION_TEST_ROOT;
if (
  !testRoot ||
  !path.isAbsolute(testRoot) ||
  fs.realpathSync(testRoot) !== testRoot
)
  throw new Error("test_paths_unavailable");
const info = fs.lstatSync(testRoot);
if (
  !info.isDirectory() ||
  info.isSymbolicLink() ||
  info.uid !== process.getuid?.() ||
  (info.mode & 0o077) !== 0
)
  throw new Error("test_paths_unavailable");
esbuild
  .build({
    entryPoints: [path.join(__dirname, "browser-entry.tsx")],
    outfile: path.join(process.env.REGISTRATION_TEST_ROOT, "browser.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    metafile: true,
  })
  .then((result) =>
    require("node:fs").writeFileSync(
      path.join(process.env.REGISTRATION_TEST_ROOT, "browser-meta.json"),
      JSON.stringify(result.metafile, null, 2),
    ),
  )
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
