/**
 * Workflow `shell` and `code` blocks in box projects (spec §8.8).
 *
 * {@link createBoxAwareSandboxRunner} wraps the host's `SandboxRunner`
 * (workflows/sandbox/sandbox.ts) and keeps its contract: a request whose
 * project lives in a box runs THERE, everything else goes to the host runner
 * untouched. For a box attempt:
 *
 * - The work is a DETACHED `orq-agent` process (procId `wf-<uuid>`), so it
 *   survives a daemon restart in the box's process table — not through the
 *   host's `/proc` re-adoption. After a restart `wait()` reattaches with
 *   `attach(procId, offset)` from the last byte it recorded.
 * - The attempt directory stays ON THE HOST, laid out as the host runner lays
 *   it out where the executors read it: `stdout.log`/`stderr.log` (capped the
 *   same way, redacted at read time as always), `result.json`, `exit.json`,
 *   `handle.json`, plus `box.json` — {boxId, procId, nonce, offsets} — written
 *   BEFORE the process starts (persist before the side effect).
 * - Secrets reach the box only through env (shell blocks, by the user's
 *   choice) and stdin: a code block's input — secrets included — and its module
 *   source go over stdin to `box-code-host.mjs`, which writes nothing in the
 *   box; its result comes back as a nonce-tagged last line of stdout that is
 *   cut out of the kept log.
 * - The deadline and cancel are enforced from here (SIGTERM, SIGKILL after the
 *   same grace as the host runner); a box that stays away past the deadline is
 *   given up as interrupted, and its process killed when the box returns.
 * - Env: the box's own, the block's env, the workflow ids and launch marker,
 *   and the tooling contribution (git uses the box user's config and
 *   `orq-agent`'s `SSH_AUTH_SOCK`). Never the host's env.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import { WORKFLOW_LIMITS, hostToBoxPath } from "@orquester/api";
import { appendNodeRequireOption } from "@orquester/config";

import { AGENT_LAUNCH_ENV_VAR } from "../../../agent-host/support/leftover-processes.ts";
import type { Clock, SandboxHandle, SandboxSpawnRequest, WorkflowLogger } from "../../../workflows/contracts.ts";
import type { DetailedSandboxRunner, SandboxExitDetail } from "../../../workflows/sandbox/sandbox.ts";
import type { BoxConnection, BoxHub, BoxProcess, BoxRegistry, BoxToolingProvisioner } from "../../contracts.ts";
import { boxToolingEnv, toolingFor } from "./env.ts";
import { waitSpawned } from "./run.ts";

/** SIGTERM → SIGKILL grace, as the host runner's. */
const KILL_GRACE_MS = 5_000;
/** How far past the deadline + grace a box that stays away is given up. */
const DEADLINE_BACKSTOP_MS = 10_000;
/** The box keeps this much output for a reattach while the daemon is away. */
const DETACH_BUFFER_BYTES = 8 * 1024 * 1024;
/** `handle.json` starttime of a box attempt: never a host process identity. */
export const BOX_SANDBOX_STARTTIME = -1;
const STATE_FILE = "box.json";
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const CODE_HOST_PATH = fileURLToPath(new URL("./box-code-host.mjs", import.meta.url));
let codeHostSource: string | null = null;
function boxCodeHostSource(): string {
  codeHostSource ??= readFileSync(CODE_HOST_PATH, "utf8");
  return codeHostSource;
}

export interface BoxSandboxDeps {
  registry: Pick<BoxRegistry, "locate" | "get" | "requireConnected" | "onChange">;
  hub: Pick<BoxHub, "get" | "onConnectionChange">;
  tooling?: Pick<BoxToolingProvisioner, "contribution">;
  clock?: Clock;
  logger?: WorkflowLogger;
}

/** What `box.json` records about a box attempt (host-side; nothing secret). */
interface BoxAttemptState {
  version: 1;
  boxId: string;
  procId: string;
  kind: "code" | "shell";
  /** Code: tags the result line; null for shell. */
  nonce: string | null;
  /** Output offset to reattach from (bytes consumed and kept). */
  resumeOffset: number;
  stdoutWritten: number;
  stderrWritten: number;
  stdoutProduced: number;
  stderrProduced: number;
  stdoutCapped: boolean;
  stderrCapped: boolean;
  /** Set when the daemon gave the attempt up; its process is killed when the box returns. */
  abandoned?: boolean;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
  await rename(tmp, path);
}

