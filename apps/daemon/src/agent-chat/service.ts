/**
 * The daemon-side agent-chat service: one object `startDaemon` creates, wires
 * and stops.
 *
 * It owns the supervisor (§3.1), the host client, the chat tab records (§5.2),
 * the coarse summary subscription (§6.4) and the route dependencies of
 * §6.2/§6.3. `index.ts` keeps only the boot order and the `/api/sessions`
 * lifecycle glue, exactly as it does for cliproxy.
 */

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { readCodeStamp } from "../agent-host/support/code-stamp.ts";
import { randomUUID } from "node:crypto";
import type {
  AgentAdapterId,
  CreateAgentChatSessionFields,
  CreateSessionRequest,
  RegistryEntry,
  SessionSummary, AgentAccount } from "@orquester/api";
import { SYSTEM_ACCOUNT_ID } from "@orquester/api";
import type { AgentChatHome, RuntimePlatform } from "@orquester/config";
import { agentHostSocketPath, agentHostTokenPath } from "@orquester/config";
import {
  AGENT_HOST_HEALTH_INTERVAL_MS,
  agentHostRoutes,
  type AgentHostHealthResponse,
  type CreateHostThreadRequest,
  type SetThreadIdentityRequest
} from "../agent-host/host-protocol.ts";
import { Transform, type Readable } from "node:stream";
import { MAX_UPLOAD_BYTES } from "@orquester/api";
import { UploadTooLargeError } from "../upload-stream.ts";
import { isAgentAdapterId } from "../agent-host/adapters/index.ts";
import { agentHostExtraRoutes } from "../agent-host/server/extra-routes.ts";
import { ACCOUNT_HOME_ENV_VAR } from "../agent-host/support/env.ts";
import type { SessionIndexContributor } from "../sessions.ts";
import { ChatSessionManager, ChatSessionError } from "./chat-sessions.ts";
import { AgentHostClient, HostUnavailableError } from "./host-client.ts";
import { markClaudeProjectTrusted } from "./home-prep.ts";
import type { FastifyReply } from "fastify";
import type { AgentChatRouteDeps } from "./proxy-routes.ts";
import { AgentChatSummaryService, type SummaryBroadcaster, type SummaryPush } from "./summary.ts";
import {
  AgentHostSupervisor,
  buildAgentHostEnv,
  type DirectHostHandle,
  type ProbeOutcome,
  type SupervisorTmux
} from "./supervisor.ts";

/**
 * A conversation id may only ever be a real history-file name. The same shape
 * `resumeLaunchArgs` enforces for a terminal launch — the leading char excludes
 * `-` so an id can never arrive at a provider as a flag.
 */
const CONVERSATION_ID = /^[\w.][\w.\-/]*$/;

/**
 * How long one adapter is left alone after a registry-driven provider refresh.
 *
 * An install, an update and the version re-detection that follows are three
 * separate registry events for the same binary; the window collapses them into
 * one probe and makes a flapping detector unable to loop. It is only ever a
 * *nudge* — the host re-probes a moved binary on its next read anyway
 * (`orchestration/provider-snapshots.ts`), so a dropped nudge costs latency,
 * never correctness.
 */
export const PROVIDER_REFRESH_DEBOUNCE_MS = 10_000;

/**
 * Deadline on the refresh hop. Wider than the host's own 10 s auth probe so a
 * provider that must start a server first (OpenCode) still fits, and finite
 * because nothing else bounds a fire-and-forget call.
 */
const PROVIDER_REFRESH_DEADLINE_MS = 30_000;

/** One launch-env contribution, mirroring `index.ts`'s `LaunchEnv`. */
export interface ChatLaunchEnv {
  env: Record<string, string>;
  unset?: string[];
  accountId?: string;
}

