/**
 * Agent host — thread lineage's fork, the parts that need no runtime (spec
 * 2026-10-14 §6): which turns a fork keeps, the transcript a provider without
 * a native fork is handed, and where that transcript waits for the child's
 * first message.
 *
 * Providers fork at turn boundaries, so a message names a TURN:
 * an assistant message keeps every turn through its own; a user message keeps
 * every turn before its own (the fork starts just before that prompt). Only
 * settled turns are kept — a provider cannot fork a turn in progress (Codex
 * refuses one by contract, and the others would copy half a reply).
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  escapeForkHandoffTags as escapeHandoffTags,
  FORK_HANDOFF_CLOSE_TAG as CLOSE_TAG,
  FORK_HANDOFF_OPEN_TAG as OPEN_TAG,
  formatHandoffBytes,
  handoffBlocks,
  handoffMessagesOf,
  handoffSummaryOf,
  renderHandoffTranscript,
  selectHandoffMessages,
  SETTLED_TURN_STATES,
  startedTurns,
  type ForkHandoffSummary,
  type StartedTurn,
  type ThreadForkPoint,
  type ThreadForkTarget,
  type ThreadItem,
  type ThreadMessageItem,
  type Turn
} from "@orquester/api/agent-chat";
import { parseForkHandoff, type ForkHandoffRecord } from "@orquester/config";

/** A fork the host refuses; the message is the user's. */
export class ForkRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForkRefusal";
  }
}

export interface ResolvedForkCut {
  /** Started turns the fork keeps, in order. Empty: nothing precedes the fork point. */
  retained: StartedTurn[];
  /** The first started turn after them, or null when the fork keeps every started turn. */
  firstRemovedTurnId: string | null;
  /** The message the fork was taken from, when one was named. */
  forkedFrom?: ThreadForkPoint;
}

const isSettled = (turn: StartedTurn): boolean => SETTLED_TURN_STATES.has(turn.state);

function parentMessage(items: readonly ThreadItem[], messageId: string): ThreadMessageItem | undefined {
  for (const item of items) {
    if (item.kind === "message" && item.id === messageId) return item;
  }
  return undefined;
}

/**
 * Resolve a {@link ThreadForkTarget} against the source's fold. The fold's own
 * message wins; the client's `turnId`/`role` stand in only for a message the
 * retained window no longer holds (one loaded with "Load older"), and then
 * only for a turn the fold knows.
 */
