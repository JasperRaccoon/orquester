/**
 * Agent host — agent CLIs in boxes (spec 2026-10-19 §7, §8.4, §8.5).
 *
 * An agent chat whose project is a box runs its CLI IN the box and behaves
 * like a host chat. The adapters stay the owners of their protocols; what is
 * box-specific is here, behind two objects:
 *
 * - {@link AgentHostBoxes} — one per host (`AdapterContext.boxes`): the box
 *   connections, the token broker and sync clients, the Claude token restart
 *   policy, the turn-end mirror, the checkpoint git runners.
 * - {@link BoxLaunch} — one per CLI start ({@link AgentHostBoxes.launch}):
 *   refuses the System account, waits for the box, syncs the CLI's config
 *   (and its transcript, on a resume), resolves — or installs — the CLI in
 *   the box, and then gives the adapter everything it needs to start it
 *   there: box paths, the box env, the remote spawn, brokered tokens, file
 *   writes into the box and the MCP bridge registrations.
 *
 * Module map: `launch-info.ts` (the launch field and path mapping),
 * `connections.ts`, `remote-child.ts` (the remote `ProviderChild`),
 * `claude-process.ts` (the SDK's `SpawnedProcess`), `box-env.ts`,
 * `box-tools.ts` (PATH, `command -v`, installs, `--version`),
 * `daemon-client.ts` (token + sync routes), `token-policy.ts`,
 * `mcp-plan.ts` / `mcp-bridge-registry.ts` (the bridge), and
 * `../checkpoints/box-git.ts`.
 */

import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import type { AccountHome, AgentAdapterId } from "@orquester/api/agent-chat";
import type { BoxPathMap, BoxSysInfo } from "@orquester/api";
import { boxMcpSettingsPath, runInBoxServerNames, sessionProfileDir } from "@orquester/config";

import type { AgentTokenGrant, BoxConnection } from "../../boxes/contracts.ts";
import type { AdapterContext, AdapterLogger } from "../adapter.ts";
import type { HostThreadBox, HostThreadProfile } from "../host-protocol.ts";
import { createBoxGitRunner } from "../checkpoints/box-git.ts";
import type { GitRunner } from "../checkpoints/git.ts";
import { ACCOUNT_HOME_ENV_VAR } from "../support/env.ts";
import type { ChildExitReason, ProviderChild } from "../support/spawn.ts";
import { buildBoxProviderEnv, type BoxEnvResult } from "./box-env.ts";
import { boxLoginPath, ensureBoxAgentCli, probeBoxVersion } from "./box-tools.ts";
import { boxClaudeSpawner } from "./claude-process.ts";
import { BoxConnectionPool, type BoxConnector } from "./connections.ts";
import { BoxDaemonCallError, type BoxSyncClient, type BoxTokenSource } from "./daemon-client.ts";
import { BoxLaunchError, describeBoxFailure } from "./errors.ts";
import { mapHostValue } from "./launch-info.ts";
import {
  MCP_BRIDGE_ENTRY_VERSION,
  removeMcpBridgeEntries,
  writeMcpBridgeEntry,
  newMcpBridgeServerId
} from "./mcp-bridge-registry.ts";
import { mcpBridgeArgv, planMcpBridges, type McpBridgePlan, type McpServerSpec } from "./mcp-plan.ts";
import { spawnBoxChild, type BoxProviderChild } from "./remote-child.ts";
import { BoxTokenTracker, BOX_TOKEN_MIN_VALID_SECONDS } from "./token-policy.ts";

export { BoxLaunchError } from "./errors.ts";
export type { BoxConnector } from "./connections.ts";

/** The agents whose box launches take a brokered token (OpenCode uses API-key providers). */
type TokenAgent = "claude" | "codex" | "grok";

function isTokenAgent(agent: AgentAdapterId): agent is TokenAgent {
  return agent === "claude" || agent === "codex" || agent === "grok";
}

export interface BoxLaunchInput {
  threadId: string;
  agent: AgentAdapterId;
  box: HostThreadBox;
  home: AccountHome;
  /** HOST path of the CLI's working directory. */
  cwd: string;
  profile?: HostThreadProfile;
  /**
   * HOST path of the directory the CLI reads its config and writes its transcripts in (the
   * account home; a Codex profile's prepared home). Default: `home.path`.
   */
  configRoot?: string;
  /** The provider session this start resumes: its transcript is pushed into the box first. */
  resumeSessionRef?: string | null;
  /** False for a short-lived helper (a fork's process, a probe): no config sync. Default true. */
  sync?: boolean;
  signal?: AbortSignal;
  /** One line of progress for the chat's log (an install, a sync). */
  onProgress?: (message: string) => void;
}

