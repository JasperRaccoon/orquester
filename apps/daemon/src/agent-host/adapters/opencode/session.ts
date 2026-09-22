/**
 * Agent host — one OpenCode thread session (spec §4.1, §4.5 OpenCode).
 *
 * Ported from T3 Code (MIT):
 * `apps/server/src/provider/Layers/OpenCodeAdapter.ts` — session
 * create/resume/fork, `promptAsync`, the three completion machines, the
 * permission/question round-trips, interrupt with descendant abort, native
 * compaction and the fork-based rollback — translated from Effect into plain
 * promises.
 *
 * What lives here and not in `normalize.ts`: everything that needs I/O or a
 * deadline. The normaliser decodes a frame and hands back **signals**; this
 * class is what polls `GET /session/status`, replies to a permission, walks a
 * session's children, and kills a wedged turn.
 */

import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";

import type {
  ApprovalDecision,
  AttachmentRef,
  ModelSelection,
  ProviderSession,
  RuntimeEvent,
  RuntimeEventBase,
  RuntimeMode,
  ThreadSnapshot
} from "@orquester/api/agent-chat";

import type {
  AdapterContext,
  RollbackTarget,
  SendTurnInput,
  SendTurnResult
} from "../../adapter.ts";
import { AGENT_HOST_DEADLINES, withDeadline } from "../../support/deadline.ts";
import { OpenCodeHttpError, isOpenCodeNotFound, type OpenCodeClient } from "./http.ts";
import {
  NormalizerEmitter,
  closeLiveChildAgents,
  emitTerminalPermission,
  emitTerminalQuestion,
  hasLiveChildAgents,
  normalizeOpenCodeEvent,
  type NormalizeContext,
  type NormalizerSignal
} from "./normalize.ts";
import {
  asRawEvent,
  isRecord,
  type OpenCodePart,
  type OpenCodePermissionRequest,
  type OpenCodeQuestionRequest,
  type OpenCodeRawEvent,
  type OpenCodeSessionInfo
} from "./protocol.ts";
import {
  openCodeRoutes,
  type CreateSessionBody,
  type ForkBody,
  type OpenCodeCommandRow,
  type OpenCodeMessageWithParts,
  type OpenCodePartInput,
  type PromptAsyncBody,
  type SessionCommandBody,
  type SessionStatusMap,
  type SummarizeBody,
  type UpdateSessionBody
} from "./routes.ts";
import { buildOpenCodePermissionRules, toOpenCodePermissionReply } from "./ruleset.ts";
import type { OpenCodeServerHandle } from "./server.ts";
import { readSseFrames } from "./sse.ts";
import {
  createSessionState,
  makeTurnTokenUsageAccumulator,
  repointSession,
  takeTurnTokenUsage,
  type OpenCodeCancellation,
  type OpenCodeIdleReconciliation,
  type OpenCodePromptAdmission,
  type OpenCodeSessionState
} from "./state.ts";
import { Mutex, backoffMs, deferred, delay, forEachLimited } from "./util.ts";

// ---------------------------------------------------------------------------
// Constants §4.5 pins
// ---------------------------------------------------------------------------

/** The cursor shape; a wrong version or empty id means "no resume", never an error. */
export const OPENCODE_RESUME_VERSION = 1 as const;
/** `POST /session/{id}/summarize` is bounded at ten minutes. */
const COMPACTION_TIMEOUT_MS = 10 * 60_000;
/** The event stream must connect within this window after the session opens. */
const FIRST_CONNECTION_TIMEOUT_MS = 10_000;
/** Machine (3) hard-fails after this many attempts. */
const ADMISSION_MAX_ATTEMPTS = 5;
/** Ancestry retries for a terminal request frame. */
const ANCESTRY_TERMINAL_MAX_ATTEMPTS = 5;
/**
 * Ancestry retries for an `*.asked` frame. T3 retries these forever, which is
 * safe only with a per-thread server; ours is per project, so a co-tenant
 * thread's ask would otherwise poll for the session's whole life (§3.2).
 */
const ANCESTRY_ASKED_MAX_ATTEMPTS = 12;
/** OpenCode ingests these natively; anything else rides as a path in the prompt. */
const NATIVE_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const NATIVE_FILE_PART_MAX_BYTES = 20 * 1024 * 1024;

export interface OpenCodeResumeCursor {
  schemaVersion: typeof OPENCODE_RESUME_VERSION;
  sessionId: string;
}

export function parseOpenCodeResume(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  if (raw.schemaVersion !== OPENCODE_RESUME_VERSION) {
    return undefined;
  }
  if (typeof raw.sessionId !== "string" || raw.sessionId.trim().length === 0) {
    return undefined;
  }
  return { sessionId: raw.sessionId.trim() };
}

/** `msg_` + 48-bit sortable time + 14 random alnum — OpenCode's own shape. */
const MESSAGE_ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
let messageIdEpochMillis = -1;
let messageIdCounter = 0;

export function mintOpenCodeMessageId(nowMs = Date.now()): string {
  if (nowMs !== messageIdEpochMillis) {
    messageIdEpochMillis = nowMs;
    messageIdCounter = 0;
  }
  messageIdCounter += 1;
  const encodedTime = BigInt.asUintN(48, BigInt(nowMs) * 0x1000n + BigInt(messageIdCounter))
    .toString(16)
    .padStart(12, "0");
  const random = Array.from(
    randomBytes(14),
    (byte) => MESSAGE_ID_ALPHABET[byte % MESSAGE_ID_ALPHABET.length]
  ).join("");
  return `msg_${encodedTime}${random}`;
}

export interface ParsedModelSlug {
  providerID: string;
  modelID: string;
}

/** `"<providerID>/<modelID>"`; the model id itself may contain slashes. */
export function parseOpenCodeModelSlug(slug: string | undefined): ParsedModelSlug | null {
  const trimmed = slug?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    return null;
  }
  const separator = trimmed.indexOf("/");
  if (separator <= 0 || separator === trimmed.length - 1) {
    return null;
  }
  return {
    providerID: trimmed.slice(0, separator),
    modelID: trimmed.slice(separator + 1)
  };
}

