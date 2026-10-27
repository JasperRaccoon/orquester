/**
 * Knowledge Graph linking — one myKG child (spec "Linking runs"; myKG 0.4.10 `cli.py`
 * `extract_graph`).
 *
 * Invocations (cwd = the plugin's myKG dir, where `mykg_config.yaml` is found):
 * - first run / rebuild: `mykg extract-graph <input>` — a full extract with schema induction into
 *   a NEW session; myKG prints `Session: <name>` (before any log line) and the run records it;
 * - resuming an interrupted full run or rebuild: `mykg extract-graph <input> --session <name>`
 *   (myKG skips the steps whose outputs exist; answered tasks are cached);
 * - normal run: `--session <name> --update` (`--append --sync`: new and edited entries extracted,
 *   deleted ones removed);
 * - schema growth: `--session <name> --update --append-with-grow-schema` (locked Pass 1 over the
 *   changed entries may add concepts/properties, then back-fills).
 *
 * The child's environment is minimal: `HOME` (and the XDG dirs) inside the plugin dir, tiktoken's
 * cache in the runtime (the installer prefetched its encodings), `PATH` = the venv's bin then the
 * system dirs, UTF-8 locale, unbuffered Python. No provider key, no account variable, nothing else of the daemon's env: myKG never calls an LLM itself (its
 * agent provider only writes inbox files).
 *
 * Success is exit 0 AND `output/nodes.jsonl` present (a non-blocking `validate_graph` failure exits
 * 0 without one). A failure's message is the failed steps from `pipeline_state.json`, then the
 * stderr tail. Cancel = SIGTERM, then SIGKILL after a grace on the injected clock.
 */

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { KnowledgeRunMode } from "@orquester/api";
import type { Clock } from "../../workflows/contracts.ts";
import type { KnowledgeRuntime } from "../ports.ts";
import { isMykgSessionName, mykgSessionPaths, readMykgProgress } from "./mykg-files.ts";

