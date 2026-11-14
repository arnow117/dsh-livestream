import React, { useEffect, useRef, useState } from "react";
import type { ReadSettings } from "../registration/readSettings";

type Consumer = "live" | "robot";
type PrivateResult = {
  observedAt: string;
  fields: {
    displayName: string;
    contactText: string;
    productInterest: string | null;
    photo: { state: string; reason?: string };
  };
  metadata: { revision: string; consent: string; collection: string };
  readiness: { state: string; reasons?: string[] };
  submission: string;
};
type SavedResponse = {
  ok: true;
  saved: ReadSettings | null;
  authorized?: boolean;
};
const empty: ReadSettings = {
  workspaceId: "",
  profile: "",
  appId: "",
  userOpenId: "",
  artifactDirectory: "",
  baseId: "",
  tableId: "",
  recordId: "",
  mappingId: "",
  mappingRevision: 1,
  displayNameField: "",
  contactField: "",
  interestField: "",
  photoField: "",
  revisionField: null,
  consentField: null,
  sourceField: null,
  collectedAtField: null,
};
const inputs: Array<{
  key: keyof ReadSettings;
  label: string;
  optional?: boolean;
}> = [
  { key: "workspaceId", label: "工作区标识" },
  { key: "profile", label: "身份配置名称" },
  { key: "appId", label: "应用标识" },
  { key: "userOpenId", label: "用户标识" },
  { key: "artifactDirectory", label: "共享组件目录" },
  { key: "baseId", label: "Base 标识" },
  { key: "tableId", label: "数据表标识" },
  { key: "recordId", label: "确切记录标识" },
  { key: "mappingId", label: "映射标识" },
  { key: "mappingRevision", label: "映射版本" },
  { key: "displayNameField", label: "用户名字段 ID" },
  { key: "contactField", label: "联系方式字段 ID" },
  { key: "interestField", label: "意向商品字段 ID" },
  { key: "photoField", label: "照片字段 ID" },
  { key: "revisionField", label: "资料版本字段 ID", optional: true },
  { key: "consentField", label: "用途依据字段 ID", optional: true },
  { key: "sourceField", label: "来源字段 ID", optional: true },
  { key: "collectedAtField", label: "收集时间字段 ID", optional: true },
];
async function request<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(
    `/api/dsh-livestream/registration/${path}`,
    body === undefined
      ? { cache: "no-store", signal }
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          keepalive: path === "revoke",
          signal,
        },
  );
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok)
    throw new Error(
      typeof result.error === "string" ? result.error : "操作失败，请重试",
    );
  return result as T;
}
function photoText(photo: PrivateResult["fields"]["photo"]): string {
  if (photo.state === "absent") return "无照片";
  if (photo.state === "reference_only") return "有照片引用，未核验内容";
  if (photo.state === "invalid") return "照片状态无效，需要核对";
  if (photo.state === "unknown") return "照片状态未知";
  return "照片状态待核对";
}

function metadataText(state: string): string {
  const labels: Record<string, string> = {
    verified: "已核对",
    missing: "缺失",
    invalid: "无效",
    reference_only: "仅有引用",
    unverified: "未核实",
  };
  return labels[state] ?? "未知";
}
function pendingReason(reason: string): string {
  const labels: Record<string, string> = {
    profile_revision_missing: "缺少资料版本",
    profile_revision_invalid: "资料版本无效",
    consent_unverified: "用途依据尚未核实",
    collection_unverified: "收集来源或时间尚未核实",
    photo_unverified: "照片内容或用途尚未核实",
    photo_metadata_conflict: "照片元数据需要核对",
  };
  return labels[reason] ?? "其他事实尚未核实";
}