function readState(attemptDir: string): BoxAttemptState | null {
  try {
    const value = JSON.parse(readFileSync(join(attemptDir, STATE_FILE), "utf8")) as Partial<BoxAttemptState>;
    if (value?.version !== 1 || typeof value.boxId !== "string" || typeof value.procId !== "string") return null;
    return {
      version: 1,
      boxId: value.boxId,
      procId: value.procId,
      kind: value.kind === "code" ? "code" : "shell",
      nonce: typeof value.nonce === "string" ? value.nonce : null,
      resumeOffset: Number(value.resumeOffset) || 0,
      stdoutWritten: Number(value.stdoutWritten) || 0,
      stderrWritten: Number(value.stderrWritten) || 0,
      stdoutProduced: Number(value.stdoutProduced) || 0,
      stderrProduced: Number(value.stderrProduced) || 0,
      stdoutCapped: value.stdoutCapped === true,
      stderrCapped: value.stderrCapped === true,
      ...(value.abandoned === true ? { abandoned: true } : {})
    };
  } catch {
    return null;
  }
}

/** A log file capped like the host runner's sinks (one notice line, then everything dropped). */
class CappedLog {
  constructor(
    private readonly path: string,
    private readonly label: string,
    private readonly maxBytes: number,
    public written: number,
    public produced: number,
    public capped: boolean
  ) {}

  /** The bytes to append for `chunk` (counts updated); empty once capped. */
  take(chunk: Buffer): Buffer {
    this.produced += chunk.length;
    if (this.capped || chunk.length === 0) return Buffer.alloc(0);
    const room = this.maxBytes - this.written;
    if (chunk.length <= room) {
      this.written += chunk.length;
      return chunk;
    }
    // Cut at a UTF-8 boundary so the notice never lands inside a character.
    let cut = Math.max(0, room);
    while (cut > 0 && (chunk[cut]! & 0xc0) === 0x80) cut -= 1;
    const notice = Buffer.from(`\n[orquester] ${this.label} passed ${this.maxBytes} bytes; the rest of it was dropped.\n`, "utf8");
    this.written += cut + notice.length;
    this.capped = true;
    return Buffer.concat([chunk.subarray(0, cut), notice]);
  }

  async append(bytes: Buffer): Promise<void> {
    if (bytes.length > 0) await appendFile(this.path, bytes, { mode: 0o600 });
  }

  /** A diagnostic line (not counted as the work's output). */
  async note(line: string): Promise<void> {
    const bytes = Buffer.from(`[orquester] ${line}\n`, "utf8");
    this.written += bytes.length;
    await appendFile(this.path, bytes, { mode: 0o600 });
  }
}

/**
 * Cuts the code host's result line (`\x1eORQ-RESULT:<nonce>:<base64>\n`) out of
 * stdout. Bytes that may start the marker are held until they can be told
 * apart; `held` says how many, so the persisted reattach offset never skips
 * them.
 */
export class ResultLineFilter {
  private readonly marker: Buffer;
  private pending = Buffer.alloc(0);
  private phase: "scan" | "payload" | "done" = "scan";
  private payload: Buffer[] = [];
  private payloadBytes = 0;
  /** The result JSON, once its line is complete. */
  result: string | null = null;

  constructor(
    nonce: string,
    private readonly maxPayloadBytes: number
  ) {
    this.marker = Buffer.from(`\x1eORQ-RESULT:${nonce}:`, "utf8");
  }

  get held(): number {
    return this.pending.length + (this.phase === "payload" ? this.marker.length + this.payloadBytes : 0);
  }

  /** The bytes of `chunk` that belong in the log. */
  push(chunk: Buffer): Buffer {
    let data = this.pending.length > 0 ? Buffer.concat([this.pending, chunk]) : chunk;
    this.pending = Buffer.alloc(0);
    const out: Buffer[] = [];
    while (data.length > 0) {
      if (this.phase === "scan") {
        const at = data.indexOf(this.marker);
        if (at >= 0) {
          out.push(data.subarray(0, at));
          data = data.subarray(at + this.marker.length);
          this.phase = "payload";
          continue;
        }
        const keep = this.partialMarkerSuffix(data);
        out.push(data.subarray(0, data.length - keep));
        this.pending = Buffer.from(data.subarray(data.length - keep));
        break;
      }
      if (this.phase === "payload") {
        const newline = data.indexOf(0x0a);
        const part = newline >= 0 ? data.subarray(0, newline) : data;
        if (this.payloadBytes + part.length <= this.maxPayloadBytes) this.payload.push(Buffer.from(part));
        this.payloadBytes += part.length;
        if (newline < 0) break;
        this.complete();
        data = data.subarray(newline + 1);
        continue;
      }
      out.push(data);
      break;
    }
    return out.length === 1 ? out[0]! : Buffer.concat(out);
  }

