import {
  constants,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  lstatSync,
  readSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { RegistrationAuthority, type Peer } from "./authority";
import { loadSharedArtifact } from "./artifactLoader";
import { buildConfigSnapshot } from "./configSnapshot";
import { mountRegistrationPrivateApplication } from "./privateApplication";
import { parseReadSettings, type ReadSettings } from "./readSettings";

const ARTIFACT_HASH =
  "cff638ff461fab35b082e93d62c28c768472688d03888b69864700f89abb8fcb";
type Connection = {
  admit(request: Request): { peer: Peer } | { rejection: number };
};
type Workspace = { path: string };
type Host = { connection: Connection; get?(name: string): any; plugin: any };
type Mounted = Awaited<ReturnType<typeof mountRegistrationPrivateApplication>>;
type Slot = {
  generation: number;
  peer: Peer;
  live: object;
  robot: object;
  mounted: Mounted;
  detach: () => void;
};

/** Read the fixed local native configuration only after explicit owner authorization. */
function nativeConfigSnapshot(config: ReadSettings): Uint8Array {
  const file = path.join(homedir(), ".lark-cli", "config.json");
  let fd: number | undefined;
  let bytes: Buffer | undefined;
  try {
    if (realpathSync(file) !== file)
      throw new Error("configuration_unavailable");
    const pathBefore = lstatSync(file);
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.uid !== process.getuid?.() ||
      (before.mode & 0o022) !== 0 ||
      before.size > 1024 * 1024 ||
      pathBefore.dev !== before.dev ||
      pathBefore.ino !== before.ino
    )
      throw new Error("configuration_unavailable");
    bytes = Buffer.alloc(before.size + 1);
    const length = readSync(fd, bytes, 0, bytes.length, 0);
    const after = fstatSync(fd);
    const pathAfter = lstatSync(file);
    if (
      length !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      pathAfter.dev !== before.dev ||
      pathAfter.ino !== before.ino
    )
      throw new Error("configuration_unavailable");
    return buildConfigSnapshot(bytes.subarray(0, length), {
      profile: config.profile,
      expectedAppId: config.appId,
      expectedUserOpenId: config.userOpenId,
    });
  } catch {
    throw new Error("configuration_unavailable");
  } finally {
    bytes?.fill(0);
    if (fd !== undefined) closeSync(fd);
  }
}
function workspaceIdentity(directory: string) {
  const info = lstatSync(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    realpathSync(directory) !== directory
  )
    throw new Error("workspace_unavailable");
  return { dev: info.dev, ino: info.ino };
}

function matchesWorkspace(
  directory: string,
  expected: { dev: number; ino: number },
): boolean {
  try {
    const actual = workspaceIdentity(directory);
    return actual.dev === expected.dev && actual.ino === expected.ino;
  } catch {
    return false;
  }
}

function viewOf(value: unknown) {
  const result = value as {
    requestRef: string;
    observation: {
      fields: {
        displayName: string;
        contactText: string;
        productInterest: string | null;
        photo: { state: string; reason?: string };
      };
      metadata: {
        profileRevision: { state: string };
        consent: { state: string };
        collection: { state: string };
      };
      readiness: { state: string; reasons?: string[] };
      observedAt: string;
      submission: { state: string };
    };
  };
  const observation = result.observation;
  return {
    requestRef: result.requestRef,
    observedAt: observation.observedAt,
    fields: {
      displayName: observation.fields.displayName,
      contactText: observation.fields.contactText,
      productInterest: observation.fields.productInterest,
      photo: {
        state: observation.fields.photo.state,
        ...(observation.fields.photo.reason
          ? { reason: observation.fields.photo.reason }
          : {}),
      },
    },
    metadata: {
      revision: observation.metadata.profileRevision.state,
      consent: observation.metadata.consent.state,
      collection: observation.metadata.collection.state,
    },
    readiness: observation.readiness,
    submission: observation.submission.state,
  };
}

