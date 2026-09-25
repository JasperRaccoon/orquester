/**
 * Agent host — the OpenCode frame normaliser (spec §4.2, §4.5 OpenCode).
 *
 * Ported from T3 Code (MIT):
 * `apps/server/src/provider/Layers/OpenCodeAdapter.ts:2215-2660` (the child
 * routing filter and the SSE switch), translated from Effect into a pure
 * function over {@link OpenCodeSessionState}.
 *
 * **Pure on purpose.** One frame in, `{events, signals}` out; nothing here
 * touches the network, a timer or a process. That is what lets
 * `normalize.replay.test.ts` fold a real captured `*.ndjson` through it and
 * assert the emitted `RuntimeEvent` sequence, and it keeps the three
 * completion machines (which *do* need HTTP) in `session.ts` where their
 * deadlines live.
 *
 * There are **two** demuxes, both ending in `satisfies never` (§10): `demux`
 * for the thread's own session and `demuxChild` for its subagents. An unmapped
 * provider message is a typecheck error, and at runtime an unknown frame is
 * surfaced as `runtime.warning` — never swallowed by a catch-all, never ending
 * an active turn. `server.heartbeat` and the 37 dormant `session.next.*` /
 * `*.v2.*` members are allow-listed as "known, ignored" rather than warned
 * about every ten seconds (fixtures README observation 18).
 *
 * *differs from T3:* it keeps only a child's permission and question frames and
 * drops the other 38 (fixture 12), which is why its OpenCode roster is thin.
 * Here a child session becomes a `task.*` row set and its own work is stamped
 * with `agentId`, so §7.6's roster shows what the provider actually reports
 * while §7.2's re-homing keeps it out of the parent timeline.
 */

import type {
  CanonicalItemType,
  RuntimeEvent,
  RuntimeEventBase,
  RuntimeItemStatus,
  RuntimeTaskCompletedStatus,
  RuntimeTaskStatus,
  TaskAgentLinkage,
  ToolLifecycleItemType,
  UserInputQuestion
} from "@orquester/api/agent-chat";

import {
  KNOWN_IGNORED_EVENT_TYPES,
  asHandledEvent,
  eventSessionId,
  isHandledEventType,
  isRecord,
  isRequestEventType,
  type OpenCodeHandledEvent,
  type OpenCodePart,
  type OpenCodePermissionRequest,
  type OpenCodeQuestionRequest,
  type OpenCodeRawEvent
} from "./protocol.ts";
import {
  approvalOptionsFor,
  fromOpenCodePermissionReply,
  mapPermissionToRequestType,
  permissionDetail
} from "./ruleset.ts";
import {
  accumulateStepUsage,
  addRelatedSession,
  advanceOutputMark,
  claimPrompt,
  finalOutputRemainder,
  isCutFinalOutput,
  mergeOpenCodeAssistantText,
  messageRoleForPart,
  openTurn,
  stepTotalTokens,
  type OpenCodeChildAgent,
  type OpenCodeSessionState,
  type OpenCodeStepUsage,
  type OpenCodeTextPartState
} from "./state.ts";

// ---------------------------------------------------------------------------
// Signals — what the runtime must act on
// ---------------------------------------------------------------------------

/**
 * A frame the normaliser decoded but cannot finish handling without doing I/O
 * (an HTTP poll, an ancestry lookup, a permission reply). The runtime in
 * `session.ts` owns every one of these, with its own deadline.
 */
export type NormalizerSignal =
  /** `session.status: busy|retry` for the active turn. */
  | { kind: "status-busy" }
  /** `session.status: idle` for the active turn — machine (2)/(3) decide. */
  | { kind: "status-idle"; raw: unknown }
  /** `session.idle`, which after an abort is the ONLY idle signal (obs. 6). */
  | { kind: "session-idle"; raw: unknown }
  /** The client-minted user message came back — prompt admission is confirmed. */
  | { kind: "user-message-observed"; messageId: string }
  /** Full access: answer this ask `once`, never `always` (§4.3). */
  | { kind: "auto-reply-permission"; request: OpenCodePermissionRequest; raw: unknown }
  /** `MessageAbortedError` — the abort acknowledgement arrived on the stream. */
  | { kind: "abort-acknowledged" }
  /** The turn failed on a `session.error`; requests need a recovery sweep. */
  | { kind: "turn-failed"; message: string }
  /** A request event from a session whose ancestry is not yet known. */
  | { kind: "ancestry-probe"; sessionId: string; raw: OpenCodeRawEvent }
  /** `session.compacted` landed; the thread state event has already been emitted. */
  | { kind: "compacted" }
  /**
   * A reply the host never started began while no turn ran — the parent
   * woken by a background `task` call's answer — and opened turn `turnId`
   * (`claimReply`); its `turn.started` has already been emitted.
   */
  | { kind: "turn-woken"; turnId: string };

export interface NormalizeResult {
  events: RuntimeEvent[];
  signals: NormalizerSignal[];
}

export interface NormalizeContext {
  eventId: () => string;
  nowIso: () => string;
}

// ---------------------------------------------------------------------------
// Small mappers
// ---------------------------------------------------------------------------

/** *T3: `OpenCodeAdapter.ts:506-539`.* */
export function toToolLifecycleItemType(toolName: string): ToolLifecycleItemType {
  const normalized = toolName.toLowerCase();
  if (normalized === "todowrite" || normalized === "todoread") {
    return "dynamic_tool_call";
  }
  if (normalized.includes("bash") || normalized.includes("command")) {
    return "command_execution";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("patch") ||
    normalized.includes("multiedit")
  ) {
    return "file_change";
  }
  if (normalized.includes("web")) {
    return "web_search";
  }
  if (normalized.includes("mcp")) {
    return "mcp_tool_call";
  }
  if (normalized.includes("image")) {
    return "image_view";
  }
  if (
    normalized.includes("task") ||
    normalized.includes("agent") ||
    normalized.includes("subtask")
  ) {
    return "collab_agent_tool_call";
  }
  return "dynamic_tool_call";
}

/**
 * The question id the UI answers by. Stable per `(index, header)` so an
 * answered card still renders after a reload.
 *
 * *T3: `opencodeRuntime.ts:439-448`.*
 */
export function openCodeQuestionId(index: number, header: string): string {
  const slug = header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-");
  return slug.length > 0 ? `question-${index}-${slug}` : `question-${index}`;
}

export function normalizeQuestions(request: OpenCodeQuestionRequest): UserInputQuestion[] {
  return request.questions.map((question, index) => ({
    id: openCodeQuestionId(index, question.header ?? ""),
    header: question.header ?? "",
    question: question.question ?? "",
    options: (question.options ?? []).map((option) => ({
      label: option.label,
      description: option.description ?? ""
    })),
    ...(question.multiple === true ? { multiSelect: true } : {})
  }));
}

/**
 * 1.18.5's `session.error` envelope is `{name, data:{message}}`, and `name` is
 * always `UnknownError` — the real class (`ProviderModelNotFoundError`) only
 * appears inside the message, sometimes behind a full bun stack trace
 * (fixtures README observation 13). Truncate before it reaches the user.
 */
export function sessionErrorMessage(error: unknown): string {
  if (!isRecord(error)) {
    return "OpenCode session failed.";
  }
  const data = isRecord(error.data) ? error.data : undefined;
  const raw = typeof data?.message === "string" ? data.message : undefined;
  const text = raw?.trim();
  if (text === undefined || text.length === 0) {
    return "OpenCode session failed.";
  }
  // A stack trace begins on its own line with `at …`; keep the sentence.
  const firstFrame = text.search(/\n\s+at\s/);
  const head = firstFrame === -1 ? text : text.slice(0, firstFrame);
  return head.length > 600 ? `${head.slice(0, 600)}…` : head;
}

/**
 * `Model not found: x` and `ProviderModelNotFoundError: Model not found: x`
 * are the same failure. The class prefix is what 1.18.5 adds on the re-emit,
 * so it is stripped for comparison only — never from what the user reads.
 */
function dedupeKey(message: string): string {
  return message.replace(/^[A-Za-z][A-Za-z0-9_]*Error:\s*/, "").trim();
}

function isAbortError(error: unknown): boolean {
  return isRecord(error) && error.name === "MessageAbortedError";
}

