import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export type BackgroundLaunchPlan = {
  command: string;
  args: string[];
  policy: "direct";
};

export type BackgroundCompletion = {
  reason: "close" | "error" | "timeout";
  code: number | null;
  signal: NodeJS.Signals | null;
};

export type BackgroundLaunchHandle = {
  child: ChildProcess;
  plan: BackgroundLaunchPlan;
  /** Resolves only after the directly spawned worker closes or fails to spawn. */
  completed: Promise<BackgroundCompletion>;
};

export function resolveBackgroundLaunch(nodeArgs: string[], options: { execPath?: string } = {}): BackgroundLaunchPlan {
  return { command: options.execPath ?? process.execPath, args: nodeArgs, policy: "direct" };
}

export function launchBackground(
  nodeArgs: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    stdio?: SpawnOptions["stdio"];
    execPath?: string;
    completionTimeoutMs?: number;
    detached?: boolean;
    unref?: boolean;
  },
): BackgroundLaunchHandle {
  const plan = resolveBackgroundLaunch(nodeArgs, { execPath: options.execPath });
  const detached = options.detached ?? true;
  const child = spawn(plan.command, plan.args, {
    cwd: options.cwd,
    env: options.env,
    detached,
    stdio: options.stdio ?? "ignore",
  });

  let timedOut = false;
  let forceTimer: NodeJS.Timeout | undefined;
  let resolveCompleted!: (value: BackgroundCompletion) => void;
  const completed = new Promise<BackgroundCompletion>(resolve => { resolveCompleted = resolve; });
  const timeout = setTimeout(() => {
    timedOut = true;
    terminate(child, detached, "SIGTERM");
    forceTimer = setTimeout(() => terminate(child, detached, "SIGKILL"), 500);
  }, Math.max(1_000, options.completionTimeoutMs ?? 20 * 60_000));

  let settled = false;
  const settle = (value: BackgroundCompletion) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    if (forceTimer) clearTimeout(forceTimer);
    resolveCompleted(value);
  };
  child.once("close", async (code, signal) => {
    if (timedOut) await waitForProcessGroupExit(child.pid, detached);
    settle({ reason: timedOut ? "timeout" : "close", code, signal });
  });
  child.once("error", () => settle({ reason: "error", code: null, signal: null }));
  if (options.unref !== false) child.unref();
  return { child, plan, completed };
}

function terminate(child: ChildProcess, detached: boolean, signal: NodeJS.Signals): void {
  if (detached && process.platform !== "win32" && child.pid) {
    try { process.kill(-child.pid, signal); return; } catch {}
  }
  try { child.kill(signal); } catch {}
}
async function waitForProcessGroupExit(pid: number | undefined, detached: boolean): Promise<void> {
  if (!pid || !detached || process.platform === "win32") return;
  const deadline = Date.now() + 1_500;
  while (Date.now() < deadline) {
    try { process.kill(-pid, 0); } catch (error: any) {
      if (error?.code === "ESRCH") return;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}