export function resolveForkCut(
  state: { turns: readonly Turn[]; items: readonly ThreadItem[] },
  target: ThreadForkTarget
): ResolvedForkCut {
  const started = startedTurns(state.turns);
  const keep = (count: number, forkedFrom?: ThreadForkPoint): ResolvedForkCut => {
    const retained = started.slice(0, count);
    const unsettled = retained.find((turn) => !isSettled(turn));
    if (unsettled !== undefined) {
      throw new ForkRefusal("That reply is still being written. Fork once the turn has finished.");
    }
    return {
      retained,
      firstRemovedTurnId: started[count]?.turnId ?? null,
      ...(forkedFrom !== undefined ? { forkedFrom } : {})
    };
  };

  const messageId = target.messageId;
  if (messageId === undefined && target.turnId !== undefined) {
    // By turn alone (the MCP's `throughTurn`): through that turn, or before it for `role: "user"`.
    const index = started.findIndex((turn) => turn.turnId === target.turnId);
    if (index === -1) {
      throw new ForkRefusal("That turn is not part of this conversation.");
    }
    const replyId = started[index]!.assistantMessageId;
    return target.role === "user"
      ? keep(index)
      : keep(index + 1, replyId !== null ? { messageId: replyId, turnId: target.turnId } : undefined);
  }
  if (messageId === undefined) {
    // The latest settled message: every turn through the last settled one.
    let last = started.length - 1;
    while (last >= 0 && !isSettled(started[last]!)) last -= 1;
    return keep(last + 1);
  }

  const message = parentMessage(state.items, messageId);
  if (message?.agentId !== undefined) {
    throw new ForkRefusal("Fork from a message of the main conversation, not a subagent's.");
  }
  let role: "user" | "assistant";
  let turnId: string | null;
  if (message !== undefined) {
    if (message.role === "reasoning") {
      throw new ForkRefusal("Fork from a message, not from the agent's reasoning.");
    }
    if (message.streaming && message.role === "assistant") {
      throw new ForkRefusal("That reply is still being written. Fork once the turn has finished.");
    }
    role = message.role;
    // A prompt's turn is the one it opened (`Turn.userMessageId`); a steer
    // into a running turn carries that turn's id itself.
    turnId =
      role === "user"
        ? (started.find((turn) => turn.userMessageId === messageId)?.turnId ?? message.turnId)
        : message.turnId;
  } else if (target.turnId !== undefined && (target.role === "user" || target.role === "assistant")) {
    role = target.role;
    turnId = target.turnId;
  } else {
    throw new ForkRefusal("That message is no longer in this thread's loaded history.");
  }
  if (turnId === null) {
    throw new ForkRefusal("That message has not been answered yet, so there is nothing to fork from.");
  }
  const index = started.findIndex((turn) => turn.turnId === turnId);
  if (index === -1) {
    throw new ForkRefusal("That message's turn is not part of this conversation any more.");
  }
  return keep(role === "assistant" ? index + 1 : index, { messageId, turnId });
}

// ---------------------------------------------------------------------------
// Transcript handoff
// ---------------------------------------------------------------------------

/**
 * The most message text a same-agent transcript carries, in UTF-8 bytes, however large the
 * model's window; within it, what the window leaves ({@link handoffBudgetBytes}).
 */
export const FORK_TRANSCRIPT_MAX_BYTES = 120_000;
/** The most one message contributes; a longer one keeps its head and tail. */
export const FORK_TRANSCRIPT_MESSAGE_MAX_CHARS = 8_000;

// The delimiters and their escaping are shared with the continuation's budgeted transcript
// (`@orquester/api` `handoff.ts`), so {@link stripForkHandoff} strips either kind of handoff.

const isHighSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;
const isLowSurrogate = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff;

/** `text` within `max` characters: its head and tail around a marker, never half a surrogate pair. */
export function clipForkMessage(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor((max - 40) / 2);
  const head = isHighSurrogate(text.charCodeAt(half - 1)) ? half - 1 : half;
  const tail = isLowSurrogate(text.charCodeAt(text.length - half)) ? text.length - half + 1 : text.length - half;
  return `${text.slice(0, head)}\n[… ${tail - head} characters omitted …]\n${text.slice(tail)}`;
}

/**
 * The source's conversation through the kept turns, as plain text: every
 * user prompt and assistant reply of the main conversation (no reasoning, no
 * subagent's words, no tool rows — the provider re-reads files itself), each
 * clipped to {@link FORK_TRANSCRIPT_MESSAGE_MAX_CHARS}, picked as a
 * continuation's are (`selectHandoffMessages`: the original request and the
 * newest prompt and reply first, then the newest history that fits) within
 * `budgetBytes` — the model's window's share, {@link FORK_TRANSCRIPT_MAX_BYTES}
 * by default — every omitted run marked where it was. `null` when the kept
 * turns hold no message the fold still has.
 */
