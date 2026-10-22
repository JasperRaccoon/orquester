/**
 * "Continue in another agent" — the budgeted transcript a chat hands a NEW agent session (thread
 * lineage, spec 2026-10-14 §6, a fork whose target agent or account cannot take a native fork).
 *
 * Pure and shared: the agent host renders the handoff with it, and the client's picker counts with
 * the same budget and selection what the handoff will carry ("23 of 41 messages, ≈58 KB").
 *
 * The rules (after T3 Code's `handoffBudget.ts`, adapted):
 * - the budget is what the TARGET model's context window leaves ({@link handoffBudgetBytes}):
 *   the window less a reserve for the system prompt, tool definitions and the reply, less what
 *   else the first message carries, at one UTF-8 byte per token, never over
 *   {@link HANDOFF_BUDGET_BYTES}; an unknown window is taken as
 *   {@link HANDOFF_FALLBACK_CONTEXT_WINDOW};
 * - only user and assistant messages of the main conversation are carried — never reasoning, a
 *   subagent's words or tool rows (the new agent re-reads files itself);
 * - the anchors come first: the newest prompt, the newest reply and the ORIGINAL request; one too
 *   long to fit is cut in the middle with a marker rather than dropped;
 * - then the newest history that fits, whole messages only; a message that does not fit is left
 *   out and an older one that does still goes in;
 * - the rendering is chronological, attributed, names the source chat's agent and model, marks
 *   every omitted span where it was, and tells the new agent how to read it (the Orquester MCP
 *   `read_transcript` on the source session).
 *
 * No Node APIs: `@orquester/api` is shared with the browser.
 */

import { SETTLED_TURN_STATES, type ThreadItem, type Turn } from "./thread.ts";
import { startedTurns, type StartedTurn } from "./turns.ts";
import type { ThreadForkTarget } from "./lineage.ts";
import type { ModelSelection, ProviderModel } from "./adapter-types.ts";

/** The most message text a handoff carries, in UTF-8 bytes, however large the target's window. */
export const HANDOFF_BUDGET_BYTES = 64 * 1024;

/** The most `git status --short` text a handoff carries (the workflow handoff's own cap). */
export const HANDOFF_GIT_STATUS_BYTES = 8 * 1024;

/** What each carried message adds on top of its text: its attribution line and separators. */
const MESSAGE_OVERHEAD_BYTES = 48;

/** Room for one omitted-span marker ("[… 1234 messages omitted (turns 12–345) …]") and its separators. */
const OMITTED_MARKER_BYTES = 64;

/** The least text worth carrying of a message cut to fit: an anchor with less room is left out. */
const MIN_CUT_TEXT_BYTES = 256;

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
// The budget: what the target model's context window leaves
// ---------------------------------------------------------------------------

/** The context window, in tokens, a handoff assumes when the target model's is unknown (T3 Code's). */
export const HANDOFF_FALLBACK_CONTEXT_WINDOW = 128_000;

/**
 * The least room, in tokens, kept out of the target's window for its system prompt, tool
 * definitions and the work after the handoff; a quarter of a larger window is kept instead.
 */
export const HANDOFF_MIN_RESERVE_TOKENS = 16_000;

/**
 * UTF-8 bytes a token is counted as: one. T3 Code's deliberately pessimistic rate — a token of a
 * byte-level tokenizer is never shorter than a byte, and English prose runs near four bytes a
 * token — so a budget sized with it fits whatever the text, multilingual included.
 */
export const HANDOFF_BYTES_PER_TOKEN = 1;

/** Room the rendered handoff's own words take: its preamble, the `read_transcript` call, the coverage line. */
export const HANDOFF_PREAMBLE_BYTES = 2 * 1024;