function isoFromEpochMs(value: number | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function toolDetail(part: Extract<OpenCodePart, { type: "tool" }>): string | undefined {
  switch (part.state.status) {
    case "completed":
      return part.state.output;
    case "error":
      return part.state.error;
    case "running":
      return part.state.title;
    default:
      return undefined;
  }
}

function toolCreatedAt(part: Extract<OpenCodePart, { type: "tool" }>): string | undefined {
  switch (part.state.status) {
    case "running":
      return isoFromEpochMs(part.state.time?.start);
    case "completed":
    case "error":
      return isoFromEpochMs(part.state.time?.end);
    default:
      return undefined;
  }
}

const DEFAULT_TITLE_PATTERN = /^(?:untitled|new session|session \d+)$/i;

function sessionTitle(info: { title?: string }): string | undefined {
  const title = info.title?.trim();
  if (title === undefined || title.length === 0 || DEFAULT_TITLE_PATTERN.test(title)) {
    return undefined;
  }
  return title;
}

// ---------------------------------------------------------------------------
// The normaliser
// ---------------------------------------------------------------------------

class Emitter {
  readonly events: RuntimeEvent[] = [];
  readonly signals: NormalizerSignal[] = [];

  constructor(
    private readonly state: OpenCodeSessionState,
    private readonly ctx: NormalizeContext
  ) {}

  base(input: {
    turnId?: string | undefined;
    itemId?: string | undefined;
    requestId?: string | undefined;
    /**
     * The owning subagent. Set on EVERY event decoded from a child session, so
     * §7.2's re-homing rule keeps the child's own work out of the parent
     * timeline and in the roster's drill-in instead.
     */
    agentId?: string | undefined;
    createdAt?: string | undefined;
    raw?: unknown;
  }): RuntimeEventBase {
    return {
      eventId: this.ctx.eventId(),
      threadId: this.state.threadId,
      createdAt: input.createdAt ?? this.ctx.nowIso(),
      ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
      ...(input.itemId !== undefined ? { itemId: input.itemId } : {}),
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
      providerRefs: {
        providerTurnId: input.agentId ?? this.state.openCodeSessionId
      },
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

  push(event: RuntimeEvent): void {
    this.events.push(event);
  }

  signal(signal: NormalizerSignal): void {
    this.signals.push(signal);
  }
}

/**
 * Fold one frame off `GET /event` into runtime events plus the signals the
 * runtime must act on. Mutates `state`.
 */
export function normalizeOpenCodeEvent(
  state: OpenCodeSessionState,
  raw: OpenCodeRawEvent,
  ctx: NormalizeContext
): NormalizeResult {
  const out = new Emitter(state, ctx);

  // ---- routing (T3: OpenCodeAdapter.ts:2215-2265) -------------------------
  const payloadSessionId = eventSessionId(raw);

  if (raw.type === "session.created" || raw.type === "session.updated") {
    const info = isRecord(raw.properties) ? raw.properties.info : undefined;
    if (
      isRecord(info) &&
      typeof info.id === "string" &&
      typeof info.parentID === "string" &&
      state.relatedSessionIds.has(info.parentID)
    ) {
      addRelatedSession(state, info.id);
    }
  } else if (raw.type === "session.deleted") {
    const info = isRecord(raw.properties) ? raw.properties.info : undefined;
    if (isRecord(info) && typeof info.id === "string") {
      state.relatedSessionIds.delete(info.id);
    }
  }

  const isParentEvent = payloadSessionId === state.openCodeSessionId;
  let knownPendingTerminal = false;
  if (
    payloadSessionId !== undefined &&
    !state.relatedSessionIds.has(payloadSessionId) &&
    isRequestEventType(raw.type)
  ) {
    const requestId = isRecord(raw.properties)
      ? typeof raw.properties.requestID === "string"
        ? raw.properties.requestID
        : typeof raw.properties.id === "string"
          ? raw.properties.id
          : undefined
      : undefined;
    if (raw.type === "permission.asked" || raw.type === "question.asked") {
      out.signal({ kind: "ancestry-probe", sessionId: payloadSessionId, raw });
      return { events: out.events, signals: out.signals };
    }
    knownPendingTerminal =
      requestId !== undefined &&
      (state.pendingPermissions.has(requestId) || state.pendingQuestions.has(requestId));
    if (!knownPendingTerminal) {
      out.signal({ kind: "ancestry-probe", sessionId: payloadSessionId, raw });
      return { events: out.events, signals: out.signals };
    }
  }

  const isChildRequestEvent =
    payloadSessionId !== undefined &&
    isRequestEventType(raw.type) &&
    (state.relatedSessionIds.has(payloadSessionId) || knownPendingTerminal);

  /**
   * A non-request frame from a child session of this thread.
   *
   * *differs from T3* (`OpenCodeAdapter.ts:2215-2265`), which drops every
   * child frame that is not a permission or a question — the reason its
   * OpenCode roster is thinner than Claude's. Fixture 12 shows the child is
   * fully observable (38 frames across eight types), so those frames are
   * routed into `demuxChild` and become the roster's `task.*` rows plus the
   * child's own `agentId`-stamped items. Request frames keep the old path,
   * because an approval belongs on the parent thread whichever session raised
   * it.
   */
  const isChildOwnEvent =
    payloadSessionId !== undefined &&
    !isParentEvent &&
    !isChildRequestEvent &&
    state.relatedSessionIds.has(payloadSessionId);

  // A frame with no session id at all is startup chatter (`plugin.added`,
  // `catalog.updated`, `server.*`) — it belongs to no thread by design
  // (fixtures README observation 19). It is triaged as known-ignored below.
  if (payloadSessionId !== undefined && !isParentEvent && !isChildRequestEvent && !isChildOwnEvent) {
    return { events: out.events, signals: out.signals };
  }

  if (isChildOwnEvent && payloadSessionId !== undefined) {
    const childEvent = triage(state, raw, out);
    if (childEvent !== null) {
      demuxChild(state, childEvent, raw, payloadSessionId, out);
    }
    return { events: out.events, signals: out.signals };
  }

  // Parent output that arrives after an interruption must not reopen the turn.
  const suppressInterruptedOutput =
    isParentEvent &&
    ((state.activeTurnId === undefined &&
      (state.interruptedTurnId !== undefined || state.reconcileIdleStatus)) ||
      state.awaitingBusyAfterInterruption) &&
    (raw.type === "message.part.delta" ||
      raw.type === "message.part.updated" ||
      raw.type === "todo.updated" ||
      (raw.type === "message.updated" &&
        isRecord(raw.properties) &&
        isRecord(raw.properties.info) &&
        raw.properties.info.role === "assistant"));
  if (suppressInterruptedOutput) {
    return { events: out.events, signals: out.signals };
  }

  const event = triage(state, raw, out);
  if (event === null) {
    return { events: out.events, signals: out.signals };
  }

  demux(state, event, raw, out);
  return { events: out.events, signals: out.signals };
}

/**
 * §10: known-ignored vs unknown. An unknown frame is **surfaced** as a
 * `runtime.warning` — which never ends an active turn — and never dropped by a
 * catch-all. Shared by the parent and the child paths so a child cannot
 * silently swallow a frame the parent would have warned about.
 */
function triage(
  state: OpenCodeSessionState,
  raw: OpenCodeRawEvent,
  out: Emitter
): OpenCodeHandledEvent | null {
  if (!isHandledEventType(raw.type)) {
    if (!KNOWN_IGNORED_EVENT_TYPES.has(raw.type)) {
      out.push({
        ...out.base({ turnId: state.activeTurnId, raw }),
        type: "runtime.warning",
        payload: {
          message: `OpenCode sent an unknown event '${raw.type}'.`,
          detail: raw.properties
        }
      });
    }
    return null;
  }

  const event = asHandledEvent(raw);
  if (event === null) {
    out.push({
      ...out.base({ turnId: state.activeTurnId, raw }),
      type: "runtime.warning",
      payload: {
        message: `OpenCode sent a '${raw.type}' frame in an unrecognised shape.`,
        detail: raw.properties
      }
    });
  }
  return event;
}

function demux(
  state: OpenCodeSessionState,
  event: OpenCodeHandledEvent,
  raw: OpenCodeRawEvent,
  out: Emitter
): void {
  const turnId = state.activeTurnId;

  switch (event.type) {
    case "session.created":
      return;

    case "session.updated": {
      const title = sessionTitle(event.properties.info);
      // `session.updated` re-states the title on EVERY recompute — a real turn
      // against `opencode/big-pickle` produced four identical frames — so only
      // a genuine change is mirrored onto the thread.
      if (
        title !== undefined &&
        title !== state.lastEmittedTitle &&
        event.properties.info.id === state.openCodeSessionId
      ) {
        state.lastEmittedTitle = title;
        out.push({
          ...out.base({ raw }),
          type: "thread.metadata.updated",
          payload: { name: title }
        });
      }
      return;
    }

    case "session.deleted":
      return;

    case "session.compacted": {
      out.push({
        ...out.base({ turnId, raw }),
        type: "thread.state.changed",
        payload: { state: "compacted" }
      });
      out.signal({ kind: "compacted" });
      return;
    }

    case "message.updated": {
      const info = event.properties.info;
      const admission = state.promptAdmission;
      if (info.role === "user" && admission?.messageId === info.id) {
        admission.messageObserved = true;
        out.signal({ kind: "user-message-observed", messageId: info.id });
      }
      // Read before the role is recorded: a reply begins on its first frame.
      const firstSighting = !state.messageRoleById.has(info.id);
      state.messageRoleById.set(info.id, info.role);
      if (info.role === "user") {
        state.textPartsByMessageId.delete(info.id);
      }
      if (info.role === "assistant") {
        if (firstSighting) {
          claimReply(state, info, raw, out);
        }
        // The turn the reply belongs to, which it may just have opened.
        const replyTurnId = state.activeTurnId;
        emitContextWindow(
          state,
          resolveAssistantOwnership(state, info.id, info.parentID),
          replyTurnId,
          raw,
          out
        );
        for (const part of state.textPartsByMessageId.get(info.id)?.values() ?? []) {
          emitTextDelta(part, replyTurnId, raw, out);
        }
      }
      return;
    }

    case "message.removed": {
      state.messageRoleById.delete(event.properties.messageID);
      state.textPartsByMessageId.delete(event.properties.messageID);
      dropMessageOutputMarks(state, event.properties.messageID);
      return;
    }

    case "message.part.removed": {
      const parts = state.textPartsByMessageId.get(event.properties.messageID);
      parts?.delete(event.properties.partID);
      if (parts?.size === 0) {
        state.textPartsByMessageId.delete(event.properties.messageID);
      }
      state.outputMarks.delete(event.properties.partID);
      return;
    }

    case "message.part.delta": {
      const existing = state.textPartsByMessageId
        .get(event.properties.messageID)
        ?.get(event.properties.partID);
      // `existing.text === undefined` is the guard, NOT truthiness: the opening
      // snapshot has `text: ""`, and a truthiness check would drop the first
      // delta of every part (fixtures README observation 4).
      if (existing === undefined || existing.text === undefined) {
        return;
      }
      if (event.properties.field !== "text") {
        return;
      }
      if (messageRoleForPart(state, existing) !== "assistant") {
        return;
      }
      const delta = event.properties.delta;
      if (delta.length === 0) {
        return;
      }
      const previous = existing.emittedText ?? existing.text;
      const nextText = previous + delta;
      existing.emittedText = nextText;
      existing.text = nextText;
      out.push({
        ...out.base({ turnId, itemId: existing.id, raw }),
        type: "content.delta",
        payload: {
          // The stream kind comes from the PART's type. `field:"text"` deltas
          // also carry `reasoning` parts (fixtures README observation 4).
          streamKind: existing.type === "reasoning" ? "reasoning_text" : "assistant_text",
          delta
        }
      });
      return;
    }

    case "message.part.updated": {
      const part = event.properties.part;
      const role = messageRoleForPart(state, part) ?? (part.type === "tool" ? "assistant" : undefined);

      if (part.type === "step-finish" && turnId !== undefined && state.turnTokenUsage) {
        emitContextWindow(
          state,
          accumulateStepPart(state, part as Extract<OpenCodePart, { type: "step-finish" }>),
          turnId,
          raw,
          out
        );
      }

      takeBackgroundResult(state, part, raw, out);

      if ((part.type === "text" || part.type === "reasoning") && role !== "user") {
        const textPart = part as Extract<OpenCodePart, { type: "text" | "reasoning" }>;
        const stored = retainTextPart(state, textPart);
        if (role === "assistant") {
          emitTextDelta(stored, turnId, raw, out);
        }
      } else {
        const previous = state.textPartsByMessageId.get(part.messageID)?.get(part.id);
        if (previous !== undefined) {
          // A non-text PATCH removes the current snapshot but KEEPS
          // `emittedText`, so a later text PATCH still emits only the suffix.
          previous.text = undefined;
        }
      }

      if (part.type === "tool") {
        const tool = part as Extract<OpenCodePart, { type: "tool" }>;
        // Output first: a completion closes the call's output buffer.
        emitCommandOutput(state, tool, turnId, raw, out);
        emitToolItem(tool, turnId, raw, out);
        if (tool.tool === "task") {
          // The parent's own row stays on the timeline; the child it names
          // additionally becomes a roster task (§7.6).
          linkChildFromTaskPart(state, tool, raw, out);
        }
      }
      return;
    }

    case "permission.asked": {
      openPermission(state, event.properties, raw, out);
      return;
    }

    case "permission.replied": {
      resolveRequest(state, event.properties.requestID);
      emitTerminalPermission(
        state,
        event.properties.requestID,
        fromOpenCodePermissionReply(event.properties.reply),
        raw,
        out
      );
      return;
    }

    case "question.asked": {
      openQuestion(state, event.properties, raw, out);
      return;
    }

    case "question.replied": {
      resolveRequest(state, event.properties.requestID);
      emitTerminalQuestion(state, event.properties.requestID, event.properties.answers, raw, out);
      return;
    }

    case "question.rejected": {
      resolveRequest(state, event.properties.requestID);
      emitTerminalQuestion(state, event.properties.requestID, undefined, raw, out);
      return;
    }

    case "todo.updated": {
      if (turnId === undefined) {
        return;
      }
      out.push({
        ...out.base({ turnId, raw }),
        type: "turn.plan.updated",
        payload: {
          plan: event.properties.todos
            .filter((todo) => todo.status !== "cancelled")
            .map((todo) => ({
              step: todo.content?.trim().length > 0 ? todo.content.trim() : "Task",
              status:
                todo.status === "completed"
                  ? ("completed" as const)
                  : todo.status === "in_progress"
                    ? ("inProgress" as const)
                    : ("pending" as const)
            }))
        }
      });
      return;
    }

    case "command.executed": {
      // `messageID` here is the ASSISTANT message, not the client-minted user
      // id (fixtures README observation 15) — never match admission on it.
      out.push({
        ...out.base({ turnId, raw }),
        type: "item.completed",
        payload: {
          itemType: "dynamic_tool_call",
          status: "completed",
          title: `/${event.properties.name}`,
          ...(event.properties.arguments !== undefined && event.properties.arguments.length > 0
            ? { detail: event.properties.arguments }
            : {})
        }
      });
      return;
    }

    case "session.status": {
      const status = event.properties.status;
      if (status.type === "busy" || status.type === "retry") {
        // A run is going, whoever started it: the evidence a reply the host
        // never started needs before it opens a turn (`claimReply`).
        state.parentBusy = true;
        if (turnId !== undefined) {
          out.signal({ kind: "status-busy" });
        }
        if (status.type === "retry") {
          out.push({
            ...out.base({ turnId, raw }),
            type: "runtime.warning",
            payload: {
              message: `OpenCode retry ${status.attempt ?? 1}: ${status.message ?? "retrying"}`,
              detail: status
            }
          });
        }
        return;
      }
      if (status.type === "idle") {
        state.parentBusy = false;
        if (turnId !== undefined) {
          out.signal({ kind: "status-idle", raw });
        }
      }
      return;
    }

    case "session.idle": {
      state.parentBusy = false;
      // After an abort this is the ONLY idle signal — no `session.status`
      // follows (fixtures README observation 6).
      if (state.activeTurnId !== undefined) {
        out.signal({ kind: "session-idle", raw });
      }
      return;
    }

    case "session.error": {
      const error = event.properties.error;
      const message = sessionErrorMessage(error);
      const activeTurnId = state.activeTurnId;
      const cancellation = state.cancellation;

      if (isAbortError(error)) {
        if (cancellation !== undefined && cancellation.turnId === undefined) {
          out.signal({ kind: "abort-acknowledged" });
          return;
        }
        if (activeTurnId !== undefined && cancellation?.turnId === activeTurnId) {
          out.signal({ kind: "abort-acknowledged" });
          return;
        }
        if (state.interruptedTurnId !== undefined || state.reconcileIdleStatus) {
          return;
        }
      }

      // One bad model produces THREE frames, two of them re-stating the same
      // failure with the real class in front of it and a full bun stack trace
      // behind it (fixtures README observation 13). Collapse them on a key
      // that ignores that class prefix, and keep the FIRST (cleanest) text.
      const key = dedupeKey(message);
      if (state.lastSessionErrorMessage === key) {
        return;
      }
      state.lastSessionErrorMessage = key;

      out.signal({ kind: "turn-failed", message });
      out.push({
        ...out.base({ raw }),
        type: "runtime.error",
        payload: { message, class: "provider_error", detail: error }
      });
      return;
    }

    default: {
      const exhaustive: never = event;
      void exhaustive;
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Subagents (§4.2 tasks, §7.6 roster)
// ---------------------------------------------------------------------------

/**
 * The linkage block. §4.2 requires it on **every** task row, not just
 * `task.started`, so a client fold can rebuild an agent whose start row aged
 * out of activity retention.
 *
 * `agentKind` is deliberately absent: the host stamps it at ingestion and does
 * not trust it from the provider. `taskType: "subagent"` is what makes
 * `classifyTaskAgentKind` resolve it to `"agent"`.
 */
function childLinkage(agent: OpenCodeChildAgent): TaskAgentLinkage {
  return {
    taskType: "subagent",
    agentId: agent.sessionId,
    ...(agent.title !== undefined ? { title: agent.title } : {}),
    ...(agent.role !== undefined ? { role: agent.role } : {}),
    ...(agent.model !== undefined ? { model: agent.model } : {}),
    ...(agent.toolUseId !== undefined ? { toolUseId: agent.toolUseId } : {}),
    ...(agent.parentAgentId !== undefined ? { parentAgentId: agent.parentAgentId } : {})
  };
}

function ensureChildAgent(
  state: OpenCodeSessionState,
  sessionId: string,
  seed: Partial<OpenCodeChildAgent> = {}
): OpenCodeChildAgent {
  const existing = state.childAgents.get(sessionId);
  if (existing !== undefined) {
    // Later frames only ever enrich: the parent's `task` part carries the
    // role, the model and the tool call, and arrives after `session.created`.
    if (seed.title !== undefined) {
      existing.title = seed.title;
    }
    if (seed.description !== undefined && seed.description.length > 0) {
      existing.description = seed.description;
    }
    if (seed.role !== undefined) {
      existing.role = seed.role;
    }
    if (seed.model !== undefined) {
      existing.model = seed.model;
    }
    // The launching call is set once, by the first part naming this child. A
    // later call is a relaunch, which `linkChildFromTaskPart` re-points
    // explicitly, or not this run's at all (a stale frame, a second call on a
    // live child) — adopting it here named the wrong call on every later row.
    if (seed.toolUseId !== undefined && existing.toolUseId === undefined) {
      existing.toolUseId = seed.toolUseId;
    }
    if (seed.parentAgentId !== undefined) {
      existing.parentAgentId = seed.parentAgentId;
    }
    return existing;
  }
  const created: OpenCodeChildAgent = {
    sessionId,
    parentSessionId: seed.parentSessionId ?? state.openCodeSessionId,
    ...(seed.title !== undefined ? { title: seed.title } : {}),
    description: seed.description ?? seed.title ?? "Subagent",
    ...(seed.role !== undefined ? { role: seed.role } : {}),
    ...(seed.model !== undefined ? { model: seed.model } : {}),
    ...(seed.toolUseId !== undefined ? { toolUseId: seed.toolUseId } : {}),
    ...(seed.parentAgentId !== undefined ? { parentAgentId: seed.parentAgentId } : {}),
    started: false,
    completed: false
  };
  state.childAgents.set(sessionId, created);
  return created;
}

/**
 * `task.started` once per RUN — a relaunch (`linkChildFromTaskPart`) resets
 * `started` — and every later row of the run is progress or an update.
 */
function emitTaskStarted(
  state: OpenCodeSessionState,
  agent: OpenCodeChildAgent,
  raw: unknown,
  out: Emitter
): void {
  if (agent.started) {
    return;
  }
  agent.started = true;
  out.push({
    ...out.base({ turnId: state.activeTurnId, agentId: agent.sessionId, raw }),
    type: "task.started",
    payload: {
      ...childLinkage(agent),
      taskId: agent.sessionId,
      description: agent.description
    }
  });
}

function emitTaskProgress(
  state: OpenCodeSessionState,
  agent: OpenCodeChildAgent,
  raw: unknown,
  out: Emitter,
  extra: { summary?: string; lastToolName?: string; status?: RuntimeTaskStatus } = {}
): void {
  if (agent.completed) {
    return;
  }
  emitTaskStarted(state, agent, raw, out);
  out.push({
    ...out.base({ turnId: state.activeTurnId, agentId: agent.sessionId, raw }),
    type: "task.progress",
    payload: {
      ...childLinkage(agent),
      taskId: agent.sessionId,
      description: agent.description,
      ...(extra.summary !== undefined ? { summary: extra.summary } : {}),
      ...(extra.lastToolName !== undefined ? { lastToolName: extra.lastToolName } : {}),
      ...(extra.status !== undefined ? { status: extra.status } : {})
    }
  });
}

/** A non-terminal status patch; repeated identical statuses are dropped. */
function emitTaskStatus(
  state: OpenCodeSessionState,
  agent: OpenCodeChildAgent,
  status: RuntimeTaskStatus,
  raw: unknown,
  out: Emitter
): void {
  if (agent.completed || agent.lastStatus === status) {
    return;
  }
  emitTaskStarted(state, agent, raw, out);
  agent.lastStatus = status;
  out.push({
    ...out.base({ turnId: state.activeTurnId, agentId: agent.sessionId, raw }),
    type: "task.updated",
    payload: {
      ...childLinkage(agent),
      taskId: agent.sessionId,
      status,
      description: agent.description
    }
  });
}

function emitTaskCompleted(
  state: OpenCodeSessionState,
  agent: OpenCodeChildAgent,
  status: RuntimeTaskCompletedStatus,
  raw: unknown,
  out: Emitter,
  summary?: string
): void {
  if (agent.completed) {
    return;
  }
  emitTaskStarted(state, agent, raw, out);
  agent.completed = true;
  out.push({
    ...out.base({ turnId: state.activeTurnId, agentId: agent.sessionId, raw }),
    type: "task.completed",
    payload: {
      ...childLinkage(agent),
      taskId: agent.sessionId,
      status,
      ...(summary !== undefined && summary.length > 0 ? { summary } : {})
    }
  });
}

/**
 * A result for a run that already ended: one more `task.completed` of that
 * run, the same linkage and the same `completed` its end had (the child's own
 * `session.idle` is the only thing that leaves a result pending), carrying the
 * result. The roster fold keeps a settled row's status and times and takes
 * the result from a later completion (`roster.ts`, the `task.completed` arm),
 * so it reopens nothing and every reader still reads `completed`.
 */
function emitTaskResult(
  state: OpenCodeSessionState,
  agent: OpenCodeChildAgent,
  raw: unknown,
  out: Emitter,
  result: string | undefined
): void {
  if (result === undefined || result.length === 0) {
    return;
  }
  out.push({
    ...out.base({ turnId: state.activeTurnId, agentId: agent.sessionId, raw }),
    type: "task.completed",
    payload: {
      ...childLinkage(agent),
      taskId: agent.sessionId,
      status: "completed",
      summary: result
    }
  });
}

/**
 * §3.1: "a dead child never leaves a running turn" — closing every live task
 * with `task.completed {status: "stopped"}`, which the roster folds to
 * `interrupted` (§7.6). Called by `session.ts` before `session.exited`, and
 * when a turn is interrupted or fails.
 */
export function closeLiveChildAgents(
  state: OpenCodeSessionState,
  ctx: NormalizeContext,
  reason?: string
): RuntimeEvent[] {
  const out = new Emitter(state, ctx);
  for (const agent of state.childAgents.values()) {
    if (!agent.completed) {
      emitTaskCompleted(state, agent, "stopped", undefined, out, reason);
    }
  }
  return out.events;
}

/** Are any subagents still live? Feeds §6.4's `backgroundLiveness`. */
export function hasLiveChildAgents(state: OpenCodeSessionState): boolean {
  for (const agent of state.childAgents.values()) {
    if (!agent.completed) {
      return true;
    }
  }
  return false;
}

/**
 * The parent's `task` tool part is where the child's identity lives: its
 * `state.metadata.sessionId` names the child, `state.input.subagent_type` its
 * role, `state.input.description` its label and `callID` the tool call it
 * belongs to. The **pending** frame carries none of that — only `running` and
 * later do. Its `running` frame is also where a child's run STARTS: the
 * child's own `session.created` comes just before it and emits nothing, so the
 * start carries the launching call — the id the roster fold needs to tell a
 * later relaunch from a late delivery.
 *
 * A `task` call with `task_id` resumes a child: it re-prompts the existing
 * session with no `session.created`, and its `running` frame names that child
 * under a NEW call (fixtures README observation 26).
 *
 * Its terminal frame carries the child's answer. The child's own
 * `session.idle` ends the run just BEFORE it (fixture 12, lines 179-180), so
 * the part gives that end its result — one more `task.completed` of the run,
 * once (`emitTaskResult`, fixtures README observation 27); a part that settles
 * first ends the run itself, with the result.
 */
function linkChildFromTaskPart(
  state: OpenCodeSessionState,
  part: Extract<OpenCodePart, { type: "tool" }>,
  raw: unknown,
  out: Emitter
): void {
  const metadata = isRecord(part.state.metadata) ? part.state.metadata : undefined;
  const childId = typeof metadata?.sessionId === "string" ? metadata.sessionId : undefined;
  if (childId === undefined || childId === state.openCodeSessionId) {
    return;
  }
  addRelatedSession(state, childId);

  // A call that is not the one this child's run was launched by. A live part
  // of a call never seen before, on a SETTLED child, is a relaunch: the run
  // reopens under the new call, and the tail below emits its start — whose
  // changed `toolUseId` is what reopens a terminal roster row — before any row
  // of the new run. Anything else is not this run's — a stale frame of an
  // earlier call, or a second call on a child that is still working, which
  // 1.18.32 hands to the running job and answers at once — and emits no task
  // row, so it can never end the run.
  const known = state.childAgents.get(childId);
  if (known !== undefined && known.toolUseId !== undefined && known.toolUseId !== part.callID) {
    const live = part.state.status === "pending" || part.state.status === "running";
    const settled = known.completed || known.lastStatus === "idle";
    const earlier = known.seenCallIds?.has(part.callID) === true;
    rememberCall(known, part.callID);
    if (!live || !settled || earlier) {
      return;
    }
    known.toolUseId = part.callID;
    known.started = false;
    known.completed = false;
    known.lastStatus = undefined;
    known.resultPending = false;
    known.pendingResult = undefined;
    known.answersInBackground = false;
  }

  const input = isRecord(part.state.input) ? part.state.input : undefined;
  const model = isRecord(metadata?.model) ? metadata.model : undefined;
  const parentSessionId =
    typeof metadata?.parentSessionId === "string"
      ? metadata.parentSessionId
      : state.openCodeSessionId;
  const agent = ensureChildAgent(state, childId, {
    parentSessionId,
    ...(typeof input?.description === "string" ? { description: input.description } : {}),
    ...(typeof input?.subagent_type === "string" ? { role: input.subagent_type } : {}),
    ...(typeof model?.providerID === "string" && typeof model.modelID === "string"
      ? { model: `${model.providerID}/${model.modelID}` }
      : {}),
    toolUseId: part.callID,
    // A grandchild's parent is the intermediate agent, not the thread.
    ...(parentSessionId !== state.openCodeSessionId ? { parentAgentId: parentSessionId } : {})
  });
  rememberCall(agent, part.callID);

  if (part.state.status === "completed" || part.state.status === "error") {
    // A call run in the BACKGROUND (`metadata.background: true`) completes at
    // once while the child works on; the child's own `session.idle` settles
    // it, and this answer ("still working") is no run's result.
    if (part.state.status === "completed" && metadata?.background === true) {
      // Its answer comes as a prompt to the parent (`takeBackgroundResult`).
      agent.answersInBackground = true;
      return;
    }
    const text =
      part.state.status === "completed" ? taskResultText(part.state.output) : part.state.error;
    if (!agent.completed) {
      emitTaskCompleted(
        state,
        agent,
        part.state.status === "completed" ? "completed" : "failed",
        raw,
        out,
        text
      );
      return;
    }
    // The child's own idle ended the run first (fixture 12, lines 179-180):
    // the part gives that end its result, and ends nothing itself.
    if (agent.resultPending === true) {
      agent.resultPending = false;
      emitTaskResult(state, agent, raw, out, text);
    }
    return;
  }
  emitTaskProgress(state, agent, raw, out, { status: "running" });
}

/**
 * The envelope the `task` tool wraps a child's answer in for the parent's
 * model: `<task id="<child session>" state="…">`, an optional `<summary>`,
 * then the text inside `<task_result>` (`<task_error>` for a failure).
 * Fixture 12 line 180 shows it on 1.18.5; 1.18.32's `TaskTool` builds the
 * same one (`Ur`, read from the source) for a part's output and for the
 * answer it prompts a background run's parent with.
 */
const TASK_OUTPUT_ENVELOPE = new RegExp(
  String.raw`^<task id="(?<id>[^"\n]*)" state="[^"\n]*">\n` +
    String.raw`(?:<summary>(?<summary>[\s\S]*?)</summary>\n)?` +
    String.raw`<(?<tag>task_result|task_error)>\n(?<text>[\s\S]*)\n</\k<tag>>\n</task>\s*$`
);

/**
 * The child an envelope names, its summary line when it has one, and the text
 * inside it — or nothing for any other shape.
 */
function taskEnvelopeOf(
  output: string
): { taskId: string; summary?: string; text: string } | undefined {
  const groups = TASK_OUTPUT_ENVELOPE.exec(output)?.groups;
  if (groups?.id === undefined || groups.text === undefined) {
    return undefined;
  }
  return {
    taskId: groups.id,
    ...(groups.summary !== undefined ? { summary: groups.summary } : {}),
    text: groups.text
  };
}

/**
 * The call description a background answer's summary names — 1.18.32 writes
 * `Background task completed: <description>` (or `failed`), the `task` call's
 * own `description` — or nothing for a summary of any other shape.
 */
const BACKGROUND_SUMMARY = /^Background task (?:completed|failed): (?<description>[\s\S]*)$/;

/**
 * What a child answered, out of its parent `task` part's output: the text
 * inside {@link TASK_OUTPUT_ENVELOPE}, because the roster shows what the child
 * said, not how the tool wrapped it. An output of any other shape is the
 * result as it stands — never dropped.
 */
export function taskResultText(output: string | undefined): string | undefined {
  if (output === undefined) {
    return undefined;
  }
  return taskEnvelopeOf(output)?.text ?? output;
}

/**
 * A background run's answer (fixtures README observation 27). 1.18.32's
 * `TaskTool` answers a call it runs in the BACKGROUND at once, "still
 * working" (`metadata.background`), and when the child's job settles it
 * prompts the session that called it with the answer
 * (`injectBackgroundResult`, read from the source, not captured): a user
 * message whose one text part is `synthetic` and wraps the answer in
 * {@link TASK_OUTPUT_ENVELOPE}, naming the child. That part is the run's
 * result, as a foreground call's own completion is: the run's end gets it
 * once (`resultPending`) — 1.18.32 publishes the child's `session.idle`
 * before the job completes and the prompt is written, so the end comes first
 * — or, defensively, the answer coming before it, that end carries it
 * (`pendingResult`). Both are written before any reply to the prompt opens a
 * turn (`claimReply` opens at the reply), so neither rides it. Only for a run
 * whose launching part answered in the background (`answersInBackground`), and
 * only when the summary, where it names the call's description, names this run's:
 * an answer arriving after a relaunch is the earlier run's. A part that is not
 * synthetic, or names no child of this thread, is none. The prompt is still
 * no message of the thread's: this adds the result and nothing else.
 */
function takeBackgroundResult(
  state: OpenCodeSessionState,
  part: OpenCodePart,
  raw: unknown,
  out: Emitter
): void {
  if (part.type !== "text") {
    return;
  }
  const text = part as Extract<OpenCodePart, { type: "text" | "reasoning" }>;
  if (text.synthetic !== true || typeof text.text !== "string") {
    return;
  }
  const envelope = taskEnvelopeOf(text.text);
  const agent = envelope === undefined ? undefined : state.childAgents.get(envelope.taskId);
  // Only a run whose launching part answered in the background takes one: an
  // answer that reaches a foreground run is an earlier run's, late. And one
  // whose summary names another call's description is another run's.
  if (envelope === undefined || agent === undefined || agent.answersInBackground !== true) {
    return;
  }
  const described = BACKGROUND_SUMMARY.exec(envelope.summary ?? "")?.groups?.description;
  if (described !== undefined && described !== agent.description) {
    return;
  }
  if (!agent.completed) {
    agent.pendingResult = envelope.text;
    return;
  }
  if (agent.resultPending === true) {
    agent.resultPending = false;
    emitTaskResult(state, agent, raw, out, envelope.text);
  }
}

/** Record a `task` call that named `agent` (`OpenCodeChildAgent.seenCallIds`). */
function rememberCall(agent: OpenCodeChildAgent, callId: string): void {
  (agent.seenCallIds ??= new Set<string>()).add(callId);
}

/**
 * Everything a child session emits that is not a permission or a question.
 * The child's own text, tool calls and status become roster rows plus
 * `agentId`-stamped items; **no** child frame ever touches the parent's
 * completion machines, its token accounting or its plan.
 */
function demuxChild(
  state: OpenCodeSessionState,
  event: OpenCodeHandledEvent,
  raw: OpenCodeRawEvent,
  childSessionId: string,
  out: Emitter
): void {
  const turnId = state.activeTurnId;

  switch (event.type) {
    case "session.created":
    case "session.updated": {
      const info = event.properties.info;
      const parentID = typeof info.parentID === "string" ? info.parentID : undefined;
      const agentName = isRecord(raw.properties)
        ? isRecord(raw.properties.info) && typeof raw.properties.info.agent === "string"
          ? raw.properties.info.agent
          : undefined
        : undefined;
      const title = info.title?.trim();
      // Read before `ensureChildAgent`, which writes the new title.
      const previousTitle = state.childAgents.get(childSessionId)?.title;
      const agent = ensureChildAgent(state, childSessionId, {
        ...(parentID !== undefined ? { parentSessionId: parentID } : {}),
        ...(title !== undefined && title.length > 0 ? { title } : {}),
        ...(agentName !== undefined ? { role: agentName } : {}),
        ...(parentID !== undefined && parentID !== state.openCodeSessionId
          ? { parentAgentId: parentID }
          : {})
      });
      if (event.type === "session.created") {
        // No start yet: the parent's `task` part names this child in the
        // `running` frame that follows (fixture 12, lines 141-142), and the
        // start it emits carries the launching call. A child no part ever
        // names — a missed frame, a grandchild — still gets its start, without
        // that call, from whichever of its rows comes first.
        return;
      }
      // `session.updated` re-states an unchanged title on every recompute
      // (observation 25), so only a real change of a title already known is
      // worth a progress row. The comparison used to read the title
      // `ensureChildAgent` had just written, and no change ever showed.
      if (
        title !== undefined &&
        title.length > 0 &&
        previousTitle !== undefined &&
        title !== previousTitle
      ) {
        emitTaskProgress(state, agent, raw, out, { summary: title });
      }
      return;
    }

    case "session.deleted": {
      const agent = state.childAgents.get(childSessionId);
      if (agent !== undefined) {
        emitTaskCompleted(state, agent, "stopped", raw, out);
      }
      return;
    }

    case "session.status": {
      const agent = ensureChildAgent(state, childSessionId);
      const status = event.properties.status;
      emitTaskStatus(
        state,
        agent,
        status.type === "busy" || status.type === "retry" ? "running" : "idle",
        raw,
        out
      );
      return;
    }

    case "session.idle": {
      // The child's terminal signal. Its parent `task` tool part settles
      // right AFTER it (fixture 12, lines 179-180) and carries the result
      // text, which that part gives this run's end (`linkChildFromTaskPart`);
      // a background run's answer comes as a prompt to the parent instead
      // (`takeBackgroundResult`), and one that came first rides this end.
      const agent = ensureChildAgent(state, childSessionId);
      if (!agent.completed) {
        const result = agent.pendingResult;
        agent.pendingResult = undefined;
        emitTaskCompleted(state, agent, "completed", raw, out, result);
        agent.resultPending = result === undefined;
      }
      return;
    }

    case "session.error": {
      const agent = ensureChildAgent(state, childSessionId);
      emitTaskCompleted(
        state,
        agent,
        "failed",
        raw,
        out,
        sessionErrorMessage(event.properties.error)
      );
      return;
    }

    case "message.updated": {
      const info = event.properties.info;
      state.messageRoleById.set(info.id, info.role);
      if (info.role === "user") {
        state.textPartsByMessageId.delete(info.id);
        return;
      }
      const agent = ensureChildAgent(state, childSessionId);
      for (const part of state.textPartsByMessageId.get(info.id)?.values() ?? []) {
        emitTextDelta(part, turnId, raw, out, agent.sessionId);
      }
      return;
    }

    case "message.removed": {
      state.messageRoleById.delete(event.properties.messageID);
      state.textPartsByMessageId.delete(event.properties.messageID);
      dropMessageOutputMarks(state, event.properties.messageID);
      return;
    }

    case "message.part.removed": {
      const parts = state.textPartsByMessageId.get(event.properties.messageID);
      parts?.delete(event.properties.partID);
      state.outputMarks.delete(event.properties.partID);
      return;
    }

    case "message.part.delta": {
      const existing = state.textPartsByMessageId
        .get(event.properties.messageID)
        ?.get(event.properties.partID);
      if (
        existing === undefined ||
        existing.text === undefined ||
        event.properties.field !== "text" ||
        messageRoleForPart(state, existing) !== "assistant" ||
        event.properties.delta.length === 0
      ) {
        return;
      }
      const nextText = (existing.emittedText ?? existing.text) + event.properties.delta;
      existing.emittedText = nextText;
      existing.text = nextText;
      out.push({
        ...out.base({ turnId, itemId: existing.id, agentId: childSessionId, raw }),
        type: "content.delta",
        payload: {
          streamKind: existing.type === "reasoning" ? "reasoning_text" : "assistant_text",
          delta: event.properties.delta
        }
      });
      return;
    }

    case "message.part.updated": {
      const part = event.properties.part;
      const role =
        messageRoleForPart(state, part) ?? (part.type === "tool" ? "assistant" : undefined);

      // A grandchild's background answer is prompted into this child.
      takeBackgroundResult(state, part, raw, out);

      // A child's `step-finish` tokens belong to the child, never to the
      // parent turn's accumulator — they are a different session's spend.
      if ((part.type === "text" || part.type === "reasoning") && role !== "user") {
        const stored = retainTextPart(state, part as Extract<OpenCodePart, { type: "text" | "reasoning" }>);
        if (role === "assistant") {
          emitTextDelta(stored, turnId, raw, out, childSessionId);
        }
      } else {
        const previous = state.textPartsByMessageId.get(part.messageID)?.get(part.id);
        if (previous !== undefined) {
          previous.text = undefined;
        }
      }

      if (part.type === "tool") {
        const tool = part as Extract<OpenCodePart, { type: "tool" }>;
        const agent = ensureChildAgent(state, childSessionId);
        // Output first: a completion closes the call's output buffer.
        emitCommandOutput(state, tool, turnId, raw, out, childSessionId);
        emitToolItem(tool, turnId, raw, out, childSessionId);
        if (tool.state.status === "running" || tool.state.status === "pending") {
          emitTaskProgress(state, agent, raw, out, {
            lastToolName: tool.tool,
            ...(tool.state.title !== undefined ? { summary: tool.state.title } : {}),
            status: "running"
          });
        }
      }
      return;
    }

    case "todo.updated": {
      // A child's todo list is its own plan, not the thread's. It rides the
      // roster as a progress summary rather than overwriting `turn.plan`.
      const agent = ensureChildAgent(state, childSessionId);
      // A cancelled step counts in NEITHER the numerator nor the denominator —
      // it is not done, and it is no longer planned. The parent path drops
      // cancelled rows from `turn.plan.updated` for the same reason; counting
      // them as done read "2/3" for one completed, one cancelled, one pending.
      const planned = event.properties.todos.filter((todo) => todo.status !== "cancelled");
      const done = planned.filter((todo) => todo.status === "completed").length;
      emitTaskProgress(state, agent, raw, out, {
        summary: `${done}/${planned.length} steps done`
      });
      return;
    }

    case "session.compacted":
    case "command.executed":
      return;

    // Request frames never reach here: they keep the parent path, because an
    // approval belongs on the thread whichever session raised it.
    case "permission.asked":
    case "permission.replied":
    case "question.asked":
    case "question.replied":
    case "question.rejected":
      return;

    default: {
      const exhaustive: never = event;
      void exhaustive;
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers the demux leans on
// ---------------------------------------------------------------------------

function retainTextPart(
  state: OpenCodeSessionState,
  part: Extract<OpenCodePart, { type: "text" | "reasoning" }>
): OpenCodeTextPartState {
  const parts =
    state.textPartsByMessageId.get(part.messageID) ?? new Map<string, OpenCodeTextPartState>();
  const previous = parts.get(part.id);
  const next: OpenCodeTextPartState = {
    id: part.id,
    messageID: part.messageID,
    type: part.type,
    ...(part.time !== undefined ? { time: part.time } : {}),
    text: part.text,
    emittedText: previous?.emittedText,
    completed: previous?.completed ?? false
  };
  parts.set(part.id, next);
  state.textPartsByMessageId.set(part.messageID, parts);
  return next;
}

function emitTextDelta(
  part: OpenCodeTextPartState,
  turnId: string | undefined,
  raw: unknown,
  out: Emitter,
  agentId?: string
): void {
  if (part.text === undefined) {
    return;
  }
  const { latestText, deltaToEmit } = mergeOpenCodeAssistantText(part.emittedText, part.text);
  // BOTH before emitting: the same bytes can never go out twice.
  part.emittedText = latestText;
  part.text = latestText;
  if (deltaToEmit.length > 0) {
    out.push({
      ...out.base({
        turnId,
        itemId: part.id,
        agentId,
        createdAt: isoFromEpochMs(part.time?.start),
        raw
      }),
      type: "content.delta",
      payload: {
        streamKind: part.type === "reasoning" ? "reasoning_text" : "assistant_text",
        delta: deltaToEmit
      }
    });
  }
  if (part.type === "text" && part.time?.end !== undefined && !part.completed) {
    part.completed = true;
    out.push({
      ...out.base({
        turnId,
        itemId: part.id,
        agentId,
        createdAt: isoFromEpochMs(part.time.end),
        raw
      }),
      type: "item.completed",
      payload: {
        itemType: "assistant_message",
        status: "completed",
        title: "Assistant message",
        ...(agentId !== undefined ? { agentId } : {}),
        ...(latestText.length > 0 ? { detail: latestText } : {})
      }
    });
  }
}

/**
 * The turn a reply belongs to, decided on the first frame of its assistant
 * message — `parentID` names the prompt it answers, the newest user message
 * of the session's run (1.18.32's `MessageV2.latest`, read from the source).
 *
 * A reply to a prompt the host sent, or to one a turn already claimed, is
 * that turn's (`claimedPromptIds`). Any other prompt the SERVER wrote: 1.18.32
 * answers a background `task` call by prompting the calling session with the
 * child's answer (`injectBackgroundResult`, fixtures README observation 27),
 * through `SessionPrompt.prompt` — the path a `prompt_async` takes — and that
 * prompt starts a run of its own, the parent's reply, which no `/turn` ever
 * opened. Its rows were turnless, and the thread read idle while the agent
 * worked. So:
 *
 * - While a turn runs, the reply is that turn's: the server answers a prompt
 *   that arrives mid-run in the same run (`SessionRunState.ensureRunning`
 *   awaits a running run), so the turn claims it, and its steps count as the
 *   turn's own (`promptMessageIds`).
 * - While none runs, it opens one — the woken turn — named by the prompt, as
 *   a live turn is named by the prompt that opened it (a rewind finds it again
 *   in `GET /session/:id/message`): `openTurn`, `turn.started` before any row
 *   of the reply, and a `turn-woken` signal for the session's record. From
 *   there it is any turn: the session's idle (or error) settles it, a Stop
 *   aborts it, the session's stop closes it, and a message the user sends
 *   meanwhile steers it — the server queues it into the same run. Only with a
 *   run behind it (`parentBusy`): with none, no idle would ever settle it.
 *
 * A compaction's summary (`summary: true`) answers no prompt of the
 * conversation, so its prompt is claimed but never joins `promptMessageIds`:
 * the summary call stays off the meter and the turn's usage, as it always has
 * inside a turn the host started. While no turn runs it is either the host's
 * own `/compact` (`hostCompacting`), which stays turnless, or a run's own —
 * one a background answer woke that found its context full and compacts
 * before it replies (1.18.32's `SessionPrompt.run`) — which opens the woken
 * turn there, named by the compaction's prompt, so the thread reads working
 * through the compaction; the reply to the prompt it goes on with then joins
 * it as any mid-run prompt does.
 *
 * Only a reply BEGINNING: a message that already ended (a fork copies a
 * session's messages whole — fixture 10) answers no running prompt, and a
 * rewind claims every prompt its fork copied (`rollbackThread`), so neither
 * does a copy its dead run never completed. Output that follows an
 * interruption never reaches here (the demux drops it first), so it opens
 * nothing either.
 */
function claimReply(
  state: OpenCodeSessionState,
  info: { parentID?: string; summary?: unknown; time?: { completed?: number } },
  raw: unknown,
  out: Emitter
): void {
  const promptId =
    typeof info.parentID === "string" && info.parentID.length > 0 ? info.parentID : undefined;
  if (
    promptId === undefined ||
    state.claimedPromptIds.has(promptId) ||
    info.time?.completed !== undefined
  ) {
    return;
  }
  const summary = info.summary === true;
  if (state.activeTurnId !== undefined) {
    claimPrompt(state, promptId);
    if (!summary) {
      state.turnTokenUsage?.promptMessageIds.add(promptId);
    }
    return;
  }
  if (summary && state.hostCompacting) {
    claimPrompt(state, promptId);
    return;
  }
  // No run behind it, no turn: a reply beginning comes after its run's `busy`
  // (`parentBusy`). Unclaimed, a later reply of a live run can still open it.
  if (!state.parentBusy) {
    return;
  }
  claimPrompt(state, promptId);
  openTurn(state, promptId);
  if (!summary) {
    state.turnTokenUsage?.promptMessageIds.add(promptId);
  }
  out.push({
    ...out.base({ turnId: promptId, raw }),
    type: "turn.started",
    payload: {}
  });
  out.signal({ kind: "turn-woken", turnId: promptId });
}

/**
 * Decide whether an assistant message is this turn's, and flush the steps that
 * were deferred while the answer was unknown. Returns the steps it counted, so
 * the caller can move the meter on them too — a step that resolved late is
 * still a step of ours.
 */
function resolveAssistantOwnership(
  state: OpenCodeSessionState,
  messageId: string,
  parentID: string | undefined
): OpenCodeStepUsage[] {
  const usage = state.turnTokenUsage;
  if (usage === undefined) {
    return [];
  }
  const parentMessageId =
    typeof parentID === "string" && parentID.trim().length > 0 ? parentID : undefined;
  const observed =
    parentMessageId === undefined
      ? "unknown"
      : usage.promptMessageIds.has(parentMessageId)
        ? "owned"
        : "other";
  const prior = usage.assistantOwnershipByMessageId.get(messageId);
  const ownership = prior === undefined || prior === "unknown" ? observed : prior;
  usage.assistantOwnershipByMessageId.set(messageId, ownership);
  if (ownership === "unknown") {
    return [];
  }
  const counted: OpenCodeStepUsage[] = [];
  const steps = usage.unresolvedStepsByMessageId.get(messageId);
  if (ownership === "owned" && steps !== undefined) {
    for (const step of steps.values()) {
      if (accumulateStepUsage(usage, step)) {
        counted.push(step);
      }
    }
  }
  usage.unresolvedStepsByMessageId.delete(messageId);
  return counted;
}

/** The owned steps this part contributed, so the caller can move the meter. */
function accumulateStepPart(
  state: OpenCodeSessionState,
  part: Extract<OpenCodePart, { type: "step-finish" }>
): OpenCodeStepUsage[] {
  const usage = state.turnTokenUsage;
  if (usage === undefined) {
    return [];
  }
  const ownership = usage.assistantOwnershipByMessageId.get(part.messageID);
  if (ownership === "owned") {
    const step = { id: part.id, tokens: part.tokens };
    return accumulateStepUsage(usage, step, part.cost) ? [step] : [];
  }
  if (
    ownership === "unknown" ||
    (ownership === undefined && state.messageRoleById.get(part.messageID) !== "assistant")
  ) {
    const steps =
      usage.unresolvedStepsByMessageId.get(part.messageID) ??
      new Map<string, { id: string; tokens: typeof part.tokens }>();
    steps.set(part.id, { id: part.id, tokens: part.tokens });
    usage.unresolvedStepsByMessageId.set(part.messageID, steps);
  }
  return [];
}

/**
 * The context meter (§7.6). Each owned `step-finish` states the size of the
 * context that model call carried, so the LAST one is the window's occupancy;
 * the running sum across the thread is "total processed".
 *
 * A child session's steps never reach here — they are a different session's
 * spend (fixtures README observation 19) — and `maxTokens` is emitted only
 * when the server's catalogue actually named a `limit.context` for the
 * thread's model. Without it the client degrades to a bare count rather than
 * drawing a ring against a guess.
 */
function emitContextWindow(
  state: OpenCodeSessionState,
  counted: readonly OpenCodeStepUsage[],
  turnId: string | undefined,
  raw: unknown,
  out: Emitter
): void {
  if (counted.length === 0) {
    return;
  }
  let usedTokens = 0;
  for (const step of counted) {
    const total = stepTotalTokens(step.tokens);
    state.processedTokens += total;
    usedTokens = total;
  }
  if (usedTokens <= 0) {
    return;
  }
  out.push({
    ...out.base({ turnId, raw }),
    type: "thread.token-usage.updated",
    payload: {
      usage: {
        usedTokens,
        ...(state.contextMaxTokens !== undefined ? { maxTokens: state.contextMaxTokens } : {}),
        ...(state.processedTokens > usedTokens
          ? { totalProcessedTokens: state.processedTokens }
          : {}),
        compactsAutomatically: true
      }
    }
  });
}

/**
 * A tool part as its lifecycle row. A command's completion carries its final
 * `output` in `data.result`, where both readers of a row's whole output look
 * (`storedCommandOutput`). When OpenCode cut that output itself — the shell
 * keeps only the END past its limits, behind a note naming the file that holds
 * all of it; the generic cut any other command-named tool goes through (an
 * MCP server's) keeps the HEAD, its note at the end ({@link isCutFinalOutput})
 * — the completion says so (`truncated`, as Codex marks the head it bounded):
 * the MCP's `read_tool_output` then reads the call's streamed join first, as
 * the GUI's viewer does, and answers the kept part as the command's output,
 * only a part of it, when no join answers.
 */
function emitToolItem(
  part: Extract<OpenCodePart, { type: "tool" }>,
  turnId: string | undefined,
  raw: unknown,
  out: Emitter,
  agentId?: string
): void {
  const itemType: CanonicalItemType = toToolLifecycleItemType(part.tool);
  const title =
    part.state.status === "running" || part.state.status === "completed"
      ? (part.state.title ?? part.tool)
      : part.tool;
  const detail = toolDetail(part);
  const status: RuntimeItemStatus =
    part.state.status === "error"
      ? "failed"
      : part.state.status === "completed"
        ? "completed"
        : "inProgress";
  const command = part.state.input?.command;
  const cut =
    part.state.status === "completed" &&
    itemType === "command_execution" &&
    typeof part.state.output === "string" &&
    isCutFinalOutput(part.state.output);

  out.push({
    ...out.base({ turnId, itemId: part.callID, agentId, createdAt: toolCreatedAt(part), raw }),
    type:
      part.state.status === "pending"
        ? "item.started"
        : part.state.status === "completed" || part.state.status === "error"
          ? "item.completed"
          : "item.updated",
    payload: {
      itemType,
      status,
      ...(title !== undefined ? { title } : {}),
      ...(detail !== undefined ? { detail } : {}),
      ...(agentId !== undefined ? { agentId } : {}),
      data: {
        tool: part.tool,
        toolUseId: part.callID,
        state: part.state,
        ...(typeof command === "string" ? { command } : {}),
        ...(itemType === "file_change" ? { input: part.state.input } : {}),
        ...(part.state.status === "completed" &&
        (itemType === "command_execution" || itemType === "mcp_tool_call")
          ? { result: part.state.output }
          : {})
      },
      ...(cut ? { truncated: true } : {})
    }
  });
}

/**
 * How many running command parts keep an output mark at once. Settled parts
 * drop theirs, so only a part whose settle never reached the demux (an
 * interrupted turn's suppressed tail, a stream gap) can pile up here.
 */
const OUTPUT_MARKS_CAP = 64;

/**
 * A command's output, as it grows (fixtures README observation 28). Each
 * `running` frame of a command-like part restates everything printed so far
 * in `state.metadata.output`, which reached nobody: the item row carries it
 * only inside `data.state`, and the wire slimmer drops it there, so only the
 * completion ever showed output. Each frame now becomes a `command_output`
 * delta of just what it adds ({@link advanceOutputMark}), on the call's own
 * item and under the call's owner — the chunks ingestion joins onto the
 * call's row, whose output they then are, settled too.
 *
 * So the part's completion appends what its final `output` holds past them
 * ({@link finalOutputRemainder}: a timeout's or an abort's note, output the
 * running frames never carried) — called BEFORE the completion's own item
 * event, which closes the call's output buffer. A stream that showed nothing
 * gets nothing: the completion's own output is what its row shows. An errored
 * part has no final output, and its error stays the completion's. Either way
 * the part's mark goes.
 */
function emitCommandOutput(
  state: OpenCodeSessionState,
  part: Extract<OpenCodePart, { type: "tool" }>,
  turnId: string | undefined,
  raw: unknown,
  out: Emitter,
  agentId?: string
): void {
  const marks = state.outputMarks;
  const status = part.state.status;
  if (status === "completed" || status === "error") {
    const shown = marks.get(part.id)?.value;
    marks.delete(part.id);
    const final = status === "completed" ? part.state.output : undefined;
    if (shown !== undefined && shown.length > 0 && typeof final === "string") {
      pushCommandOutput(part, finalOutputRemainder(shown, final), turnId, raw, out, agentId);
    }
    return;
  }
  if (status !== "running") {
    return;
  }
  const output = isRecord(part.state.metadata) ? part.state.metadata.output : undefined;
  if (typeof output !== "string" || toToolLifecycleItemType(part.tool) !== "command_execution") {
    return;
  }
  const { mark, chunk } = advanceOutputMark(marks.get(part.id)?.value ?? "", output);
  // Written last, so the cap drops the mark written longest ago — a settle
  // that never came, not a command still printing.
  marks.delete(part.id);
  marks.set(part.id, { messageId: part.messageID, value: mark });
  while (marks.size > OUTPUT_MARKS_CAP) {
    const oldest = marks.keys().next();
    if (oldest.done === true) {
      break;
    }
    marks.delete(oldest.value);
  }
  pushCommandOutput(part, chunk, turnId, raw, out, agentId);
}

function pushCommandOutput(
  part: Extract<OpenCodePart, { type: "tool" }>,
  delta: string,
  turnId: string | undefined,
  raw: unknown,
  out: Emitter,
  agentId: string | undefined
): void {
  if (delta.length === 0) {
    return;
  }
  out.push({
    ...out.base({ turnId, itemId: part.callID, agentId, raw }),
    type: "content.delta",
    payload: { streamKind: "command_output", delta }
  });
}

/** A removed message's parts keep no output mark. */
function dropMessageOutputMarks(state: OpenCodeSessionState, messageId: string): void {
  for (const [partId, mark] of state.outputMarks) {
    if (mark.messageId === messageId) {
      state.outputMarks.delete(partId);
    }
  }
}

function openPermission(
  state: OpenCodeSessionState,
  request: OpenCodePermissionRequest,
  raw: unknown,
  out: Emitter
): void {
  if (state.resolvedRequestIds.has(request.id) || state.pendingPermissions.has(request.id)) {
    return;
  }
  if (state.activeTurnId === undefined && state.reconcileIdleStatus) {
    // An ask that arrives while the turn is being torn down belongs to nothing.
    state.resolvedRequestIds.add(request.id);
    return;
  }
  if (state.runtimeMode === "full-access") {
    // §4.3: auto-answer `once`, NEVER `always`. An `always` grant is stored per
    // directory and would silently widen every supervised thread sharing this
    // server (fixtures README observation 10 proves it across sessions).
    state.resolvedRequestIds.add(request.id);
    state.autoRepliedRequestIds.add(request.id);
    out.signal({ kind: "auto-reply-permission", request, raw });
    return;
  }
  state.autoRepliedRequestIds.delete(request.id);
  state.pendingPermissions.set(request.id, request);
  out.push({
    ...out.base({ turnId: state.activeTurnId, requestId: request.id, raw }),
    type: "request.opened",
    payload: {
      requestType: mapPermissionToRequestType(request.permission),
      // The provider is blocked waiting on a reply: it must be answered or
      // cancelled, never dismissed (§4.2).
      dismissible: false,
      detail: permissionDetail(request),
      options: approvalOptionsFor(request),
      args: {
        ...(request.metadata !== undefined ? { metadata: request.metadata } : {}),
        ...(request.always !== undefined ? { always: request.always } : {}),
        ...(request.tool !== undefined ? { tool: request.tool } : {}),
        permission: request.permission,
        patterns: request.patterns
      }
    }
  });
}

function openQuestion(
  state: OpenCodeSessionState,
  request: OpenCodeQuestionRequest,
  raw: unknown,
  out: Emitter
): void {
  if (state.resolvedRequestIds.has(request.id) || state.pendingQuestions.has(request.id)) {
    return;
  }
  if (state.activeTurnId === undefined && state.reconcileIdleStatus) {
    state.resolvedRequestIds.add(request.id);
    return;
  }
  state.pendingQuestions.set(request.id, request);
  out.push({
    ...out.base({ turnId: state.activeTurnId, requestId: request.id, raw }),
    type: "user-input.requested",
    payload: {
      questions: normalizeQuestions(request),
      // The `question` tool blocks the turn until it is answered or rejected,
      // so this is a protocol reply, not a message — hence not dismissible.
      dismissible: false
    }
  });
}

function resolveRequest(state: OpenCodeSessionState, requestId: string): void {
  state.resolvedRequestIds.add(requestId);
  state.requestRelationRetries.delete(requestId);
}

export function emitTerminalPermission(
  state: OpenCodeSessionState,
  requestId: string,
  decision: ReturnType<typeof fromOpenCodePermissionReply> | undefined,
  raw: unknown,
  out: Emitter
): void {
  if (state.emittedTerminalRequestIds.has(requestId)) {
    return;
  }
  if (state.autoRepliedRequestIds.delete(requestId)) {
    // Full access answered this itself; nothing was ever shown to the user.
    state.emittedTerminalRequestIds.add(requestId);
    return;
  }
  const request = state.pendingPermissions.get(requestId);
  state.pendingPermissions.delete(requestId);
  state.emittedTerminalRequestIds.add(requestId);
  out.push({
    ...out.base({ turnId: state.activeTurnId, requestId, raw }),
    type: "request.resolved",
    payload: {
      requestType:
        request !== undefined ? mapPermissionToRequestType(request.permission) : "unknown",
      ...(decision !== undefined ? { decision } : {})
    }
  });
}

export function emitTerminalQuestion(
  state: OpenCodeSessionState,
  requestId: string,
  answers: string[][] | undefined,
  raw: unknown,
  out: Emitter
): void {
  if (state.emittedTerminalRequestIds.has(requestId)) {
    return;
  }
  const request = state.pendingQuestions.get(requestId);
  state.pendingQuestions.delete(requestId);
  state.emittedTerminalRequestIds.add(requestId);
  const resolved: Record<string, unknown> =
    answers !== undefined && request !== undefined
      ? Object.fromEntries(
          request.questions.map((question, index) => [
            openCodeQuestionId(index, question.header ?? ""),
            answers[index]?.join(", ") ?? ""
          ])
        )
      : {};
  out.push({
    ...out.base({ turnId: state.activeTurnId, requestId, raw }),
    type: "user-input.resolved",
    payload: { answers: resolved }
  });
}

/** Exposed so `session.ts` can close requests without re-entering the demux. */
export { Emitter as NormalizerEmitter };
