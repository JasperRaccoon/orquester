/**
 * Codex adapter — one `codex app-server` child per thread (spec §3.1, §3.2,
 * §4.1, §4.5 Codex).
 *
 * Ported from T3 Code (MIT):
 * `apps/server/src/provider/Layers/CodexSessionRuntime.ts`, reimplemented in
 * plain TypeScript without Effect and with the deadlines T3 lacks (§3.1: T3's
 * `initialize` is an unbounded await, which turns a provider that starts but
 * never answers into a permanently `starting` thread).
 *
 * The invariants this file exists to hold:
 *
 * - **A running state never outlives its process.** `handleExit` settles the
 *   in-flight turn, closes every live task `stopped`, fails every parked
 *   request and only then emits `session.exited` (§3.1).
 * - **Settle before interrupt.** Every pending approval and user-input request
 *   is cancelled and emitted as resolved BEFORE `turn/interrupt` reaches the
 *   provider. On this CLI the interrupt itself needs no settling — but it
 *   **silently abandons** open requests and `inProgress` items, emitting no
 *   `serverRequest/resolved` and no `item/completed` for them, so without this
 *   they dangle forever (fixtures README observation 5).
 * - **Interrupt is turn-scoped**, enforced client-side: a stale turn id is a
 *   hard `-32600 "no active turn to interrupt"` on the wire, not a no-op.
 * - **Plan mode is sticky**, so `collaborationMode` is sent on every turn
 *   including `{mode:"default"}` (fixtures README observation 9).
 */

import type {
  ApprovalDecision,
  ApprovalOption,
  AttachmentRef,
  InteractionMode,
  ModelSelection,
  ProviderSession,
  ProviderSessionStatus,
  RuntimeMode,
  ThreadSnapshot,
  UserInputQuestion
} from "@orquester/api/agent-chat";

import type { AdapterContext } from "../../adapter.ts";
import { AGENT_HOST_DEADLINES, TURN_LIVENESS_WINDOWS, withDeadline } from "../../support/deadline.ts";
import {
  describeExit,
  exitOutcome,
  spawnProviderChild,
  type ChildExitReason,
  type ProviderChild
} from "../../support/spawn.ts";
import { StderrCapture } from "../../support/stderr.ts";
import type {
  CodexProtocol,
  ServerNotificationMethod,
  ServerRequestMethod,
  ServerRequestResultsByMethod
} from "./_generated/index.ts";
import {
  DEFAULT_APPROVAL_OPTIONS,
  approvalOptionsFromAvailableDecisions,
  toCommandDecision,
  toElicitationAction,
  toFileChangeDecision,
  toPermissionsResponse,
  unknownAvailableDecisions
} from "./decisions.ts";
import {
  interactionModeToCollaborationMode,
  runtimeModeToThreadConfig,
  runtimeModeToTurnSandboxPolicy
} from "./modes.ts";
import {
  CODEX_RAW_REQUEST,
  CodexNormaliser,
  canonicalRequestType,
  presentableError,
  type RuntimeEventDraft
} from "./normalise.ts";
import {
  CodexPeer,
  CodexRequestRefusal,
  CodexRpcError,
  describeError,
  type CodexServerRequest
} from "./protocol.ts";
import { CodexUsageTracker } from "./usage.ts";

/** What a resumed session persists. Codex's cursor is just `{threadId}` (§4.1). */
export interface CodexResumeCursor {
  threadId: string;
}

/** A cursor that fails its own shape check means "no resume", **never** an error. */
export function parseResumeCursor(value: unknown): CodexResumeCursor | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const threadId = (value as { threadId?: unknown }).threadId;
  return typeof threadId === "string" && threadId.length > 0 ? { threadId } : null;
}

export interface CodexSessionOptions {
  context: AdapterContext;
  threadId: string;
  cwd: string;
  /** Absolute, already expanded — nothing shell-expands an env value (§3.1). */
  codexHome?: string;
  bin: string;
  /** Tokenised user launch args, appended after `app-server`. */
  launchArgs?: readonly string[];
  env: Record<string, string>;
  runtimeMode: RuntimeMode;
  modelSelection: ModelSelection;
  resumeCursor?: unknown;
  /**
   * Overrides for {@link AGENT_HOST_DEADLINES}. Production passes nothing; a
   * test shortens the handshake window so §3.1's "an expired deadline kills
   * the child" is exercised in milliseconds rather than half a minute.
   */
  deadlines?: Partial<Record<keyof typeof AGENT_HOST_DEADLINES, number>>;
  emit: (draft: RuntimeEventDraft) => void;
  /** Called once the session has settled for good, so the adapter can forget it. */
  onClosed: () => void;
}

interface PendingApproval {
  requestId: string;
  method: string;
  settle: (decision: ApprovalDecision) => void;
  fail: (error: Error) => void;
}

interface PendingUserInput {
  requestId: string;
  settle: (answers: Record<string, unknown>) => void;
  fail: (error: Error) => void;
}

/** Live tasks, so a dead child can close every one with `status:"stopped"` (§3.1). */
interface LiveTask {
  taskId: string;
  agentId?: string;
  agentPath?: string;
}

export class CodexSession {
  readonly threadId: string;

