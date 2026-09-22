/**
 * Agent host — the process entry and composition root (spec §3.1, §3.3, §8).
 *
 * A separate long-lived Node process, run with tsx like the daemon, in a tmux
 * service session (`orqsvc-agent-host`) so `KillMode=process` cannot take it
 * down with a deploy. It hosts the four adapters, owns every provider child,
 * owns the per-thread event logs, and serves the unix-socket HTTP API the
 * daemon proxies.
 *
 * **Readiness is a gate, not a race** (§3.1, §8). The socket may be bound, but
 * `GET /health` is answered only once the store is open, the adapters are
 * acquired and the §3.3 reconcile has been scheduled. Every fallible startup
 * step sits before that boundary; a failure fails the gate, and every queued
 * and subsequent command answers with that error rather than hanging.
 *
 * **No lazy dynamic `import()`** anywhere under this directory (§8): a host
 * that survives a deploy runs old code until the drain-restart, and loading
 * changed source into it is a correctness bug.
 */

import { randomBytes } from "node:crypto";
import { readCodeStamp } from "./support/code-stamp.ts";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve as resolvePath, sep } from "node:path";

import {
  agentChatDir,
  agentChatThreadAttachmentsDir,
  agentHostSocketPath,
  agentHostTokenPath,
  appConfigPath,
  continueThreadsForProject,
  createDefaultAppConfig,
  daemonConfigDir,
  daemonConfigPath,
  expandVars,
  parseAppConfig,
  parseDaemonConfig,
  parseSessionsConfig,
  resolveDaemonPaths,
  sessionsIndexPath
} from "@orquester/config";
import { REGISTRY, type RegistryEntryDef } from "@orquester/registry";
import type { AccountHome, AgentAdapterId, ProviderSnapshot } from "@orquester/api/agent-chat";

import type { AdapterContext, AdapterLogger, AgentAdapter } from "./adapter.ts";
import {
  ADAPTER_IDS,
  ADAPTER_PENDING_SNAPSHOTS,
  SNAPSHOT_TIMEOUTS_MS,
  adapterFactory
} from "./adapters/index.ts";
import { createCheckpointService } from "./checkpoints/index.ts";
import type { AgentHostStopResponse } from "@orquester/api/agent-chat";
import { newHostInstanceId } from "./host-protocol.ts";
import { createIngestion } from "./ingestion/index.ts";
import { createFileLaunchConfigStore } from "./orchestration/launch-config.ts";
import { createLivenessRegistry } from "./orchestration/liveness.ts";
import { createOrchestrator, type Orchestrator } from "./orchestration/orchestrator.ts";
import {
  createProviderSnapshotRegistry,
  type ManagedProviderSnapshotRegistry
} from "./orchestration/provider-snapshots.ts";
import { systemClock, systemIdGen } from "./orchestration/runtime-seams.ts";
import { createAgentHostServer, type AgentHostServer } from "./server/index.ts";
import { createThreadStore } from "./store/index.ts";
import { buildProviderEnv } from "./support/env.ts";

/**
 * The ONE ambient credential a cliproxy launcher may keep: for `claudex` and
 * `claudemix` the proxy's bearer token IS the selected identity, so the §3.1
 * denylist must not strip it. Everything else in
 * `AMBIENT_CREDENTIAL_ENV_VARS` stays denied.
 */
const CLIPROXY_CREDENTIAL_ENV_VAR = "ANTHROPIC_AUTH_TOKEN";

// ---------------------------------------------------------------------------
// Small host-local helpers
// ---------------------------------------------------------------------------

/** `--appdir <dir>` / `--appdir=<dir>`, the same spelling `cli.ts` accepts. */
export function parseHostArgs(args: readonly string[]): { appdir?: string } {
  const eq = args.find((arg) => arg.startsWith("--appdir="));
  if (eq) {
    return { appdir: eq.slice("--appdir=".length) };
  }
  const index = args.indexOf("--appdir");
  const value = index !== -1 ? args[index + 1] : undefined;
  return value !== undefined ? { appdir: value } : {};
}

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a registry `bin` to an **absolute** executable against the session
 * PATH. Must be a real executable, not a shim or a bare name: the Claude SDK
 * spawns the path directly, without a shell and without PATH resolution (§10).
 */
