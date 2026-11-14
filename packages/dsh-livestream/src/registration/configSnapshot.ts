import { parseStrictJson } from "./strictJson";
import { effectiveStrictMode, requireUserAllowed } from "./strictMode";

interface Selection {
  profile: string;
  expectedAppId: string;
  expectedUserOpenId: string;
}
interface ObjectValue {
  [key: string]: unknown;
}
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("configuration_unavailable");
  return value as ObjectValue;
}
function required(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
      value,
    )
  )
    throw new Error("configuration_unavailable");
  return value;
}
/** Build only the selected app and first native user. Never resolve or export credentials. */
export function buildConfigSnapshot(
  bytes: Uint8Array,
  selection: Selection,
): Uint8Array {
  const profile = required(selection.profile);
  const expectedAppId = required(selection.expectedAppId);
  const expectedUser = required(selection.expectedUserOpenId);
  const source = object(parseStrictJson(bytes));
  if (!Array.isArray(source.apps)) throw new Error("configuration_unavailable");
  const apps = source.apps.map(object);
  const byName = apps.filter((app) => app.name === profile && app.name !== "");
  const byId = apps.filter((app) => app.appId === profile);
  if (byName.length > 1 || (byName.length === 0 && byId.length !== 1))
    throw new Error("configuration_unavailable");
  const app = byName.length === 1 ? byName[0] : byId[0];
  const appId = required(app.appId);
  if (appId !== expectedAppId) throw new Error("configuration_unavailable");
  const secret = object(app.appSecret);
  if (
    Object.keys(secret).some(
      (key) => !["source", "id", "provider"].includes(key),
    ) ||
    secret.source !== "keychain" ||
    secret.id !== `appsecret:${appId}` ||
    (secret.provider !== undefined && typeof secret.provider !== "string")
  )
    throw new Error("configuration_unavailable");
  const brand = required(app.brand);
  if (brand !== "feishu" && brand !== "lark")
    throw new Error("configuration_unavailable");
  if (!Array.isArray(app.users) || app.users.length === 0)
    throw new Error("configuration_unavailable");
  const user = object(app.users[0]);
  const userOpenId = required(user.userOpenId);
  if (
    userOpenId !== expectedUser ||
    (user.userName !== undefined && typeof user.userName !== "string")
  )
    throw new Error("configuration_unavailable");
  const mode = effectiveStrictMode(source.strictMode, app.strictMode);
  requireUserAllowed(mode);
  const dpop = app.dpopMode;
  if (
    dpop !== undefined &&
    !["", "disabled", "preferred", "required"].includes(String(dpop))
  )
    throw new Error("configuration_unavailable");
  if (dpop !== undefined && typeof dpop !== "string")
    throw new Error("configuration_unavailable");
  if (app.name !== undefined && typeof app.name !== "string")
    throw new Error("configuration_unavailable");
  const selectedSecret = {
    source: "keychain",
    id: secret.id,
    ...(secret.provider === undefined ? {} : { provider: secret.provider }),
  };
  const selectedApp = {
    ...(app.name ? { name: app.name } : {}),
    appId,
    appSecret: selectedSecret,
    brand,
    ...(dpop ? { dpopMode: dpop } : {}),
    ...(mode ? { strictMode: mode } : {}),
    users: [
      {
        userOpenId,
        ...(user.userName === undefined ? {} : { userName: user.userName }),
      },
    ],
  };
  return Buffer.from(JSON.stringify({ apps: [selectedApp] }), "utf8");
}
