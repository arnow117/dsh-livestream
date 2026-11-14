import { createHash } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REGISTRATION_NATIVE_SHA256 } from "./nativeCli/nativeIdentity";

/** The artifact is fixed beside this module; request data cannot select executable or digest. */
export function verifiedNativeExecutable(): string {
  const binary = fileURLToPath(
    new URL("./nativeCli/registration-native", import.meta.url),
  );
  if (!/^[a-f0-9]{64}$/.test(REGISTRATION_NATIVE_SHA256))
    throw new Error("executor_unavailable");
  const parent = path.dirname(binary);
  const parentInfo = lstatSync(parent);
  if (
    realpathSync(parent) !== parent ||
    !parentInfo.isDirectory() ||
    parentInfo.isSymbolicLink() ||
    (parentInfo.mode & 0o222) !== 0 ||
    typeof process.getuid !== "function" ||
    parentInfo.uid !== process.getuid()
  )
    throw new Error("executor_unavailable");
  const fd = openSync(binary, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (
      !info.isFile() ||
      info.uid !== process.getuid() ||
      info.nlink !== 1 ||
      (info.mode & 0o222) !== 0 ||
      (info.mode & 0o111) === 0 ||
      info.size > 128 * 1024 * 1024 ||
      realpathSync(binary) !== binary
    )
      throw new Error("executor_unavailable");
    const hash = createHash("sha256").update(readFileSync(fd)).digest("hex");
    const after = fstatSync(fd);
    if (
      hash !== REGISTRATION_NATIVE_SHA256 ||
      info.dev !== after.dev ||
      info.ino !== after.ino ||
      info.size !== after.size ||
      info.mtimeMs !== after.mtimeMs
    )
      throw new Error("executor_unavailable");
    return binary;
  } finally {
    closeSync(fd);
  }
}
