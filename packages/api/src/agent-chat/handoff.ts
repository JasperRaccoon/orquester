/**
 * "Continue in another agent" — the budgeted transcript a chat hands a NEW agent session (thread
 * lineage, spec 2026-10-14 §6, a fork whose target agent or account cannot take a native fork).
 *
 * Pure and shared: the agent host renders the handoff with it, and the client's picker counts with
 * the same selection what the handoff will carry ("the last 23 of 41 messages, ≈58 KB").
 *
 * The rules (after T3 Code's `handoffBudget.ts`, adapted):
 * - only whole user and assistant messages of the main conversation are carried — never
 *   reasoning, a subagent's words or tool rows (the new agent re-reads files itself);
 * - they are picked NEWEST FIRST within {@link HANDOFF_BUDGET_BYTES} (UTF-8 bytes, one constant)
 *   and never cut in half: the walk stops at the first message that no longer fits, so what is
 *   carried is one unbroken stretch ending at the fork point;
 * - only when the newest message ALONE exceeds the budget is its tail carried, marked as cut;
 * - the rendering is chronological, attributed, names the source chat's agent and model, says
 *   how much earlier history was left out, and tells the new agent how to read it (the
 *   Orquester MCP `read_transcript` on the source session).
 *
 * No Node APIs: `@orquester/api` is shared with the browser.
 */

import { SETTLED_TURN_STATES, type ThreadItem, type Turn } from "./thread.ts";
import { startedTurns, type StartedTurn } from "./turns.ts";
import type { ThreadForkTarget } from "./lineage.ts";

/** The most message text a handoff carries, in UTF-8 bytes; the newest messages win. */
export const HANDOFF_BUDGET_BYTES = 64 * 1024;

/** The most `git status --short` text a handoff carries (the workflow handoff's own cap). */
export const HANDOFF_GIT_STATUS_BYTES = 8 * 1024;

/** What each carried message adds on top of its text: its attribution line and separators. */
const MESSAGE_OVERHEAD_BYTES = 48;

/** Room kept for the cut marker when the newest message alone is over the budget. */
const CLIP_MARKER_BYTES = 96;

// ---------------------------------------------------------------------------
// UTF-8, without Node
// ---------------------------------------------------------------------------

/** The UTF-8 length of `text` (a lone surrogate counts as the 3-byte replacement character). */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/** Whether the code unit at `index` is the low half of a surrogate pair. */
function isPairTail(text: string, index: number): boolean {
  const unit = text.charCodeAt(index);
  const before = text.charCodeAt(index - 1);
  return unit >= 0xdc00 && unit <= 0xdfff && before >= 0xd800 && before <= 0xdbff;
}

/** The longest prefix of `text` within `maxBytes` UTF-8 bytes, never splitting a character. */
export function utf8Head(text: string, maxBytes: number): string {
  if (utf8ByteLength(text) <= maxBytes) return text;
  let bytes = 0;
  let end = 0;
  while (end < text.length) {
    const step = end + 1 < text.length && isPairTail(text, end + 1) ? 2 : 1;
    const size = utf8ByteLength(text.slice(end, end + step));
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += step;
  }
  return text.slice(0, end);
}

/** The longest suffix of `text` within `maxBytes` UTF-8 bytes, never splitting a character. */
export function utf8Tail(text: string, maxBytes: number): string {
  if (utf8ByteLength(text) <= maxBytes) return text;
  let bytes = 0;
  let start = text.length;
  while (start > 0) {
    const step = start - 2 >= 0 && isPairTail(text, start - 1) ? 2 : 1;
    const size = utf8ByteLength(text.slice(start - step, start));
    if (bytes + size > maxBytes) break;
    bytes += size;
    start -= step;
  }
  return text.slice(start);
}

