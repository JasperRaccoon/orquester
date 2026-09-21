/**
 * Claude adapter — one live session per thread (spec §3.1, §4.1, §4.5).
 *
 * Ported from T3 Code (MIT):
 * `apps/server/src/provider/Layers/ClaudeAdapter.ts` (`startSession`,
 * `sendTurn`, `interruptTurn`, `stopSessionInternal`, `handleStreamExit`,
 * `canUseTool`, `handleAskUserQuestion`, `handleResumeDialog`), translated
 * from Effect into plain promises.
 *
 * One `query()` per thread, with a streaming input kept open across turns. The
 * message loop **never breaks**: breaking out of `for await (… of query)`
 * closes the query and kills the CLI, so a stop always goes through
 * {@link ClaudeSession.teardown}.
 */

import { promises as fs } from "node:fs";

import type {
  CanUseTool,
  PermissionResult,
  PermissionUpdate,
  Query,
  SDKUserMessage,
  UserDialogRequest,
  UserDialogResult
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AccountHome,
  ApprovalDecision,
  AttachmentRef,
  CanonicalRequestType,
  InteractionMode,
  ModelSelection,
  ProviderModel,
  ProviderSession,
  RuntimeEvent,
  RuntimeMode,
  Skill,
  ThreadSnapshot
} from "@orquester/api/agent-chat";
import { SUPPORTED_ATTACHMENT_IMAGE_MIME_TYPES } from "@orquester/api/agent-chat";

import type { AdapterContext } from "../../adapter.ts";
import { TURN_LIVENESS_WINDOWS, withDeadline } from "../../support/deadline.ts";
import { StderrCapture } from "../../support/stderr.ts";
import { createDeferred, type Deferred } from "./async-queue.ts";
import { classifyRequestType, summarizeToolRequest, trimmedString } from "./classify.ts";
import { buildClaudeResumeCursor, type ClaudeResumeCursor } from "./cursor.ts";
import { permissionResultForDecision, shouldShortCircuitToAllow } from "./decisions.ts";
import type { ClaudeAdapterDeps } from "./deps.ts";
import { createClaudeHistoryReader } from "./history.ts";
import { buildClaudeQueryOptions } from "./launch.ts";
import { CLAUDE_OPTION_IDS, findModel, resolveEffortLevel, selectionStringOption } from "./models.ts";
import { ClaudeNormalizer, extractExitPlanModePlan } from "./normalize.ts";
import { PromptQueue } from "./prompt-queue.ts";
import { buildAskUserQuestionReply, parseAskUserQuestionInput } from "./questions.ts";
import {
  ROLLBACK_SESSION_UNAVAILABLE,
  ROLLBACK_FORK_MISALIGNED,
  planClaudeRollback,
  remapClaudeForkTurnBoundaries
} from "./rollback.ts";
import { dispatchableSkillNames, discoverClaudeSkills } from "./skills.ts";
import { planClaudeSkillDispatch } from "./skill-dispatch.ts";
import type { ClaudeScopedLimitNames } from "./usage.ts";

/**
 * The fixed message `ExitPlanMode` is always denied with: the plan is a
 * client-owned card, never the SDK's gate (§4.5).
 */
export const EXIT_PLAN_MODE_DENY_MESSAGE =
  "The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn.";

/** The literal turn a `/compact` compaction sends (§4.1 `compaction`). */
export const COMPACT_COMMAND = "/compact";

const IMAGE_MIME_TYPES = new Set<string>(SUPPORTED_ATTACHMENT_IMAGE_MIME_TYPES);

interface PendingApproval {
  requestId: string;
  requestType: CanonicalRequestType;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseId?: string;
  suggestions?: readonly PermissionUpdate[];
  settle: (decision: ApprovalDecision) => void;
}

interface PendingUserInput {
  requestId: string;
  toolInput: Record<string, unknown>;
  toolUseId?: string;
  settle: (answers: Record<string, unknown> | null) => void;
}

export interface ClaudeSessionOptions {
  context: AdapterContext;
  deps: ClaudeAdapterDeps;
  threadId: string;
  cwd: string;
  home: AccountHome;
  runtimeMode: RuntimeMode;
  modelSelection: ModelSelection;
  models: readonly ProviderModel[];
  executablePath: string;
  /** The complete child env; carries `CLAUDE_CONFIG_DIR` and nothing ambient. */
  env: Record<string, string>;
  resumeCursor?: ClaudeResumeCursor;
  scopedLimitNames: ClaudeScopedLimitNames;
  emit: (events: readonly RuntimeEvent[]) => void;
  onClosed: (session: ClaudeSession) => void;
  /** Marks the cached provider snapshot stale (§4.1). */
  onUsageLimitsStale?: () => void;
  launchArgs?: readonly string[];
  autoCompactWindow?: number;
}

export class ClaudeSession {
  readonly threadId: string;
  readonly normalizer: ClaudeNormalizer;

  private readonly options: ClaudeSessionOptions;
  private readonly promptQueue = new PromptQueue();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly pendingUserInputs = new Map<string, PendingUserInput>();
  private readonly stderr: StderrCapture;