  /** End of stream: what is still held goes to the log; a result line cut short is still read. */
  flush(): Buffer {
    if (this.phase === "payload") this.complete();
    const rest = this.pending;
    this.pending = Buffer.alloc(0);
    return rest;
  }

  private complete(): void {
    this.phase = "done";
    if (this.payloadBytes > this.maxPayloadBytes) {
      this.result = JSON.stringify({ ok: false, error: { message: "The code block's result was too large to keep." } });
      return;
    }
    const json = Buffer.from(Buffer.concat(this.payload).toString("latin1"), "base64").toString("utf8");
    try {
      JSON.parse(json);
      this.result = json;
    } catch {
      this.result = JSON.stringify({ ok: false, error: { message: "The code block's result could not be read." } });
    }
  }

  /** Length of the longest tail of `data` that is a proper prefix of the marker. */
  private partialMarkerSuffix(data: Buffer): number {
    for (let k = Math.min(data.length, this.marker.length - 1); k > 0; k -= 1) {
      if (data.subarray(data.length - k).equals(this.marker.subarray(0, k))) return k;
    }
    return 0;
  }
}

/** One box attempt the daemon is tracking (from its spawn, or adopted after a restart). */
class BoxAttempt {
  proc: BoxProcess | null = null;
  /** Bytes consumed from the stream in this daemon run (held bytes included). */
  offset: number;
  finishedDetail: SandboxExitDetail | null = null;
  timedOut = false;
  cancelled = false;
  /** A SIGTERM/SIGKILL owed to the process once the box is reachable again. */
  owedSignal: NodeJS.Signals | null = null;
  readonly stdout: CappedLog;
  readonly stderr: CappedLog;
  readonly filter: ResultLineFilter | null;
  private queue: Promise<void> = Promise.resolve();
  private resultWritten = false;
  private exitStatus: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  private reattaching = false;
  private finishing = false;
  readonly logListeners = new Set<(bytes: { stdout: number; stderr: number }) => void>();
  readonly done: Promise<SandboxExitDetail>;
  private resolveDone!: (detail: SandboxExitDetail) => void;

  constructor(
    readonly attemptDir: string,
    readonly state: BoxAttemptState,
    private readonly runner: {
      hub: BoxSandboxDeps["hub"];
      logger?: WorkflowLogger;
      /** An attempt given up while its box was away: its process is owed a SIGKILL and a release. */
      onAbandoned(state: BoxAttemptState): void;
    }
  ) {
    this.offset = state.resumeOffset;
    const maxLog = WORKFLOW_LIMITS.maxLogBytes;
    this.stdout = new CappedLog(join(attemptDir, "stdout.log"), "stdout", maxLog, state.stdoutWritten, state.stdoutProduced, state.stdoutCapped);
    this.stderr = new CappedLog(join(attemptDir, "stderr.log"), "stderr", maxLog, state.stderrWritten, state.stderrProduced, state.stderrCapped);
    // The payload is base64 of at most maxOutputBytes of JSON, plus room for an error result.
    this.filter = state.nonce ? new ResultLineFilter(state.nonce, Math.ceil((WORKFLOW_LIMITS.maxOutputBytes * 4) / 3) + 4096) : null;
    this.done = new Promise((resolve) => (this.resolveDone = resolve));
  }

  get finished(): boolean {
    return this.finishedDetail !== null;
  }

  private connection(): BoxConnection | undefined {
    const connection = this.runner.hub.get(this.state.boxId);
    return connection?.connected ? connection : undefined;
  }