export interface AgentChatServiceOptions {
  /** `<appdir>`. */
  baseDir: string;
  daemonDir: string;
  platform: RuntimePlatform;
  /** cwd for the host process (the repo root the daemon runs from). */
  cwd: string;
  /** The wider session PATH, so the host resolves user-installed CLIs. */
  sessionPath: string;
  /** The daemon's own env, read ONLY for the four vars §8 names. */
  env: NodeJS.ProcessEnv;
  tmux: SupervisorTmux | null;
  broadcaster: SummaryBroadcaster;
  push: SummaryPush;
  /** Resolve the registry entry a chat tab launches from. */
  registryEntry(refId: string): RegistryEntry | undefined;
  /**
   * The SAME launch env a terminal launch of this entry would get today —
   * account home, cliproxy env for claudex/claudemix, model pin, timeouts
   * (§3.1 "Launch environment"). `index.ts` passes its own `resolveExtraEnv`
   * body so the two can never drift.
   */
  resolveLaunchEnv(
    entry: RegistryEntry,
    ctx: { accountId?: string; model?: string }
  ): Promise<ChatLaunchEnv | null>;
  /** The system Claude config file, when no `CLAUDE_CONFIG_DIR` is in play. */
  systemClaudeConfigFile(): string;
  /**
   * Confine a client-supplied project path to the workspaces sandbox and
   * realpath it, or answer null. The ONLY path a chat launch is allowed to
   * grant Claude project trust for — see `prepareHome`.
   */
  resolveTrustedProjectDir(projectPath: string): Promise<string | null>;
  /**
   * Stream a host-resolved attachment to the client. `index.ts` owns it
   * because the `Content-Disposition` / streaming conventions live there with
   * the other download routes.
   */
  sendAttachment(reply: FastifyReply, path: string): Promise<unknown>;
  /** Managed accounts + family defaults, for the §7.7 auth overlay (see `provider-auth-overlay.ts`). */
  listManagedAccounts?(): { accounts: AgentAccount[]; defaults?: Partial<Record<AgentAccount["agent"], string | null>> };
  /**
   * `index.ts`'s `seededAccountRefusal`, injected rather than imported so the
   * service does not depend on the daemon entry point. A switch has to apply
   * exactly the gate a create does, or a claudex tab could be re-pointed at an
   * account the proxy has no auth file for and every later turn would 502.
   */
  seededAccountRefusal?(
    input: { refId: string; accountId?: string },
    model: string | undefined
  ): { code: string; message: string } | null;
  logger?: {
    log?: (...a: unknown[]) => void;
    warn?: (...a: unknown[]) => void;
    error?: (...a: unknown[]) => void;
  };
  /** Test seam: overrides `process.execPath`. */
  nodeBin?: string;
  mainPath?: string;
  /**
   * Test seam for the no-tmux spawn. Production leaves it unset and gets the
   * real child; a test that supplies it can never start a host process.
   */
  spawnDirect?: (bin: string, args: string[], env: Record<string, string>) => DirectHostHandle;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * `POST /api/sessions` with `kind: "agent-chat"`.
 *
 * The §6.1 extras ride the nested `chat` block the client sends; the flattened
 * spelling is still accepted so a socket/curl caller (and an older bundle) is
 * not a 400.
 */
export type CreateAgentChatRequest = CreateSessionRequest & Partial<CreateAgentChatSessionFields>;

/** Read §6.1's fields from either spelling, nested first. */
function chatFields(req: CreateAgentChatRequest): Partial<CreateAgentChatSessionFields> {
  return {
    ...(req.modelSelection !== undefined ? { modelSelection: req.modelSelection } : {}),
    ...(req.runtimeMode !== undefined ? { runtimeMode: req.runtimeMode } : {}),
    ...(req.resume !== undefined ? { resume: req.resume } : {}),
    ...(req.chat ?? {})
  };
}

export class AgentChatService {
  readonly chat: ChatSessionManager;
  readonly client: AgentHostClient;
  readonly supervisor: AgentHostSupervisor;
  readonly summary: AgentChatSummaryService;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private directHandle: DirectHostHandle | null = null;
  private readonly socketPath: string;

  constructor(private readonly opts: AgentChatServiceOptions) {
    this.socketPath = agentHostSocketPath(opts.baseDir, opts.platform);
    this.chat = new ChatSessionManager({ requestPersist: () => this.requestPersist() });
    this.client = new AgentHostClient({
      socketPath: this.socketPath,
      token: () => this.supervisor.currentToken()
    });
    this.supervisor = new AgentHostSupervisor({
      appdir: opts.baseDir,
      tokenPath: agentHostTokenPath(opts.baseDir),
      cwd: opts.cwd,
      env: buildAgentHostEnv({
        sessionPath: opts.sessionPath,
        tmpdir: opts.env.TMPDIR,
        home: opts.env.HOME ?? homedir(),
        npmConfigPrefix: opts.env.NPM_CONFIG_PREFIX,
        appdir: opts.baseDir,
        socketPath: this.socketPath
      }),
      nodeBin: opts.nodeBin ?? process.execPath,
      mainPath: opts.mainPath,
      // The daemon's own commit, read at boot; a surviving host reporting a
      // different one is drained and replaced (see `support/code-stamp.ts`).
      codeStamp: readCodeStamp(opts.cwd),
      adapters: {
        probe: () => this.probe(),
        requestStop: () => this.requestHostStop(),
        tmux: opts.tmux,
        spawnDirect: (bin, args, env) => {
          if (opts.spawnDirect) {
            this.directHandle = opts.spawnDirect(bin, args, env);
            return this.directHandle;
          }
          const child = spawn(bin, args, { cwd: opts.cwd, detached: false, stdio: "ignore", env });
          child.on("error", (error) => opts.logger?.error?.("agent host spawnDirect failed", error));
          const handle: DirectHostHandle = { kill: () => child.kill(), pid: child.pid };
          // Clear the handle when the child dies, or `protectedPids()` keeps
          // returning a pid the OS may recycle onto an unrelated process — and
          // `POST /api/system/processes/kill` would then refuse a legitimate
          // target for no visible reason.
          child.on("exit", () => {
            if (this.directHandle === handle) this.directHandle = null;
          });
          this.directHandle = handle;
          return handle;
        },
        now: opts.now ?? Date.now,
        sleep: opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
        // The host's OWN refresh (§4.6.4) reaches the bus through here; the
        // explicit refresh route publishes separately.
        onProvidersRevision: () => this.summary.publishProvidersChanged(),
        logger: opts.logger
      }
    });
    this.summary = new AgentChatSummaryService({
      client: this.client,
      chat: this.chat,
      broadcaster: opts.broadcaster,
      push: opts.push,
      now: opts.now,
      logger: opts.logger,
      // The poll idles while the host is restarting or foreign: every chat
      // route answers 503 then anyway, and a read would only log noise.
      isHostHealthy: () => this.supervisor.isHealthy(),
      // A settled turn reopens the §3.1 drain window, so a deploy's version
      // handover happens the moment the host goes quiet.
      onTurnSettled: () => this.supervisor.handleTurnSettled()
    });
  }

