import { randomUUID } from "node:crypto";
import type { Grant, GrantScope, RegistrationAuthority } from "./authority";
import type { LoadedCore, ParentContext } from "./artifactContract";
import { mountPrivateConsumers } from "./privateHost";
import { readRegistrationProfile } from "./recordAdapter";
import {
  readBoundRecord,
  type Binding,
  type WorkspaceExecutionContext,
} from "./workspaceExecutor";

interface PrivateApplicationOptions {
  context: ParentContext;
  core: LoadedCore;
  authority: RegistrationAuthority;
  binding: Binding;
  execution: Omit<WorkspaceExecutionContext, "core" | "assertCurrent">;
  now: () => string;
}

type ScopeInput = Omit<GrantScope, "consumer" | "audience" | "actions">;

/**
 * Host-only composition. It joins the admitted peer, a distinct mounted component,
 * the fixed workspace executor, and the one loaded contract instance.
 */
export async function mountRegistrationPrivateApplication(
  options: PrivateApplicationOptions,
) {
  const core = options.core;
  const authority = options.authority;
  const lifetime = new AbortController();
  const binding = Object.freeze({
    ...options.binding,
    fieldIds: Object.freeze([...options.binding.fieldIds]),
  });
  const config = core.parseRegistrationConfig(options.execution.profileConfig);
  const execution = {
    ...options.execution,
    profileConfig: config,
    configBytes: Uint8Array.from(options.execution.configBytes),
  };
  const checkScope = (scope: Readonly<GrantScope>) => {
    if (
      lifetime.signal.aborted ||
      scope.appId !== binding.appId ||
      scope.profileRef !== config.profileRef ||
      scope.baseId !== config.baseId ||
      scope.tableId !== config.visitorsTableId ||
      scope.mappingId !== config.mapping.mappingId ||
      scope.mappingRevision !== config.mapping.revision
    ) {
      throw new Error("revoked");
    }
  };
  const mounted = await mountPrivateConsumers(options.context, core, {
    assertCurrent(grant, request, component) {
      checkScope(authority.check(grant, component, request, "read"));
    },
    async readOriginal(grant, request, component) {
      const assertCurrent = () => {
        const scope = authority.check(grant, component, request, "read");
        checkScope(scope);
        return scope;
      };
      const scope = assertCurrent();
      const requestRef = randomUUID();
      const readEvidenceRef = randomUUID();
      const result = await readRegistrationProfile(
        config,
        scope.recordId,
        requestRef,
        readEvidenceRef,
        {
          assertCurrent: () => {
            const current = assertCurrent();
            if (current.recordId !== scope.recordId) throw new Error("revoked");
          },
          readExactRecord: (recordId) =>
            readBoundRecord(binding, recordId, {
              ...execution,
              core,
              signal: AbortSignal.any([
                execution.signal,
                lifetime.signal,
                authority.signal(grant, component, request, "read"),
              ]),
              assertCurrent: () => {
                const current = assertCurrent();
                if (current.recordId !== recordId) throw new Error("revoked");
              },
            }),
          projectRecord: core.projectRecord,
          now: options.now,
        },
      );
      assertCurrent();
      if (result.outcome !== "read") throw new Error(result.code);
      return { requestRef, observation: result.observation };
    },
  });

  const issue = (
    request: Request,
    scope: ScopeInput,
    consumer: "live" | "robot",
  ): Grant => {
    const component =
      consumer === "live" ? mounted.liveComponent : mounted.robotComponent;
    checkScope({
      ...scope,
      consumer,
      audience: consumer === "live" ? "owner_private" : "robot_private",
      actions: ["read"],
    });
    return authority.issue(
      request,
      {
        ...scope,
        consumer,
        audience: consumer === "live" ? "owner_private" : "robot_private",
        actions: ["read"],
      },
      component,
    );
  };
  return {
    issueLive: (request: Request, scope: ScopeInput) =>
      issue(request, scope, "live"),
    issueRobot: (request: Request, scope: ScopeInput) =>
      issue(request, scope, "robot"),
    liveRead: mounted.liveRead,
    robotConsume: mounted.robotConsume,
    async dispose() {
      lifetime.abort();
      await mounted.dispose();
    },
  };
}