/** "≈58 KB" — decimal-free kilobytes for a picker or a timeline row (at least 1 KB once non-empty). */
export function formatHandoffBytes(bytes: number): string {
  if (bytes <= 0) return "0 KB";
  return `≈${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// ---------------------------------------------------------------------------
// Which messages a fork point holds
// ---------------------------------------------------------------------------

/** One message a handoff may carry: its author, its text and the transcript turn it belongs to. */
export interface HandoffMessage {
  role: "user" | "assistant";
  text: string;
  /** Its turn's 1-based number in the transcript (`read_transcript`'s numbering); absent when unknown. */
  turn?: number;
}

/**
 * The user and assistant messages of the main conversation in `retained` turns, in thread order:
 * every prompt that opened a retained turn and every non-empty reply inside one — no reasoning,
 * no subagent's words. The same set the same-agent transcript fork hands over.
 */
export function handoffMessagesOf(items: readonly ThreadItem[], retained: readonly StartedTurn[]): HandoffMessage[] {
  const turnNumber = new Map<string, number>();
  const promptTurn = new Map<string, number>();
  retained.forEach((turn, index) => {
    turnNumber.set(turn.turnId, index + 1);
    if (turn.userMessageId !== undefined) promptTurn.set(turn.userMessageId, index + 1);
  });
  const messages: HandoffMessage[] = [];
  for (const item of items) {
    if (item.kind !== "message" || item.agentId !== undefined) continue;
    if (item.role !== "user" && item.role !== "assistant") continue;
    const turn = promptTurn.get(item.id) ?? (item.turnId !== null ? turnNumber.get(item.turnId) : undefined);
    const text = item.text.trim();
    if (turn === undefined || text.length === 0) continue;
    messages.push({ role: item.role, text, turn });
  }
  return messages;
}

/**
 * The started turns a fork keeps, as the client can tell from its own window — the host's
 * `resolveForkCut` rule without its refusals: a reply keeps every turn through its own, a prompt
 * every turn before its own, and no message the latest settled turn and all before it. `null`
 * when the window cannot place the fork point (the host then decides).
 */
export function retainedTurnsForFork(
  state: { turns: readonly Turn[]; items: readonly ThreadItem[] },
  target: ThreadForkTarget
): StartedTurn[] | null {
  const started = startedTurns(state.turns);
  if (target.messageId === undefined && target.turnId === undefined) {
    let last = started.length - 1;
    while (last >= 0 && !SETTLED_TURN_STATES.has(started[last]!.state)) last -= 1;
    return started.slice(0, last + 1);
  }
  let role = target.role;
  let turnId = target.turnId ?? null;
  if (target.messageId !== undefined) {
    const message = state.items.find((item) => item.kind === "message" && item.id === target.messageId);
    if (message?.kind === "message" && (message.role === "user" || message.role === "assistant")) {
      role = message.role;
      turnId =
        message.role === "user"
          ? (started.find((turn) => turn.userMessageId === message.id)?.turnId ?? message.turnId)
          : message.turnId;
    }
  }
  if (turnId === null) return null;
  const index = started.findIndex((turn) => turn.turnId === turnId);
  if (index === -1) return null;
  return started.slice(0, role === "user" ? index : index + 1);
}

// ---------------------------------------------------------------------------
// The budgeted selection
// ---------------------------------------------------------------------------

export interface HandoffSelection {
  /** The carried messages, oldest first. With `clipped`, the only one is the newest's tail. */
  messages: HandoffMessage[];
  /** Every message the fork point holds. */
  total: number;
  /** How many of them are left out (the oldest). */
  omitted: number;
  /** UTF-8 bytes of the carried text. */
  bytes: number;
  /** The newest message alone was over the budget: how many of its leading bytes were cut. */
  clippedBytes: number;
  /**
   * The transcript turn of the newest word left out — an omitted message, or the cut head of a
   * clipped one — so `read_transcript` can page back from just after it. Absent when nothing
   * was left out, or its turn is unknown.
   */
  lastOmittedTurn?: number;
}

/** The cost of carrying one message whole. */
function messageCost(message: HandoffMessage): number {
  return utf8ByteLength(message.text) + MESSAGE_OVERHEAD_BYTES;
}

/**
 * Pick whole messages newest first within `budgetBytes`, stopping at the first that does not fit
 * — never one cut in half, never a gap. When even the newest does not fit alone, its tail is
 * carried (the rest of the budget, a marker's room kept) and `clippedBytes` says how much went.
 */
export function selectHandoffMessages(
  messages: readonly HandoffMessage[],
  budgetBytes: number = HANDOFF_BUDGET_BYTES
): HandoffSelection {
  const budget = Math.max(0, Math.floor(budgetBytes));
  let used = 0;
  let first = messages.length;
  while (first > 0 && used + messageCost(messages[first - 1]!) <= budget) {
    first -= 1;
    used += messageCost(messages[first]!);
  }
  if (first === messages.length && messages.length > 0) {
    const newest = messages[messages.length - 1]!;
    const room = Math.max(0, budget - MESSAGE_OVERHEAD_BYTES - CLIP_MARKER_BYTES);
    const tail = utf8Tail(newest.text, room);
    const tailBytes = utf8ByteLength(tail);
    return {
      messages: tail.length > 0 ? [{ ...newest, text: tail }] : [],
      total: messages.length,
      omitted: messages.length - (tail.length > 0 ? 1 : 0),
      bytes: tailBytes,
      clippedBytes: utf8ByteLength(newest.text) - tailBytes,
      ...(newest.turn !== undefined ? { lastOmittedTurn: newest.turn } : {})
    };
  }
  const carried = messages.slice(first);
  const lastOmittedTurn = first > 0 ? messages[first - 1]!.turn : undefined;
  return {
    messages: carried,
    total: messages.length,
    omitted: first,
    bytes: carried.reduce((sum, message) => sum + utf8ByteLength(message.text), 0),
    clippedBytes: 0,
    ...(lastOmittedTurn !== undefined ? { lastOmittedTurn } : {})
  };
}

/** What a handoff carried, as the fork's answer and its timeline row say it. */
export interface ForkHandoffSummary {
  /** Messages carried (a clipped newest one counts). */
  carried: number;
  /** Messages the fork point held. */
  total: number;
  /** UTF-8 bytes of the carried text. */
  bytes: number;
  /** Set when the newest message alone was over the budget and only its tail was carried. */
  clipped?: true;
}

export function handoffSummaryOf(selection: HandoffSelection): ForkHandoffSummary {
  return {
    carried: selection.messages.length,
    total: selection.total,
    bytes: selection.bytes,
    ...(selection.clippedBytes > 0 ? { clipped: true as const } : {})
  };
}

/**
 * The picker's line for a handoff: "Carries the last 23 of 41 messages (≈58 KB); earlier history
 * stays readable." `moreOlder`: the client's window does not hold the oldest turns, so the total
 * is a floor ("41+").
 */
export function describeHandoffSummary(summary: ForkHandoffSummary, options: { moreOlder?: boolean } = {}): string {
  const total = `${summary.total}${options.moreOlder ? "+" : ""}`;
  if (summary.total === 0) return "Nothing to carry over yet: the new chat starts fresh.";
  const size = formatHandoffBytes(summary.bytes);
  if (summary.clipped) {
    return `The newest message alone is over the budget, so only its end is carried (${size}); the rest of the history stays readable.`;
  }
  if (summary.carried >= summary.total && !options.moreOlder) {
    return `Carries the whole conversation: ${summary.total} message${summary.total === 1 ? "" : "s"} (${size}).`;
  }
  return `Carries the last ${summary.carried} of ${total} messages (${size}); earlier history stays readable.`;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** The handoff block's delimiters: the host strips a replayed prompt's block by them. */
export const FORK_HANDOFF_OPEN_TAG = "<forked-conversation>";
export const FORK_HANDOFF_CLOSE_TAG = "</forked-conversation>";

/**
 * The source's own words with the delimiters spelled as entities: a message (or title) that
 * quotes `</forked-conversation>` must not end the block early, or the stripping of a replayed
 * prompt would show the rest of the transcript as the user's message.
 */
export function escapeForkHandoffTags(text: string): string {
  return text.replace(/<(\/?)(forked-conversation)>/gi, "&lt;$1$2&gt;");
}

const AGENT_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  grok: "Grok",
  opencode: "OpenCode"
};

/** An adapter's display name: "Claude", "Codex", "Grok", "OpenCode" (else the id). */
export function agentAdapterLabel(adapter: string): string {
  return AGENT_LABELS[adapter] ?? adapter;
}

/**
 * "Claude Opus 4.1", "Codex · GPT-5": the agent and its model as one label — the model's own name
 * when it already starts with the agent's, else both.
 */
export function agentModelLabel(agentLabel: string, modelName: string | null | undefined): string {
  const model = modelName?.trim() ?? "";
  if (model.length === 0) return agentLabel;
  return model.toLowerCase().startsWith(agentLabel.toLowerCase()) ? model : `${agentLabel} · ${model}`;
}

/**
 * `git status --short` as a handoff section, within `maxBytes`: the same words the workflow
 * handoff (`buildHandoffPrompt`) uses, so both read the same.
 */
export function gitStatusSection(status: string, maxBytes: number = HANDOFF_GIT_STATUS_BYTES): string {
  const trimmed = status.trimEnd();
  const text = utf8Head(trimmed, maxBytes);
  const cut = text.length < trimmed.length;
  return `\`git status --short\` of the project${cut ? " (cut)" : ""}:\n\n${text || "(clean)"}`;
}