  private readonly options: CodexSessionOptions;
  private readonly usage = new CodexUsageTracker();
  private readonly normaliser: CodexNormaliser;
  private readonly stderr = new StderrCapture();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly pendingUserInputs = new Map<string, PendingUserInput>();
  private readonly liveTasks = new Map<string, LiveTask>();

  private child: ProviderChild | null = null;
  private peer: CodexPeer | null = null;
  private providerThreadId: string | null = null;
  private announcedThreadId: string | null = null;
  private status: ProviderSessionStatus = "starting";
  private lastError: string | undefined;
  private activeTurnId: string | null = null;
  private modelSelection: ModelSelection;
  private runtimeMode: RuntimeMode;
  private hostInitiatedClose = false;
  private exitHandled = false;
  private closedPromise: Promise<void> | null = null;
  private requestSeq = 0;
  private livenessTimer: NodeJS.Timeout | null = null;
  private readonly createdAt: string;
  private updatedAt: string;

  constructor(options: CodexSessionOptions) {
    this.options = options;
    this.threadId = options.threadId;
    this.modelSelection = options.modelSelection;
    this.runtimeMode = options.runtimeMode;
    this.normaliser = new CodexNormaliser({ usage: this.usage });
    this.createdAt = options.context.clock.nowIso();
    this.updatedAt = this.createdAt;
  }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  summary(): ProviderSession {
    return {
      threadId: this.threadId,
      status: this.status,
      runtimeMode: this.runtimeMode,
      cwd: this.options.cwd,
      model: this.modelSelection.model,
      ...(this.providerThreadId !== null
        ? { resumeCursor: { threadId: this.providerThreadId } satisfies CodexResumeCursor }
        : {}),
      ...(this.activeTurnId !== null ? { activeTurnId: this.activeTurnId } : {}),
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      ...(this.lastError !== undefined ? { lastError: this.lastError } : {})
    };
  }

  get isLive(): boolean {
    return this.status !== "stopped" && this.status !== "error";
  }

  get currentTurnId(): string | null {
    return this.activeTurnId;
  }

  /**
   * Spawn the child, handshake, then `thread/resume` or `thread/start`.
   *
   * Every wait here is bounded and an expired deadline KILLS the child rather
   * than leaving the thread `starting` forever (§3.1).
   */
  async start(): Promise<ProviderSession> {
    const child = spawnProviderChild({
      command: this.options.bin,
      args: ["app-server", ...(this.options.launchArgs ?? [])],
      env: this.options.env,
      cwd: this.options.cwd
    });
    this.child = child;
    this.watchStderr(child);
    void child.exited.then((reason) => {
      this.handleExit(reason);
    });

    const peer = new CodexPeer({
      stdin: child.stdin,
      stdout: child.stdout,
      handlers: {
        onRequest: (request) => this.handleServerRequest(request),
        onNotification: (method, params) => {
          this.handleNotification(method, params);
        },
        onUnknownFrame: (frame, reason) => {
          // Surfaced, NEVER dropped by a catch-all (§10). A warning never ends
          // an active turn.
          this.emit({
            type: "runtime.warning",
            payload: { message: `codex: ${reason}`, detail: frame }
          });
        },
        onMalformedLine: (line, error) => {
          this.emit({
            type: "runtime.warning",
            payload: {
              message: `codex: unparseable line (${describeError(error)})`,
              detail: line.slice(0, 500)
            }
          });
        }
      },
      onFrame: (direction, frame) => {
        this.options.context.logRawFrame(this.threadId, { direction, frame });
      }
    });
    this.peer = peer;

    this.setStatus("starting");
    this.emit({
      type: "session.started",
      payload: {
        ...(this.options.resumeCursor !== undefined
          ? { resume: this.options.resumeCursor }
          : {})
      }
    });

    const initialize = await this.bounded(
      () =>
        peer.request("initialize", {
          clientInfo: { name: "orquester", title: "Orquester", version: HOST_CLIENT_VERSION },
          capabilities: {
            experimentalApi: true,
            requestAttestation: false
          }
        }),
      this.deadline("handshakeMs"),
      "initialize"
    );
    // `initialized` takes no params; the server rejects an explicit null.
    peer.notify("initialized");

    if (
      this.options.codexHome !== undefined &&
      initialize.codexHome !== this.options.codexHome
    ) {
      // `codexHome` comes back on `initialize` in 0.154.0 — a cheap way to
      // verify a CODEX_HOME override actually landed (fixtures README obs. 18).
      this.emit({
        type: "runtime.warning",
        payload: {
          message: "codex is using a different CODEX_HOME than this account's home",
          detail: { requested: this.options.codexHome, actual: initialize.codexHome }
        }
      });
    }

    await this.openThread();
    this.setStatus("ready");
    return this.summary();
  }