  /** Persisting is the PTY manager's job; `index.ts` injects the callback. */
  private persist: () => void = () => undefined;

  setPersist(persist: () => void): void {
    this.persist = persist;
  }

  private requestPersist(): void {
    try {
      this.persist();
    } catch (error) {
      this.opts.logger?.error?.("failed to persist agent-chat tabs", error);
    }
  }

  /**
   * The §5.2 contributor the session manager writes and reads our records
   * through. `owns` is what keeps a chat record out of the tmux reattach and
   * out of the orphan reap.
   */
  indexContributor(): SessionIndexContributor {
    return {
      records: () => this.chat.records(),
      adopt: (records) => this.chat.adopt(records),
      owns: (record) => record.kind === "agent-chat",
      pendingThreadDeletes: () => this.chat.pendingThreadDeletes(),
      adoptPendingThreadDeletes: (ids) => this.chat.adoptPendingDeletes(ids)
    };
  }

  /** Boot: adopt or spawn the host, then start the coarse subscription. */
  async init(): Promise<void> {
    await this.supervisor.init();
    // Clear the durable delete queue as soon as a host is adopted, and again on
    // every later adoption (a respawn or the drain-restart).
    await this.replayPendingThreadDeletes();
    this.supervisor.onChange((status) => {
      if (status.state === "healthy") {
        void this.replayPendingThreadDeletes();
      }
    });
    this.summary.start();
    // `.catch`, never a bare `void`: a rejection here would be unhandled, and
    // Node ≥15 exits the process on one — taking every live terminal, `/events`
    // stream and WebSocket with it. Supervision failures are logged and retried
    // on the next tick, which is the whole point of the interval.
    this.healthTimer = setInterval(() => {
      this.supervisor
        .checkHealth()
        .catch((error) => this.opts.logger?.error?.("agent host health check failed", error));
    }, AGENT_HOST_HEALTH_INTERVAL_MS);
    this.healthTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    await this.summary.stopAndWait();
    this.supervisor.stop();
  }

  /** Pids `/api/system/processes/kill` must refuse (§3.1 "Kill guard"). */
  protectedPids(): number[] {
    return this.supervisor.protectedPids();
  }

  // --- §3.2 the registry moved a CLI under the host ------------------------

  /** The version each chat-capable registry entry was last seen at. */
  private readonly registryVersions = new Map<string, string>();
  /** The install state each chat-capable entry was last seen in. */
  private readonly registryInstallStates = new Map<string, RegistryEntry["installState"]>();
  /** When each adapter was last nudged, on the injected clock. */
  private readonly providerRefreshAt = new Map<AgentAdapterId, number>();
  /** In-flight nudges — the idempotence guard AND the §9 drain seam. */
  private readonly providerRefreshInFlight = new Map<AgentAdapterId, Promise<void>>();

  /**
   * A registry entry changed — ask the host to re-probe the provider it maps to.
   *
   * The incident: `claude` was updated from Settings → Agents (2.1.278 →
   * 2.1.280, which resolves the `opus` alias to a different model) and a chat
   * opened afterwards still offered the old alias, because the host's snapshot
   * was the one probed under the old binary and **nothing told it the CLI had
   * changed**. The daemon is the one process that knows an install just
   * happened, so it says so.
   *
   * Two arms, one debounce:
   * - the install/update itself, as `installState` settles from `installing`
   *   back to `idle` — the moment `RegistryService.runManaged` has re-resolved
   *   the bin and kicked its own version detection;
   * - a version that MOVED for an entry with a chat adapter, which also covers
   *   a CLI updated outside the registry entirely.
   *
   * A first sighting is never a change: the host's own boot probe already owns
   * boot. `claudex`/`claudemix` need no special case — their catalog rows carry
   * `chat.adapter: "claude"`, so they nudge the same provider the launcher runs.
   */
  onRegistryEntryChanged(entry: RegistryEntry): void {
    const adapter = entry.chat?.adapter;
    if (!adapter) {
      // §5.3: a row with no chat adapter has no provider to refresh.
      return;
    }
    const previousState = this.registryInstallStates.get(entry.id);
    this.registryInstallStates.set(entry.id, entry.installState);
    const previousVersion = this.registryVersions.get(entry.id);
    // `undefined` is "not detected yet" — `runManaged` clears the version
    // before re-detecting it — and must never be read as a change, nor forget
    // the version we knew.
    if (entry.version !== undefined) {
      this.registryVersions.set(entry.id, entry.version);
    }

    const installed = previousState === "installing" && entry.installState === "idle";
    const moved =
      entry.version !== undefined &&
      previousVersion !== undefined &&
      previousVersion !== entry.version;
    if (!installed && !moved) {
      return;
    }
    this.refreshProvider(
      adapter,
      installed ? `${entry.id} install/update finished` : `${entry.id} version moved`
    );
  }