export function selectedOption(
  selection: ModelSelection | undefined,
  id: string
): string | undefined {
  const value = selection?.options?.find((option) => option.id === id)?.value;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * The per-turn `system` addendum. `session.command` accepts none, so a native
 * slash command runs without it (§4.6.5) — that is a documented gap, not a bug.
 */
export function buildRuntimeInstructions(model: string): string {
  const single = model.replace(/\s+/g, " ").trim();
  const modelInfo = single.length > 0 && single !== "auto" ? `, as ${single}` : "";
  return `<runtime_info>In case you're asked: you are running inside Orquester's agent chat through the OpenCode harness${modelInfo}. No need to mention this otherwise. You can embed images in your response using Markdown with absolute file paths.</runtime_info>`;
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

export interface OpenCodeThreadSessionDeps {
  ctx: AdapterContext;
  emit: (event: RuntimeEvent) => void;
  /** Called exactly once, after `session.exited` has been emitted. */
  onClosed: (threadId: string) => void;
}

export interface StartOpenCodeSessionInput {
  threadId: string;
  cwd: string;
  title?: string;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  resumeCursor?: unknown;
  /**
   * `provider/model → limit.context` off the server's catalogue (§7.6). Passed
   * whole rather than as the one resolved number so an in-session model switch
   * re-points the meter's denominator without another HTTP read.
   */
  contextLimits?: ReadonlyMap<string, number>;
  server: OpenCodeServerHandle;
}

export class OpenCodeThreadSession {
  readonly state: OpenCodeSessionState;
  private readonly deps: OpenCodeThreadSessionDeps;
  private readonly server: OpenCodeServerHandle;
  private client: OpenCodeClient;
  private record: ProviderSession;
  private readonly promptLock = new Mutex();
  private readonly pumpAbort = new AbortController();
  private readonly firstConnection = deferred<void>();
  /** Resolves once `doStop` runs, so shared-promise listeners can detach. */
  private readonly closed$ = deferred<void>();
  private readonly ancestryAttempts = new Map<string, number>();
  private pumpConnections = 0;
  private closed = false;
  private closing: Promise<void> | undefined;
  private lastModelSlug: string;
  private readonly contextLimits: ReadonlyMap<string, number>;
  /**
   * A message id the fold may still name → the id that message carries in
   * the session this thread points at now. A rollback fork re-mints every
   * message id (fixtures README observation 17) while the fold keeps the ids
   * it saw, so a later rewind to a turn an earlier one kept must be
   * translated. Filled by `rememberFork`; in memory only, so after a host
   * restart such a rewind refuses rather than guesses.
   */
  private forkedMessageIds = new Map<string, string>();

  private constructor(input: {
    deps: OpenCodeThreadSessionDeps;
    server: OpenCodeServerHandle;
    client: OpenCodeClient;
    state: OpenCodeSessionState;
    record: ProviderSession;
    modelSlug: string;
    contextLimits: ReadonlyMap<string, number>;
  }) {
    this.deps = input.deps;
    this.server = input.server;
    this.client = input.client;
    this.state = input.state;
    this.record = input.record;
    this.lastModelSlug = input.modelSlug;
    this.contextLimits = input.contextLimits;
  }

  // -- lifecycle ----------------------------------------------------------

  /**
   * Resume re-adopts the upstream session id. Same directory ⇒ reuse in place
   * **and re-assert the ruleset** (a runtime-mode change would otherwise leave
   * the session on its original permissions); different directory ⇒ fork into
   * the requested one, which preserves history. Only a **structurally
   * confirmed 404** falls through to a fresh session (§4.5).
   */
  static async start(
    deps: OpenCodeThreadSessionDeps,
    input: StartOpenCodeSessionInput
  ): Promise<OpenCodeThreadSession> {
    const client = input.server.client(input.cwd);
    const ruleset = buildOpenCodePermissionRules(input.runtimeMode);
    const resume = parseOpenCodeResume(input.resumeCursor);

    let adopted: OpenCodeSessionInfo | undefined;
    if (resume !== undefined) {
      try {
        adopted = await client.get<OpenCodeSessionInfo>(openCodeRoutes.session(resume.sessionId), {
          timeoutMs: AGENT_HOST_DEADLINES.sessionOpenMs
        });
      } catch (error) {
        if (!isOpenCodeNotFound(error)) {
          throw error;
        }
        deps.ctx.logger.warn("opencode resume session is gone; starting fresh", {
          threadId: input.threadId,
          sessionId: resume.sessionId
        });
      }
    }

    let sessionInfo: OpenCodeSessionInfo;
    let resumed = false;
    if (adopted !== undefined && sameDirectory(adopted.directory, input.cwd)) {
      await client.patch<unknown>(openCodeRoutes.session(adopted.id), {
        timeoutMs: AGENT_HOST_DEADLINES.sessionOpenMs,
        body: { permission: ruleset } satisfies UpdateSessionBody
      });
      sessionInfo = adopted;
      resumed = true;
    } else if (adopted !== undefined) {
      // The thread moved (a worktree, a renamed project). Fork into the
      // requested directory rather than minting an empty session — the fork
      // carries the full history. NOTE (fixtures README observation 17): a
      // fork RE-MINTS every message id, so nothing the host persisted that
      // points at an upstream message id survives this.
      deps.ctx.logger.info("opencode session was created under another directory; forking", {
        threadId: input.threadId,
        from: adopted.directory,
        to: input.cwd
      });
      const forked = await client.post<OpenCodeSessionInfo>(openCodeRoutes.fork(adopted.id), {
        timeoutMs: AGENT_HOST_DEADLINES.sessionOpenMs,
        body: { directory: input.cwd } satisfies ForkBody
      });
      if (forked === undefined || typeof forked.id !== "string") {
        throw new Error("OpenCode session fork returned no session payload.");
      }
      await client.patch<unknown>(openCodeRoutes.session(forked.id), {
        timeoutMs: AGENT_HOST_DEADLINES.sessionOpenMs,
        body: { permission: ruleset } satisfies UpdateSessionBody
      });
      sessionInfo = forked;
    } else {
      const created = await client.post<OpenCodeSessionInfo>(openCodeRoutes.sessions, {
        timeoutMs: AGENT_HOST_DEADLINES.sessionOpenMs,
        body: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          permission: ruleset
        } satisfies CreateSessionBody
      });
      if (created === undefined || typeof created.id !== "string") {
        throw new Error("OpenCode session create returned no session payload.");
      }
      sessionInfo = created;
    }

    const now = deps.ctx.clock.nowIso();
    const contextLimits = input.contextLimits ?? new Map<string, number>();
    const contextMaxTokens = contextLimits.get(input.modelSelection.model);
    const state = createSessionState({
      threadId: input.threadId,
      openCodeSessionId: sessionInfo.id,
      directory: input.cwd,
      runtimeMode: input.runtimeMode,
      ...(contextMaxTokens !== undefined ? { contextMaxTokens } : {})
    });
    const record: ProviderSession = {
      threadId: input.threadId,
      status: "starting",
      runtimeMode: input.runtimeMode,
      cwd: input.cwd,
      model: input.modelSelection.model,
      resumeCursor: {
        schemaVersion: OPENCODE_RESUME_VERSION,
        sessionId: sessionInfo.id
      } satisfies OpenCodeResumeCursor,
      createdAt: now,
      updatedAt: now
    };

    const session = new OpenCodeThreadSession({
      deps,
      server: input.server,
      client,
      state,
      record,
      modelSlug: input.modelSelection.model,
      contextLimits
    });

    session.emit({
      ...session.base({}),
      type: "session.started",
      payload: {
        ...(resumed ? { resume: record.resumeCursor } : {}),
        message: `OpenCode ${input.server.version} on ${input.server.url}`
      }
    });
    session.emit({
      ...session.base({}),
      type: "thread.started",
      payload: { providerThreadId: sessionInfo.id }
    });

    void session.pump();
    try {
      await withDeadline(session.firstConnection.promise, {
        label: "opencode event stream",
        timeoutMs: FIRST_CONNECTION_TIMEOUT_MS,
        signal: deps.ctx.signal
      });
    } catch (error) {
      await session.stop({ reason: "event stream did not connect", hostInitiated: true });
      throw error;
    }

    // The server dying is what settles every thread it carried: a running
    // state never outlives its process (§3.1/§4.1).
    //
    // `server.exited` is the SAME promise for every handle of a project's
    // server, so a bare `.then` would pin this whole session — its text parts,
    // its request sets — for as long as the project keeps any thread open.
    // Racing it against the session's own closed signal lets the loser be
    // collected as soon as this session stops.
    void Promise.race([
      input.server.exited.then((reason) => ({ exited: true as const, reason })),
      session.closedSignal.then(() => ({ exited: false as const }))
    ]).then((outcome) => {
      if (outcome.exited) {
        void session.stop({
          reason: `OpenCode server ${describeReason(outcome.reason)}`,
          hostInitiated: false
        });
      }
    });

    session.updateRecord({ status: "ready" });
    session.emit({
      ...session.base({}),
      type: "session.state.changed",
      payload: { state: "ready" }
    });
    return session;
  }

  /** Settles when this session stops, whatever the reason. */
  get closedSignal(): Promise<void> {
    return this.closed$.promise;
  }

  get session(): ProviderSession {
    return this.record;
  }

  get sessionId(): string {
    return this.state.openCodeSessionId;
  }

  get resumeCursor(): OpenCodeResumeCursor {
    return { schemaVersion: OPENCODE_RESUME_VERSION, sessionId: this.state.openCodeSessionId };
  }

  // -- event plumbing -----------------------------------------------------

  private base(input: {
    turnId?: string | undefined;
    itemId?: string | undefined;
    requestId?: string | undefined;
    /** The frame that triggered this, kept for §4.2 correlation. */
    raw?: unknown;
  }): RuntimeEventBase {
    return {
      eventId: this.deps.ctx.ids.eventId(),
      threadId: this.state.threadId,
      createdAt: this.deps.ctx.clock.nowIso(),
      ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
      ...(input.itemId !== undefined ? { itemId: input.itemId } : {}),
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      providerRefs: { providerTurnId: this.state.openCodeSessionId },
      ...(input.raw === undefined
        ? {}
        : {
            raw: {
              source: "opencode.sdk.event" as const,
              ...(isRecord(input.raw) && typeof input.raw.type === "string"
                ? { messageType: input.raw.type }
                : {}),
              payload: input.raw
            }
          })
    };
  }

  private emit(event: RuntimeEvent): void {
    this.deps.emit(event);
  }

  /**
   * §3.1: every live task is closed with `task.completed {status:"stopped"}` —
   * which the roster folds to `interrupted` (§7.6) — before the turn or the
   * session settles. A subagent row must never outlive the process that ran it.
   */
  private closeChildAgents(reason?: string): void {
    for (const event of closeLiveChildAgents(this.state, this.normalizeContext(), reason)) {
      this.emit(event);
    }
  }

  /** Whether any subagent is still live — §6.4's `backgroundLiveness` input. */
  hasLiveSubagents(): boolean {
    return hasLiveChildAgents(this.state);
  }

  private normalizeContext(): NormalizeContext {
    return {
      eventId: () => this.deps.ctx.ids.eventId(),
      nowIso: () => this.deps.ctx.clock.nowIso()
    };
  }

  private updateRecord(patch: Partial<ProviderSession>, clear?: {
    activeTurnId?: boolean;
    lastError?: boolean;
  }): void {
    const next: ProviderSession = {
      ...this.record,
      ...patch,
      updatedAt: this.deps.ctx.clock.nowIso(),
      resumeCursor: this.resumeCursor
    };
    if (clear?.activeTurnId === true) {
      delete next.activeTurnId;
    }
    if (clear?.lastError === true) {
      delete next.lastError;
    }
    this.record = next;
  }

  /**
   * The SSE pump. It reconnects on its own: a dropped stream is a warning, not
   * a dead session — but a **reconnect** marks usage incomplete and re-arms
   * both completion machines, because frames were missed (§4.5).
   */
  private async pump(): Promise<void> {
    let attempt = 0;
    let warned = false;
    while (!this.closed && !this.pumpAbort.signal.aborted) {
      try {
        const response = await this.client.openEventStream(this.pumpAbort.signal);
        this.pumpConnections += 1;
        if (this.pumpConnections === 1) {
          this.firstConnection.resolve();
        } else {
          this.onReconnect();
        }
        let sawFrame = false;
        for await (const frame of readSseFrames(response.body)) {
          if (!sawFrame) {
            // The backoff resets on PROGRESS, not on a successful connect. A
            // server that answers `200 text/event-stream` and immediately
            // closes the body would otherwise drive a flat 250 ms loop that
            // re-arms both completion machines four times a second.
            sawFrame = true;
            attempt = 0;
            warned = false;
          }
          if (this.closed) {
            break;
          }
          this.handleFrame(frame.data);
        }
        if (!sawFrame && !this.closed && !warned) {
          warned = true;
          this.emit({
            ...this.base({ turnId: this.state.activeTurnId }),
            type: "runtime.warning",
            payload: {
              message: "OpenCode accepted the event stream but sent nothing. Reconnecting.",
              detail: { attempt }
            }
          });
        }
      } catch (error) {
        if (this.closed || this.pumpAbort.signal.aborted) {
          break;
        }
        if (!warned) {
          warned = true;
          this.emit({
            ...this.base({ turnId: this.state.activeTurnId }),
            type: "runtime.warning",
            payload: {
              message: "OpenCode connection lost. Reconnecting.",
              detail: error instanceof Error ? error.message : String(error)
            }
          });
        }
      }
      if (this.closed || this.pumpAbort.signal.aborted) {
        break;
      }
      await delay(backoffMs(attempt, 250, 5_000), this.pumpAbort.signal);
      attempt += 1;
    }
  }

  private onReconnect(): void {
    if (this.state.turnTokenUsage !== undefined) {
      this.state.turnTokenUsage.complete = false;
    }
    const turnId = this.state.activeTurnId;
    if (turnId === undefined) {
      return;
    }
    if (this.state.promptAdmission !== undefined) {
      void this.runPromptAdmissionRecovery(this.state.promptAdmission);
    } else {
      this.scheduleIdleReconciliation(turnId, { type: "server.reconnected" });
    }
    void this.recoverPendingRequests();
  }

  private handleFrame(data: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const raw = asRawEvent(parsed);
    if (raw === null) {
      return;
    }
    this.deps.ctx.logRawFrame(this.state.threadId, {
      source: "opencode.sdk.event",
      messageType: raw.type,
      payload: raw
    });
    const result = normalizeOpenCodeEvent(this.state, raw, this.normalizeContext());
    for (const event of result.events) {
      this.emit(event);
    }
    for (const signal of result.signals) {
      this.handleSignal(signal);
    }
  }

  private handleSignal(signal: NormalizerSignal): void {
    switch (signal.kind) {
      case "status-busy": {
        this.cancelIdleReconciliation();
        this.state.awaitingBusyAfterInterruption = false;
        const admission = this.state.promptAdmission;
        if (admission !== undefined && admission.turnId === this.state.activeTurnId) {
          admission.busyObserved = true;
          void this.runPromptAdmissionRecovery(admission);
        }
        this.updateRecord({
          status: "running",
          ...(this.state.activeTurnId !== undefined
            ? { activeTurnId: this.state.activeTurnId }
            : {})
        });
        return;
      }
      case "status-idle":
      case "session-idle": {
        this.onIdle(signal.raw);
        return;
      }
      case "user-message-observed": {
        const admission = this.state.promptAdmission;
        if (admission === undefined || admission.messageId !== signal.messageId) {
          return;
        }
        admission.messageObserved = true;
        if (!admission.accepted) {
          return;
        }
        const idle = admission.idleDuringAdmission;
        this.state.awaitingBusyAfterInterruption = false;
        this.state.promptAdmission = undefined;
        if (idle !== undefined) {
          this.scheduleIdleReconciliation(idle.turnId, idle.raw);
        }
        return;
      }
      case "auto-reply-permission": {
        void this.autoReplyOnce(signal.request, signal.raw);
        return;
      }
      case "abort-acknowledged": {
        this.state.cancellation?.acknowledge();
        if (this.state.cancellation !== undefined) {
          this.state.cancellation.acknowledged = true;
        }
        return;
      }
      case "turn-failed": {
        this.failActiveTurn(signal.message);
        return;
      }
      case "ancestry-probe": {
        void this.resolveAncestry(signal.sessionId, signal.raw);
        return;
      }
      case "compacted": {
        return;
      }
      default: {
        const exhaustive: never = signal;
        void exhaustive;
        return;
      }
    }
  }

  // -- completion machines (§4.5) -----------------------------------------

  /** Every deferral condition, in T3's order. */
  private onIdle(raw: unknown): void {
    const turnId = this.state.activeTurnId;
    if (turnId === undefined) {
      return;
    }
    const cancellation = this.state.cancellation;
    if (cancellation !== undefined && cancellation.turnId === turnId) {
      cancellation.deferredIdle = raw;
      return;
    }
    const admission = this.state.promptAdmission;
    if (admission !== undefined && admission.turnId === turnId) {
      admission.idleDuringAdmission = { turnId, raw };
      void this.runPromptAdmissionRecovery(admission);
      return;
    }
    if (this.state.awaitingBusyAfterInterruption) {
      return;
    }
    if (this.state.reconcileIdleStatus) {
      this.scheduleIdleReconciliation(turnId, raw);
      return;
    }
    this.completeTurn(turnId, this.state.promptGeneration, raw);
  }

  private cancelIdleReconciliation(): void {
    const pending = this.state.pendingIdleReconciliation;
    if (pending !== undefined) {
      pending.cancelled = true;
      this.state.pendingIdleReconciliation = undefined;
    }
  }

  /**
   * Machine (2). On an idle for the active turn, poll `GET /session/status`
   * with a 1 s timeout and one retry: a **missing entry counts as idle**
   * (fixtures README observation 7), `busy`/`retry` abandons unless a newer
   * idle marked it dirty, and undecidable emits one `runtime.warning` and
   * backs off `min(250·2^n, 5000)`.
   */
  private scheduleIdleReconciliation(turnId: string, raw: unknown): void {
    const existing = this.state.pendingIdleReconciliation;
    if (
      existing !== undefined &&
      existing.turnId === turnId &&
      existing.promptGeneration === this.state.promptGeneration
    ) {
      existing.raw = raw;
      existing.dirty = true;
      return;
    }
    this.cancelIdleReconciliation();
    const pending: OpenCodeIdleReconciliation = {
      turnId,
      promptGeneration: this.state.promptGeneration,
      raw,
      warned: false,
      dirty: false,
      running: true,
      cancelled: false
    };
    this.state.pendingIdleReconciliation = pending;
    void this.runIdleReconciliation(pending);
  }

  private async runIdleReconciliation(pending: OpenCodeIdleReconciliation): Promise<void> {
    let attempt = 0;
    try {
      while (this.state.pendingIdleReconciliation === pending && !pending.cancelled) {
        if (
          this.closed ||
          this.state.activeTurnId !== pending.turnId ||
          this.state.awaitingBusyAfterInterruption ||
          this.state.promptGeneration !== pending.promptGeneration
        ) {
          this.state.pendingIdleReconciliation = undefined;
          return;
        }
        const status = await this.pollSessionStatus();
        if (
          this.state.pendingIdleReconciliation !== pending ||
          pending.cancelled ||
          this.state.activeTurnId !== pending.turnId ||
          this.state.promptGeneration !== pending.promptGeneration
        ) {
          return;
        }
        if (status.kind === "idle") {
          this.state.pendingIdleReconciliation = undefined;
          this.completeTurn(pending.turnId, pending.promptGeneration, pending.raw);
          return;
        }
        if (status.kind === "busy") {
          if (pending.dirty) {
            pending.dirty = false;
            continue;
          }
          this.state.pendingIdleReconciliation = undefined;
          return;
        }
        if (!pending.warned) {
          pending.warned = true;
          this.emit({
            ...this.base({ turnId: pending.turnId }),
            type: "runtime.warning",
            payload: {
              message: "OpenCode turn completion is waiting for session status.",
              detail: status.detail ?? "session.status returned missing or invalid data."
            }
          });
        }
        await delay(backoffMs(attempt, 250, 5_000), this.pumpAbort.signal);
        attempt += 1;
      }
    } finally {
      if (this.state.pendingIdleReconciliation === pending) {
        this.state.pendingIdleReconciliation = undefined;
      }
    }
  }

  private async pollSessionStatus(): Promise<{
    kind: "idle" | "busy" | "unknown";
    detail?: string;
  }> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const map = await this.client.get<SessionStatusMap>(openCodeRoutes.sessionStatus, {
          timeoutMs: 1_000
        });
        if (!isRecord(map)) {
          return { kind: "unknown", detail: "session.status returned a non-object body." };
        }
        const entry = map[this.state.openCodeSessionId];
        // A missing entry IS idle — an idle session is simply absent from the
        // map (fixtures README observation 7).
        if (entry === undefined || entry.type === "idle") {
          return { kind: "idle" };
        }
        if (entry.type === "busy" || entry.type === "retry") {
          return { kind: "busy" };
        }
        return { kind: "unknown", detail: `unrecognised status '${String(entry.type)}'` };
      } catch (error) {
        if (attempt === 1) {
          return {
            kind: "unknown",
            detail: error instanceof Error ? error.message : String(error)
          };
        }
      }
    }
    return { kind: "unknown" };
  }

  /**
   * Machine (3). For **idle arriving before `promptAsync` returns**: confirm
   * the user message exists via `GET /session/{id}/message/{msgId}`, poll
   * status, and require **two consecutive idle confirmations** before
   * completing. After five attempts it hard-fails with
   * `turn.completed {state:"failed"}` plus `runtime.error {transport_error}`
   * — which is also the terminal path for fixtures README observation 14, a
   * prompt admitted, gone busy, gone idle and produced nothing at all.
   */
  private async runPromptAdmissionRecovery(admission: OpenCodePromptAdmission): Promise<void> {
    if (admission.recovering || admission.cancelled) {
      return;
    }
    admission.recovering = true;
    try {
      for (let attempt = 0; attempt < ADMISSION_MAX_ATTEMPTS; attempt += 1) {
        if (!this.admissionStillCurrent(admission)) {
          return;
        }
        if (!admission.messageObserved) {
          const seen = await this.confirmUserMessage(admission.messageId);
          if (!this.admissionStillCurrent(admission)) {
            return;
          }
          if (seen) {
            admission.messageObserved = true;
            this.state.messageRoleById.set(admission.messageId, "user");
            this.state.textPartsByMessageId.delete(admission.messageId);
          }
        }

        // A native command's response only arrives once generation finished,
        // so its receipt — not a submit cap — is what proves admission.
        if (admission.requiresMessageReceipt && !admission.accepted) {
          await delay(backoffMs(attempt, 250, 2_000), this.pumpAbort.signal);
          continue;
        }
        if (!admission.accepted) {
          await delay(backoffMs(attempt, 250, 2_000), this.pumpAbort.signal);
          continue;
        }

        const status = await this.pollSessionStatus();
        if (!this.admissionStillCurrent(admission)) {
          return;
        }
        if (status.kind === "busy") {
          admission.busyObserved = true;
          admission.idleStatusConfirmations = 0;
          this.state.awaitingBusyAfterInterruption = false;
          this.state.promptAdmission = undefined;
          return;
        }
        const idle = admission.idleDuringAdmission ?? admission.priorIdle;
        if (
          status.kind === "idle" &&
          idle !== undefined &&
          (admission.messageObserved || admission.busyObserved)
        ) {
          this.state.promptAdmission = undefined;
          this.state.awaitingBusyAfterInterruption = false;
          this.scheduleIdleReconciliation(admission.turnId, idle.raw);
          return;
        }
        if (status.kind === "idle" && admission.messageObserved) {
          admission.idleStatusConfirmations += 1;
          if (admission.idleStatusConfirmations >= 2) {
            this.state.promptAdmission = undefined;
            this.state.awaitingBusyAfterInterruption = false;
            this.completeTurn(admission.turnId, admission.generation, {
              type: "session.status.recovered"
            });
            return;
          }
        } else if (status.kind !== "idle") {
          admission.idleStatusConfirmations = 0;
        }
        await delay(backoffMs(attempt, 250, 2_000), this.pumpAbort.signal);
      }
      await this.failPromptAdmission(admission);
    } finally {
      admission.recovering = false;
    }
  }

  private admissionStillCurrent(admission: OpenCodePromptAdmission): boolean {
    return (
      !this.closed &&
      this.state.promptAdmission === admission &&
      this.state.activeTurnId === admission.turnId &&
      this.state.promptGeneration === admission.generation &&
      !admission.cancelled
    );
  }

  private async confirmUserMessage(messageId: string): Promise<boolean> {
    try {
      const message = await this.client.get<OpenCodeMessageWithParts>(
        openCodeRoutes.message(this.state.openCodeSessionId, messageId),
        { timeoutMs: 1_000 }
      );
      return message?.info?.id === messageId && message.info.role === "user";
    } catch {
      return false;
    }
  }

  private async failPromptAdmission(admission: OpenCodePromptAdmission): Promise<void> {
    if (!this.admissionStillCurrent(admission)) {
      return;
    }
    const detail =
      "OpenCode accepted the prompt, but Orquester could not confirm its message or session status.";
    await this.abortSession(1_000).catch(() => undefined);
    const tokenUsage = takeTurnTokenUsage(this.state, false);
    this.state.promptAdmission = undefined;
    this.state.activeTurnId = undefined;
    this.state.activeAgent = undefined;
    this.state.activeVariant = undefined;
    this.state.awaitingBusyAfterInterruption = false;
    this.state.reconcileIdleStatus = false;
    this.updateRecord({ status: "error", lastError: detail }, { activeTurnId: true });
    this.closeChildAgents(detail);
    this.emit({
      ...this.base({ turnId: admission.turnId }),
      type: "turn.completed",
      payload: { state: "failed", errorMessage: detail, tokenUsage }
    });
    this.emit({
      ...this.base({ turnId: admission.turnId }),
      type: "runtime.error",
      payload: { message: detail, class: "transport_error" }
    });
  }

  private completeTurn(turnId: string, generation: number, raw: unknown): void {
    if (this.state.activeTurnId !== turnId || this.state.promptGeneration !== generation) {
      return;
    }
    const usage = this.state.turnTokenUsage;
    const costUsd = usage?.costUsd ?? 0;
    const tokenUsage = takeTurnTokenUsage(this.state, true);
    this.state.activeTurnId = undefined;
    this.state.activeAgent = undefined;
    this.state.activeVariant = undefined;
    this.state.interruptedTurnId = undefined;
    this.state.awaitingBusyAfterInterruption = false;
    this.state.reconcileIdleStatus = false;
    this.state.lastSessionErrorMessage = undefined;
    for (const requestId of this.state.autoRepliedRequestIds) {
      this.state.emittedTerminalRequestIds.add(requestId);
    }
    this.state.autoRepliedRequestIds.clear();
    this.cancelIdleReconciliation();
    this.updateRecord({ status: "ready" }, { activeTurnId: true });
    void this.recoverPendingRequests();
    this.emit({
      ...this.base({ turnId, raw }),
      type: "turn.completed",
      payload: {
        state: "completed",
        tokenUsage,
        ...(costUsd > 0 ? { totalCostUsd: costUsd } : {})
      }
    });
  }

  private failActiveTurn(message: string): void {
    const turnId = this.state.activeTurnId;
    this.cancelIdleReconciliation();
    const cancellation = this.state.cancellation;
    if (turnId !== undefined && cancellation?.turnId === turnId) {
      cancellation.turnSettled = true;
      cancellation.acknowledged = true;
      cancellation.acknowledge();
    }
    const tokenUsage = turnId !== undefined ? takeTurnTokenUsage(this.state, false) : undefined;
    this.state.activeTurnId = undefined;
    this.state.activeAgent = undefined;
    this.state.activeVariant = undefined;
    this.state.reconcileIdleStatus = false;
    this.updateRecord({ status: "error", lastError: message }, { activeTurnId: true });
    this.closeChildAgents(message);
    void this.recoverPendingRequests();
    if (turnId !== undefined) {
      this.emit({
        ...this.base({ turnId }),
        type: "turn.completed",
        payload: { state: "failed", errorMessage: message, ...(tokenUsage ? { tokenUsage } : {}) }
      });
    }
  }

  // -- requests -----------------------------------------------------------

  /**
   * Full access answers every ask **`once`**, never `always` (§4.3): an
   * `always` is stored per directory and fixture 04 shows it silencing the ask
   * in a brand-new session on the same server — which would widen a supervised
   * thread sharing this project's server.
   */
  private async autoReplyOnce(request: OpenCodePermissionRequest, raw: unknown): Promise<void> {
    try {
      await this.client.post<unknown>(openCodeRoutes.permissionReply(request.id), {
        timeoutMs: AGENT_HOST_DEADLINES.submitMs,
        body: { reply: "once" }
      });
    } catch (error) {
      this.deps.ctx.logger.warn("opencode auto-approval failed; falling back to the card", {
        threadId: this.state.threadId,
        requestId: request.id,
        error: error instanceof Error ? error.message : String(error)
      });
      // Fall back to the dialog. The id stays resolved so a recovered copy of
      // this ask cannot reopen after the user answers.
      this.state.autoRepliedRequestIds.delete(request.id);
      this.state.resolvedRequestIds.delete(request.id);
      const previousMode = this.state.runtimeMode;
      // Re-run the ask through the normaliser with the supervised branch, so
      // the card is built by exactly the code the supervised path uses.
      this.state.runtimeMode = "approval-required";
      try {
        const frame: OpenCodeRawEvent = asRawEvent(raw) ?? {
          type: "permission.asked",
          properties: request
        };
        const result = normalizeOpenCodeEvent(this.state, frame, this.normalizeContext());
        for (const event of result.events) {
          this.emit(event);
        }
      } finally {
        this.state.runtimeMode = previousMode;
      }
    }
  }

  /**
   * Re-open anything `GET /permission` and `GET /question` still hold that we
   * are not tracking, and close anything we track that the server has already
   * forgotten. Best effort; a failure only shrinks the sweep.
   */
  private async recoverPendingRequests(): Promise<void> {
    if (this.closed) {
      return;
    }
    try {
      const [permissions, questions] = await Promise.all([
        this.client
          .get<OpenCodePermissionRequest[]>(openCodeRoutes.permissions, { timeoutMs: 2_000 })
          .catch(() => [] as OpenCodePermissionRequest[]),
        this.client
          .get<OpenCodeQuestionRequest[]>(openCodeRoutes.questions, { timeoutMs: 2_000 })
          .catch(() => [] as OpenCodeQuestionRequest[])
      ]);
      const livePermissions = new Set(
        (Array.isArray(permissions) ? permissions : [])
          .filter((request) => this.state.relatedSessionIds.has(request.sessionID))
          .map((request) => request.id)
      );
      const liveQuestions = new Set(
        (Array.isArray(questions) ? questions : [])
          .filter((request) => this.state.relatedSessionIds.has(request.sessionID))
          .map((request) => request.id)
      );
      for (const [requestId] of [...this.state.pendingPermissions]) {
        if (!livePermissions.has(requestId)) {
          const out = new NormalizerEmitter(this.state, this.normalizeContext());
          emitTerminalPermission(this.state, requestId, undefined, undefined, out);
          for (const event of out.events) {
            this.emit(event);
          }
        }
      }
      for (const [requestId] of [...this.state.pendingQuestions]) {
        if (!liveQuestions.has(requestId)) {
          const out = new NormalizerEmitter(this.state, this.normalizeContext());
          emitTerminalQuestion(this.state, requestId, undefined, undefined, out);
          for (const event of out.events) {
            this.emit(event);
          }
        }
      }
    } catch {
      // Recovery is best effort by construction.
    }
  }

  /**
   * A request event from a session we have not yet linked to this thread.
   * Walk `parentID` up to 32 steps.
   *
   * **Every** retry chain is capped, asked-events included. T3 could retry an
   * ask forever because its server was per *thread*, so a foreign session's
   * frame could not appear; Orquester's server is per **project** (§3.2), so
   * every thread's `GET /event` sees every co-tenant thread's frames. An
   * uncapped chain therefore meant: thread B opens an approval card, thread A
   * polls `GET /session/{B}` every 5 s **for the rest of its life**, one live
   * chain per foreign ask, with a map key that is never released.
   *
   * A root whose id is not ours is a definitive answer — that ask belongs to
   * another thread — so it gives up at once rather than retrying at all.
   */
  private async resolveAncestry(sessionId: string, raw: OpenCodeRawEvent): Promise<void> {
    const key = `${raw.type}:${sessionId}`;
    const attempt = this.ancestryAttempts.get(key) ?? 0;
    const terminal = raw.type !== "permission.asked" && raw.type !== "question.asked";
    const limit = terminal ? ANCESTRY_TERMINAL_MAX_ATTEMPTS : ANCESTRY_ASKED_MAX_ATTEMPTS;
    if (attempt >= limit) {
      this.ancestryAttempts.delete(key);
      return;
    }
    this.ancestryAttempts.set(key, attempt + 1);

    const outcome = await this.resolveSessionRoot(sessionId);
    if (this.closed) {
      this.ancestryAttempts.delete(key);
      return;
    }
    if (outcome === "descendant") {
      this.ancestryAttempts.delete(key);
      const result = normalizeOpenCodeEvent(this.state, raw, this.normalizeContext());
      for (const event of result.events) {
        this.emit(event);
      }
      for (const signal of result.signals) {
        if (signal.kind !== "ancestry-probe") {
          this.handleSignal(signal);
        }
      }
      return;
    }
    if (outcome === "foreign") {
      // A fully-walked tree with a different root: retrying cannot change it.
      this.ancestryAttempts.delete(key);
      return;
    }
    // "unknown" — the walk could not complete (a transient read, a session not
    // yet visible). Back off and try again, within the cap.
    await delay(backoffMs(attempt, 250, 5_000), this.pumpAbort.signal);
    if (this.closed) {
      this.ancestryAttempts.delete(key);
      return;
    }
    void this.resolveAncestry(sessionId, raw);
  }

  /**
   * Walk a session's `parentID` chain, distinguishing the three answers a
   * retry loop needs:
   *
   * - `descendant` — it belongs to this thread;
   * - `foreign` — the walk completed and the root is somebody else's, or the
   *   session is gone. Definitive: retrying cannot change it;
   * - `unknown` — the walk could not complete (a transient read error, a
   *   cycle, the 32-step cap). Only this one is worth a retry.
   */
  private async resolveSessionRoot(
    candidate: string
  ): Promise<"descendant" | "foreign" | "unknown"> {
    const seen = new Set<string>();
    let sessionId: string | undefined = candidate;
    for (let depth = 0; sessionId !== undefined && depth < 32; depth += 1) {
      if (this.state.relatedSessionIds.has(sessionId)) {
        addRelated(this.state, candidate);
        return "descendant";
      }
      if (seen.has(sessionId)) {
        return "unknown";
      }
      seen.add(sessionId);
      try {
        const info: OpenCodeSessionInfo = await this.client.get<OpenCodeSessionInfo>(
          openCodeRoutes.session(sessionId),
          { timeoutMs: 2_000 }
        );
        sessionId = typeof info?.parentID === "string" ? info.parentID : undefined;
      } catch (error) {
        // A confirmed 404 is an answer: that session does not exist here.
        return isOpenCodeNotFound(error) ? "foreign" : "unknown";
      }
    }
    // The chain ended at a root that is not ours — a co-tenant thread's
    // session on this project's shared server.
    return sessionId === undefined ? "foreign" : "unknown";
  }

  async respondToApproval(requestId: string, decision: ApprovalDecision): Promise<void> {
    const reply = toOpenCodePermissionReply(decision);
    try {
      await this.client.post<unknown>(openCodeRoutes.permissionReply(requestId), {
        timeoutMs: AGENT_HOST_DEADLINES.submitMs,
        body: { reply }
      });
    } catch (error) {
      if (!isOpenCodeNotFound(error)) {
        throw error;
      }
      // The provider already forgot it (an abort orphans the request —
      // fixtures README observation 11). Settle the card locally.
    }
    this.state.resolvedRequestIds.add(requestId);
    const out = new NormalizerEmitter(this.state, this.normalizeContext());
    emitTerminalPermission(this.state, requestId, decision, undefined, out);
    for (const event of out.events) {
      this.emit(event);
    }
  }

  async respondToUserInput(requestId: string, answers: Record<string, unknown>): Promise<void> {
    const request = this.state.pendingQuestions.get(requestId);
    const rejected = Object.keys(answers).length === 0;
    try {
      if (rejected) {
        // `POST /question/{id}/reject` works and is what `/dismiss` wants —
        // T3 never calls it (fixtures README observation, question notes).
        await this.client.post<unknown>(openCodeRoutes.questionReject(requestId), {
          timeoutMs: AGENT_HOST_DEADLINES.submitMs
        });
      } else {
        await this.client.post<unknown>(openCodeRoutes.questionReply(requestId), {
          timeoutMs: AGENT_HOST_DEADLINES.submitMs,
          body: { answers: toQuestionAnswers(request, answers) }
        });
      }
    } catch (error) {
      if (!isOpenCodeNotFound(error)) {
        throw error;
      }
    }
    this.state.resolvedRequestIds.add(requestId);
    const out = new NormalizerEmitter(this.state, this.normalizeContext());
    emitTerminalQuestion(
      this.state,
      requestId,
      rejected ? undefined : toQuestionAnswers(request, answers),
      undefined,
      out
    );
    for (const event of out.events) {
      this.emit(event);
    }
  }

  /**
   * §4.1 "settle before interrupt". Every pending approval and user-input
   * request is resolved with `cancel` and emitted **before** the interrupt
   * reaches the provider. Two reasons, both load-bearing: a transport that
   * answers server requests inline is blocked by an open prompt, and — proven
   * by fixture 06 — an aborted turn leaves its request **open forever** in
   * `GET /permission`, so without this the next recovery sweep re-opens a card
   * for a turn that no longer exists.
   *
   * *differs from T3:* the reject is also sent to the server, not only emitted
   * locally, so the orphan is actually released rather than merely ignored.
   */
  private async settlePendingRequests(): Promise<void> {
    const permissions = [...this.state.pendingPermissions.keys()];
    const questions = [...this.state.pendingQuestions.keys()];
    const out = new NormalizerEmitter(this.state, this.normalizeContext());
    for (const requestId of permissions) {
      this.state.resolvedRequestIds.add(requestId);
      emitTerminalPermission(this.state, requestId, "cancel", undefined, out);
    }
    for (const requestId of questions) {
      this.state.resolvedRequestIds.add(requestId);
      emitTerminalQuestion(this.state, requestId, undefined, undefined, out);
    }
    for (const event of out.events) {
      this.emit(event);
    }
    await forEachLimited([...permissions], 8, async (requestId) => {
      await this.client
        .post<unknown>(openCodeRoutes.permissionReply(requestId), {
          timeoutMs: 2_000,
          body: { reply: "reject" }
        })
        .catch(() => undefined);
    });
    await forEachLimited([...questions], 8, async (requestId) => {
      await this.client
        .post<unknown>(openCodeRoutes.questionReject(requestId), { timeoutMs: 2_000 })
        .catch(() => undefined);
    });
  }

  // -- turns ---------------------------------------------------------------

  async sendTurn(input: SendTurnInput): Promise<SendTurnResult> {
    const selection = input.modelSelection ?? { model: this.lastModelSlug };
    const parsedModel = parseOpenCodeModelSlug(selection.model);
    if (parsedModel === null) {
      throw new Error("OpenCode model selection must use the 'provider/model' format.");
    }
    this.lastModelSlug = selection.model;
    // A model switch moves the meter's denominator with it; a model the
    // catalogue never described clears it, so the ring disappears rather than
    // measuring against the previous model's window.
    const contextMaxTokens = this.contextLimits.get(selection.model);
    if (contextMaxTokens === undefined) {
      delete this.state.contextMaxTokens;
    } else {
      this.state.contextMaxTokens = contextMaxTokens;
    }

    const text = input.input.trim();
    const fileParts = await this.buildFileParts(input.attachments);
    if (text.length === 0 && fileParts.length === 0) {
      throw new Error("OpenCode turns require text input or at least one attachment.");
    }

    // §4.6.5(c): a prompt matching `^/name( args)?$` whose name is in a
    // FRESHLY fetched `command.list` is dispatched natively; a name that is
    // not in the list falls through to an ordinary prompt.
    const commandMatch = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text);
    const nativeCommand =
      commandMatch === null ? undefined : await this.lookupCommand(commandMatch[1] ?? "");

    return await this.promptLock.run(async () => {
      const pending = this.state.cancellation;
      if (pending !== undefined) {
        await pending.completion.catch(() => undefined);
      }
      if (this.closed) {
        throw new Error("OpenCode session is closed.");
      }

      // A sendTurn while a turn is active is a STEER: OpenCode queues the
      // prompt into the running session, so the active turn id is reused
      // (§4.1 "Steering"). A new turn is NAMED by the OpenCode id of the prompt
      // that opens it — OpenCode keeps a client-minted `messageID` verbatim
      // (fixtures README observations 8 and 15) — so the id the fold keeps is
      // the provider's own and a rewind finds the turn again in
      // `GET /session/:id/message`, across a host restart too (§5.5).
      const steeringTurnId = this.state.activeTurnId;
      const messageId = mintOpenCodeMessageId();
      const turnId = steeringTurnId ?? messageId;
      const agent =
        selectedOption(selection, "agent") ??
        (input.interactionMode === "plan" ? "plan" : undefined);
      const variant = selectedOption(selection, "variant");

      const priorReconciliation = this.state.pendingIdleReconciliation;
      const priorIdle =
        priorReconciliation !== undefined
          ? { turnId: priorReconciliation.turnId, raw: priorReconciliation.raw }
          : undefined;
      this.cancelIdleReconciliation();

      const generation = this.state.promptGeneration + 1;
      const admission: OpenCodePromptAdmission = {
        generation,
        turnId,
        messageId,
        requiresMessageReceipt: nativeCommand !== undefined,
        messageObserved: false,
        busyObserved: false,
        accepted: false,
        cancelled: false,
        idleStatusConfirmations: 0,
        ...(priorIdle !== undefined ? { priorIdle } : {}),
        priorAwaitingBusy: this.state.awaitingBusyAfterInterruption,
        recovering: false
      };
      this.state.promptGeneration = generation;
      this.state.promptAdmission = admission;
      this.state.activeTurnId = turnId;
      this.state.activeAgent = agent;
      this.state.activeVariant = variant;
      this.state.lastSessionErrorMessage = undefined;
      if (steeringTurnId === undefined) {
        this.state.turnTokenUsage = makeTurnTokenUsageAccumulator();
        this.state.awaitingBusyAfterInterruption = this.state.interruptedTurnId !== undefined;
      }
      this.state.turnTokenUsage?.promptMessageIds.add(messageId);

      this.updateRecord(
        { status: "running", activeTurnId: turnId, model: selection.model },
        { lastError: true }
      );
      if (steeringTurnId === undefined) {
        this.emit({
          ...this.base({ turnId }),
          type: "turn.started",
          payload: {
            model: selection.model,
            ...(variant !== undefined ? { effort: variant } : {})
          }
        });
      }

      try {
        if (nativeCommand !== undefined) {
          await this.submitCommand({
            messageId,
            command: nativeCommand.name,
            args: commandMatch?.[2] ?? "",
            model: `${parsedModel.providerID}/${parsedModel.modelID}`,
            agent,
            variant,
            parts: fileParts,
            admission
          });
        } else {
          await this.submitPrompt({
            messageId,
            model: parsedModel,
            agent,
            variant,
            text,
            parts: fileParts
          });
        }
      } catch (error) {
        this.rollbackAdmission(admission, steeringTurnId, error);
        throw error;
      }

      admission.accepted = true;
      if (admission.messageObserved) {
        const idle = admission.idleDuringAdmission;
        this.state.promptAdmission = undefined;
        this.state.awaitingBusyAfterInterruption = false;
        if (idle !== undefined) {
          this.scheduleIdleReconciliation(idle.turnId, idle.raw);
        }
      } else {
        void this.runPromptAdmissionRecovery(admission);
      }

      return { turnId, resumeCursor: this.resumeCursor };
    });
  }

  private async submitPrompt(input: {
    messageId: string;
    model: ParsedModelSlug;
    agent: string | undefined;
    variant: string | undefined;
    text: string;
    parts: OpenCodePartInput[];
  }): Promise<void> {
    const body: PromptAsyncBody = {
      messageID: input.messageId,
      model: input.model,
      ...(input.agent !== undefined ? { agent: input.agent } : {}),
      ...(input.variant !== undefined ? { variant: input.variant } : {}),
      // OpenCode appends this after its own agent/provider prompts.
      system: buildRuntimeInstructions(`${input.model.providerID}/${input.model.modelID}`),
      parts: [
        ...(input.text.length > 0 ? [{ type: "text" as const, text: input.text }] : []),
        ...input.parts
      ]
    };
    // `prompt_async` answers 204 with an empty body: nothing in the response
    // identifies the turn, which is why the client-minted `messageID` is
    // load-bearing (fixtures README observation 8).
    await this.client.post<unknown>(openCodeRoutes.promptAsync(this.state.openCodeSessionId), {
      timeoutMs: AGENT_HOST_DEADLINES.submitMs,
      body
    });
  }

  /**
   * `session.command` is **blocking** — 4.5 s in fixture 11 — and returns the
   * finished assistant message, so it is bounded by the user-message receipt
   * rather than the submit cap. Its `command.executed.messageID` is the
   * *assistant* id, never the minted user one.
   */
  private async submitCommand(input: {
    messageId: string;
    command: string;
    args: string;
    model: string;
    agent: string | undefined;
    variant: string | undefined;
    parts: OpenCodePartInput[];
    admission: OpenCodePromptAdmission;
  }): Promise<void> {
    const body: SessionCommandBody = {
      messageID: input.messageId,
      command: input.command,
      arguments: input.args,
      model: input.model,
      ...(input.agent !== undefined ? { agent: input.agent } : {}),
      ...(input.variant !== undefined ? { variant: input.variant } : {}),
      parts: input.parts
    };
    const receipt = deferred<void>();
    const watcher = setInterval(() => {
      if (input.admission.messageObserved) {
        receipt.resolve();
      }
    }, 25);
    watcher.unref?.();
    try {
      await Promise.race([
        this.client.post<unknown>(openCodeRoutes.command(this.state.openCodeSessionId), {
          // The call blocks for the whole generation, so the deadline is the
          // liveness window, not the submit cap.
          timeoutMs: COMPACTION_TIMEOUT_MS,
          body
        }),
        withDeadline(receipt.promise, {
          label: "opencode session.command receipt",
          timeoutMs: AGENT_HOST_DEADLINES.submitMs,
          // `withDeadline` deliberately keeps its timer ref'd, so without a
          // signal this 10 s timer outlives every native slash-command turn
          // and delays the drain-restart the shutdown design depends on.
          signal: this.pumpAbort.signal
        })
      ]);
    } finally {
      clearInterval(watcher);
    }
  }

  private rollbackAdmission(
    admission: OpenCodePromptAdmission,
    steeringTurnId: string | undefined,
    error: unknown
  ): void {
    if (this.state.promptAdmission !== admission) {
      return;
    }
    this.state.promptAdmission = undefined;
    if (steeringTurnId !== undefined) {
      // A failed steer must not kill the turn that is still running.
      this.state.awaitingBusyAfterInterruption = admission.priorAwaitingBusy;
      const idle = admission.idleDuringAdmission ?? admission.priorIdle;
      if (idle !== undefined) {
        this.scheduleIdleReconciliation(idle.turnId, idle.raw);
      }
      this.emit({
        ...this.base({ turnId: admission.turnId }),
        type: "runtime.warning",
        payload: {
          message: "OpenCode refused the steering message.",
          detail: error instanceof Error ? error.message : String(error)
        }
      });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    const tokenUsage = takeTurnTokenUsage(this.state, false);
    this.state.activeTurnId = undefined;
    this.state.activeAgent = undefined;
    this.state.activeVariant = undefined;
    this.updateRecord({ status: "ready" }, { activeTurnId: true });
    this.emit({
      ...this.base({ turnId: admission.turnId }),
      type: "turn.completed",
      payload: { state: "failed", errorMessage: message, tokenUsage }
    });
    this.emit({
      ...this.base({ turnId: admission.turnId }),
      type: "runtime.error",
      payload: {
        message,
        class: error instanceof OpenCodeHttpError ? "provider_error" : "transport_error"
      }
    });
  }

  private async lookupCommand(name: string): Promise<OpenCodeCommandRow | undefined> {
    if (name.length === 0) {
      return undefined;
    }
    try {
      const rows = await this.client.get<OpenCodeCommandRow[]>(openCodeRoutes.commands, {
        timeoutMs: AGENT_HOST_DEADLINES.submitMs
      });
      return (Array.isArray(rows) ? rows : []).find((row) => row.name === name);
    } catch {
      // A failed catalogue lookup falls through to an ordinary prompt: the CLI
      // decides what a slash command means (§4.6.5(c)).
      return undefined;
    }
  }

  private async buildFileParts(attachments: AttachmentRef[]): Promise<OpenCodePartInput[]> {
    const parts: OpenCodePartInput[] = [];
    for (const attachment of attachments) {
      const mime = attachment.mimeType?.trim().toLowerCase() ?? "";
      const size = attachment.sizeBytes ?? 0;
      if (size > NATIVE_FILE_PART_MAX_BYTES) {
        continue;
      }
      const native =
        NATIVE_IMAGE_MIMES.has(mime) || mime.startsWith("text/") || mime === "application/pdf";
      if (!native) {
        // Anything the model API would reject rides only as the file path the
        // host already flattened into the prompt text (§4.1).
        continue;
      }
      let absolute: string;
      try {
        absolute = await this.deps.ctx.resolveAttachmentPath(this.state.threadId, attachment.id);
      } catch {
        continue;
      }
      parts.push({
        type: "file",
        mime,
        filename: attachment.name,
        url: pathToFileURL(absolute).href
      });
    }
    return parts;
  }

  // -- interrupt and stop --------------------------------------------------

  /**
   * §4.5 Interrupt. `POST /session/{id}/abort` (10 s), **then** walk
   * `GET /session/{id}/children` and abort every descendant, concurrency 8,
   * cycle-guarded, 404s ignored. The acknowledgement arrives either as the
   * HTTP reply *or* as a `session.error` carrying `MessageAbortedError` —
   * fixture 06 shows the stream winning the race. Success emits
   * **`turn.aborted`**, not `turn.completed`.
   *
   * Interrupt is **turn-scoped**: a Stop aimed at a turn that is no longer the
   * active one is a no-op, so it cannot kill the next turn (§4.1).
   */
  async interruptTurn(turnId?: string): Promise<void> {
    const activeTurnId = this.state.activeTurnId;
    if (turnId !== undefined && activeTurnId !== turnId) {
      return;
    }
    const target = turnId ?? activeTurnId;
    if (target !== undefined && this.state.interruptedTurnId === target) {
      return;
    }
    const existing = this.state.cancellation;
    if (existing !== undefined) {
      await existing.completion.catch(() => undefined);
      return;
    }

    // Settle first — see settlePendingRequests().
    await this.settlePendingRequests();

    this.cancelIdleReconciliation();
    if (target !== undefined) {
      this.state.interruptedTurnId = target;
    }
    this.state.reconcileIdleStatus = true;
    this.state.awaitingBusyAfterInterruption = false;
    const admission = this.state.promptAdmission;
    if (admission !== undefined) {
      admission.cancelled = true;
    }

    const cancellation = makeCancellation(target);
    this.state.cancellation = cancellation;
    try {
      await this.abortSession(AGENT_HOST_DEADLINES.submitMs);
      cancellation.acknowledged = true;
      cancellation.acknowledge();
      await this.abortDescendants();
      // §6.2: "`/interrupt` is also the only way to stop background work, and
      // it stops all of it. It is addressed to the SESSION, not to a turn, so
      // it is valid with no turn running." The descendant abort above already
      // killed the children provider-side; closing their roster rows is what
      // lets `backgroundLiveness` drop to null — without it the client's Stop
      // button stays on "Stopping…" forever. Runs on EVERY interrupt, with or
      // without an active turn, and is idempotent.
      this.closeChildAgents("interrupted");
      const tokenUsage = takeTurnTokenUsage(this.state, false);
      if (target !== undefined && this.state.activeTurnId === target) {
        this.state.activeTurnId = undefined;
        this.state.activeAgent = undefined;
        this.state.activeVariant = undefined;
        this.state.promptAdmission = undefined;
        this.updateRecord({ status: "ready" }, { activeTurnId: true });
        this.emit({
          ...this.base({ turnId: target }),
          type: "turn.aborted",
          payload: { reason: "interrupted", tokenUsage }
        });
      }
      cancellation.complete();
    } catch (error) {
      cancellation.complete(error);
      throw error;
    } finally {
      if (this.state.cancellation === cancellation) {
        this.state.cancellation = undefined;
      }
    }
  }

  /** `POST /session/<nonexistent>/abort` answers `200 true` — it proves nothing. */
  private async abortSession(timeoutMs: number): Promise<void> {
    await this.client
      .post<unknown>(openCodeRoutes.abort(this.state.openCodeSessionId), { timeoutMs })
      .catch((error: unknown) => {
        if (isOpenCodeNotFound(error)) {
          return;
        }
        throw error;
      });
  }

  private async abortDescendants(): Promise<void> {
    const visited = new Set([this.state.openCodeSessionId]);
    const visit = async (sessionId: string, abortIt: boolean): Promise<void> => {
      if (abortIt) {
        await withDeadline(
          this.client
            .post<unknown>(openCodeRoutes.abort(sessionId), {
              timeoutMs: AGENT_HOST_DEADLINES.interruptChildMs
            })
            .catch(() => undefined),
          {
            label: "opencode child abort",
            timeoutMs: AGENT_HOST_DEADLINES.interruptChildMs
          }
        ).catch(() => undefined);
      }
      const children = await this.client
        .get<{ id: string }[]>(openCodeRoutes.children(sessionId), {
          timeoutMs: AGENT_HOST_DEADLINES.interruptChildMs
        })
        .catch(() => [] as { id: string }[]);
      const next = (Array.isArray(children) ? children : []).filter((child) => {
        if (typeof child?.id !== "string" || visited.has(child.id)) {
          return false;
        }
        visited.add(child.id);
        return true;
      });
      await forEachLimited(next, 8, async (child) => {
        await visit(child.id, true);
      });
    };
    // The whole fleet interrupt is bounded, however many children there are:
    // the runaway-fleet case is precisely when Stop has to work (§3.1).
    await withDeadline(visit(this.state.openCodeSessionId, false), {
      label: "opencode descendant abort",
      timeoutMs: AGENT_HOST_DEADLINES.interruptAllMs
    }).catch(() => undefined);
  }

  /**
   * §3.1: before `session.exited` the adapter settles the in-flight turn,
   * closes every request parked on this transport, and only then reports the
   * exit. A running state never outlives its process.
   */
  async stop(input: { reason: string; hostInitiated: boolean }): Promise<void> {
    this.closing ??= this.doStop(input);
    return await this.closing;
  }

  private async doStop(input: { reason: string; hostInitiated: boolean }): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.state.stopped = true;
    this.closed$.resolve();
    this.cancelIdleReconciliation();

    await this.settlePendingRequests().catch(() => undefined);
    this.closeChildAgents(input.reason);

    const turnId = this.state.activeTurnId;
    if (turnId !== undefined) {
      const tokenUsage = takeTurnTokenUsage(this.state, false);
      this.state.activeTurnId = undefined;
      this.emit({
        ...this.base({ turnId }),
        type: "turn.completed",
        payload: {
          state: input.hostInitiated ? "interrupted" : "failed",
          errorMessage: input.reason,
          tokenUsage
        }
      });
    }

    if (input.hostInitiated && !this.server.hasExited()) {
      // Abort the parent FIRST so it cannot spawn a new child while the
      // adapter reads the tree (§4.5 teardown ordering).
      await this.abortSession(1_000).catch(() => undefined);
      await this.abortDescendants().catch(() => undefined);
    }

    this.pumpAbort.abort();
    this.updateRecord(
      {
        status: input.hostInitiated ? "stopped" : "error",
        ...(input.hostInitiated ? {} : { lastError: input.reason })
      },
      { activeTurnId: true }
    );
    this.emit({
      ...this.base({}),
      type: "session.exited",
      payload: {
        reason: input.reason,
        // A fresh session can always be opened from the persisted cursor.
        recoverable: true,
        exitKind: input.hostInitiated ? "graceful" : "error"
      }
    });
    this.server.release();
    this.deps.onClosed(this.state.threadId);
  }

  // -- compaction, reads and rollback --------------------------------------

  /**
   * Native compaction. The server does **not** refuse `summarize` during an
   * active turn (fixtures README observation 16) — it compacts anyway — so the
   * refusal is a **client-side invariant with no server backstop** and has to
   * be enforced right here, or a user can compact the context out from under a
   * running turn.
   */
  async compact(): Promise<void> {
    const parsedModel = parseOpenCodeModelSlug(this.lastModelSlug);
    if (parsedModel === null) {
      throw new Error("OpenCode compaction requires an active 'provider/model' selection.");
    }
    await this.promptLock.run(async () => {
      if (this.closed) {
        throw new Error("OpenCode session is closed.");
      }
      if (this.state.activeTurnId !== undefined) {
        throw new Error("OpenCode cannot compact while a turn is running.");
      }
      await this.client.post<unknown>(openCodeRoutes.summarize(this.state.openCodeSessionId), {
        timeoutMs: COMPACTION_TIMEOUT_MS,
        body: {
          providerID: parsedModel.providerID,
          modelID: parsedModel.modelID,
          auto: false
        } satisfies SummarizeBody
      });
    });
  }

  async readThread(): Promise<ThreadSnapshot> {
    return toThreadSnapshot(
      this.state.threadId,
      await this.listMessages(this.state.openCodeSessionId)
    );
  }

  /**
   * §4.5 "Rollback forks, deliberately not `session.revert`" — native revert
   * also rewrites workspace files, and this design keeps file restore out of a
   * revert (§5.5). The fork is verified to have kept exactly the expected
   * message count and errors otherwise, then the ruleset is re-applied and a
   * new cursor minted.
   *
   * With `target` the cut starts at the turn the host NAMED and `numTurns` is
   * not consulted. Every turn id the fold holds for this adapter is an
   * OpenCode message id — a replayed turn's is its assistant message or a
   * trailing unanswered prompt (`toThreadSnapshot`), a live turn's is the
   * prompt that opened it (`sendTurn`) — so it is looked up in the message
   * list itself, followed through this session's earlier rollback forks. A
   * count cannot stand in for it: the snapshot has a turn per ASSISTANT
   * message and a turn that ran tools writes several. An id that is not
   * there is a refusal, never a guess. Without `target` (a caller that
   * predates it) the cut is `turns[turns.length - numTurns]`. Either way the
   * fork lands on the user message that opens the boundary turn.
   */
  async rollbackThread(numTurns: number, target?: RollbackTarget): Promise<ThreadSnapshot> {
    return await this.promptLock.run(async () => {
      let boundaryId: string;
      if (target !== undefined) {
        boundaryId =
          this.forkedMessageIds.get(target.firstRemovedTurnId) ?? target.firstRemovedTurnId;
      } else {
        const snapshot = await this.readThread();
        const targetIndex = Math.max(0, snapshot.turns.length - numTurns);
        const turn = snapshot.turns[targetIndex];
        if (turn === undefined) {
          return snapshot;
        }
        boundaryId = turn.id;
      }
      const list = await this.listMessages(this.state.openCodeSessionId);
      const targetMessageIndex = list.findIndex((entry) => entry.info?.id === boundaryId);
      if (targetMessageIndex < 0) {
        throw new Error(
          target !== undefined
            ? "opencode: the turn to rewind to is no longer in this session"
            : "The OpenCode rewind boundary is no longer available."
        );
      }
      const head = list.slice(0, targetMessageIndex + 1);
      let firstRemoved = list[targetMessageIndex];
      for (let index = head.length - 1; index >= 0; index -= 1) {
        const entry = head[index];
        if (entry?.info?.role === "user") {
          firstRemoved = entry;
          break;
        }
      }
      if (firstRemoved === undefined) {
        throw new Error("The OpenCode rewind boundary is no longer available.");
      }
      const expectedCount = list.indexOf(firstRemoved);

      const fork = await this.client.post<OpenCodeSessionInfo>(
        openCodeRoutes.fork(this.state.openCodeSessionId),
        {
          timeoutMs: AGENT_HOST_DEADLINES.sessionOpenMs,
          body: {
            messageID: firstRemoved.info.id,
            directory: this.state.directory
          } satisfies ForkBody
        }
      );
      if (fork === undefined || typeof fork.id !== "string") {
        throw new Error("OpenCode session fork returned no session payload.");
      }
      const forked = await this.listMessages(fork.id);
      if (forked.length !== expectedCount) {
        throw new Error("OpenCode did not preserve the requested rewind boundary.");
      }
      await this.client.patch<unknown>(openCodeRoutes.session(fork.id), {
        timeoutMs: AGENT_HOST_DEADLINES.sessionOpenMs,
        body: {
          permission: buildOpenCodePermissionRules(this.state.runtimeMode)
        } satisfies UpdateSessionBody
      });

      this.rememberFork(list, forked);
      await this.settlePendingRequests().catch(() => undefined);
      repointSession(this.state, fork.id);
      this.updateRecord({ status: "ready" }, { activeTurnId: true });
      this.emit({
        ...this.base({}),
        type: "thread.started",
        payload: { providerThreadId: fork.id }
      });
      return {
        threadId: this.state.threadId,
        turns: forked
          .filter((entry) => entry?.info?.role === "assistant")
          .map((entry) => ({
            id: entry.info.id,
            items: [entry.info, ...((entry.parts ?? []) as OpenCodePart[])] as unknown[]
          }))
      };
    });
  }

  private async listMessages(sessionId: string): Promise<OpenCodeMessageWithParts[]> {
    const messages = await this.client.get<OpenCodeMessageWithParts[]>(
      openCodeRoutes.messages(sessionId),
      { timeoutMs: AGENT_HOST_DEADLINES.sessionOpenMs }
    );
    return Array.isArray(messages) ? messages : [];
  }

  /**
   * Carry `forkedMessageIds` across a rollback fork. The fork holds `source`'s
   * messages before the boundary, in order, under fresh ids (fixtures README
   * observation 17), so the mapping is positional — and taken only when every
   * position's role agrees, or nothing carries over and a rewind to a turn
   * this one kept refuses. A message the fork cut drops out, and so does the
   * pre-fork spelling of one the map already names by its original id.
   */
  private rememberFork(
    source: readonly OpenCodeMessageWithParts[],
    fork: readonly OpenCodeMessageWithParts[]
  ): void {
    const moved = new Map<string, string>();
    const aligned = fork.every((entry, index) => {
      const from = source[index]?.info;
      return (
        typeof entry?.info?.id === "string" &&
        typeof from?.id === "string" &&
        entry.info.role === from.role
      );
    });
    if (aligned) {
      fork.forEach((entry, index) => moved.set(source[index]!.info.id, entry.info.id));
    }
    const carried = new Map<string, string>();
    for (const [named, current] of this.forkedMessageIds) {
      const next = moved.get(current);
      if (next !== undefined) {
        carried.set(named, next);
        moved.delete(current);
      }
    }
    for (const [from, to] of moved) {
      carried.set(from, to);
    }
    this.forkedMessageIds = carried;
  }
}