function resolveBinOnPath(bin: string, path: string): string | null {
  if (isAbsolute(bin)) {
    return isExecutable(bin) ? bin : null;
  }
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of path.split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = join(dir, bin + ext);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * The PATH a provider child runs with — deliberately wider than the daemon's
 * own, which under systemd omits the per-user bin dirs sessions get (§3.1).
 * Mirrors `sessionPath()` in `apps/daemon/src/tmux.ts`; duplicated rather than
 * imported so the host process never loads the daemon's module graph.
 */
export function hostSessionPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME ?? homedir();
  const extras = [
    join(home, ".local", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".cargo", "bin"),
    join(home, ".deno", "bin"),
    join(home, "go", "bin")
  ];
  const inherited = (env.PATH ?? "").split(delimiter).filter(Boolean);
  const seen = new Set(inherited);
  return [...extras.filter((dir) => !seen.has(dir)), ...inherited].join(delimiter);
}

function consoleLogger(): AdapterLogger {
  const write = (level: string) => (message: string, detail?: unknown) => {
    const line = `[agent-host] ${level} ${message}`;
    if (detail === undefined) {
      console.error(line);
      return;
    }
    console.error(line, detail);
  };
  return {
    debug: process.env.ORQUESTER_AGENT_HOST_DEBUG === "1" ? write("debug") : () => undefined,
    info: write("info"),
    warn: write("warn"),
    error: write("error")
  };
}

/** The registry `refId → adapter` map, from the catalog's `chat` block (§5.3). */
function buildRefIdIndex(): Map<
  string,
  { adapter: AgentAdapterId; bins: string[]; args: string[] }
> {
  const index = new Map<string, { adapter: AgentAdapterId; bins: string[]; args: string[] }>();
  for (const entry of REGISTRY.agents as readonly RegistryEntryDef[]) {
    if (!entry.chat) continue;
    index.set(entry.id, {
      adapter: entry.chat.adapter,
      bins: [...entry.bin],
      args: [...(entry.args ?? [])]
    });
  }
  return index;
}

/**
 * The managed-account family for an adapter. OpenCode has no managed account
 * family, so an `account` home there falls back to the daemon user's HOME.
 */
function accountFamilyFor(adapter: AgentAdapterId): "claude" | "codex" | "grok" | null {
  return adapter === "claude" || adapter === "codex" || adapter === "grok" ? adapter : null;
}

async function readOrCreateToken(path: string): Promise<string> {
  try {
    const existing = (await readFile(path, "utf8")).trim();
    if (existing.length > 0) {
      return existing;
    }
  } catch {
    // Not written yet: the host is being started outside the daemon's normal
    // spawn path.
  }
  const token = randomBytes(32).toString("base64url");
  await mkdir(daemonConfigDir(resolvePath(path, "..", "..")), { recursive: true }).catch(
    () => undefined
  );
  await writeFile(path, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);
  return token;
}

// ---------------------------------------------------------------------------
// The host
// ---------------------------------------------------------------------------

export interface AgentHost {
  readonly hostInstanceId: string;
  readonly orchestrator: Orchestrator;
  readonly server: AgentHostServer;
  /** Resolves when the command gate is open (or rejects with the startup error). */
  readonly ready: Promise<void>;
  stop(): Promise<void>;
}

export interface StartAgentHostOptions {
  appdir?: string;
  env?: NodeJS.ProcessEnv;
  logger?: AdapterLogger;
}

