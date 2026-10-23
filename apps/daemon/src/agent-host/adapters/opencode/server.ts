/**
 * Agent host — the ref-counted `opencode serve` pool (spec §3.2, §4.5).
 *
 * Ported from T3 Code (MIT): `apps/server/src/provider/opencodeRuntime.ts`
 * (`startOpenCodeServerProcess`, the readiness scrape, the group kill) and
 * `apps/server/src/provider/OpenCodeServerOwner.ts` (the refcount + idle
 * close), translated from Effect into plain promises.
 *
 * **This is where Orquester deliberately differs from T3** (§3.2): T3 runs one
 * chat server *per thread*; this pool runs **one per (project, pool key)**,
 * shared by the threads that name that pair. The key is
 * {@link OPENCODE_GLOBAL_POOL_KEY} unless a thread's launch config names
 * another one ({@link OpenCodeServerPoolSpec}): an opaque string plus env
 * overrides applied only to that server — `opencode serve` reads its config
 * once, at start, so a different config needs a different process (agent
 * profiles design §6.4). The divergence from T3 holds on exactly two
 * invariants, and both are enforced elsewhere in this directory:
 *   1. a thread-scoped registration never lets one thread act as another.
 *      The only one is the session-tool server (design 2026-10-14 §1.2,
 *      `session-tools.ts`): each thread registers its OWN `orquester-<key>`
 *      MCP server, and each thread's session permission ruleset hides every
 *      other thread's (OpenCode drops a tool whose last matching rule is a
 *      `*` deny) — so co-tenant threads neither replace nor reach each
 *      other's connection; and
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
import { ProviderLeftovers } from "../../support/provider-leftovers.ts";
import { OpenCodeClient } from "./http.ts";
import { meetsMinimumOpenCodeVersion, tooOldMessage } from "./semver.ts";
// boxes:
import type { BoxHostForward } from "../../../boxes/contracts.ts";
import { mergeOpenCodeConfigContent, type OpenCodeBoxServer } from "./box-launch.ts";

/**
 * The pool key of the server every thread without a pool spec shares: the
 * project's launcher env exactly as before keyed pools existed. Reserved — a
 * spec may not name it.
 */
export const OPENCODE_GLOBAL_POOL_KEY = "global";

/**
 * Variables a pool spec may neither set nor unset: the host decides PATH,
 * TMPDIR and HOME for every provider child (`support/env.ts`), and the server
 * password is minted per start.
 */
const POOL_RESERVED_ENV = new Set(["PATH", "TMPDIR", "HOME", "OPENCODE_SERVER_PASSWORD"]);

/**
 * A keyed server: which `opencode serve` of a project a thread runs on, and
 * the env that server starts with on top of the project's launcher env.
 *
 * `key` is opaque to the pool — two threads naming the same key in the same
 * project share one server, so a key must always stand for the same `env` /
 * `unsetEnv` (the acquire that STARTS the server decides them; a later acquire
 * with a different env gets the running server and a warning). `unsetEnv` is
 * removed first, then `env` is layered over what is left.
 */
export interface OpenCodeServerPoolSpec {
  key: string;
  env?: Readonly<Record<string, string>>;
  unsetEnv?: readonly string[];
}

interface ResolvedPoolSpec {
  key: string;
  env: Readonly<Record<string, string>>;
  unsetEnv: readonly string[];
  /** Order-independent identity of `env` + `unsetEnv`, to spot a key reused with another env. */
  fingerprint: string;
}

const GLOBAL_POOL: ResolvedPoolSpec = {
  key: OPENCODE_GLOBAL_POOL_KEY,
  env: {},
  unsetEnv: [],
  fingerprint: "[[],[]]"
};

/**
 * Validate a caller's spec. Refused rather than repaired: a spec the pool
 * cannot apply as written would run the thread on a server with a different
 * config than its owner asked for, silently.
 */