// ---------------------------------------------------------------------------
// Free helpers
// ---------------------------------------------------------------------------

function addRelated(state: OpenCodeSessionState, sessionId: string): void {
  state.relatedSessionIds.add(sessionId);
  if (state.activeTurnId !== undefined && state.turnTokenUsage !== undefined) {
    state.turnTokenUsage.hasSubagents = true;
  }
}

function makeCancellation(turnId: string | undefined): OpenCodeCancellation {
  const ack = deferred<void>();
  const done = deferred<void>();
  return {
    ...(turnId !== undefined ? { turnId } : {}),
    acknowledged: false,
    turnSettled: false,
    acknowledgment: ack.promise,
    acknowledge: () => ack.resolve(),
    completion: done.promise,
    complete: (error?: unknown) => {
      if (error !== undefined) {
        done.reject(error);
      } else {
        done.resolve();
      }
    }
  };
}

/**
 * `GET /session/:id/message` → the §4.1 snapshot.
 *
 * A **turn is keyed on the assistant message**, because that is the unit
 * `rollbackThread`'s count path counts: `numTurns` means exchanges, and keying
 * on every message would make `rollback(2)` remove one exchange instead of
 * two. (An exchange that ran tools still spans several assistant messages,
 * which is why a rewind by turn ID never counts.) A replayed turn's id — this
 * key — is what the fold keeps, so it is also what a rewind names.
 *
 * Each turn's `items` additionally carry the **user message that prompted it**
 * — `parentID` links them, and OpenCode can answer one prompt with several
 * assistant messages, so the prompt is attached to the first of them only. A
 * trailing prompt with no answer yet becomes a turn of its own, or replaying
 * the history would silently lose the last thing the user said.
 *
 * `items` is `unknown[]` by contract; `history.ts` is the only reader that
 * knows this shape.
 */