  /**
   * Nudge the host to re-probe one provider. **Fire-and-forget**: it is never
   * awaited by the route that triggered it, and a failure is logged and dropped
   * — an install response must never fail because the host was busy.
   *
   * A refresh that actually changed something publishes the same coarse
   * `agent.providers.changed` the manual `POST /api/agent/providers/:id/refresh`
   * does, so an open client re-reads §6.3 exactly as it does today. (The host
   * also bumps `providersRevision`, which the supervisor's health poll turns
   * into the same event — this only makes it immediate.)
   */
  refreshProvider(adapterId: AgentAdapterId, reason: string): void {
    if (this.providerRefreshInFlight.has(adapterId)) {
      return;
    }
    if (!this.supervisor.isHealthy()) {
      // Every host route answers 503 now, and a host that comes up later probes
      // every provider at boot anyway.
      return;
    }
    const now = (this.opts.now ?? Date.now)();
    const last = this.providerRefreshAt.get(adapterId);
    if (last !== undefined && now - last < PROVIDER_REFRESH_DEBOUNCE_MS) {
      return;
    }
    this.providerRefreshAt.set(adapterId, now);
    const task = this.client
      .json<{ changed?: boolean }>(
        "POST",
        agentHostRoutes.providerRefresh(adapterId),
        {},
        { timeoutMs: PROVIDER_REFRESH_DEADLINE_MS }
      )
      .then((response) => {
        if (response.value?.changed === true) {
          this.summary.publishProvidersChanged({ adapterId });
        }
      })
      .catch((error: unknown) => {
        this.opts.logger?.warn?.(
          `agent host provider refresh failed for ${adapterId} (${reason})`,
          error
        );
      })
      .finally(() => {
        this.providerRefreshInFlight.delete(adapterId);
      });
    this.providerRefreshInFlight.set(adapterId, task);
  }

  /** Await every in-flight provider nudge. The §9 drain seam a test waits on. */
  async drainProviderRefreshes(): Promise<void> {
    while (this.providerRefreshInFlight.size > 0) {
      await Promise.all([...this.providerRefreshInFlight.values()]).catch(() => undefined);
    }
  }

  routeDeps(): AgentChatRouteDeps {
    return {
      client: this.client,
      isHostHealthy: () => this.supervisor.isHealthy(),
      chatSession: (id) => this.chat.get(id),
      noteSeq: (id, seq) => this.chat.noteSeq(id, seq),
      switchAccount: (id, body) => this.switchAccount(id, body),
      restartHost: async () => {
        this.lastMarkedThreadIds = [];
        const hostInstanceId = await this.supervisor.restartNow();
        return { hostInstanceId, markedThreadIds: this.lastMarkedThreadIds };
      },
      onProvidersChanged: (adapterId) =>
        this.summary.publishProvidersChanged(
          isAgentAdapterId(adapterId) ? { adapterId } : {}
        ),
      attachmentPath: (sessionId, attachmentId) => this.attachmentPath(sessionId, attachmentId),
      sendAttachment: (reply, path) => this.opts.sendAttachment(reply, path),
      ...(this.opts.listManagedAccounts
        ? { managedAccounts: () => this.opts.listManagedAccounts!() }
        : {}),
      logger: this.opts.logger
    };
  }

  /** Threads the OLD host marked for continuation on its way out (§3.3). */
  private lastMarkedThreadIds: string[] = [];

  // --- §6.1 lifecycle ------------------------------------------------------