  /**
   * Start a turn, or STEER the one already running.
   *
   * `turn/start` on a thread with an active turn injects into it and is
   * neither an error nor a second turn (§4.1) — the reply's turn id is the
   * active one, which is why the returned id is taken from the response rather
   * than minted here.
   */
  async sendTurn(input: {
    input: string;
    attachments: readonly AttachmentRef[];
    modelSelection?: ModelSelection;
    interactionMode: InteractionMode;
    continuation?: boolean;
  }): Promise<{ turnId: string; resumeCursor: CodexResumeCursor }> {
    const peer = this.requirePeer();
    const providerThreadId = this.requireProviderThreadId();
    if (input.modelSelection !== undefined) {
      this.modelSelection = input.modelSelection;
    }

    const items: CodexProtocol.v2.UserInput[] = [];
    if (input.input.length > 0) {
      items.push({ type: "text", text: input.input, text_elements: [] });
    }
    for (const attachment of input.attachments) {
      // Images by PATH, never base64 (§4.5). Everything else is already
      // flattened into the prompt text by the host.
      if (attachment.type !== "image") {
        continue;
      }
      const path = await this.options.context.resolveAttachmentPath(this.threadId, attachment.id);
      items.push({ type: "localImage", path });
    }

    const config = runtimeModeToThreadConfig(this.runtimeMode);
    const effort = this.selectedOption("effort");
    const serviceTier = this.selectedOption("serviceTier");

    const params: CodexProtocol.v2.TurnStartParams = {
      threadId: providerThreadId,
      input: items,
      approvalPolicy: config.approvalPolicy,
      // ALWAYS explicit, including on resume: omitting it keeps the thread's
      // previous reviewer and leaves `auto_review` sticky (§4.4).
      approvalsReviewer: config.approvalsReviewer,
      sandboxPolicy: runtimeModeToTurnSandboxPolicy(this.runtimeMode),
      model: this.modelSelection.model,
      ...(effort !== undefined ? { effort } : {}),
      ...(serviceTier !== undefined ? { serviceTier } : {}),
      // Sent on EVERY turn, `{mode:"default"}` included: leaving it off does
      // not return the thread to default and traps it in plan mode forever
      // (fixtures README observation 9).
      collaborationMode: interactionModeToCollaborationMode(input.interactionMode, {
        model: this.modelSelection.model,
        ...(effort !== undefined ? { effort } : {})
      })
    };

    const response = await this.bounded(
      () => peer.request("turn/start", params),
      this.deadline("submitMs"),
      "turn/start"
    );

    const turnId = response.turn.id;
    this.activeTurnId = turnId;
    this.normaliser.noteTurnStarted(turnId, this.modelSelection.model, effort);
    this.setStatus("running");
    this.armLivenessWatchdog();
    return { turnId, resumeCursor: { threadId: providerThreadId } };
  }

  /**
   * Stop a turn. Order matters and is the spec's, not the server's (§4.5):
   * settle approvals, settle user inputs, then `turn/interrupt`.
   */
  async interruptTurn(turnId?: string): Promise<void> {
    const active = this.activeTurnId;
    if (active === null) {
      // Turn-scoped and a no-op when that turn is no longer active (§4.1).
      // Enforced HERE because the server answers a stale turn id with a hard
      // `-32600 "no active turn to interrupt"` (fixtures README observation 5).
      return;
    }
    if (turnId !== undefined && turnId !== active) {
      return;
    }

    this.settlePendingRequests("cancel");

    const peer = this.peer;
    if (peer === null || peer.isClosed) {
      return;
    }
    // The settle above only RESOLVES the handlers; their replies are written on
    // the following microtask. Without this the interrupt would reach the wire
    // first and the server would abandon the requests unanswered — which is
    // exactly the leak §4.1's ordering exists to prevent.
    await peer.whenServerRequestsSettled();
    try {
      await this.bounded(
        () =>
          peer.request("turn/interrupt", {
            threadId: this.requireProviderThreadId(),
            turnId: active
          }),
        this.deadline("cancelMs"),
        "turn/interrupt"
      );
    } catch (error) {
      if (error instanceof CodexRpcError) {
        // "no active turn to interrupt" — the turn settled underneath us.
        // Not a failure: the user's Stop achieved what they asked for.
        return;
      }
      throw error;
    }
  }

  /** Answer one parked approval. Unknown ids are ignored, never thrown. */
  respondToApproval(requestId: string, decision: ApprovalDecision): void {
    const pending = this.pendingApprovals.get(requestId);
    if (pending === undefined) {
      return;
    }
    this.pendingApprovals.delete(requestId);
    this.disarmIfIdle();
    pending.settle(decision);
  }

  respondToUserInput(requestId: string, answers: Record<string, unknown>): void {
    const pending = this.pendingUserInputs.get(requestId);
    if (pending === undefined) {
      return;
    }
    this.pendingUserInputs.delete(requestId);
    this.disarmIfIdle();
    pending.settle(answers);
  }

  /**
   * Native compaction (§4.1 `compaction: {type:"native"}`).
   *
   * The request returns `{}` immediately; completion is observed through the
   * turn lifecycle, because compaction runs as a **whole extra turn** and
   * `thread/compacted` never fires (fixtures README observation 8).
   */
  async compact(): Promise<void> {
    const peer = this.requirePeer();
    await this.bounded(
      () => peer.request("thread/compact/start", { threadId: this.requireProviderThreadId() }),
      this.deadline("submitMs"),
      "thread/compact/start"
    );
  }

  /**
   * Read the thread out of band (§4.1 `ThreadSnapshot`).
   *
   * `thread/resume` hands back `turns: []` with `excludeTurns: true`, so
   * history is hydrated through `thread/turns/list` (fixtures README obs. 17).
   */
  async readThread(): Promise<ThreadSnapshot> {
    const turns = await this.listTurns();
    return {
      threadId: this.threadId,
      // `thread/turns/list` returns newest-first; the snapshot reads oldest-first.
      turns: [...turns].reverse().map((turn) => ({ id: turn.id, items: [...turn.items] }))
    };
  }

