const path = require("node:path");
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
const esbuild = require("esbuild");

esbuild
  .build({
    entryPoints: [path.join(__dirname, "read-entry.ts")],
    outfile: path.join(
      process.env.REGISTRATION_TEST_ROOT,
      "read-test-bundle.mjs",
    ),
    bundle: true,
    platform: "node",
    format: "esm",
    plugins: [
      {
        name: "fixture-native-process",
        setup(build) {
          build.onResolve({ filter: /^\.\/nativeArtifact$/ }, () => ({
            path: "native",
            namespace: "seam",
          }));
          build.onResolve({ filter: /^node:child_process$/ }, () => ({
            path: "spawn",
            namespace: "seam",
          }));
          build.onLoad({ filter: /.*/, namespace: "seam" }, (args) => ({
            contents:
              args.path === "native"
                ? "export function verifiedNativeExecutable(){return globalThis.__testExecutable;}"
                : "export function spawn(...args){return globalThis.__testSpawn(...args);}",
            loader: "js",
          }));
        },
      },
    ],
  })
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
