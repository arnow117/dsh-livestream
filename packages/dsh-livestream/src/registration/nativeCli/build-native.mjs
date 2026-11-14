#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ownDir = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  readFileSync(path.join(ownDir, "candidate-manifest.json"), "utf8"),
);
const baselineBytes = readFileSync(
  path.join(ownDir, "upstream-source-manifest.json"),
);
const patch = path.join(ownDir, "registration-native.patch");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hashFile = (file) => hash(readFileSync(file));
const pinned = {
  revision: "8d8357d39dd15ac5e9aa815d4ab2639d56bd3239",
  source: "a709190ec00caafa4b737ad5925d30a1da509d3533a92caf8b65a27ddd7b2ac0",
  baseline: "fd9f1b182061b27a2b4a2908432799cbd7c3d23f1a0f0ccb1d4939888c01777b",
  patch: "af6c215c5ba663c4970408e565ef1280fa42e1870c8f8233e0386379d91dee3b",
  changes: "52a83ad63423d187f3de5acc693198de54a90a082e1f24036d6fc0480692594e",
  toolchain: "go1.27.3",
};
if (
  manifest.upstream_revision !== pinned.revision ||
  manifest.source_archive_sha256 !== pinned.source ||
  manifest.source_manifest_sha256 !== pinned.baseline ||
  manifest.patch_sha256 !== pinned.patch ||
  manifest.go_version !== pinned.toolchain ||
  hash(Buffer.from(JSON.stringify(manifest.changed_sources))) !== pinned.changes
)
  throw new Error("build manifest identity mismatch");
if (process.argv.length === 3 && process.argv[2] === "--help") {
  console.log(
    "Usage: node build-native.mjs <source-archive> <new-work-dir> <go-binary> <private-gopath> <private-gocache>",
  );
  process.exit(0);
}
if (process.argv.length !== 7) throw new Error("invalid arguments");
const [archive, work, go, gopath, gocache] = process.argv.slice(2);
function existing(value, directory) {
  if (
    !path.isAbsolute(value) ||
    path.resolve(value) !== value ||
    realpathSync(value) !== value
  )
    throw new Error("noncanonical input");
  const info = lstatSync(value);
  if (
    info.isSymbolicLink() ||
    (directory ? !info.isDirectory() : !info.isFile())
  )
    throw new Error("invalid input");
}
existing(archive, false);
existing(go, false);
existing(gopath, true);
existing(gocache, true);
existing(path.dirname(work), true);
if (!path.isAbsolute(work) || path.resolve(work) !== work)
  throw new Error("invalid work directory");
if (
  hashFile(archive) !== manifest.source_archive_sha256 ||
  hash(baselineBytes) !== manifest.source_manifest_sha256 ||
  hashFile(patch) !== manifest.patch_sha256
)
  throw new Error("source identity mismatch");
const env = {
  PATH: "/usr/bin:/bin",
  LANG: "C",
  GOTOOLCHAIN: "local",
  GOWORK: "off",
  GOENV: "off",
  GOTELEMETRY: "off",
  GOPROXY: "off",
  GOSUMDB: "off",
  GOMAXPROCS: "2",
  GOPATH: gopath,
  GOMODCACHE: path.join(gopath, "pkg/mod"),
  GOCACHE: gocache,
};
function run(executable, args, cwd) {
  const result = spawnSync(executable, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `command failed: ${path.basename(executable)} (${result.status})`,
    );
  return result.stdout;
}
const version = run(go, ["version"], path.dirname(work));
if (!version.startsWith(`go version ${manifest.go_version} `))
  throw new Error("toolchain mismatch");
mkdirSync(work, { mode: 0o700 });
const temporary = path.join(work, "tmp");
mkdirSync(temporary, { mode: 0o700 });
env.TMPDIR = temporary;
run("/usr/bin/tar", ["-xzf", archive, "-C", work], work);
const source = path.join(work, `cli-${manifest.upstream_revision}`);
existing(source, true);
const expected = new Map(
  Object.entries(JSON.parse(baselineBytes).files).map(([name, info]) => [
    name,
    info.sha256,
  ]),
);
function verifyTree(expectedFiles) {
  const actual = new Map();
  function visit(dir, prefix = "") {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(dir, entry.name);
      const info = lstatSync(absolute);
      if (info.isSymbolicLink()) throw new Error("source symlink rejected");
      if (info.isDirectory()) visit(absolute, relative);
      else if (info.isFile()) actual.set(relative, hashFile(absolute));
      else throw new Error("invalid source entry");
    }
  }
  visit(source);
  if (actual.size !== expectedFiles.size)
    throw new Error("source file count mismatch");
  for (const [name, digest] of expectedFiles)
    if (actual.get(name) !== digest) throw new Error("source file mismatch");
}
verifyTree(expected);
run("/usr/bin/patch", ["-p1", "-i", patch], source);
for (const item of manifest.changed_sources) {
  if (expected.get(item.path) !== (item.before ?? undefined))
    throw new Error("patch baseline mismatch");
  if (item.after === null) expected.delete(item.path);
  else expected.set(item.path, item.after);
}
verifyTree(expected);
const binary = path.join(work, "registration-native");
run(
  go,
  [
    "build",
    "-trimpath",
    "-p",
    "2",
    "-mod=readonly",
    "-o",
    binary,
    "./cmd/registration-native",
  ],
  source,
);
const result = {
  source_revision: manifest.upstream_revision,
  source_archive_sha256: manifest.source_archive_sha256,
  patch_sha256: manifest.patch_sha256,
  go_version: version.trim(),
  binary_sha256: hashFile(binary),
  binary_size: lstatSync(binary).size,
  build_flags: ["-trimpath", "-p", "2", "-mod=readonly"],
  network: "disabled",
  release_approved: false,
};
writeFileSync(
  path.join(work, "build-result.json"),
  JSON.stringify(result, null, 2) + "\n",
  { flag: "wx", mode: 0o600 },
);
console.log(JSON.stringify(result));
