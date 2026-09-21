/**
 * Agent host — the ref-counted `opencode serve` pool (spec §3.2, §4.5).
 *
 * Ported from T3 Code (MIT): `apps/server/src/provider/opencodeRuntime.ts`
 * (`startOpenCodeServerProcess`, the readiness scrape, the group kill) and
 * `apps/server/src/provider/OpenCodeServerOwner.ts` (the refcount + idle
 * close), translated from Effect into plain promises.
 *
 * **This is where Orquester deliberately differs from T3** (§3.2): T3 runs one
 * chat server *per thread*; this pool runs **one per project**, shared by that
 * project's threads. The divergence holds on exactly two invariants, and both
 * are enforced elsewhere in this directory:
 *   1. chat sessions register nothing thread-scoped into the server (no MCP
 *      connection — the daemon's `/mcp` server is out of scope, §2); and
 *   2. an automatic approval is a one-shot `once` grant, never a persisted
 *      `always` (`normalize.ts`, `openPermission`), because OpenCode stores
 *      `always` per **directory** and fixture 04 proves a grant made in one
 *      session silences the ask in a brand-new one.
 *
 * Two things the fixtures corrected:
 * - **`--port 0` does not mean ephemeral.** It binds the well-known **4096**
 *   when free (fixtures README observation 2), where a co-tenant `opencode`
 *   TUI could already be listening and would then answer this daemon's health
 *   check. The port comes from an ephemeral-port probe **and** the real URL is
 *   read off stdout — both halves are mandatory.
 * - **`/global/health` is behind the auth gate** (observation 20), so the
 *   post-start version check already carries the credential.
 */

import { createServer } from "node:net";
import { randomBytes } from "node:crypto";

import type { AdapterLogger } from "../../adapter.ts";
import { AGENT_HOST_DEADLINES, withDeadline } from "../../support/deadline.ts";
import { StderrCapture, type ClassifiedStderrLine } from "../../support/stderr.ts";
import {
  describeExit,
  spawnProviderChild,
  type ChildExitReason,
  type ProviderChild
} from "../../support/spawn.ts";
import { OpenCodeClient } from "./http.ts";
import { meetsMinimumOpenCodeVersion, tooOldMessage } from "./semver.ts";

/** T3's ready prefix; the scrape stays **line-oriented** (observation 1). */
export const OPENCODE_SERVER_READY_PREFIX = "opencode server listening";
const READY_URL_RE = /on\s+(https?:\/\/[^\s]+)/;
/** Startup output is capped, then discarded while the pipes keep draining. */
const STARTUP_CAPTURE_MAX_CHARS = 64 * 1024;
/** How long a project's server survives its last thread (T3's 30 s). */
export const SERVER_IDLE_CLOSE_MS = 30_000;

/**
 * Scrape the readiness URL out of accumulated stdout. Line-oriented on
 * purpose: without a server password the readiness line is preceded by
 * `Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.` on the
 * same stream, and a whole-buffer regex would happily match inside it.
 */
export function parseServerUrl(output: string): string | null {
  for (const line of output.split("\n")) {
    if (!line.startsWith(OPENCODE_SERVER_READY_PREFIX)) {
      continue;
    }
    const match = READY_URL_RE.exec(line);
    return match?.[1] ?? null;
  }
  return null;
}

