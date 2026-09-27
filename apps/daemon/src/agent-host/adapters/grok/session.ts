/**
 * Grok adapter — one `grok agent stdio` child per thread (spec §3.1, §4.1,
 * §4.5 Grok).
 *
 * Ported from T3 Code (MIT):
 * `apps/server/src/provider/Layers/GrokAdapter.ts` and
 * `apps/server/src/provider/acp/AcpSessionRuntime.ts`, translated from Effect
 * into plain promises.
 *
 * The session owns the child, the ACP peer, the normaliser and the turn
 * machinery. Everything that must not outlive the process is settled here
 * before `session.exited` is emitted (§3.1).
 */

import type {
  AccountHome,
  ApprovalDecision,
  ModelSelection,
  ProviderSession,
  ProviderSessionStatus,
  RuntimeEvent,
  RuntimeMode
} from "@orquester/api/agent-chat";

import { randomUUID } from "node:crypto";

import { AGENT_HOST_DEADLINES } from "../../support/deadline.ts";
import {
  AGENT_LAUNCH_ENV_VAR,
  recordChildSessions,
  stopLeftoverProcesses,
  type RecordedSession
} from "../../support/leftover-processes.ts";
import type { ChildExitReason } from "../../support/spawn.ts";
import { describeExit, exitOutcome } from "../../support/spawn.ts";
import type { ClassifiedStderrLine } from "../../support/stderr.ts";
import { appendAttachmentPathLines } from "../attachment-lines.ts";
import { AcpConnection } from "./acp/connection.ts";
import type { AcpFrameDirection } from "./acp/peer.ts";
import { ACP_ERROR_CODES, AcpRpcError, classifyAcpError } from "./acp/errors.ts";
import type {
  InitializeResponse,
  LoadSessionResponse,
  NewSessionResponse,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification
} from "./acp/_generated/schema.ts";
import {
  XAI_EXTENSION_NOTIFICATIONS,
  XAI_EXTENSION_REQUESTS,
  xaiMethodSpellings,
  type XaiAskUserQuestionParams,
  type XaiExitPlanModeParams,
  type XaiPromptCompleteParams
} from "./acp/_generated/xai.ts";
import {
  GROK_EXTRA_ENV,
  autoApprovesEdits,
  autoApprovesEverything,
  expectsApprovalCards,
  GROK_CONFIG_PATH_ENV,
  grokConfigAdvisory,
  grokSpawnArgs,
  meetsMinimumGrokVersion,
  resolveGrokModelUpdate,
  versionGateMessage,
  writeGrokOverlayConfig
} from "./launch.ts";
import { GrokNormalizer, XAI_RAW_SOURCE, ACP_RAW_SOURCE, type GrokTurnOutcome } from "./normalize.ts";
import {
  approvalGrantKey,
  isEditApproval,
  permissionDetail,
  permissionRequestType,
  selectAutoApprovedOptionId,
  selectPermissionOptionId
} from "./permissions.ts";
import { XAI_EMPTY_PLAN_MARKDOWN, XAI_EXIT_PLAN_FEEDBACK, type PlanPathHost } from "./plan.ts";
import { GrokWakes, isParentSessionId, type CliPrompt } from "./prompt-queue.ts";
import { answersToXaiResponse } from "./questions.ts";
import { parsePromptResultUsage, parseXaiUsage } from "./usage.ts";
import { agentVersionOf, contextWindowFromModelState, modelStateOf, promptIdOf } from "./xai-meta.ts";

/**
 * Every method this adapter registers a handler for, in the spelling it
 * registers. Exported so `acp/_generated/catalog.test.ts` can assert that each
 * one exists in the generated catalog: a typo would otherwise register a
 * handler that can never fire, silently (R4 #19).
 *
 * Extension names are listed in their BARE spelling —
 * `AcpPeer.registerExtension*` registers both.
 */
export const GROK_REGISTERED_METHODS: readonly string[] = [
  "session/update",
  "session/request_permission",
  XAI_EXTENSION_NOTIFICATIONS.session_notification,
  XAI_EXTENSION_NOTIFICATIONS.session_update,
  XAI_EXTENSION_NOTIFICATIONS.task_backgrounded,
  XAI_EXTENSION_NOTIFICATIONS.task_completed,
  XAI_EXTENSION_NOTIFICATIONS.monitor_event,
  XAI_EXTENSION_NOTIFICATIONS.scheduled_task_created,
  XAI_EXTENSION_NOTIFICATIONS.scheduled_task_fired,
  XAI_EXTENSION_NOTIFICATIONS.scheduled_task_deleted,
  XAI_EXTENSION_NOTIFICATIONS.prompt_complete,
  XAI_EXTENSION_NOTIFICATIONS.queue_changed,
  XAI_EXTENSION_NOTIFICATIONS.settings_update,
  XAI_EXTENSION_NOTIFICATIONS.announcements_update,
  XAI_EXTENSION_NOTIFICATIONS.sessions_changed,
  XAI_EXTENSION_NOTIFICATIONS.mcp_init_progress,
  XAI_EXTENSION_NOTIFICATIONS.mcp_initialized,
  XAI_EXTENSION_NOTIFICATIONS.mcp_servers_updated,
  XAI_EXTENSION_NOTIFICATIONS.models_update,
  XAI_EXTENSION_NOTIFICATIONS.mcp_server_status,
  XAI_EXTENSION_REQUESTS.ask_user_question,
  XAI_EXTENSION_REQUESTS.exit_plan_mode
];

/** How many settled turns `readThread` remembers. */
const MAX_RECORDED_TURNS = 200;

/**
 * Ids the CLI gives requests it sends ITSELF and answers on our stdout: a
 * subagent's child session reloading its skills and workflows answered
 * `{"id": "skills-reload", …}` four times and `"workflows-reload"` once
 * (fixture 15's spawn, the first of its day; the later captures' spawns sent
 * none). The peer drops a reply carrying one structurally
 * (`AcpPeerOptions.agentOwnReplyIds`) — warning on each put five rows in the
 * timeline; any other stray reply still warns.
 */
const CLI_OWN_REPLY_IDS: ReadonlySet<string> = new Set(["skills-reload", "workflows-reload"]);

/** `{schemaVersion: 1, sessionId}` — the only thing persisted for resume (§4.1). */
export const GROK_RESUME_SCHEMA_VERSION = 1;

export interface GrokResumeCursor {
  schemaVersion: number;
  sessionId: string;
}

/** A cursor that fails its shape check means "no resume", **never** an error. */
export function parseGrokResumeCursor(value: unknown): GrokResumeCursor | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record["schemaVersion"] !== GROK_RESUME_SCHEMA_VERSION) {
    return null;
  }
  const sessionId = record["sessionId"];
  return typeof sessionId === "string" && sessionId.trim().length > 0
    ? { schemaVersion: GROK_RESUME_SCHEMA_VERSION, sessionId: sessionId.trim() }
    : null;
}

export interface GrokSessionOptions {
  threadId: string;
  cwd: string;
  home: AccountHome;
  runtimeMode: RuntimeMode;
  modelSelection: ModelSelection;
  resumeCursor?: unknown;
  command: string;
  env: Record<string, string>;
  clientInfo: { name: string; version: string };
  emit(event: RuntimeEvent): void;
  stamp(): { eventId: string; createdAt: string };
  uuid(): string;
  logRaw(direction: AcpFrameDirection, frame: unknown): void;
  logger: {
    debug(message: string, detail?: unknown): void;
    warn(message: string, detail?: unknown): void;
    error(message: string, detail?: unknown): void;
  };
  homeDirs?: readonly string[];
  /** A host-owned directory for this thread's config overlay. */
  overlayDir: string;
  /**
   * The child is gone and this session is finished. Without it a crashed child
   * leaves a dead session in the adapter's map, so `hasSession` stays true and
   * `listSessions()` keeps reporting it to the §3.3 reconcile (Q1 #30).
   */
  onClosed?(threadId: string): void;
  /**
   * Remember this launch's task sessions for a later user end (the thread's
   * `leftover-work.json`, `support/leftover-work.ts`): called whenever the
   * CLI reports new work and at an end that leaves it running. Best-effort.
   */
  persistTaskSessions?(launchId: string, sessions: readonly RecordedSession[]): Promise<void>;
}

/** Why a session ended without the user: what the closing row of work left running names. */
export type GrokSessionEndCause = "restart" | "host";

/**
 * The helpers' grace at the host's teardown — SIGTERM, then SIGKILL this long
 * after — where every other end gives them `spawn.ts`'s 2 s. The host's
 * process entry exits 3 s after a SIGTERM whatever its stop is still doing
 * (`main.ts`), and the sweep starts only once the CLI is gone (the captured
 * CLI exits on SIGTERM at once, fixture 14): with 2 s, a helper that ignores
 * SIGTERM was killed some 2.4 s into the stop, a hair inside the backstop;
 * with this, about 1.2 s (`host-teardown.test.ts`). A CLI that ignores
 * SIGTERM itself spends its own 2 s grace first, and the backstop can then
 * cut the helpers' SIGKILL — see {@link GrokSession.stopLeftovers}.
 */
export const HOST_TEARDOWN_SWEEP_GRACE_MS = 1_000;

/**
 * The line a shell's or a monitor's closing row says when its process
 * outlives the end — never a bare "stopped" for work that runs on.
 */
export function leftRunningNote(
  cause: GrokSessionEndCause | "exit",
  platform: NodeJS.Platform = process.platform
): string {
  const when =
    cause === "restart"
      ? "the session restarted"
      : cause === "host"
        ? "the agent host stopped"
        : "the agent process exited";
  // Settings → System reads `/proc`: elsewhere it lists nothing to stop.
  return platform === "linux"
    ? `Left running when ${when} — stop it from Settings → System.`
    : `Left running when ${when}.`;
}

/**
 * A parked card. Settling it — `resolve` (the user's answer) or `withdraw`
 * (nobody's: a Stop, a steer, the session's stop, the exit) — emits its ONE
 * resolution row there and then and answers the CLI; the handler awaiting it
 * emits nothing. Every teardown used to emit a row AND resolve the deferred,
 * and the handler then emitted another — two closing rows per card, the
 * second of an exit landing after `session.exited`.
 */
