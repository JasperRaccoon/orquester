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
import { randomUUID } from "node:crypto";
import type {
  AgentAdapterId,
  CreateAgentChatSessionFields,
  CreateSessionRequest,
  RegistryEntry,
  SessionSummary
} from "@orquester/api";
import type { AgentChatHome, RuntimePlatform, SessionRecord } from "@orquester/config";
import { agentHostSocketPath, agentHostTokenPath } from "@orquester/config";
import {
  AGENT_HOST_HEALTH_INTERVAL_MS,
  agentHostRoutes,
  type AgentHostHealthResponse,
  type CreateHostThreadRequest
} from "../agent-host/host-protocol.ts";
import { ChatSessionManager, ChatSessionError } from "./chat-sessions.ts";
import { AgentHostClient, HostUnavailableError } from "./host-client.ts";
import { ensureGrokChatConfig, markClaudeProjectTrusted } from "./home-prep.ts";
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
  logger?: {
    log?: (...a: unknown[]) => void;
    warn?: (...a: unknown[]) => void;
    error?: (...a: unknown[]) => void;
  };
  /** Test seam: overrides `process.execPath`. */
  nodeBin?: string;
  mainPath?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** `POST /api/sessions` with `kind: "agent-chat"` — §6.1's extra fields. */
export type CreateAgentChatRequest = CreateSessionRequest & Partial<CreateAgentChatSessionFields>;

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
      adapters: {
        probe: () => this.probe(),
        requestStop: () => this.requestHostStop(),
        tmux: opts.tmux,
        spawnDirect: (bin, args, env) => {
          const child = spawn(bin, args, { cwd: opts.cwd, detached: false, stdio: "ignore", env });
          child.on("error", (error) => opts.logger?.error?.("agent host spawnDirect failed", error));
          this.directHandle = { kill: () => child.kill(), pid: child.pid };
          return this.directHandle;
        },
        now: opts.now ?? Date.now,
        sleep: opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
        logger: opts.logger
      }
    });
    this.summary = new AgentChatSummaryService({
      client: this.client,
      chat: this.chat,
      broadcaster: opts.broadcaster,
      push: opts.push,
      now: opts.now,
      sleep: opts.sleep,
      logger: opts.logger
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
  indexContributor(): {
    records(): SessionRecord[];
    adopt(records: readonly SessionRecord[]): void;
    owns(record: SessionRecord): boolean;
  } {
    return {
      records: () => this.chat.records(),
      adopt: (records) => this.chat.adopt(records),
      owns: (record) => record.kind === "agent-chat"
    };
  }

  /** Boot: adopt or spawn the host, then start the coarse subscription. */
  async init(): Promise<void> {
    await this.supervisor.init();
    this.summary.start();
    this.healthTimer = setInterval(() => void this.supervisor.checkHealth(), AGENT_HOST_HEALTH_INTERVAL_MS);
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

  routeDeps(): AgentChatRouteDeps {
    return {
      client: this.client,
      isHostHealthy: () => this.supervisor.isHealthy(),
      chatSession: (id) => this.chat.get(id),
      noteSeq: (id, seq) => this.chat.noteSeq(id, seq),
      restartHost: () => this.supervisor.restartNow(),
      logger: this.opts.logger
    };
  }

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
    if (req.resume && !isUsableConversationId(req.resume.conversationId)) {
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
      launch = await this.opts.resolveLaunchEnv(entry, { accountId: req.accountId, model: req.model });
    } catch (error) {
      throw error instanceof ChatSessionError
        ? error
        : new ChatSessionError(error instanceof Error ? error.message : String(error));
    }

    const accountId = launch?.accountId ?? "";
    const home = resolveHomeKind(entry.id, accountId);
    const cwd = req.cwd || req.projectPath || homedir();
    const id = randomUUID();

    // Reality findings: a fresh directory is untrusted for Claude, and Grok
    // ships with approvals off and auto-update on. Best-effort and before the
    // thread exists, so the very first turn already sees the prepared home.
    await this.prepareHome(adapter, launch?.env ?? {}, cwd);

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
      modelSelection: req.modelSelection,
      runtimeMode: req.runtimeMode,
      ...(req.resume ? { resume: req.resume } : {})
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
   * `DELETE` cascade (§6.1): the host settles pending requests, stops the
   * provider child, prunes every checkpoint ref under the thread's prefix and
   * removes the thread directory. Fire-and-forget — the tab is already gone,
   * and a host that is down reconciles the orphan on its next start (§3.3).
   */
  deleteThread(id: string): void {
    this.summary.forget(id);
    void this.client
      .json("DELETE", agentHostRoutes.deleteThread(id))
      .catch((error) => this.opts.logger?.warn?.(`agent host thread delete failed for ${id}`, error));
  }

  /** `PUT` rename (§6.1) — the host appends `thread.meta-updated`. */
  renameThread(id: string, title: string): void {
    void this.client
      .json("PUT", agentHostRoutes.updateThread(id), { title })
      .catch((error) => this.opts.logger?.warn?.(`agent host thread rename failed for ${id}`, error));
  }

  // --- internals -----------------------------------------------------------

  private async prepareHome(
    adapter: AgentAdapterId,
    env: Record<string, string>,
    cwd: string
  ): Promise<void> {
    try {
      if (adapter === "claude") {
        const dir = env.CLAUDE_CONFIG_DIR;
        const file = dir ? join(dir, ".claude.json") : this.opts.systemClaudeConfigFile();
        await markClaudeProjectTrusted(file, cwd, this.opts.logger);
        return;
      }
      if (adapter === "grok") {
        const home = env.GROK_HOME ?? this.opts.env.GROK_HOME ?? join(homedir(), ".grok");
        await ensureGrokChatConfig(home, this.opts.logger);
      }
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
    await this.client.json("POST", agentHostRoutes.stop, {}, { timeoutMs: 30_000 });
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

/** §6.1: an id the adapter cannot use is refused at creation, never degraded. */
export function isUsableConversationId(value: unknown): boolean {
  const id = typeof value === "string" ? value.trim() : "";
  return Boolean(id) && CONVERSATION_ID.test(id) && !id.split("/").includes("..");
}

export { ChatSessionError };