/** A context window as a catalogue or a reading states it: a positive number of tokens, else unknown. */
function knownWindow(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

/**
 * The message bytes a handoff may carry into a model with `contextWindow` tokens (unknown:
 * {@link HANDOFF_FALLBACK_CONTEXT_WINDOW}): the window less the reserve
 * (max({@link HANDOFF_MIN_RESERVE_TOKENS}, a quarter of it)), at {@link HANDOFF_BYTES_PER_TOKEN},
 * less `reservedBytes` — what else the same first message carries (the handoff's own words, a
 * `git status`, a prompt) — and never over `capBytes`. Zero when nothing is left.
 *
 * The target is always a fresh session, so no usage of its own is subtracted. The new chat's
 * first message is not known when a continuation's handoff is built (it waits for that message),
 * so the reserve covers it too.
 */
// Adapted from T3 Code (MIT): packages/provider-core/src/server/handoffBudget.ts
export function handoffBudgetBytes(
  input: { contextWindow?: number | null | undefined; reservedBytes?: number; capBytes?: number } = {}
): number {
  const window = knownWindow(input.contextWindow) ?? HANDOFF_FALLBACK_CONTEXT_WINDOW;
  const reserve = Math.max(HANDOFF_MIN_RESERVE_TOKENS, Math.ceil(window / 4));
  const room = (window - reserve) * HANDOFF_BYTES_PER_TOKEN - Math.max(0, input.reservedBytes ?? 0);
  return Math.max(0, Math.floor(Math.min(input.capBytes ?? HANDOFF_BUDGET_BYTES, room)));
}

/**
 * A continuation's budget: {@link handoffBudgetBytes} with the handoff's own words and the
 * largest `git status` section it may carry reserved — the same whatever the status turns out
 * to be, so the picker's count is the host's.
 */
export function continuationBudgetBytes(contextWindow: number | null | undefined): number {
  return handoffBudgetBytes({ contextWindow, reservedBytes: HANDOFF_PREAMBLE_BYTES + HANDOFF_GIT_STATUS_BYTES });
}

/**
 * The newest context-window reading's `maxTokens` in a thread's items (the meter's denominator,
 * `context-window.updated`); undefined when the newest usable reading names none. Rows without a
 * usable `usedTokens` are walked past, as the meter does.
 */
export function latestContextWindowTokens(items: readonly ThreadItem[]): number | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.kind !== "activity" || item.activityKind !== "context-window.updated") continue;
    const payload = item.payload as Record<string, unknown> | null | undefined;
    if (payload === null || typeof payload !== "object") continue;
    const used = payload.usedTokens;
    if (typeof used !== "number" || !Number.isFinite(used) || used < 0) continue;
    return knownWindow(payload.maxTokens);
  }
  return undefined;
}

function sameModelSelection(a: ModelSelection, b: ModelSelection): boolean {
  const options = (selection: ModelSelection) =>
    JSON.stringify([...(selection.options ?? [])].sort((x, y) => x.id.localeCompare(y.id)).map((o) => [o.id, o.value]));
  return a.model === b.model && options(a) === options(b);
}

/**
 * The target model's context window for a handoff, in tokens, or undefined (the budget then
 * assumes {@link HANDOFF_FALLBACK_CONTEXT_WINDOW}):
 * - its catalogue entry's, when the provider lists one (OpenCode, Grok);
 * - else the source chat's newest reading, when the target runs the source's very agent, model
 *   and options (another account of it) — a reading of another model says nothing of this one.
 */
export function handoffContextWindow(input: {
  /** The target's model, and the target agent's catalogue. */
  target: ModelSelection | null | undefined;
  catalog: readonly ProviderModel[] | undefined;
  /** The target runs the source chat's agent (adapter). */
  sameAgent: boolean;
  source: { modelSelection: ModelSelection | null | undefined; items: readonly ThreadItem[] };
}): number | undefined {
  const target = input.target;
  if (target === null || target === undefined) return undefined;
  const listed = knownWindow(input.catalog?.find((model) => model.slug === target.model)?.contextWindow);
  if (listed !== undefined) return listed;
  const source = input.source.modelSelection;
  if (!input.sameAgent || source === null || source === undefined || !sameModelSelection(source, target)) return undefined;
  return latestContextWindowTokens(input.source.items);
}

