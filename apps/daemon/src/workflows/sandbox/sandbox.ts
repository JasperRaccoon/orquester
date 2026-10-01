// Automated workflows — the sandbox runner the code and shell blocks run through (spec §5.6, §5.8).
//
// `spawn()` lays the attempt out on disk and starts `runner.mjs` DETACHED (a session and process
// group of its own, stdio on /dev/null, unref'd), so the attempt survives a daemon restart and its
// exit is recorded on disk whether or not the daemon is up:
//
//   <attemptDir>/spec.json     what to run and its limits (kind, shell, cwd, deadline, caps)
//   <attemptDir>/block.mjs     code: the user's module            (0600)
//   <attemptDir>/input.json    code: {input, nodes, trigger, run, project, secrets} (0600; the code
//                              host deletes it the moment it has read it, the runner at the end)
//   <attemptDir>/script.sh     shell: the script, run as `bash -c` / `sh -c` (0600)
//   <attemptDir>/handle.json   {pid, starttime, attemptDir} of the runner
//   <attemptDir>/runner.json   the runner's "my SIGTERM handler is installed" marker
//   <attemptDir>/child.json    {pid, starttime} of the work (written by the runner)
//   <attemptDir>/stdout.log, stderr.log   capped copies of the work's output
//   <attemptDir>/result.json   code: the outcome (code-host.mjs)
//   <attemptDir>/exit.json     the runner's record of the end, written last
//
// `wait()` works the same for a child of this daemon and for a runner adopted after a restart: it
// watches for exit.json, and treats a runner that is gone without one as interrupted. The runner
// enforces the deadline itself; `wait()` only backs it up, well past the runner's own grace.

import { spawn as spawnChild } from "node:child_process";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { WORKFLOW_LIMITS } from "@orquester/api";

import type {
  Clock,
  SandboxExit,
  SandboxHandle,
  SandboxRunner,
  SandboxSpawnRequest,
  WorkflowLogger
} from "../contracts.ts";
import { buildSandboxEnv, defaultSandboxTmpDir } from "./env.ts";
import { isSameProcessAlive, readStarttime, signalGroupIfOurs } from "./proc.ts";

const SANDBOX_RUNNER_PATH = fileURLToPath(new URL("./runner.mjs", import.meta.url));

/** SIGTERM → SIGKILL grace, the runner's and `kill()`'s (spec §5.6). */
const SANDBOX_KILL_GRACE_MS = 5_000;
/** How far past the deadline + grace `wait()` steps in for a runner that did not. */
const SANDBOX_DEADLINE_BACKSTOP_MS = 10_000;
const DEFAULT_POLL_MS = 250;
/** How long kill() waits for a runner that is still booting to install its SIGTERM handler. */
const RUNNER_READY_TIMEOUT_MS = 5_000;

/** `SandboxExit` plus what the runner recorded beside it (additive; the engine may ignore it). */
export interface SandboxExitDetail extends SandboxExit {
  /** The run's cancel (a SIGTERM to the runner) ended it. */
  cancelled?: boolean;
  /** No exit.json: the runner itself was gone (SIGKILL, OOM, a reboot). */
  interrupted?: boolean;
  endedAt?: string;
  stdoutCapped?: boolean;
  stderrCapped?: boolean;
  /** The runner could not start the work (e.g. no `bash` on PATH). */
  error?: string;
}

export interface SandboxRunnerOptions {
  /** `<appdir>/tmp` — the attempt's TMPDIR. Defaults to the daemon's TMPDIR, else the OS's. */
  appdirTmp?: string;
  clock?: Clock;
  logger?: WorkflowLogger;
}

const realClock: Clock = {
  now: () => new Date(),
  setTimeout(fn, ms) {
    const timer = setTimeout(fn, ms);
    return { cancel: () => clearTimeout(timer) };
  }
};