export type SpawnMykg = (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

/** System dirs after the venv's bin (no user tool dirs). */
const SYSTEM_PATH = ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"];
const STDERR_TAIL_BYTES = 16 * 1024;
const ERROR_MAX_CHARS = 2_000;
const DEFAULT_KILL_GRACE_MS = 10_000;

export interface MykgRunSpec {
  runtime: KnowledgeRuntime;
  /** cwd: holds `mykg_config.yaml` and `mykg_sessions/`. */
  mykgDir: string;
  /** The child's `HOME`. */
  homeDir: string;
  /** The entry mirror myKG reads (`KnowledgeStorePort.mykgInputDir`). */
  inputDir: string;
  mode: KnowledgeRunMode;
  /**
   * `update` / `grow-schema`: the recorded session (required). `full` / `rebuild`: a session this
   * run already created and is resuming, else null (a new one).
   */
  session: string | null;
}

export type MykgRunResult =
  | { kind: "ok"; session: string }
  | { kind: "failed"; session: string | null; error: string }
  | { kind: "cancelled"; session: string | null };

/** The argv after the binary. */
export function mykgArgs(spec: Pick<MykgRunSpec, "inputDir" | "mode" | "session">): string[] {
  const args = ["extract-graph", spec.inputDir];
  // The name comes from state.json: never let a hand-edited one become a flag or a path.
  if (spec.session && !isMykgSessionName(spec.session)) throw new Error(`Not a myKG session name: ${JSON.stringify(spec.session)}`);
  if (spec.mode === "update" || spec.mode === "grow-schema") {
    if (!spec.session) throw new Error(`A ${spec.mode} run needs the recorded myKG session.`);
    args.push("--session", spec.session, "--update");
    if (spec.mode === "grow-schema") args.push("--append-with-grow-schema");
    return args;
  }
  if (spec.session) args.push("--session", spec.session);
  return args;
}

/** The child's whole environment (never a spread of the daemon's). */
export function mykgEnv(runtime: Pick<KnowledgeRuntime, "mykgBin" | "tiktokenCacheDir">, homeDir: string): Record<string, string> {
  const venvBin = dirname(runtime.mykgBin);
  return {
    HOME: homeDir,
    PATH: [venvBin, ...SYSTEM_PATH].join(":"),
    VIRTUAL_ENV: dirname(venvBin),
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PYTHONUNBUFFERED: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONIOENCODING: "utf-8",
    XDG_CACHE_HOME: join(homeDir, ".cache"),
    XDG_CONFIG_HOME: join(homeDir, ".config"),
    XDG_DATA_HOME: join(homeDir, ".local", "share"),
    // The runtime's encoding cache, filled at install: tiktoken never goes to the network.
    TIKTOKEN_CACHE_DIR: runtime.tiktokenCacheDir,
    TMPDIR: join(homeDir, "tmp"),
    NO_COLOR: "1",
    TERM: "dumb"
  };
}

export interface MykgRunDeps {
  clock: Clock;
  spawn?: SpawnMykg;
  killGraceMs?: number;
}

/** One running child. */
export class MykgRun {
  readonly done: Promise<MykgRunResult>;
  private readonly child: ChildProcess;
  private session: string | null;
  private readonly sessionListeners = new Set<(session: string) => void>();
  private cancelled = false;
  private killTimer: { cancel(): void } | null = null;
  private stderrTail = "";

  constructor(
    private readonly spec: MykgRunSpec,
    private readonly deps: MykgRunDeps
  ) {
    this.session = spec.session;
    const spawn = deps.spawn ?? ((file, args, options) => nodeSpawn(file, [...args], options));
    this.child = spawn(spec.runtime.mykgBin, mykgArgs(spec), {
      cwd: spec.mykgDir,
      env: mykgEnv(spec.runtime, spec.homeDir),
      stdio: ["ignore", "pipe", "pipe"]
    });
    this.done = new Promise<MykgRunResult>((resolve) => {
      let finished = false;
      const finish = (result: MykgRunResult): void => {
        if (finished) return;
        finished = true;
        this.killTimer?.cancel();
        resolve(result);
      };
      this.child.on("error", (error) => {
        finish(this.cancelled ? { kind: "cancelled", session: this.session } : { kind: "failed", session: this.session, error: `myKG could not be started: ${error.message}` });
      });
      this.child.on("close", (code, signal) => {
        void this.settle(code, signal).then(finish);
      });
    });
    let line = "";
    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => {
      line += chunk;
      let newline: number;
      while ((newline = line.indexOf("\n")) >= 0) {
        this.onStdoutLine(line.slice(0, newline).replace(/\r$/, ""));
        line = line.slice(newline + 1);
      }
      if (line.length > 64 * 1024) line = line.slice(-1024);
    });
    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
    });
  }

  get pid(): number | null {
    return this.child.pid ?? null;
  }

  /** Called once, when a new session's name is printed (a run with a known session never calls it). */
  onSession(listener: (session: string) => void): () => void {
    this.sessionListeners.add(listener);
    return () => this.sessionListeners.delete(listener);
  }

  /** SIGTERM, then SIGKILL after the grace. Idempotent. */
  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.kill("SIGTERM");
    this.killTimer = this.deps.clock.setTimeout(() => {
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
    }, this.deps.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
  }

  private onStdoutLine(text: string): void {
    if (this.session !== null) return;
    const match = /^Session: (.+)$/.exec(text.trim());
    if (!match) return;
    const name = match[1]!.trim();
    if (!isMykgSessionName(name)) return;
    this.session = name;
    for (const listener of this.sessionListeners) listener(name);
  }

  private async settle(code: number | null, signal: NodeJS.Signals | null): Promise<MykgRunResult> {
    if (this.cancelled) return { kind: "cancelled", session: this.session };
    const session = this.session;
    const progress = session ? await readMykgProgress(mykgSessionPaths(this.spec.mykgDir, session).intermediate) : null;
    if (code === 0 && session) {
      try {
        await stat(mykgSessionPaths(this.spec.mykgDir, session).nodes);
        return { kind: "ok", session };
      } catch {
        return { kind: "failed", session, error: clip(describeFailure("myKG finished without writing the graph.", progress?.failed, this.stderrTail)) };
      }
    }
    const head = code === 0 ? "myKG finished without naming its session." : signal ? `myKG was stopped (${signal}).` : `myKG exited with code ${code}.`;
    return { kind: "failed", session, error: clip(describeFailure(head, progress?.failed, this.stderrTail)) };
  }
}

function describeFailure(head: string, failed: { step: string; error: string }[] | undefined, stderr: string): string {
  const parts = [head];
  for (const { step, error } of failed ?? []) parts.push(`${step}: ${error}`);
  const tail = stderr.trim();
  if (tail) parts.push(tail);
  return parts.join("\n");
}

/** The error's LAST characters (a traceback ends with the exception). */
function clip(text: string): string {
  return text.length <= ERROR_MAX_CHARS ? text : `…${text.slice(-(ERROR_MAX_CHARS - 1))}`;
}