  private query: Query | undefined;
  private record: ProviderSession;
  private closed = false;
  private hostInitiatedStop = false;
  private streamDone: Promise<void> | undefined;
  private turnSettled: Deferred<void> | undefined;
  private watchdog: NodeJS.Timeout | number | undefined;
  private lastActivityMs = 0;
  private hasOpenTool = false;
  private basePermissionMode: NonNullable<
    ReturnType<typeof buildClaudeQueryOptions>["basePermissionMode"]
  > = "default";
  private currentModel: string | undefined;
  private currentEffort: string | undefined;
  /** The native session id to resume from — updated on every assistant message. */
  private resumeSessionId: string | undefined;
  private resumeSessionAt: string | undefined;

  constructor(options: ClaudeSessionOptions) {
    this.options = options;
    this.threadId = options.threadId;
    this.stderr = new StderrCapture({
      homeDirs: options.home.path.length > 0 ? [options.home.path] : []
    });
    this.normalizer = new ClaudeNormalizer({
      threadId: options.threadId,
      clock: options.context.clock,
      ids: options.context.ids,
      onRawFrame: (frame) => options.context.logRawFrame(options.threadId, frame),
      ...(options.onUsageLimitsStale !== undefined
        ? { onUsageLimitsStale: options.onUsageLimitsStale }
        : {})
    });
    this.normalizer.scopedLimitNames = options.scopedLimitNames;
    this.resumeSessionId = options.resumeCursor?.resume;
    this.resumeSessionAt = options.resumeCursor?.resumeSessionAt;
    if (options.resumeCursor?.turnStartMessageIds !== undefined) {
      this.normalizer.turnStartMessageIds.push(...options.resumeCursor.turnStartMessageIds);
    }
    const now = options.context.clock.nowIso();
    this.record = {
      threadId: options.threadId,
      status: "starting",
      runtimeMode: options.runtimeMode,
      cwd: options.cwd,
      ...(options.modelSelection.model ? { model: options.modelSelection.model } : {}),
      ...(options.resumeCursor !== undefined ? { resumeCursor: options.resumeCursor } : {}),
      createdAt: now,
      updatedAt: now
    };
  }

  // -------------------------------------------------------------------------
  // Accessors
  // -------------------------------------------------------------------------

  get session(): ProviderSession {
    return { ...this.record };
  }

  get isAlive(): boolean {
    return !this.closed;
  }

  get activeTurnId(): string | undefined {
    return this.normalizer.turnState?.turnId;
  }

  // -------------------------------------------------------------------------
  // Start
  // -------------------------------------------------------------------------

  async start(): Promise<ProviderSession> {
    const built = buildClaudeQueryOptions({
      cwd: this.options.cwd,
      executablePath: this.options.executablePath,
      env: this.options.env,
      runtimeMode: this.options.runtimeMode,
      modelSelection: this.options.modelSelection,
      models: this.options.models,
      attachmentsDir: this.options.context.attachmentsDir(this.threadId),
      canUseTool: this.canUseTool,
      onUserDialog: this.onUserDialog,
      stderr: (data) => this.onStderr(data),
      ...(this.resumeSessionId !== undefined ? { resume: this.resumeSessionId } : {}),
      ...(this.resumeSessionAt !== undefined ? { resumeSessionAt: this.resumeSessionAt } : {}),
      ...(this.resumeSessionId === undefined
        ? { sessionId: this.options.context.ids.uuid() }
        : {}),
      ...(this.options.launchArgs !== undefined ? { launchArgs: this.options.launchArgs } : {}),
      ...(this.options.autoCompactWindow !== undefined
        ? { autoCompactWindow: this.options.autoCompactWindow }
        : {})
    });
    this.basePermissionMode = built.basePermissionMode;
    this.currentModel = built.model;
    this.currentEffort = built.effort;
    this.normalizer.expectedModel = built.model;
    if (built.options.sessionId !== undefined) {
      // A client-supplied session id is honoured verbatim, so the resume
      // cursor exists before the CLI has said anything (fixtures README
      // observation 8).
      this.resumeSessionId = built.options.sessionId;
    }

    this.emit([this.normalizer.sessionStarted(this.options.resumeCursor)]);

    try {
      this.query = this.options.deps.query({
        prompt: this.promptQueue,
        options: built.options
      });
    } catch (error) {
      this.record = {
        ...this.record,
        status: "error",
        lastError: errorMessage(error),
        updatedAt: this.options.context.clock.nowIso()
      };
      this.closed = true;
      this.emit([
        this.normalizer.error(
          `Could not start the Claude CLI: ${errorMessage(error)}`,
          "provider_error"
        ),
        this.normalizer.sessionExited({
          reason: errorMessage(error),
          recoverable: false,
          exitKind: "error"
        })
      ]);
      this.options.onClosed(this);
      throw error instanceof Error ? error : new Error(errorMessage(error));
    }

    // The message loop starts before the handshake so the frames the CLI emits
    // while initialising are normalised rather than buffered.
    this.streamDone = this.runStream();

    try {
      await withDeadline(this.query.initializationResult(), {
        label: "claude/handshake",
        timeoutMs: this.options.deps.deadlines.handshakeMs,
        onTimeout: () => {
          // An expired deadline kills the child rather than leaving the thread
          // `starting` forever (§3.1).
          this.closeQuery();
        }
      });
    } catch (error) {
      await this.teardown({
        reason: `Claude did not finish starting: ${errorMessage(error)}`,
        status: "error",
        exitKind: "error",
        recoverable: true
      });
      throw error instanceof Error ? error : new Error(errorMessage(error));
    }

    this.record = {
      ...this.record,
      status: "ready",
      updatedAt: this.options.context.clock.nowIso(),
      ...(this.resumeSessionId !== undefined
        ? { resumeCursor: this.currentCursor() }
        : {})
    };
    this.emit(this.normalizer.sessionStateChanged("ready", "session:started"));
    return this.session;
  }

