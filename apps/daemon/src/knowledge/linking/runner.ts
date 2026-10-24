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

  /** The session the run extracts into, once known. */
  get sessionName(): string | null {
    return this.session;
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

export function startMykgRun(spec: MykgRunSpec, deps: MykgRunDeps): MykgRun {
  return new MykgRun(spec, deps);
}

/**
 * A child a previous daemon process left running (its pid recorded with the run): stopped before
 * the run is started again, so two myKG processes never share a session. Linux only checks that
 * the pid is still THIS knowledge base's myKG extract (`/proc/<pid>/cmdline` names `mykg` and
 * `extract-graph <inputDir>`): a recycled pid now running another appdir's myKG (a dev `.stage`
 * daemon, another checkout) or anything else is never signalled. Elsewhere nothing is killed.
 */
export async function stopStaleMykg(
  pid: number | null,
  inputDir: string,
  readCmdline: (pid: number) => Promise<string | null> = procCmdline
): Promise<boolean> {
  if (pid === null || !Number.isSafeInteger(pid) || pid <= 1) return false;
  const cmdline = await readCmdline(pid);
  if (cmdline === null || !/mykg/.test(cmdline) || !` ${cmdline} `.includes(` extract-graph ${inputDir} `)) return false;
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

async function procCmdline(pid: number): Promise<string | null> {
  if (process.platform !== "linux") return null;
  try {
    return (await readFile(`/proc/${pid}/cmdline`, "utf8")).replace(/\0/g, " ");
  } catch {
    return null;
  }
}