// ---------------------------------------------------------------------------
// The budgeted selection
// ---------------------------------------------------------------------------

/** A message a handoff carries: whole, or — an anchor too long to fit — cut in the middle. */
export interface CarriedHandoffMessage extends HandoffMessage {
  /** Its position among the fork point's messages (0: the oldest). */
  index: number;
  /** UTF-8 bytes cut from its middle (the marker in `text` says where). Absent when whole. */
  cutBytes?: number;
}

/** A run of messages left out, between carried ones (or before the first, after the last). */
export interface HandoffOmittedSpan {
  /** Positions among the fork point's messages: `start` to `end`, `end` exclusive. */
  start: number;
  end: number;
  /** The transcript turns it spans, when known. */
  fromTurn?: number;
  toTurn?: number;
}

export interface HandoffSelection {
  /** The carried messages, oldest first. */
  messages: CarriedHandoffMessage[];
  /** The runs left out, oldest first. */
  spans: HandoffOmittedSpan[];
  /** Every message the fork point holds. */
  total: number;
  /** How many of them are left out entirely. */
  omitted: number;
  /** UTF-8 bytes of the carried text (cut markers included). */
  bytes: number;
  /** UTF-8 bytes cut from the middle of carried messages, all told. */
  clippedBytes: number;
  /** The original request (the first user message) is carried, whole or cut. */
  firstRequest: boolean;
  /**
   * The transcript turn of the newest word left out — an omitted message, or the cut middle of a
   * carried one — so `read_transcript` can page back from just after it. Absent when nothing was
   * left out, or its turn is unknown.
   */
  lastOmittedTurn?: number;
}

/** The cost of carrying `text` as one message. */
function carryCost(text: string): number {
  return utf8ByteLength(text) + MESSAGE_OVERHEAD_BYTES;
}

/** The marker standing in a cut message for its middle ("[… 812 bytes …]", "[… ≈40 KB …]"). */
function cutMarker(bytes: number): string {
  return `\n[… ${bytes < 1024 ? `${bytes} bytes` : formatHandoffBytes(bytes)} of this message omitted …]\n`;
}

/**
 * `text` within `maxBytes` UTF-8 bytes: whole when it fits, else its head and tail around a
 * marker saying how much of the middle went — never splitting a character. Null when less than
 * {@link MIN_CUT_TEXT_BYTES} of it would be left.
 */
export function cutHandoffText(text: string, maxBytes: number): { text: string; cutBytes: number } | null {
  const bytes = utf8ByteLength(text);
  if (bytes <= maxBytes) return { text, cutBytes: 0 };
  // The widest marker this text can need: fewer bytes cut never print more digits, except that
  // under 1 KB the bytes are spelled out.
  const marker = Math.max(utf8ByteLength(cutMarker(bytes)), utf8ByteLength(cutMarker(Math.min(bytes, 1023))));
  const room = Math.floor(maxBytes) - marker;
  if (room < MIN_CUT_TEXT_BYTES) return null;
  const head = utf8Head(text, Math.ceil(room / 2));
  const tail = utf8Tail(text, room - utf8ByteLength(head));
  const cutBytes = bytes - utf8ByteLength(head) - utf8ByteLength(tail);
  return { text: `${head}${cutMarker(cutBytes)}${tail}`, cutBytes };
}

/** How many runs of left-out messages `carried` (positions, any order) leaves among `count`. */
function countSpans(count: number, carried: Iterable<number>): number {
  const kept = [...carried].sort((a, b) => a - b);
  let spans = 0;
  let next = 0;
  for (const index of kept) {
    if (index > next) spans += 1;
    next = index + 1;
  }
  return next < count ? spans + 1 : spans;
}