  /**
   * Create a chat tab and its thread (§6.1). **Order is fixed**: the tab record
   * is written first, so a failed first turn leaves an empty thread the user
   * retries into rather than a half-created tab. A host that refuses the thread
   * rolls the tab back, because a tab pointing at no thread is worse than none.
   */
  async createSession(req: CreateAgentChatRequest, order: number): Promise<SessionSummary> {
    const entry = this.opts.registryEntry(req.refId);
    if (!entry?.resolvedBin || !entry.enabled) {
      throw new ChatSessionError(`Registry entry "${req.refId}" is not available.`);
    }
    const adapter = entry.chat?.adapter;
    if (!adapter) {
      // §5.3: an agent row without `chat` cannot open a chat tab.
      throw new ChatSessionError(`"${entry.name}" has no chat adapter.`);
    }
    const fields = chatFields(req);
    if (fields.resume && !isUsableConversationId(fields.resume.conversationId)) {
      throw new ChatSessionError(
        "That conversation cannot be resumed with this agent.",
        "RESUME_UNAVAILABLE"
      );
    }
    if (!this.supervisor.isHealthy()) {
      throw new ChatSessionError("The agent host is not running.", "HOST_UNAVAILABLE");
    }

    let launch: ChatLaunchEnv | null = null;
    try {
      // The account rides the top level, shared with the terminal path;
      // `chat.accountId` is the host-side spelling and is only a fallback.
      launch = await this.opts.resolveLaunchEnv(entry, {
        accountId: req.accountId ?? fields.accountId,
        model: req.model
      });
    } catch (error) {
      throw error instanceof ChatSessionError
        ? error
        : new ChatSessionError(error instanceof Error ? error.message : String(error));
    }

    const accountId = launch?.accountId ?? "";
    const home = resolveHomeKind(entry.id, accountId);
    const cwd = req.cwd || req.projectPath || homedir();
    const id = randomUUID();
    // EXACTLY the env a terminal launch composes today: the registry entry's
    // own env (which already carries `<appdir>/daemon/env/<id>.env`, loaded by
    // RegistryService) under the `resolveExtraEnv` contributors, which win a
    // collision — the same order the terminal wrapper script's `export` has
    // over `tmux -e`.
    const launchEnv: Record<string, string> = { ...entry.env, ...(launch?.env ?? {}) };
    // The adapter's home variable is the one authority on the home dir, so a
    // managed account, a cliproxy launcher home and the system home all resolve
    // through the same rule the child itself will read.
    const homePath = launchEnv[ACCOUNT_HOME_ENV_VAR[adapter]];

    // Reality findings: a fresh directory is untrusted for Claude, and Grok
    // ships with approvals off and auto-update on. Best-effort and before the
    // thread exists, so the very first turn already sees the prepared home.
    await this.prepareHome(adapter, launchEnv, req.projectPath ?? "");

    const summary = this.chat.create({
      id,
      refId: entry.id,
      title: req.title || entry.name,
      projectPath: req.projectPath ?? "",
      cwd,
      order,
      accountId,
      home,
      model: req.model
    });

    const body: CreateHostThreadRequest = {
      threadId: id,
      projectPath: summary.projectPath,
      cwd,
      title: summary.title,
      refId: entry.id,
      accountId,
      home,
      // Passed through as the client sent it. An empty `modelSelection.model`
      // means "the provider's own default" — the launcher had no catalog to
      // pick from — and is never a refusal here (the daemon's model gate above
      // is the claudex/claudemix catalog check, which is a different thing).
      modelSelection: fields.modelSelection,
      runtimeMode: fields.runtimeMode,
      // EXACTLY the env a terminal launch of this entry gets today (§3.1): the
      // registry entry's own env — which is where the per-launcher env file
      // `<appdir>/daemon/env/<id>.env` (opencode.env, the generated
      // claudex.env/claudemix.env) has already been merged by RegistryService —
      // under the `resolveExtraEnv` contributors, which win a collision exactly
      // as the terminal wrapper script's `export` wins over `tmux -e`.
      launchEnv,
      ...(launch?.unset?.length ? { unsetEnv: launch.unset } : {}),
      ...(homePath ? { homePath } : {}),
      ...(home === "cliproxy" ? { proxyRefId: entry.id } : {}),
      ...(fields.resume ? { resume: fields.resume } : {})
    };
    try {
      const response = await this.client.json<{ error?: { code: string; message: string } }>(
        "POST",
        agentHostRoutes.createThread,
        body
      );
      if (response.status >= 400) {
        const code = response.value?.error?.code;
        throw new ChatSessionError(
          response.value?.error?.message ?? "The agent host refused the thread.",
          code === "RESUME_UNAVAILABLE" ? "RESUME_UNAVAILABLE" : "SESSION_UNAVAILABLE"
        );
      }
    } catch (error) {
      this.chat.close(id);
      if (error instanceof ChatSessionError) throw error;
      if (error instanceof HostUnavailableError) {
        throw new ChatSessionError("The agent host is not running.", "HOST_UNAVAILABLE");
      }
      throw new ChatSessionError(error instanceof Error ? error.message : String(error));
    }
    return summary;
  }

