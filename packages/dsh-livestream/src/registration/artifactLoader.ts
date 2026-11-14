import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseStrictJson } from "./strictJson";

import type { LoadedCore } from "./artifactContract";
type ArtifactCore = LoadedCore;
interface ManifestFile {
  path: string;
  size: number;
  sha256: string;
}
let loaded: { key: string; value: Promise<ArtifactCore> } | undefined;
function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
async function enumerate(root: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(path.join(root, prefix), {
    withFileTypes: true,
  })) {
    const relative = path.join(prefix, entry.name);
    const absolute = path.join(root, relative);
    const stat = await lstat(absolute);
    if (
      stat.isSymbolicLink() ||
      (stat.mode & 0o222) !== 0 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    )
      throw new Error("artifact_unavailable");
    if (stat.isDirectory()) files.push(...(await enumerate(root, relative)));
    else if (stat.isFile()) files.push(relative);
    else throw new Error("artifact_unavailable");
  }
  return files.sort();
}
async function load(
  directory: string,
  expectedManifestSha256: string,
): Promise<ArtifactCore> {
  if (
    !path.isAbsolute(directory) ||
    path.resolve(directory) !== directory ||
    (await realpath(directory)) !== directory ||
    !/^[a-f0-9]{64}$/.test(expectedManifestSha256)
  )
    throw new Error("artifact_unavailable");
  const root = await lstat(directory);
  if (
    !root.isDirectory() ||
    root.isSymbolicLink() ||
    (root.mode & 0o077) !== 0 ||
    (root.mode & 0o222) !== 0 ||
    typeof process.getuid !== "function" ||
    root.uid !== process.getuid()
  )
    throw new Error("artifact_unavailable");
  const manifestPath = path.join(directory, "manifest.json");
  const manifestStat = await lstat(manifestPath);
  if (
    !manifestStat.isFile() ||
    manifestStat.isSymbolicLink() ||
    manifestStat.size > 1024 * 1024 ||
    (manifestStat.mode & 0o222) !== 0 ||
    manifestStat.uid !== process.getuid()
  )
    throw new Error("artifact_unavailable");
  const manifestBytes = await readFile(manifestPath);
  if (hash(manifestBytes) !== expectedManifestSha256)
    throw new Error("artifact_unavailable");
  const manifest = parseStrictJson(manifestBytes) as {
    version?: unknown;
    target?: {
      platform?: unknown;
      arch?: unknown;
      node?: unknown;
      napi?: unknown;
    };
    files?: unknown;
  };
  if (
    manifest?.version !== "visitor-registration-profile/1" ||
    manifest.target?.platform !== process.platform ||
    manifest.target?.arch !== process.arch ||
    manifest.target?.node !== process.version ||
    manifest.target?.napi !== process.versions.napi ||
    !Array.isArray(manifest.files) ||
    manifest.files.length > 1000
  )
    throw new Error("artifact_unavailable");
  const expected = new Map<string, ManifestFile>();
  for (const raw of manifest.files) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("artifact_unavailable");
    const file = raw as ManifestFile;
    if (
      typeof file.path !== "string" ||
      path.isAbsolute(file.path) ||
      path.normalize(file.path) !== file.path ||
      file.path.split(path.sep).some((part) => part === ".." || part === ".") ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      expected.has(file.path) ||
      file.path === "manifest.json"
    )
      throw new Error("artifact_unavailable");
    expected.set(file.path, file);
  }
  const actual = await enumerate(directory);
  if (actual.length !== expected.size + 1 || !actual.includes("manifest.json"))
    throw new Error("artifact_unavailable");
  for (const file of actual) {
    if (file === "manifest.json") continue;
    const item = expected.get(file);
    if (!item) throw new Error("artifact_unavailable");
    const filePath = path.join(directory, file);
    const stat = await lstat(filePath);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size !== item.size ||
      stat.size > 32 * 1024 * 1024
    )
      throw new Error("artifact_unavailable");
    const bytes = await readFile(filePath);
    if (bytes.length !== item.size || hash(bytes) !== item.sha256)
      throw new Error("artifact_unavailable");
  }
  if (!expected.has("core.mjs")) throw new Error("artifact_unavailable");
  const module: unknown = await import(
    pathToFileURL(path.join(directory, "core.mjs")).href
  );
  if (!module || typeof module !== "object")
    throw new Error("artifact_unavailable");
  const core = module as ArtifactCore;
  if (
    core.CONTRACT_VERSION !== manifest.version ||
    typeof core.sharedCoreIdentity !== "object" ||
    core.sharedCoreIdentity === null ||
    typeof core.parseRegistrationConfig !== "function" ||
    typeof core.validatePatch !== "function" ||
    typeof core.projectRecord !== "function" ||
    typeof core.createRobotPrivateHost !== "function" ||
    typeof core.mountRobotPrivateHost !== "function" ||
    typeof core.verifyPhotoBytes !== "function"
  )
    throw new Error("artifact_unavailable");
  if (
    hash(await readFile(path.join(directory, "manifest.json"))) !==
    expectedManifestSha256
  )
    throw new Error("artifact_unavailable");
  return core;
}
/** The path and hash must come from immutable trusted host deployment policy. */
export function loadSharedArtifact(
  directory: string,
  expectedManifestSha256: string,
): Promise<ArtifactCore> {
  const key = `${directory}\0${expectedManifestSha256}`;
  if (loaded && loaded.key !== key)
    return Promise.reject(new Error("artifact_unavailable"));
  if (!loaded) {
    const entry = { key, value: load(directory, expectedManifestSha256) };
    loaded = entry;
    void entry.value.catch(() => {
      if (loaded === entry) loaded = undefined;
    });
  }
  return loaded.value;
}