function resolvePoolSpec(spec: OpenCodeServerPoolSpec | undefined): ResolvedPoolSpec {
  if (spec === undefined) {
    return GLOBAL_POOL;
  }
  if (typeof spec.key !== "string" || spec.key.length === 0) {
    throw new Error("An OpenCode server pool key must be a non-empty string.");
  }
  if (spec.key === OPENCODE_GLOBAL_POOL_KEY) {
    throw new Error(`The OpenCode server pool key '${OPENCODE_GLOBAL_POOL_KEY}' is reserved.`);
  }
  const env = { ...spec.env };
  const unsetEnv = [...new Set(spec.unsetEnv ?? [])];
  for (const name of [...Object.keys(env), ...unsetEnv]) {
    if (name.length === 0 || POOL_RESERVED_ENV.has(name)) {
      throw new Error(`An OpenCode server pool may not override '${name}'.`);
    }
  }
  const fingerprint = JSON.stringify([
    Object.entries(env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    [...unsetEnv].sort()
  ]);
  return { key: spec.key, env, unsetEnv, fingerprint };
}

/** The pool's map key for one server. NUL cannot occur in a path. */
function serverKey(projectDir: string, poolKey: string): string {
  return `${projectDir}\u0000${poolKey}`;
}

/** T3's ready prefix; the scrape stays **line-oriented** (observation 1). */
const OPENCODE_SERVER_READY_PREFIX = "opencode server listening";
const READY_URL_RE = /on\s+(https?:\/\/[^\s]+)/;
/** Startup output is capped, then discarded while the pipes keep draining. */
const STARTUP_CAPTURE_MAX_CHARS = 64 * 1024;
/** How long a project's server survives its last thread (T3's 30 s). */
const SERVER_IDLE_CLOSE_MS = 30_000;
/**
 * §4.5: "SIGTERM to the **process group**, 1 s, then SIGKILL". `spawn.ts`
 * defaults to 2 s, which doubles teardown latency on host shutdown.
 */
const OPENCODE_KILL_GRACE_MS = 1_000;

/**
 * Scrape the readiness URL out of accumulated stdout. Line-oriented on
 * purpose: without a server password the readiness line is preceded by
 * `Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.` on the
 * same stream, and a whole-buffer regex would happily match inside it.
 */
function parseServerUrl(output: string): string | null {
  for (const line of output.split("\n")) {
    if (!line.startsWith(OPENCODE_SERVER_READY_PREFIX)) {
      continue;
    }
    const match = READY_URL_RE.exec(line);
    return match?.[1] ?? null;
  }
  return null;
}

/**
 * Keep the tail under `maxChars` without ever cutting inside a line: drop
 * whole leading lines until it fits.
 */
function trimToLastLines(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  let start = text.length - maxChars;
  const newline = text.indexOf("\n", start);
  // No newline left in the tail: keep the tail as-is rather than everything.
  start = newline === -1 ? start : newline + 1;
  return text.slice(start);
}

/** Bind :0, read the assigned port, release it. */
async function probeFreePort(host: string): Promise<number> {
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

interface OpenCodeHealth {
  healthy: boolean;
  version: string;
}

export interface OpenCodeServerHandle {
  readonly url: string;
  readonly version: string;
  readonly projectDir: string;
  /** {@link OPENCODE_GLOBAL_POOL_KEY} or the spec's key this server was acquired under. */
  readonly poolKey: string;
  readonly pid: number | undefined;
  /** A client for this server scoped to `directory`. */
  client(directory: string, signal?: AbortSignal): OpenCodeClient;
  /** Resolves when the child exits, whatever the reason. */
  readonly exited: Promise<ChildExitReason>;
  readonly hasExited: () => boolean;
  /** Drop one reference. The server closes shortly after the last one. */
  release(): void;
}

interface OpenCodeServerPoolOptions {
  logger: AdapterLogger;
  /** Absolute path to the resolved `opencode` binary. */
  resolveBin: () => Promise<string>;
  /**
   * `support/env.ts`'s output, per project: the launcher env every server of
   * the project starts from. A keyed server's spec is applied on top by the
   * pool, so this never needs to know about keys.
   */
  buildEnv: (input: { projectDir: string; poolKey: string }) => Record<string, string>;
  /** Host shutdown. */
  signal: AbortSignal;
  /** Surfaced as `runtime.warning` / `runtime.error` on the owning thread. */
  onStderr?: (projectDir: string, line: ClassifiedStderrLine, poolKey: string) => void;
  /**
   * A reference to this server was dropped. The adapter re-checks a recycle
   * it had to defer (agent profile §4.8): a snapshot probe holding the server
   * is in-flight work too.
   */
  onRelease?: (projectDir: string, poolKey: string) => void;
}

interface PoolEntry {
  projectDir: string;
  /** `serverKey(projectDir, spec.key)`: this entry's key in `entries`. */
  id: string;
  spec: ResolvedPoolSpec;
  /** boxes: the project runs in a box — its server does too (the acquire that starts it decides). */
  box?: OpenCodeBoxServer;
  refs: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  starting?: Promise<Started>;
  started?: Started;
  closing?: Promise<void>;
}

interface Started {
  url: string;
  version: string;
  serverPassword: string;
  child: ProviderChild;
}

/**
 * One `opencode serve` per (project directory, pool key), ref-counted by its
 * threads and torn down shortly after the last one closes — so a project
 * nobody is working in holds no process (§3.2). Two keys of one project are
 * two independent servers: their own refcount, idle close, crash handling,
 * recycle and retirement. Every query below takes the key and defaults to
 * {@link OPENCODE_GLOBAL_POOL_KEY}, so a caller that knows nothing of keys
 * sees exactly the per-project pool it always did.
 */
export class OpenCodeServerPool {
  private readonly entries = new Map<string, PoolEntry>();
  /**
   * The server stops `stopAll` started and that have not settled, so every
   * call waits for all of them: the host's teardown calls the adapter's
   * `stopAll()` twice (its abort listener, then its own `stop()`), and the
   * second pool stop used to find the entries cleared and return while the
   * first one's kills were still in their SIGTERM grace — the host could
   * exit before a `serve` that ignored SIGTERM got its SIGKILL (final review
   * A r1, m4).
   */
  private readonly stopping = new Set<Promise<void>>();
  /**
   * Agent profile §4.8: a recycled server's stop, per (project, key), until
   * its child is gone. That server's next start waits for it, so one key never
   * has two `opencode serve` of its own config running at once. (Servers of
   * DIFFERENT keys do share the data directory concurrently, by design: that
   * is what lets a session move between them, verified on 1.18.34.)
   */
  private readonly retiring = new Map<string, Promise<void>>();
  private readonly options: OpenCodeServerPoolOptions;
  private readonly hostname = "127.0.0.1";

  constructor(options: OpenCodeServerPoolOptions) {
    this.options = options;
  }

  /**
   * Take a reference to this project's server for `pool`'s key (the global
   * server when omitted), starting it if nobody holds one. Concurrent acquires
   * for the same (project, key) collapse onto one start.
   */
  async acquire(projectDir: string, pool?: OpenCodeServerPoolSpec, box?: OpenCodeBoxServer): Promise<OpenCodeServerHandle> {
    if (this.options.signal.aborted) {
      throw new Error("agent host is shutting down");
    }
    const spec = resolvePoolSpec(pool);
    const id = serverKey(projectDir, spec.key);
    let entry = this.entries.get(id);
    if (entry === undefined) {
      entry = { projectDir, id, spec, refs: 0, ...(box !== undefined ? { box } : {}) };
      this.entries.set(id, entry);
    } else if (box !== undefined && entry.started === undefined && entry.starting === undefined) {
      // boxes: a server that is not running starts with the latest launch's pieces.
      entry.box = box;
    } else if (entry.spec.fingerprint !== spec.fingerprint) {
      // Keys are the caller's promise of one env; keep the running server
      // (its threads depend on it) and say so rather than guess.
      this.options.logger.warn("opencode server pool key reused with a different env", {
        projectDir,
        poolKey: spec.key
      });
    }
    if (entry.idleTimer !== undefined) {
      clearTimeout(entry.idleTimer);
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
        entry.starting ??= this.start(entry).finally(() => {
          if (this.entries.get(id) === entry) {
            entry.starting = undefined;
          }
        });
        entry.started = await entry.starting;
      }
      return this.handle(entry, entry.started);
    } catch (error) {
      entry.refs -= 1;
      if (entry.refs <= 0 && entry.started === undefined && this.entries.get(id) === entry) {
        this.entries.delete(id);
      }
      throw error;
    }
  }

  /**
   * Is this project's server already warm? Never starts one.
   *
   * The snapshot probe uses this to stay inside the host's budget: a cold
   * start plus the ~4.3 MB catalogue read cannot finish in 10 s, while the
   * same read against a warm server takes ~474 ms.
   */
  isWarm(projectDir: string, poolKey: string = OPENCODE_GLOBAL_POOL_KEY): boolean {
    const entry = this.entries.get(serverKey(projectDir, poolKey));
    return entry?.started !== undefined && !entry.started.child.hasExited();
  }

  /** Whether this server is still being started. */
  isStarting(projectDir: string, poolKey: string = OPENCODE_GLOBAL_POOL_KEY): boolean {
    return this.entries.get(serverKey(projectDir, poolKey))?.starting !== undefined;
  }

  /** References held on this server: its threads' sessions and any probe in flight. */
  refCount(projectDir: string, poolKey: string = OPENCODE_GLOBAL_POOL_KEY): number {
    return this.entries.get(serverKey(projectDir, poolKey))?.refs ?? 0;
  }

  /** Every (project, key) with a server started or starting. */
  servers(): { projectDir: string; poolKey: string }[] {
    return [...this.entries.values()]
      .filter((entry) => entry.started !== undefined || entry.starting !== undefined)
      .map((entry) => ({ projectDir: entry.projectDir, poolKey: entry.spec.key }));
  }

  /**
   * Agent profile §4.8: stop this (project, key)'s server now, so the next
   * acquire starts a fresh one — `opencode serve` reads its config once, at
   * start, and keeps it for its whole life. Only a server nobody holds is
   * stopped: null when a reference is held, a start is under way, or nothing
   * runs (a dead child's entry is dropped). Other keys of the project are
   * untouched. Resolves once the child is gone; that server's next start
   * waits for it (`retiring`), and so does `stopAll`.
   */
  recycle(projectDir: string, poolKey: string = OPENCODE_GLOBAL_POOL_KEY): Promise<void> | null {
    const id = serverKey(projectDir, poolKey);
    const entry = this.entries.get(id);
    if (entry === undefined || entry.refs > 0 || entry.starting !== undefined) {
      return null;
    }
    this.entries.delete(id);
    if (entry.idleTimer !== undefined) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
    const started = entry.started;
    entry.started = undefined;
    if (started === undefined || started.child.hasExited()) {
      return null;
    }
    const stop = started.child.kill().then(
      () => undefined,
      () => undefined
    );
    this.retiring.set(id, stop);
    this.stopping.add(stop);
    void stop.then(() => {
      this.stopping.delete(stop);
      if (this.retiring.get(id) === stop) {
        this.retiring.delete(id);
      }
    });
    return stop;
  }

  /** Every live server, for the host's own diagnostics. */
  list(): { projectDir: string; poolKey: string; url: string; version: string; pid: number | undefined }[] {
    const out: { projectDir: string; poolKey: string; url: string; version: string; pid: number | undefined }[] = [];
    for (const entry of this.entries.values()) {
      if (entry.started !== undefined) {
        out.push({
          projectDir: entry.projectDir,
          poolKey: entry.spec.key,
          url: entry.started.url,
          version: entry.started.version,
          pid: entry.started.child.pid
        });
      }
    }
    return out;
  }

  /**
   * Stop every server now, regardless of refcount (host shutdown), and wait
   * for every server stop in flight — this call's and an earlier call's. A
   * failed stop fails the call only once the others are done.
   */
  async stopAll(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) {
      const stop = (async () => {
        if (entry.idleTimer !== undefined) {
          clearTimeout(entry.idleTimer);
        }
        const started = entry.started ?? (await entry.starting?.catch(() => undefined));
        if (started !== undefined) {
          await started.child.kill();
        }
      })();
      this.stopping.add(stop);
      const forget = (): void => {
        this.stopping.delete(stop);
      };
      void stop.then(forget, forget);
    }
    const results = await Promise.allSettled([...this.stopping]);
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure !== undefined) {
      throw failure.reason;
    }
  }

  private handle(entry: PoolEntry, started: Started): OpenCodeServerHandle {
    let released = false;
    const pool = this;
    return {
      url: started.url,
      version: started.version,
      projectDir: entry.projectDir,
      poolKey: entry.spec.key,
      pid: started.child.pid,
      exited: started.child.exited,
      hasExited: () => started.child.hasExited(),
      client(directory: string, signal?: AbortSignal): OpenCodeClient {
        return new OpenCodeClient({
          baseUrl: started.url,
          directory,
          serverPassword: started.serverPassword,
          signal: signal ?? pool.options.signal
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
    this.options.onRelease?.(entry.projectDir, entry.spec.key);
    if (entry.refs > 0 || entry.idleTimer !== undefined) {
      return;
    }
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = undefined;
      if (entry.refs > 0 || this.entries.get(entry.id) !== entry) {
        return;
      }
      this.entries.delete(entry.id);
      const started = entry.started;
      entry.started = undefined;
      if (started !== undefined) {
        // SIGTERM to the process GROUP, then SIGKILL on the grace deadline —
        // `opencode serve` is a bun binary that spawns its own children.
        void started.child.kill().catch(() => undefined);
      }
    }, SERVER_IDLE_CLOSE_MS);
    entry.idleTimer.unref?.();
  }

  private async start(entry: PoolEntry): Promise<Started> {
    const { projectDir, spec } = entry;
    await this.retiring.get(entry.id);
    // boxes: the project's server runs in its box, reached through a forwarded port.
    if (entry.box !== undefined) return this.startInBox(entry, entry.box);
    const bin = await this.options.resolveBin();
    const port = await probeFreePort(this.hostname);
    const password = randomBytes(24).toString("base64url");

    // The global server's env is exactly `buildEnv`'s, as it always was; a
    // keyed server's spec is layered on top — its unsets first, then its env.
    const env = { ...this.options.buildEnv({ projectDir, poolKey: spec.key }) };
    for (const name of spec.unsetEnv) {
      delete env[name];
    }
    Object.assign(env, spec.env);
    // `extendEnv` has no analogue here — `buildProviderEnv` never spreads
    // `process.env` — so both variables are set explicitly. `{}` is only a
    // fallback: setting `OPENCODE_CONFIG_CONTENT` unconditionally clobbers the
    // user's own config and hides their providers (§4.5).
    const configContent =
      env.OPENCODE_CONFIG_CONTENT ?? process.env.OPENCODE_CONFIG_CONTENT ?? "{}";
    const childEnv: Record<string, string> = {
      ...env,
      OPENCODE_CONFIG_CONTENT: configContent,
      OPENCODE_SERVER_PASSWORD: password
    };

    const child = spawnProviderChild({
      command: bin,
      args: ["serve", `--hostname=${this.hostname}`, `--port=${port}`],
      env: childEnv,
      cwd: projectDir,
      // The whole process group is what a kill must signal (§3.1): `opencode
      // serve` is a Bun binary that spawns its own children.
      killGraceMs: OPENCODE_KILL_GRACE_MS
    });
    // A stop signals the server's whole group; its own exit (a crash) now does the same, by the
    // launch marker and never a shared daemon (`support/provider-leftovers.ts`).
    const leftovers = new ProviderLeftovers({ env: childEnv, label: "opencode", logger: this.options.logger });
    void leftovers.watchGroup(child.pid);
    void child.exited.then(() => leftovers.sweep());
    return await this.awaitReady(entry, child, { homeDir: childEnv.HOME ?? "", password });
  }

  /**
   * boxes (spec 2026-10-19 §8.5): the project's server in its box. A free port THERE (the box's
   * listening ports, `sys.ports`), the box env with the launch's config content merged in, the
   * readiness line scraped as for a local server — and then the box port forwarded to a loopback
   * port HERE, which every client (the health check included) talks to. The child is detached:
   * a dropped link reattaches rather than ending every thread on the server.
   */
  private async startInBox(entry: PoolEntry, box: OpenCodeBoxServer): Promise<Started> {
    const { projectDir, spec } = entry;
    const password = randomBytes(24).toString("base64url");
    const env: Record<string, string> = { ...box.env };
    for (const name of spec.unsetEnv) {
      delete env[name];
    }
    for (const [key, value] of Object.entries(spec.env)) {
      env[key] = box.launch.toBox(value);
    }
    // The bridged MCP servers belong to THIS server: registered now, released when it is gone.
    const config = await box.configContent();
    const childEnv: Record<string, string> = {
      ...env,
      OPENCODE_CONFIG_CONTENT: mergeOpenCodeConfigContent(env.OPENCODE_CONFIG_CONTENT ?? "{}", config.content),
      OPENCODE_SERVER_PASSWORD: password
    };
    let port: number;
    try {
      port = await freeBoxPort(box.launch);
    } catch (error) {
      await config.release();
      throw error;
    }
    const child = box.launch.spawn({
      command: box.launch.bin,
      args: ["serve", `--hostname=${this.hostname}`, `--port=${port}`],
      env: childEnv,
      envUnset: box.envUnset,
      cwd: box.launch.toBox(projectDir),
      killGraceMs: OPENCODE_KILL_GRACE_MS,
      detached: true
    });
    let forward: BoxHostForward | null = null;
    void child.exited.then(async () => {
      await forward?.close().catch(() => undefined);
      await config.release();
    });
    return await this.awaitReady(entry, child, {
      homeDir: box.launch.sys.home,
      password,
      toHostUrl: async (scraped) => {
        const boxPort = Number(new URL(scraped).port) || port;
        const opened = await box.launch.connection.forwardToHost(boxPort);
        forward = opened;
        if (child.hasExited()) await opened.close().catch(() => undefined);
        return `http://127.0.0.1:${opened.hostPort}`;
      }
    });
  }

  /**
   * The readiness scrape, then the version check against the server — a local one's or, through
   * `toHostUrl`, a box one's forwarded port. Kills the child on any failure.
   */
  private async awaitReady(
    entry: PoolEntry,
    child: ProviderChild,
    input: { homeDir: string; password: string; toHostUrl?: (scraped: string) => Promise<string> }
  ): Promise<Started> {
    const { projectDir, spec } = entry;
    const password = input.password;
    const stderr = new StderrCapture({ homeDirs: [input.homeDir] });
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
      // Trim on a LINE boundary. Front-truncating mid-line would make the
      // line-oriented scrape (`parseServerUrl`, which uses `startsWith`) skip
      // a real readiness line, and a healthy server would then be killed at
      // the handshake deadline.
      stdoutCapture = trimToLastLines(`${stdoutCapture}${chunk}`, STARTUP_CAPTURE_MAX_CHARS);
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
          this.options.onStderr?.(projectDir, line, spec.key);
        }
      }
    });

    void child.exited.then((reason) => {
      // Diagnostics must never report a dead pid as live: `list()` reads
      // `entry.started`, and without this it stays populated until the next
      // `acquire` happens to notice.
      if (entry.started?.child === child) {
        entry.started = undefined;
      }
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
      // boxes: the box's readiness URL names a box port; clients use the forwarded one.
      if (input.toHostUrl !== undefined) url = await input.toHostUrl(url);
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
      serverPassword: password,
      signal: this.options.signal
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
      poolKey: spec.key,
      url,
      version,
      pid: child.pid
    });

    return { url, version, serverPassword: password, child };
  }
}

/**
 * boxes: a port nothing listens on in the box, from its own listening-port list. Random in the
 * ephemeral range, so two servers starting at once rarely pick the same one — and a clash is the
 * server's own bind failure, reported like any failed start.
 */
async function freeBoxPort(launch: OpenCodeBoxServer["launch"]): Promise<number> {
  const listening = await launch.connection.request("sys.ports", {}).catch(() => []);
  const taken = new Set(listening.map((entry) => entry.port));
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const port = 20_000 + Math.floor(Math.random() * 40_000);
    if (!taken.has(port)) return port;
  }
  throw new Error("Could not find a free port in the box for the OpenCode server.");
}

/**
 * `GET /global/health` must answer `{healthy:true, version}` within 5 s and
 * satisfy the §4.1 minimum. The check runs against the **server**, not only
 * the binary, because an already-running server can be older than the
 * `opencode` on PATH (§3.2).
 */
async function verifyServerVersion(client: OpenCodeClient): Promise<string> {
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