/** Bind :0, read the assigned port, release it. */
export async function probeFreePort(host: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen({ host, port: 0, exclusive: true }, () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close(() => reject(new Error("could not read a probed port")));
        return;
      }
      const port = address.port;
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

export interface OpenCodeHealth {
  healthy: boolean;
  version: string;
}

export interface OpenCodeServerHandle {
  readonly url: string;
  readonly version: string;
  readonly serverPassword: string | undefined;
  readonly projectDir: string;
  readonly pid: number | undefined;
  /** A client for this server scoped to `directory`. */
  client(directory: string, signal?: AbortSignal): OpenCodeClient;
  /** Resolves when the child exits, whatever the reason. */
  readonly exited: Promise<ChildExitReason>;
  readonly hasExited: () => boolean;
  /** Drop one reference. The server closes shortly after the last one. */
  release(): void;
}

export interface OpenCodeServerPoolOptions {
  logger: AdapterLogger;
  /** Absolute path to the resolved `opencode` binary. */
  resolveBin: () => Promise<string>;
  /** `support/env.ts`'s output, per project. */
  buildEnv: (input: { projectDir: string }) => Record<string, string>;
  /** Host shutdown. */
  signal: AbortSignal;
  /** Surfaced as `runtime.warning` / `runtime.error` on the owning thread. */
  onStderr?: (projectDir: string, line: ClassifiedStderrLine) => void;
  hostname?: string;
  idleCloseMs?: number;
  /** Test seam; `undefined` means "generate one". */
  serverPassword?: string | null;
  fetchImpl?: typeof fetch;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

interface PoolEntry {
  projectDir: string;
  refs: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  starting?: Promise<Started>;
  started?: Started;
  closing?: Promise<void>;
}

interface Started {
  url: string;
  version: string;
  serverPassword: string | undefined;
  child: ProviderChild;
}

/**
 * One `opencode serve` per project directory, ref-counted by its threads and
 * torn down shortly after the last one closes — so a project nobody is working
 * in holds no process (§3.2).
 */
export class OpenCodeServerPool {
  private readonly entries = new Map<string, PoolEntry>();
  private readonly options: OpenCodeServerPoolOptions;
  private readonly hostname: string;
  private readonly idleCloseMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;

  constructor(options: OpenCodeServerPoolOptions) {
    this.options = options;
    this.hostname = options.hostname ?? "127.0.0.1";
    this.idleCloseMs = options.idleCloseMs ?? SERVER_IDLE_CLOSE_MS;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
  }

  /**
   * Take a reference to this project's server, starting it if nobody holds
   * one. Concurrent acquires for the same project collapse onto one start.
   */
  async acquire(projectDir: string): Promise<OpenCodeServerHandle> {
    if (this.options.signal.aborted) {
      throw new Error("agent host is shutting down");
    }
    let entry = this.entries.get(projectDir);
    if (entry === undefined) {
      entry = { projectDir, refs: 0 };
      this.entries.set(projectDir, entry);
    }
    if (entry.idleTimer !== undefined) {
      this.clearTimer(entry.idleTimer);
      entry.idleTimer = undefined;
    }
    // A server whose child died while parked must not be handed out again.
    if (entry.started !== undefined && entry.started.child.hasExited()) {
      entry.started = undefined;
      entry.starting = undefined;
    }
    entry.refs += 1;
    try {
      if (entry.started === undefined) {
        entry.starting ??= this.start(projectDir).finally(() => {
          if (this.entries.get(projectDir) === entry) {
            entry.starting = undefined;
          }
        });
        entry.started = await entry.starting;
      }
      return this.handle(entry, entry.started);
    } catch (error) {
      entry.refs -= 1;
      if (entry.refs <= 0 && entry.started === undefined) {
        this.entries.delete(projectDir);
      }
      throw error;
    }
  }

  /** Every live server, for the host's own diagnostics. */
  list(): { projectDir: string; url: string; version: string; pid: number | undefined }[] {
    const out: { projectDir: string; url: string; version: string; pid: number | undefined }[] = [];
    for (const entry of this.entries.values()) {
      if (entry.started !== undefined) {
        out.push({
          projectDir: entry.projectDir,
          url: entry.started.url,
          version: entry.started.version,
          pid: entry.started.child.pid
        });
      }
    }
    return out;
  }

  /** Stop every server now, regardless of refcount (host shutdown). */
  async stopAll(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(
      entries.map(async (entry) => {
        if (entry.idleTimer !== undefined) {
          this.clearTimer(entry.idleTimer);
        }
        const started = entry.started ?? (await entry.starting?.catch(() => undefined));
        if (started !== undefined) {
          await started.child.kill();
        }
      })
    );
  }

  private handle(entry: PoolEntry, started: Started): OpenCodeServerHandle {
    let released = false;
    const pool = this;
    return {
      url: started.url,
      version: started.version,
      serverPassword: started.serverPassword,
      projectDir: entry.projectDir,
      pid: started.child.pid,
      exited: started.child.exited,
      hasExited: () => started.child.hasExited(),
      client(directory: string, signal?: AbortSignal): OpenCodeClient {
        return new OpenCodeClient({
          baseUrl: started.url,
          directory,
          ...(started.serverPassword !== undefined
            ? { serverPassword: started.serverPassword }
            : {}),
          signal: signal ?? pool.options.signal,
          ...(pool.options.fetchImpl !== undefined ? { fetchImpl: pool.options.fetchImpl } : {})
        });
      },
      release(): void {
        if (released) {
          return;
        }
        released = true;
        pool.release(entry);
      }
    };
  }

  private release(entry: PoolEntry): void {
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs > 0 || entry.idleTimer !== undefined) {
      return;
    }
    entry.idleTimer = this.setTimer(() => {
      entry.idleTimer = undefined;
      if (entry.refs > 0 || this.entries.get(entry.projectDir) !== entry) {
        return;
      }
      this.entries.delete(entry.projectDir);
      const started = entry.started;
      entry.started = undefined;
      if (started !== undefined) {
        // SIGTERM to the process GROUP, then SIGKILL on the grace deadline —
        // `opencode serve` is a bun binary that spawns its own children.
        void started.child.kill().catch(() => undefined);
      }
    }, this.idleCloseMs);
    entry.idleTimer.unref?.();
  }

  private async start(projectDir: string): Promise<Started> {
    const bin = await this.options.resolveBin();
    const port = await probeFreePort(this.hostname);
    const password =
      this.options.serverPassword === null
        ? undefined
        : (this.options.serverPassword ?? randomBytes(24).toString("base64url"));

    const env = this.options.buildEnv({ projectDir });
    // `extendEnv` has no analogue here — `buildProviderEnv` never spreads
    // `process.env` — so both variables are set explicitly. `{}` is only a
    // fallback: setting `OPENCODE_CONFIG_CONTENT` unconditionally clobbers the
    // user's own config and hides their providers (§4.5).
    const configContent =
      env.OPENCODE_CONFIG_CONTENT ?? process.env.OPENCODE_CONFIG_CONTENT ?? "{}";
    const childEnv: Record<string, string> = {
      ...env,
      OPENCODE_CONFIG_CONTENT: configContent,
      ...(password !== undefined ? { OPENCODE_SERVER_PASSWORD: password } : {})
    };

    const child = spawnProviderChild({
      command: bin,
      args: ["serve", `--hostname=${this.hostname}`, `--port=${port}`],
      env: childEnv,
      cwd: projectDir,
      // The whole process group is what a kill must signal (§3.1).
      detached: true
    });

    const stderr = new StderrCapture({ homeDirs: [childEnv.HOME ?? ""] });
    let stdoutCapture: string | null = "";
    let readyUrl: string | null = null;
    let resolveReady: ((url: string) => void) | undefined;
    let rejectReady: ((error: Error) => void) | undefined;
    const ready = new Promise<string>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdoutCapture === null) {
        return;
      }
      stdoutCapture = `${stdoutCapture}${chunk}`.slice(-STARTUP_CAPTURE_MAX_CHARS);
      if (readyUrl !== null) {
        return;
      }
      const parsed = parseServerUrl(stdoutCapture);
      if (parsed !== null) {
        readyUrl = parsed;
        resolveReady?.(parsed);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      for (const line of stderr.push(chunk)) {
        if (line.class !== "drop") {
          this.options.onStderr?.(projectDir, line);
        }
      }
    });

    void child.exited.then((reason) => {
      if (readyUrl === null) {
        const tail = stderr.excerpt().trim();
        rejectReady?.(
          new Error(
            `OpenCode server ${describeExit(reason)} before startup completed${
              tail.length > 0 ? `:\n${tail}` : "."
            }`
          )
        );
      }
    });

    let url: string;
    try {
      url = await withDeadline(ready, {
        label: "opencode serve readiness",
        timeoutMs: AGENT_HOST_DEADLINES.handshakeMs,
        onTimeout: () => void child.kill().catch(() => undefined),
        signal: this.options.signal
      });
    } catch (error) {
      await child.kill().catch(() => undefined);
      throw error;
    }

    // Startup output is no longer needed, but the readers must keep draining:
    // stopping them blocks OpenCode once its output buffers fill (§4.5).
    stdoutCapture = null;

    const client = new OpenCodeClient({
      baseUrl: url,
      directory: projectDir,
      ...(password !== undefined ? { serverPassword: password } : {}),
      signal: this.options.signal,
      ...(this.options.fetchImpl !== undefined ? { fetchImpl: this.options.fetchImpl } : {})
    });

    let version: string;
    try {
      version = await verifyServerVersion(client);
    } catch (error) {
      await child.kill().catch(() => undefined);
      throw error;
    }

    this.options.logger.info("opencode server ready", {
      projectDir,
      url,
      version,
      pid: child.pid
    });

    return { url, version, serverPassword: password, child };
  }
}

/**
 * `GET /global/health` must answer `{healthy:true, version}` within 5 s and
 * satisfy the §4.1 minimum. The check runs against the **server**, not only
 * the binary, because an already-running server can be older than the
 * `opencode` on PATH (§3.2).
 */
export async function verifyServerVersion(client: OpenCodeClient): Promise<string> {
  const health = await client.get<Partial<OpenCodeHealth>>("/global/health", {
    label: "opencode global.health",
    timeoutMs: AGENT_HOST_DEADLINES.healthMs
  });
  if (health?.healthy !== true || typeof health.version !== "string") {
    throw new Error(
      `OpenCode server returned an invalid health response. ${tooOldMessage(null)}`
    );
  }
  if (!meetsMinimumOpenCodeVersion(health.version)) {
    throw new Error(tooOldMessage(health.version));
  }
  return health.version;
}