  // -------------------------------------------------------------------------
  // The message loop
  // -------------------------------------------------------------------------

  private async runStream(): Promise<void> {
    const query = this.query;
    if (!query) {
      return;
    }
    let failure: unknown;
    try {
      for await (const message of query) {
        // Never `break`: that calls the iterator's `return()`, which closes the
        // query and kills the CLI.
        if (this.closed) {
          continue;
        }
        try {
          this.emit(this.normalizer.handleMessage(message));
        } catch (error) {
          this.emit([
            this.normalizer.error(
              `Failed to process a Claude frame: ${errorMessage(error)}`,
              "unknown",
              message
            )
          ]);
        }
        this.noteActivity();
      }
    } catch (error) {
      failure = error;
    }
    await this.handleStreamEnd(failure);
  }

  private async handleStreamEnd(failure: unknown): Promise<void> {
    if (this.closed) {
      return;
    }
    if (failure !== undefined && !isInterruptLikeError(failure)) {
      const excerpt = this.stderr.excerpt();
      const message = `Claude runtime stream failed: ${errorMessage(failure)}`;
      this.emit([
        this.normalizer.error(
          excerpt.length > 0 ? `${message}\n${excerpt}` : message,
          "transport_error",
          { excerpt }
        )
      ]);
      await this.teardown({
        reason: message,
        status: "error",
        exitKind: "error",
        recoverable: true,
        turnState: "failed",
        turnError: message
      });
      return;
    }
    await this.teardown({
      reason: "Claude runtime stream ended.",
      status: this.hostInitiatedStop ? "stopped" : "error",
      exitKind: this.hostInitiatedStop ? "graceful" : "error",
      recoverable: true,
      turnState: "interrupted",
      turnError: "Claude runtime stream ended."
    });
  }

  private onStderr(data: string): void {
    for (const line of this.stderr.push(data)) {
      if (line.class === "drop") {
        continue;
      }
      this.emit([
        line.class === "error"
          ? this.normalizer.error(line.text, "provider_error")
          : this.normalizer.warning(line.text)
      ]);
    }
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  /**
   * §3.1: a dead child never leaves a running turn. Pending requests are
   * settled **before** the process is signalled (§4.1 "settle before
   * interrupt"), then every live task is closed `stopped`, then the turn is
   * settled, and `session.exited` is the very last event.
   */
  async teardown(input: {
    reason: string;
    status: "stopped" | "error";
    exitKind: "graceful" | "error";
    recoverable: boolean;
    turnState?: "interrupted" | "failed";
    turnError?: string;
    emitExit?: boolean;
  }): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.clearWatchdog();

    this.emit(this.cancelPendingRequests());
    this.closeQuery();
    this.promptQueue.close();

    this.emit(this.normalizer.closeLiveTasks());
    if (this.normalizer.turnState) {
      this.emit(
        this.normalizer.completeTurn(input.turnState ?? "interrupted", input.turnError ?? input.reason)
      );
    }
    this.turnSettled?.resolve();

    this.record = {
      ...this.record,
      status: input.status,
      activeTurnId: undefined,
      updatedAt: this.options.context.clock.nowIso(),
      ...(input.status === "error" ? { lastError: input.reason } : {})
    };

    if (input.emitExit !== false) {
      this.emit([
        this.normalizer.sessionExited({
          reason: input.reason,
          recoverable: input.recoverable,
          exitKind: input.exitKind
        })
      ]);
    }
    this.options.onClosed(this);
  }

  /** Settle every parked request with `cancel`, and report each resolution. */
  private cancelPendingRequests(): RuntimeEvent[] {
    const events: RuntimeEvent[] = [];
    for (const pending of [...this.pendingApprovals.values()]) {
      this.pendingApprovals.delete(pending.requestId);
      pending.settle("cancel");
      events.push(
        this.normalizer.requestResolved({
          requestId: pending.requestId,
          requestType: pending.requestType,
          decision: "cancel",
          ...(pending.toolUseId !== undefined ? { toolUseId: pending.toolUseId } : {})
        })
      );
    }
    for (const pending of [...this.pendingUserInputs.values()]) {
      this.pendingUserInputs.delete(pending.requestId);
      pending.settle(null);
      events.push(
        this.normalizer.userInputResolved({
          requestId: pending.requestId,
          answers: {},
          ...(pending.toolUseId !== undefined ? { toolUseId: pending.toolUseId } : {})
        })
      );
    }
    return events;
  }