  /**
   * Re-point an existing chat thread at another managed account (§3.4's
   * "account changed"), applied on the thread's **next message**.
   *
   * The order mirrors `createSession` for the same reason: everything that can
   * refuse runs before anything is written, the launch environment is
   * recomposed by the daemon (only it has the sources), the host records the
   * new identity and rewrites `launch.json`, and only then does the tab record
   * move. A host that refuses leaves the tab exactly as it was.
   */
  async switchAccount(
    id: string,
    input: { commandId: string; accountId: string }
  ): Promise<{ seq: number }> {
    const summary = this.chat.get(id);
    if (!summary) {
      throw new ChatSessionError("No chat session with that id.", "THREAD_NOT_FOUND");
    }
    const commandId = typeof input?.commandId === "string" ? input.commandId.trim() : "";
    if (commandId.length === 0 || commandId.length > 200) {
      throw new ChatSessionError("commandId is required.", "INVALID_COMMAND");
    }
    if (typeof input?.accountId !== "string" || input.accountId.trim().length === 0) {
      throw new ChatSessionError("accountId is required.", "INVALID_COMMAND");
    }
    const requestedAccountId = input.accountId.trim();
    const entry = this.opts.registryEntry(summary.refId);
    if (!entry?.resolvedBin || !entry.enabled) {
      throw new ChatSessionError(
        `Registry entry "${summary.refId}" is not available.`,
        "INVALID_COMMAND"
      );
    }
    const adapter = entry.chat?.adapter;
    if (!adapter) {
      throw new ChatSessionError(`"${entry.name}" has no chat adapter.`, "INVALID_COMMAND");
    }
    // OpenCode runs ONE server per project under the daemon's own identity and
    // refuses a non-system home (§3.2); there is no per-thread account to move.
    if (adapter === "opencode") {
      throw new ChatSessionError(
        "OpenCode threads always run under the server's own identity.",
        "INVALID_COMMAND"
      );
    }
    // The family gate. `AgentAccountsService.resolveLaunchEnv` answers `null`
    // for an account of the wrong family — which would SILENTLY launch the
    // system identity — so a mismatched id is refused here rather than
    // degraded there.
    if (requestedAccountId !== SYSTEM_ACCOUNT_ID) {
      const family = proxyAccountFamily(entry.id) ?? entry.id;
      const managed = this.opts.listManagedAccounts?.().accounts ?? [];
      const account = managed.find((candidate) => candidate.id === requestedAccountId);
      if (!account || account.agent !== family) {
        throw new ChatSessionError(
          `That account cannot run "${entry.name}".`,
          "INVALID_COMMAND"
        );
      }
    }
    const seededRefusal = this.opts.seededAccountRefusal?.(
      { refId: entry.id, accountId: requestedAccountId },
      summary.model
    );
    if (seededRefusal) {
      throw new ChatSessionError(seededRefusal.message, "INVALID_COMMAND");
    }
    if (!this.supervisor.isHealthy()) {
      throw new ChatSessionError("The agent host is not running.", "HOST_UNAVAILABLE");
    }

    let launch: ChatLaunchEnv | null = null;
    try {
      // ALWAYS explicit: an omitted id makes `resolveLaunchEnv` fall back to
      // the family default, so "switch to System" would silently pick whatever
      // account happens to be the default instead.
      launch = await this.opts.resolveLaunchEnv(entry, {
        accountId: requestedAccountId,
        model: summary.model
      });
    } catch (error) {
      throw error instanceof ChatSessionError
        ? error
        : new ChatSessionError(error instanceof Error ? error.message : String(error));
    }

    const accountId = launch?.accountId ?? "";
    const home = resolveHomeKind(entry.id, accountId);
    const launchEnv: Record<string, string> = { ...entry.env, ...(launch?.env ?? {}) };
    const homePath = launchEnv[ACCOUNT_HOME_ENV_VAR[adapter]];
    // The new home may never have been used for this project.
    await this.prepareHome(adapter, launchEnv, summary.projectPath ?? "");

    const body: SetThreadIdentityRequest = {
      commandId,
      accountId,
      home,
      launchEnv,
      ...(launch?.unset?.length ? { unsetEnv: launch.unset } : {}),
      ...(homePath ? { homePath } : {}),
      ...(home === "cliproxy" ? { proxyRefId: entry.id } : {})
    };
    let receipt: { seq: number };
    try {
      const response = await this.client.json<{
        seq?: number;
        error?: { code: string; message: string };
      }>("POST", agentHostRoutes.setThreadIdentity(id), body);
      if (response.status === 404 && response.value?.error?.code === undefined) {
        // A host that survived a deploy is still running the code it started
        // from (§8) and has no identity route. It is replaced on the next
        // drain-restart, so this is a retry, not a refusal.
        throw new ChatSessionError(
          "The agent host is still updating. Try again in a moment.",
          "HOST_UNAVAILABLE"
        );
      }
      if (response.status >= 400) {
        throw new ChatSessionError(
          response.value?.error?.message ?? "The agent host refused the account switch.",
          response.value?.error?.code ?? "SESSION_UNAVAILABLE"
        );
      }
      receipt = { seq: typeof response.value?.seq === "number" ? response.value.seq : 0 };
    } catch (error) {
      if (error instanceof ChatSessionError) throw error;
      if (error instanceof HostUnavailableError) {
        throw new ChatSessionError("The agent host is not running.", "HOST_UNAVAILABLE");
      }
      throw new ChatSessionError(error instanceof Error ? error.message : String(error));
    }
    // Only after the host accepted: `sessions.json`, the tab badge and
    // `liveAccountIds()` must never name an identity the thread does not have.
    this.chat.setAccount(id, { accountId, home });
    return receipt;
  }