/** The CLI configuration a launch's MCP servers came from. */
export interface BoxMcpBridgeResult extends McpBridgePlan {
  /** Names the owner switched to "Run in box" (for the adapter's in-box handling). */
  runInBox: ReadonlySet<string>;
  /** Ends caller-owned registrations (`owner: "caller"`); a no-op for the launch's own. */
  release: () => Promise<void>;
}

/**
 * One CLI start in a box. Created by {@link AgentHostBoxes.launch}; the adapter
 * closes it when the session ends ({@link close}).
 */
export class BoxLaunch {
  private readonly bridgeIds: string[] = [];
  private closed = false;
  private credentialWriter: ((grant: AgentTokenGrant) => Promise<void>) | null = null;
  private credentialWork: Promise<void> = Promise.resolve();

  constructor(
    private readonly host: AgentHostBoxesImpl,
    readonly input: BoxLaunchInput,
    readonly connection: BoxConnection,
    /** The box as the LIVE connection reports it (its sys and paths win over the persisted copy). */
    readonly box: HostThreadBox,
    /** Absolute BOX path of the agent CLI. */
    readonly bin: string,
    /** The box's login PATH (before the tooling prepend). */
    readonly boxPath: string,
    /** The managed account the CLI runs as ("" for OpenCode without one). */
    readonly accountId: string
  ) {}

  get threadId(): string {
    return this.input.threadId;
  }

  get sys(): BoxSysInfo {
    return this.box.sys;
  }

  get paths(): BoxPathMap {
    return this.box.paths;
  }

  /** A host path as the box knows it (identity on POSIX boxes). */
  toBox(hostPath: string): string {
    return mapHostValue(this.box.paths, hostPath);
  }

  /** The box env for a host-built env (`AdapterContext.buildEnv`). */
  env(hostEnv: Readonly<Record<string, string>>): BoxEnvResult {
    return buildBoxProviderEnv({ hostEnv, adapter: this.input.agent, box: this.box, boxPath: this.boxPath });
  }

  /**
   * The provider child, in the box. `detached` (agent CLIs) survives a dropped link and
   * reattaches; a short command does not. `command`/`cwd` are BOX paths, `env` box-shaped.
   */
  spawn(input: {
    command: string;
    args: readonly string[];
    env: Record<string, string>;
    envUnset?: readonly string[];
    cwd: string;
    killGraceMs?: number;
    detached?: boolean;
  }): BoxProviderChild {
    return spawnBoxChild({
      connection: this.connection,
      command: input.command,
      args: input.args,
      env: input.env,
      ...(input.envUnset !== undefined ? { envUnset: input.envUnset } : {}),
      cwd: input.cwd,
      ...(input.killGraceMs !== undefined ? { killGraceMs: input.killGraceMs } : {}),
      ...(input.detached === true ? { detach: { procId: this.host.newProcId(this.input) } } : {}),
      onNotice: (message) => this.host.logger.info(`box ${this.box.boxId}: ${message}`, { threadId: this.threadId })
    });
  }

  /**
   * A `spawnProviderChild`-shaped function for an adapter's short helpers (`--version`, a
   * history worker): host paths and env are mapped, nothing is detached.
   */
  spawnFn(envUnset: readonly string[] = []): (input: {
    command: string;
    args: readonly string[];
    env: Record<string, string>;
    cwd: string;
    killGraceMs?: number;
  }) => ProviderChild {
    return (input) =>
      this.spawn({
        command: this.toBox(input.command),
        args: input.args,
        env: input.env,
        envUnset,
        cwd: this.toBox(input.cwd),
        ...(input.killGraceMs !== undefined ? { killGraceMs: input.killGraceMs } : {})
      });
  }

  /** The Agent SDK's `spawnClaudeCodeProcess` for this launch. */
  claudeSpawner(stderr: (data: string) => void, envUnset: readonly string[] = []): (options: SpawnOptions) => SpawnedProcess {
    return boxClaudeSpawner({
      connection: this.connection,
      procId: () => this.host.newProcId(this.input),
      stderr,
      envUnset,
      onNotice: (message) => this.host.logger.info(`box ${this.box.boxId}: ${message}`, { threadId: this.threadId })
    });
  }