  /** Consume a live stream (`startOffset` = the stream's first byte). */
  pump(proc: BoxProcess, startOffset: number): void {
    this.proc = proc;
    this.offset = startOffset;
    const onData = (which: "stdout" | "stderr") => (chunk: Buffer) => {
      if (this.proc !== proc) return;
      this.consume(which, Buffer.from(chunk));
    };
    proc.stdout.on("data", onData("stdout"));
    proc.stderr.on("data", onData("stderr"));
    proc.stdin.on("error", () => undefined);
    const streamsDone = Promise.all([
      finished(proc.stdout, { writable: false }).catch(() => undefined),
      finished(proc.stderr, { writable: false }).catch(() => undefined)
    ]);
    proc.on("exit", (code, signal) => {
      if (this.proc !== proc) return;
      this.exitStatus = { code, signal };
      void streamsDone.then(() => this.finish());
    });
    proc.on("detached", () => {
      if (this.proc === proc) this.proc = null;
    });
    proc.on("error", (error: Error) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.runner.logger?.warn("box sandbox stream failed", { attemptDir: this.attemptDir, error: error.message });
      void this.reattach();
    });
    if (this.owedSignal) this.signal(this.owedSignal);
  }

  private consume(which: "stdout" | "stderr", chunk: Buffer): void {
    this.offset += chunk.length;
    const kept = which === "stdout" && this.filter ? this.filter.push(chunk) : chunk;
    const resumeOffset = this.offset - (this.filter?.held ?? 0);
    const log = which === "stdout" ? this.stdout : this.stderr;
    const bytes = log.take(kept);
    const result = this.filter?.result ?? null;
    this.enqueue(async () => {
      await log.append(bytes);
      // The result is on disk before the offset moves past its line: a restart then finds it.
      if (result !== null && !this.resultWritten) {
        await writeJsonAtomicRaw(join(this.attemptDir, "result.json"), result);
        this.resultWritten = true;
      }
      this.state.resumeOffset = resumeOffset;
      await this.saveState();
      this.reportLogs();
    });
  }

  enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).catch((error: unknown) => {
      this.runner.logger?.warn("box sandbox log write failed", { attemptDir: this.attemptDir, error: String(error) });
    });
  }

  drain(): Promise<void> {
    return this.queue;
  }

  async saveState(): Promise<void> {
    Object.assign(this.state, {
      stdoutWritten: this.stdout.written,
      stderrWritten: this.stderr.written,
      stdoutProduced: this.stdout.produced,
      stderrProduced: this.stderr.produced,
      stdoutCapped: this.stdout.capped,
      stderrCapped: this.stderr.capped
    });
    await writeJsonAtomic(join(this.attemptDir, STATE_FILE), this.state);
  }

  reportLogs(): void {
    for (const listener of this.logListeners) {
      try {
        listener({ stdout: this.stdout.written, stderr: this.stderr.written });
      } catch {
        // a listener's problem is not the attempt's
      }
    }
  }

  /** Signal the process now, or as soon as the box is reachable. */
  signal(signal: NodeJS.Signals): void {
    if (this.finished) return;
    if (this.proc) {
      this.owedSignal = null;
      this.proc.kill(signal);
      return;
    }
    const connection = this.connection();
    if (connection) {
      this.owedSignal = null;
      void connection.request("proc.signal", { procId: this.state.procId, signal }).catch(() => {
        this.owedSignal = signal;
      });
      return;
    }
    this.owedSignal = signal;
  }

  /** SIGTERM, then SIGKILL after the grace (the host runner's cancel and timeout). */
  terminate(reason: "timeout" | "cancel", clock: Clock): void {
    if (this.finished) return;
    if (reason === "timeout") this.timedOut = true;
    else this.cancelled = true;
    this.signal("SIGTERM");
    this.graceTimer ??= clock.setTimeout(() => {
      if (!this.finished) this.signal("SIGKILL");
    }, KILL_GRACE_MS);
  }

  private graceTimer: { cancel(): void } | null = null;

  /** Re-establish the stream after a reconnect or a restart. */
  async reattach(): Promise<void> {
    if (this.finished || this.proc || this.reattaching) return;
    const connection = this.connection();
    if (!connection) return;
    this.reattaching = true;
    try {
      const procs = await connection.request("proc.list", {});
      const info = procs.find((entry) => entry.procId === this.state.procId);
      if (!info) {
        // Gone from the box without a stream to tell the end: what the daemon kept is all there is.
        await this.finishLost();
        return;
      }
      if (this.state.abandoned) {
        // Given up before (an earlier daemon run): nothing more to read; its process is reaped.
        this.runner.onAbandoned(this.state);
        await this.finishLost();
        return;
      }
      const start = Math.max(this.offset, info.bufferStart);
      if (start > this.offset) {
        const lost = start - this.offset;
        this.enqueue(() => this.stderr.note(`${lost} bytes of output were lost while the daemon was away.`));
      }
      const proc = connection.attach(this.state.procId, start);
      try {
        await waitSpawned(proc);
      } catch {
        // The box no longer has the process: what the daemon kept is all there is.
        await this.finishLost();
        return;
      }
      this.pump(proc, start);
    } catch (error) {
      this.runner.logger?.warn("box sandbox reattach failed", { attemptDir: this.attemptDir, error: String(error) });
    } finally {
      this.reattaching = false;
    }
  }

  private exitRecord(): SandboxExitDetail & Record<string, unknown> {
    return {
      code: this.exitStatus?.code ?? null,
      signal: this.exitStatus?.signal ?? null,
      timedOut: this.timedOut,
      cancelled: this.cancelled,
      endedAt: new Date().toISOString(),
      stdoutBytes: this.stdout.written,
      stderrBytes: this.stderr.written,
      stdoutProduced: this.stdout.produced,
      stderrProduced: this.stderr.produced,
      stdoutCapped: this.stdout.capped,
      stderrCapped: this.stderr.capped
    };
  }

  /** The process ended and its streams are drained: record the end like the host runner does. */
  private async finish(): Promise<void> {
    if (this.finished || this.finishing) return;
    this.finishing = true;
    const rest = this.filter?.flush();
    if (rest && rest.length > 0) {
      const bytes = this.stdout.take(rest);
      this.enqueue(() => this.stdout.append(bytes));
    }
    const result = this.filter?.result ?? null;
    await this.drain();
    if (result !== null && !this.resultWritten) {
      await writeJsonAtomicRaw(join(this.attemptDir, "result.json"), result);
      this.resultWritten = true;
    }
    const exit = this.exitRecord();
    this.state.resumeOffset = this.offset;
    await this.saveState().catch(() => undefined);
    await writeJsonAtomic(join(this.attemptDir, "exit.json"), exit);
    const connection = this.connection();
    if (connection) void connection.request("proc.release", { procId: this.state.procId }).catch(() => undefined);
    this.settle(await this.withResult(exit));
  }

  /** The process is gone and left nothing to read: interrupted, as a host runner that vanished. */
  async finishLost(): Promise<void> {
    if (this.finished || this.finishing) return;
    this.finishing = true;
    await this.drain();
    const exit: SandboxExitDetail = {
      code: null,
      signal: "SIGKILL",
      timedOut: this.timedOut,
      stdoutBytes: this.stdout.written,
      stderrBytes: this.stderr.written,
      interrupted: true,
      ...(this.cancelled ? { cancelled: true } : {})
    };
    this.settle(await this.withResult(exit));
  }

  /** Give up on a box that stays away: interrupted now, its process killed when it returns. */
  async abandon(): Promise<void> {
    if (this.finished) return;
    this.state.abandoned = true;
    await this.saveState().catch(() => undefined);
    this.runner.onAbandoned(this.state);
    await this.finishLost();
  }

  private async withResult(exit: SandboxExitDetail): Promise<SandboxExitDetail> {
    try {
      const value = JSON.parse(await readFile(join(this.attemptDir, "result.json"), "utf8")) as SandboxExitDetail["result"];
      if (value && typeof value === "object") return { ...exit, result: normalizeResult(value) ?? undefined } as SandboxExitDetail;
    } catch {
      // no result (a shell block, or a code block that never reported one)
    }
    return exit;
  }

  private settle(detail: SandboxExitDetail): void {
    this.finishedDetail = detail;
    this.graceTimer?.cancel();
    this.proc = null;
    this.resolveDone(detail);
  }
}