interface PendingApproval {
  readonly requestType: ReturnType<typeof permissionRequestType>;
  resolve(decision: ApprovalDecision): void;
  /** `cancel` to the CLI, and a row marked `withdrawn` ("Request cancelled"). */
  withdraw(): void;
}

interface PendingUserInput {
  readonly params: XaiAskUserQuestionParams;
  /** The turn its rows ride, stamped once ({@link GrokSession.questionTurnId}); `null` for none. */
  readonly turnId: string | null;
  resolve(answers: Record<string, unknown>): void;
  /** `cancelled` to the CLI, and a row marked `withdrawn` ("Question cancelled"). */
  withdraw(): void;
}

/** One settled turn, kept for `readThread`'s provider-side snapshot. */
interface RecordedTurn {
  readonly id: string;
  readonly items: unknown[];
}

interface ActiveTurn {
  readonly turnId: string;
  /**
   * The generation of the prompt that is allowed to settle this turn.
   * **Mutable on purpose**: a steer supersedes the in-flight prompt, so the
   * turn must move to the new generation or the CANCELLED prompt settles it
   * and the steered answer is discarded (R4 #1 / Q1 #4).
   */
  epoch: number;
  /** Resolved once the provider's own prompt id is known. */
  providerPromptId?: string;
  settled: boolean;
  interrupted: boolean;
  outcome?: GrokTurnOutcome;
  errorMessage?: string;
  /**
   * The CLI's own prompt this turn stands for — a wake ({@link
   * GrokSession.onQueueChanged}) — settled by that prompt's `turn_completed`,
   * since no RPC of ours answers it. Cleared when a steer takes the turn over.
   */
  wakePromptId?: string;
}

/** One live `grok agent stdio` child. */
export class GrokSession {
  readonly threadId: string;
  private readonly options: GrokSessionOptions;
  private readonly normalizer: GrokNormalizer;
  private connection: AcpConnection | null = null;

  private acpSessionId = "";
  private agentVersion: string | null = null;
  private contextWindow: number | undefined;
  private status: ProviderSessionStatus = "starting";
  private createdAt: string;
  private updatedAt: string;
  private lastError: string | undefined;
  private stopped = false;
  private hostInitiatedStop = false;
  /**
   * This launch's value of {@link AGENT_LAUNCH_ENV_VAR}, on the CLI's launch
   * env and so on everything it starts: how its leftovers are found once it
   * is gone ({@link stopLeftovers}). Random, never the injectable `uuid()`:
   * it names real processes, and a deterministic test id shared by two test
   * files running at once would let one stop the other's.
   */
  private readonly launchId = randomUUID();
  /**
   * The sessions of the CLI's own per-session HELPERS — its children while
   * its session opens, which are its MCP servers (fixture 31: all four
   * existed as `session/new` answered, none of the user's work had run) —
   * recorded while it lived: as it reports them booting, once the open
   * answered, and at any end before the session was announced ({@link
   * recordSessions}). Swept at every end.
   */
  private readonly helperSessions = new Map<number, RecordedSession>();
  /**
   * The sessions of the CLI's later children — its shells, the dev servers
   * they started — recorded right before the USER ends the session, while
   * the CLI still lives. Swept only then ({@link stop}), by a sweep of their
   * own ({@link stopTaskLeftovers}).
   */
  private readonly taskSessions = new Map<number, RecordedSession>();
  /** The sweep of the helpers this launch left running, once started — the exit and a stop share it. */
  private leftovers: Promise<void> | null = null;
  /** The helpers' SIGTERM grace, when not `spawn.ts`'s: the host's teardown ({@link HOST_TEARDOWN_SWEEP_GRACE_MS}). */
  private sweepGraceMs: number | undefined;
  /**
   * The sweep of the user's work, once started. Its own, never the helpers':
   * a CLI that exits in the middle of the user's stop starts the helpers'
   * sweep from {@link onExit}, and a stop that reused it left the work
   * running.
   */
  private taskLeftovers: Promise<void> | null = null;
  /** The user is ending the session: an exit in the middle of it leaves nothing running to say so of. */
  private endingByUser = false;
  /** Recordings of the user's work as the CLI reports it, one at a time ({@link recordTaskWork}). */
  private taskRecording: Promise<void> = Promise.resolve();
  /**
   * Recordings of the CLI's helpers while its session opens, off its own
   * reports of its MCP servers booting, one at a time
   * ({@link recordHelpersWhileOpening}); the helpers' sweep waits for them.
   */
  private helperRecording: Promise<void> = Promise.resolve();
  /**
   * `session.started` went out. Until then the session has no life of its own
   * to report: an open that fails is reported by `start()`'s rejection, which
   * the host writes, and its CLI's exit adds no row ({@link onExit}).
   */
  private announced = false;
  /** How the CLI ended while its session was still opening — the open's rejection names it. */
  private exitBeforeOpen: { reason: ChildExitReason; stderrTail: string } | null = null;
  /** The self-resolved-approvals advisory is said once per session. */
  private selfResolveAdvised = false;
  /** `<server>\u0000<status>` of every MCP failure already reported, until the server is ready again. */
  private readonly mcpWarned = new Set<string>();

  private currentModelId: string | undefined;
  private currentReasoningEffort: string | undefined;
  /**
   * `session/set_model` requests the CLI refused (`-32602`), by model and
   * effort. The session keeps the CLI's own model then, and every later turn
   * carries the same selection — an outdated CLI and a chat created on the
   * pending catalogue name a model it does not know — so each would ask, and
   * warn, again. Asked once per session; a timeout is not a refusal.
   */
  private readonly refusedModels = new Set<string>();

  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly pendingUserInputs = new Map<string, PendingUserInput>();
  private readonly sessionGrants = new Set<string>();

  private activeTurn: ActiveTurn | null = null;
  private readonly recordedTurns: RecordedTurn[] = [];
  private epoch = 0;

  /**
   * The CLI's prompt queue, the turns its own prompts get and the frames
   * that wait for them (`prompt-queue.ts` — the capture-replay driver runs
   * the same class).
   */
  private readonly wakes: GrokWakes;

  /** A serial queue: one mutating command at a time per thread (§3.1). */
  private lock: Promise<unknown> = Promise.resolve();

  constructor(options: GrokSessionOptions) {
    this.options = options;
    this.threadId = options.threadId;
    this.createdAt = options.stamp().createdAt;
    this.updatedAt = this.createdAt;
    this.normalizer = new GrokNormalizer(
      {
        threadId: options.threadId,
        stamp: options.stamp,
        uuid: options.uuid,
        activeTurnId: () => this.activeTurn?.turnId,
        planHost: this.planHost(),
        launchNonce: this.launchId.slice(0, 8)
      },
      "pending"
    );
    this.wakes = new GrokWakes(
      this.normalizer,
      {
        turnOpen: () => this.activeTurn !== null && !this.activeTurn.settled,
        openTurn: (prompt) => this.openWakeTurn(prompt),
        emit: (events) => this.emitAll(events),
        notePrompt: (promptId) => this.notePromptId(promptId),
        debug: (message, detail) => this.options.logger.debug(message, detail)
      },
      { parentSessionId: () => this.acpSessionId }
    );
  }

  // ---------------------------------------------------------------- getters

  get summary(): ProviderSession {
    return {
      threadId: this.threadId,
      status: this.status,
      runtimeMode: this.options.runtimeMode,
      cwd: this.options.cwd,
      ...(this.currentModelId === undefined ? {} : { model: this.currentModelId }),
      ...(this.acpSessionId.length === 0
        ? {}
        : { resumeCursor: { schemaVersion: GROK_RESUME_SCHEMA_VERSION, sessionId: this.acpSessionId } }),
      ...(this.activeTurn === null ? {} : { activeTurnId: this.activeTurn.turnId }),
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      ...(this.lastError === undefined ? {} : { lastError: this.lastError })
    };
  }

  get sessionId(): string {
    return this.acpSessionId;
  }

  get version(): string | null {
    return this.agentVersion;
  }

  get reportedContextWindow(): number | undefined {
    return this.contextWindow;
  }