  /**
   * Roll the conversation back by `numTurns` (§5.5).
   *
   * `thread/rollback {numTurns}` is **dead** on every thread this CLI creates
   * (`-32600 "paginated threads do not support thread/rollback"`, plus a
   * deprecation notice). The working path is `thread/turns/list` →
   * `thread/revert {beforeTurnId}` (fixtures README observation 7).
   *
   * Neither endpoint touches the working tree — "This only changes persisted
   * conversation history" — so §5.5's checkpoint restore stays Orquester's job.
   */
  async rollbackThread(numTurns: number): Promise<ThreadSnapshot> {
    const peer = this.requirePeer();
    const providerThreadId = this.requireProviderThreadId();

    // Newest-first, so the turn to revert *before* is the `numTurns`-th one.
    const turns = await this.listTurns(numTurns + 1);
    const boundary = turns[numTurns - 1];
    if (boundary === undefined) {
      throw new Error(
        `codex: cannot roll back ${numTurns} turn(s); the thread has ${turns.length}`
      );
    }

    await this.bounded(
      () => peer.request("thread/revert", { threadId: providerThreadId, beforeTurnId: boundary.id }),
      this.deadline("sessionOpenMs"),
      "thread/revert"
    );
    // The response's `turns` is ALWAYS empty by documented design; re-hydrate.
    return this.readThread();
  }

  /** Stop the session on purpose. Settles everything first (§4.1). */
  async stop(): Promise<void> {
    if (this.closedPromise !== null) {
      return this.closedPromise;
    }
    this.hostInitiatedClose = true;
    this.closedPromise = (async () => {
      try {
        await this.interruptTurn();
      } catch {
        // A wedged interrupt must not stop the kill.
      }
      this.settlePendingRequests("cancel");
      this.peer?.close("session stopped");
      const child = this.child;
      if (child !== null && !child.hasExited()) {
        await child.kill();
      }
    })();
    return this.closedPromise;
  }

  // -------------------------------------------------------------------------
  // Thread open / resume
  // -------------------------------------------------------------------------

  private async openThread(): Promise<void> {
    const peer = this.requirePeer();
    const config = runtimeModeToThreadConfig(this.runtimeMode);
    const cursor = parseResumeCursor(this.options.resumeCursor);

    if (cursor !== null) {
      try {
        const resumed = await this.bounded(
          () =>
            peer.request("thread/resume", {
              threadId: cursor.threadId,
              cwd: this.options.cwd,
              approvalPolicy: config.approvalPolicy,
              approvalsReviewer: config.approvalsReviewer,
              sandbox: config.sandbox,
              model: this.modelSelection.model,
              // The documented path for paginated threads — full-history
              // hydration is deprecated (fixtures README observation 17).
              excludeTurns: true
            }),
          this.deadline("sessionOpenMs"),
          "thread/resume"
        );
        this.providerThreadId = resumed.thread.id;
        this.announceThread(resumed.thread.id);
        return;
      } catch (error) {
        // A resume that fails falls back to a FRESH thread rather than failing
        // the session (§4.5). T3 decides this with an English-substring
        // matcher over the error message; that matcher was never exercised on
        // this CLI (fixtures README observation 17) and the brief forbids
        // copying it, so the fallback is unconditional and the user is told.
        this.emit({
          type: "runtime.warning",
          payload: {
            message: "Could not resume the Codex conversation; starting a fresh one.",
            detail: describeError(error)
          }
        });
      }
    }

    const started = await this.bounded(
      () =>
        peer.request("thread/start", {
          cwd: this.options.cwd,
          approvalPolicy: config.approvalPolicy,
          approvalsReviewer: config.approvalsReviewer,
          sandbox: config.sandbox,
          model: this.modelSelection.model
        }),
      this.deadline("sessionOpenMs"),
      "thread/start"
    );
    // NOT `{threadId}` — `result.thread.id` (fixtures README observation 1).
    this.providerThreadId = started.thread.id;
    this.announceThread(started.thread.id);
  }

  private async listTurns(limit = 50): Promise<CodexProtocol.v2.Turn[]> {
    const peer = this.requirePeer();
    const providerThreadId = this.requireProviderThreadId();
    const turns: CodexProtocol.v2.Turn[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20 && turns.length < limit; page += 1) {
      const response: CodexProtocol.v2.ThreadTurnsListResponse = await this.bounded(
        () =>
          peer.request("thread/turns/list", {
            threadId: providerThreadId,
            limit: Math.min(50, limit - turns.length),
            ...(cursor !== null ? { cursor } : {}),
            itemsView: "full"
          }),
        this.deadline("sessionOpenMs"),
        "thread/turns/list"
      );
      turns.push(...response.data);
      cursor = response.nextCursor;
      if (cursor === null) {
        break;
      }
    }
    return turns;
  }

  // -------------------------------------------------------------------------
  // Inbound
  // -------------------------------------------------------------------------

