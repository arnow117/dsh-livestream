import { spawn } from "node:child_process";

export interface BoundedResult {
  exitCode: number | null;
  stdout: Buffer;
  stopped: boolean;
  joined: boolean;
  pid: number;
  authIndeterminate: boolean;
}
const MAX_OUTPUT = 1024 * 1024;
const MAX_LIFETIME_MS = 120_000;
function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
/** Internal primitive: caller supplies only a trusted executable, fixed argv and filtered environment. */
export async function runBoundedProcess(options: {
  executable: string;
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  timeoutMs: number;
  stdin?: Uint8Array;
  onSpawn?: (pid: number) => void;
}): Promise<BoundedResult> {
  if (
    options.signal.aborted ||
    !Number.isInteger(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    options.timeoutMs > 30_000 ||
    (options.stdin !== undefined && options.stdin.byteLength > MAX_OUTPUT)
  )
    throw new Error("executor_unavailable");
  const child = spawn(options.executable, options.argv, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pid = child.pid;
  if (pid === undefined) {
    await new Promise((resolve) => child.once("error", resolve));
    throw new Error("executor_unavailable");
  }
  let stopped = false;
  let authIndeterminate = false;
  let size = 0;
  const stdout: Buffer[] = [];
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try {
      signalProcess(pid, "SIGINT");
    } catch {
      /* join check below remains authoritative */
    }
  };
  const deadline = setTimeout(stop, options.timeoutMs);
  const hardDeadline = setTimeout(() => {
    stopped = true;
    authIndeterminate = true;
    try {
      if (child.exitCode === null && child.signalCode === null)
        signalProcess(pid, "SIGKILL");
    } catch {}
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  }, MAX_LIFETIME_MS);
  options.signal.addEventListener("abort", stop, { once: true });
  if (options.signal.aborted) stop();
  const collect = (chunk: Buffer, retain: boolean) => {
    size += chunk.length;
    if (size > MAX_OUTPUT) {
      stop();
      return;
    }
    if (retain) stdout.push(chunk);
  };
  child.stdout.on("data", (chunk: Buffer) => collect(chunk, true));
  child.stderr.on("data", (chunk: Buffer) => collect(chunk, false));
  child.stdin.on("error", stop);
  child.stdin.end(options.stdin === undefined ? undefined : options.stdin);
  try {
    options.onSpawn?.(pid);
  } catch {
    stop();
  }
  const exitCode = await new Promise<number | null>((resolve) => {
    child.on("error", stop);
    child.on("close", (code) => resolve(code));
  });
  clearTimeout(deadline);
  clearTimeout(hardDeadline);
  options.signal.removeEventListener("abort", stop);
  let joined = !groupExists(pid);
  for (let i = 0; !joined && i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    joined = !groupExists(pid);
  }
  return {
    exitCode,
    stdout: Buffer.concat(stdout),
    stopped,
    joined,
    pid,
    authIndeterminate,
  };
}