export async function startAgentHost(
  options: StartAgentHostOptions = {}
): Promise<AgentHost> {
  const env = options.env ?? process.env;
  const logger = options.logger ?? consoleLogger();
  const homeDir = env.HOME ?? homedir();
  const appdir = resolvePath(options.appdir ?? env.ORQUESTER_APPDIR ?? join(homeDir, ".orquester"));
  const startedAt = new Date().toISOString();
  const hostInstanceId = newHostInstanceId();

  const clock = systemClock;
  const ids = systemIdGen;
  const stateDir = agentChatDir(appdir);
  const tmpDir = env.TMPDIR ?? join(appdir, "tmp");
  const sessionPath = hostSessionPath(env);
  const refIds = buildRefIdIndex();

  await mkdir(stateDir, { recursive: true });
  await mkdir(tmpDir, { recursive: true });

  const token = await readOrCreateToken(agentHostTokenPath(appdir));
  const socketPath = agentHostSocketPath(appdir, process.platform === "win32" ? "win32" : "linux");

  // ---- services ----------------------------------------------------------
  const liveness = createLivenessRegistry();
  const launchConfigs = createFileLaunchConfigStore({ rootDir: stateDir });
  // Exactly ONE checkpoint service for the host: its git permit pool is per
  // instance, so a second one would double the concurrency §5.4 bounds.
  const checkpoints = createCheckpointService({
    clock,
    gitEnv: {
      PATH: sessionPath,
      HOME: homeDir,
      TMPDIR: tmpDir,
      GIT_TERMINAL_PROMPT: "0"
    },
    log: (message, detail) => logger.debug(message, detail)
  });

  // `rootDir` is `<appdir>/daemon/agent`, NOT the appdir. The delete hook runs
  // before the directory is removed and a throw there aborts the delete, so a
  // thread can never be deleted and leave its checkpoint refs behind (§5.4).
  const store = createThreadStore({
    rootDir: stateDir,
    clock,
    idGen: ids,
    homeDirs: [homeDir],
    deleteThreadRefs: (input) => checkpoints.deleteThreadRefs(input)
  });

  /**
   * OpenCode's shared per-project server is built with a synthetic
   * `project:<dir>` session id, because it belongs to no single thread (§3.2).
   * Resolve the project's launcher env for it; anything else, or an unknown
   * project, degrades to no launcher env.
   */
  const PROJECT_PSEUDO_THREAD_PREFIX = "project:";
  const projectLaunchConfig = (threadId: string) =>
    threadId.startsWith(PROJECT_PSEUDO_THREAD_PREFIX)
      ? (orchestrator?.launchConfigForCwd(
          threadId.slice(PROJECT_PSEUDO_THREAD_PREFIX.length)
        ) ?? null)
      : null;

  /**
   * Exact secrets this host injects into children, masked wherever they could
   * surface (a CLI echoing its resolved config on stderr, an error message).
   * The cliproxy `ANTHROPIC_AUTH_TOKEN` is a bare hex string that matches no
   * credential shape, so nothing but the literal catches it.
   */
  const hostInjectedSecrets: string[] = [];
  const noteInjectedSecret = (value: string | undefined): void => {
    if (value !== undefined && value.length >= 8 && !hostInjectedSecrets.includes(value)) {
      hostInjectedSecrets.push(value);
    }
  };

  /**
   * §4.6.4's optional refresh `cwd` becomes a spawn cwd and a
   * `<cwd>/.claude/skills` readdir, so it is confined to the workspaces root
   * the way every other path-taking route on this daemon is.
   */
  const workspacesRoot = await resolveWorkspacesRoot(appdir, homeDir, env);
  const isAllowedCwd = (candidate: string): boolean => {
    if (workspacesRoot === null) {
      // The daemon's config could not be read, so there is no root to confine
      // to; refusing every per-cwd refresh would be worse than today.
      return true;
    }
    const resolved = resolvePath(candidate);
    return resolved === workspacesRoot || resolved.startsWith(`${workspacesRoot}${sep}`);
  };

  const shutdown = new AbortController();

  // ---- adapters (acquired BEFORE the gate opens, §3.1) -------------------
  const adapters = new Map<AgentAdapterId, AgentAdapter>();

  const adapterContext = (adapter: AgentAdapterId): AdapterContext => ({
    logger,
    clock,
    ids,
    resolveAttachmentPath: (threadId, attachmentId) =>
      store.resolveAttachment(threadId, attachmentId),
    attachmentsDir: (threadId) => agentChatThreadAttachmentsDir(appdir, threadId),
    logRawFrame: (threadId, frame) => store.logRawFrame(threadId, frame),
    buildEnv: ({ threadId, home, projectPath, extraEnv }) => {
      // The §6.1 launcher env the daemon composed for this thread: the registry
      // entry's own env (which already carries `<appdir>/daemon/env/<id>.env`)
      // under every `resolveExtraEnv` contributor. It layers OVER the adapter's
      // own extras, exactly as the terminal wrapper's `export` wins over
      // `tmux -e`.
      // A child shared by a project (OpenCode's server, §3.2) names the project
      // rather than a thread, so it resolves the project's launcher env.
      const launch =
        orchestrator?.launchConfig(threadId) ??
        (projectPath !== undefined
          ? (orchestrator?.launchConfigForCwd(projectPath) ?? null)
          : null) ??
        projectLaunchConfig(threadId);
      const accountHomeDir = launch?.homePath ?? (home.kind !== "system" ? home.path : undefined);
      const env = buildProviderEnv({
        adapter,
        sessionPath,
        tmpDir,
        homeDir,
        ...(accountHomeDir !== undefined ? { accountHomeDir } : {}),
        extraEnv: { ...extraEnv, ...launch?.launchEnv },
        sessionId: threadId,
        // For a cliproxy launcher the proxy token IS the selected identity, so
        // it is the one ambient credential that may survive the denylist —
        // without this, `claudex`/`claudemix` launch with no credential at all.
        ...(home.kind === "cliproxy"
          ? { allowCredentialVars: [CLIPROXY_CREDENTIAL_ENV_VAR] }
          : {})
      });
      // The `unset` half of §3.1: the daemon names the ambient vars this launch
      // must not carry, and they are removed after everything else is layered.
      for (const name of launch?.unsetEnv ?? []) {
        delete env[name];
      }
      // Remember what we handed out so the redactor can mask it by value.
      noteInjectedSecret(env.ANTHROPIC_AUTH_TOKEN);
      for (const [key, value] of Object.entries(env)) {
        if (/(_API_KEY|_TOKEN)$/.test(key)) {
          noteInjectedSecret(value);
        }
      }
      return env;
    },
    resolveBin: async (refId: string) => {
      const entry = refIds.get(refId);
      if (!entry) return null;
      for (const bin of entry.bins) {
        const resolved = resolveBinOnPath(bin, sessionPath);
        if (resolved) return resolved;
      }
      return null;
    },
    sessionPath: () => sessionPath,
    tmpDir: () => tmpDir,
    signal: shutdown.signal
  });

  // ---- provider snapshots ------------------------------------------------
  /**
   * The CLI a provider's cached snapshot was probed against (§3.2 layer two).
   * Resolved against the SESSION path, exactly as a launch resolves it, so a
   * cache written before an `npm install -g` moved the binary is discarded
   * rather than rendered. A plain PATH walk — cheap enough to run at boot and
   * on every store.
   */
  const probeBinPath = (id: AgentAdapterId): string | null => {
    for (const entry of refIds.values()) {
      if (entry.adapter !== id) continue;
      for (const bin of entry.bins) {
        const resolved = resolveBinOnPath(bin, sessionPath);
        if (resolved) return resolved;
      }
    }
    return null;
  };

  const snapshots: ManagedProviderSnapshotRegistry = createProviderSnapshotRegistry({
    probes: ADAPTER_IDS.map((id) => ({
      id,
      // E9: an adapter whose catalogue lives behind a server it must start
      // first needs a window covering the start too. Data, per adapter — every
      // other probe keeps the tight auth window.
      ...(SNAPSHOT_TIMEOUTS_MS[id] !== undefined ? { timeoutMs: SNAPSHOT_TIMEOUTS_MS[id] } : {}),
      // §3.2 layer one: the synchronous seed the registry holds from
      // construction, so `GET /providers` is never `[]`. Read from the module
      // rather than from `adapters.get(id)` — no adapter exists yet here.
      pending: ADAPTER_PENDING_SNAPSHOTS[id],
      // §3.2 layer two: what the on-disk cache is correlated against.
      identity: () => ({ binPath: probeBinPath(id) }),
      refresh: async (input?: { cwd?: string }): Promise<ProviderSnapshot> => {
        const adapter = adapters.get(id);
        if (!adapter) {
          throw new Error(`Adapter '${id}' is not available.`);
        }
        return adapter.refreshSnapshot(input);
      }
    })),
    stateDir,
    logger,
    clock
  });

  // ---- orchestration -----------------------------------------------------
  // The ingestion sink is late-bound: ingestion needs somewhere to deliver
  // translated events, and that somewhere is the orchestrator's own append
  // path, which needs ingestion to exist first.
  let orchestrator: Orchestrator | null = null;
  const ingestion = createIngestion({
    sink: async (threadId, events) => {
      if (!orchestrator) return;
      await orchestrator.ingestionSink(threadId, events);
    },
    liveness,
    clock,
    idGen: ids,
    // Without these three the behaviour is silently off: no seeded session
    // state after a restart, a provider retitle overwriting a manual rename,
    // no §5.4 placeholder, and nothing routing `account.rate-limits.updated`
    // onto the provider snapshot.
    threadContext: (threadId) => orchestrator?.threadContext(threadId) ?? null,
    placeholderCheckpoint: (input) =>
      orchestrator?.placeholderCheckpoint({
        threadId: input.threadId,
        turnId: input.turnId
      }) ?? null,
    onAccountEvent: (event) => orchestrator?.onAccountEvent(event),
    logger: { warn: (message, detail) => logger.warn(message, detail) }
  });

  orchestrator = createOrchestrator({
    store,
    ingestion,
    checkpoints,
    liveness,
    snapshots,
    adapters,
    logger,
    hostInstanceId,
    adapterForRefId: (refId) => refIds.get(refId)?.adapter ?? null,
    resolveHome: async ({ adapter, refId, accountId, home, threadId }): Promise<AccountHome> => {
      // The daemon resolved the absolute home when it created the thread and
      // it is the authority: it read the same `ACCOUNT_HOME_ENV_VAR` the child
      // itself will read. The conventions below are the fallback for a thread
      // created before the daemon sent one.
      const launch = orchestrator?.launchConfig(threadId) ?? null;
      if (home === "cliproxy") {
        const proxyRefId = launch?.proxyRefId ?? refId;
        return {
          kind: "cliproxy",
          proxyRefId,
          path:
            launch?.homePath ??
            join(daemonConfigDir(appdir), "cliproxy", `claude-home-${proxyRefId}`)
        };
      }
      const family = accountFamilyFor(adapter);
      if (home === "account" && (launch?.homePath || (family && accountId.length > 0))) {
        return {
          kind: "account",
          accountId,
          path:
            launch?.homePath ??
            join(daemonConfigDir(appdir), "agent-accounts", family!, accountId, "home")
        };
      }
      return { kind: "system", path: launch?.homePath ?? homeDir };
    },
    continuationEnabled: (projectPath) => continuationEnabledFor(appdir, projectPath, env),
    isThreadClosed: (threadId) => isThreadClosedFor(appdir, threadId),
    launchArgsForRefId: (refId) => refIds.get(refId)?.args ?? [],
    launchConfigs,
    clock,
    ids
  });
  const host = orchestrator;

  // ---- server ------------------------------------------------------------
  let stopping = false;
  const server = createAgentHostServer({
    orchestrator: host,
    store,
    logger,
    hostInstanceId,
    token,
    socketPath,
    tmpDir,
    startedAt,
    // Read ONCE at boot: this is the code this process is running, which is
    // the whole point — after a deploy the checkout moves and this does not.
    codeStamp: readCodeStamp(process.cwd()),
    // Everything that leaves the host as a message goes through the same
    // redaction the stderr path uses (§3.1).
    homeDirs: [homeDir],
    secretLiterals: hostInjectedSecrets,
    isAllowedCwd,
    onStop: async (): Promise<AgentHostStopResponse> => {
      // The intentional stop of §3.3: write every continuation marker for a
      // running thread with a usable cursor, then drain and stop.
      const markedThreadIds = await host.markThreadsForContinuation();
      queueMicrotask(() => {
        void stop().catch(async (error: unknown) => {
          logger.error("agent-host: intentional stop failed", error);
          // A cancelled restart must not inject a phantom continuation on the
          // next boot.
          await host.clearContinuationMarkers(markedThreadIds).catch(() => undefined);
        });
      });
      return { ok: true, markedThreadIds };
    },
    addProviderWatcher: () => snapshots.addWatcher()
  });

  // The socket is bound first so the daemon's connect succeeds; the health
  // request itself waits on the gate (§8: a bound socket is not readiness).
  await server.listen();

  const consumers: Array<Promise<void>> = [];

  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    shutdown.abort();
    snapshots.stop();
    await server.close().catch((error: unknown) => {
      logger.warn("agent-host: server close failed", error);
    });
    for (const adapter of adapters.values()) {
      await adapter.stopAll().catch((error: unknown) => {
        logger.warn(`agent-host: ${adapter.id} stopAll failed`, error);
      });
    }
    await host.stop().catch((error: unknown) => {
      logger.warn("agent-host: orchestrator stop failed", error);
    });
    // Last: the store's sweep timer and its open raw-log handles. The timer is
    // `unref`'d, so this is about a deterministic stop rather than about the
    // process exiting — a sweep must not start while the log writers close.
    store.close();
    await Promise.allSettled(consumers);
  };

  const ready = (async (): Promise<void> => {
    await snapshots.load();
    for (const id of ADAPTER_IDS) {
      try {
        const adapter = await adapterFactory(id)(adapterContext(id));
        adapters.set(id, adapter);
        // One consumer per adapter: the host's ingestion is the only reader of
        // an adapter's canonical event stream (§4.1).
        consumers.push(host.consume(adapter));
      } catch (error) {
        // An adapter that cannot be acquired must not keep the host from
        // serving the other three.
        logger.warn(`agent-host: adapter '${id}' is unavailable`, error);
      }
    }
    // §3.3 runs before the gate opens, and never blocks or fails startup.
    await host.reconcile();
    // One sweep after adoption, before the gate: the store's own interval is
    // 6 h, so without this a host that is restarted more often than that never
    // collects anything at all — and what it has to collect (a `.part` from an
    // upload whose connection died with the last process, a raw log for a
    // thread that is gone) is exactly what accumulates WHILE it is down.
    // After adoption, so a thread the reconcile just adopted still counts as
    // live and its raw log is not a sweep target.
    void store.sweepNow().catch((error: unknown) => {
      // Housekeeping that cannot run costs disk, not correctness.
      logger.warn("agent-host: the boot sweep failed", error);
    });
    host.openGate();
    // §3.2 layer three, AFTER the gate and never awaited: the registry forces
    // one probe of every provider itself, so a fresh host converges on real
    // catalogues in seconds instead of waiting out the 5-minute interval or a
    // client subscribing. Readiness has already been announced above — a probe
    // must never be able to delay it.
    // *T3: `makeManagedServerProvider.ts:280-284` — the forced refresh is
    // forked by the provider at construction, not awaited by its builder.*
    snapshots.startBootRefresh();
    logger.info(`agent-host ready on ${socketPath}`, {
      hostInstanceId,
      adapters: [...adapters.keys()]
    });
  })();

  ready.catch((error: unknown) => {
    logger.error("agent-host: startup failed", error);
    host.failGate(error);
  });

  return {
    hostInstanceId,
    orchestrator: host,
    server,
    ready,
    stop
  };
}