  private handleNotification(method: ServerNotificationMethod, params: unknown): void {
    // Any observable progress refreshes the liveness window (§3.1).
    this.noteActivity();

    for (const draft of this.normaliser.notification(method, params)) {
      if (draft.type === "thread.started") {
        this.announceThread(draft.payload.providerThreadId);
        continue;
      }
      this.trackTask(draft);
      this.emit(draft);
    }

    if (method === "turn/started") {
      const p = params as CodexProtocol.v2.TurnStartedNotification;
      this.activeTurnId = p.turn.id;
      this.setStatus("running");
      this.armLivenessWatchdog();
    } else if (method === "turn/completed") {
      const p = params as CodexProtocol.v2.TurnCompletedNotification;
      if (this.activeTurnId === p.turn.id) {
        this.activeTurnId = null;
        this.setStatus("ready");
        this.disarmLivenessWatchdog();
      }
    } else if (method === "error") {
      const p = params as CodexProtocol.v2.ErrorNotification;
      if (!p.willRetry) {
        this.lastError = presentableError(p.error.message);
      }
    }
  }

  /**
   * The five server→client requests §4.5 names, and nothing else.
   *
   * Everything unhandled — including `item/fileRead/requestApproval` and
   * `account/chatgptAuthTokens/refresh` — is refused `-32601`, which the
   * server treats as "the model was refused", never as a protocol violation
   * (fixtures README observation 14).
   */
  private async handleServerRequest(
    request: CodexServerRequest
  ): Promise<ServerRequestResultsByMethod[ServerRequestMethod]> {
    this.noteActivity();
    const raw = {
      source: CODEX_RAW_REQUEST,
      method: request.method,
      payload: request.params
    } as const;

    switch (request.method) {
      case "item/commandExecution/requestApproval": {
        const params = request.params as CodexProtocol.v2.CommandExecutionRequestApprovalParams;
        const unknown = unknownAvailableDecisions(params.availableDecisions);
        if (unknown.length > 0) {
          this.emit({
            type: "runtime.warning",
            payload: { message: `codex advertised unknown approval decisions: ${unknown.join(", ")}` }
          });
        }
        const decision = await this.parkApproval({
          method: request.method,
          turnId: params.turnId,
          itemId: params.itemId,
          providerRequestId: String(request.id),
          detail: params.command ?? undefined,
          options:
            approvalOptionsFromAvailableDecisions(params.availableDecisions) ??
            [...DEFAULT_APPROVAL_OPTIONS],
          args: {
            command: params.command,
            cwd: params.cwd,
            commandActions: params.commandActions,
            reason: params.reason,
            kind: params.kind
          },
          raw
        });
        return {
          decision: toCommandDecision(decision, params.proposedExecpolicyAmendment)
        } satisfies CodexProtocol.v2.CommandExecutionRequestApprovalResponse;
      }

      case "item/fileChange/requestApproval": {
        // Much thinner than the command shape and carries NO diff: the diff is
        // on the `item/started` `fileChange` item that precedes it, so a card
        // must be rendered by joining on `itemId` (fixtures README obs. 2).
        const params = request.params as CodexProtocol.v2.FileChangeRequestApprovalParams;
        const decision = await this.parkApproval({
          method: request.method,
          turnId: params.turnId,
          itemId: params.itemId,
          providerRequestId: String(request.id),
          ...(params.reason !== null && params.reason !== undefined
            ? { detail: params.reason }
            : {}),
          options: [...DEFAULT_APPROVAL_OPTIONS],
          args: { grantRoot: params.grantRoot },
          raw
        });
        return {
          decision: toFileChangeDecision(decision)
        } satisfies CodexProtocol.v2.FileChangeRequestApprovalResponse;
      }

      case "mcpServer/elicitation/request": {
        const params = request.params as CodexProtocol.v2.McpServerElicitationRequestParams;
        if (params.mode !== "form" && params.mode !== "openai/form" && params.mode !== "openaiForm") {
          // `openai/userVerification` and `url` modes are real MCP forms, not
          // approvals, and nothing in this UI can render them. Declining is
          // the documented-safe answer.
          this.emit({
            type: "runtime.warning",
            payload: { message: `Declined an unsupported MCP elicitation (${params.mode}).` }
          });
          return {
            action: "decline",
            content: null,
            _meta: null
          } satisfies CodexProtocol.v2.McpServerElicitationRequestResponse;
        }
        const decision = await this.parkApproval({
          method: request.method,
          ...(params.turnId !== null ? { turnId: params.turnId } : {}),
          providerRequestId: String(request.id),
          // `message` is the provider's own wording and is the card's title.
          detail: params.message,
          appName: params.serverName,
          options: [...DEFAULT_APPROVAL_OPTIONS],
          args: { meta: params._meta, serverName: params.serverName },
          raw
        });
        return {
          action: toElicitationAction(decision),
          content: null,
          _meta: null
        } satisfies CodexProtocol.v2.McpServerElicitationRequestResponse;
      }

      case "item/permissions/requestApproval": {
        const params = request.params as CodexProtocol.v2.PermissionsRequestApprovalParams;
        const decision = await this.parkApproval({
          method: request.method,
          turnId: params.turnId,
          itemId: params.itemId,
          providerRequestId: String(request.id),
          ...(params.reason !== null ? { detail: params.reason } : {}),
          options: [...DEFAULT_APPROVAL_OPTIONS],
          args: { permissions: params.permissions, cwd: params.cwd },
          raw
        });
        return toPermissionsResponse(decision, params.permissions);
      }

      case "item/tool/requestUserInput": {
        const params = request.params as CodexProtocol.v2.ToolRequestUserInputParams;
        const questions = toUserInputQuestions(params.questions);
        if (questions.length === 0) {
          // Every question was dropped by the filter; suppressing the event
          // and refusing is better than an empty card (§4.5).
          throw CodexRequestRefusal.invalidParams("no answerable questions in the request");
        }
        const requestId = this.nextRequestId();
        const answers = await new Promise<Record<string, unknown>>((resolve, reject) => {
          this.pendingUserInputs.set(requestId, {
            requestId,
            settle: resolve,
            fail: reject
          });
          this.emit({
            type: "user-input.requested",
            payload: {
              questions,
              dismissible: !params.isBlocking,
              // The provider's own signal, beside our derivation of it.
              isBlocking: params.isBlocking
            },
            turnId: params.turnId,
            itemId: params.itemId,
            requestId,
            providerRefs: {
              providerTurnId: params.turnId,
              providerItemId: params.itemId,
              providerRequestId: String(request.id)
            },
            raw
          });
          this.disarmIfIdle();
        });
        this.emit({
          type: "user-input.resolved",
          payload: { answers },
          turnId: params.turnId,
          requestId,
          raw
        });
        return {
          answers: toCodexAnswers(questions, answers)
        } satisfies CodexProtocol.v2.ToolRequestUserInputResponse;
      }

      default:
        throw CodexRequestRefusal.methodNotFound(request.method);
    }
  }