  private closeQuery(): void {
    try {
      this.query?.close();
    } catch {
      // The child may already be gone; the exit watcher decides the outcome.
    }
  }

  // -------------------------------------------------------------------------
  // canUseTool — the approval surface
  // -------------------------------------------------------------------------

  private readonly canUseTool: CanUseTool = async (toolName, toolInput, callbackOptions) => {
    if (this.closed) {
      return { behavior: "deny", message: "The Claude session is no longer running." };
    }

    // AskUserQuestion is intercepted BEFORE any approval logic, in every
    // runtime mode — plan mode leans on it heavily (§4.5).
    if (toolName === "AskUserQuestion") {
      return this.handleAskUserQuestion(toolInput, callbackOptions);
    }

    if (toolName === "ExitPlanMode") {
      const plan = extractExitPlanModePlan(toolInput);
      if (plan) {
        this.emit(
          this.normalizer.proposedPlanCompleted({
            planMarkdown: plan.planMarkdown,
            toolUseId: callbackOptions.toolUseID,
            ...(plan.planFilePath !== undefined ? { planFilePath: plan.planFilePath } : {}),
            source: "claude.sdk.permission",
            method: "canUseTool/ExitPlanMode",
            payload: { toolName, input: toolInput }
          })
        );
      }
      return { behavior: "deny", message: EXIT_PLAN_MODE_DENY_MESSAGE };
    }

    if (shouldShortCircuitToAllow(this.options.runtimeMode)) {
      // Allow with no event at all — nothing is written to the timeline (§4.3).
      return { behavior: "allow", updatedInput: toolInput };
    }

    // Keyed on the SDK's own request id: it redelivers a request whose
    // response was lost in a transport gap, and a freshly minted key would
    // open a second card for the same tool call (fixtures README obs. 11).
    const requestId = trimmedString(callbackOptions.requestId) ?? this.options.context.ids.uuid();
    const existing = this.pendingApprovals.get(requestId);
    if (existing) {
      // Idempotent per request id: the first card stays, and this delivery
      // waits on the same decision.
      return new Promise<PermissionResult>((resolve) => {
        const previous = existing.settle;
        existing.settle = (decision) => {
          previous(decision);
          resolve(
            permissionResultForDecision({
              decision,
              toolName,
              toolInput,
              ...(existing.suggestions !== undefined ? { suggestions: existing.suggestions } : {})
            })
          );
        };
      });
    }

    const requestType = classifyRequestType(toolName);
    // The provider's own one-line summary beats anything reconstructed here.
    const detail =
      trimmedString(callbackOptions.description) ?? summarizeToolRequest(toolName, toolInput);

    const decided = createDeferred<ApprovalDecision>();
    const pending: PendingApproval = {
      requestId,
      requestType,
      toolName,
      toolInput,
      ...(callbackOptions.toolUseID !== undefined ? { toolUseId: callbackOptions.toolUseID } : {}),
      ...(callbackOptions.suggestions !== undefined
        ? { suggestions: callbackOptions.suggestions }
        : {}),
      settle: (decision) => decided.resolve(decision)
    };
    this.pendingApprovals.set(requestId, pending);

    this.emit([
      this.normalizer.requestOpened({
        requestId,
        requestType,
        detail,
        toolName,
        toolInput,
        ...(callbackOptions.toolUseID !== undefined
          ? { toolUseId: callbackOptions.toolUseID }
          : {}),
        ...(callbackOptions.mcpServer?.name !== undefined
          ? { appName: callbackOptions.mcpServer.name }
          : {})
      })
    ]);
    // A pending request pauses the liveness watchdog: a turn waiting on a
    // human is not a stalled turn (§3.1).
    this.noteActivity();

    const onAbort = (): void => {
      const open = this.pendingApprovals.get(requestId);
      if (!open) {
        return;
      }
      this.pendingApprovals.delete(requestId);
      open.settle("cancel");
      this.emit([
        this.normalizer.requestResolved({
          requestId,
          requestType,
          decision: "cancel",
          ...(callbackOptions.toolUseID !== undefined
            ? { toolUseId: callbackOptions.toolUseID }
            : {})
        })
      ]);
    };
    callbackOptions.signal.addEventListener("abort", onAbort, { once: true });
    // The signal may have aborted while the event above was emitted.
    if (callbackOptions.signal.aborted) {
      onAbort();
    }

    const decision = await decided.promise;
    this.noteActivity();
    return permissionResultForDecision({
      decision,
      toolName,
      toolInput,
      ...(pending.suggestions !== undefined ? { suggestions: pending.suggestions } : {})
    });
  };