export function toThreadSnapshot(
  threadId: string,
  messages: readonly OpenCodeMessageWithParts[]
): ThreadSnapshot {
  const byId = new Map<string, OpenCodeMessageWithParts>();
  for (const entry of messages) {
    if (typeof entry?.info?.id === "string") {
      byId.set(entry.info.id, entry);
    }
  }

  const turns: ThreadSnapshot["turns"] = [];
  const answeredPrompts = new Set<string>();
  const claimedPrompts = new Set<string>();

  for (const entry of messages) {
    if (entry?.info?.role !== "assistant") {
      continue;
    }
    const parentId = entry.info.parentID;
    const items: unknown[] = [];
    if (typeof parentId === "string") {
      answeredPrompts.add(parentId);
      const prompt = byId.get(parentId);
      // Only the FIRST assistant message of a prompt carries it, so a
      // multi-message answer does not replay the user's text twice.
      if (prompt !== undefined && !claimedPrompts.has(parentId)) {
        claimedPrompts.add(parentId);
        items.push(prompt.info, ...((prompt.parts ?? []) as OpenCodePart[]));
      }
    }
    items.push(entry.info, ...((entry.parts ?? []) as OpenCodePart[]));
    turns.push({ id: entry.info.id, items });
  }

  const last = messages.at(-1);
  if (last?.info?.role === "user" && !answeredPrompts.has(last.info.id)) {
    turns.push({
      id: last.info.id,
      items: [last.info, ...((last.parts ?? []) as OpenCodePart[])]
    });
  }

  return { threadId, turns };
}

