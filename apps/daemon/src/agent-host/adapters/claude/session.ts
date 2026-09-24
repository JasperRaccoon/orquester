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
import { homedir } from "node:os";

import type {
  CanUseTool,
  PermissionResult,
  PermissionUpdate,
  Query,
  SDKMessage,
  SDKUserMessage,
  UserDialogRequest,
  UserDialogResult
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AccountHome,
  AgentGoal,
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
import { SUPPORTED_ATTACHMENT_IMAGE_MIME_TYPES, isUnfinishedGoal } from "@orquester/api/agent-chat";

import type { AdapterContext, RollbackTarget } from "../../adapter.ts";
import { TURN_LIVENESS_WINDOWS, withDeadline } from "../../support/deadline.ts";
import { StderrCapture } from "../../support/stderr.ts";
import { FileTail, TAIL_MAX_READ_BYTES, TAIL_MAX_TOTAL_BYTES, resolveTildePath } from "../../support/tail-file.ts";
import { appendAttachmentPathLines, type AttachmentPathLine } from "../attachment-lines.ts";
import { createDeferred, type Deferred } from "./async-queue.ts";
import { classifyRequestType, summarizeToolRequest, trimmedString } from "./classify.ts";
import {
  buildClaudeResumeCursor,
  claudeTurnBoundariesFromCursor,
  type ClaudeResumeCursor
} from "./cursor.ts";
import {
  claudeCanUseToolRoute,
  claudeRequestKey,
  permissionResultForDecision,
  shouldShortCircuitToAllow
} from "./decisions.ts";
import type { ClaudeAdapterDeps } from "./deps.ts";
import { transcriptGoalFromLastRow } from "./goal.ts";
import { claudeConfigDir } from "./config-dir.ts";
import { ClaudeGoalTranscript } from "./goal-transcript.ts";
import { createClaudeHistoryReader, type ClaudeHistoryReader } from "./history.ts";
import { buildClaudeQueryOptions } from "./launch.ts";
import { CLAUDE_OPTION_IDS, findModel, resolveEffortLevel, selectionStringOption } from "./models.ts";
import {
  ClaudeNormalizer,
  extractExitPlanModePlan,
  type BackgroundShellChange
} from "./normalize.ts";
import { PromptQueue } from "./prompt-queue.ts";
import { buildAskUserQuestionReply, parseAskUserQuestionInput } from "./questions.ts";
import {
  ROLLBACK_COMPACTED,
  ROLLBACK_SESSION_UNAVAILABLE,
  ROLLBACK_FORK_MISALIGNED,
  groupClaudeHistoryTurns,
  isAnchorReachableAfterCompaction,
  planClaudeRollback,
  planClaudeRollbackById,
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

/**
 * How often a background shell's output file is re-read. The CLI streams that
 * output nowhere — it writes it to a file and tells the model to `Read` it —
 * so this poll is the only way the chat can show a running command's output.
 * 750 ms is a compromise: fast enough to read as live, slow enough that a
 * chatty command costs a handful of `stat`s a second.
 */
export const BACKGROUND_SHELL_TAIL_INTERVAL_MS = 750;

/**
 * A file read that has not answered in this long is treated as failed, like
 * every other wait on a child (§3.1). A stuck FUSE/NFS mount must not hold the
 * message loop, which is what the final drain awaits.
 */
export const BACKGROUND_SHELL_TAIL_READ_DEADLINE_MS = 5_000;

/** The final drain's bound: the per-shell cap divided by one read, plus one. */
const BACKGROUND_SHELL_DRAIN_MAX_READS = Math.ceil(TAIL_MAX_TOTAL_BYTES / TAIL_MAX_READ_BYTES) + 1;

/**
 * One incremental read of the CLI's transcript for `goal_status` rows, or one
 * set-point jump (goals §6.1.4). Local-file work of a turn's worth of bytes;
 * past this a stuck mount is given up on, like a background shell's tail.
 */
export const GOAL_TRANSCRIPT_READ_DEADLINE_MS = 5_000;

/**
 * The resume scan reads a WHOLE transcript for its last `goal_status` row
 * (goals §6.1.5) — tens of megabytes on a long thread — so it gets longer.
 */
export const GOAL_TRANSCRIPT_SCAN_DEADLINE_MS = 30_000;

/**
 * How long a stop waits for goal reads already in flight before
 * `session.exited` goes out. A read that met the goal just before a stop
 * would otherwise be dropped: nothing may follow `session.exited`.
 */
export const GOAL_WORK_SETTLE_DEADLINE_MS = 5_000;

/**
 * When a turn-end walk found no verdict, the transcript is read again after
 * these delays, one after the other (~0.3 s and ~1.5 s after the turn end).
 *
 * The CLI writes a goal's met / impossible `goal_status` row only to its
 * transcript, and an SDK session does NOT flush the transcript before
 * `result`: the hard flush is gated on `CLAUDE_CODE_EAGER_FLUSH` /
 * `CLAUDE_CODE_IS_COWORK` (never set here — the chat spec keeps the Claude
 * env to `CLAUDE_CONFIG_DIR`), and the row is queued for the store's 100 ms
 * write timer (2.1.280). Read at `result` alone, the verdict was missed and
 * the goal read "active" until the next turn ended.
 */
export const GOAL_VERDICT_REREAD_DELAYS_MS = [300, 1_200] as const;

/**
 * One read of the transcript's new rows, walked chunk by chunk (goals
 * §6.1.4). What the walk judges by is taken when it is asked for: the turn
 * that ended, whether background work was live then, and the goal epoch.
 */
interface TranscriptWalk {
  sessionId: string | undefined;
  turnId?: string;
  atTurnEnd: boolean;
  backgroundLive: boolean;
  epoch: number;
  /** How many verdict re-reads came before this walk (0: the turn end's own). */
  reread: number;
  /**
   * A met / impossible row may still be on its way: the turn ended with
   * nothing in the background, so the CLI did evaluate. Such a walk that finds
   * no verdict schedules the next re-read.
   */
  awaitsVerdict: boolean;
}

interface BackgroundShellTail {
  tail: FileTail;
  timer: NodeJS.Timeout | number | undefined;
  stopped: boolean;
}

const IMAGE_MIME_TYPES = new Set<string>(SUPPORTED_ATTACHMENT_IMAGE_MIME_TYPES);

/**
 * §4.1: Claude ingests an attachment natively — as an inline base64 image
 * block — only when it is an image of a mime the API accepts. Everything else
 * (a PDF, a CSV, a pasted-text file, an image of any other mime) reaches the
 * agent as a line of the `Attached files:` block `appendAttachmentPathLines`
 * writes, which the attachments-dir grant (`launch.ts`) lets it `Read` without
 * an approval prompt. Pure; judged on the ref alone.
 */
export function claudeIngestsAttachment(
  attachment: AttachmentRef
): attachment is Extract<AttachmentRef, { type: "image" }> {
  return attachment.type === "image" && IMAGE_MIME_TYPES.has(attachment.mimeType);
}

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
  autoCompactWindow?: number;
  /** The fold's goal (goals §5.3); the session reports only what changes from it. */
  knownGoal?: AgentGoal | null;
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
  /** One debug line per session for an unavailable context-usage request. */
  private contextUsageUnavailableLogged = false;
  private hostInitiatedStop = false;
  private streamDone: Promise<void> | undefined;
  private turnSettled: Deferred<void> | undefined;
  private watchdog: NodeJS.Timeout | number | undefined;
  /** One live tail per background shell, keyed by task id. */
  private readonly backgroundShells = new Map<string, BackgroundShellTail>();
  private lastActivityMs = 0;
  private hasOpenTool = false;
  private basePermissionMode: NonNullable<
    ReturnType<typeof buildClaudeQueryOptions>["basePermissionMode"]
  > = "default";
  private currentModel: string | undefined;
  private currentEffort: string | undefined;
  /** The native session id to resume from — updated on every assistant message. */
  private resumeSessionId: string | undefined;
  /** True when this session was started from a cursor, i.e. it has a past. */
  private readonly startedFromCursor: boolean;
  private resumeSessionAt: string | undefined;
  /**
   * The CLI's own transcript, read for what stdout never says about a goal:
   * met, impossible, cleared by an error (goals §6.1.4), and what `--resume`
   * re-arms (§6.1.5).
   */
  private readonly goalTranscript: ClaudeGoalTranscript;
  /** Goal transcript work, one item at a time, never on the message loop. */
  private goalWork: Promise<void> = Promise.resolve();
  private goalWorkPending = 0;
  /** A throttled goal `progress`, flushed when its window ends (goals §6). */
  private goalFlushTimer: NodeJS.Timeout | number | undefined;
  /** False once `session.exited` is out: nothing may follow it. */
  private goalOutputOpen = true;
  /** The one teardown, once it has begun (see {@link teardown}). */
  private teardownDone: Promise<void> | undefined;
  /** A transcript walk is under way; the ones asked for behind it wait here. */
  private transcriptWalking = false;
  private readonly transcriptWalksWaiting: TranscriptWalk[] = [];
  /** The pending verdict re-read, if any ({@link GOAL_VERDICT_REREAD_DELAYS_MS}). */
  private verdictRereadTimer: NodeJS.Timeout | number | undefined;

  constructor(options: ClaudeSessionOptions) {
    this.options = options;
    this.threadId = options.threadId;
    this.stderr = new StderrCapture({
      homeDirs: options.home.path.length > 0 ? [options.home.path] : []
    });
    this.goalTranscript = new ClaudeGoalTranscript({
      configDir: claudeConfigDir(options.env),
      cwd: options.cwd
    });
    this.normalizer = new ClaudeNormalizer({
      threadId: options.threadId,
      clock: options.context.clock,
      ids: options.context.ids,
      onRawFrame: (frame) => options.context.logRawFrame(options.threadId, frame),
      onBackgroundShell: (change) => this.onBackgroundShell(change),
      ...(options.onUsageLimitsStale !== undefined
        ? { onUsageLimitsStale: options.onUsageLimitsStale }
        : {}),
      ...(options.knownGoal !== undefined ? { knownGoal: options.knownGoal } : {}),
      onGoalSetPoint: () => this.markGoalSetPoint(),
      onGoalTranscriptCheck: () => this.checkGoalTranscript({ atTurnEnd: false }),
      onGoalProgressDeferred: (dueAtMs) => this.scheduleGoalFlush(dueAtMs)
    });
    this.normalizer.scopedLimitNames = options.scopedLimitNames;
    this.resumeSessionId = options.resumeCursor?.resume;
    this.startedFromCursor = options.resumeCursor?.resume !== undefined;
    this.resumeSessionAt = options.resumeCursor?.resumeSessionAt;
    if (options.resumeCursor?.turnStartMessageIds !== undefined) {
      this.normalizer.turnStartMessageIds.push(...options.resumeCursor.turnStartMessageIds);
    }
    this.normalizer.turnBoundaries.push(...claudeTurnBoundariesFromCursor(options.resumeCursor));
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
    // Recomputed, not handed out as last recorded: Claude's session id moves
    // whenever the SDK re-inits (a compaction forks it) and every turn adds a
    // start message id, but nothing writes `record.resumeCursor` between
    // `sendTurn` calls. The host reads this on `turn.completed` to persist the
    // new native boundary for a turn it did not dispatch itself — a background
    // turn has no `sendTurn` result at all (*T3: `ProviderService.ts:1104-1129`*).
    const cursor = this.currentCursor();
    return { ...this.record, ...(cursor !== undefined ? { resumeCursor: cursor } : {}) };
  }

  get isAlive(): boolean {
    return !this.closed;
  }

  get activeTurnId(): string | undefined {
    return this.normalizer.turnState?.turnId;
  }

  /**
   * The goal this session last reported — what the host's fold now holds, and
   * so the `knownGoal` a restart of this thread must compare against (goals §6).
   */
  get trackedGoal(): AgentGoal | null {
    return this.normalizer.goals.lastEmitted;
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
    //
    // The `.catch` is load-bearing: `runStream` guards the `for await` and each
    // `handleMessage`, but not the trailing `handleStreamEnd`, and the host
    // installs no `unhandledRejection` handler — so a throw there would end the
    // whole long-lived host and every other thread's session with it.
    this.streamDone = this.runStream().catch((error: unknown) => {
      this.options.context.logger.error(
        `claude: the message loop for thread ${this.threadId} failed`,
        error
      );
    });

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
    this.reconcileGoalOnStart();
    // The meter's denominator used to arrive only with the FIRST `result`
    // (`modelUsage[*].contextWindow`), so the opening turn of every session
    // showed a bare token count and no percentage. Asking the CLI once the
    // handshake is done fixes that, and it is never awaited: readiness must
    // not wait on a display refresh.
    void this.refreshContextUsage(undefined);
    return this.session;
  }

  /**
   * Ask the CLI for its own `/context` accounting and fold the answer into the
   * meter (§7.6).
   *
   * Deliberately best-effort in every direction: an older CLI rejects the
   * control request, an SDK that predates it has no method at all, and a busy
   * one may not answer inside the deadline. None of those is a turn failure
   * and none of them earns a `runtime.warning` row — the meter simply keeps
   * the last reading the stream produced. One debug line per session says so,
   * so a host that never gets an answer is diagnosable without being noisy.
   */
  private async refreshContextUsage(turnId: string | undefined): Promise<void> {
    const query = this.query;
    if (query === undefined || this.closed) {
      return;
    }
    let response: unknown;
    try {
      response = await withDeadline(query.getContextUsage({ detail: "summary" }), {
        label: "claude/context-usage",
        timeoutMs: this.options.deps.deadlines.contextUsageMs
      });
    } catch (error) {
      if (!this.contextUsageUnavailableLogged) {
        this.contextUsageUnavailableLogged = true;
        this.options.context.logger.debug(
          "claude: the context-usage control request is unavailable on this CLI",
          { threadId: this.threadId, error: errorMessage(error) }
        );
      }
      return;
    }
    if (this.closed) {
      return;
    }
    this.emit(this.normalizer.applyContextUsage(response, turnId));
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
        // A shell's last lines are written before its completion frame, but the
        // poll that would read them is 750 ms away. Drain here, BEFORE the
        // frame is normalised: `item.completed` is where ingestion closes the
        // item's tool-output buffer, so anything emitted after it is lost.
        const settling = backgroundShellSettlingTaskId(message);
        if (settling !== undefined) {
          await this.drainBackgroundShell(settling);
        }
        // The two moments the window genuinely moved: a turn just ended, and a
        // compaction just rewrote the transcript. The turn id is read BEFORE
        // the frame settles the turn, so the refresh's answer — which lands
        // after an await — is attributed to the turn it was asked for and
        // never to a turn the user started in the meantime.
        const refreshesContextWindow = movesContextWindow(message);
        const meterTurnId = refreshesContextWindow
          ? this.normalizer.turnState?.turnId
          : undefined;
        // A goal's met / impossible verdict is written to the transcript at
        // the turn end and nowhere else (goals §6.1.4). Read after the frame,
        // so the turn's own events are out first, and against the turn that
        // ended — read before the frame settles it.
        const endsTurn = (message as { type?: unknown }).type === "result";
        const endingTurnId = endsTurn ? this.normalizer.turnState?.turnId : undefined;
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
        if (refreshesContextWindow) {
          // The boundary's own `post_tokens` row has already gone out above;
          // this refines it with the CLI's own accounting a moment later, and
          // never blocks the loop.
          void this.refreshContextUsage(meterTurnId);
        }
        if (endsTurn) {
          this.checkGoalTranscript({
            atTurnEnd: true,
            ...(endingTurnId !== undefined ? { turnId: endingTurnId } : {})
          });
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

  // -------------------------------------------------------------------------
  // Background shells (§4.5)
  // -------------------------------------------------------------------------

  private onBackgroundShell(change: BackgroundShellChange): void {
    if (change.kind === "stop") {
      this.stopBackgroundShell(change.taskId);
      return;
    }
    if (this.closed || this.backgroundShells.has(change.taskId)) {
      return;
    }
    // The CLI abbreviates the path against ITS home, which is the managed
    // account home this session launched with — not the daemon user's.
    const path = resolveTildePath(
      change.outputFile,
      this.options.env.HOME ?? this.options.env.USERPROFILE ?? homedir()
    );
    const entry: BackgroundShellTail = {
      tail: new FileTail({ path }),
      timer: undefined,
      stopped: false
    };
    this.backgroundShells.set(change.taskId, entry);
    this.scheduleBackgroundShellPoll(change.taskId, entry);
  }

  private scheduleBackgroundShellPoll(taskId: string, entry: BackgroundShellTail): void {
    if (entry.stopped || this.closed) {
      return;
    }
    entry.timer = this.options.deps.setTimer(() => {
      entry.timer = undefined;
      this.pollBackgroundShell(taskId).catch((error: unknown) => {
        // The host installs no `unhandledRejection` handler; a throw from a
        // timer callback would take it down.
        this.options.context.logger.error("claude: a background-shell tail failed", error);
      });
    }, BACKGROUND_SHELL_TAIL_INTERVAL_MS);
  }

  private async pollBackgroundShell(taskId: string): Promise<void> {
    const entry = this.backgroundShells.get(taskId);
    if (entry === undefined || entry.stopped || this.closed) {
      return;
    }
    const done = await this.readBackgroundShell(taskId, entry);
    if (done) {
      this.stopBackgroundShell(taskId);
      return;
    }
    this.scheduleBackgroundShellPoll(taskId, entry);
  }

  /** One bounded read, emitted as a delta. Answers "is this tail over?". */
  private async readBackgroundShell(
    taskId: string,
    entry: BackgroundShellTail
  ): Promise<boolean> {
    let result: { text: string; done: boolean };
    try {
      result = await withDeadline(entry.tail.read(), {
        label: "claude/background-shell-tail",
        timeoutMs: BACKGROUND_SHELL_TAIL_READ_DEADLINE_MS
      });
    } catch (error) {
      this.options.context.logger.warn(
        `claude: reading a background shell's output timed out: ${errorMessage(error)}`
      );
      return true;
    }
    if (result.text.length > 0) {
      this.emit(this.normalizer.backgroundShellOutput(taskId, result.text));
    }
    return result.done;
  }

  /**
   * Read whatever is left before a shell's completion frame is normalised.
   * Bounded twice: by the tail's own per-shell cap and by an explicit read
   * count, so a file being appended to as fast as we read cannot hold the
   * message loop open.
   */
  private async drainBackgroundShell(taskId: string): Promise<void> {
    const entry = this.backgroundShells.get(taskId);
    if (entry === undefined || entry.stopped) {
      return;
    }
    if (entry.timer !== undefined) {
      this.options.deps.clearTimer(entry.timer);
      entry.timer = undefined;
    }
    for (let read = 0; read < BACKGROUND_SHELL_DRAIN_MAX_READS; read += 1) {
      const before = entry.tail.bytesRead;
      const done = await this.readBackgroundShell(taskId, entry);
      if (done || entry.tail.bytesRead === before) {
        break;
      }
    }
    this.stopBackgroundShell(taskId);
  }

  private stopBackgroundShell(taskId: string): void {
    const entry = this.backgroundShells.get(taskId);
    if (entry === undefined) {
      return;
    }
    entry.stopped = true;
    if (entry.timer !== undefined) {
      this.options.deps.clearTimer(entry.timer);
      entry.timer = undefined;
    }
    this.backgroundShells.delete(taskId);
  }

  private stopAllBackgroundShells(): void {
    for (const taskId of [...this.backgroundShells.keys()]) {
      this.stopBackgroundShell(taskId);
    }
  }

  // -------------------------------------------------------------------------
  // Goals: what only the transcript knows (goals §6.1.4-5)
  // -------------------------------------------------------------------------

  /** The CLI session whose transcript is current: a fork or a re-init moves it. */
  private transcriptSessionId(): string | undefined {
    return this.normalizer.providerSessionId ?? this.resumeSessionId;
  }

  /**
   * `--resume` re-arms whatever goal the transcript's last `goal_status` row
   * left running, and says nothing about it: compare that with the thread's
   * goal once, now (goals §6.1.5). A new CLI session holds no goal at all, so
   * a thread goal that a fresh start meets — a rewind to the very start, a
   * lost cursor — is over.
   */
  private reconcileGoalOnStart(): void {
    if (!this.startedFromCursor) {
      this.emit(this.normalizer.reconcileTranscriptGoal({ kind: "none" }));
      return;
    }
    const sessionId = this.transcriptSessionId();
    if (sessionId === undefined) {
      return;
    }
    const epoch = this.normalizer.goalEpoch;
    this.queueGoalWork({
      label: "restore",
      timeoutMs: GOAL_TRANSCRIPT_SCAN_DEADLINE_MS,
      read: () => this.goalTranscript.readLast(sessionId),
      apply: (found) => {
        if (found === undefined) {
          if (isUnfinishedGoal(this.normalizer.goals.goal)) {
            this.options.context.logger.debug(
              `claude: the resumed transcript of thread ${this.threadId} is not there; its goal is left as the thread shows it`,
              { sessionId }
            );
          }
          return [];
        }
        return this.normalizer.reconcileTranscriptGoal(transcriptGoalFromLastRow(found.row), {
          epoch
        });
      }
    });
    // A scan that failed or ran out of time placed nothing: reads then start
    // at the tail, never at the first byte, where an earlier run of the same
    // goal may have been met. After a good scan this keeps its position.
    this.queueGoalWork({
      label: "tail",
      timeoutMs: GOAL_TRANSCRIPT_READ_DEADLINE_MS,
      read: () => this.goalTranscript.anchorAtTail(sessionId),
      apply: () => []
    });
  }

  /**
   * Read what the transcript gained since the last read, after a `result`
   * (`atTurnEnd`) or an `active_goal: null`, while a goal is running (goals
   * §6.1.4, §6.1.6). Whether background work was live, and which goal run
   * this is, are taken NOW: by the time the read lands a task may have
   * finished and the next goal may have been set.
   */
  private checkGoalTranscript(input: { atTurnEnd: boolean; turnId?: string }): void {
    // A new walk reads on from where the last one stopped, so it supersedes a
    // re-read still pending for an earlier turn end.
    this.cancelVerdictReread();
    if (this.closed || !isUnfinishedGoal(this.normalizer.goals.goal)) {
      return;
    }
    const backgroundLive = this.normalizer.liveTasks().size > 0;
    this.queueTranscriptWalk({
      sessionId: this.transcriptSessionId(),
      ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
      atTurnEnd: input.atTurnEnd,
      backgroundLive,
      epoch: this.normalizer.goalEpoch,
      reread: 0,
      // With background work live the CLI skipped the evaluation: no verdict
      // is coming for this turn end.
      awaitsVerdict: input.atTurnEnd && !backgroundLive
    });
  }

  /**
   * Walks run ONE at a time, in the order they were asked for. A walk queues
   * its next chunk only once its current one has landed, so two turn ends
   * close together used to interleave on the goal chain — the first walk's
   * next chunk behind the second walk's first — and a row one walk read was
   * stamped with the OTHER turn's id, and the older walk's final phase could
   * land after the newer one's.
   */
  private queueTranscriptWalk(walk: TranscriptWalk): void {
    if (this.transcriptWalking) {
      this.transcriptWalksWaiting.push(walk);
      return;
    }
    this.transcriptWalking = true;
    this.queueTranscriptChunk(walk);
  }

  /**
   * A walk is over: start the next one asked for — which reads on from here,
   * so it supersedes any re-read of this one — or, with none waiting, re-read
   * later for a verdict this walk did not find yet.
   */
  private transcriptWalkEnded(walk: TranscriptWalk): void {
    const next = this.transcriptWalksWaiting.shift();
    if (next !== undefined) {
      this.queueTranscriptChunk(next);
      return;
    }
    this.transcriptWalking = false;
    this.scheduleVerdictReread(walk);
  }

  /**
   * Read the transcript again after the next of
   * {@link GOAL_VERDICT_REREAD_DELAYS_MS}, for a verdict the CLI had not
   * written yet when `walk` looked (goals §6.1.4). Bounded, and only while it
   * can still come: the goal is unfinished, the walk's epoch still current
   * (no stdout goal news since), and the turn end evaluated at all. The walk
   * the re-read queues is stamped with the turn that ended, judges no phase
   * (the turn end already did), and goes through the same serialised walks.
   */
  private scheduleVerdictReread(walk: TranscriptWalk): void {
    const delay = GOAL_VERDICT_REREAD_DELAYS_MS[walk.reread];
    if (
      delay === undefined ||
      !walk.awaitsVerdict ||
      this.closed ||
      walk.epoch !== this.normalizer.goalEpoch ||
      !isUnfinishedGoal(this.normalizer.goals.goal)
    ) {
      return;
    }
    this.cancelVerdictReread();
    const timer = this.options.deps.setTimer(() => {
      if (this.verdictRereadTimer !== timer) {
        // Superseded — a new walk, a new turn, or the teardown — after this
        // timer had already been handed to the loop.
        return;
      }
      this.verdictRereadTimer = undefined;
      if (
        this.closed ||
        walk.epoch !== this.normalizer.goalEpoch ||
        !isUnfinishedGoal(this.normalizer.goals.goal)
      ) {
        return;
      }
      this.queueTranscriptWalk({ ...walk, atTurnEnd: false, reread: walk.reread + 1 });
    }, delay);
    this.verdictRereadTimer = timer;
  }

  private cancelVerdictReread(): void {
    if (this.verdictRereadTimer !== undefined) {
      this.options.deps.clearTimer(this.verdictRereadTimer);
      this.verdictRereadTimer = undefined;
    }
  }

  /**
   * One chunk of a transcript walk (goals §6.1.4) — one `read()`, its position
   * committed and its rows applied together — and the next chunk queued
   * behind it while the transcript has more. Each chunk is its own bounded
   * step, so a delta too big for one deadline still finishes. The turn-end
   * phase is judged once, after the last chunk: "still unmet" needs every
   * row. A goal (re)started meanwhile ends the walk (its epoch moved), and so
   * does a chunk that could not be read: the next turn end reads on from the
   * last position committed.
   *
   * A walk whose epoch has moved by the time a chunk STARTS ends without
   * reading at all: the rows it would consume belong to what came after that
   * stdout news, and a read it then discarded would commit their position —
   * the next walk would never see them.
   */
  private queueTranscriptChunk(walk: TranscriptWalk): void {
    const { sessionId } = walk;
    let continued = false;
    this.queueGoalWork({
      label: "read",
      timeoutMs: GOAL_TRANSCRIPT_READ_DEADLINE_MS,
      read: () => {
        if (walk.epoch !== this.normalizer.goalEpoch) {
          return Promise.resolve(null);
        }
        return sessionId === undefined
          ? Promise.resolve(undefined)
          : this.goalTranscript.readNew(sessionId);
      },
      apply: (chunk) => {
        if (chunk === null) {
          // Stale: ended without reading, nothing consumed.
          return [];
        }
        if (chunk === undefined) {
          this.options.context.logger.debug(
            `claude: no transcript to read the goal of thread ${this.threadId} from`,
            { sessionId }
          );
        }
        const more = chunk?.more === true && walk.epoch === this.normalizer.goalEpoch;
        // Without the file the verdict is unknown, but the phase is not: with
        // background work live the CLI did not evaluate at all.
        const events = this.normalizer.applyGoalTranscriptRows(chunk?.rows ?? [], {
          ...(walk.turnId !== undefined ? { turnId: walk.turnId } : {}),
          backgroundLive: walk.backgroundLive,
          atTurnEnd: walk.atTurnEnd && !more,
          epoch: walk.epoch
        });
        if (more) {
          continued = true;
          this.queueTranscriptChunk(walk);
        }
        return events;
      },
      settled: () => {
        if (!continued) {
          this.transcriptWalkEnded(walk);
        }
      }
    });
  }

  /** A goal (re)started: judge it by rows written from here on (goals §6.1.4). */
  private markGoalSetPoint(): void {
    const sessionId = this.transcriptSessionId();
    if (this.closed || sessionId === undefined) {
      return;
    }
    this.queueGoalWork({
      label: "set-point",
      timeoutMs: GOAL_TRANSCRIPT_READ_DEADLINE_MS,
      read: () => this.goalTranscript.markSetPoint(sessionId),
      apply: () => []
    });
  }

  /**
   * One piece of goal transcript work, after every piece before it. The read
   * is bounded; the normaliser is only touched once it has landed, so a read
   * that outlived its deadline changes nothing (and moves no read position:
   * `abandonPending`). A failure is a debug line, never an error (§6.1.4).
   */
  private queueGoalWork<T>(work: {
    label: string;
    timeoutMs: number;
    read: () => Promise<T>;
    apply: (result: T) => RuntimeEvent[];
    /** Runs last, whatever happened: applied, failed, timed out or skipped. */
    settled?: () => void;
  }): void {
    this.goalWorkPending += 1;
    this.goalWork = this.goalWork.then(async () => {
      try {
        if (!this.goalOutputOpen) {
          return;
        }
        // A test parks a read here; production passes no gate.
        await this.options.deps.goalReadGate?.(this.threadId, work.label);
        let result: T;
        try {
          result = await withDeadline(work.read, {
            label: `claude/goal/${work.label}`,
            timeoutMs: work.timeoutMs,
            onTimeout: () => this.goalTranscript.abandonPending()
          });
        } catch (error) {
          this.options.context.logger.debug(
            `claude: the goal transcript ${work.label} for thread ${this.threadId} failed`,
            { error: errorMessage(error) }
          );
          return;
        }
        if (this.goalOutputOpen) {
          this.emit(work.apply(result));
        }
      } catch (error) {
        // The chain must never reject: every later read hangs off it.
        this.options.context.logger.error(
          `claude: applying the goal transcript ${work.label} for thread ${this.threadId} failed`,
          error
        );
      } finally {
        try {
          work.settled?.();
        } catch (error) {
          this.options.context.logger.error(
            `claude: settling the goal transcript ${work.label} for thread ${this.threadId} failed`,
            error
          );
        }
        this.goalWorkPending -= 1;
        if (this.goalWorkPending === 0) {
          try {
            this.options.deps.onGoalWorkIdle?.(this.threadId);
          } catch (error) {
            // A test hook; a throw from it must not reject the chain every
            // later goal read hangs off.
            this.options.context.logger.error(
              `claude: the goal-work idle hook for thread ${this.threadId} threw`,
              error
            );
          }
        }
      }
    });
  }

  private scheduleGoalFlush(dueAtMs: number): void {
    if (this.closed || this.goalFlushTimer !== undefined) {
      return;
    }
    const delay = Math.max(0, dueAtMs - this.options.context.clock.now().getTime());
    this.goalFlushTimer = this.options.deps.setTimer(() => {
      this.goalFlushTimer = undefined;
      if (this.closed || !this.goalOutputOpen) {
        return;
      }
      const due = this.normalizer.goals.pendingProgressDueAtMs;
      if (due !== undefined && due > this.options.context.clock.now().getTime()) {
        // The window moved on since this timer was set: wait for its end.
        this.scheduleGoalFlush(due);
        return;
      }
      this.emit(this.normalizer.flushGoalProgress());
    }, delay);
  }

  /**
   * Let goal work already under way land before `session.exited` does —
   * ALL of it: a walk queues its next chunk only when the last one lands,
   * so the chain grows while it is being awaited, and the verdict of a goal
   * run (well over 1 MiB of transcript since its set point) sits in the
   * walk's LAST chunk. The chain is re-awaited until it stops changing, all
   * within one budget; nothing new is queued meanwhile (the session is
   * closed), only the rest of walks begun before the stop.
   */
  private async settleGoalWork(): Promise<void> {
    const deadline = performance.now() + GOAL_WORK_SETTLE_DEADLINE_MS;
    for (;;) {
      const work = this.goalWork;
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        return;
      }
      try {
        await withDeadline(work, { label: "claude/goal/settle", timeoutMs: remaining });
      } catch {
        // A read stuck past its own deadline and this one never holds a stop.
        return;
      }
      if (this.goalWork === work) {
        return;
      }
    }
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
   *
   * ONE teardown per session, and every caller waits for all of it: a second
   * call joins the first. Teardown awaits the goal reads in flight (goals
   * §6.1.4), so between `closed` and `session.exited` there is time — and a
   * replacement session started in that gap had the old `session.exited`
   * land after its own events (the host unbound a live thread on it) and the
   * old `onClosed` overwrite the new start record. {@link untilClosed} is how
   * the adapter waits the gap out before it starts anything.
   */
  teardown(input: {
    reason: string;
    status: "stopped" | "error";
    exitKind: "graceful" | "error";
    recoverable: boolean;
    turnState?: "interrupted" | "failed";
    turnError?: string;
    emitExit?: boolean;
  }): Promise<void> {
    if (this.teardownDone !== undefined) {
      return this.teardownDone;
    }
    if (this.closed) {
      // Closed without a teardown: the spawn failure in `start`, which emits
      // its own `session.exited` and runs `onClosed` synchronously.
      return Promise.resolve();
    }
    // Never a rejection: a caller waiting to start this thread's next session
    // would be stuck on it for good (`runTeardown` guards every step anyway).
    this.teardownDone = this.runTeardown(input).catch((error: unknown) => {
      this.options.context.logger.error(
        `claude: the teardown of thread ${this.threadId} failed`,
        error
      );
    });
    return this.teardownDone;
  }

  /**
   * Resolves once this session has fully exited — `session.exited` emitted and
   * `onClosed` run — or at once for a session that is not closing. Nothing may
   * start this thread's next session before it resolves. Never rejects.
   */
  untilClosed(): Promise<void> {
    return this.teardownDone ?? Promise.resolve();
  }

  private async runTeardown(input: {
    reason: string;
    status: "stopped" | "error";
    exitKind: "graceful" | "error";
    recoverable: boolean;
    turnState?: "interrupted" | "failed";
    turnError?: string;
    emitExit?: boolean;
  }): Promise<void> {
    // Synchronous up to the first await: `closed` is set before `teardown`
    // returns its promise.
    this.closed = true;
    // Every step is guarded: one that throws (a normaliser bug, a callback) is
    // logged and the rest still runs. A teardown that stopped half-way left a
    // session that never exited, an `onClosed` that never ran, and a thread no
    // later turn could restart.
    const step = (label: string, run: () => void): void => {
      try {
        run();
      } catch (error) {
        this.options.context.logger.error(
          `claude: the teardown of thread ${this.threadId} failed at ${label}; carrying on`,
          error
        );
      }
    };
    try {
      step("the watchdog", () => {
        this.clearWatchdog();
        if (this.goalFlushTimer !== undefined) {
          this.options.deps.clearTimer(this.goalFlushTimer);
          this.goalFlushTimer = undefined;
        }
        this.cancelVerdictReread();
      });

      step("pending requests", () => this.emit(this.cancelPendingRequests()));
      // Nothing is tailed past the session: `closeLiveTasks` below closes each
      // shell's item, and a poll that outlived its session would emit into a
      // thread whose turn is already settled.
      step("background shells", () => this.stopAllBackgroundShells());
      step("the query", () => this.closeQuery());
      step("the prompt queue", () => this.promptQueue.close());

      step("live tasks", () => this.emit(this.normalizer.closeLiveTasks()));
      step("the turn", () => {
        if (this.normalizer.turnState) {
          this.emit(
            this.normalizer.completeTurn(
              input.turnState ?? "interrupted",
              input.turnError ?? input.reason
            )
          );
        }
      });
      step("the turn waiters", () => this.turnSettled?.resolve());

      step("the session record", () => {
        this.record = {
          ...this.record,
          status: input.status,
          activeTurnId: undefined,
          updatedAt: this.options.context.clock.nowIso(),
          ...(input.status === "error" ? { lastError: input.reason } : {})
        };
      });

      // A goal met at the turn end that just settled is only in the
      // transcript; a stop right behind that `result` must not lose it
      // (goals §6.1.4). Bounded, never rejects, after the turn's own events.
      await this.settleGoalWork();
      // The background work a `waiting-background` goal waited on dies with
      // this process, and a throttled `progress` has no timer left to flush it
      // (goals §6): both go out now, still before `session.exited`.
      step("the goal", () => this.emit(this.normalizer.goalAtSessionEnd()));
      this.goalOutputOpen = false;

      step("session.exited", () => {
        if (input.emitExit !== false) {
          this.emit([
            this.normalizer.sessionExited({
              reason: input.reason,
              recoverable: input.recoverable,
              exitKind: input.exitKind
            })
          ]);
        }
      });
    } finally {
      this.goalOutputOpen = false;
      step("onClosed", () => this.options.onClosed(this));
    }
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

    const route = claudeCanUseToolRoute(toolName);
    if (route === "user-input") {
      return this.handleAskUserQuestion(toolInput, callbackOptions);
    }

    if (route === "proposed-plan") {
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

    const requestId = claudeRequestKey(callbackOptions.requestId, () =>
      this.options.context.ids.uuid()
    );
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

    const requestId = claudeRequestKey(callbackOptions.requestId, () =>
      this.options.context.ids.uuid()
    );
    const open = this.pendingUserInputs.get(requestId);
    if (open !== undefined) {
      // Idempotent per request id, like the approval path: the SDK redelivers a
      // request whose response was lost in a transport gap, and overwriting the
      // map entry would park the first control request forever (nothing could
      // reach its deferred any more) and open a second question card.
      return new Promise<PermissionResult>((resolve) => {
        const previous = open.settle;
        open.settle = (answers) => {
          previous(answers);
          resolve(
            answers === null
              ? { behavior: "deny", message: "User cancelled tool execution." }
              : { behavior: "allow", updatedInput: buildAskUserQuestionReply(toolInput, answers) }
          );
        };
      });
    }

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
      // `null`, never `{behavior: "cancelled"}`. The SDK's contract is explicit:
      // a host that receives a kind it did not declare MUST NOT answer it —
      // `cancelled` is a real settlement, read as the user dismissing the
      // dialog, and in a multi-client session that would dismiss it for
      // everyone. Returning `null` leaves it pending for a host that declared
      // it.
      return null;
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
      // A new turn supersedes a verdict re-read still pending for the last
      // one: its own turn end walks the transcript on from there.
      this.cancelVerdictReread();
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
    const settled = this.turnSettled;
    if (settled === undefined) {
      return;
    }
    // Bounded like every other wait on a child (§3.1). A `/compact` whose CLI
    // keeps streaming status frames but never emits a terminal `result` would
    // otherwise leave the host's `compacting` latch set forever, and every
    // message the user sent afterwards would queue silently with no error and
    // no recovery short of restarting the host.
    await withDeadline(settled.promise, {
      label: "claude/compact",
      timeoutMs: this.options.deps.deadlines.compactMs,
      onTimeout: () => {
        this.emit([
          this.normalizer.warning(
            "Claude did not finish compacting in time; the compaction was abandoned."
          )
        ]);
      }
    });
  }

  /**
   * Interrupt has **two** scopes.
   *
   * §4.1, turn-scoped: an interrupt that NAMES a turn is a no-op when that turn
   * is no longer the active one, so a Stop that races a settling turn cannot
   * kill the next one.
   *
   * §6.2, session-scoped: *"`/interrupt` is also the only way to stop
   * background work, and it stops all of it. It is addressed to the session,
   * not to a turn, so it is **valid with no turn running**"*. The client omits
   * `turnId` whenever the session is not `running`, and this must then kill
   * every live subagent, background shell and watch loop. Returning early here
   * left the fleet running and the client's "Stopping…" latch set forever,
   * because `backgroundLiveness` never dropped to `null`.
   *
   * T3 does the same by construction: its `interruptTurn` **is**
   * `stopSessionInternal` (`ClaudeAdapter.ts:5289-5297`), i.e. unconditional.
   */
  /**
   * The user's Ctrl+B: move the running foreground call(s) to the background.
   * The CLI answers each blocked tool call with a "running in the background"
   * result and the turn continues; the task then shows up in
   * `background_tasks_changed` / `task_started` (`local_bash`) and the roster
   * lists it as a background row. Nothing to move resolves `false`.
   */
  async backgroundTasks(toolUseId?: string): Promise<boolean> {
    if (this.closed || this.query === undefined) {
      throw new Error("No live Claude session to background work in.");
    }
    if (this.normalizer.turnState === undefined) {
      return false;
    }
    return (await withDeadline(this.query.backgroundTasks(toolUseId), {
      label: "claude/background_tasks",
      timeoutMs: this.options.deps.deadlines.cancelMs
    })) as boolean;
  }

  async interruptTurn(turnId?: string): Promise<void> {
    if (this.closed) {
      return;
    }
    const active = this.normalizer.turnState?.turnId;
    if (turnId !== undefined && turnId !== active) {
      // Named a turn that is no longer running: deliberately nothing.
      return;
    }
    if (active === undefined) {
      // Session-scoped Stop with no running turn. The CLI keeps subagents,
      // background shells and watch loops alive inside its own process after a
      // turn settles, and closing the query is the only thing that reaches
      // them — `teardown` closes every live task `stopped` on the way out, so
      // the roster and the liveness registry clear.
      await this.stop("Stop: background work stopped.");
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

  /**
   * A host-initiated stop: the process really does go away. On a session
   * already closing (its stream ended, a watchdog fired, another stop) it
   * waits for that teardown instead: "stopped" means FULLY exited, because the
   * caller may be about to start this thread's next session.
   */
  async stop(reason = "Session stopped."): Promise<void> {
    if (this.closed) {
      await this.untilClosed();
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
    // stops and immediately restarts cannot race two loops on one thread. The
    // timer is CLEARED when the loop wins — `support/deadline.ts` deliberately
    // does not unref, so a leaked one per stop would hold the event loop open
    // and delay the drain-restart the shutdown design depends on.
    let timer: NodeJS.Timeout | number | undefined;
    const guard = new Promise<void>((resolve) => {
      timer = this.options.deps.setTimer(resolve, this.options.deps.deadlines.cancelMs);
    });
    try {
      await Promise.race([this.streamDone ?? Promise.resolve(), guard]);
    } finally {
      if (timer !== undefined) {
        this.options.deps.clearTimer(timer);
      }
    }
  }

  /**
   * The thread as the PROVIDER holds it (§4.1).
   *
   * A live session has its turns in memory. A **resumed** one does not: a
   * resume replays nothing onto the message stream, so the in-memory turns are
   * empty while the CLI holds the whole conversation. That case reads the
   * native transcript out-of-band and groups it into turns, which is what
   * `projectHistory` then turns into a timeline.
   *
   * Best-effort by construction: a transcript that cannot be read answers with
   * an empty snapshot rather than failing the read.
   */
  async readThread(): Promise<ThreadSnapshot> {
    if (this.normalizer.turns.length > 0) {
      return {
        threadId: this.threadId,
        turns: this.normalizer.turns.map((turn) => ({ id: turn.id, items: [...turn.items] }))
      };
    }
    const sessionId = this.resumeSessionId;
    // Only a RESUMED session has history the stream never showed us. A session
    // started fresh has written nothing yet, so reading it would spawn a
    // worker for a transcript that does not exist.
    if (sessionId === undefined || !this.startedFromCursor) {
      return { threadId: this.threadId, turns: [] };
    }
    try {
      const messages = await createClaudeHistoryReader({
        env: this.options.env,
        cwd: this.options.cwd,
        hostConfigDir: this.options.deps.hostConfigDir,
        spawn: this.options.deps.spawn,
        nodePath: this.options.deps.nodePath
      }).readMessages({ sessionId, cwd: this.options.cwd });
      return { threadId: this.threadId, turns: groupClaudeHistoryTurns(messages) };
    } catch (error) {
      this.options.context.logger.warn(
        `claude: could not read the native history for thread ${this.threadId}`,
        error
      );
      return { threadId: this.threadId, turns: [] };
    }
  }

  // -------------------------------------------------------------------------
  // Rollback
  // -------------------------------------------------------------------------

  /**
   * Compute the fork for a rollback of `numTurns` and return the cursor the
   * restarted session must use. Throws the §4.5 refusal when the boundary
   * cannot be established — refuse rather than guess.
   *
   * With a `target` the cut is resolved from its turn ID and `numTurns` is only
   * compared against it ({@link planRollbackById}); without one — a caller that
   * predates `RollbackTarget` — the count path below runs as it always has.
   */
  async planRollback(numTurns: number, target?: RollbackTarget): Promise<{
    cursor: ClaudeResumeCursor | undefined;
    retainedTurns: Array<{ id: string; items: unknown[] }>;
  }> {
    const sessionId = this.resumeSessionId;
    if (sessionId === undefined) {
      throw new Error(ROLLBACK_SESSION_UNAVAILABLE);
    }
    if (target !== undefined) {
      return this.planRollbackById(sessionId, numTurns, target);
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
    // Sliced by the plan's OWN retained count, not by `turns.length - numTurns`:
    // `beginTurn` pushes a boundary while only `completeTurn` pushes a turn, so
    // during a live turn `turnStartMessageIds.length === turns.length + 1` and
    // the two disagreed by one — the restarted session was seeded with one turn
    // fewer than its cursor claimed, and every later rewind then targeted the
    // wrong boundary.
    const retainedTurns = this.normalizer.turns.slice(
      0,
      Math.min(plan.retainedCount, this.normalizer.turns.length)
    );

    if (plan.rollbackAt === undefined) {
      return { cursor: undefined, retainedTurns };
    }

    // A compaction between the anchor and now makes the anchor unreachable.
    // Checked BEFORE the fork, so a doomed rewind says why instead of creating
    // an orphan fork session on disk and then failing the deep-equal scan with
    // a misleading "did not preserve the retained turn boundaries" (§4.5 "or a
    // compaction in between", fixtures README obs. 17).
    if (
      !isAnchorReachableAfterCompaction({
        anchorUuid: plan.rollbackAt,
        preservedUuids: this.normalizer.preservedMessageUuids,
        messages
      })
    ) {
      throw new Error(ROLLBACK_COMPACTED);
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

  /**
   * The id path (§5.5, `RollbackTarget`). The host's `numTurns` is counted over
   * its own fold, and that is not the list this session's boundaries count: a
   * transcript resumed from the CLI has history turns no cursor recorded, and a
   * compaction writes rows shaped like turn starts that the host never counted.
   * A count-based cut then lands on the wrong turn WITHOUT refusing, so the id
   * decides and a disagreeing count is only logged.
   *
   * The ids are the fold's turn ids, which for Claude are transcript uuids — a
   * live turn's is the `SDKUserMessage.uuid` `sendTurn` stamps, a history
   * turn's is its human row's uuid — until a fork rewrites them; the recorded
   * pairs (`normalizer.turnBoundaries`) are what still resolve them then, and
   * every fork re-pairs the turns it keeps (`remapClaudeForkTurnBoundaries`).
   */
  private async planRollbackById(
    sessionId: string,
    numTurns: number,
    target: RollbackTarget
  ): Promise<{
    cursor: ClaudeResumeCursor | undefined;
    retainedTurns: Array<{ id: string; items: unknown[] }>;
  }> {
    const history = this.historyReader();
    const messages = await history.readMessages({ sessionId, cwd: this.options.cwd });
    // Everything that can refuse — an id the transcript cannot place, an
    // anchor a compaction dropped — refuses here, before any fork exists.
    const plan = planClaudeRollbackById({
      messages,
      boundaries: this.normalizer.turnBoundaries,
      firstRemovedTurnId: target.firstRemovedTurnId,
      preservedUuids: this.normalizer.preservedMessageUuids
    });
    if (plan.dropped.length !== numTurns) {
      this.options.context.logger.debug(
        `claude: the rewind of thread ${this.threadId} cuts at turn ${target.firstRemovedTurnId}, which drops ${plan.dropped.length} turn(s) of the native history; the host counted ${numTurns}. The id wins.`,
        {
          droppedHere: plan.dropped.map((boundary) => boundary.turnId),
          droppedByHost: target.droppedTurnIds
        }
      );
    }

    // Nothing of the conversation precedes the cut: a fresh session (§4.5).
    if (plan.rollbackAt === undefined) {
      return { cursor: undefined, retainedTurns: [] };
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
      plan.retained.map((boundary) => boundary.uuid)
    );
    if (!remapped) {
      throw new Error(ROLLBACK_FORK_MISALIGNED);
    }

    // The fork rewrote every uuid: each kept turn keeps its OWN id, paired with
    // its fork uuid, so it stays rewindable by id in the forked session.
    const retainedIds = new Set(plan.retained.map((boundary) => boundary.turnId));
    return {
      cursor: buildClaudeResumeCursor({
        threadId: this.threadId,
        sessionId: fork.sessionId,
        turnStartMessageIds: remapped,
        turnBoundaries: plan.retained.map((boundary, index) => ({
          turnId: boundary.turnId,
          uuid: remapped[index] ?? null
        }))
      }),
      retainedTurns: this.normalizer.turns.filter((turn) => retainedIds.has(turn.id))
    };
  }

  /** The native-history reader, under this thread's own config dir (§4.5). */
  private historyReader(): ClaudeHistoryReader {
    return createClaudeHistoryReader({
      env: this.options.env,
      cwd: this.options.cwd,
      hostConfigDir: this.options.deps.hostConfigDir,
      spawn: this.options.deps.spawn,
      nodePath: this.options.deps.nodePath
    });
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
    // The same directory the CLI reads its user-scope skills from. A system
    // home carries no CLAUDE_CONFIG_DIR, and its `home.path` is the daemon
    // user's home dir itself (`main.ts`; only the probe's system home has
    // `""`), so falling back to that path looked in `<home>/skills` rather
    // than `<home>/.claude/skills` and found none.
    const configDir = claudeConfigDir(this.options.env);
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
   * `/command` back to plain prose on every image-carrying turn. A non-image
   * attachment is a path line in the text, never a content block (§4.1, §4.5).
   */
  private async buildUserMessage(input: {
    text: string;
    attachments: readonly AttachmentRef[];
    skills: readonly Skill[];
  }): Promise<SDKUserMessage> {
    const content: Array<Record<string, unknown>> = [];
    const dispatch = planClaudeSkillDispatch(input.text, dispatchableSkillNames(input.skills));

    // Claude ingests images natively. Everything else reaches the agent as a
    // path line it can `Read` without an approval — the thread's attachments
    // dir is an `additionalDirectories` entry (`launch.ts`) — appended by
    // `appendAttachmentPathLines` (§4.1, §4.5), which skips a path the text
    // already names because the composer inserts it at upload time (§7.4).
    const imageBlocks: Array<Record<string, unknown>> = [];
    const pathLines: AttachmentPathLine[] = [];
    for (const attachment of input.attachments) {
      // Resolved for every ref, native or not: one that no longer resolves
      // fails the turn instead of vanishing from it (§4.1).
      const path = await this.options.context.resolveAttachmentPath(this.threadId, attachment.id);
      if (!claudeIngestsAttachment(attachment)) {
        pathLines.push({ name: attachment.name, path });
        continue;
      }
      const bytes = await fs.readFile(path);
      imageBlocks.push({
        type: "image",
        source: { type: "base64", media_type: attachment.mimeType, data: bytes.toString("base64") }
      });
    }

    if (dispatch) {
      // The command block must stay LAST and untouched (§4.5), so the path
      // lines ride the leading text block, created when the prose was empty,
      // while "already named" reads the whole prompt: a path typed after the
      // `$skill` mention lives in the command block.
      const leading = appendAttachmentPathLines(dispatch.leadingText ?? "", pathLines, input.text);
      if (leading.length > 0) {
        content.push({ type: "text", text: leading });
      }
      content.push(...imageBlocks);
      content.push({ type: "text", text: dispatch.commandText });
    } else {
      content.push(...imageBlocks);
      const text = appendAttachmentPathLines(input.text, pathLines);
      if (text.length > 0) {
        content.push({ type: "text", text });
      }
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
      turnStartMessageIds: this.normalizer.turnStartMessageIds,
      turnBoundaries: this.normalizer.turnBoundaries
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
    // No goal window here, on purpose (goals §5.2 widens only the host's
    // watchdog): a Claude goal turn ends whenever its evaluation is deferred,
    // so it is never silent for longer than an ordinary turn.
    const window = this.hasOpenTool
      ? TURN_LIVENESS_WINDOWS.activeToolMs
      : TURN_LIVENESS_WINDOWS.idleMs;
    this.watchdog = this.options.deps.setTimer(() => {
      this.checkLiveness().catch((error: unknown) => {
        // The host installs no `unhandledRejection` handler; a throw from a
        // timer callback would take it down.
        this.options.context.logger.error("claude: the liveness watchdog failed", error);
      });
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

/**
 * The task id whose tail must be drained before this frame is handed to the
 * normaliser: a completion notification, or a `task_updated` that settles the
 * task. Read off the raw frame rather than the normalised event, because the
 * drain has to happen BEFORE normalisation.
 */
function backgroundShellSettlingTaskId(message: SDKMessage): string | undefined {
  const frame = message as {
    type?: unknown;
    subtype?: unknown;
    task_id?: unknown;
    patch?: { status?: unknown };
  };
  if (frame.type !== "system" || typeof frame.task_id !== "string") {
    return undefined;
  }
  if (frame.subtype === "task_notification") {
    return frame.task_id;
  }
  if (frame.subtype === "task_updated") {
    const status = frame.patch?.status;
    return status === "completed" || status === "failed" || status === "killed"
      ? frame.task_id
      : undefined;
  }
  return undefined;
}

/**
 * The frames after which the context window has genuinely moved, and which
 * therefore earn an authoritative `getContextUsage` refresh: a settled turn
 * and a completed compaction. Everything else is covered by the stream's own
 * `message_delta` usage.
 */
function movesContextWindow(message: SDKMessage): boolean {
  const frame = message as { type?: unknown; subtype?: unknown };
  return (
    frame.type === "result" ||
    (frame.type === "system" && frame.subtype === "compact_boundary")
  );
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