function clampMemoryMb(value: number | undefined): number {
  const { default: fallback, min, max } = WORKFLOW_LIMITS.codeMemoryMb;
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
  await rename(tmp, path);
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function parseResult(value: unknown): SandboxExit["result"] | undefined {
  const record = asRecord(value);
  if (record === null) {
    return undefined;
  }
  if (record.stop === true) {
    return typeof record.reason === "string" ? { stop: true, reason: record.reason } : { stop: true };
  }
  if (record.ok === true) {
    return { ok: true, value: record.value ?? null };
  }
  if (record.ok === false) {
    const error = asRecord(record.error);
    const message = typeof error?.message === "string" ? error.message : "The code block failed.";
    return typeof error?.stack === "string" ? { ok: false, error: { message, stack: error.stack } } : { ok: false, error: { message } };
  }
  return undefined;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** exit.json + result.json of a finished attempt, or null when exit.json is not there (yet). */
async function readSandboxExit(attemptDir: string): Promise<SandboxExitDetail | null> {
  const record = asRecord(await readJson(join(attemptDir, "exit.json")));
  if (record === null) {
    return null;
  }
  const exit: SandboxExitDetail = {
    code: typeof record.code === "number" ? record.code : null,
    signal: typeof record.signal === "string" ? record.signal : null,
    timedOut: record.timedOut === true,
    stdoutBytes: numberOr(record.stdoutBytes, 0),
    stderrBytes: numberOr(record.stderrBytes, 0),
    cancelled: record.cancelled === true
  };
  if (typeof record.endedAt === "string") exit.endedAt = record.endedAt;
  if (record.stdoutCapped === true) exit.stdoutCapped = true;
  if (record.stderrCapped === true) exit.stderrCapped = true;
  if (typeof record.error === "string") exit.error = record.error;
  const result = parseResult(await readJson(join(attemptDir, "result.json")));
  if (result !== undefined) {
    exit.result = result;
  }
  return exit;
}

async function readChildIdentity(attemptDir: string): Promise<{ pid: number; starttime: number } | null> {
  const record = asRecord(await readJson(join(attemptDir, "child.json")));
  if (record === null || typeof record.pid !== "number") {
    return null;
  }
  return { pid: record.pid, starttime: numberOr(record.starttime, 0) };
}

/** The contract's `SandboxRunner`, its exits typed with what the runner records beside them. */
export interface DetailedSandboxRunner extends SandboxRunner {
  wait(handle: SandboxHandle, opts: Parameters<SandboxRunner["wait"]>[1]): Promise<SandboxExitDetail>;
  readExit(attemptDir: string): Promise<SandboxExitDetail | null>;
}

export function createSandboxRunner(options: SandboxRunnerOptions = {}): DetailedSandboxRunner {
  const clock = options.clock ?? realClock;
  const pollMs = DEFAULT_POLL_MS;
  const killGraceMs = SANDBOX_KILL_GRACE_MS;
  const maxLogBytes = WORKFLOW_LIMITS.maxLogBytes;
  const maxOutputBytes = WORKFLOW_LIMITS.maxOutputBytes;
  const nodePath = process.execPath;
  const tmpDir = options.appdirTmp ?? defaultSandboxTmpDir();

  /** Runners this daemon started: resolved on their `exit`, so a wait wakes at once. */
  const ownExits = new Map<number, Promise<void>>();

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      clock.setTimeout(resolve, ms);
    });

  const isAlive = (handle: SandboxHandle): boolean => isSameProcessAlive(handle.pid, handle.starttime);

  /** Waits until the runner is gone, at most `ms`; true when it is. */
  const awaitGone = async (handle: SandboxHandle, ms: number): Promise<boolean> => {
    const until = clock.now().getTime() + ms;
    while (isAlive(handle)) {
      const left = until - clock.now().getTime();
      if (left <= 0) {
        return false;
      }
      const own = ownExits.get(handle.pid);
      const step = sleep(Math.min(50, left));
      await (own ? Promise.race([own, step]) : step);
    }
    return true;
  };

  /** SIGTERM then SIGKILL the work's own group, when a runner that is gone left it behind. */
  const endOrphanedWork = async (attemptDir: string): Promise<void> => {
    const child = await readChildIdentity(attemptDir);
    if (child === null) {
      return;
    }
    if (signalGroupIfOurs(child.pid, child.starttime, "SIGTERM")) {
      await sleep(killGraceMs);
      signalGroupIfOurs(child.pid, child.starttime, "SIGKILL");
    }
  };

  const kill = async (handle: SandboxHandle): Promise<void> => {
    if (!isAlive(handle)) {
      await endOrphanedWork(handle.attemptDir);
      return;
    }
    // A runner still booting would die of the SIGTERM without recording anything: wait for its
    // `runner.json` (written once its handler is installed), a moment at most.
    const ready = join(handle.attemptDir, "runner.json");
    const readyBy = clock.now().getTime() + RUNNER_READY_TIMEOUT_MS;
    while (!(await exists(ready)) && isAlive(handle) && clock.now().getTime() < readyBy) {
      await sleep(10);
    }
    // The runner leads a group of its own (itself); its SIGTERM handler ends the work's group,
    // SIGKILLs it after the grace and records the exit.
    signalGroupIfOurs(handle.pid, handle.starttime, "SIGTERM");
    if (await awaitGone(handle, killGraceMs + 2_000)) {
      return;
    }
    const child = await readChildIdentity(handle.attemptDir);
    if (isAlive(handle)) {
      signalGroupIfOurs(handle.pid, handle.starttime, "SIGKILL");
    }
    if (child !== null) {
      signalGroupIfOurs(child.pid, child.starttime, "SIGKILL");
    }
    await awaitGone(handle, 2_000);
  };

  const readExit = readSandboxExit;

  const readHandle = async (attemptDir: string): Promise<SandboxHandle | null> => {
    const record = (await readJson(join(attemptDir, "handle.json"))) as Partial<SandboxHandle> | null | undefined;
    if (!record || typeof record !== "object") return null;
    if (typeof record.pid !== "number" || !(record.pid > 0) || typeof record.starttime !== "number") return null;
    return { pid: record.pid, starttime: record.starttime, attemptDir };
  };

  const spawn = async (request: SandboxSpawnRequest): Promise<SandboxHandle> => {
    if (request.kind !== "code" && request.kind !== "shell") {
      throw new Error(`Unknown sandbox kind: ${String(request.kind)}`);
    }
    const attemptDir = request.attemptDir;
    await mkdir(attemptDir, { recursive: true, mode: 0o700 });
    // A reused directory must not hand a new wait an old ending.
    await Promise.all(
      ["exit.json", "result.json", "child.json", "handle.json", "runner.json"].map((name) => rm(join(attemptDir, name), { force: true }))
    );
    await mkdir(tmpDir, { recursive: true });
    const env = buildSandboxEnv({ runId: request.runId, workflowId: request.workflowId, env: request.env, tmpDir });

    const deadlineAt = clock.now().getTime() + Math.max(0, request.timeoutMs);
    await writeJsonAtomic(join(attemptDir, "spec.json"), {
      version: 1,
      kind: request.kind,
      shell: request.shell === "sh" ? "sh" : "bash",
      cwd: request.cwd,
      projectPath: request.projectPath,
      memoryMb: request.kind === "code" ? clampMemoryMb(request.memoryMb) : undefined,
      deadlineAt,
      killGraceMs,
      maxLogBytes,
      maxOutputBytes,
      runId: request.runId,
      workflowId: request.workflowId
    });
    if (request.kind === "code") {
      await writeFile(join(attemptDir, "block.mjs"), request.source, { mode: 0o600 });
      await writeFile(join(attemptDir, "input.json"), JSON.stringify(request.input ?? {}), { mode: 0o600 });
    } else {
      await writeFile(join(attemptDir, "script.sh"), request.source, { mode: 0o600 });
    }

    const child = spawnChild(nodePath, [SANDBOX_RUNNER_PATH, attemptDir], {
      cwd: request.cwd,
      env,
      detached: true,
      stdio: "ignore"
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", (error) => reject(error));
    });
    const pid = child.pid;
    if (pid === undefined) {
      throw new Error("The sandbox runner did not start.");
    }
    const promise = new Promise<void>((resolve) => {
      child.once("exit", () => {
        ownExits.delete(pid);
        resolve();
      });
    });
    ownExits.set(pid, promise);
    child.unref();

    const handle: SandboxHandle = { pid, starttime: readStarttime(pid), attemptDir };
    await writeJsonAtomic(join(attemptDir, "handle.json"), handle);
    options.logger?.debug("sandbox attempt started", { pid, attemptDir, kind: request.kind });
    return handle;
  };

  const wait = (
    handle: SandboxHandle,
    opts: { deadlineAt: Date; signal: AbortSignal; onLogs?: (bytes: { stdout: number; stderr: number }) => void }
  ): Promise<SandboxExitDetail> =>
    new Promise<SandboxExitDetail>((resolve, reject) => {
      const stdoutPath = join(handle.attemptDir, "stdout.log");
      const stderrPath = join(handle.attemptDir, "stderr.log");
      let done = false;
      let running = false;
      let again = false;
      let timer: { cancel(): void } | null = null;
      let killing: Promise<void> | null = null;
      let timedOutByBackstop = false;
      let lastLogs = { stdout: -1, stderr: -1 };

      const startKill = (): void => {
        if (killing === null) {
          killing = kill(handle).catch((error: unknown) => {
            options.logger?.warn("sandbox kill failed", { pid: handle.pid, error: String(error) });
          });
          void killing.then(() => request());
        }
      };

      const finish = (exit: SandboxExitDetail): void => {
        if (done) return;
        done = true;
        timer?.cancel();
        opts.signal.removeEventListener("abort", onAbort);
        resolve(exit);
      };

      const reportLogs = async (): Promise<void> => {
        if (!opts.onLogs) return;
        const [stdout, stderr] = await Promise.all([fileSize(stdoutPath), fileSize(stderrPath)]);
        if (stdout !== lastLogs.stdout || stderr !== lastLogs.stderr) {
          lastLogs = { stdout, stderr };
          try {
            opts.onLogs({ stdout, stderr });
          } catch {
            // a listener's problem is not the attempt's
          }
        }
      };

      const interrupted = async (): Promise<SandboxExitDetail> => {
        // The runner is gone without a record: whatever it started may still run.
        await endOrphanedWork(handle.attemptDir);
        const exit: SandboxExitDetail = {
          code: null,
          signal: "SIGKILL",
          timedOut: timedOutByBackstop,
          stdoutBytes: await fileSize(stdoutPath),
          stderrBytes: await fileSize(stderrPath),
          interrupted: true
        };
        if (opts.signal.aborted) exit.cancelled = true;
        const result = parseResult(await readJson(join(handle.attemptDir, "result.json")));
        if (result !== undefined) exit.result = result;
        return exit;
      };

      const check = async (): Promise<void> => {
        await reportLogs();
        const exit = await readExit(handle.attemptDir);
        if (exit !== null) {
          await reportLogs();
          finish(exit);
          return;
        }
        if (!isAlive(handle)) {
          // exit.json is written just before the runner exits: read once more past that race.
          const late = await readExit(handle.attemptDir);
          finish(late ?? (await interrupted()));
          return;
        }
        const backstopAt = opts.deadlineAt.getTime() + killGraceMs + SANDBOX_DEADLINE_BACKSTOP_MS;
        if (clock.now().getTime() >= backstopAt && killing === null) {
          timedOutByBackstop = true;
          options.logger?.warn("sandbox runner missed its deadline; killing it", { pid: handle.pid });
          startKill();
        }
      };

      function request(): void {
        if (done) return;
        if (running) {
          again = true;
          return;
        }
        running = true;
        timer?.cancel();
        timer = null;
        void check()
          .catch((error: unknown) => {
            options.logger?.warn("sandbox wait check failed", { pid: handle.pid, error: String(error) });
          })
          .finally(() => {
            running = false;
            if (done) return;
            if (again) {
              again = false;
              request();
              return;
            }
            timer = clock.setTimeout(request, pollMs);
          });
      }

      function onAbort(): void {
        startKill();
      }

      try {
        if (opts.signal.aborted) {
          startKill();
        } else {
          opts.signal.addEventListener("abort", onAbort, { once: true });
        }
        const own = ownExits.get(handle.pid);
        if (own) {
          void own.then(() => request());
        }
        request();
      } catch (error) {
        reject(error);
      }
    });

  return {
    spawn,
    wait,
    isAlive,
    readExit,
    readHandle,
    kill
  };
}