/**
 * §3.3: "archived and deleted threads are settled, never continued".
 *
 * The daemon's `deleteThread` is fire-and-forget over the socket, so a tab
 * closed while the host is **down** never gets a `thread.deleted` event — the
 * log alone cannot tell the difference between "closed" and "orphaned", and
 * resuming it spends tokens on a tab that no longer exists. The daemon's own
 * tab index is the authority, so the host reads it.
 *
 * An unreadable index answers `false`: never settle a live thread because a
 * file could not be read.
 */
async function isThreadClosedFor(appdir: string, threadId: string): Promise<boolean> {
  try {
    const raw = await readFile(sessionsIndexPath(appdir), "utf8");
    const sessions = parseSessionsConfig(JSON.parse(raw) as unknown);
    return !sessions.sessions.some(
      (session) => session.id === threadId && session.kind === "agent-chat"
    );
  } catch {
    return false;
  }
}

/**
 * The workspaces root every chat `cwd` lives under — `daemon.json`'s
 * `workspacesDir`, expanded. Read once at startup; `null` when the config
 * cannot be read, which leaves the guard open rather than breaking refreshes
 * on a host whose daemon config is missing.
 */
async function resolveWorkspacesRoot(
  appdir: string,
  homeDir: string,
  env: NodeJS.ProcessEnv
): Promise<string | null> {
  try {
    const raw = await readFile(daemonConfigPath(appdir), "utf8");
    const config = parseDaemonConfig(JSON.parse(raw) as unknown);
    const paths = resolveDaemonPaths({
      homeDir,
      platform: process.platform === "win32" ? "win32" : "linux",
      cwd: appdir,
      appdir,
      env: env as Record<string, string | undefined>
    });
    return resolvePath(expandVars(config.workspacesDir, paths.vars));
  } catch {
    return null;
  }
}