  private parkApproval(input: {
    method: string;
    turnId?: string;
    itemId?: string;
    providerRequestId: string;
    detail?: string;
    appName?: string;
    options: ApprovalOption[];
    args?: unknown;
    raw: { source: "codex.app-server.request"; method: string; payload: unknown };
  }): Promise<ApprovalDecision> {
    const requestId = this.nextRequestId();
    const requestType = canonicalRequestType(input.method);
    return new Promise<ApprovalDecision>((resolve, reject) => {
      this.pendingApprovals.set(requestId, {
        requestId,
        method: input.method,
        settle: (decision) => {
          this.emit({
            type: "request.resolved",
            payload: { requestType, decision },
            ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
            ...(input.itemId !== undefined ? { itemId: input.itemId } : {}),
            requestId,
            raw: input.raw
          });
          resolve(decision);
        },
        fail: reject
      });
      this.emit({
        type: "request.opened",
        payload: {
          requestType,
          // False for every native-callback approval: the provider is blocked
          // waiting on a reply and it must be answered or cancelled (§4.2).
          dismissible: false,
          ...(input.detail !== undefined ? { detail: input.detail } : {}),
          ...(input.appName !== undefined ? { appName: input.appName } : {}),
          options: input.options,
          ...(input.args !== undefined ? { args: input.args } : {})
        },
        ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
        ...(input.itemId !== undefined ? { itemId: input.itemId } : {}),
        requestId,
        providerRefs: {
          ...(input.turnId !== undefined ? { providerTurnId: input.turnId } : {}),
          ...(input.itemId !== undefined ? { providerItemId: input.itemId } : {}),
          providerRequestId: input.providerRequestId
        },
        raw: input.raw
      });
      // A turn waiting on a human is not a stalled turn (§3.1).
      this.disarmIfIdle();
    });
  }

  // -------------------------------------------------------------------------
  // Settling
  // -------------------------------------------------------------------------

  /**
   * Resolve every open request with one decision and emit the matching
   * `request.resolved` / `user-input.resolved` (§4.1 "Settle before
   * interrupt").
   */
  private settlePendingRequests(decision: ApprovalDecision): void {
    const approvals = [...this.pendingApprovals.values()];
    this.pendingApprovals.clear();
    for (const approval of approvals) {
      approval.settle(decision);
    }

    const inputs = [...this.pendingUserInputs.values()];
    this.pendingUserInputs.clear();
    for (const input of inputs) {
      this.emit({
        type: "user-input.resolved",
        payload: { answers: {} },
        requestId: input.requestId
      });
      input.settle({});
    }
  }

  /** Fail every parked request outright — used when the transport is gone. */
  private failPendingRequests(reason: string): void {
    const error = new Error(reason);
    const approvals = [...this.pendingApprovals.values()];
    this.pendingApprovals.clear();
    for (const approval of approvals) {
      this.emit({
        type: "request.resolved",
        payload: { requestType: canonicalRequestType(approval.method), decision: "cancel" },
        requestId: approval.requestId
      });
      approval.fail(error);
    }
    const inputs = [...this.pendingUserInputs.values()];
    this.pendingUserInputs.clear();
    for (const input of inputs) {
      this.emit({
        type: "user-input.resolved",
        payload: { answers: {} },
        requestId: input.requestId
      });
      input.fail(error);
    }
  }