  /** `<bin> --version` in the box (first line), cached per box and binary. */
  version(envUnset: readonly string[] = []): Promise<string | null> {
    return this.host.cachedVersion(this.connection, this.bin, () =>
      probeBoxVersion(this.connection, { bin: this.bin, env: { PATH: this.boxPath }, envUnset })
    );
  }

  /**
   * A fresh access token for the launch's account (spec §7) — never a refresh token. Claude's
   * expiry is tracked for the restart-before-expiry policy. Fails with a {@link BoxLaunchError}.
   */
  async token(minValidSeconds = BOX_TOKEN_MIN_VALID_SECONDS, signal?: AbortSignal): Promise<AgentTokenGrant> {
    const agent = this.input.agent;
    if (!isTokenAgent(agent)) {
      throw new BoxLaunchError("BOX_UNSUPPORTED", "This agent does not use Orquester-managed logins in a box.");
    }
    let grant: AgentTokenGrant;
    try {
      grant = await this.host.tokens.getToken(
        { boxId: this.box.boxId, agent, accountId: this.accountId, minValidSeconds },
        signal ?? this.input.signal
      );
    } catch (error) {
      const message = error instanceof BoxDaemonCallError ? error.message : describeBoxFailure(error);
      throw new BoxLaunchError("BOX_TOKEN_UNAVAILABLE", `Orquester could not hand the box a login for this account: ${message}`);
    }
    if (agent === "claude") this.host.tracker.note(this.threadId, grant.expiresAt);
    return grant;
  }

  /**
   * A login the CLI reads from a file in the box (Claude's refresh-token-free
   * `.credentials.json`): written now from a fresh grant, and rewritten by
   * {@link refreshCredentials} whenever the token runs short.
   */
  async installCredentials(write: (grant: AgentTokenGrant) => Promise<void>): Promise<void> {
    const grant = await this.token();
    await write(grant);
    this.credentialWriter = write;
    this.host.credentialLaunches.set(this.threadId, this);
  }

  /**
   * Rewrite the login file when the token has less than the restart margin left
   * (`token-policy.ts`). Serialized; a failure while the old token is still good is logged, not
   * thrown — the turn goes ahead on it — and one with the token already expired fails the turn.
   */
  refreshCredentials(): Promise<void> {
    const write = this.credentialWriter;
    if (write === null || this.closed || !this.host.tracker.stale(this.threadId)) return this.credentialWork;
    this.credentialWork = this.credentialWork.then(async () => {
      if (this.closed || !this.host.tracker.stale(this.threadId)) return;
      try {
        await write(await this.token());
      } catch (error) {
        const remaining = this.host.tracker.remainingMs(this.threadId);
        if (remaining !== null && remaining <= 0) throw error;
        this.host.logger.warn(`box ${this.box.boxId}: could not renew the login of ${this.threadId}; it keeps the current one`, error);
      }
    });
    const work = this.credentialWork;
    this.credentialWork = work.catch(() => undefined);
    return work;
  }

  /** Write `content` into the box at `hostPath`'s mapped path (parents created); answers the box path. */
  async writeFile(hostPath: string, content: string | Uint8Array, mode = 0o600): Promise<string> {
    const target = this.toBox(hostPath);
    await this.connection.writeFile(target, content, { mode, mkdirs: true });
    return target;
  }

  /** Copy a host file (an attachment) into the box at the same (mapped) path; answers the box path. */
  async copyIn(hostPath: string): Promise<string> {
    const target = this.toBox(hostPath);
    await this.connection.writeFile(target, createReadStream(hostPath), { mode: 0o600, mkdirs: true });
    return target;
  }

  /**
   * The adapter context a box session resolves attachments through: each one a turn names is
   * copied into the box at its own (mapped) path before the turn, and named by that box path;
   * the attachments dir is the box's too.
   */
  adapterContext(context: AdapterContext): AdapterContext {
    return {
      ...context,
      resolveAttachmentPath: async (threadId, attachmentId) =>
        this.copyIn(await context.resolveAttachmentPath(threadId, attachmentId)),
      attachmentsDir: (threadId) => this.toBox(context.attachmentsDir(threadId))
    };
  }