/**
 * Water-filling: each cost in full while an equal share of what is left covers it, the rest an
 * equal share each — so a short anchor is never cut to make room for a long one.
 */
function shareRoom(costs: readonly number[], room: number): number[] {
  const shares = new Array<number>(costs.length).fill(0);
  const order = costs.map((cost, index) => ({ cost, index })).sort((a, b) => a.cost - b.cost);
  let left = room;
  order.forEach(({ cost, index }, position) => {
    const share = Math.floor(left / (order.length - position));
    shares[index] = Math.min(cost, share);
    left -= shares[index]!;
  });
  return shares;
}

/**
 * Pick what a handoff carries within `budgetBytes` (T3 Code's anchored selection, with cutting):
 * 1. the anchors — the newest user message, the newest assistant message, the first user
 *    message (the original request) — whole when they fit together; else the room is shared
 *    among them and the longest are cut in the middle, and when even that leaves one too little,
 *    the original request goes first, then the newest reply;
 * 2. then every other message newest first, whole, wherever it still fits.
 * Every omitted run is charged its marker's room; the result is chronological.
 */
// Adapted from T3 Code (MIT): packages/provider-core/src/server/handoffBudget.ts
export function selectHandoffMessages(
  messages: readonly HandoffMessage[],
  budgetBytes: number = HANDOFF_BUDGET_BYTES
): HandoffSelection {
  const budget = Math.max(0, Math.floor(budgetBytes));
  const count = messages.length;
  const carried = new Map<number, { text: string; cutBytes: number }>();
  let used = 0;

  const firstUser = messages.findIndex((message) => message.role === "user");
  const lastOf = (role: HandoffMessage["role"]) => {
    for (let index = count - 1; index >= 0; index -= 1) if (messages[index]!.role === role) return index;
    return -1;
  };
  const anchors = [lastOf("user"), lastOf("assistant"), firstUser].filter(
    (index, position, all) => index >= 0 && all.indexOf(index) === position
  );
  for (let kept = anchors.length; kept > 0; kept -= 1) {
    const candidates = anchors.slice(0, kept);
    const room = budget - countSpans(count, candidates) * OMITTED_MARKER_BYTES;
    const shares = shareRoom(candidates.map((index) => carryCost(messages[index]!.text)), room);
    const cuts = candidates.map((index, position) =>
      cutHandoffText(messages[index]!.text, shares[position]! - MESSAGE_OVERHEAD_BYTES)
    );
    if (cuts.some((cut) => cut === null)) continue;
    candidates.forEach((index, position) => {
      const cut = cuts[position]!;
      carried.set(index, cut);
      used += carryCost(cut.text);
    });
    break;
  }

  // The newest history that fits, whole. Adding a message changes the runs left out by one at
  // most: it splits a run (+1), shortens one (0) or closes one (−1).
  let spans = countSpans(count, carried.keys());
  for (let index = count - 1; index >= 0; index -= 1) {
    if (carried.has(index)) continue;
    const before = index > 0 && !carried.has(index - 1);
    const after = index < count - 1 && !carried.has(index + 1);
    const nextSpans = spans + (before && after ? 1 : before || after ? 0 : -1);
    const cost = carryCost(messages[index]!.text);
    if (used + cost + nextSpans * OMITTED_MARKER_BYTES > budget) continue;
    carried.set(index, { text: messages[index]!.text, cutBytes: 0 });
    used += cost;
    spans = nextSpans;
  }

  const kept: CarriedHandoffMessage[] = [];
  const omittedSpans: HandoffOmittedSpan[] = [];
  let lastOmittedTurn: number | undefined;
  let bytes = 0;
  let clippedBytes = 0;
  let spanStart = -1;
  const closeSpan = (end: number) => {
    if (spanStart === -1) return;
    const from = messages[spanStart]!.turn;
    const to = messages[end - 1]!.turn;
    omittedSpans.push({
      start: spanStart,
      end,
      ...(from !== undefined ? { fromTurn: from } : {}),
      ...(to !== undefined ? { toTurn: to } : {})
    });
    spanStart = -1;
  };
  for (let index = 0; index < count; index += 1) {
    const message = messages[index]!;
    const pick = carried.get(index);
    if (pick === undefined) {
      if (spanStart === -1) spanStart = index;
      if (message.turn !== undefined) lastOmittedTurn = message.turn;
      continue;
    }
    closeSpan(index);
    bytes += utf8ByteLength(pick.text);
    clippedBytes += pick.cutBytes;
    if (pick.cutBytes > 0 && message.turn !== undefined) lastOmittedTurn = message.turn;
    kept.push({ ...message, text: pick.text, index, ...(pick.cutBytes > 0 ? { cutBytes: pick.cutBytes } : {}) });
  }
  closeSpan(count);
  return {
    messages: kept,
    spans: omittedSpans,
    total: count,
    omitted: count - kept.length,
    bytes,
    clippedBytes,
    firstRequest: firstUser >= 0 && carried.has(firstUser),
    ...(lastOmittedTurn !== undefined ? { lastOmittedTurn } : {})
  };
}