export function buildForkTranscript(input: {
  items: readonly ThreadItem[];
  retained: readonly StartedTurn[];
  parentTitle: string;
  budgetBytes?: number;
}): string | null {
  const messages = handoffMessagesOf(input.items, input.retained).map((message) => ({
    ...message,
    text: clipForkMessage(message.text, FORK_TRANSCRIPT_MESSAGE_MAX_CHARS)
  }));
  if (messages.length === 0) return null;
  // Kept exchanges the fold's window no longer holds a word of (retention
  // evicted them): said, never passed off as the whole story. Only a turn that
  // had words to lose counts — a prompt or a recorded reply; a turn the
  // provider started itself with neither (a goal's continuation, a background
  // wake-up) lost nothing.
  const turnsWithText = new Set(messages.map((message) => message.turn));
  const lostTurns = input.retained.filter(
    (turn, index) =>
      !turnsWithText.has(index + 1) && (turn.userMessageId !== undefined || turn.assistantMessageId !== null)
  ).length;
  const selection = selectHandoffMessages(messages, input.budgetBytes ?? FORK_TRANSCRIPT_MAX_BYTES);
  const { omitted } = selection;
  const cut = selection.messages.filter((message) => message.cutBytes !== undefined).length;
  const title = escapeHandoffTags(input.parentTitle.replace(/\s+/g, " ").trim()) || "the original conversation";
  const preamble =
    `This conversation is a fork of "${title}". The user branched it off at the point below, so ` +
    "treat the transcript as what was said before their next message and continue from there." +
    (lostTurns > 0
      ? ` ${lostTurns} earlier exchange${lostTurns === 1 ? " is" : "s are"} no longer available and ${lostTurns === 1 ? "is" : "are"} missing from it.`
      : "") +
    (omitted > 0
      ? ` ${omitted} message${omitted === 1 ? " was" : "s were"} left out for length${selection.firstRequest ? " (the original request and the newest ones are kept)" : ""}, marked where ${omitted === 1 ? "it was" : "they were"}.`
      : "") +
    (cut > 0 ? ` ${cut === 1 ? "One message is" : `${cut} messages are`} cut in the middle to fit, marked where.` : "");
  const blocks = handoffBlocks(
    selection,
    (message) => `[${message.role === "user" ? "User" : "Assistant"}]\n${escapeHandoffTags(message.text)}`
  );
  return `${OPEN_TAG}\n${preamble}\n\n${blocks.join("\n\n")}\n${CLOSE_TAG}`;
}

/**
 * "Continue in another agent" (a fork onto another adapter or account): the kept turns' user and
 * assistant messages within `budgetBytes` (`continuationBudgetBytes` of the target model's window)
 * — the original request and the newest prompt and reply first, then the newest history that
 * fits — rendered with the source's agent and model, what was left out and how the new agent
 * reads it (`read_transcript` on the parent). `null` when the kept turns hold no message the fold
 * still has — the child then starts fresh (`unavailable`), as a same-agent fork does.
 */
export function buildContinuationTranscript(input: {
  items: readonly ThreadItem[];
  retained: readonly StartedTurn[];
  parentThreadId: string;
  parentTitle: string;
  /** "Claude Opus 4.1": the parent's agent and model. */
  sourceLabel: string;
  /** "Codex": the child's agent. */
  targetLabel: string;
  gitStatus?: string | undefined;
  budgetBytes?: number;
}): { transcript: string; summary: ForkHandoffSummary } | null {
  const messages = handoffMessagesOf(input.items, input.retained);
  if (messages.length === 0) return null;
  const selection = selectHandoffMessages(messages, input.budgetBytes);
  return {
    transcript: renderHandoffTranscript({
      selection,
      source: { sessionId: input.parentThreadId, title: input.parentTitle, label: input.sourceLabel },
      targetLabel: input.targetLabel,
      ...(input.gitStatus !== undefined ? { gitStatus: input.gitStatus } : {})
    }),
    summary: handoffSummaryOf(selection)
  };
}

/** The most `git status --short` text a continuation request may carry (the handoff cuts it further). */
const CONTINUATION_GIT_STATUS_MAX_CHARS = 64 * 1024;

/**
 * `ForkHostThreadRequest.continuation`, read tolerantly: an object is a continuation (its
 * `gitStatus` kept only as a string, capped); anything else — absent included — is none.
 */
