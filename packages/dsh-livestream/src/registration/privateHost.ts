import { consumeLivePrivate } from "./livePrivateConsumer";

import type {
  ParentContext,
  PrivateDependencies,
  PrivateRead,
  RobotHost,
  LoadedCore,
} from "./artifactContract";

/** Both components are separate Cordis children, with independent exact-record reads. */
export async function mountPrivateConsumers<T>(
  context: ParentContext,
  core: Pick<LoadedCore, "mountRobotPrivateHost">,
  dependencies: PrivateDependencies<T>,
) {
  let liveActive = false;
  const liveComponent = Object.freeze({});
  const liveFiber = await context.plugin((child) => {
    liveActive = true;
    child.effect(
      () => () => {
        liveActive = false;
      },
      "registration: live private lifetime",
    );
  });
  let robot: RobotHost<T>;
  try {
    robot = await core.mountRobotPrivateHost(context, dependencies);
  } catch (error) {
    await liveFiber.dispose();
    throw error;
  }
  return {
    liveComponent,
    robotComponent: robot.component,
    liveRead(grant: object, request: Request): Promise<PrivateRead<T>> {
      return consumeLivePrivate({
        assertCurrent: () => {
          if (!liveActive) throw new Error("revoked");
          dependencies.assertCurrent(grant, request, liveComponent);
        },
        readOriginal: () =>
          dependencies.readOriginal(grant, request, liveComponent),
      });
    },
    robotConsume: (grant: object, request: Request) =>
      robot.consume(grant, request),
    async dispose() {
      await Promise.all([liveFiber.dispose(), robot.dispose()]);
    },
  };
}