/**
 * Two directory spellings name the same location. Raw equality misreads a
 * trailing slash or a `.` segment as a cwd change and needlessly forks the
 * session on every resume.
 */
export function sameDirectory(left: string | undefined, right: string): boolean {
  if (left === undefined || left.length === 0) {
    return true;
  }
  return normalizeDir(left) === normalizeDir(right);
}

function normalizeDir(value: string): string {
  const trimmed = value.replace(/\/+$/, "");
  return trimmed.length === 0 ? "/" : trimmed;
}

/** Answers are keyed by `question-<index>-<header-slug>`, then by header/text. */
export function toQuestionAnswers(
  request: OpenCodeQuestionRequest | undefined,
  answers: Record<string, unknown>
): string[][] {
  if (request === undefined) {
    return Object.values(answers).map((value) => toAnswerList(value));
  }
  return request.questions.map((question, index) => {
    const slug = `question-${index}-${(question.header ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")}`;
    const raw =
      answers[slug] ??
      answers[`question-${index}`] ??
      answers[question.header ?? ""] ??
      answers[question.question ?? ""];
    return toAnswerList(raw);
  });
}

function toAnswerList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  if (typeof value === "string") {
    return value.trim().length > 0 ? [value] : [];
  }
  return [];
}

function describeReason(reason: { kind: string }): string {
  return reason.kind === "exit" ? "exited" : reason.kind === "signal" ? "was killed" : "failed";
}