async function writeJsonAtomicRaw(path: string, json: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, json, { mode: 0o600 });
  await rename(tmp, path);
}

/** The result shape the executors read (the host runner's `parseResult`). */
function normalizeResult(value: unknown): SandboxExitDetail["result"] | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.stop === true) return typeof record.reason === "string" ? { stop: true, reason: record.reason } : { stop: true };
  if (record.ok === true) return { ok: true, value: record.value ?? null };
  if (record.ok === false) {
    const error = record.error as Record<string, unknown> | undefined;
    const message = typeof error?.message === "string" ? error.message : "The code block failed.";
    return typeof error?.stack === "string" ? { ok: false, error: { message, stack: error.stack } } : { ok: false, error: { message } };
  }
  return null;
}

const realClock: Clock = {
  now: () => new Date(),
  setTimeout(fn, ms) {
    const timer = setTimeout(fn, Math.max(0, Math.min(ms, 2 ** 31 - 1)));
    timer.unref?.();
    return { cancel: () => clearTimeout(timer) };
  }
};

/** The attempt's env in the box (see the module doc). Throws on a name or value no process can take. */
async function boxSandboxEnv(request: SandboxSpawnRequest, connection: BoxConnection, deps: BoxSandboxDeps, boxId: string): Promise<Record<string, string>> {
  const contribution = toolingFor(deps.tooling, boxId);
  const env: Record<string, string> = {
    TERM: "dumb",
    ...(await boxToolingEnv(connection, contribution))
  };
  for (const [name, value] of Object.entries(request.env)) {
    if (!ENV_NAME.test(name)) throw new Error(`Invalid environment variable name: ${JSON.stringify(name)}`);
    if (typeof value !== "string" || value.includes("\0")) {
      throw new Error(`The environment variable ${name} holds a value that cannot be passed to a process.`);
    }
    env[name] = value;
  }
  // The block's own NODE_OPTIONS keeps the box tooling's `--require` files (never the host preload).
  if (request.env.NODE_OPTIONS !== undefined) {
    let options: string | undefined = request.env.NODE_OPTIONS;
    for (const file of contribution.nodeRequire) options = appendNodeRequireOption(options, file);
    if (options !== undefined) env.NODE_OPTIONS = options;
  }
  env.ORQUESTER_WORKFLOW_RUN_ID = request.runId;
  env.ORQUESTER_WORKFLOW_ID = request.workflowId;
  env[AGENT_LAUNCH_ENV_VAR] = randomUUID();
  return env;
}

