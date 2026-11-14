const path = require("node:path");
const { createRequire } = require("node:module");
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
const project = createRequire(path.join(__dirname, "../../package.json"));
esbuild
  .build({
    entryPoints: [path.join(__dirname, "fullhost-entry.ts")],
    outfile: path.join(
      process.env.REGISTRATION_TEST_ROOT,
      "fullhost-test-bundle.mjs",
    ),
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    metafile: true,
    plugins: [
      {
        name: "fixture-seams",
        setup(build) {
          build.onResolve(
            { filter: /^@turf\/boolean-point-in-polygon$/ },
            (args) => ({ path: project.resolve(args.path), external: true }),
          );
          build.onResolve({ filter: /^\.\/nativeArtifact$/ }, () => ({
            path: "native",
            namespace: "seam",
          }));
          build.onResolve({ filter: /^node:child_process$/ }, (args) =>
            args.importer.endsWith("/registration/boundedProcess.ts")
              ? { path: "spawn", namespace: "seam" }
              : undefined,
          );
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
  .then((result) =>
    require("node:fs").writeFileSync(
      path.join(process.env.REGISTRATION_TEST_ROOT, "fullhost-meta.json"),
      JSON.stringify(result.metafile, null, 2),
    ),
  )
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