  /**
   * `DELETE` cascade (§6.1): the host settles pending requests, stops the
   * provider child, prunes every checkpoint ref under the thread's prefix and
   * removes the thread directory.
   *
   * **Durable, not fire-and-forget.** `ChatSessionManager.close` has already
   * queued the id into the persisted `pendingThreadDeletes`; this attempt only
   * clears it on a definitive answer. A host that is down at close time would
   * otherwise never write `thread.deleted`, and §3.3's reconcile would then
   * find an orphan with a cursor and a continuation marker and RESUME it —
   * spending tokens on a tab nobody is looking at. The queue is replayed the
   * moment a host is adopted, and survives the daemon restart in between.
   */
  deleteThread(id: string): void {
    this.summary.forget(id);
    void this.attemptThreadDelete(id);
  }

  /** One delete attempt. Clears the retry only on a definitive host answer. */
  private async attemptThreadDelete(id: string): Promise<void> {
    try {
      const response = await this.client.json("DELETE", agentHostRoutes.deleteThread(id));
      // 404 is definitive too: the host has no such thread, so there is nothing
      // left to reconcile. Anything 5xx stays queued.
      if (response.status < 500) {
        this.chat.resolveThreadDelete(id);
        return;
      }
      this.opts.logger?.warn?.(
        `agent host refused the thread delete for ${id} (${response.status}); will retry`
      );
    } catch (error) {
      this.opts.logger?.warn?.(`agent host thread delete failed for ${id}; will retry`, error);
    }
  }

  /**
   * Replay every queued delete. Called whenever a host becomes healthy —
   * boot adoption, a respawn, or the drain-restart.
   */
  async replayPendingThreadDeletes(): Promise<void> {
    if (!this.supervisor.isHealthy()) return;
    const pending = this.chat.pendingThreadDeletes();
    if (pending.length === 0) return;
    this.opts.logger?.log?.(`agent chat: replaying ${pending.length} pending thread delete(s)`);
    for (const id of pending) {
      await this.attemptThreadDelete(id);
    }
  }