function clampMemoryMb(value: number | undefined): number {
  const { default: fallback, min, max } = WORKFLOW_LIMITS.codeMemoryMb;
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/** The host runner, with box projects' attempts run in their box (see the module doc). */
export function createBoxAwareSandboxRunner(host: DetailedSandboxRunner, deps: BoxSandboxDeps): DetailedSandboxRunner {
  const clock = deps.clock ?? realClock;
  const attempts = new Map<string, BoxAttempt>();
  /**
   * Processes of attempts given up while their box was away (boxId → procIds). An abandoned
   * attempt is settled at once, so it leaves `attempts`; its process stays here until the box is
   * back and it is SIGKILLed, seen to exit and released — or the box is destroyed.
   */
  const abandoned = new Map<string, Set<string>>();
  /** The reap running per box, and the boxes asked again meanwhile (a reconnect during one). */
  const reaping = new Map<string, Promise<void>>();
  const reapAgain = new Set<string>();

  /** SIGKILL a detached process, wait for its exit, release it. True once nothing of it is left. */
  const killAndRelease = async (connection: BoxConnection, procId: string): Promise<boolean> => {
    try {
      const info = (await connection.request("proc.list", {})).find((entry) => entry.procId === procId);
      if (!info) return true;
      if (info.running) {
        // Attached at the end of its output: only its exit is wanted.
        const proc = connection.attach(procId, info.outputBytes);
        const exited = new Promise<boolean>((resolve) => {
          proc.once("exit", () => resolve(true));
          proc.on("detached", () => resolve(false));
          proc.once("error", () => resolve(false));
        });
        proc.stdout.resume();
        proc.stderr.resume();
        proc.stdin.on("error", () => undefined);
        proc.kill("SIGKILL");
        if (!(await exited)) return false;
      }
      await connection.request("proc.release", { procId });
      return true;
    } catch (error) {
      deps.logger?.warn("box sandbox could not end an abandoned attempt", { procId, error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  };

  /**
   * End the abandoned processes of a connected box; what fails stays owed for its next connect.
   * One reap per box at a time: asked again while one runs (the link dropped and came back
   * mid-kill), it runs once more after it.
   */
  const reap = (boxId: string): Promise<void> => {
    const running = reaping.get(boxId);
    if (running) {
      reapAgain.add(boxId);
      return running;
    }
    const run = (async () => {
      const owed = abandoned.get(boxId);
      const connection = deps.hub.get(boxId);
      if (!owed || !connection?.connected) return;
      await Promise.all(
        [...owed].map(async (procId) => {
          if (await killAndRelease(connection, procId)) owed.delete(procId);
        })
      );
      if (owed.size === 0 && abandoned.get(boxId) === owed) abandoned.delete(boxId);
    })().finally(() => {
      reaping.delete(boxId);
      if (reapAgain.delete(boxId)) void reap(boxId);
    });
    reaping.set(boxId, run);
    return run;
  };

  const runnerContext = {
    hub: deps.hub,
    ...(deps.logger ? { logger: deps.logger } : {}),
    onAbandoned: (state: BoxAttemptState): void => {
      const owed = abandoned.get(state.boxId) ?? new Set<string>();
      owed.add(state.procId);
      abandoned.set(state.boxId, owed);
      void reap(state.boxId);
    }
  };

  const isBoxAttempt = (attemptDir: string): boolean => existsSync(join(attemptDir, STATE_FILE));

  const forBox = (boxId: string): BoxAttempt[] => [...attempts.values()].filter((attempt) => attempt.state.boxId === boxId);

  deps.hub.onConnectionChange((boxId, connected) => {
    if (connected) void reap(boxId);
    for (const attempt of forBox(boxId)) {
      if (connected) void attempt.reattach();
      else attempt.proc = null;
    }
  });
  deps.registry.onChange((boxId) => {
    const record = deps.registry.get(boxId);
    if (record && record.state !== "destroyed") return;
    // A destroyed box took its processes with it.
    abandoned.delete(boxId);
    for (const attempt of forBox(boxId)) void attempt.finishLost();
  });

  /** The in-memory attempt for a box attempt dir, adopting it from `box.json` after a restart. */
  const attemptFor = (attemptDir: string): BoxAttempt | null => {
    const known = attempts.get(attemptDir);
    if (known) return known;
    const state = readState(attemptDir);
    if (!state) return null;
    const attempt = new BoxAttempt(attemptDir, state, runnerContext);
    attempts.set(attemptDir, attempt);
    void attempt.done.then(() => attempts.delete(attemptDir));
    return attempt;
  };

  const spawnInBox = async (request: SandboxSpawnRequest, connection: BoxConnection, boxId: string): Promise<SandboxHandle> => {
    const attemptDir = request.attemptDir;
    await mkdir(attemptDir, { recursive: true, mode: 0o700 });
    // A reused directory must not hand a new wait an old ending.
    await Promise.all(
      ["exit.json", "result.json", "child.json", "handle.json", "runner.json", STATE_FILE].map((name) => rm(join(attemptDir, name), { force: true }))
    );
    const env = await boxSandboxEnv(request, connection, deps, boxId);
    const deadlineAt = clock.now().getTime() + Math.max(0, request.timeoutMs);
    const state: BoxAttemptState = {
      version: 1,
      boxId,
      procId: `wf-${randomUUID()}`,
      kind: request.kind,
      nonce: request.kind === "code" ? randomBytes(18).toString("base64url") : null,
      resumeOffset: 0,
      stdoutWritten: 0,
      stderrWritten: 0,
      stdoutProduced: 0,
      stderrProduced: 0,
      stdoutCapped: false,
      stderrCapped: false
    };
    const [stdoutSize, stderrSize] = await Promise.all(
      ["stdout.log", "stderr.log"].map((name) => stat(join(attemptDir, name)).then((s) => s.size, () => 0))
    );
    state.stdoutWritten = stdoutSize ?? 0;
    state.stderrWritten = stderrSize ?? 0;
    // On disk BEFORE the process exists: a restart in between finds the attempt by its procId
    // (`handle.json` too, which a resume in the `spawning` window reads; its pid is a placeholder
    // until the box reports one — a box attempt is never identified by a host pid).
    await writeJsonAtomic(join(attemptDir, STATE_FILE), state);
    await writeJsonAtomic(join(attemptDir, "handle.json"), { pid: 1, starttime: BOX_SANDBOX_STARTTIME, attemptDir });

    const cwd = hostToBoxPath(connection.paths, request.cwd);
    let command: string;
    let args: string[];
    let input: string | null = null;
    if (request.kind === "code") {
      command = "node";
      args = [`--max-old-space-size=${clampMemoryMb(request.memoryMb)}`, "--input-type=module", "-e", boxCodeHostSource()];
      // Secrets and the module travel on stdin only — nothing of them is written in the box.
      input = JSON.stringify({
        nonce: state.nonce,
        source: request.source,
        context: request.input ?? {},
        projectPath: hostToBoxPath(connection.paths, request.projectPath),
        maxOutputBytes: WORKFLOW_LIMITS.maxOutputBytes,
        deadlineAt
      });
    } else {
      command = request.shell === "sh" ? "sh" : "bash";
      args = ["-c", request.source];
    }

    const attempt = new BoxAttempt(attemptDir, state, runnerContext);
    attempts.set(attemptDir, attempt);
    void attempt.done.then(() => attempts.delete(attemptDir));
    let proc: BoxProcess;
    try {
      proc = connection.exec({ command, args, cwd, env, detach: { procId: state.procId, bufferBytes: DETACH_BUFFER_BYTES } });
      await waitSpawned(proc);
    } catch (error) {
      attempts.delete(attemptDir);
      await Promise.all([STATE_FILE, "handle.json"].map((name) => rm(join(attemptDir, name), { force: true })));
      const code = (error as { code?: unknown }).code;
      if (code === "ENOENT" && request.kind === "code") throw new Error("Node.js is not installed in the box (code blocks run with `node` there).");
      if (code === "ENOENT") throw new Error(`\`${command}\` is not installed in the box.`);
      throw error;
    }
    attempt.pump(proc, 0);
    if (input !== null) proc.stdin.end(input);
    else proc.stdin.end();

    const handle: SandboxHandle = { pid: proc.pid && proc.pid > 0 ? proc.pid : 1, starttime: BOX_SANDBOX_STARTTIME, attemptDir };
    await writeJsonAtomic(join(attemptDir, "handle.json"), handle);
    deps.logger?.debug("box sandbox attempt started", { boxId, attemptDir, kind: request.kind });
    return handle;
  };

  const waitBox = (attempt: BoxAttempt, opts: Parameters<DetailedSandboxRunner["wait"]>[1]): Promise<SandboxExitDetail> => {
    if (attempt.finishedDetail) return Promise.resolve(attempt.finishedDetail);
    const onLogs = opts.onLogs;
    if (onLogs) attempt.logListeners.add(onLogs);
    const timers: { cancel(): void }[] = [];
    const onAbort = (): void => attempt.terminate("cancel", clock);
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
    const untilDeadline = opts.deadlineAt.getTime() - clock.now().getTime();
    timers.push(clock.setTimeout(() => attempt.terminate("timeout", clock), Math.max(0, untilDeadline)));
    // A box that stays away cannot be signalled: past the deadline and the grace, give it up.
    timers.push(
      clock.setTimeout(() => {
        if (!attempt.finished && !attempt.proc) void attempt.abandon();
      }, Math.max(0, untilDeadline) + KILL_GRACE_MS + DEADLINE_BACKSTOP_MS)
    );
    void attempt.reattach();
    return attempt.done.then((detail) => {
      for (const timer of timers) timer.cancel();
      opts.signal.removeEventListener("abort", onAbort);
      if (onLogs) attempt.logListeners.delete(onLogs);
      return detail;
    });
  };

  return {
    async spawn(request) {
      const location = deps.registry.locate(request.projectPath);
      if (location.kind === "host") return host.spawn(request);
      // Rejects with the registry's BOX_NOT_READY while the box is away: the block fails to start.
      const connection = await deps.registry.requireConnected(request.projectPath);
      if (!connection) return host.spawn(request);
      return spawnInBox(request, connection, location.boxId);
    },

    async wait(handle, opts) {
      if (!isBoxAttempt(handle.attemptDir)) return host.wait(handle, opts);
      const live = attempts.get(handle.attemptDir);
      // Ended (while the daemon was down, or before this wait), its record written: nothing to wait for.
      if (!live && existsSync(join(handle.attemptDir, "exit.json"))) {
        const exit = await host.readExit(handle.attemptDir);
        if (exit) return exit;
      }
      const attempt = live ?? attemptFor(handle.attemptDir);
      if (!attempt) return host.wait(handle, opts);
      return waitBox(attempt, opts);
    },

    isAlive(handle) {
      if (!isBoxAttempt(handle.attemptDir)) return host.isAlive(handle);
      const attempt = attempts.get(handle.attemptDir);
      if (attempt) return !attempt.finished;
      if (existsSync(join(handle.attemptDir, "exit.json"))) return false;
      const state = readState(handle.attemptDir);
      if (!state || state.abandoned) return false;
      const record = deps.registry.get(state.boxId);
      // Unknown until the box answers: `wait` reattaches (or gives up at the deadline).
      return record !== undefined && record.state !== "destroyed";
    },

    readHandle: (attemptDir) => host.readHandle(attemptDir),
    readExit: (attemptDir) => host.readExit(attemptDir),

    async kill(handle) {
      if (!isBoxAttempt(handle.attemptDir)) return host.kill(handle);
      const attempt = attemptFor(handle.attemptDir);
      if (!attempt || attempt.finished) return;
      attempt.terminate("cancel", clock);
      void attempt.reattach();
      // Bounded like the host runner's kill: the grace, then a moment for the SIGKILL.
      await Promise.race([
        attempt.done,
        new Promise<void>((resolve) => {
          clock.setTimeout(resolve, KILL_GRACE_MS + 2_000);
        })
      ]);
    }
  };
}