/** Private owner routes share no grant, record values or identifiers with public state. */
export function createReadService(
  ctx: Host,
  options: {
    dataDir: string;
    getSaved(): unknown;
    save(value: ReadSettings): void;
  },
) {
  let generation = 1;
  let closed = false;
  const slots = new Map<Peer, Slot>();
  const pending = new Set<Promise<void>>();
  const active = new Set<Promise<unknown>>();
  const bindings = new WeakMap<
    Peer,
    {
      registry: any;
      workspace: Workspace;
      workspacePath: string;
      workspaceIdentity: { dev: number; ino: number };
      config: ReadSettings;
      generation: number;
      ownerRef: string;
    }
  >();
  const currentConnection = () => {
    const connection = ctx.connection;
    return (Reflect.get(connection, Symbol.for("cordis.original")) ??
      connection) as Connection;
  };
  const authority = new RegistrationAuthority(
    currentConnection,
    () => generation,
    (peer, scope) => {
      const binding = bindings.get(peer);
      if (
        !binding ||
        binding.generation !== generation ||
        ctx.get?.("workspaceRegistry") !== binding.registry ||
        binding.registry.get(binding.config.workspaceId) !==
          binding.workspace ||
        binding.workspace.path !== binding.workspacePath ||
        !matchesWorkspace(binding.workspacePath, binding.workspaceIdentity)
      )
        return false;
      const config = binding.config;
      return (
        scope.ownerRef === binding.ownerRef &&
        scope.workspaceRef === config.workspaceId &&
        scope.appId === config.appId &&
        scope.profileRef === config.profile &&
        scope.baseId === config.baseId &&
        scope.tableId === config.tableId &&
        scope.recordId === config.recordId &&
        scope.mappingId === config.mappingId &&
        scope.mappingRevision === config.mappingRevision &&
        scope.purpose === "reception"
      );
    },
  );
  function scheduleDispose(mounted: Mounted) {
    const operation = mounted.dispose().catch(() => undefined);
    pending.add(operation);
    void operation.finally(() => pending.delete(operation));
  }
  function owner(request: Request): Peer {
    if (closed) throw new Error("revoked");
    const result = currentConnection().admit(request);
    if (
      "rejection" in result ||
      result.peer.principal.kind !== "owner" ||
      result.peer.signal.aborted ||
      request.signal.aborted
    )
      throw new Error("forbidden");
    return result.peer;
  }
  function clear(): void {
    generation++;
    authority.invalidateAll();
    for (const slot of slots.values()) {
      slot.detach();
      scheduleDispose(slot.mounted);
    }
    slots.clear();
  }
  function getSettings(request: Request) {
    owner(request);
    const saved = options.getSaved();
    return saved == null ? null : parseReadSettings(saved);
  }
  function status(request: Request) {
    const peer = owner(request);
    const slot = slots.get(peer);
    const binding = bindings.get(peer);
    const valid =
      !!slot &&
      !!binding &&
      slot.generation === generation &&
      binding.generation === generation &&
      ctx.get?.("workspaceRegistry") === binding.registry &&
      binding.registry.get(binding.config.workspaceId) === binding.workspace &&
      binding.workspace.path === binding.workspacePath &&
      matchesWorkspace(binding.workspacePath, binding.workspaceIdentity);
    if (slot && !valid) {
      slots.delete(peer);
      bindings.delete(peer);
      slot.detach();
      scheduleDispose(slot.mounted);
    }
    return { saved: getSettings(request), authorized: valid };
  }
  function save(request: Request, raw: unknown) {
    owner(request);
    const config = parseReadSettings(raw);
    options.save(config);
    clear();
    return config;
  }
  async function authorizeInternal(request: Request) {
    const peer = owner(request);
    const config = parseReadSettings(options.getSaved());
    const registry = ctx.get?.("workspaceRegistry");
    const workspace: Workspace | undefined = registry?.get?.(
      config.workspaceId,
    );
    if (
      !workspace ||
      typeof workspace.path !== "string" ||
      !path.isAbsolute(workspace.path)
    )
      throw new Error("workspace_unavailable");
    const startGeneration = generation;
    const workspacePath = workspace.path;
    const identity = workspaceIdentity(workspacePath);
    const ownerRef = (peer as Peer & { id?: unknown }).id;
    if (typeof ownerRef !== "string" || !ownerRef.trim())
      throw new Error("forbidden");
    const current = () => {
      if (
        owner(request) !== peer ||
        generation !== startGeneration ||
        ctx.get?.("workspaceRegistry") !== registry ||
        registry.get(config.workspaceId) !== workspace ||
        workspace.path !== workspacePath ||
        !matchesWorkspace(workspacePath, identity)
      )
        throw new Error("revoked");
    };
    current();
    const core = await loadSharedArtifact(
      config.artifactDirectory,
      ARTIFACT_HASH,
    );
    current();
    const configBytes = nativeConfigSnapshot(config);
    const profileConfig = core.parseRegistrationConfig({
      schemaVersion: "visitor-registration-profile/1",
      mapping: {
        mappingId: config.mappingId,
        revision: config.mappingRevision,
      },
      appRef: config.appId,
      profileRef: config.profile,
      baseId: config.baseId,
      visitorsTableId: config.tableId,
      formId: null,
      fields: {
        display_name: config.displayNameField,
        contact_text: config.contactField,
        product_interest: config.interestField,
        photo: config.photoField,
      },
      metadataFields: {
        profile_revision: config.revisionField,
        consent_ref: config.consentField,
        submission_ref: null,
        source_kind: config.sourceField,
        collected_at: config.collectedAtField,
        photo_revision: null,
        photo_sha256: null,
        profile_operation_ref: null,
      },
    });
    const tempRoot = path.join(options.dataDir, "registration-runtime");
    mkdirSync(tempRoot, { mode: 0o700, recursive: true });
    const fieldIds = [
      ...Object.values(profileConfig.fields),
      ...Object.values(profileConfig.metadataFields).filter(
        (field): field is string => field !== null,
      ),
    ];
    const binding = {
      profile: config.profile,
      appRef: config.appId,
      profileRef: config.profile,
      appId: config.appId,
      userOpenId: config.userOpenId,
      baseId: config.baseId,
      tableId: config.tableId,
      fieldIds,
    };
    const mounted = await mountRegistrationPrivateApplication({
      context: ctx,
      core,
      authority,
      binding,
      execution: {
        profileConfig,
        configBytes,
        tempRoot,
        signal: new AbortController().signal,
      },
      now: () => new Date().toISOString(),
    });
    try {
      current();
      bindings.set(peer, {
        registry,
        workspace,
        workspacePath,
        workspaceIdentity: identity,
        config,
        generation: startGeneration,
        ownerRef,
      });
      const scope = {
        ownerRef,
        workspaceRef: config.workspaceId,
        appId: config.appId,
        profileRef: config.profile,
        baseId: config.baseId,
        tableId: config.tableId,
        recordId: config.recordId,
        mappingId: config.mappingId,
        mappingRevision: config.mappingRevision,
        purpose: "reception" as const,
      };
      const live = mounted.issueLive(request, scope);
      const robot = mounted.issueRobot(request, scope);
      const previous = slots.get(peer);
      if (previous) {
        slots.delete(peer);
        previous.detach();
        await previous.mounted.dispose();
      }
      current();
      const abort = () => {
        const slot = slots.get(peer);
        if (slot?.mounted !== mounted) return;
        slots.delete(peer);
        bindings.delete(peer);
        slot.detach();
        scheduleDispose(mounted);
      };
      peer.signal.addEventListener("abort", abort, { once: true });
      slots.set(peer, {
        generation: startGeneration,
        peer,
        live,
        robot,
        mounted,
        detach: () => peer.signal.removeEventListener("abort", abort),
      });
      if (peer.signal.aborted) {
        const slot = slots.get(peer);
        slots.delete(peer);
        slot?.detach();
        throw new Error("revoked");
      }
      return { recordId: config.recordId };
    } catch (error) {
      bindings.delete(peer);
      await mounted.dispose();
      throw error;
    }
  }
  async function readInternal(request: Request, consumer: "live" | "robot") {
    const peer = owner(request);
    const slot = slots.get(peer);
    if (!slot || slot.generation !== generation)
      throw new Error("not_authorized");
    const original = slot.generation;
    const result =
      consumer === "live"
        ? await slot.mounted.liveRead(slot.live, request)
        : await slot.mounted.robotConsume(slot.robot, request);
    if (
      owner(request) !== peer ||
      generation !== original ||
      slots.get(peer) !== slot
    )
      throw new Error("revoked");
    return viewOf(result);
  }
  function track<T>(operation: Promise<T>): Promise<T> {
    active.add(operation);
    void operation.then(
      () => active.delete(operation),
      () => active.delete(operation),
    );
    return operation;
  }
  function authorize(request: Request) {
    return track(authorizeInternal(request));
  }
  function read(request: Request, consumer: "live" | "robot") {
    return track(readInternal(request, consumer));
  }
  function revoke(request: Request) {
    owner(request);
    clear();
  }
  async function dispose() {
    if (!closed) {
      clear();
      closed = true;
    }
    await Promise.allSettled([...active]);
    await Promise.all([...pending]);
  }
  return { getSettings, status, save, authorize, read, revoke, dispose };
}