  /**
   * A chat attachment (§6.3). The bytes are streamed straight through to the
   * host, which claims the file into the thread's attachment namespace and
   * answers the `AttachmentRef` — the host, not the daemon, mints the id and
   * re-checks the §4.1 bounds against the file it stat'd, and its thread-delete
   * cascade is what cleans the file up.
   *
   * The daemon deliberately does not write into the thread directory itself:
   * that directory is the host's, and a file the host never claimed could not
   * be resolved by `GET …/attachments/:id` when an adapter goes looking for it.
   */
  async uploadAttachment(
    sessionId: string,
    query: { name?: string; type?: string },
    body: Readable
  ): Promise<{ status: number; value: unknown }> {
    const params = new URLSearchParams();
    if (query.name) params.set("name", query.name);
    if (query.type) params.set("type", query.type);
    const suffix = params.toString();
    const path = `${agentHostExtraRoutes.putAttachment(sessionId)}${suffix ? `?${suffix}` : ""}`;
    // The cap is enforced TWICE, as AGENTS.md requires: the route already
    // refused a declared `Content-Length` above it, and this counts what
    // actually arrives — a chunked upload with no `Content-Length` would
    // otherwise stream unbounded straight through to the host.
    const stream = await this.client.open("POST", path, {
      body: countingLimit(body, MAX_UPLOAD_BYTES),
      headers: { "content-type": "application/octet-stream" },
      timeoutMs: 0
    });
    const chunks: Buffer[] = [];
    for await (const chunk of stream.body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    let value: unknown = null;
    try {
      value = raw.trim() ? JSON.parse(raw) : null;
    } catch {
      value = null;
    }
    return { status: stream.status, value };
  }

  /**
   * Resolve an attachment id to its absolute host path (§6.3 read-back).
   *
   * The daemon cannot serve it through `/api/fs/download`: that route is
   * confined to `fsRoot` (`<appdir>/workspaces`) and the thread's attachments
   * live under `<appdir>/daemon/agent/threads/<id>/attachments`. So the host
   * resolves the id — it owns the namespace and the traversal guard — and the
   * daemon streams what it names.
   */
  async attachmentPath(sessionId: string, attachmentId: string): Promise<string | null> {
    const response = await this.client.json<{ path?: unknown }>(
      "GET",
      agentHostExtraRoutes.attachment(sessionId, attachmentId)
    );
    if (response.status !== 200) return null;
    const path = response.value?.path;
    return typeof path === "string" && path ? path : null;
  }

  /**
   * `PUT` rename (§6.1) — the host appends `thread.meta-updated`.
   *
   * `opts.seed` forwards §7.7's "this is the client's auto-seed, not a rename"
   * so the host leaves the title replaceable by a provider retitle.
   */
  renameThread(id: string, title: string, opts?: { seed?: boolean }): void {
    void this.client
      .json("PUT", agentHostRoutes.updateThread(id), { title, seed: opts?.seed === true })
      .catch((error) => this.opts.logger?.warn?.(`agent host thread rename failed for ${id}`, error));
  }

  // --- internals -----------------------------------------------------------

  /**
   * Claude project trust for the home this thread will run under.
   *
   * The trusted path is **the daemon's, not the client's**: `projectPath` is
   * run through `resolveTrustedProjectDir`, which realpaths it and refuses
   * anything outside `fsRoot`. `cwd` off the create request is never trusted —
   * accepting it would let a client permanently enable an arbitrary directory's
   * Claude hooks (arbitrary shell as the daemon user, which holds scoped
   * passwordless sudo) host-wide, including for every future terminal tab on
   * that path.
   *
   * No other adapter is prepared here: see the module comment in `home-prep.ts`
   * for why the Grok config write is gone.
   */
  private async prepareHome(
    adapter: AgentAdapterId,
    env: Record<string, string>,
    projectPath: string
  ): Promise<void> {
    if (adapter !== "claude") return;
    try {
      const projectDir = await this.opts.resolveTrustedProjectDir(projectPath);
      if (!projectDir) {
        this.opts.logger?.warn?.(
          `agent chat: not granting Claude project trust for ${projectPath} (outside the workspaces sandbox)`
        );
        return;
      }
      const dir = env.CLAUDE_CONFIG_DIR;
      const file = dir ? join(dir, ".claude.json") : this.opts.systemClaudeConfigFile();
      await markClaudeProjectTrusted(file, projectDir, this.opts.logger);
    } catch (error) {
      // Never block a launch on home preparation.
      this.opts.logger?.warn?.("agent chat home preparation failed", error);
    }
  }

  /** Authenticated `GET /health`; classifies exactly the five §3.1 cases. */
  private async probe(): Promise<ProbeOutcome> {
    try {
      const response = await this.client.json<AgentHostHealthResponse>(
        "GET",
        agentHostRoutes.health,
        undefined,
        { timeoutMs: 5_000 }
      );
      if (response.status === 401 || response.status === 403) {
        return { ok: false, reachable: true, rejected: true };
      }
      if (response.status === 200 && response.value?.ok) {
        return { ok: true, health: response.value };
      }
      return { ok: false, reachable: true, rejected: false, status: response.status };
    } catch {
      return { ok: false, reachable: false };
    }
  }

  private async requestHostStop(): Promise<void> {
    const response = await this.client.json<{ markedThreadIds?: unknown }>(
      "POST",
      agentHostRoutes.stop,
      {},
      { timeoutMs: 30_000 }
    );
    const marked = response.value?.markedThreadIds;
    this.lastMarkedThreadIds = Array.isArray(marked)
      ? marked.filter((id): id is string => typeof id === "string")
      : [];
  }
}

/**
 * Which HOME the thread's provider child runs under — the §5.2 `home` field,
 * and the same three-way split the resume picker already uses.
 */
export function resolveHomeKind(entryId: string, accountId: string): AgentChatHome {
  if (entryId === "claudex" || entryId === "claudemix") return "cliproxy";
  return accountId ? "account" : "system";
}

/**
 * Which managed-account FAMILY a registry entry draws its accounts from.
 *
 * The proxy launchers route by model name, so `claudex` pins a seeded **Codex**
 * account and `claudemix` a seeded **Claude** one; their own ids never match an
 * `AgentAccount.agent`. Mirrors `PROXY_ACCOUNT_FAMILY` in the UI's `NewTabMenu`
 * — the two decide the same thing for the same reason, one at launch and one at
 * switch. Null for every other entry, which draws from its own id.
 */
export function proxyAccountFamily(entryId: string): "claude" | "codex" | null {
  if (entryId === "claudemix") return "claude";
  if (entryId === "claudex") return "codex";
  return null;
}

/**
 * Pass a body through, counting bytes, and destroy it with
 * {@link UploadTooLargeError} past `limit`. The second half of AGENTS.md's
 * "the cap is enforced twice": a chunked request carries no `Content-Length`
 * for the route's declared-length check to refuse.
 */
function countingLimit(source: Readable, limit: number): Readable {
  let seen = 0;
  return source.pipe(
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        seen += chunk.length;
        if (seen > limit) {
          callback(new UploadTooLargeError());
          return;
        }
        callback(null, chunk);
      }
    })
  );
}

/** §6.1: an id the adapter cannot use is refused at creation, never degraded. */
export function isUsableConversationId(value: unknown): boolean {
  const id = typeof value === "string" ? value.trim() : "";
  return Boolean(id) && CONVERSATION_ID.test(id) && !id.split("/").includes("..");
}

export { ChatSessionError };
