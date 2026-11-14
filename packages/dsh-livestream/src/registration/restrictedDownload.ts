import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_MS = 15_000;
const PRIVATE_V4: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 8],
  [0x0a000000, 8],
  [0x64400000, 10],
  [0x7f000000, 8],
  [0xa9fe0000, 16],
  [0xac100000, 12],
  [0xc0000000, 24],
  [0xc0000200, 24],
  [0xc0586300, 24],
  [0xc0a80000, 16],
  [0xc6120000, 15],
  [0xc6336400, 24],
  [0xcb007100, 24],
  [0xe0000000, 4],
  [0xf0000000, 4],
];
export function isPublicIPv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const octets = address.split(".").map(Number);
  const value =
    (octets[0] * 0x1000000 +
      (octets[1] << 16) +
      (octets[2] << 8) +
      octets[3]) >>>
    0;
  return !PRIVATE_V4.some(([network, bits]) => {
    const mask = (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) >>> 0 === (network & mask) >>> 0;
  });
}
export function validateDownloadUrl(
  raw: string,
  trustedHosts: readonly string[],
): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("photo_restricted");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    isIP(url.hostname) ||
    !trustedHosts.includes(url.hostname) ||
    !url.hostname.includes(".")
  )
    throw new Error("photo_restricted");
  return url;
}

async function fetchPinnedPhoto(
  url: URL,
  selected: string,
  signal: AbortSignal,
): Promise<{ bytes: Buffer; mediaType: "image/png" | "image/jpeg" }> {
  return await new Promise((resolve, reject) => {
    const req = request(url, {
      method: "GET",
      agent: false,
      servername: url.hostname,
      signal,
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [{ address: selected, family: 4 }]);
        else callback(null, selected, 4);
      },
      headers: {
        accept: "image/png, image/jpeg",
        "accept-encoding": "identity",
      },
    });
    req.on("error", () => reject(new Error("photo_restricted")));
    req.on("response", (response) => {
      const address = response.socket.remoteAddress;
      const mime = response.headers["content-type"]
        ?.split(";")[0]
        .trim()
        .toLowerCase();
      const encoding = response.headers["content-encoding"];
      const rawLength = response.headers["content-length"];
      const length = rawLength === undefined ? null : Number(rawLength);
      if (
        address !== selected ||
        response.statusCode !== 200 ||
        (mime !== "image/png" && mime !== "image/jpeg") ||
        (encoding !== undefined && encoding !== "identity") ||
        (rawLength !== undefined &&
          (!/^\d+$/.test(rawLength) ||
            !Number.isSafeInteger(length) ||
            length! > MAX_BYTES))
      ) {
        response.destroy();
        reject(new Error("photo_restricted"));
        return;
      }
      const parts: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BYTES) {
          response.destroy(new Error("photo_restricted"));
          return;
        }
        parts.push(chunk);
      });
      response.on("error", () => reject(new Error("photo_restricted")));
      response.on("aborted", () => reject(new Error("photo_restricted")));
      response.on("close", () => {
        if (!response.complete) reject(new Error("photo_restricted"));
      });
      response.on("end", () => {
        if (size === 0 || (length !== null && size !== length)) {
          reject(new Error("photo_restricted"));
          return;
        }
        resolve({ bytes: Buffer.concat(parts, size), mediaType: mime });
      });
    });
    req.end();
  });
}

/** Only call with a URL obtained for the exact authorized attachment and a host-owned fixed allowlist. */
export async function downloadAuthorizedPhoto(
  raw: string,
  trustedHosts: readonly string[],
  signal: AbortSignal,
): Promise<{ bytes: Buffer; mediaType: "image/png" | "image/jpeg" }> {
  const url = validateDownloadUrl(raw, trustedHosts);
  if (signal.aborted) throw new Error("photo_restricted");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new AbortController();
  const onAbort = () => deadline.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  timer = setTimeout(() => deadline.abort(), MAX_MS);
  try {
    const resolved = await Promise.race([
      lookup(url.hostname, { all: true, family: 4, verbatim: true }),
      new Promise<never>((_, reject) =>
        deadline.signal.addEventListener(
          "abort",
          () => reject(new Error("photo_restricted")),
          { once: true },
        ),
      ),
    ]);
    if (
      resolved.length === 0 ||
      resolved.some((entry) => !isPublicIPv4(entry.address))
    )
      throw new Error("photo_restricted");
    const selected = resolved[0].address;
    if (deadline.signal.aborted) throw new Error("photo_restricted");
    return await fetchPinnedPhoto(url, selected, deadline.signal);
  } catch {
    throw new Error("photo_restricted");
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}