/** What a stale-child check reads of a pid and how it signals it (Linux `/proc`; tests stub it). */
export interface MykgProcessProbe {
  /** The pid's command line (NULs as spaces), or null when there is no such process or it cannot be read. */
  cmdline(pid: number): Promise<string | null>;
  /** The pid's start time (`/proc/<pid>/stat` field 22, clock ticks since boot), or null. */
  startTime(pid: number): Promise<number | null>;
  /** Sends `signal`; false when the process is gone or may not be signalled. */
  signal(pid: number, signal: NodeJS.Signals): boolean;
}

export const procMykgProbe: MykgProcessProbe = {
  async cmdline(pid) {
    if (process.platform !== "linux") return null;
    try {
      return (await readFile(`/proc/${pid}/cmdline`, "utf8")).replace(/\0/g, " ").trim() || null;
    } catch {
      return null;
    }
  },
  async startTime(pid) {
    if (process.platform !== "linux") return null;
    try {
      const text = await readFile(`/proc/${pid}/stat`, "utf8");
      // `pid (comm) state ppid …`: comm may hold spaces and parens, so fields start after the last ")".
      const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
      const value = Number(fields[19]);
      return Number.isSafeInteger(value) && value >= 0 ? value : null;
    } catch {
      return null;
    }
  },
  signal(pid, signal) {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
};

/** The run's recorded child (`KnowledgeCurrentRunRecord.pid` / `pidStartTime`). */
export interface StaleMykgChild {
  pid: number | null;
  /** Its start time when it was spawned; null = not recorded (the command line alone decides). */
  startTime: number | null;
  /** The entry mirror it was given (`extract-graph <inputDir>`): another appdir's myKG is never touched. */
  inputDir?: string;
}

export interface StopStaleMykgOptions {
  clock: Clock;
  probe?: MykgProcessProbe;
  /** How long SIGTERM gets before SIGKILL. */
  termGraceMs?: number;
  /** How long a SIGKILL'd child gets to be gone before it is reported alive. */
  killWaitMs?: number;
  /** Liveness re-checks while waiting (on the injected clock). */
  pollMs?: number;
}

const STALE_POLL_MS = 100;
const STALE_KILL_WAIT_MS = 5_000;

/**
 * A child a previous daemon process left running (its pid and start time recorded with the run):
 * stopped before the run is started again, so two myKG processes never share a session. It is
 * signalled only while the pid is still that child — a myKG `extract-graph` of this plugin's input
 * whose start time matches the recorded one (a reused pid is left alone); elsewhere than Linux
 * nothing is read, so nothing is killed. SIGTERM, then a wait for the exit (liveness re-checked
 * every `pollMs` on the injected clock), SIGKILL after `termGraceMs`, then a bounded wait again.
 *
 * `none`: no such child; `stopped`: it is gone; `alive`: it outlived even SIGKILL's wait (the
 * caller must not start another myKG on its session).
 */
export async function stopStaleMykg(child: StaleMykgChild, options: StopStaleMykgOptions): Promise<"none" | "stopped" | "alive"> {
  const { pid } = child;
  if (pid === null || !Number.isSafeInteger(pid) || pid <= 1) return "none";
  const probe = options.probe ?? procMykgProbe;
  const isChild = async (): Promise<boolean> => {
    const cmdline = await probe.cmdline(pid);
    if (cmdline === null || !/mykg/.test(cmdline) || !/extract-graph/.test(cmdline)) return false;
    // `extract-graph <this knowledge base's input dir>` exactly: another appdir's myKG (a dev
    // `.stage` daemon, another checkout) on a recycled pid is never signalled.
    if (child.inputDir !== undefined && !` ${cmdline} `.includes(` extract-graph ${child.inputDir} `)) return false;
    if (child.startTime !== null && (await probe.startTime(pid)) !== child.startTime) return false;
    return true;
  };
  const pollMs = options.pollMs ?? STALE_POLL_MS;
  /** True once the child is gone, false when `ms` passed with it still there. */
  const gone = async (ms: number): Promise<boolean> => {
    const deadline = options.clock.now().getTime() + ms;
    for (;;) {
      if (!(await isChild())) return true;
      const left = deadline - options.clock.now().getTime();
      if (left <= 0) return false;
      await new Promise<void>((resolve) => options.clock.setTimeout(resolve, Math.min(pollMs, left)));
    }
  };
  if (!(await isChild())) return "none";
  if (!probe.signal(pid, "SIGTERM")) return (await isChild()) ? "alive" : "stopped";
  if (await gone(options.termGraceMs ?? DEFAULT_KILL_GRACE_MS)) return "stopped";
  // Still the same child (checked just now): no other process gets the SIGKILL.
  probe.signal(pid, "SIGKILL");
  return (await gone(options.killWaitMs ?? STALE_KILL_WAIT_MS)) ? "stopped" : "alive";
}