/** What a handoff carried, as the fork's answer and its timeline row say it. */
export interface ForkHandoffSummary {
  /** Messages carried (cut ones count). */
  carried: number;
  /** Messages the fork point held. */
  total: number;
  /** UTF-8 bytes of the carried text. */
  bytes: number;
  /** Set when a message too long to fit was carried cut in the middle. */
  clipped?: true;
  /** Set when messages were left out but the original request is carried. */
  firstRequest?: true;
}

export function handoffSummaryOf(selection: HandoffSelection): ForkHandoffSummary {
  return {
    carried: selection.messages.length,
    total: selection.total,
    bytes: selection.bytes,
    ...(selection.clippedBytes > 0 ? { clipped: true as const } : {}),
    ...(selection.firstRequest && selection.omitted > 0 ? { firstRequest: true as const } : {})
  };
}

/**
 * The picker's line for a handoff: "Carries 23 of 41 messages (≈58 KB): the original request and
 * the newest history that fits; the rest stays readable." `moreOlder`: the client's window does
 * not hold the oldest turns, so the total is a floor ("41+").
 */
export function describeHandoffSummary(summary: ForkHandoffSummary, options: { moreOlder?: boolean } = {}): string {
  const total = `${summary.total}${options.moreOlder ? "+" : ""}`;
  if (summary.total === 0) return "Nothing to carry over yet: the new chat starts fresh.";
  if (summary.carried === 0) {
    return `None of the ${total} messages fits this model's context window, so nothing is carried; the history stays readable.`;
  }
  const size = formatHandoffBytes(summary.bytes);
  const cut = summary.clipped ? ", the longest cut in the middle to fit" : "";
  if (summary.carried >= summary.total && !options.moreOlder) {
    return summary.clipped
      ? `Carries all ${summary.total} message${summary.total === 1 ? "" : "s"} (${size})${cut}.`
      : `Carries the whole conversation: ${summary.total} message${summary.total === 1 ? "" : "s"} (${size}).`;
  }
  const which = summary.firstRequest ? "the original request and the newest history that fits" : "the newest history that fits";
  return `Carries ${summary.carried} of ${total} messages (${size}): ${which}${cut}; the rest stays readable.`;
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

/** "[… 18 messages omitted (turns 2–10) …]": an omitted run, where it was. */
export function omittedSpanMarker(span: HandoffOmittedSpan): string {
  const count = span.end - span.start;
  const turns =
    span.fromTurn === undefined || span.toTurn === undefined
      ? ""
      : span.fromTurn === span.toTurn
        ? ` (turn ${span.fromTurn})`
        : ` (turns ${span.fromTurn}–${span.toTurn})`;
  return `[… ${count} message${count === 1 ? "" : "s"} omitted${turns} …]`;
}

/** The selection's blocks in thread order: each carried message (`render`) and each omitted run's marker. */
export function handoffBlocks(selection: HandoffSelection, render: (message: CarriedHandoffMessage) => string): string[] {
  const blocks: string[] = [];
  let span = 0;
  for (const message of selection.messages) {
    while (span < selection.spans.length && selection.spans[span]!.start < message.index) {
      blocks.push(omittedSpanMarker(selection.spans[span]!));
      span += 1;
    }
    blocks.push(render(message));
  }
  for (; span < selection.spans.length; span += 1) blocks.push(omittedSpanMarker(selection.spans[span]!));
  return blocks;
}

/** The handoff's coverage line: how much of the conversation it carries, and how. */
function coverageLine(selection: HandoffSelection): string {
  const size = formatHandoffBytes(selection.bytes);
  if (selection.total === 0) return "No message of that chat could be carried over.";
  if (selection.messages.length === 0) {
    return `None of its ${selection.total} message${selection.total === 1 ? "" : "s"} fits this session's handoff budget, so none is carried here.`;
  }
  const cut = selection.messages.filter((message) => message.cutBytes !== undefined).length;
  const cutNote =
    cut === 0
      ? ""
      : `; ${cut === 1 ? "one message too long to carry whole is" : `${cut} messages too long to carry whole are`} cut in the middle, marked where`;
  if (selection.omitted === 0) {
    return cut === 0
      ? `This carries the whole conversation so far: ${selection.total} message${selection.total === 1 ? "" : "s"} (${size}).`
      : `This carries all ${selection.total} message${selection.total === 1 ? "" : "s"} of the conversation so far (${size})${cutNote}.`;
  }
  const which = selection.firstRequest
    ? ": the original request and the newest history that fits the handoff budget"
    : ": the newest history that fits the handoff budget";
  return (
    `This carries ${selection.messages.length} of ${selection.total} messages (${size})${which}; ` +
    `the ${selection.omitted} left out for length ${selection.omitted === 1 ? "is" : "are"} marked where ${selection.omitted === 1 ? "it was" : "they were"}${cutNote}.`
  );
}

/**
 * The handoff as the new agent reads it with the user's first message: a preamble that says what
 * it is and how to read what was left out, the carried messages oldest first with attribution and
 * every omitted run marked, and the project's `git status --short` when known. Wrapped in
 * {@link FORK_HANDOFF_OPEN_TAG} so a replayed prompt shows only what the user typed.
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
  const partial = selection.omitted > 0 || selection.clippedBytes > 0;
  const lines: string[] = [
    `This conversation continues "${title}", a chat that ran on ${sourceLabel} (Orquester session ${source.sessionId}). ` +
      `The user continued it here, in a new ${escapeForkHandoffTags(input.targetLabel)} session, from the point below: treat the transcript as what was said before their next message and carry on from there. ` +
      `The assistant messages below were written in that chat, not by you in this session; its tool calls, file reads and reasoning are not replayed, so re-read any file you need.`,
    coverageLine(selection),
    `The full history of that chat${partial ? ", the omitted part included," : ", tool calls included,"} stays readable: call the Orquester MCP tool \`read_transcript\` with ${readCall} and page further back with \`beforeTurn\` set to the result's \`olderTurns\` + 1.`
  ];
  const blocks = handoffBlocks(selection, (message) => {
    const speaker = message.role === "user" ? "User" : `Assistant (${sourceLabel})`;
    return `[${speaker}]\n${escapeForkHandoffTags(message.text)}`;
  });
  const status = input.gitStatus === undefined || input.gitStatus === null ? null : gitStatusSection(escapeForkHandoffTags(input.gitStatus));
  return [
    FORK_HANDOFF_OPEN_TAG,
    lines.join("\n"),
    ...(blocks.length > 0 ? ["", blocks.join("\n\n")] : []),
    ...(status !== null ? ["", status] : []),
    FORK_HANDOFF_CLOSE_TAG
  ].join("\n");
}