  /**
   * §3.1, the whole rule in one place: a dead child never leaves a running
   * turn. The turn is settled, every live task is closed `stopped`, every
   * parked request is failed — and only THEN is `session.exited` emitted.
   */
  private handleExit(reason: ChildExitReason): void {
    if (this.exitHandled) {
      return;
    }
    this.exitHandled = true;
    this.disarmLivenessWatchdog();

    const outcome = exitOutcome(reason, this.hostInitiatedClose);
    const excerpt = this.stderr.excerpt();

    // 1. Settle the in-flight turn: `interrupted` when the stream simply
    //    ended, `failed` with the first captured failure when it ended in
    //    error.
    const turnId = this.activeTurnId;
    if (turnId !== null) {
      const failed = outcome.status === "error";
      this.emit({
        type: "turn.completed",
        payload: {
          state: failed ? "failed" : "interrupted",
          tokenUsage: this.usage.completeTurn(turnId, { interrupted: true }),
          ...(failed
            ? { errorMessage: this.lastError ?? describeExit(reason) }
            : {})
        },
        turnId,
        providerRefs: { providerTurnId: turnId }
      });
      this.activeTurnId = null;
      this.normaliser.noteTurnSettled();
    }

    // 2. Close every live task; the roster folds `stopped` to `interrupted`.
    for (const task of this.liveTasks.values()) {
      this.emit({
        type: "task.completed",
        payload: {
          taskId: task.taskId,
          status: "stopped",
          ...(task.agentId !== undefined ? { agentId: task.agentId } : {}),
          ...(task.agentPath !== undefined ? { agentPath: task.agentPath } : {})
        },
        ...(task.agentId !== undefined ? { agentId: task.agentId } : {})
      });
    }
    this.liveTasks.clear();

    // 3. Fail every request still parked on the dead transport, and make every
    //    later call fail fast.
    this.peer?.close(describeExit(reason));
    this.failPendingRequests(`codex exited: ${describeExit(reason)}`);

    // 4. Only now the exit itself.
    this.setStatus(outcome.status);
    if (outcome.status === "error") {
      this.lastError = excerpt.length > 0 ? `${outcome.reason}\n${excerpt}` : outcome.reason;
    }
    this.emit({
      type: "session.exited",
      payload: {
        ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
        // Recovery is `thread/resume` against the persisted rollout file — the
        // conversation survives the process (fixtures README observation 16).
        recoverable: this.providerThreadId !== null,
        exitKind: outcome.exitKind
      }
    });
    this.options.onClosed();
  }

  // -------------------------------------------------------------------------
  // Liveness watchdog (§3.1)
  // -------------------------------------------------------------------------

  private armLivenessWatchdog(): void {
    this.disarmLivenessWatchdog();
    if (this.activeTurnId === null || this.hasLivenessPause()) {
      return;
    }
    const window = this.liveTasks.size > 0 || this.normaliser.openItemIds().length > 0
      ? TURN_LIVENESS_WINDOWS.activeToolMs
      : TURN_LIVENESS_WINDOWS.idleMs;
    const timer = setTimeout(() => {
      // Re-check the pause immediately before cancelling: a turn waiting on a
      // human is not a stalled turn, and a watchdog that ignored that would
      // cancel every request the user left open over lunch (§3.1).
      if (this.activeTurnId === null || this.hasLivenessPause()) {
        this.armLivenessWatchdog();
        return;
      }
      const minutes = Math.round(window / 60_000);
      this.emit({
        type: "runtime.warning",
        payload: { message: `No Codex activity for ${minutes} minutes; stopping the turn.` },
        turnId: this.activeTurnId
      });
      void this.interruptTurn().catch(() => {
        // The interrupt is best effort; the turn is settled either way.
      });
    }, window);
    timer.unref?.();
    this.livenessTimer = timer;
  }

  private disarmLivenessWatchdog(): void {
    if (this.livenessTimer !== null) {
      clearTimeout(this.livenessTimer);
      this.livenessTimer = null;
    }
  }

  /** Paused entirely while an approval or user-input request is pending (§3.1). */
  private hasLivenessPause(): boolean {
    return this.pendingApprovals.size > 0 || this.pendingUserInputs.size > 0;
  }

  private disarmIfIdle(): void {
    if (this.hasLivenessPause()) {
      this.disarmLivenessWatchdog();
      return;
    }
    this.armLivenessWatchdog();
  }