export function parseForkContinuation(raw: unknown): { gitStatus?: string } | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const gitStatus = (raw as Record<string, unknown>).gitStatus;
  return typeof gitStatus === "string" ? { gitStatus: gitStatus.slice(0, CONTINUATION_GIT_STATUS_MAX_CHARS) } : {};
}

/** The continuation row's second line: what was carried over, and when the new agent reads it. */
export function continuationDetail(
  strategy: "native" | "transcript" | "empty" | "unavailable",
  handoff: ForkHandoffSummary | undefined,
  targetLabel: string
): string {
  if (strategy === "empty") return `Continued before the first message: ${targetLabel} starts fresh.`;
  if (strategy !== "transcript" || handoff === undefined) {
    return `The conversation before this point could not be carried over: its messages are no longer held here, so ${targetLabel} starts fresh.`;
  }
  const size = formatHandoffBytes(handoff.bytes);
  const when = `handed to ${targetLabel} with your first message`;
  if (handoff.carried === 0) {
    return `None of the ${handoff.total} message${handoff.total === 1 ? "" : "s"} fits ${targetLabel}'s context window, so only a pointer to the original chat's history is ${when}.`;
  }
  const cut = handoff.clipped ? ", the longest cut in the middle to fit" : "";
  if (handoff.carried >= handoff.total) {
    return handoff.clipped
      ? `All ${handoff.total} message${handoff.total === 1 ? "" : "s"} (${size})${cut}, are ${when}; the full text stays readable in the original chat.`
      : `The whole conversation (${handoff.total} message${handoff.total === 1 ? "" : "s"}, ${size}) is ${when}.`;
  }
  const which = handoff.firstRequest ? "the original request and the newest history" : "the newest history";
  return `${handoff.carried} of ${handoff.total} messages (${size}) — ${which}${cut} — are ${when}; the rest stays readable in the original chat.`;
}

/**
 * The child's first real message, with the pending transcript in front of it.
 * A `/command` is never prefixed — it must still dispatch (§4.6.9) — so the
 * transcript waits for the next ordinary message.
 */
export function withForkHandoff(input: string, transcript: string): string | null {
  if (input.trimStart().startsWith("/")) return null;
  return `${transcript}\n\n${input}`;
}

/**
 * Strip a handoff transcript from a replayed prompt, so a resumed history
 * shows what the user typed. The first close tag ends it: the transcript's
 * own text never holds one ({@link escapeHandoffTags}), while the user's
 * message after it may.
 */
export function stripForkHandoff(text: string): string {
  if (!text.startsWith(OPEN_TAG)) return text;
  const end = text.indexOf(CLOSE_TAG);
  return end === -1 ? text : text.slice(end + CLOSE_TAG.length).replace(/^\n+/, "");
}

// ---------------------------------------------------------------------------
// The pending handoff's store
// ---------------------------------------------------------------------------

export interface ForkHandoffStore {
  load(threadId: string): Promise<ForkHandoffRecord | null>;
  save(threadId: string, record: ForkHandoffRecord): Promise<void>;
}

/** `fork-handoff.json` beside `meta.json`: 0600, written atomically, read tolerantly. */
export function createFileForkHandoffStore(pathFor: (threadId: string) => string): ForkHandoffStore {
  return {
    async load(threadId) {
      try {
        return parseForkHandoff(JSON.parse(await readFile(pathFor(threadId), "utf8")) as unknown);
      } catch {
        return null;
      }
    },
    async save(threadId, record) {
      const path = pathFor(threadId);
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      await writeFile(tmp, JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
      await rename(tmp, path);
    }
  };
}

/** For tests and a host built without a state dir. */
export function createMemoryForkHandoffStore(): ForkHandoffStore {
  const records = new Map<string, ForkHandoffRecord>();
  return {
    async load(threadId) {
      return records.get(threadId) ?? null;
    },
    async save(threadId, record) {
      records.set(threadId, record);
    }
  };
}