export function RegistrationSettingsPanel() {
  const [draft, setDraft] = useState<ReadSettings>(empty);
  const [saved, setSaved] = useState<ReadSettings | null>(null);
  const [authorized, setAuthorized] = useState(false);
  const [busy, setBusy] = useState<string | null>("加载配置");
  const [error, setError] = useState("");
  const [results, setResults] = useState<
    Partial<Record<Consumer, PrivateResult>>
  >({});
  const [states, setStates] = useState<Partial<Record<Consumer, string>>>({});
  const epoch = useRef(0);
  const current = useRef<AbortController | null>(null);
  const locked = useRef(false);
  const isAuthorized = useRef(false);
  const revokePending = useRef<Promise<unknown>>(Promise.resolve());
  const mounted = useRef(true);
  const savedRef = useRef<ReadSettings | null>(null);
  const channel = useRef<BroadcastChannel | null>(null);
  const watching = useRef(false);
  function clearPrivate(revoke: boolean) {
    epoch.current++;
    current.current?.abort();
    current.current = null;
    locked.current = false;
    if (mounted.current) setBusy(null);
    setResults({});
    setStates({});
    setAuthorized(false);
    if (revoke && isAuthorized.current)
      revokePending.current = request("revoke", {}).catch(() => undefined);
    isAuthorized.current = false;
  }
  useEffect(() => {
    mounted.current = true;
    if (typeof BroadcastChannel !== "undefined") {
      channel.current = new BroadcastChannel("dsh-registration-private-read");
      channel.current.onmessage = () => {
        if (mounted.current) {
          clearPrivate(false);
          setError("配置或授权已变化，请重新核对");
        }
      };
    }
    const controller = new AbortController();
    current.current = controller;
    void request<SavedResponse>("settings", undefined, controller.signal)
      .then((result) => {
        if (!mounted.current) return;
        savedRef.current = result.saved;
        setSaved(result.saved);
        if (result.saved) setDraft(result.saved);
      })
      .catch(() => {
        if (mounted.current && !controller.signal.aborted)
          setError("无法读取资料配置");
      })
      .finally(() => {
        if (mounted.current) setBusy(null);
      });
    const timer = window.setInterval(() => {
      if (!isAuthorized.current || watching.current) return;
      watching.current = true;
      void request<SavedResponse>(
        "settings",
        undefined,
        AbortSignal.timeout(3000),
      )
        .then((result) => {
          if (
            mounted.current &&
            isAuthorized.current &&
            (!result.authorized ||
              JSON.stringify(result.saved) !== JSON.stringify(savedRef.current))
          ) {
            clearPrivate(false);
            setError("配置、身份或授权已变化，请重新核对");
          }
        })
        .catch(() => {
          if (mounted.current && isAuthorized.current) {
            clearPrivate(false);
            setError("身份或授权不可用，请重新授权");
          }
        })
        .finally(() => {
          watching.current = false;
        });
    }, 1000);
    const clearOnHide = () => {
      if (document.visibilityState !== "visible" && isAuthorized.current)
        clearPrivate(true);
    };
    document.addEventListener("visibilitychange", clearOnHide);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", clearOnHide);
      channel.current?.close();
      channel.current = null;
      mounted.current = false;
      epoch.current++;
      controller.abort();
      current.current?.abort();
      if (isAuthorized.current)
        void request("revoke", {}).catch(() => undefined);
    };
  }, []);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  function change(key: keyof ReadSettings, value: string, optional = false) {
    clearPrivate(true);
    setError("");
    setDraft((previous) => ({
      ...previous,
      [key]:
        key === "mappingRevision"
          ? Number(value)
          : optional && !value
            ? null
            : value,
    }));
  }
  async function run(
    label: string,
    action: (signal: AbortSignal, ticket: number) => Promise<void>,
  ) {
    if (locked.current) return;
    locked.current = true;
    setBusy(label);
    setError("");
    const ticket = epoch.current,
      controller = new AbortController();
    current.current = controller;
    try {
      await revokePending.current;
      if (ticket === epoch.current) await action(controller.signal, ticket);
    } catch (cause) {
      if (
        mounted.current &&
        ticket === epoch.current &&
        !controller.signal.aborted
      )
        setError(cause instanceof Error ? cause.message : "操作失败");
    } finally {
      if (current.current === controller) {
        current.current = null;
        locked.current = false;
        if (mounted.current && ticket === epoch.current) setBusy(null);
      }
    }
  }
  function save() {
    clearPrivate(true);
    void run("保存配置", async (signal, ticket) => {
      const result = await request<SavedResponse>("settings", draft, signal);
      if (ticket !== epoch.current) return;
      savedRef.current = result.saved;
      setSaved(result.saved);
      if (result.saved) setDraft(result.saved);
      channel.current?.postMessage("changed");
    });
  }
  function authorize() {
    clearPrivate(true);
    void run("授权记录", async (signal, ticket) => {
      await request("authorize", {}, signal);
      if (ticket !== epoch.current) return;
      isAuthorized.current = true;
      setAuthorized(true);
    });
  }
  function read(consumer: Consumer) {
    void run(
      consumer === "live" ? "Live 读取" : "Robot 读取",
      async (signal, ticket) => {
        setStates((previous) => ({ ...previous, [consumer]: "读取中" }));
        try {
          const response = await request<{ result: PrivateResult }>(
            consumer === "live" ? "live/read" : "robot/consume",
            {},
            signal,
          );
          if (ticket !== epoch.current) return;
          setResults((previous) => ({
            ...previous,
            [consumer]: response.result,
          }));
          setStates((previous) => ({
            ...previous,
            [consumer]: "本次读取完成",
          }));
        } catch (cause) {
          if (ticket === epoch.current && !signal.aborted) {
            setResults((previous) => {
              const next = { ...previous };
              delete next[consumer];
              return next;
            });
            setStates((previous) => ({
              ...previous,
              [consumer]: "读取失败或结果未知",
            }));
          }
          throw cause;
        }
      },
    );
  }
  return (
    <section
      className="dl-field dl-registration"
      aria-labelledby="registration-read-title"
    >
      <h3 id="registration-read-title">登记资料私有读取</h3>
      <p className="dl-hint">
        配置只保存引用，不登录或读取资料。先明确授权一条记录，再分别读取；照片内容不在这里下载。
      </p>
      {inputs.map(({ key, label, optional }) => (
        <label key={key}>
          {label}
          {optional ? "（可留空）" : ""}
          <input
            value={draft[key] ?? ""}
            type={key === "mappingRevision" ? "number" : "text"}
            min={key === "mappingRevision" ? 1 : undefined}
            autoComplete="off"
            disabled={busy !== null}
            onChange={(event) => change(key, event.target.value, optional)}
          />
        </label>
      ))}
      <p role="status">
        {busy
          ? `正在${busy}`
          : !saved
            ? "尚未配置"
            : dirty
              ? "有未保存的配置"
              : `已保存记录：${saved.recordId}`}
      </p>
      {error && <p role="alert">{error}</p>}
      <div className="dl-row">
        <button type="button" disabled={busy !== null || !dirty} onClick={save}>
          保存配置
        </button>
        <button
          type="button"
          disabled={busy !== null || !saved || dirty}
          onClick={authorize}
        >
          授权当前记录
        </button>
        <button
          type="button"
          disabled={!authorized}
          onClick={() => {
            clearPrivate(true);
            channel.current?.postMessage("changed");
            setError("");
          }}
        >
          撤销授权并清除
        </button>
      </div>
      <p role="status">
        {authorized ? "当前记录已授权，仅本次私有读取可用" : "尚未授权读取"}
      </p>
      {(["live", "robot"] as const).map((consumer) => {
        const result = results[consumer];
        return (
          <section
            key={consumer}
            aria-label={`${consumer === "live" ? "Live" : "Robot"} 私有读取`}
          >
            <h4>{consumer === "live" ? "Live" : "Robot"} 私有读取</h4>
            <button
              type="button"
              disabled={busy !== null || !authorized || dirty}
              onClick={() => read(consumer)}
            >
              读取
            </button>
            <p role="status">{states[consumer] ?? "尚未读取"}</p>
            {result && (
              <div>
                <p>读取时间：{result.observedAt}</p>
                <p>用户名：{result.fields.displayName}</p>
                <p>联系方式：{result.fields.contactText}</p>
                <p>意向商品：{result.fields.productInterest ?? "未填写"}</p>
                <p>照片：{photoText(result.fields.photo)}</p>
                <p>
                  资料状态：
                  {result.readiness.state === "ready_no_photo"
                    ? "已核无照片"
                    : result.readiness.state === "ready_verified_photo"
                      ? "照片已核验"
                      : "记录已读取，元数据待核对"}
                </p>
                {result.readiness.state === "pending" &&
                  !!result.readiness.reasons?.length && (
                    <ul aria-label="待核实事项">
                      {result.readiness.reasons.map((reason) => (
                        <li key={reason}>{pendingReason(reason)}</li>
                      ))}
                    </ul>
                  )}
                <p>
                  版本：{metadataText(result.metadata.revision)}；用途依据：
                  {metadataText(result.metadata.consent)}；来源：
                  {metadataText(result.metadata.collection)}
                </p>
                <p>
                  原提交关联：
                  {result.submission === "verified" ? "已核对" : "未核对"}
                </p>
              </div>
            )}
          </section>
        );
      })}
    </section>
  );
}