export interface HandoffSource {
  /** The source chat's session (= thread) id, for `read_transcript`. */
  sessionId: string;
  title: string;
  /** "Claude Opus 4.1" — the source's agent and model ({@link agentModelLabel}). */
  label: string;
}

/**
 * The handoff as the new agent reads it with the user's first message: a preamble that says what
 * it is and how to read what was left out, the carried messages oldest first with attribution,
 * and the project's `git status --short` when known. Wrapped in {@link FORK_HANDOFF_OPEN_TAG} so
 * a replayed prompt shows only what the user typed.
 */
export function renderHandoffTranscript(input: {
  selection: HandoffSelection;
  source: HandoffSource;
  /** The new chat's agent ("Codex"). */
  targetLabel: string;
  /** `git status --short` at the fork; null or absent when it could not be read. */
  gitStatus?: string | null;
}): string {
  const { selection, source } = input;
  const title = escapeForkHandoffTags(source.title.replace(/\s+/g, " ").trim()) || "the original conversation";
  const sourceLabel = escapeForkHandoffTags(source.label);
  // Page back from just after the newest word left out, so its whole turn is read.
  const beforeTurn = selection.lastOmittedTurn !== undefined ? Math.max(2, selection.lastOmittedTurn + 1) : undefined;
  const readCall = JSON.stringify({ sessionId: source.sessionId, ...(beforeTurn !== undefined ? { beforeTurn } : {}), turns: 20 });
  const size = formatHandoffBytes(selection.bytes);
  const lines: string[] = [
    `This conversation continues "${title}", a chat that ran on ${sourceLabel} (Orquester session ${source.sessionId}). ` +
      `The user continued it here, in a new ${escapeForkHandoffTags(input.targetLabel)} session, from the point below: treat the transcript as what was said before their next message and carry on from there. ` +
      `The assistant messages below were written in that chat, not by you in this session; its tool calls, file reads and reasoning are not replayed, so re-read any file you need.`
  ];
  if (selection.total === 0) {
    lines.push("No message of that chat could be carried over.");
  } else if (selection.clippedBytes > 0) {
    lines.push(
      `Its newest message alone is over the handoff budget, so only its end is carried (${size})` +
        (selection.omitted > 0
          ? `, and the ${selection.omitted} earlier message${selection.omitted === 1 ? " is" : "s are"} left out.`
          : ".")
    );
  } else if (selection.omitted > 0) {
    lines.push(`This carries the last ${selection.messages.length} of ${selection.total} messages (${size}); the ${selection.omitted} earlier message${selection.omitted === 1 ? " was" : "s were"} left out for length.`);
  } else {
    lines.push(`This carries the whole conversation so far: ${selection.total} message${selection.total === 1 ? "" : "s"} (${size}).`);
  }
  lines.push(
    `The full history of that chat${selection.omitted > 0 || selection.clippedBytes > 0 ? ", the omitted part included," : ", tool calls included,"} stays readable: call the Orquester MCP tool \`read_transcript\` with ${readCall} and page further back with \`beforeTurn\` set to the result's \`olderTurns\` + 1.`
  );
  const blocks: string[] = [];
  if (selection.omitted > 0 && selection.clippedBytes === 0) {
    blocks.push(`[${selection.omitted} earlier message${selection.omitted === 1 ? "" : "s"} omitted — read them with read_transcript]`);
  }
  for (const message of selection.messages) {
    const speaker = message.role === "user" ? "User" : `Assistant (${sourceLabel})`;
    const body = escapeForkHandoffTags(message.text);
    blocks.push(
      selection.clippedBytes > 0
        ? `[${speaker} — the first ${formatHandoffBytes(selection.clippedBytes).replace("≈", "")} of this message are cut]\n… ${body}`
        : `[${speaker}]\n${body}`
    );
  }
  const status = input.gitStatus === undefined || input.gitStatus === null ? null : gitStatusSection(escapeForkHandoffTags(input.gitStatus));
  return [FORK_HANDOFF_OPEN_TAG, lines.join("\n"), "", blocks.join("\n\n"), ...(status !== null ? ["", status] : []), FORK_HANDOFF_CLOSE_TAG].join("\n");
}