  get slashCommands(): ReadonlyArray<{ name: string; description?: string; input?: { hint: string } }> {
    return this.normalizer.slashCommands;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  get hasActiveTurn(): boolean {
    return this.activeTurn !== null && !this.activeTurn.settled;
  }

  /**
   * The provider-side turn snapshot (§4.1). Grok exposes no transcript RPC and
   * `session/load` replays only a fraction of the history, so this is what the
   * adapter itself observed: one opaque item per settled turn, carrying the
   * provider's own prompt id and stop reason. Bounded, because a long-lived
   * session must not grow this without limit.
   */
  get turns(): RecordedTurn[] {
    // The replayed history first — it is the older half of the conversation —
    // then the turns this process ran itself.
    return [
      ...this.normalizer.historyTurns(),
      ...this.recordedTurns.map((turn) => ({ id: turn.id, items: [...turn.items] }))
    ];
  }

  private planHost(): PlanPathHost {
    return { platform: process.platform, env: this.options.env };
  }

  /** Run a mutating command under the per-thread lock. */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.lock.then(work, work);
    this.lock = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  // ------------------------------------------------------------------ start

  async start(): Promise<void> {
    // The approvals surface of §4.3 silently never fires without
    // `[features] support_permission = true`, and the user then gets an agent
    // that approves itself while the UI says "supervised". It reaches the CLI
    // as a `GROK_CONFIG_PATH` **overlay** the host owns outright — never as a
    // key patched into the account home, whose `config.toml` is a symlink to
    // the user's global config on this host (R4 #4).
    const overlay = await writeGrokOverlayConfig(this.options.overlayDir);
    if (overlay === null) {
      this.emitEvent(this.normalizer.event("runtime.warning", { message: grokConfigAdvisory() }));
    }

    const connection = AcpConnection.spawn({
      command: this.options.command,
      args: grokSpawnArgs(this.options.runtimeMode),
      env: {
        ...this.options.env,
        ...GROK_EXTRA_ENV,
        ...(overlay === null ? {} : { [GROK_CONFIG_PATH_ENV]: overlay }),
        [AGENT_LAUNCH_ENV_VAR]: this.launchId
      },
      cwd: this.options.cwd,
      clientInfo: this.options.clientInfo,
      homeDirs: this.options.homeDirs,
      onRawFrame: (direction, frame) => this.options.logRaw(direction, frame),
      onStderrLine: (line) => this.onStderr(line),
      onWarning: (message, detail) =>
        this.emitEvent(this.normalizer.event("runtime.warning", { message, detail })),
      agentOwnReplyIds: CLI_OWN_REPLY_IDS,
      onExit: (reason, tail) => this.onExit(reason, tail)
    });
    this.connection = connection;
    this.registerHandlers(connection);

    const cursor = parseGrokResumeCursor(this.options.resumeCursor);
    let initialize: InitializeResponse;
    let setup: NewSessionResponse | LoadSessionResponse;
    try {
      initialize = await connection.handshake();
      // Read on EVERY handshake, never cached per host: the CLI auto-updates
      // and can change version between two spawns of one thread.
      this.agentVersion = agentVersionOf(initialize._meta) ?? null;
      if (!meetsMinimumGrokVersion(this.agentVersion)) {
        throw new Error(versionGateMessage(this.agentVersion));
      }
      setup = cursor === null ? await this.openNewSession() : await this.loadSession(cursor.sessionId);
    } catch (error) {
      // Whatever failed, the CLI goes with it: a `session/new` or
      // `session/load` that failed (a cursor the CLI no longer knows answers
      // "Path not found", fixture 13) used to leave it running, holding its
      // pipes, outside the adapter's map — nothing would ever stop it. What it
      // had started is recorded first, while it lives; its exit sweeps it
      // ({@link onExit}).
      await this.recordSessions("helpers");
      await connection.stop();
      await this.stopLeftovers();
      throw error;
    }
    // Its MCP servers, started with the session (fixture 31: all four existed
    // the moment `session/new` answered): per-session helpers, nobody's work.
    await this.recordSessions("helpers");

    const modelState = modelStateOf(initialize._meta) ?? (setup as { models?: unknown }).models;
    this.currentModelId = currentModelIdOf(modelState);
    this.currentReasoningEffort = currentEffortOf(modelState, this.currentModelId);
    this.contextWindow = contextWindowFromModelState(modelState, this.currentModelId);
    // The normaliser stamps the window onto EVERY meter row it emits, chunk
    // rows included — without it the client's last-writer-wins read of
    // `context-window.updated` alternated between a ringed row and a bare one.
    this.normalizer.setContextWindow(this.contextWindow);

    await this.applyModelSelection(this.options.modelSelection);

    if (this.stopped) {
      // The CLI ended while its session was still opening — after
      // `session/new` answered, on the `session/set_model` above, say: its
      // exit wrote no row ({@link onExit}), so this rejection is the whole
      // report. Announcing it ready would hand the host a dead session.
      throw new Error(this.openAbortedMessage());
    }
    this.status = "ready";
    this.touch();
    this.announced = true;
    this.emitEvent(
      this.normalizer.event("session.started", {
        ...(cursor === null ? {} : { resume: cursor })
      })
    );
    this.emitEvent(this.normalizer.event("session.state.changed", { state: "ready" }));
    this.emitEvent(this.normalizer.event("thread.started", { providerThreadId: this.acpSessionId }));
    if (this.contextWindow !== undefined) {
      this.emitEvent(
        this.normalizer.event("thread.token-usage.updated", {
          usage: {
            usedTokens: this.normalizer.contextSize ?? 0,
            maxTokens: this.contextWindow,
            compactsAutomatically: true
          }
        })
      );
    }
  }

  private async openNewSession(): Promise<NewSessionResponse> {
    const response = await this.peer().request<NewSessionResponse>(
      "session/new",
      // `mcpServers: []` is explicit: `session/new` boots every MCP server the
      // host has configured — 157 tools in ~3 s, discovered from the user's
      // `~/.claude.json` via Grok's Claude-compat layer. A chat thread does
      // not inherit that fleet by accident.
      { cwd: this.options.cwd, mcpServers: [] },
      { timeoutMs: AGENT_HOST_DEADLINES.sessionOpenMs }
    );
    this.acpSessionId = response.sessionId;
    this.normalizer.bindSession(response.sessionId);
    return response;
  }

  /**
   * `session/load`, never `session/resume`.
   *
   * The spec says `resume` is "gated on an agent capability Grok does not
   * declare"; 1.0.34 **does** declare `sessionCapabilities.resume`, so the
   * capability check no longer distinguishes the two and the choice has to be
   * explicit. `load` is the documented path and it works — it answered in
   * 266 ms after five replayed notifications, so the spec's 2 s replay-idle
   * race and its synthetic response are no longer the design centre. The
   * overall 90 s cap stays.
   */
  private async loadSession(sessionId: string): Promise<LoadSessionResponse> {
    this.acpSessionId = sessionId;
    this.normalizer.bindSession(sessionId);
    return await this.peer().request<LoadSessionResponse>(
      "session/load",
      { sessionId, cwd: this.options.cwd, mcpServers: [] },
      { timeoutMs: AGENT_HOST_DEADLINES.sessionOpenMs }
    );
  }

  private peer(): AcpConnection["peer"] {
    const connection = this.connection;
    if (connection === null) {
      throw new Error("grok: session has no transport");
    }
    return connection.peer;
  }

  // -------------------------------------------------------------- handlers

  private registerHandlers(connection: AcpConnection): void {
    const peer = connection.peer;

    peer.onNotification("session/update", (params) => this.onSessionUpdate(params as SessionNotification));

    // BOTH private channels. An adapter that registers only the live one
    // silently loses every replayed row on `session/load`.
    for (const method of [
      XAI_EXTENSION_NOTIFICATIONS.session_notification,
      XAI_EXTENSION_NOTIFICATIONS.session_update
    ]) {
      peer.registerExtensionNotification(method, (params) => this.onPrivateChannel(method, params));
    }

    // Background work reported by methods of their own: a task started, a
    // shell's or monitor's end (fixtures 16, 18, 20), a monitor's line, the
    // scheduler's loops (fixture 29) — each registered, where an unregistered
    // one was a peer warning per frame, one per fire of a week-long loop.
    for (const method of [
      XAI_EXTENSION_NOTIFICATIONS.task_backgrounded,
      XAI_EXTENSION_NOTIFICATIONS.task_completed,
      XAI_EXTENSION_NOTIFICATIONS.monitor_event,
      XAI_EXTENSION_NOTIFICATIONS.scheduled_task_created,
      XAI_EXTENSION_NOTIFICATIONS.scheduled_task_fired,
      XAI_EXTENSION_NOTIFICATIONS.scheduled_task_deleted
    ]) {
      peer.registerExtensionNotification(method, (params) => this.onBackgroundFrame(method, params));
    }

    peer.registerExtensionNotification(XAI_EXTENSION_NOTIFICATIONS.prompt_complete, (params) => {
      this.onPromptComplete(params as XaiPromptCompleteParams);
    });

    peer.registerExtensionNotification(XAI_EXTENSION_NOTIFICATIONS.queue_changed, (params) => {
      this.onQueueChanged(params);
    });

    // Product payloads. Registered so they do not raise an unknown-method
    // warning on every session, and deliberately never surfaced.
    for (const method of [
      XAI_EXTENSION_NOTIFICATIONS.settings_update,
      XAI_EXTENSION_NOTIFICATIONS.announcements_update,
      XAI_EXTENSION_NOTIFICATIONS.sessions_changed
    ]) {
      peer.registerExtensionNotification(method, () => {});
    }
    // Never surfaced either, but the CLI's own word that its MCP servers are
    // booting: while the session opens, its children are recorded as helpers.
    for (const method of [
      XAI_EXTENSION_NOTIFICATIONS.mcp_init_progress,
      XAI_EXTENSION_NOTIFICATIONS.mcp_initialized,
      XAI_EXTENSION_NOTIFICATIONS.mcp_servers_updated
    ]) {
      peer.registerExtensionNotification(method, () => {
        this.recordHelpersWhileOpening();
      });
    }

    peer.registerExtensionNotification(XAI_EXTENSION_NOTIFICATIONS.models_update, (params) => {
      const state = params as { currentModelId?: unknown };
      if (typeof state.currentModelId === "string") {
        this.currentModelId = state.currentModelId;
        this.contextWindow = contextWindowFromModelState(params, this.currentModelId) ?? this.contextWindow;
        this.normalizer.setContextWindow(this.contextWindow);
      }
    });

    peer.registerExtensionNotification(XAI_EXTENSION_NOTIFICATIONS.mcp_server_status, (params) => {
      this.recordHelpersWhileOpening();
      const record = params as { status?: unknown; name?: unknown; sessionId?: unknown };
      const status = record.status;
      // One warning per server and failure until it reports ready again: the
      // CLI re-handshakes the thread's servers whenever a subagent's child
      // session boots, and reports the same failure again under the parent's
      // id (fixtures 15–23: `stripe` unavailable at the session's start and
      // again at each spawn). A report under a child session's own id — none
      // captured — would be the same servers: the parent's stands.
      if (!this.isParentSession(record.sessionId)) {
        return;
      }
      const key = `${String(record.name)}\u0000${String(status)}`;
      if (status === "ready") {
        for (const warned of [...this.mcpWarned]) {
          if (warned.startsWith(`${String(record.name)}\u0000`)) {
            this.mcpWarned.delete(warned);
          }
        }
        return;
      }
      if (this.mcpWarned.has(key)) {
        return;
      }
      this.mcpWarned.add(key);
      if (typeof status === "string" && status !== "ready") {
        this.emitEvent(
          this.normalizer.event("runtime.warning", {
            message: `grok: MCP server not ready`,
            detail: { name: (params as { name?: unknown }).name, status }
          })
        );
      }
    });

    peer.onRequest("session/request_permission", async (params) =>
      await this.onPermissionRequest(params as RequestPermissionRequest)
    );

    peer.registerExtension(XAI_EXTENSION_REQUESTS.ask_user_question, async (params) =>
      await this.onAskUserQuestion(params as XaiAskUserQuestionParams)
    );

    peer.registerExtension(XAI_EXTENSION_REQUESTS.exit_plan_mode, async (params) =>
      await this.onExitPlanMode(params as XaiExitPlanModeParams)
    );
  }

  // ------------------------------------------------------------- approvals

  private async onPermissionRequest(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const requestType = permissionRequestType(params.toolCall);
    const grantKey = approvalGrantKey(params.toolCall);

    // The three silent paths, in the order §4.3 and §4.4 define them.
    const auto =
      autoApprovesEverything(this.options.runtimeMode) ||
      (grantKey !== undefined && this.sessionGrants.has(grantKey)) ||
      (autoApprovesEdits(this.options.runtimeMode) && isEditApproval(params.toolCall));
    if (auto) {
      const optionId = autoApprovesEverything(this.options.runtimeMode)
        ? selectAutoApprovedOptionId(params.options)
        : // A remembered grant replays as `allow_once`, never `allow_always`:
          // the host owns the session scope and must not let Grok also
          // remember it, or the two can disagree about what is approved.
          selectPermissionOptionId(params.options, "accept");
      if (optionId !== undefined) {
        return { outcome: { outcome: "selected", optionId } };
      }
      // No usable option: fall through and ask rather than cancel.
    }

    // A card, in order behind what the CLI streamed before it: the frames
    // held for a prompt of its own waiting for a turn join the open turn
    // first. Only for a request of the parent's — a child session's has
    // nothing to do with them — and never for one answered without a card.
    if (this.isParentSession(params.sessionId)) {
      this.wakes.merge("a request the user must answer arrived");
    }

    const requestId = this.options.uuid();
    const decision = deferred<ApprovalDecision>();
    // The card's one resolution row, where it is settled (`PendingApproval`).
    const settle = (resolved: ApprovalDecision, withdrawn: boolean): void => {
      if (!this.pendingApprovals.delete(requestId)) {
        return;
      }
      this.emitEvent(
        this.normalizer.requestResolved({
          requestId,
          requestType,
          decision: resolved,
          ...(withdrawn ? { withdrawn: true as const } : {})
        })
      );
      decision.resolve(resolved);
    };
    this.pendingApprovals.set(requestId, {
      requestType,
      resolve: (answer) => settle(answer, false),
      withdraw: () => settle("cancel", true)
    });

    this.emitEvent(
      this.normalizer.requestOpened({
        requestId,
        requestType,
        detail: permissionDetail(params.toolCall),
        args: params.toolCall,
        raw: { source: ACP_RAW_SOURCE, method: "session/request_permission", payload: params }
      })
    );

    const resolved = await decision.promise;
    const optionId = resolved === "cancel" ? undefined : selectPermissionOptionId(params.options, resolved);
    if (resolved === "acceptForSession" && optionId !== undefined && grantKey !== undefined) {
      this.sessionGrants.add(grantKey);
    }
    return optionId === undefined
      ? { outcome: { outcome: "cancelled" } }
      : { outcome: { outcome: "selected", optionId } };
  }

  respondToApproval(requestId: string, decision: ApprovalDecision): void {
    const pending = this.pendingApprovals.get(requestId);
    if (pending === undefined) {
      throw new Error(`grok: no pending approval ${requestId}`);
    }
    pending.resolve(decision);
  }

  // --------------------------------------------------------------- questions

  private async onAskUserQuestion(params: XaiAskUserQuestionParams): Promise<unknown> {
    const turnId = this.questionTurnId(params);
    if (turnId !== null) {
      this.wakes.merge("a question the user must answer arrived");
    }
    const requestId = this.options.uuid();
    const pending = deferred<Record<string, unknown> | null>();
    // The card's one resolution row, where it is settled (`PendingUserInput`).
    const settle = (answers: Record<string, unknown> | null): void => {
      if (!this.pendingUserInputs.delete(requestId)) {
        return;
      }
      this.emitEvent(this.normalizer.userInputResolved(requestId, answers ?? {}, turnId, answers === null));
      pending.resolve(answers);
    };
    this.pendingUserInputs.set(requestId, {
      params,
      turnId,
      resolve: (answers) => settle(answers),
      withdraw: () => settle(null)
    });

    this.emitEvent(
      this.normalizer.userInputRequested({
        requestId,
        params,
        turnId,
        raw: {
          source: XAI_RAW_SOURCE,
          method: XAI_EXTENSION_REQUESTS.ask_user_question,
          payload: params
        }
      })
    );

    const answers = await pending.promise;
    return answers === null ? { outcome: "cancelled" } : answersToXaiResponse(params, answers);
  }

  /**
   * The turn a question's rows ride — Codex's `questionTurnId` rule. A turn's
   * end dismisses every question on it, in the log only, never answering the
   * adapter (`settleStrandedQuestions` in the orchestrator, §6.2: there the
   * provider's request died with its turn). So a question whose asker
   * outlives the open turn rides NONE, and is answered or cancelled like any
   * other card (a Stop, the exit, a host's first load settle it):
   * - one the CLI's own prompt asks while it waits for its turn — fixture
   *   20's window, before our RPC result: on our turn it was swept at our
   *   turn's end while the CLI stayed blocked, and the wake's turn read
   *   running with no card and no progress, holding a deploy's drain;
   * - one a subagent's child session asks, whose run is not our turn's.
   * Any other question rides the open turn — the wake's own, once its turn
   * is open. Stamped once, so the request and its resolution agree.
   */
  private questionTurnId(params: XaiAskUserQuestionParams): string | null {
    if (!this.isParentSession(params.sessionId) || this.wakes.waitingPromptRuns()) {
      return null;
    }
    return this.activeTurn?.turnId ?? null;
  }

  respondToUserInput(requestId: string, answers: Record<string, unknown>): void {
    const pending = this.pendingUserInputs.get(requestId);
    if (pending === undefined) {
      throw new Error(`grok: no pending question ${requestId}`);
    }
    pending.resolve(answers);
  }

  /**
   * Nobody's answer — the host's cancel (a Stop, the session's stop, a closed
   * tab): `cancelled` to the CLI and one `withdrawn` row, exactly what this
   * session's own teardown does to a card ({@link withdrawPendingRequests}).
   */
  withdrawUserInput(requestId: string): void {
    const pending = this.pendingUserInputs.get(requestId);
    if (pending === undefined) {
      throw new Error(`grok: no pending question ${requestId}`);
    }
    pending.withdraw();
  }

  // ------------------------------------------------------------- plan gate

  /**
   * `_x.ai/exit_plan_mode`. We **abandon the native gate**: the plan is
   * captured as `turn.proposed.completed` and the agent is told to stop, or
   * the turn hangs on a dialog the user cannot see.
   *
   * The reply is a FLAT `{outcome, feedback}` — observed verbatim — unlike
   * `session/request_permission`, which nests as `{outcome:{outcome}}`.
   */
  private async onExitPlanMode(params: XaiExitPlanModeParams): Promise<unknown> {
    this.wakes.merge("a plan the user must see arrived");
    const planContent = params.planContent?.trim();
    const markdown =
      planContent !== undefined && planContent.length > 0
        ? planContent
        : (this.normalizer.lastPlanMarkdown ?? XAI_EMPTY_PLAN_MARKDOWN);
    this.emitEvent(
      this.normalizer.event(
        "turn.proposed.completed",
        { planMarkdown: markdown },
        undefined,
        {
          source: XAI_RAW_SOURCE,
          method: XAI_EXTENSION_REQUESTS.exit_plan_mode,
          payload: params
        }
      )
    );
    this.normalizer.clearPlanFallback();
    return await Promise.resolve({ outcome: "abandoned", feedback: XAI_EXIT_PLAN_FEEDBACK });
  }

  // ----------------------------------------------------------------- turns

  /**
   * Send one turn.
   *
   * **Steering is cancel-then-send, not injection.** Two overlapping
   * `session/prompt` calls are both accepted and the second is **queued**, not
   * interleaved: in `08-steering-second-prompt.ndjson` the model finished
   * counting to 20 before it answered "stop counting". §4.1 promises that a
   * `sendTurn` during a live turn reuses the turn id and reaches the running
   * loop, and the only way to honour that on this protocol is to settle the
   * open requests, send `session/cancel`, and then prompt again under the same
   * turn id — which is what T3 does.
   */
  async sendTurn(input: {
    text: string;
    attachments?: ReadonlyArray<{ id: string; name: string; path: string; mimeType?: string }>;
    modelSelection?: ModelSelection;
    interactionMode: "default" | "plan";
  }): Promise<{ turnId: string; resumeCursor: GrokResumeCursor }> {
    return await this.serialize(async () => {
      if (this.stopped) {
        throw new Error("grok: session is stopped");
      }
      const steering = this.activeTurn !== null && !this.activeTurn.settled;
      const turnId = steering ? this.activeTurn!.turnId : `grok-turn-${this.options.uuid()}`;
      this.epoch += 1;
      const epoch = this.epoch;

      if (steering) {
        // Move the turn to this generation BEFORE the cancel goes out. The
        // superseded prompt will answer `stopReason:"cancelled"` within
        // milliseconds; without this it still matches `turn.epoch` and ends
        // the turn, and the steered prompt's real result is then dropped
        // because `activeTurn` is already null. A turn the CLI started on its
        // own (a wake) is steered the same way — the CLI's own advice is that
        // "sending a message interrupts the wait and runs your message right
        // away" — and becomes this prompt's: the woken prompt's cancelled
        // `turn_completed` must not settle it.
        this.activeTurn!.epoch = epoch;
        this.activeTurn!.providerPromptId = undefined;
        this.activeTurn!.wakePromptId = undefined;
        await this.settlePendingAsCancelled();
        this.wakes.cancelEnds();
        try {
          this.peer().notify("session/cancel", { sessionId: this.acpSessionId });
        } catch {
          // A cancel that cannot be written is not a reason to drop the turn.
        }
        // The superseded prompt's calls: the cancel cut them, and the CLI
        // answers none of them ({@link GrokNormalizer.cutTurnCalls}).
        this.emitAll(this.normalizer.cutTurnCalls("Cancelled: a new message was sent."));
        // Re-open the assistant stream: `endTurn()` may have closed it, and a
        // closed stream silently drops every chunk the steered prompt streams.
        this.normalizer.beginTurn();
      } else {
        this.openTurn({ turnId, epoch, settled: false, interrupted: false });
      }

      if (input.modelSelection !== undefined) {
        await this.applyModelSelection(input.modelSelection);
      }
      await this.applyInteractionMode(input.interactionMode);

      // Attachments reach the agent as PATHS, not bytes:
      // `agentCapabilities.promptCapabilities.image` is **false** on this CLI,
      // so T3's "Grok ingests images only" path would be sending a content
      // block the agent has said it cannot take. A path line is something the
      // agent's own `read_file` tool can act on. The shared helper skips a path
      // the text already names — the composer inserts it at upload time (§7.4).
      const text = appendAttachmentPathLines(input.text, input.attachments ?? []);
      const prompt = [{ type: "text" as const, text }];
      const promise = this.peer().request<PromptResponse>(
        "session/prompt",
        { sessionId: this.acpSessionId, prompt },
        // No deadline of its own: `session/prompt` legitimately runs for as
        // long as the model works, and the liveness watchdog is what bounds
        // it (§3.1). A fixed timeout here would cancel real work.
        { timeoutMs: 0 }
      );
      this.trackPrompt(turnId, epoch, promise);

      return {
        turnId,
        resumeCursor: { schemaVersion: GROK_RESUME_SCHEMA_VERSION, sessionId: this.acpSessionId }
      };
    });
  }

  private trackPrompt(turnId: string, epoch: number, promise: Promise<PromptResponse>): void {
    void promise.then(
      (response) => {
        void this.serialize(async () => {
          await Promise.resolve();
          // The RPC result is the RICHEST source (README 18): it is the only
          // one carrying both the usage block and the resulting context size,
          // so it wins over the `turn_completed` notification that races it.
          const fromResult = parsePromptResultUsage(response._meta);
          this.settleTurn(turnId, epoch, {
            stopReason: response.stopReason ?? null,
            // No `prompt_complete` arrived (a locally handled slash command
            // produces none, README 18), so the hook the CLI fires on a
            // decline is the only discriminant left (R4 #9).
            ...(this.activeTurn?.outcome?.cancellationCategory === undefined &&
            this.normalizer.sawPermissionDenied
              ? { cancellationCategory: "PermissionRejected" }
              : {}),
            usage: fromResult.usage ?? this.normalizer.turnUsage(),
            ...(fromResult.contextTokens === undefined
              ? {}
              : { contextTokens: fromResult.contextTokens })
          });
        });
      },
      (error: unknown) => {
        void this.serialize(async () => {
          await Promise.resolve();
          if (this.activeTurn?.interrupted === true) {
            // A cancelled prompt rejects; the interrupt already settled it.
            return;
          }
          if (this.stopped) {
            // A host-initiated stop kills the child, which rejects the parked
            // prompt. `stop()` has already settled the turn and nulled
            // `activeTurn`, so without this guard a clean user Stop emits a
            // spurious `runtime.error` AFTER `session.exited` — breaking
            // §4.1's "everything is settled before session.exited" (Q1 #22).
            return;
          }
          this.settleTurn(
            turnId,
            epoch,
            { stopReason: null },
            error instanceof Error ? error.message : String(error)
          );
          this.emitEvent(
            this.normalizer.event("runtime.error", {
              message: error instanceof Error ? error.message : String(error),
              class: classifyAcpError(error)
            })
          );
        });
      }
    );
  }

  /**
   * Resolve the provider's own prompt id for the active turn.
   *
   * Keyed on `_meta.promptId`, which **every** `session/update` carries
   * (README 19) — not on the prompt TEXT. The text key was wrong twice: it ran
   * synchronously at send time, before `_x.ai/queue/changed` arrives ~5 ms
   * later, so it almost always missed; and after a steer the active turn
   * already held an id, so the steered prompt's id was never claimed at all
   * (R4 #12). The FIRST id seen for a turn wins, so a steer keeps reporting
   * the prompt that actually produced the answer.
   */
  private notePromptId(promptId: string | undefined): void {
    if (promptId === undefined || promptId.length === 0 || this.wakes.isCliPrompt(promptId)) {
      return;
    }
    const turn = this.activeTurn;
    if (turn === null || turn.settled || turn.providerPromptId !== undefined) {
      return;
    }
    turn.providerPromptId = promptId;
  }

  /** A frame of the thread's own ACP session — not a subagent's child session. */
  private isParentSession(sessionId: unknown): boolean {
    return isParentSessionId(this.acpSessionId, sessionId);
  }

  /** One `session/update`, through the wake gate ({@link GrokWakes.offer}). */
  private onSessionUpdate(notification: SessionNotification): void {
    if (this.wakes.offer(notification, () => this.onSessionUpdate(notification))) {
      return;
    }
    // A subagent's child session streams under its own id (fixture 15): its
    // prompt ids are its own, never a turn of ours.
    if (this.isParentSession(notification.sessionId)) {
      this.notePromptId(promptIdOf(notification._meta));
    }
    this.emitAll(this.normalizer.handleSessionUpdate(notification));
  }

  /** One private-channel frame, through the gate; the live one may settle a CLI prompt's turn. */
  private onPrivateChannel(method: string, params: unknown): void {
    if (this.wakes.offer(params, () => this.onPrivateChannel(method, params))) {
      return;
    }
    this.emitAll(this.normalizer.handleXaiNotification(method, params));
    if (method === XAI_EXTENSION_NOTIFICATIONS.session_notification) {
      this.onPrivateUpdate(params);
    }
  }

  /** A task's start or end, or a monitor's line — through the gate, in order with the rest. */
  private onBackgroundFrame(method: string, params: unknown): void {
    if (this.wakes.offer(params, () => this.onBackgroundFrame(method, params))) {
      return;
    }
    this.emitAll(this.normalizer.handleXaiNotification(method, params));
  }

  /**
   * `_x.ai/queue/changed`, the parent session's prompt queue — which also
   * tells a prompt of ours from one the CLI starts ON ITS OWN
   * (`prompt-queue.ts`): `subagent-completed-<id>` when a background
   * subagent's end wakes the parent, `task-completed-<id>` when a monitor
   * ends, `notifications-<uuid>` for a monitor's line (fixtures 16, 19, 20,
   * 22; README observation 40). Such a prompt streams the parent's reply like
   * any turn — and no RPC of ours answers it — so it gets a turn of its own
   * ({@link openWakeTurn}), as Claude's woken parent gets a synthetic one:
   * AT ONCE when no turn is open, before the next frame is read (its reply
   * may follow in the same read, and a chunk with no open turn is dropped —
   * safe against a `sendTurn` in flight, which decides steer-or-new inside
   * the per-thread lock by reading the open turn and opens its own before
   * its first await); else once the open turn settles ({@link settleTurn}),
   * its frames waiting with it. A child session's queue is its own and never
   * read here.
   */
  private onQueueChanged(params: unknown): void {
    if (this.stopped || !this.isParentSession((params as { sessionId?: unknown } | null)?.sessionId)) {
      return;
    }
    this.wakes.queueChanged(params);
  }

  /**
   * Open a turn and announce it: `turn.started`, the thread running. The one
   * place a turn opens — a `sendTurn` and a CLI prompt alike.
   */
  private openTurn(turn: ActiveTurn): void {
    this.activeTurn = turn;
    this.normalizer.clearPlanFallback();
    this.normalizer.beginTurn();
    this.status = "running";
    this.touch();
    this.emitEvent(this.normalizer.event("session.state.changed", { state: "running" }, turn.turnId));
    this.emitEvent(
      this.normalizer.event(
        "turn.started",
        {
          ...(this.currentModelId === undefined ? {} : { model: this.currentModelId }),
          ...(this.currentReasoningEffort === undefined ? {} : { effort: this.currentReasoningEffort })
        },
        turn.turnId
      )
    );
  }

  /**
   * A turn for the CLI's own prompt — no RPC; `GrokWakes` re-arms the
   * monitors it carries lines of and hands back the frames held for it.
   */
  private openWakeTurn(prompt: CliPrompt): void {
    this.epoch += 1;
    this.openTurn({
      turnId: `grok-turn-${this.options.uuid()}`,
      epoch: this.epoch,
      settled: false,
      interrupted: false,
      providerPromptId: prompt.promptId,
      wakePromptId: prompt.promptId
    });
  }

  /**
   * The parent's private channel, after the normaliser: the `turn_completed`
   * of a prompt the CLI started itself settles its turn with that frame's
   * stop reason and usage — the only report such a prompt gets (no
   * `prompt_complete`, no RPC result). One that ended while its frames
   * joined another turn has no turn of its own to settle
   * ({@link GrokWakes.offer}).
   */
  private onPrivateUpdate(params: unknown): void {
    const record = params as { sessionId?: unknown; update?: Record<string, unknown> } | null;
    const update = record?.update;
    if (update?.["sessionUpdate"] !== "turn_completed" || !this.isParentSession(record?.sessionId)) {
      return;
    }
    const promptId = update["prompt_id"];
    if (typeof promptId !== "string" || !this.wakes.isCliPrompt(promptId)) {
      return;
    }
    const stopReason = typeof update["stop_reason"] === "string" ? update["stop_reason"] : null;
    const usage = parseXaiUsage(update["usage"]);
    void this.serialize(async () => {
      await Promise.resolve();
      const turn = this.activeTurn;
      if (turn === null || turn.settled || turn.wakePromptId !== promptId) {
        return;
      }
      this.settleTurn(turn.turnId, turn.epoch, {
        stopReason,
        ...(usage === undefined ? {} : { usage })
      });
    });
  }

  /**
   * `_x.ai/session/prompt_complete` **races** the RPC result and always
   * arrived 1–3 ms BEFORE it, carrying the same stop reason. It is a
   * duplicate, not a substitute — and the poorer of the two, because only the
   * RPC result carries the usage block. So it is recorded and the RPC wins.
   *
   * Its `cancellationCategory` is the one thing the RPC does not carry, and it
   * is what tells a declined tool apart from a user Stop.
   */
  private onPromptComplete(params: XaiPromptCompleteParams): void {
    const turn = this.activeTurn;
    if (turn === null || turn.settled) {
      return;
    }
    const record = params as unknown as Record<string, unknown>;
    turn.outcome = {
      stopReason: typeof params.stopReason === "string" ? params.stopReason : null,
      ...(typeof record["cancellationCategory"] === "string"
        ? { cancellationCategory: record["cancellationCategory"] }
        : {}),
      ...(typeof record["cancellationContext"] === "object" && record["cancellationContext"] !== null
        ? {
            cancellationReason: String(
              (record["cancellationContext"] as Record<string, unknown>)["reason"] ?? ""
            )
          }
        : {})
    };
    if (params.stopReason === "rate_limit") {
      this.emitEvent(
        this.normalizer.event("runtime.error", {
          message: "Grok usage limit reached. Try again later.",
          class: "provider_error"
        })
      );
    }
  }

  private settleTurn(
    turnId: string,
    epoch: number,
    outcome: GrokTurnOutcome,
    errorMessage?: string
  ): void {
    const turn = this.activeTurn;
    if (turn === null || turn.turnId !== turnId || turn.settled) {
      return;
    }
    if (turn.epoch !== epoch) {
      // A superseded steer's prompt settling late must not end the live turn.
      return;
    }
    turn.settled = true;
    this.recordTurn(turn, outcome, errorMessage);

    const merged: GrokTurnOutcome = {
      ...turn.outcome,
      ...outcome,
      stopReason: outcome.stopReason ?? turn.outcome?.stopReason ?? null,
      usage: outcome.usage ?? turn.outcome?.usage ?? this.normalizer.turnUsage()
    };

    this.emitAll(this.normalizer.endTurn());
    if (merged.contextTokens !== undefined) {
      this.emitEvent(
        this.normalizer.event("thread.token-usage.updated", {
          usage: {
            usedTokens: merged.contextTokens,
            ...(this.contextWindow === undefined ? {} : { maxTokens: this.contextWindow }),
            compactsAutomatically: true
          }
        })
      );
    }
    this.emitEvent(this.normalizer.turnCompleted(turnId, merged, errorMessage));

    // Once per session, and only where approval cards were promised: under
    // `auto` / `full-access` the CLI resolving its own interactions is the
    // mode working. Said at every turn end, it filled a full-access thread's
    // timeline — and a woken turn ends too.
    if (
      !this.selfResolveAdvised &&
      expectsApprovalCards(this.options.runtimeMode) &&
      this.normalizer.approvalsWereSelfResolved
    ) {
      this.selfResolveAdvised = true;
      this.emitEvent(this.normalizer.event("runtime.warning", { message: grokConfigAdvisory() }));
    }

    this.activeTurn = null;
    if (!this.stopped) {
      this.status = "ready";
      this.touch();
      this.emitEvent(this.normalizer.event("session.state.changed", { state: "ready" }));
      // The CLI moved on to a prompt of its own while this turn was settling.
      this.wakes.turnSettled();
    }
  }

  /** Keep a bounded, opaque record of the turn for `readThread`. */
  private recordTurn(turn: ActiveTurn, outcome: GrokTurnOutcome, errorMessage?: string): void {
    this.recordedTurns.push({
      id: turn.turnId,
      items: [
        {
          // `observed_turn`: this process streamed the turn's events already,
          // so `projectHistory` must NOT project it again (history.ts).
          kind: "observed_turn" as const,
          providerPromptId: turn.providerPromptId ?? null,
          stopReason: outcome.stopReason,
          ...(outcome.cancellationCategory === undefined
            ? {}
            : { cancellationCategory: outcome.cancellationCategory }),
          ...(errorMessage === undefined ? {} : { errorMessage })
        }
      ]
    });
    while (this.recordedTurns.length > MAX_RECORDED_TURNS) {
      this.recordedTurns.shift();
    }
  }

  /**
   * Stop. **Turn-scoped**: a Stop naming a turn that is no longer the active
   * one is a no-op, so it cannot kill the next turn.
   *
   * Ordering is the contract (§4.1): every pending approval and user input is
   * settled as `cancel` FIRST, then `session/cancel` goes out, then the calls
   * it cut are closed on the turn (the CLI answers none of them), then the
   * turn is settled. `05-cancel-with-pending-permission.ndjson` shows the CLI does
   * not actually wait for the pending permission — it settles the turn 3 ms
   * after the cancel and accepts a late `{"outcome":"cancelled"}` 2.5 s
   * afterwards — so the ordering is not load-bearing *here*, but it remains
   * correct and it is load-bearing for the transport: a peer that answered
   * requests inline would deadlock the other way round.
   */
  async interrupt(turnId?: string): Promise<void> {
    const turn = this.activeTurn;
    if (turn === null || turn.settled) {
      // §6.2: Stop is SESSION-scoped when the client names no turn. A thread
      // whose turn already settled can still be showing a live background
      // shell or subagent — that is precisely when §7.6 keeps the Stop button
      // up — so an early return here leaves the work running and the client's
      // `stopping` flag stuck, because `backgroundLiveness` never drops to
      // null (R6 #1). Only a turn-scoped Stop naming a turn that is not the
      // active one is a genuine no-op.
      if (turnId === undefined) {
        await this.stopSessionScopedWork();
      }
      return;
    }
    if (turnId !== undefined && turn.turnId !== turnId) {
      return;
    }
    // Marked BEFORE the lock so a settlement queued behind it bails out.
    turn.interrupted = true;

    await this.serialize(async () => {
      await this.settlePendingAsCancelled();
      this.wakes.cancelEnds();
      try {
        this.peer().notify("session/cancel", { sessionId: this.acpSessionId });
      } catch {
        // Nothing to cancel on a dead transport.
      }
      // The turn's own calls the cancel cut, closed on that turn before it
      // settles: the CLI never answers them (fixtures 05, 23, 31). Work that
      // outlives the turn — a background shell, a subagent's run — is not a
      // call of it ({@link GrokNormalizer.cutTurnCalls}).
      this.emitAll(this.normalizer.cutTurnCalls("Stopped."));
      this.settleTurn(turn.turnId, turn.epoch, {
        stopReason: "cancelled",
        cancellationCategory: "MidTurnAbort",
        usage: this.normalizer.turnUsage()
      });
    });
  }

  /**
   * The §6.2 session-scoped stop, with no turn to settle: release anything the
   * user could still be waiting on, tell the agent to stop whatever it is
   * running, and close every open call and live background task so the
   * roster empties and `backgroundLiveness` clears — the calls FIRST, then
   * the tasks, as every adapter's teardown orders them (a background shell's
   * call closes before its task).
   *
   * `session/cancel` is the only lever that reaches Grok's background work —
   * the tasks are children of the CLI process and it exposes no per-task kill
   * to the client (the model kills its own through `KillTask`). Captured
   * (fixture 21): it cancels a background subagent (`subagent_finished
   * {status: "cancelled"}`) and leaves a background shell running, which a
   * later CLI report then counts live again. The session itself stays up: the
   * user pressed Stop, not Close.
   */
  private async stopSessionScopedWork(): Promise<void> {
    if (this.stopped) {
      return;
    }
    await this.serialize(async () => {
      await this.settlePendingAsCancelled();
      try {
        this.peer().notify("session/cancel", { sessionId: this.acpSessionId });
      } catch {
        // Nothing to cancel on a dead transport.
      }
      this.emitAll(this.normalizer.failOpenTools("Stopped."));
      this.emitAll(this.normalizer.stopBackgroundTasks());
    });
  }

  private async settlePendingAsCancelled(): Promise<void> {
    this.withdrawPendingRequests();
    await Promise.resolve();
  }

  /**
   * Settle every parked card with nobody's answer: one `withdrawn` row each,
   * emitted now, and the CLI's `cancelled` — never a second row from the
   * handler that awaited it.
   */
  private withdrawPendingRequests(): void {
    for (const pending of [...this.pendingApprovals.values()]) {
      pending.withdraw();
    }
    for (const pending of [...this.pendingUserInputs.values()]) {
      pending.withdraw();
    }
  }

  // ----------------------------------------------------------------- model

  /**
   * Plan mode is per turn (§4.4), and Grok's column there is "none": the mode
   * is entered by the MODEL through `enter_plan_mode`, which is why
   * `showPlanModeToggle` is false and the UI never sends `"plan"`. If it ever
   * does, `session/set_mode` is honoured — `13-errors-and-rpcs.ndjson` shows
   * it accepted (and answered with a `current_mode_update`) even though the
   * agent advertises no `modeState`. Best-effort: a refusal must not fail the
   * turn.
   */
  private async applyInteractionMode(mode: "default" | "plan"): Promise<void> {
    const desired = mode === "plan" ? "plan" : "default";
    if (this.normalizer.modeId === desired) {
      return;
    }
    if (mode === "default" && this.normalizer.modeId === undefined) {
      // Never advertised a mode and none was requested: sending one would be
      // an unprompted state change.
      return;
    }
    try {
      await this.peer().request(
        "session/set_mode",
        { sessionId: this.acpSessionId, modeId: desired },
        { timeoutMs: AGENT_HOST_DEADLINES.probeMs }
      );
    } catch (error) {
      this.emitEvent(
        this.normalizer.event("runtime.warning", {
          message: `grok: could not switch to ${desired} mode`,
          detail: { error: error instanceof Error ? error.message : String(error) }
        })
      );
    }
  }

  private async applyModelSelection(selection: ModelSelection | undefined): Promise<void> {
    const update = resolveGrokModelUpdate(selection, {
      currentModelId: this.currentModelId,
      currentReasoningEffort: this.currentReasoningEffort
    });
    if (update === null) {
      return;
    }
    const key = `${update.modelId}\u0000${update.meta?.reasoningEffort ?? ""}`;
    if (this.refusedModels.has(key)) {
      return;
    }
    try {
      await this.peer().request(
        "session/set_model",
        {
          sessionId: this.acpSessionId,
          modelId: update.modelId,
          ...(update.meta === undefined ? {} : { _meta: update.meta })
        },
        { timeoutMs: AGENT_HOST_DEADLINES.probeMs }
      );
      this.currentModelId = update.modelId;
      if (update.meta !== undefined) {
        this.currentReasoningEffort = update.meta.reasoningEffort;
      }
    } catch (error) {
      if (this.stopped) {
        // The CLI is gone: its exit (or an open's rejection) is the report,
        // not a model it could not switch to.
        return;
      }
      // A rejected model must not fail the turn: the session keeps the model
      // it has and the user is told which one it is — once.
      if (error instanceof AcpRpcError && error.code === ACP_ERROR_CODES.invalidParams) {
        this.refusedModels.add(key);
      }
      this.emitEvent(
        this.normalizer.event("runtime.warning", {
          message: `grok: could not switch model to ${update.modelId}`,
          detail: { error: error instanceof Error ? error.message : String(error) }
        })
      );
    }
  }

  // ------------------------------------------------------------- liveness
  //
  // **The turn liveness watchdog is the HOST's, not the adapter's.** T3 runs
  // it inside its Grok adapter, and an earlier revision of this file did the
  // same; `orchestration/turn-watchdog.ts` now runs it for every adapter off
  // the same runtime event stream, and calls `interruptTurn` on a stall. Two
  // watchdogs on identical windows race: both fire, the turn is settled twice
  // and the user sees two terminal rows. So there is none here — the adapter's
  // duty is only to emit the events the host's watchdog reads (`turn.started`,
  // `content.delta`, the `item.*` tool lifecycle, `request.opened` /
  // `request.resolved` for the pause) and to honour the `interruptTurn` that
  // follows, which {@link interrupt} does.

  // ---------------------------------------------------------------- stderr

  private onStderr(line: ClassifiedStderrLine): void {
    if (line.class === "error") {
      this.emitEvent(
        this.normalizer.event("runtime.error", { message: line.text, class: "provider_error" })
      );
      return;
    }
    this.emitEvent(this.normalizer.event("runtime.warning", { message: line.text }));
  }

  // ------------------------------------------------------------------ exit

  private onExit(reason: ChildExitReason, stderrTail: string): void {
    if (!this.announced) {
      // The open failed, or is failing: `start()` rejects, and that rejection
      // is the whole report — the host writes it. An exit row here read as a
      // crash of a session that never ran. Nothing can be open yet: no turn,
      // no card, no task.
      this.exitBeforeOpen = { reason, stderrTail };
      this.stopped = true;
      void this.stopLeftovers();
      this.options.onClosed?.(this.threadId);
      return;
    }
    if (this.stopped && this.hostInitiatedStop) {
      // Already settled by `stop()`, which awaits this same sweep.
      this.emitExited(reason, stderrTail, true);
      void this.stopLeftovers();
      this.options.onClosed?.(this.threadId);
      return;
    }
    this.stopped = true;
    this.settleEverythingForExit(reason, stderrTail);
    this.emitExited(reason, stderrTail, false);
    // The rows above closed every task `stopped`; this makes it so — the
    // helpers, and the user's work when the user is ending the session (an
    // exit on the cancel of its card, {@link prepareUserEnd}). Started before
    // `onClosed`, so the adapter's teardown can wait for it.
    void this.sweepLeftovers();
    this.options.onClosed?.(this.threadId);
  }

  /**
   * Every sweep this end calls for: the helpers' ({@link stopLeftovers}),
   * and the user's work when the user is ending the session ({@link
   * stopTaskLeftovers}). What the adapter's teardown waits for once the CLI
   * is gone. Never rejects.
   */
  sweepLeftovers(): Promise<void> {
    return Promise.all([this.stopLeftovers(), this.endingByUser ? this.stopTaskLeftovers() : undefined]).then(
      () => undefined
    );
  }

  /**
   * Stop what this launch left running once the CLI is gone — by the rule a
   * deploy must never kill running work.
   *
   * The CLI starts its MCP servers and background shells in sessions of
   * their own (Grok fixtures README observation 48), so the group signal of
   * `connection.stop()` reaches the CLI alone and they are reparented to init
   * when it goes. Found by the launch marker they inherited
   * ({@link launchId}) in the sessions recorded while the CLI lived
   * (`support/leftover-processes.ts`: SIGTERM, SIGKILL past the grace, never
   * a recycled pid, never a process that daemonized away; Linux-only, a no-op
   * elsewhere), two kinds are swept differently:
   *
   * - **The CLI's own helpers** ({@link helperSessions}: its MCP servers) at
   *   EVERY end — a restart (account, permission mode, cwd), the host's
   *   teardown (a drain-restart's included), the CLI's own exit (a crash, an
   *   open that failed), the user's stop. They are pure per-session leaks:
   *   two survived every session until 2026-09-26. The host's teardown waits
   *   for this sweep (`GrokAdapter.stopAll`), and gives them a 1 s grace
   *   ({@link HOST_TEARDOWN_SWEEP_GRACE_MS}): the host's process entry exits
   *   3 s after a SIGTERM whatever the stop is doing, so a CLI that ignores
   *   SIGTERM itself — its own 2 s grace first — can see a helper that ignores
   *   it too outlive the backstop, a marked orphan Settings → System lists.
   * - **The user's work** ({@link taskSessions}: the shells the agent ran, the
   *   dev servers they started) ONLY when the user ends the session — the
   *   session stop command or a closed tab — by a sweep of its own
   *   ({@link stopTaskLeftovers}); this one sweeps the helpers alone, and an
   *   exit in the middle of the user's stop starts it. A deploy's drain waits
   *   for live work only within its bound (a watch loop's TTL, an agent's
   *   hour), and a dev server started in a Grok chat must survive every deploy
   *   after it; so must a thread's restart, and at a crash nobody ended
   *   anything. It runs on then as a marked orphan, listed and killable in
   *   Settings → System (`system-status.ts`). A Claude chat's background shells
   *   outlive their session too: the SDK closes the Claude CLI's stdin and
   *   SIGTERMs it 2 s later, before the CLI's own wind-down would stop them.
   *
   * Before the session is announced every child is a helper — an open that
   * failed, and any end while the session opens (the CLI's death, the host's
   * teardown, a stop): nothing of the user's has run yet. They are recorded
   * as the CLI reports its MCP servers booting ({@link
   * recordHelpersWhileOpening}), so a CLI that dies before its open answers
   * leaves none unswept, and the sweep waits for a recording in flight. A
   * sweep that finds nothing recorded is not kept: a later call — once a
   * recording has landed — sweeps what it finds.
   *
   * This sweeps the helpers; idempotent once it found any; never rejects.
   */
  stopLeftovers(): Promise<void> {
    if (this.connection === null) {
      // Never launched: nothing carries the marker.
      return Promise.resolve();
    }
    if (this.leftovers !== null) {
      return this.leftovers;
    }
    const sweep: Promise<void> = this.helperRecording.then(async () => {
      const sessions = [...this.helperSessions.values()];
      if (sessions.length === 0) {
        if (this.leftovers === sweep) {
          this.leftovers = null;
        }
        return;
      }
      try {
        const result = await stopLeftoverProcesses({
          launchId: this.launchId,
          sessions,
          ...(this.sweepGraceMs === undefined ? {} : { graceMs: this.sweepGraceMs })
        });
        if (result.found > 0) {
          this.options.logger.debug("grok: stopped what the agent left running", { ...result });
        }
      } catch (error) {
        this.options.logger.warn("grok: could not stop what the agent left running", error);
      }
    });
    this.leftovers = sweep;
    return sweep;
  }

  /**
   * §3.1: a dead child never leaves a running turn. The in-flight turn is
   * settled, every open call and then every live task is closed and every
   * parked request is failed — all BEFORE `session.exited`.
   */
  private settleEverythingForExit(reason: ChildExitReason, stderrTail: string): void {
    // What the CLI streamed for its own prompts still waiting for a turn is
    // kept: it joins the open turn, in order, before that turn settles.
    this.wakes.drop("the agent process exited");
    const turn = this.activeTurn;
    const detail = stderrTail.trim().length > 0 ? `\n${stderrTail.trim()}` : "";

    // Before `session.exited`: each card's one row is emitted as it is
    // withdrawn, never by the handler, which resumes only after this returns.
    this.withdrawPendingRequests();

    this.emitAll(this.normalizer.failOpenTools("The agent process exited."));
    // Its work runs on past it — unless the user was ending the session, whose
    // stop sweeps it ({@link stop}).
    this.emitAll(this.normalizer.stopBackgroundTasks(this.endingByUser ? undefined : leftRunningNote("exit")));

    if (turn !== null && !turn.settled) {
      const outcome = exitOutcome(reason, this.hostInitiatedStop);
      const failed = outcome.status === "error";
      turn.settled = true;
      this.emitEvent(
        this.normalizer.turnCompleted(
          turn.turnId,
          { stopReason: null, usage: this.normalizer.turnUsage() },
          failed ? `The agent process ${outcome.reason ?? "exited"}.${detail}` : undefined
        )
      );
      this.activeTurn = null;
    }
  }

  private emitExited(reason: ChildExitReason, stderrTail: string, hostInitiated: boolean): void {
    const outcome = exitOutcome(reason, hostInitiated || this.hostInitiatedStop);
    this.status = outcome.status;
    this.lastError = outcome.status === "error" ? outcome.reason : undefined;
    this.touch();
    const excerpt = stderrTail.trim();
    this.emitEvent(
      this.normalizer.event("session.state.changed", {
        state: outcome.status,
        ...(outcome.reason === undefined ? {} : { reason: outcome.reason })
      })
    );
    this.emitEvent(
      this.normalizer.event("session.exited", {
        ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
        // A fresh session can always be started from the persisted cursor; the
        // host never respawns by itself (§3.1 "No restart backoff").
        recoverable: true,
        exitKind: outcome.exitKind,
        ...(excerpt.length === 0 ? {} : { detail: excerpt })
      })
    );
  }

  /**
   * Stop the user's work this launch left running: every process carrying
   * its marker in a session {@link recordSessions} recorded as a task's.
   * Only a user's end calls it ({@link stop}). Idempotent; never rejects.
   */
  private stopTaskLeftovers(): Promise<void> {
    if (this.connection === null || this.taskSessions.size === 0) {
      return Promise.resolve();
    }
    this.taskLeftovers ??= stopLeftoverProcesses({
      launchId: this.launchId,
      sessions: [...this.taskSessions.values()]
    }).then(
      (result) => {
        if (result.found > 0) {
          this.options.logger.debug("grok: stopped the work the agent left running", { ...result });
        }
      },
      (error: unknown) => {
        this.options.logger.warn("grok: could not stop the work the agent left running", error);
      }
    );
    return this.taskLeftovers;
  }

  /** Why an open ended before its session was announced: the CLI's exit, or the host's stop. */
  private openAbortedMessage(): string {
    const exit = this.exitBeforeOpen;
    if (exit === null || this.hostInitiatedStop) {
      return "grok: the session was stopped before it opened";
    }
    const tail = exit.stderrTail.trim();
    return `The agent process ${describeExit(exit.reason)} before its session opened.${tail.length > 0 ? `\n${tail}` : ""}`;
  }

  /**
   * Record the sessions the CLI's children lead, while it lives: as its
   * helpers' ({@link helperSessions}) while its session opens — as it reports
   * its MCP servers booting, once `session/new` answered, and at any end
   * before it was announced — as its work's ({@link taskSessions}) as it
   * reports the work and when its session ends after that — a session already
   * a helper's stays one. The sweep takes only processes in a recorded
   * session. Best-effort: a read that fails records nothing, and nothing is
   * then swept for it.
   */
  private async recordSessions(kind: "helpers" | "tasks"): Promise<boolean> {
    const pid = this.connection?.pid;
    if (pid === undefined) {
      return false;
    }
    let added = false;
    try {
      for (const session of await recordChildSessions(pid)) {
        if (kind === "helpers") {
          this.helperSessions.set(session.sid, session);
        } else if (!this.helperSessions.has(session.sid) && !this.taskSessions.has(session.sid)) {
          this.taskSessions.set(session.sid, session);
          added = true;
        }
      }
    } catch (error) {
      this.options.logger.warn("grok: could not record the agent's child sessions", error);
    }
    return added;
  }

  /**
   * The CLI reported new work (a shell, a monitor): record its session now,
   * while the CLI lives — a crash leaves nothing to read — and remember it
   * for a later user end. One recording at a time; never rejects.
   */
  private recordTaskWork(): void {
    this.taskRecording = this.taskRecording
      .then(async () => {
        if (!this.stopped && (await this.recordSessions("tasks"))) {
          await this.persistTaskSessions();
        }
      })
      .catch(() => undefined);
  }

  /**
   * The CLI reported its MCP servers booting (`_x.ai/mcp/servers_updated`,
   * `init_progress`, `initialized`, `server_status`): while its session is
   * still opening, record its children as helpers now — the recording after
   * `session/new` answered comes too late for a CLI that dies first (fixture
   * 31: `init_progress` 70 ms before that answer, every MCP server existing
   * by it). Only before the session is announced, when nothing of the user's
   * can have run: after it, a child may be the user's work, which only the
   * user's end may stop. One recording at a time; never rejects.
   */
  private recordHelpersWhileOpening(): void {
    if (this.announced || this.stopped) {
      return;
    }
    this.helperRecording = this.helperRecording
      .then(async () => {
        if (this.announced) {
          return;
        }
        const before = this.helperSessions.size;
        await this.recordSessions("helpers");
        if (this.helperSessions.size > before) {
          this.options.logger.debug("grok: recorded the agent's helpers while its session opened", {
            sessions: this.helperSessions.size
          });
        }
      })
      .catch(() => undefined);
  }

  /** Remember this launch's task sessions for a later user end. Never rejects. */
  private async persistTaskSessions(): Promise<void> {
    if (this.taskSessions.size === 0 || this.options.persistTaskSessions === undefined) {
      return;
    }
    try {
      await this.options.persistTaskSessions(this.launchId, [...this.taskSessions.values()]);
    } catch (error) {
      this.options.logger.warn("grok: could not remember the work the agent left running", error);
    }
  }

  /**
   * The user is ending this session, and the host is about to answer its
   * cards (`stopSessionInternal` calls this FIRST): a card's cancel can end
   * the CLI before {@link stop} runs, and a CLI that is gone gets no stop at
   * all. So now, while it lives: record the sessions its children lead as its
   * work (as helpers while it opens) and remember them for the end's sweep,
   * and mark the end as the user's — an exit in between closes its work
   * `stopped`, with no "Left running…", and sweeps it ({@link onExit}); the
   * sessions remembered are the thread's `sweepEndedSession`'s too. Never
   * rejects.
   */
  async prepareUserEnd(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.endingByUser = true;
    await this.taskRecording;
    if (await this.recordSessions(this.announced ? "tasks" : "helpers")) {
      await this.persistTaskSessions();
    }
  }

  /**
   * Host-initiated stop. Idempotent — a session that already ended still waits
   * for its sweep. `endedByUser`: the user ended the session (the session stop
   * command, a closed tab), and the work its agent left running goes with it
   * ({@link stopLeftovers}); any other stop — a restart (`cause: "restart"`),
   * the host's teardown (`"host"`) — leaves that work running, says so on its
   * closing row ({@link leftRunningNote}) and remembers its sessions for the
   * user's next end ({@link GrokSessionOptions.persistTaskSessions}).
   */
  async stop(options: { endedByUser?: boolean; cause?: GrokSessionEndCause } = {}): Promise<void> {
    if (this.stopped) {
      await this.stopLeftovers();
      return;
    }
    const endedByUser = options.endedByUser === true;
    this.endingByUser = endedByUser;
    if (options.cause === "host") {
      // Under the SIGTERM path's backstop: a shorter grace for the helpers.
      this.sweepGraceMs = HOST_TEARDOWN_SWEEP_GRACE_MS;
    }
    // FIRST — before the host path is armed and before anything reaches the
    // CLI (the card's cancel below can end it): every child's session, while
    // the CLI still lives, after any recording already in flight. Once it is
    // gone its children are init's, and only their sessions tie them to it.
    // The user's end has recorded them once already, before the host
    // answered the cards ({@link prepareUserEnd}): this adds what came since.
    await this.taskRecording;
    // While the session opens nothing of the user's has run: every child is a
    // helper, the failed-open rule — recorded as work, a host teardown during
    // the open left the MCP servers running and remembered them as the user's.
    await this.recordSessions(this.announced ? "tasks" : "helpers");
    if (this.stopped) {
      // It ended while they were read, and its exit settled the session
      // ({@link onExit}). The user's work is still the user's to stop — and
      // anyone else's end leaves it running, remembered for the user's.
      await Promise.all([this.stopLeftovers(), endedByUser ? this.stopTaskLeftovers() : this.persistTaskSessions()]);
      return;
    }
    // Kept, as at an exit: held frames join the open turn before it settles.
    this.wakes.drop("the session stops");
    this.stopped = true;
    this.hostInitiatedStop = true;
    await this.settlePendingAsCancelled();
    this.emitAll(this.normalizer.failOpenTools("The session was stopped."));
    this.emitAll(
      this.normalizer.stopBackgroundTasks(endedByUser ? undefined : leftRunningNote(options.cause ?? "restart"))
    );
    const turn = this.activeTurn;
    if (turn !== null && !turn.settled) {
      turn.settled = true;
      this.emitEvent(
        this.normalizer.turnCompleted(turn.turnId, {
          stopReason: "cancelled",
          cancellationCategory: "MidTurnAbort",
          usage: this.normalizer.turnUsage()
        })
      );
      this.activeTurn = null;
    }
    await this.connection?.stop();
    // The CLI is gone; what it started outside its process group is not: its
    // helpers at every end, the user's work only at the user's — by a sweep of
    // its own, which a helpers' sweep an exit started cannot stand in for —
    // and remembered at every other end, so a later user end still reaches it.
    await Promise.all([this.stopLeftovers(), endedByUser ? this.stopTaskLeftovers() : this.persistTaskSessions()]);
  }

  // --------------------------------------------------------------- helpers

  private emitEvent(event: RuntimeEvent): void {
    this.options.emit(event);
    this.noteWork(event);
  }

  private emitAll(events: readonly RuntimeEvent[]): void {
    for (const event of events) {
      this.options.emit(event);
      this.noteWork(event);
    }
  }

  /**
   * A shell's or a monitor's start (the only task rows stamped `background`
   * here — a subagent, a loop and a goal live in the CLI): new user work, in
   * a session of its own, recorded while the CLI can still be read
   * ({@link recordTaskWork}).
   */
  private noteWork(event: RuntimeEvent): void {
    if (
      event.type === "task.started" &&
      !this.stopped &&
      (event.payload as { agentKind?: unknown }).agentKind === "background"
    ) {
      this.recordTaskWork();
    }
  }

  private touch(): void {
    this.updatedAt = this.options.stamp().createdAt;
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function currentModelIdOf(modelState: unknown): string | undefined {
  if (modelState === null || typeof modelState !== "object") {
    return undefined;
  }
  const value = (modelState as Record<string, unknown>)["currentModelId"];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function currentEffortOf(modelState: unknown, modelId: string | undefined): string | undefined {
  if (modelState === null || typeof modelState !== "object" || modelId === undefined) {
    return undefined;
  }
  const models = (modelState as Record<string, unknown>)["availableModels"];
  if (!Array.isArray(models)) {
    return undefined;
  }
  for (const entry of models) {
    if (entry === null || typeof entry !== "object") {
      continue;
    }
    const model = entry as Record<string, unknown>;
    if (model["modelId"] !== modelId) {
      continue;
    }
    const meta = model["_meta"];
    if (meta === null || typeof meta !== "object") {
      return undefined;
    }
    const effort = (meta as Record<string, unknown>)["reasoningEffort"];
    return typeof effort === "string" && effort.trim().length > 0 ? effort.trim() : undefined;
  }
  return undefined;
}

export { xaiMethodSpellings };