  private async handleAskUserQuestion(
    toolInput: Record<string, unknown>,
    callbackOptions: { signal: AbortSignal; toolUseID?: string; requestId?: string }
  ): Promise<PermissionResult> {
    const parsed = parseAskUserQuestionInput(toolInput);
    if (parsed.duplicateQuestionText !== undefined) {
      // The answer key is the question text, so two identical questions in one
      // request are indistinguishable. Refuse rather than answer one of them.
      this.emit([
        this.normalizer.warning(
          `Claude asked two questions with the same text ("${parsed.duplicateQuestionText}"), which cannot be answered unambiguously.`
        )
      ]);
      return {
        behavior: "deny",
        message:
          "Two of those questions have identical text, which the answer format cannot distinguish. Ask them one at a time."
      };
    }

    const requestId = trimmedString(callbackOptions.requestId) ?? this.options.context.ids.uuid();
    const answered = createDeferred<Record<string, unknown> | null>();
    const pending: PendingUserInput = {
      requestId,
      toolInput,
      ...(callbackOptions.toolUseID !== undefined ? { toolUseId: callbackOptions.toolUseID } : {}),
      settle: (answers) => answered.resolve(answers)
    };
    this.pendingUserInputs.set(requestId, pending);

    this.emit([
      this.normalizer.userInputRequested({
        requestId,
        questions: parsed.questions,
        toolInput,
        ...(callbackOptions.toolUseID !== undefined ? { toolUseId: callbackOptions.toolUseID } : {})
      })
    ]);
    this.noteActivity();

    const onAbort = (): void => {
      const open = this.pendingUserInputs.get(requestId);
      if (!open) {
        return;
      }
      this.pendingUserInputs.delete(requestId);
      open.settle(null);
      this.emit([
        this.normalizer.userInputResolved({
          requestId,
          answers: {},
          ...(callbackOptions.toolUseID !== undefined
            ? { toolUseId: callbackOptions.toolUseID }
            : {})
        })
      ]);
    };
    callbackOptions.signal.addEventListener("abort", onAbort, { once: true });
    if (callbackOptions.signal.aborted) {
      onAbort();
    }

    const answers = await answered.promise;
    this.noteActivity();
    if (answers === null) {
      return { behavior: "deny", message: "User cancelled tool execution." };
    }
    return { behavior: "allow", updatedInput: buildAskUserQuestionReply(toolInput, answers) };
  }

  /**
   * The CLI's "this resume is old, compact it?" dialog, turned into an
   * ordinary question so the same card answers it (§4.5).
   */
  private readonly onUserDialog = async (
    request: UserDialogRequest,
    callbackOptions: { signal: AbortSignal; requestId: string }
  ): Promise<UserDialogResult | null> => {
    if (request.dialogKind !== "resume_return") {
      return { behavior: "cancelled" };
    }
    const ageMinutes = Number(request.payload.sessionAgeMinutes ?? 0);
    const estimatedTokens = Number(request.payload.estimatedTokens ?? 0);
    const question =
      `This conversation was last used ${Number.isFinite(ageMinutes) ? Math.max(0, Math.round(ageMinutes)) : 0} minutes ago` +
      (Number.isFinite(estimatedTokens) && estimatedTokens > 0
        ? ` and holds about ${Math.round(estimatedTokens).toLocaleString("en-US")} tokens`
        : "") +
      ". Compact it before continuing?";

    const result = await this.handleAskUserQuestion(
      {
        questions: [
          {
            header: "Resume conversation",
            question,
            options: [
              {
                label: "Compact and continue",
                description: "Resume with a summary and use fewer tokens."
              },
              {
                label: "Keep full history",
                description: "Resume without changing the conversation."
              },
              {
                label: "Keep full history and never ask again",
                description: "Keep full history and skip future resume prompts."
              }
            ],
            multiSelect: false
          }
        ]
      },
      {
        signal: callbackOptions.signal,
        requestId: callbackOptions.requestId,
        ...(request.toolUseID !== undefined ? { toolUseID: request.toolUseID } : {})
      }
    );

    if (result.behavior !== "allow") {
      return { behavior: "cancelled" };
    }
    const answers = (result.updatedInput as { answers?: unknown } | undefined)?.answers;
    const selection =
      answers !== null && typeof answers === "object" && !Array.isArray(answers)
        ? (answers as Record<string, unknown>)[question]
        : undefined;
    const action =
      selection === "Compact and continue"
        ? "compact"
        : selection === "Keep full history and never ask again"
          ? "never"
          : "continue";
    return { behavior: "completed", result: action };
  };

  // -------------------------------------------------------------------------
  // Responding
  // -------------------------------------------------------------------------