  /** Create directories in the box (mapped), owned by its working user. */
  async ensureDirs(hostPaths: readonly string[]): Promise<void> {
    if (hostPaths.length === 0) return;
    await this.connection.request("agent.ensurePaths", { paths: hostPaths.map((path) => this.toBox(path)) });
  }

  /** The server names the owner switched to "Run in box" for this agent (Agent config, and the chat's profile). */
  runInBoxNames(): Promise<Set<string>> {
    return this.host.runInBoxNames(this.input.agent, this.input.profile);
  }

  /**
   * Plan the launch's MCP servers (`mcp-plan.ts`) and register every bridged one, so the box's
   * `orq-agent mcp-bridge <serverId>` reaches the real server here. The adapter writes the plan
   * into its CLI's config.
   */
  async bridgeMcpServers(
    servers: readonly McpServerSpec[],
    options: {
      /**
       * `launch` (default): the registrations end with this launch ({@link close}). `caller`: the
       * caller ends them with `release` — a shared server (OpenCode's) outlives the thread whose
       * launch started it.
       */
      owner?: "launch" | "caller";
    } = {}
  ): Promise<BoxMcpBridgeResult> {
    const runInBox = await this.runInBoxNames();
    const plan = planMcpBridges(servers, { runInBox, sys: this.sys });
    const owned = options.owner !== "caller";
    const ids: string[] = [];
    for (const server of plan.bridged) {
      await this.register(server.name, server.serverId, server.target, owned);
      ids.push(server.serverId);
    }
    const release = owned
      ? () => Promise.resolve()
      : () => removeMcpBridgeEntries(this.host.appdir, this.box.boxId, ids).catch(() => undefined);
    return { ...plan, runInBox, release };
  }

  /**
   * Bridge one HTTP endpoint on this machine — Orquester's own session-tool endpoint — into the
   * box: its credential stays here, in the bridge's request headers, and the box's CLI runs
   * `orq-agent mcp-bridge <serverId>` as a stdio server. No box port, no Host-header exception.
   */
  async bridgeHttp(name: string, url: string, headers: Record<string, string>): Promise<{ command: string; args: string[] }> {
    const serverId = newMcpBridgeServerId();
    await this.register(name, serverId, { transport: "http", url, headers });
    return mcpBridgeArgv(this.sys, serverId);
  }

  private async register(
    name: string,
    serverId: string,
    target: Parameters<typeof writeMcpBridgeEntry>[1]["target"],
    owned = true
  ): Promise<void> {
    if (this.closed && owned) throw new BoxLaunchError("BOX_UNAVAILABLE", "This box launch has already ended.");
    await writeMcpBridgeEntry(this.host.appdir, {
      version: MCP_BRIDGE_ENTRY_VERSION,
      boxId: this.box.boxId,
      serverId,
      name,
      threadId: this.threadId,
      target,
      createdAt: new Date(this.host.now()).toISOString()
    });
    if (owned) this.bridgeIds.push(serverId);
  }

  /** The Grok `auth_provider_command` for this launch's account (`orq-agent token grok`, spec §7). */
  grokAuthCommand(): string {
    const agentPath = this.sys.agentPath;
    const quoted = this.sys.os === "win32" ? `"${agentPath.replace(/"/g, "")}"` : `'${agentPath.replace(/'/g, "'\\''")}'`;
    const account = this.accountId.replace(/[^A-Za-z0-9._-]/g, "");
    return `${quoted} token grok --account ${account}`;
  }

