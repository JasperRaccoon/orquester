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

import { AGENT_HOST_DEADLINES } from "../../support/deadline.ts";
import type { ChildExitReason } from "../../support/spawn.ts";
import { exitOutcome } from "../../support/spawn.ts";
import type { ClassifiedStderrLine } from "../../support/stderr.ts";
import { appendAttachmentPathLines } from "../attachment-lines.ts";
import { AcpConnection } from "./acp/connection.ts";
import type { AcpFrameDirection } from "./acp/peer.ts";
import { classifyAcpError } from "./acp/errors.ts";
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
import { answersToXaiResponse } from "./questions.ts";
import { parsePromptResultUsage } from "./usage.ts";
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
}

interface PendingApproval {
  readonly requestType: ReturnType<typeof permissionRequestType>;
  resolve(decision: ApprovalDecision): void;
}

interface PendingUserInput {
  readonly params: XaiAskUserQuestionParams;
  resolve(answers: Record<string, unknown> | null): void;
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

  private currentModelId: string | undefined;
  private currentReasoningEffort: string | undefined;

  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly pendingUserInputs = new Map<string, PendingUserInput>();
  private readonly sessionGrants = new Set<string>();

  private activeTurn: ActiveTurn | null = null;
  private readonly recordedTurns: RecordedTurn[] = [];
  private epoch = 0;


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
        planHost: this.planHost()
      },
      "pending"
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
        ...(overlay === null ? {} : { [GROK_CONFIG_PATH_ENV]: overlay })
      },
      cwd: this.options.cwd,
      clientInfo: this.options.clientInfo,
      homeDirs: this.options.homeDirs,
      onRawFrame: (direction, frame) => this.options.logRaw(direction, frame),
      onStderrLine: (line) => this.onStderr(line),
      onWarning: (message, detail) =>
        this.emitEvent(this.normalizer.event("runtime.warning", { message, detail })),
      onExit: (reason, tail) => this.onExit(reason, tail)
    });
    this.connection = connection;
    this.registerHandlers(connection);

    let initialize: InitializeResponse;
    try {
      initialize = await connection.handshake();
    } catch (error) {
      await connection.stop();
      throw error;
    }

    // Read on EVERY handshake, never cached per host: the CLI auto-updates
    // and can change version between two spawns of one thread.
    this.agentVersion = agentVersionOf(initialize._meta) ?? null;
    if (!meetsMinimumGrokVersion(this.agentVersion)) {
      const message = versionGateMessage(this.agentVersion);
      await connection.stop();
      throw new Error(message);
    }

    const cursor = parseGrokResumeCursor(this.options.resumeCursor);
    const setup = cursor === null ? await this.openNewSession() : await this.loadSession(cursor.sessionId);

    const modelState = modelStateOf(initialize._meta) ?? (setup as { models?: unknown }).models;
    this.currentModelId = currentModelIdOf(modelState);
    this.currentReasoningEffort = currentEffortOf(modelState, this.currentModelId);
    this.contextWindow = contextWindowFromModelState(modelState, this.currentModelId);
    // The normaliser stamps the window onto EVERY meter row it emits, chunk
    // rows included — without it the client's last-writer-wins read of
    // `context-window.updated` alternated between a ringed row and a bare one.
    this.normalizer.setContextWindow(this.contextWindow);

    await this.applyModelSelection(this.options.modelSelection);

    this.status = "ready";
    this.touch();
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

    peer.onNotification("session/update", (params) => {
      this.notePromptId(promptIdOf((params as { _meta?: unknown })._meta));
      this.emitAll(this.normalizer.handleSessionUpdate(params as SessionNotification));
    });

    // BOTH private channels. An adapter that registers only the live one
    // silently loses every replayed row on `session/load`.
    for (const method of [
      XAI_EXTENSION_NOTIFICATIONS.session_notification,
      XAI_EXTENSION_NOTIFICATIONS.session_update
    ]) {
      peer.registerExtensionNotification(method, (params) => {
        this.emitAll(this.normalizer.handleXaiNotification(method, params));
      });
    }

    peer.registerExtensionNotification(XAI_EXTENSION_NOTIFICATIONS.task_backgrounded, (params) => {
      this.emitAll(this.normalizer.handleXaiNotification(XAI_EXTENSION_NOTIFICATIONS.task_backgrounded, params));
    });

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
      XAI_EXTENSION_NOTIFICATIONS.sessions_changed,
      XAI_EXTENSION_NOTIFICATIONS.mcp_init_progress,
      XAI_EXTENSION_NOTIFICATIONS.mcp_initialized,
      XAI_EXTENSION_NOTIFICATIONS.mcp_servers_updated
    ]) {
      peer.registerExtensionNotification(method, () => {});
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
      const status = (params as { status?: unknown; name?: unknown }).status;
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

    const requestId = this.options.uuid();
    const decision = deferred<ApprovalDecision>();
    this.pendingApprovals.set(requestId, { requestType, resolve: decision.resolve });

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
    this.pendingApprovals.delete(requestId);

    this.emitEvent(this.normalizer.requestResolved({ requestId, requestType, decision: resolved }));

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
    const requestId = this.options.uuid();
    const pending = deferred<Record<string, unknown> | null>();
    this.pendingUserInputs.set(requestId, { params, resolve: pending.resolve });

    this.emitEvent(
      this.normalizer.userInputRequested({
        requestId,
        params,
        raw: {
          source: XAI_RAW_SOURCE,
          method: XAI_EXTENSION_REQUESTS.ask_user_question,
          payload: params
        }
      })
    );

    const answers = await pending.promise;
    this.pendingUserInputs.delete(requestId);
    this.emitEvent(this.normalizer.userInputResolved(requestId, answers ?? {}));

    return answers === null ? { outcome: "cancelled" } : answersToXaiResponse(params, answers);
  }

  respondToUserInput(requestId: string, answers: Record<string, unknown>): void {
    const pending = this.pendingUserInputs.get(requestId);
    if (pending === undefined) {
      throw new Error(`grok: no pending question ${requestId}`);
    }
    pending.resolve(answers);
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
        // because `activeTurn` is already null.
        this.activeTurn!.epoch = epoch;
        this.activeTurn!.providerPromptId = undefined;
        await this.settlePendingAsCancelled();
        try {
          this.peer().notify("session/cancel", { sessionId: this.acpSessionId });
        } catch {
          // A cancel that cannot be written is not a reason to drop the turn.
        }
        // Re-open the assistant stream: `endTurn()` may have closed it, and a
        // closed stream silently drops every chunk the steered prompt streams.
        this.normalizer.beginTurn();
      } else {
        this.activeTurn = { turnId, epoch, settled: false, interrupted: false };
        this.normalizer.clearPlanFallback();
        this.normalizer.beginTurn();
        this.status = "running";
        this.touch();
        this.emitEvent(this.normalizer.event("session.state.changed", { state: "running" }, turnId));
        this.emitEvent(
          this.normalizer.event(
            "turn.started",
            {
              ...(this.currentModelId === undefined ? {} : { model: this.currentModelId }),
              ...(this.currentReasoningEffort === undefined ? {} : { effort: this.currentReasoningEffort })
            },
            turnId
          )
        );
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
    if (promptId === undefined || promptId.length === 0) {
      return;
    }
    const turn = this.activeTurn;
    if (turn === null || turn.settled || turn.providerPromptId !== undefined) {
      return;
    }
    turn.providerPromptId = promptId;
  }

  private onQueueChanged(params: unknown): void {
    const record = params as
      | { entries?: ReadonlyArray<{ id?: unknown }>; runningPromptId?: unknown }
      | null;
    if (typeof record?.runningPromptId === "string") {
      this.notePromptId(record.runningPromptId);
      return;
    }
    const first = record?.entries?.[0]?.id;
    if (typeof first === "string") {
      this.notePromptId(first);
    }
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

    if (this.normalizer.approvalsWereSelfResolved) {
      this.emitEvent(this.normalizer.event("runtime.warning", { message: grokConfigAdvisory() }));
    }

    this.activeTurn = null;
    if (!this.stopped) {
      this.status = "ready";
      this.touch();
      this.emitEvent(this.normalizer.event("session.state.changed", { state: "ready" }));
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
   * settled as `cancel` FIRST, then `session/cancel` goes out, then the turn
   * is settled. `05-cancel-with-pending-permission.ndjson` shows the CLI does
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
      try {
        this.peer().notify("session/cancel", { sessionId: this.acpSessionId });
      } catch {
        // Nothing to cancel on a dead transport.
      }
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
   * running, and close every live background task so the roster empties and
   * `backgroundLiveness` clears.
   *
   * `session/cancel` is the only lever that reaches Grok's background work —
   * the tasks are children of the CLI process and it exposes no per-task kill
   * to the client (the model kills its own through `KillTask`). The session
   * itself stays up: the user pressed Stop, not Close.
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
      this.emitAll(this.normalizer.stopBackgroundTasks());
      this.emitAll(this.normalizer.failOpenTools("Stopped."));
    });
  }

  private async settlePendingAsCancelled(): Promise<void> {
    for (const [requestId, pending] of [...this.pendingApprovals.entries()]) {
      this.pendingApprovals.delete(requestId);
      pending.resolve("cancel");
      this.emitEvent(
        this.normalizer.requestResolved({ requestId, requestType: pending.requestType, decision: "cancel" })
      );
    }
    for (const [requestId, pending] of [...this.pendingUserInputs.entries()]) {
      this.pendingUserInputs.delete(requestId);
      pending.resolve(null);
      this.emitEvent(this.normalizer.userInputResolved(requestId, {}));
    }
    await Promise.resolve();
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
      // A rejected model must not fail the turn: the session keeps the model
      // it has and the user is told which one it is.
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
    if (this.stopped && this.hostInitiatedStop) {
      // Already settled by `stop()`.
      this.emitExited(reason, stderrTail, true);
      this.options.onClosed?.(this.threadId);
      return;
    }
    this.stopped = true;
    this.settleEverythingForExit(reason, stderrTail);
    this.emitExited(reason, stderrTail, false);
    this.options.onClosed?.(this.threadId);
  }

  /**
   * §3.1: a dead child never leaves a running turn. The in-flight turn is
   * settled, every live task is closed `stopped` and every parked request is
   * failed — all BEFORE `session.exited`.
   */
  private settleEverythingForExit(reason: ChildExitReason, stderrTail: string): void {
    const turn = this.activeTurn;
    const detail = stderrTail.trim().length > 0 ? `\n${stderrTail.trim()}` : "";

    for (const [requestId, pending] of [...this.pendingApprovals.entries()]) {
      this.pendingApprovals.delete(requestId);
      pending.resolve("cancel");
      this.emitEvent(
        this.normalizer.requestResolved({ requestId, requestType: pending.requestType, decision: "cancel" })
      );
    }
    for (const [requestId, pending] of [...this.pendingUserInputs.entries()]) {
      this.pendingUserInputs.delete(requestId);
      pending.resolve(null);
      this.emitEvent(this.normalizer.userInputResolved(requestId, {}));
    }

    this.emitAll(this.normalizer.stopBackgroundTasks());
    this.emitAll(this.normalizer.failOpenTools("The agent process exited."));

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

  /** Host-initiated stop. Idempotent. */
  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.hostInitiatedStop = true;
    await this.settlePendingAsCancelled();
    this.emitAll(this.normalizer.stopBackgroundTasks());
    this.emitAll(this.normalizer.failOpenTools("The session was stopped."));
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
  }

  // --------------------------------------------------------------- helpers

  private emitEvent(event: RuntimeEvent): void {
    this.options.emit(event);
  }

  private emitAll(events: readonly RuntimeEvent[]): void {
    for (const event of events) {
      this.options.emit(event);
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
