export interface Peer {
  readonly principal: { readonly kind: string };
  readonly signal: AbortSignal;
}
export interface Connection {
  admit(request: Request): { peer: Peer } | { rejection: number };
}
export interface GrantScope {
  ownerRef: string;
  workspaceRef: string;
  appId: string;
  profileRef: string;
  baseId: string;
  tableId: string;
  recordId: string;
  mappingId: string;
  mappingRevision: number;
  purpose: "reception";
  consumer: "live" | "robot" | "owner";
  audience: "owner_private" | "workspace_private" | "robot_private";
  actions: readonly ("read" | "photo" | "patch")[];
}
interface StoredGrant {
  readonly request: Request;
  readonly connection: Connection;
  readonly peer: Peer;
  readonly component: object;
  readonly generation: number;
  readonly epoch: bigint;
  readonly scope: Readonly<GrantScope>;
  readonly controller: AbortController;
  revoked: boolean;
}
export type Grant = object;

/** Host-only issuer. The caller's policy must establish the real configured binding and explicit record authorization. */
export class RegistrationAuthority {
  readonly #grants = new WeakMap<object, StoredGrant>();
  readonly #controllers = new Set<AbortController>();
  #epoch = 0n;
  constructor(
    private readonly currentConnection: () => Connection | undefined,
    private readonly currentGeneration: () => number,
    private readonly permits: (
      peer: Peer,
      scope: Readonly<GrantScope>,
      component: object,
    ) => boolean,
  ) {}

  issue(request: Request, input: GrantScope, component: object): Grant {
    const connection = this.currentConnection();
    if (!connection || request.signal.aborted) throw new Error("forbidden");
    const admission = connection.admit(request);
    if (
      "rejection" in admission ||
      admission.peer.principal.kind !== "owner" ||
      admission.peer.signal.aborted
    ) {
      throw new Error("forbidden");
    }
    if (
      !component ||
      typeof component !== "object" ||
      input.purpose !== "reception" ||
      !["live", "robot", "owner"].includes(input.consumer) ||
      !["owner_private", "workspace_private", "robot_private"].includes(
        input.audience,
      ) ||
      !Number.isSafeInteger(input.mappingRevision) ||
      input.mappingRevision <= 0 ||
      [
        input.ownerRef,
        input.workspaceRef,
        input.appId,
        input.profileRef,
        input.baseId,
        input.tableId,
        input.recordId,
        input.mappingId,
      ].some((value) => typeof value !== "string" || !value.trim()) ||
      input.actions.length === 0 ||
      new Set(input.actions).size !== input.actions.length ||
      input.actions.some(
        (action) => !["read", "photo", "patch"].includes(action),
      ) ||
      (input.consumer === "robot" &&
        (input.audience !== "robot_private" ||
          input.actions.includes("patch"))) ||
      (input.consumer === "owner" && input.audience !== "owner_private") ||
      (input.consumer === "live" &&
        input.audience !== "workspace_private" &&
        input.audience !== "owner_private")
    ) {
      throw new Error("forbidden");
    }
    const scope = Object.freeze({
      ...input,
      actions: Object.freeze([...input.actions]),
    });
    if (!this.permits(admission.peer, scope, component))
      throw new Error("forbidden");
    const generation = this.currentGeneration();
    if (!Number.isSafeInteger(generation) || generation <= 0)
      throw new Error("forbidden");
    const grant = Object.freeze({});
    const controller = new AbortController();
    this.#controllers.add(controller);
    const abort = () => controller.abort();
    request.signal.addEventListener("abort", abort, { once: true });
    admission.peer.signal.addEventListener("abort", abort, { once: true });
    controller.signal.addEventListener(
      "abort",
      () => {
        this.#controllers.delete(controller);
        request.signal.removeEventListener("abort", abort);
        admission.peer.signal.removeEventListener("abort", abort);
      },
      { once: true },
    );
    this.#grants.set(grant, {
      request,
      connection,
      peer: admission.peer,
      component,
      generation,
      epoch: this.#epoch,
      scope,
      controller,
      revoked: false,
    });
    try {
      this.check(grant, component, request);
    } catch (error) {
      controller.abort();
      throw error;
    }
    return grant;
  }

  check(
    grant: Grant,
    component: object,
    request: Request,
    action?: "read" | "photo" | "patch",
  ): Readonly<GrantScope> {
    const entry = this.#grants.get(grant);
    if (
      !entry ||
      entry.revoked ||
      entry.component !== component ||
      request.signal.aborted ||
      (action && !entry.scope.actions.includes(action))
    )
      throw new Error("revoked");
    let stillCurrent = false;
    try {
      stillCurrent =
        !entry.request.signal.aborted &&
        !entry.peer.signal.aborted &&
        this.currentConnection() === entry.connection &&
        this.currentGeneration() === entry.generation &&
        this.#epoch === entry.epoch;
    } catch {
      stillCurrent = false;
    }
    if (!stillCurrent) {
      entry.revoked = true;
      entry.controller.abort();
      throw new Error("revoked");
    }
    const admission = entry.connection.admit(request);
    if (
      "rejection" in admission ||
      admission.peer !== entry.peer ||
      admission.peer.principal.kind !== "owner"
    )
      throw new Error("revoked");
    let permitted = false;
    try {
      permitted = this.permits(entry.peer, entry.scope, component);
    } catch {
      permitted = false;
    }
    if (!permitted) {
      entry.revoked = true;
      entry.controller.abort();
      throw new Error("revoked");
    }
    return entry.scope;
  }

  /** A running invocation receives both the original and current peer lifetimes. */
  signal(
    grant: Grant,
    component: object,
    request: Request,
    action?: "read" | "photo" | "patch",
  ): AbortSignal {
    this.check(grant, component, request, action);
    const entry = this.#grants.get(grant);
    if (!entry) throw new Error("revoked");
    return AbortSignal.any([
      entry.controller.signal,
      entry.request.signal,
      entry.peer.signal,
      request.signal,
    ]);
  }

  /** The host calls this synchronously on any authority, mapping or identity change. */
  invalidateAll(): void {
    this.#epoch += 1n;
    for (const controller of this.#controllers) controller.abort();
  }

  revoke(grant: Grant, component: object, request: Request): void {
    this.check(grant, component, request);
    const entry = this.#grants.get(grant);
    if (entry) {
      entry.revoked = true;
      entry.controller.abort();
    }
  }
}