  respondToApproval(requestId: string, decision: ApprovalDecision): void {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) {
      throw new Error(`Unknown pending approval request: ${requestId}`);
    }
    this.pendingApprovals.delete(requestId);
    pending.settle(decision);
    this.emit([
      this.normalizer.requestResolved({
        requestId,
        requestType: pending.requestType,
        decision,
        ...(pending.toolUseId !== undefined ? { toolUseId: pending.toolUseId } : {})
      })
    ]);
  }

  respondToUserInput(requestId: string, answers: Record<string, unknown>): void {
    const pending = this.pendingUserInputs.get(requestId);
    if (!pending) {
      throw new Error(`Unknown pending user-input request: ${requestId}`);
    }
    this.pendingUserInputs.delete(requestId);
    pending.settle(answers);
    this.emit([
      this.normalizer.userInputResolved({
        requestId,
        answers,
        ...(pending.toolUseId !== undefined ? { toolUseId: pending.toolUseId } : {})
      })
    ]);
  }

  // -------------------------------------------------------------------------
  // Turns
  // -------------------------------------------------------------------------

  async sendTurn(input: {
    text: string;
    attachments: readonly AttachmentRef[];
    modelSelection?: ModelSelection;
    interactionMode: InteractionMode;
  }): Promise<{ turnId: string; resumeCursor: ClaudeResumeCursor | undefined }> {
    if (this.closed) {
      throw new Error("The Claude session is no longer running.");
    }

    // A `sendTurn` while a real turn runs is a steer: the message is queued
    // into the live agent loop and the work continues as the SAME turn. A
    // stale SYNTHETIC turn (background output between prompts) is auto-closed
    // instead so it cannot block the user's next turn (§4.5).
    const current = this.normalizer.turnState;
    const steering = current !== undefined && !current.synthetic ? current : undefined;
    if (current !== undefined && steering === undefined) {
      this.emit(this.normalizer.completeTurn("completed"));
    }

    await this.applyModelSelection(input.modelSelection);
    await this.applyInteractionMode(input.interactionMode);

    // Skills are re-scanned on EVERY send: they are added and switched off
    // mid-session and the scan is a few directory reads (§4.6.4).
    const skills = await this.discoverSkills();
    const message = await this.buildUserMessage({
      text: input.text,
      attachments: input.attachments,
      skills
    });

    const turnId = steering?.turnId ?? this.options.context.ids.uuid();
    if (steering === undefined) {
      this.turnSettled = createDeferred<void>();
      this.emit(
        this.normalizer.beginTurn({
          turnId,
          ...(this.currentModel !== undefined ? { model: this.currentModel } : {}),
          ...(this.currentEffort !== undefined ? { effort: this.currentEffort } : {})
        })
      );
      this.record = {
        ...this.record,
        status: "running",
        activeTurnId: turnId,
        updatedAt: this.options.context.clock.nowIso()
      };
      this.promptQueue.push({ ...message, uuid: turnId as SDKUserMessage["uuid"] });
    } else {
      this.promptQueue.push(message);
    }

    this.noteActivity();
    this.startWatchdog();
    return { turnId, resumeCursor: this.currentCursor() };
  }

  /** `/compact` as an ordinary turn, awaited to a terminal turn state (§4.1). */
  async compact(): Promise<void> {
    await this.sendTurn({
      text: COMPACT_COMMAND,
      attachments: [],
      interactionMode: "default"
    });
    // The deferred belongs to the turn `sendTurn` just opened (or to the live
    // one it steered into), so it is read AFTER the send rather than before.
    await this.turnSettled?.promise;
  }

  /**
   * §4.1: turn-scoped, and a no-op when that turn is no longer the active one,
   * so a Stop that races a settling turn cannot kill the next one.
   */
  async interruptTurn(turnId?: string): Promise<void> {
    if (this.closed) {
      return;
    }
    const active = this.normalizer.turnState?.turnId;
    if (active === undefined || (turnId !== undefined && turnId !== active)) {
      return;
    }

    // Settle before the interrupt reaches the provider (§4.1): a transport
    // that answers server requests inline is blocked by an open prompt.
    this.emit(this.cancelPendingRequests());

    const settled = this.turnSettled ?? createDeferred<void>();
    this.turnSettled = settled;

    let receipt: { still_queued?: string[] } | undefined;
    try {
      receipt = (await withDeadline(this.query!.interrupt(), {
        label: "claude/interrupt",
        timeoutMs: this.options.deps.deadlines.cancelMs
      })) as { still_queued?: string[] } | undefined;
    } catch {
      // The interrupt RPC is the graceful path; the hard one follows.
      await this.stop("Stop: the Claude CLI did not acknowledge the interrupt.");
      return;
    }

    // `still_queued` is the `interrupt_receipt_v1` contract: uuids of async
    // user messages that WILL still run unless cancelled first
    // (fixtures README observation 14). Stop means stop, so anything left
    // queued escalates to closing the query — which is §4.5's "interrupt is a
    // process kill", now reached only when it is actually needed.
    if ((receipt?.still_queued?.length ?? 0) > 0) {
      await this.stop("Stop: queued work remained after the interrupt.");
      return;
    }

    try {
      await withDeadline(settled.promise, {
        label: "claude/interrupt/settle",
        timeoutMs: this.options.deps.deadlines.cancelMs
      });
    } catch {
      await this.stop("Stop: the turn did not settle after the interrupt.");
    }
  }

  /** A host-initiated stop: the process really does go away. */
  async stop(reason = "Session stopped."): Promise<void> {
    if (this.closed) {
      return;
    }
    this.hostInitiatedStop = true;
    await this.teardown({
      reason,
      status: "stopped",
      exitKind: "graceful",
      recoverable: true,
      turnState: "interrupted",
      turnError: reason
    });
    // The stream loop ends once the query is closed; wait so a caller that
    // stops and immediately restarts cannot race two loops on one thread.
    await Promise.race([
      this.streamDone ?? Promise.resolve(),
      new Promise<void>((resolve) => {
        const handle = this.options.deps.setTimer(resolve, this.options.deps.deadlines.cancelMs);
        void handle;
      })
    ]);
  }

  readThread(): ThreadSnapshot {
    return {
      threadId: this.threadId,
      turns: this.normalizer.turns.map((turn) => ({ id: turn.id, items: [...turn.items] }))
    };
  }

  // -------------------------------------------------------------------------
  // Rollback
  // -------------------------------------------------------------------------

  /**
   * Compute the fork for a rollback of `numTurns` and return the cursor the
   * restarted session must use. Throws the §4.5 refusal when the boundary
   * cannot be established — refuse rather than guess.
   */
  async planRollback(numTurns: number): Promise<{
    cursor: ClaudeResumeCursor | undefined;
    retainedTurns: Array<{ id: string; items: unknown[] }>;
  }> {
    const sessionId = this.resumeSessionId;
    if (sessionId === undefined) {
      throw new Error(ROLLBACK_SESSION_UNAVAILABLE);
    }
    const boundaries = [...this.normalizer.turnStartMessageIds];
    // Rolling back EVERY turn short-circuits to a fresh session rather than a
    // fork (§4.5).
    if (
      boundaries.length > 0 &&
      !boundaries.some((id) => id === null) &&
      numTurns >= boundaries.length
    ) {
      return { cursor: undefined, retainedTurns: [] };
    }

    const history = createClaudeHistoryReader({
      env: this.options.env,
      cwd: this.options.cwd,
      hostConfigDir: this.options.deps.hostConfigDir,
      spawn: this.options.deps.spawn,
      nodePath: this.options.deps.nodePath
    });
    const messages = await history.readMessages({
      sessionId,
      cwd: this.options.cwd
    });
    const plan = planClaudeRollback({ messages, boundaries, numTurns });
    const retainedTurns = this.normalizer.turns.slice(
      0,
      Math.max(0, this.normalizer.turns.length - numTurns)
    );

    if (plan.rollbackAt === undefined) {
      return { cursor: undefined, retainedTurns };
    }

    const fork = await history.fork({
      sessionId,
      upToMessageId: plan.rollbackAt,
      cwd: this.options.cwd
    });
    const forkMessages = await history.readMessages({
      sessionId: fork.sessionId,
      cwd: this.options.cwd
    });
    const remapped = remapClaudeForkTurnBoundaries(
      messages,
      forkMessages,
      plan.firstRemoved,
      plan.retainedBoundaries
    );
    if (!remapped) {
      throw new Error(ROLLBACK_FORK_MISALIGNED);
    }

    return {
      cursor: buildClaudeResumeCursor({
        threadId: this.threadId,
        sessionId: fork.sessionId,
        turnStartMessageIds: remapped
      }),
      retainedTurns
    };
  }

  /** Seed a restarted session with the turns a rollback kept. */
  seedTurns(turns: ReadonlyArray<{ id: string; items: unknown[] }>): void {
    this.normalizer.turns.push(...turns.map((turn) => ({ id: turn.id, items: [...turn.items] })));
  }

  // -------------------------------------------------------------------------
  // Model / mode
  // -------------------------------------------------------------------------

  private async applyModelSelection(selection: ModelSelection | undefined): Promise<void> {
    if (selection === undefined || this.query === undefined) {
      return;
    }
    const slug = trimmedString(selection.model);
    if (slug !== undefined && slug !== this.currentModel) {
      try {
        await this.query.setModel(slug);
        this.currentModel = slug;
        this.normalizer.expectedModel = slug;
        this.record = { ...this.record, model: slug };
      } catch (error) {
        this.emit([
          this.normalizer.warning(`Could not switch the Claude model: ${errorMessage(error)}`)
        ]);
      }
    }
    const model = findModel(this.options.models, slug ?? this.currentModel);
    const effort = resolveEffortLevel(selection, model);
    const requestedEffort = selectionStringOption(selection, CLAUDE_OPTION_IDS.effort);
    if (effort !== undefined && effort !== this.currentEffort) {
      try {
        // Effort is a per-turn knob; `applyFlagSettings` is the SDK's own path
        // for changing it mid-session without re-making the query.
        await this.query.applyFlagSettings({ effortLevel: effort });
        this.currentEffort = effort;
      } catch (error) {
        this.emit([
          this.normalizer.warning(`Could not apply the Claude effort level: ${errorMessage(error)}`)
        ]);
      }
    } else if (
      requestedEffort !== undefined &&
      effort === undefined &&
      model !== undefined
    ) {
      this.emit([
        this.normalizer.warning(
          `${model.name} does not support the "${requestedEffort}" effort level; the model's default is used.`
        )
      ]);
    }
  }

  /**
   * Plan mode is **per turn** (§4.4): `setPermissionMode("plan")` before the
   * turn, and back to the session's base mode otherwise. A RuntimeMode change
   * restarts the session instead (§3.4) — it is never applied here.
   */
  private async applyInteractionMode(mode: InteractionMode): Promise<void> {
    if (this.query === undefined) {
      return;
    }
    const target = mode === "plan" ? "plan" : this.basePermissionMode;
    try {
      await this.query.setPermissionMode(target);
    } catch (error) {
      this.emit([
        this.normalizer.warning(`Could not set the Claude permission mode: ${errorMessage(error)}`)
      ]);
    }
  }

  private async discoverSkills(): Promise<Skill[]> {
    const configDir = this.options.env.CLAUDE_CONFIG_DIR ?? this.options.home.path;
    try {
      return await discoverClaudeSkills({ configDir, cwd: this.options.cwd });
    } catch {
      // Discovery is best-effort: a broken skills dir must never fail a turn.
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Message building
  // -------------------------------------------------------------------------

  /**
   * Content-block order is load-bearing (§4.5): optional leading text (skill
   * dispatch) → base64 image blocks → the final text block **last**. The CLI
   * only reads a streamed user message as a slash-command invocation when the
   * last block is text, so leading with the text drops a hand-typed
   * `/command` back to plain prose on every image-carrying turn.
   */
  private async buildUserMessage(input: {
    text: string;
    attachments: readonly AttachmentRef[];
    skills: readonly Skill[];
  }): Promise<SDKUserMessage> {
    const content: Array<Record<string, unknown>> = [];
    const dispatch = planClaudeSkillDispatch(input.text, dispatchableSkillNames(input.skills));
    if (dispatch?.leadingText !== undefined) {
      content.push({ type: "text", text: dispatch.leadingText });
    }

    for (const attachment of input.attachments) {
      // Claude ingests images only; a generic file reaches the agent through
      // the path line the host puts in the prompt.
      if (attachment.type !== "image") {
        continue;
      }
      if (!IMAGE_MIME_TYPES.has(attachment.mimeType)) {
        throw new Error(`Unsupported Claude image attachment type '${attachment.mimeType}'.`);
      }
      const path = await this.options.context.resolveAttachmentPath(this.threadId, attachment.id);
      const bytes = await fs.readFile(path);
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: attachment.mimeType,
          data: bytes.toString("base64")
        }
      });
    }

    if (dispatch) {
      content.push({ type: "text", text: dispatch.commandText });
    } else if (input.text.length > 0) {
      content.push({ type: "text", text: input.text });
    }

    return {
      type: "user",
      session_id: this.resumeSessionId ?? "",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: content as unknown as SDKUserMessage["message"]["content"]
      }
    } as SDKUserMessage;
  }

  // -------------------------------------------------------------------------
  // Cursor
  // -------------------------------------------------------------------------

  currentCursor(): ClaudeResumeCursor | undefined {
    const sessionId = this.normalizer.providerSessionId ?? this.resumeSessionId;
    if (sessionId === undefined) {
      return undefined;
    }
    this.resumeSessionId = sessionId;
    const cursor = buildClaudeResumeCursor({
      threadId: this.threadId,
      sessionId,
      turnStartMessageIds: this.normalizer.turnStartMessageIds
    });
    this.record = { ...this.record, resumeCursor: cursor };
    return cursor;
  }

  // -------------------------------------------------------------------------
  // Liveness watchdog (§3.1)
  // -------------------------------------------------------------------------

  private noteActivity(): void {
    this.lastActivityMs = this.options.context.clock.now().getTime();
    this.hasOpenTool = this.normalizer.liveTasks().size > 0;
  }

  private startWatchdog(): void {
    this.clearWatchdog();
    this.lastActivityMs = this.options.context.clock.now().getTime();
    this.scheduleWatchdog();
  }

  private scheduleWatchdog(): void {
    const window = this.hasOpenTool
      ? TURN_LIVENESS_WINDOWS.activeToolMs
      : TURN_LIVENESS_WINDOWS.idleMs;
    this.watchdog = this.options.deps.setTimer(() => {
      void this.checkLiveness();
    }, window);
  }

  private clearWatchdog(): void {
    if (this.watchdog !== undefined) {
      this.options.deps.clearTimer(this.watchdog);
      this.watchdog = undefined;
    }
  }

  private async checkLiveness(): Promise<void> {
    this.watchdog = undefined;
    if (this.closed || this.normalizer.turnState === undefined) {
      return;
    }
    // Paused entirely while an approval or a user-input request is pending: a
    // turn waiting on a human is not a stalled turn (§3.1).
    if (this.pendingApprovals.size > 0 || this.pendingUserInputs.size > 0) {
      this.scheduleWatchdog();
      return;
    }
    const window = this.hasOpenTool
      ? TURN_LIVENESS_WINDOWS.activeToolMs
      : TURN_LIVENESS_WINDOWS.idleMs;
    const idleFor = this.options.context.clock.now().getTime() - this.lastActivityMs;
    if (idleFor < window) {
      this.scheduleWatchdog();
      return;
    }
    const minutes = Math.round(window / 60_000);
    const reason = `Claude produced no activity for ${minutes} minutes; the turn was cancelled.`;
    this.emit([this.normalizer.error(reason, "provider_error")]);
    await this.stop(reason);
  }

  // -------------------------------------------------------------------------
  // Emission
  // -------------------------------------------------------------------------

  private emit(events: readonly RuntimeEvent[]): void {
    if (events.length === 0) {
      return;
    }
    this.options.emit(events);
    if (this.normalizer.turnState === undefined) {
      this.turnSettled?.resolve();
      this.record = { ...this.record, activeTurnId: undefined };
    }
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : JSON.stringify(error);
}

/** A stream that ended because we interrupted it is not a failure. */
function isInterruptLikeError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes("abort") ||
    message.includes("request was aborted") ||
    message.includes("interrupted by user") ||
    message.includes("closed")
  );
}