  /** The session ended: its bridge registrations go, and so does its token tracking. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.host.tracker.forget(this.threadId);
    if (this.host.credentialLaunches.get(this.threadId) === this) this.host.credentialLaunches.delete(this.threadId);
    const ids = this.bridgeIds.splice(0);
    await removeMcpBridgeEntries(this.host.appdir, this.box.boxId, ids).catch((error: unknown) => {
      this.host.logger.warn(`box ${this.box.boxId}: could not remove the session's MCP bridge entries`, error);
    });
  }
}

/** What a box thread's turn end hands {@link AgentHostBoxes.turnEnded} (the orchestrator's hook). */
export interface BoxTurnEnd {
  threadId: string;
  adapter: AgentAdapterId;
  cwd: string;
  box: HostThreadBox;
  profile?: HostThreadProfile;
  launchEnv?: Record<string, string>;
  homePath?: string;
  resumeCursor: unknown;
}

export interface AgentHostBoxes {
  /** Prepare one CLI start in a box. Rejects with a {@link BoxLaunchError} the chat shows. */
  launch(input: BoxLaunchInput): Promise<BoxLaunch>;
  /**
   * The orchestrator's `onTurnEnded` for a box thread: mirror the transcript, close the change
   * set, and renew a login file that runs short (Claude).
   */
  turnEnded(input: BoxTurnEnd): void;
  /** The checkpoint service's git runner for a box project's repository. */
  gitRunner(box: HostThreadBox): Promise<GitRunner>;
}

export interface AgentHostBoxesOptions {
  appdir: string;
  /** `connectBoxRelay` (production) or a test double; null: box threads fail with a clear message. */
  connector: BoxConnector | null;
  tokens: BoxTokenSource;
  sync: BoxSyncClient;
  logger: AdapterLogger;
  now?: () => number;
  connectTimeoutMs?: number;
  /** Install commands by agent instead of the registry's (tests: a stand-in CLI, no network). */
  installCommands?: Partial<Record<AgentAdapterId, string>>;
}

/** The session ref a resume cursor names, per adapter (Claude `resume`, Codex `threadId`, Grok/OpenCode `sessionId`). */
export function boxSessionRefOf(adapter: AgentAdapterId, cursor: unknown): string | null {
  if (typeof cursor !== "object" || cursor === null) return null;
  const record = cursor as Record<string, unknown>;
  const value = adapter === "claude" ? record.resume : adapter === "codex" ? record.threadId : record.sessionId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The directory a box thread's CLI reads its config and writes its transcripts in (host path). */
export function boxConfigRootOf(input: {
  adapter: AgentAdapterId;
  homePath?: string;
  launchEnv?: Record<string, string>;
  profile?: HostThreadProfile;
}): string | null {
  // A Codex profile chat runs with CODEX_HOME = its prepared home (`adapters/codex/profile.ts`).
  if (input.adapter === "codex" && input.profile !== undefined) return input.profile.preparedDir;
  return input.launchEnv?.[ACCOUNT_HOME_ENV_VAR[input.adapter]] ?? input.homePath ?? null;
}

class AgentHostBoxesImpl implements AgentHostBoxes {
  readonly appdir: string;
  readonly tokens: BoxTokenSource;
  readonly sync: BoxSyncClient;
  readonly logger: AdapterLogger;
  readonly tracker: BoxTokenTracker;
  readonly now: () => number;
  private readonly pool: BoxConnectionPool;
  private readonly connectTimeoutMs: number | undefined;
  private readonly installCommands: Partial<Record<AgentAdapterId, string>> | undefined;
  /** One install (or lookup) of a CLI per box at a time. */
  private readonly cliLookups = new Map<string, Promise<{ bin: string; path: string }>>();
  private readonly versions = new Map<string, Promise<string | null>>();
  private readonly gitRunners = new Map<string, Promise<GitRunner>>();
  /** The live launch of each thread whose CLI reads its login from a file in the box (Claude). */
  readonly credentialLaunches = new Map<string, BoxLaunch>();
  private procSeq = 0;

  constructor(options: AgentHostBoxesOptions) {
    this.appdir = options.appdir;
    this.tokens = options.tokens;
    this.sync = options.sync;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.tracker = new BoxTokenTracker(this.now);
    this.pool = new BoxConnectionPool(options.connector);
    this.connectTimeoutMs = options.connectTimeoutMs;
    this.installCommands = options.installCommands;
  }

  /** A detached process id: unique per launch, readable in the box's process list. */
  newProcId(input: Pick<BoxLaunchInput, "threadId" | "agent">): string {
    this.procSeq += 1;
    return `${this.procIdPrefix(input)}${this.now().toString(36)}-${this.procSeq.toString(36)}`;
  }

  cachedVersion(connection: BoxConnection, bin: string, probe: () => Promise<string | null>): Promise<string | null> {
    const key = `${connection.boxId}\u0000${bin}`;
    let entry = this.versions.get(key);
    if (entry === undefined) {
      entry = probe();
      this.versions.set(key, entry);
      // An unreadable version is asked again next time (the box may have been reinstalling).
      void entry.then((value) => {
        if (value === null) this.versions.delete(key);
      });
    }
    return entry;
  }

  async launch(input: BoxLaunchInput): Promise<BoxLaunch> {
    const accountId = input.home.kind === "account" ? (input.home.accountId ?? "") : "";
    // Spec §7: the System account (the daemon user's own CLI logins) never runs in a box — its
    // tokens are refreshed outside Orquester, so the broker cannot hand one out safely.
    if (isTokenAgent(input.agent) && accountId.length === 0) {
      throw new BoxLaunchError(
        "BOX_SYSTEM_ACCOUNT",
        "Chats in a box project run with an Orquester-managed account. Pick an account for this chat (Settings → Accounts adds one), then send the message again."
      );
    }
    const connection = await this.pool.get(input.box, {
      ...(this.connectTimeoutMs !== undefined ? { timeoutMs: this.connectTimeoutMs } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {})
    });
    // The live connection's facts win: a re-provisioned agent may report a new path.
    const box: HostThreadBox = { ...input.box, sys: connection.sys, paths: connection.paths };

    if (input.sync !== false) {
      const configRoots = [input.configRoot ?? input.home.path, ...(input.profile !== undefined ? [input.profile.preparedDir] : [])].filter(
        (root, index, all): root is string => typeof root === "string" && root.length > 0 && all.indexOf(root) === index
      );
      try {
        input.onProgress?.("Syncing the agent configuration into the box…");
        await this.sync.ensureSynced(box.boxId, { agent: input.agent, configRoots, threadId: input.threadId }, input.signal);
        const sessionRef = input.resumeSessionRef ?? null;
        if (sessionRef !== null) {
          await this.sync.pushForResume(
            box.boxId,
            { agent: input.agent, configRoot: input.configRoot ?? input.home.path, cwd: input.cwd, sessionRef },
            input.signal
          );
        }
      } catch (error) {
        throw new BoxLaunchError(
          "BOX_SYNC_FAILED",
          `The agent's configuration could not be synced into the box, so it was not started: ${describeBoxFailure(error)}`
        );
      }
    }

    if (input.sync !== false && input.agent !== "opencode") await this.sweepThreadProcs(connection, input);
    const cli = await this.resolveCli(connection, input);
    return new BoxLaunch(this, input, connection, box, cli.bin, cli.path, accountId);
  }

  /**
   * A thread starts its CLI only once its previous session is gone (one live session per
   * thread), so a detached process of the thread still running in the box is a leftover: a host
   * that died without its teardown never stopped it, and nothing would ever reattach to it. It
   * is stopped here, before the new one starts (never OpenCode's, whose server a project's
   * threads share). Best-effort: a box that cannot list its processes keeps them.
   */
  private async sweepThreadProcs(connection: BoxConnection, input: BoxLaunchInput): Promise<void> {
    const prefix = this.procIdPrefix(input);
    const procs = await connection.request("proc.list", {}).catch(() => []);
    for (const proc of procs) {
      if (!proc.procId.startsWith(prefix)) continue;
      if (proc.running) {
        this.logger.warn(`box ${connection.boxId}: stopping a ${input.agent} process an earlier host left running for ${input.threadId}`);
        await connection.request("proc.signal", { procId: proc.procId, signal: "SIGKILL" }).catch(() => undefined);
      }
      await connection.request("proc.release", { procId: proc.procId }).catch(() => undefined);
    }
  }

  /** Every detached process id of a thread's agent starts with this. */
  private procIdPrefix(input: Pick<BoxLaunchInput, "threadId" | "agent">): string {
    const thread = input.threadId.replace(/[^A-Za-z0-9-]/g, "").slice(0, 36);
    return `agent-${input.agent}-${thread}-`;
  }

  private resolveCli(connection: BoxConnection, input: BoxLaunchInput): Promise<{ bin: string; path: string }> {
    const key = `${connection.boxId}\u0000${input.agent}`;
    let entry = this.cliLookups.get(key);
    if (entry === undefined) {
      entry = (async () => {
        const path = await boxLoginPath(connection);
        const installCommand = this.installCommands?.[input.agent];
        const found = await ensureBoxAgentCli(connection, input.agent, {
          path,
          ...(input.onProgress !== undefined ? { onProgress: input.onProgress } : {}),
          ...(installCommand !== undefined ? { installCommand } : {})
        });
        if (found.installed) this.versions.clear();
        return { bin: found.bin, path: found.path };
      })();
      this.cliLookups.set(key, entry);
      // A failed lookup (an install that did not work) is tried again on the next start; a found
      // CLI is re-checked then too, so an uninstall in the box is noticed.
      void entry.then(
        () => this.cliLookups.delete(key),
        () => this.cliLookups.delete(key)
      );
    }
    return entry;
  }

  turnEnded(input: BoxTurnEnd): void {
    // A login file that runs short is renewed while the CLI is between turns.
    void this.credentialLaunches
      .get(input.threadId)
      ?.refreshCredentials()
      .catch((error: unknown) => {
        this.logger.warn(`box ${input.box.boxId}: the login of ${input.threadId} could not be renewed after its turn`, error);
      });
    const configRoot = boxConfigRootOf({
      adapter: input.adapter,
      ...(input.homePath !== undefined ? { homePath: input.homePath } : {}),
      ...(input.launchEnv !== undefined ? { launchEnv: input.launchEnv } : {}),
      ...(input.profile !== undefined ? { profile: input.profile } : {})
    });
    const boxId = input.box.boxId;
    void (async () => {
      if (configRoot !== null) {
        await this.sync
          .pullAfterTurn(boxId, {
            agent: input.adapter,
            configRoot,
            cwd: input.cwd,
            sessionRef: boxSessionRefOf(input.adapter, input.resumeCursor)
          })
          .catch((error: unknown) => {
            this.logger.warn(`box ${boxId}: the transcript of ${input.threadId} could not be mirrored back after its turn`, error);
          });
      }
      await this.sync.turnEnded(boxId, input.threadId).catch((error: unknown) => {
        this.logger.warn(`box ${boxId}: the turn's configuration changes of ${input.threadId} could not be collected`, error);
      });
    })();
  }

  gitRunner(box: HostThreadBox): Promise<GitRunner> {
    let entry = this.gitRunners.get(box.boxId);
    if (entry === undefined) {
      entry = (async () => {
        const connection = await this.pool.get(box);
        return createBoxGitRunner({ connection, path: await boxLoginPath(connection) });
      })();
      this.gitRunners.set(box.boxId, entry);
      entry.catch(() => {
        if (this.gitRunners.get(box.boxId) === entry) this.gitRunners.delete(box.boxId);
      });
    }
    return entry;
  }

  /** The "Run in box" switches for `agent`: Agent config's (`box-mcp.json`) plus the profile's own items. */
  async runInBoxNames(agent: AgentAdapterId, profile: HostThreadProfile | undefined): Promise<Set<string>> {
    const names = new Set<string>();
    try {
      for (const name of runInBoxServerNames(JSON.parse(await readFile(boxMcpSettingsPath(this.appdir), "utf8")) as unknown, agent)) {
        names.add(name);
      }
    } catch {
      // No switches set: every server runs on the host.
    }
    if (profile !== undefined) {
      try {
        const manifest = JSON.parse(await readFile(join(sessionProfileDir(this.appdir, profile.profileId), "profile.json"), "utf8")) as unknown;
        const items = (manifest as { items?: unknown }).items;
        for (const item of Array.isArray(items) ? items : []) {
          const record = item as { kind?: unknown; name?: unknown; enabled?: unknown; mcp?: { runInBox?: unknown } };
          if (record?.kind === "mcp" && typeof record.name === "string" && record.enabled !== false && record.mcp?.runInBox === true) {
            names.add(record.name);
          }
        }
      } catch {
        // An unreadable profile source runs its servers on the host — the safe default.
      }
    }
    return names;
  }
}

export function createAgentHostBoxes(options: AgentHostBoxesOptions): AgentHostBoxes {
  return new AgentHostBoxesImpl(options);
}

/** The context's box support, or the error a box thread's start fails with without it. */
export function requireBoxes(context: { boxes?: AgentHostBoxes }): AgentHostBoxes {
  if (context.boxes === undefined) {
    throw new BoxLaunchError(
      "BOX_UNAVAILABLE",
      "This chat's project runs in a box, and this agent host cannot start agents in boxes. It picks that up when it restarts after the next Orquester update."
    );
  }
  return context.boxes;
}

/** A remote child's outcome is a local one's: re-exported for adapters that only import this module. */
export type { ChildExitReason, BoxProviderChild };