/**
 * §3.3: continuation is opt-in **per project** over a host-wide default that is
 * **off**, because "pick up where you left off" is wrong for a project where a
 * turn was halfway through a destructive operation.
 *
 * The host reads `app.json` itself through the config seam rather than being
 * handed the prefs by the daemon: the reconcile runs at boot, before any daemon
 * has spoken to it, so a pushed value would arrive too late to decide anything.
 * The file is read per pass (a reconcile is rare) and an unreadable or
 * unparseable one falls back to the schema's defaults — off.
 */
async function continuationEnabledFor(
  appdir: string,
  projectPath: string,
  env: NodeJS.ProcessEnv
): Promise<boolean> {
  if (env.ORQUESTER_AGENT_CONTINUE_AFTER_RESTART === "1") {
    return true;
  }
  try {
    const raw = await readFile(appConfigPath(appdir), "utf8");
    const config = parseAppConfig(JSON.parse(raw) as unknown);
    return continueThreadsForProject(config.agents, projectPath);
  } catch {
    return continueThreadsForProject(createDefaultAppConfig().agents, projectPath);
  }
}

// ---------------------------------------------------------------------------
// Process entry
// ---------------------------------------------------------------------------

/** True when this module is the process entry rather than an import. */
const isProcessEntry = (): boolean => {
  const entry = process.argv[1];
  return typeof entry === "string" && entry.endsWith("agent-host/main.ts");
};

if (isProcessEntry()) {
  const { appdir } = parseHostArgs(process.argv.slice(2));
  startAgentHost(appdir !== undefined ? { appdir } : {})
    .then((host) => {
      let stopping = false;
      const shutdown = (): void => {
        if (stopping) return;
        stopping = true;
        // The same 3 s hard-exit backstop the daemon uses: a stream that
        // refuses to drain must never stall the stop.
        //
        // Note what it costs. Provider children are children of THIS process
        // (the tmux pane's), not of the tmux server, so a backstop exit
        // orphans any child `stop()` had not reaped — and a `detached` one
        // (OpenCode's per-project server) escapes the process group entirely.
        // That is why the daemon must give the host a grace window before it
        // kills the host's tmux session, rather than assuming tmux owns them.
        const force = setTimeout(() => process.exit(0), 3_000);
        force.unref();
        void host
          .stop()
          .catch(() => undefined)
          .finally(() => {
            clearTimeout(force);
            process.exit(0);
          });
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      return host.ready;
    })
    .catch((error: unknown) => {
      console.error("[agent-host] failed to start", error);
      process.exit(1);
    });
}
