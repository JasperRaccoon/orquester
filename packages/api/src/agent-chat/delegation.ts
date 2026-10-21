/**
 * Delegated tasks as their parent sees them (`create_session` with `delegate: true`, lineage
 * relation `delegate`): what a child is doing, in one line; why a child stopped when its parent
 * did; and the notice a parent gets when a child is blocked on its user.
 *
 * One spelling shared by the agent host (the summary's preview, the stop marker it writes), the
 * daemon (the stop cascade, the attention notices) and the UI (the subagent strip, the roster's
 * delegated rows, the marker row), so no surface can drift.
 */

import type { ComposerContextRecord } from "./adapter-types.ts";
import { SETTLED_TURN_STATES, type ThreadItem, type Turn } from "./thread.ts";
import { assistantTextForTurn } from "./thread-head.ts";
import { THREAD_MESSAGE_CONTEXT_KIND } from "./thread-tools.ts";

// ---------------------------------------------------------------------------
// The live preview (SessionSummary.delegatePreview)
// ---------------------------------------------------------------------------

/** How many characters of a child's progress or result its parent's surfaces show. */
export const DELEGATE_PREVIEW_CHARS = 280;

/**
 * A delegated child's latest word, for its parent's strip and roster: `result` — its latest
 * settled turn's answer; `progress` — what its running turn last said or did (its latest
 * assistant text, else its latest tool row's summary). Cut to {@link DELEGATE_PREVIEW_CHARS}.
 */
export interface DelegatePreview {
  kind: "result" | "progress";
  text: string;
  /** When that word was written (the turn's completion for a result). */
  at: string;
}

/** `text` on one line, cut to `max` characters (whole code points) with an ellipsis; "" for blank text. */
export function compactPreviewText(text: string, max: number = DELEGATE_PREVIEW_CHARS): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  let out = "";
  for (const char of compact) {
    if (out.length + char.length > max - 1) break;
    out += char;
  }
  return `${out.trimEnd()}…`;
}

/** How far back a running turn's progress is looked for: the summary is read every poll, so the walk is bounded. */
const PROGRESS_SCAN_ITEMS = 400;

/**
 * The preview of a thread from its fold: the latest turn's answer once it settled (its error for a
 * failed turn with none), else the running turn's latest assistant text or tool row. Null when
 * there is nothing to show yet. Main conversation only — a subagent's words never stand for the
 * child's own.
 */
export function delegatePreviewOf(items: readonly ThreadItem[], turns: readonly Turn[]): DelegatePreview | null {
  const latest = turns.at(-1);
  if (!latest) return null;
  if (SETTLED_TURN_STATES.has(latest.state)) {
    const at = latest.completedAt ?? latest.startedAt ?? latest.requestedAt;
    const answer = latest.turnId ? compactPreviewText(assistantTextForTurn(items, latest.turnId)) : "";
    if (answer) return { kind: "result", text: answer, at };
    const error = latest.errorMessage ? compactPreviewText(latest.errorMessage) : "";
    return error ? { kind: "result", text: error, at } : null;
  }
  const floor = Math.max(0, items.length - PROGRESS_SCAN_ITEMS);
  for (let index = items.length - 1; index >= floor; index -= 1) {
    const item = items[index]!;
    if (item.agentId !== undefined) continue;
    // The user message that opened the running turn: nothing of this turn came after it yet.
    if (item.kind === "message" && item.role === "user") return null;
    if (latest.turnId !== null && item.turnId !== null && item.turnId !== latest.turnId) return null;
    if (item.kind === "message") {
      if (item.role !== "assistant") continue;
      const text = compactPreviewText(item.text);
      if (text) return { kind: "progress", text, at: item.updatedAt };
      continue;
    }
    if (!item.activityKind.startsWith("tool.") || item.tone === "error") continue;
    const text = compactPreviewText(item.summary);
    if (text) return { kind: "progress", text, at: item.updatedAt };
  }
  return null;
}

/**
 * What a delegated child's summary carries for its parent's surfaces
 * (`AgentChatSessionSummaryFields.delegateView`): the model it runs and its latest word. The host
 * fills it for a thread whose lineage is a `delegate` only, so ordinary chats add nothing to the bus.
 */
export interface DelegateView {
  /** The model slug the child's head runs, null when it has none yet. */
  model: string | null;
  preview: DelegatePreview | null;
}

/** A view read off the wire field-wise; `undefined` for anything that is not one. */
export function parseDelegateView(value: unknown): DelegateView | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const model = typeof record.model === "string" && record.model.trim().length > 0 ? record.model.trim().slice(0, 200) : null;
  return { model, preview: parseDelegatePreview(record.preview) ?? null };
}

/** A preview read off the wire: field-wise, `undefined` for anything that is not one. */
export function parseDelegatePreview(value: unknown): DelegatePreview | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.kind !== "result" && record.kind !== "progress") return undefined;
  if (typeof record.text !== "string" || typeof record.at !== "string") return undefined;
  const text = compactPreviewText(record.text);
  return text ? { kind: record.kind, text, at: record.at } : undefined;
}

// ---------------------------------------------------------------------------
// The stop cascade (InterruptCommandBody.cause)
// ---------------------------------------------------------------------------