  private noteActivity(): void {
    if (this.activeTurnId !== null) {
      this.armLivenessWatchdog();
    }
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  private watchStderr(child: ProviderChild): void {
    const surface = (lines: ReturnType<StderrCapture["push"]>): void => {
      for (const line of lines) {
        if (line.class === "drop") {
          continue;
        }
        if (line.class === "error") {
          this.emit({
            type: "runtime.error",
            payload: { message: line.text, class: "provider_error" }
          });
        } else {
          this.emit({ type: "runtime.warning", payload: { message: line.text } });
        }
      }
    };
    child.stderr.on("data", (chunk: Buffer) => {
      surface(this.stderr.push(chunk));
    });
    child.stderr.on("end", () => {
      surface(this.stderr.flush());
    });
  }

  /**
   * Emit `thread.started` exactly once per provider thread.
   *
   * `thread/start` answers the id AND fires a `thread/started` notification,
   * while `thread/resume` answers the id and fires nothing (it sends
   * `thread/goal/cleared` instead). Announcing from the response covers both,
   * and this guard is what stops the `thread/start` path emitting twice.
   */
  private announceThread(providerThreadId: string): void {
    if (this.announcedThreadId === providerThreadId) {
      return;
    }
    this.announcedThreadId = providerThreadId;
    this.emit({ type: "thread.started", payload: { providerThreadId } });
  }

  private emit(draft: RuntimeEventDraft): void {
    this.updatedAt = this.options.context.clock.nowIso();
    this.options.emit(draft);
  }

  private setStatus(status: ProviderSessionStatus): void {
    if (this.status === status) {
      return;
    }
    this.status = status;
    this.emit({
      type: "session.state.changed",
      payload: {
        state: status,
        ...(this.lastError !== undefined && status === "error" ? { reason: this.lastError } : {})
      }
    });
  }

  /** Keep the live-task registry in step with what the normaliser emitted. */
  private trackTask(draft: RuntimeEventDraft): void {
    if (draft.type === "task.started") {
      this.liveTasks.set(draft.payload.taskId, {
        taskId: draft.payload.taskId,
        ...(draft.payload.agentId !== undefined ? { agentId: draft.payload.agentId } : {}),
        ...(draft.payload.agentPath !== undefined ? { agentPath: draft.payload.agentPath } : {})
      });
    } else if (draft.type === "task.completed") {
      this.liveTasks.delete(draft.payload.taskId);
    }
  }

  private selectedOption(id: string): string | undefined {
    const option = this.modelSelection.options?.find((entry) => entry.id === id);
    if (option === undefined || typeof option.value !== "string" || option.value.length === 0) {
      return undefined;
    }
    return option.value;
  }

  private nextRequestId(): string {
    this.requestSeq += 1;
    return `codex-${this.threadId}-${this.requestSeq}`;
  }

  private requirePeer(): CodexPeer {
    const peer = this.peer;
    if (peer === null || peer.isClosed) {
      throw new Error(`codex session for thread ${this.threadId} is not connected`);
    }
    return peer;
  }

  private requireProviderThreadId(): string {
    const id = this.providerThreadId;
    if (id === null) {
      throw new Error(`codex session for thread ${this.threadId} has no provider thread`);
    }
    return id;
  }

  /**
   * Every wait on the child is bounded, and an expired deadline KILLS it
   * rather than leaving the thread `starting` forever (§3.1). This is the one
   * place the design does not follow T3.
   */
  private deadline(name: keyof typeof AGENT_HOST_DEADLINES): number {
    return this.options.deadlines?.[name] ?? AGENT_HOST_DEADLINES[name];
  }

  private bounded<T>(work: () => Promise<T>, timeoutMs: number, label: string): Promise<T> {
    return withDeadline(work, {
      label: `codex ${label}`,
      timeoutMs,
      onTimeout: () => {
        this.lastError = `codex ${label} timed out after ${timeoutMs}ms`;
        void this.child?.kill();
      },
      signal: this.options.context.signal
    });
  }
}

const HOST_CLIENT_VERSION = "1";

// ---------------------------------------------------------------------------
// Question filtering (§4.5 "Two question paths")
// ---------------------------------------------------------------------------

/**
 * The RPC path's filter.
 *
 * §4.5 describes T3's filter as keying on `prompt` and requiring "at least one
 * option whose label *and* description are both non-empty". On 0.154.0:
 *
 * - the prompt field is **`question`** — a filter keyed on `prompt` drops every
 *   question;
 * - `options` is `Array<{label, description}> | null`, with **no `value`**, so
 *   §4.1's `value` is always undefined for Codex and the answer must be the
 *   *label*;
 * - `isOther` maps onto `allowCustomAnswer`, and an `isOther` question with no
 *   options is a legitimate free-text-only question, so **"at least one
 *   option" is not required when `isOther` is set**;
 * - `multiSelect` does not exist on the wire, and `answers` is an array anyway,
 *   so T3's hard-coded `false` is still right.
 *
 * (fixtures README observation 11.)
 */
export function toUserInputQuestions(
  questions: readonly CodexProtocol.v2.ToolRequestUserInputQuestion[]
): UserInputQuestion[] {
  const out: UserInputQuestion[] = [];
  for (const question of questions) {
    const id = question.id.trim();
    const header = question.header.trim();
    const prompt = question.question.trim();
    if (id.length === 0 || header.length === 0 || prompt.length === 0) {
      continue;
    }
    const options = (question.options ?? [])
      .map((option) => ({ label: option.label.trim(), description: option.description.trim() }))
      .filter((option) => option.label.length > 0 && option.description.length > 0);
    if (options.length === 0 && !question.isOther) {
      continue;
    }
    out.push({
      id,
      header,
      question: prompt,
      options,
      // `isOther` is carried through in the provider's own spelling as well as
      // the canonical `allowCustomAnswer`, so the composer can render Codex's
      // free-text affordance exactly (W13's request).
      ...(question.isOther ? { allowCustomAnswer: true, isOther: true } : {}),
      // A secret answer is masked by the composer and never reaches a draft.
      ...(question.isSecret ? { isSecret: true } : {}),
      multiSelect: false
    });
  }
  return out;
}

/**
 * `{answers: {<questionId>: {answers: [<label>]}}}` — exactly T3's shape, and
 * accepted by the server verbatim. A question the user did not answer is
 * omitted rather than sent empty.
 */
export function toCodexAnswers(
  questions: readonly Pick<UserInputQuestion, "id">[],
  answers: Record<string, unknown>
): Record<string, CodexProtocol.v2.ToolRequestUserInputAnswer> {
  const out: Record<string, CodexProtocol.v2.ToolRequestUserInputAnswer> = {};
  for (const question of questions) {
    const value = answers[question.id];
    const list = normaliseAnswer(value);
    if (list.length === 0) {
      continue;
    }
    out[question.id] = { answers: list };
  }
  return out;
}

function normaliseAnswer(value: unknown): string[] {
  if (typeof value === "string") {
    return value.length > 0 ? [value] : [];
  }
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  }
  return [];
}
