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
 * The demux switch over the handled union ends in `satisfies never` (§10): an
 * unmapped provider message is a typecheck error, and at runtime an unknown
 * frame is surfaced as `runtime.warning` — never swallowed by a catch-all,
 * never ending an active turn. `server.heartbeat` and the 37 dormant
 * `session.next.*` / `*.v2.*` members are allow-listed as "known, ignored"
 * rather than warned about every ten seconds (fixtures README observation 18).
 */

import type {
  CanonicalItemType,
  RuntimeEvent,
  RuntimeEventBase,
  RuntimeItemStatus,
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
  mergeOpenCodeAssistantText,
  messageRoleForPart,
  type OpenCodeSessionState,
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
  | { kind: "compacted" };

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

  // A frame with no session id at all is startup chatter (`plugin.added`,
  // `catalog.updated`, `server.*`) — it belongs to no thread by design
  // (fixtures README observation 19). It is triaged as known-ignored below.
  if (payloadSessionId !== undefined && !isParentEvent && !isChildRequestEvent) {
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

  // ---- triage (§10: known-ignored vs unknown) ----------------------------
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
    return { events: out.events, signals: out.signals };
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
    return { events: out.events, signals: out.signals };
  }

  demux(state, event, raw, out);
  return { events: out.events, signals: out.signals };
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
      state.messageRoleById.set(info.id, info.role);
      if (info.role === "user") {
        state.textPartsByMessageId.delete(info.id);
      }
      if (info.role === "assistant") {
        resolveAssistantOwnership(state, info.id, info.parentID);
        for (const part of state.textPartsByMessageId.get(info.id)?.values() ?? []) {
          emitTextDelta(part, turnId, raw, out);
        }
      }
      return;
    }

    case "message.removed": {
      state.messageRoleById.delete(event.properties.messageID);
      state.textPartsByMessageId.delete(event.properties.messageID);
      return;
    }

    case "message.part.removed": {
      const parts = state.textPartsByMessageId.get(event.properties.messageID);
      parts?.delete(event.properties.partID);
      if (parts?.size === 0) {
        state.textPartsByMessageId.delete(event.properties.messageID);
      }
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
        accumulateStepPart(state, part as Extract<OpenCodePart, { type: "step-finish" }>);
      }

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
        emitToolItem(part as Extract<OpenCodePart, { type: "tool" }>, turnId, raw, out);
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
      if (status.type === "idle" && turnId !== undefined) {
        out.signal({ kind: "status-idle", raw });
      }
      return;
    }

    case "session.idle": {
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
  out: Emitter
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
        createdAt: isoFromEpochMs(part.time.end),
        raw
      }),
      type: "item.completed",
      payload: {
        itemType: "assistant_message",
        status: "completed",
        title: "Assistant message",
        ...(latestText.length > 0 ? { detail: latestText } : {})
      }
    });
  }
}

function resolveAssistantOwnership(
  state: OpenCodeSessionState,
  messageId: string,
  parentID: string | undefined
): void {
  const usage = state.turnTokenUsage;
  if (usage === undefined) {
    return;
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
    return;
  }
  const steps = usage.unresolvedStepsByMessageId.get(messageId);
  if (ownership === "owned" && steps !== undefined) {
    for (const step of steps.values()) {
      accumulateStepUsage(usage, step);
    }
  }
  usage.unresolvedStepsByMessageId.delete(messageId);
}

function accumulateStepPart(
  state: OpenCodeSessionState,
  part: Extract<OpenCodePart, { type: "step-finish" }>
): void {
  const usage = state.turnTokenUsage;
  if (usage === undefined) {
    return;
  }
  const ownership = usage.assistantOwnershipByMessageId.get(part.messageID);
  if (ownership === "owned") {
    accumulateStepUsage(usage, { id: part.id, tokens: part.tokens }, part.cost);
    return;
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
}

function emitToolItem(
  part: Extract<OpenCodePart, { type: "tool" }>,
  turnId: string | undefined,
  raw: unknown,
  out: Emitter
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

  out.push({
    ...out.base({ turnId, itemId: part.callID, createdAt: toolCreatedAt(part), raw }),
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
      }
    }
  });
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