/** How the parent stopped: its turn interrupted, its agent stopped, its tab closed. */
export type DelegateStopAction = "interrupted" | "stopped" | "closed";

/**
 * Why Orquester interrupted a delegated child: the chat that delegated it stopped
 * (`InterruptCommandBody.cause`, socket-trusted — the remote transport strips it). The host writes
 * it into the child's timeline as a {@link STOP_CASCADED_ACTIVITY_KIND} row.
 */
export interface InterruptCause {
  kind: "parent-stopped";
  /** The chat that delegated this one (its lineage parent). */
  parentSessionId: string;
  /** Its title when it stopped, for the row once it is gone; a client shows the live one. */
  parentTitle: string;
  action: DelegateStopAction;
}

const STOP_ACTIONS: ReadonlySet<string> = new Set<DelegateStopAction>(["interrupted", "stopped", "closed"]);
const MAX_CAUSE_ID_CHARS = 200;
const MAX_CAUSE_TITLE_CHARS = 300;

/** A cause read field-wise; `undefined` for anything that is not one (dropped, never refused). */
export function parseInterruptCause(value: unknown): InterruptCause | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.kind !== "parent-stopped") return undefined;
  const parentSessionId = record.parentSessionId;
  if (typeof parentSessionId !== "string" || parentSessionId.length === 0 || parentSessionId.length > MAX_CAUSE_ID_CHARS) return undefined;
  if (typeof record.action !== "string" || !STOP_ACTIONS.has(record.action)) return undefined;
  const title = typeof record.parentTitle === "string" ? record.parentTitle.replace(/\s+/g, " ").trim().slice(0, MAX_CAUSE_TITLE_CHARS) : "";
  return { kind: "parent-stopped", parentSessionId, parentTitle: title, action: record.action as DelegateStopAction };
}

/**
 * The activity kind the host appends beside an interrupt that carries a {@link InterruptCause}:
 * the child's timeline says it was stopped because its parent was. `payload` is the cause.
 */
export const STOP_CASCADED_ACTIVITY_KIND = "session.stop-cascaded";

/** The marker row's sentence, naming the parent by `title` (the live one, else the cause's). */
export function stopCascadedSummary(action: DelegateStopAction, title: string): string {
  const name = title.replace(/\s+/g, " ").trim() || "the chat that delegated this task";
  const quoted = title.trim() ? `“${name}”` : name;
  switch (action) {
    case "interrupted":
      return `Stopped because ${quoted} was interrupted`;
    case "stopped":
      return `Stopped because ${quoted} was stopped`;
    case "closed":
      return `Stopped because ${quoted} was closed`;
  }
}

// ---------------------------------------------------------------------------
// A child blocked on its user (the parent's attention notice)
// ---------------------------------------------------------------------------

/** What a blocked child waits for: an answer to a question, an approval, a secret. */
export type DelegateAttentionKind = "question" | "approval" | "secret";

/**
 * The chip an attention notice's `/turn` carries: Orquester's, about the blocked child
 * `fromThreadId` — a thread-authored message, so the GUI shows its header as a caption.
 */
export function delegateAttentionContext(fromThreadId: string): ComposerContextRecord {
  return { kind: THREAD_MESSAGE_CONTEXT_KIND, label: "Delegated task needs input", ref: fromThreadId };
}

/** How much of the question a notice quotes. */
export const DELEGATE_ATTENTION_QUOTE_CHARS = 300;

/**
 * The text of the notice turn a parent gets when a child it delegated to is blocked on its user:
 * names the child, quotes the request briefly, and says what the parent can do — answer a question
 * with `respond_to_request`, or ask its user (only a person decides an approval or gives a secret).
 */
export function delegateAttentionNoticeText(input: {
  title: string;
  sessionId: string;
  requestId: string;
  kind: DelegateAttentionKind;
  /** The question, the approval's subject, or the secret's name. */
  quote: string;
}): string {
  const title = input.title.replace(/\s+/g, " ").trim().slice(0, 200) || "Untitled";
  const quote = compactPreviewText(input.quote, DELEGATE_ATTENTION_QUOTE_CHARS);
  const after = "It stays blocked until then; its final reply still comes back to you automatically.";
  switch (input.kind) {
    case "question":
      return [
        `Your delegated task "${title}" is blocked: it asked its user${quote ? ` "${quote}"` : " a question"}.`,
        `If you can answer from what you know, call respond_to_request {sessionId: "${input.sessionId}", requestId: "${input.requestId}", answers: {…}}; otherwise ask your user.`,
        after
      ].join("\n");
    case "approval":
      return [
        `Your delegated task "${title}" is blocked waiting for its user to approve${quote ? `: ${quote}` : " a tool call"}.`,
        `Only a person can decide an approval: ask your user to open "${title}" and decide it.`,
        after
      ].join("\n");
    case "secret":
      return [
        `Your delegated task "${title}" is blocked waiting for its user to provide a secret${quote ? ` (${quote})` : ""}.`,
        `Only your user can provide it: ask them to open "${title}" and enter it there.`,
        after
      ].join("\n");
  }
}
