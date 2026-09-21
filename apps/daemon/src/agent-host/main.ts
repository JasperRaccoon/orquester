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
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve as resolvePath } from "node:path";

import {
  agentChatDir,
  agentChatThreadAttachmentsDir,
  agentHostSocketPath,
  agentHostTokenPath,
  daemonConfigDir
} from "@orquester/config";
import { REGISTRY, type RegistryEntryDef } from "@orquester/registry";
import type { AccountHome, AgentAdapterId, ProviderSnapshot } from "@orquester/api/agent-chat";

import type { AdapterContext, AdapterLogger, AgentAdapter } from "./adapter.ts";
import { ADAPTER_IDS, adapterFactory } from "./adapters/index.ts";
import { createCheckpointService } from "./checkpoints/index.ts";
import type { AgentHostStopResponse } from "@orquester/api/agent-chat";
import { newHostInstanceId } from "./host-protocol.ts";
import { createIngestion } from "./ingestion/index.ts";
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
    buildEnv: ({ threadId, home, extraEnv }) =>
      buildProviderEnv({
        adapter,
        sessionPath,
        tmpDir,
        homeDir,
        ...(home.kind !== "system" ? { accountHomeDir: home.path } : {}),
        ...(extraEnv !== undefined ? { extraEnv } : {}),
        sessionId: threadId,
        // The cliproxy launcher's `ANTHROPIC_AUTH_TOKEN` *is* the selected
        // identity, so it is the one ambient credential that may survive.
        ...(home.kind === "cliproxy" ? { allowCredentialVars: ["ANTHROPIC_AUTH_TOKEN"] } : {})
      }),
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
  const snapshots: ManagedProviderSnapshotRegistry = createProviderSnapshotRegistry({
    probes: ADAPTER_IDS.map((id) => ({
      id,
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
    resolveHome: async ({ adapter, refId, accountId, home }): Promise<AccountHome> => {
      if (home === "cliproxy") {
        return {
          kind: "cliproxy",
          proxyRefId: refId,
          path: join(daemonConfigDir(appdir), "cliproxy", `claude-home-${refId}`)
        };
      }
      const family = accountFamilyFor(adapter);
      if (home === "account" && family && accountId.length > 0) {
        return {
          kind: "account",
          accountId,
          path: join(daemonConfigDir(appdir), "agent-accounts", family, accountId, "home")
        };
      }
      return { kind: "system", path: homeDir };
    },
    continuationEnabled: () => continuationDefault(env),
    launchArgsForRefId: (refId) => refIds.get(refId)?.args ?? [],
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
    host.openGate();
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
 * §3.3: continuation is opt-in per project over a host-wide default that is
 * **off**. The per-project resolution is the daemon's (it owns project
 * settings); until that lands the host honours the host-wide switch only.
 */
function continuationDefault(env: NodeJS.ProcessEnv): boolean {
  return env.ORQUESTER_AGENT_CONTINUE_AFTER_RESTART === "1";
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
        // refuses to drain must never stall the stop, and provider children
        // parented to tmux survive regardless.
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
