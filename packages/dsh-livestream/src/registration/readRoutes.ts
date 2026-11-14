import type { createReadService } from "./readService";
import { parseStrictJson } from "./strictJson";
type Service = ReturnType<typeof createReadService>;
type Route = (
  path: string,
  methods: string[],
  handler: (request: Request) => Response | Promise<Response>,
  label: string,
) => unknown;

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
function failure(error: unknown) {
  const reason = error instanceof Error ? error.message : "";
  const messages: Record<string, string> = {
    forbidden: "没有配置资料读取的权限",
    revoked: "授权已失效，请重新授权",
    not_authorized: "请先授权当前记录",
    invalid_settings: "配置不完整或格式无效",
    workspace_unavailable: "工作区不可用，请检查配置",
    configuration_unavailable: "所选身份配置不可用",
    artifact_unavailable: "共享资料组件不可用",
    executor_unavailable: "读取执行器不可用",
    field_permission: "字段权限不足",
    not_found: "记录不存在或已移除",
    record_changed: "记录或映射已变化，请重新核对",
    metadata_conflict: "记录元数据发生冲突",
    required_field_missing: "所需字段缺失",
    unsupported_field_shape: "字段内容格式不受支持",
  };
  const code = Object.hasOwn(messages, reason) ? reason : "unknown";
  return json(
    { ok: false, code, error: messages[code] ?? "读取失败或结果未知" },
    code === "forbidden" ? 403 : 409,
  );
}
async function readControlBody<T>(request: Request): Promise<T | null> {
  if (!request.body) return {} as T;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 64 * 1024) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks);
    const empty = bytes.every(
      (byte) =>
        byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d,
    );
    const parsed: unknown = empty ? {} : parseStrictJson(bytes);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as T)
      : null;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}
async function requireEmptyBody(request: Request) {
  const body = await readControlBody<Record<string, unknown>>(request);
  if (!body || Object.keys(body).length !== 0)
    throw new Error("invalid_settings");
}
/** Install the same exact owner-only Fetch routes used by the host. */
export function registerReadRoutes(route: Route, service: Service) {
  route(
    "/api/dsh-livestream/registration/settings",
    ["GET", "POST"],
    async (request) => {
      try {
        if (request.method === "GET")
          return json({ ok: true, ...service.status(request) });
        const input = await readControlBody<unknown>(request);
        if (!input) throw new Error("invalid_settings");
        return json({ ok: true, saved: service.save(request, input) });
      } catch (error) {
        return failure(error);
      }
    },
    "registration settings",
  );
  route(
    "/api/dsh-livestream/registration/authorize",
    ["POST"],
    async (request) => {
      try {
        await requireEmptyBody(request);
        return json({ ok: true, ...(await service.authorize(request)) });
      } catch (error) {
        return failure(error);
      }
    },
    "registration authorize",
  );
  route(
    "/api/dsh-livestream/registration/live/read",
    ["POST"],
    async (request) => {
      try {
        await requireEmptyBody(request);
        return json({ ok: true, result: await service.read(request, "live") });
      } catch (error) {
        return failure(error);
      }
    },
    "registration live read",
  );
  route(
    "/api/dsh-livestream/registration/robot/consume",
    ["POST"],
    async (request) => {
      try {
        await requireEmptyBody(request);
        return json({ ok: true, result: await service.read(request, "robot") });
      } catch (error) {
        return failure(error);
      }
    },
    "registration robot consume",
  );
  route(
    "/api/dsh-livestream/registration/revoke",
    ["POST"],
    async (request) => {
      try {
        await requireEmptyBody(request);
        service.revoke(request);
        return json({ ok: true });
      } catch (error) {
        return failure(error);
      }
    },
    "registration revoke",
  );
}
