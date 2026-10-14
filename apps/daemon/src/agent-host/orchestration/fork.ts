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

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  SETTLED_TURN_STATES,
  startedTurns,
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

/** The most a handoff transcript carries; the newest messages win. */
export const FORK_TRANSCRIPT_MAX_CHARS = 120_000;
/** The most one message contributes; a longer one keeps its head and tail. */
export const FORK_TRANSCRIPT_MESSAGE_MAX_CHARS = 8_000;

const OPEN_TAG = "<forked-conversation>";
const CLOSE_TAG = "</forked-conversation>";

/**
 * The parent's own words with the delimiters spelled as entities: a message
 * (or title) that quotes `</forked-conversation>` must not end the block
 * early, or {@link stripForkHandoff} would show the rest of the transcript
 * as the user's message.
 */
function escapeHandoffTags(text: string): string {
  return text.replace(/<(\/?)(forked-conversation)>/gi, "&lt;$1$2&gt;");
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor((max - 40) / 2);
  return `${text.slice(0, half)}\n[… ${text.length - 2 * half} characters omitted …]\n${text.slice(-half)}`;
}

/**
 * The source's conversation through the kept turns, as plain text: every
 * user prompt and assistant reply of the main conversation (no reasoning, no
 * subagent's words, no tool rows — the provider re-reads files itself), the
 * newest first to survive {@link FORK_TRANSCRIPT_MAX_CHARS}. `null` when the
 * kept turns hold no message the fold still has.
 */
export function buildForkTranscript(input: {
  items: readonly ThreadItem[];
  retained: readonly StartedTurn[];
  parentTitle: string;
}): string | null {
  const turnIds = new Set(input.retained.map((turn) => turn.turnId));
  const prompts = new Set(
    input.retained.flatMap((turn) => (turn.userMessageId !== undefined ? [turn.userMessageId] : []))
  );
  const blocks: string[] = [];
  /** Kept turns with at least one message still in the fold's window. */
  const turnsWithText = new Set<string>();
  for (const item of input.items) {
    if (item.kind !== "message" || item.agentId !== undefined || item.role === "reasoning") continue;
    const kept = prompts.has(item.id) || (item.turnId !== null && turnIds.has(item.turnId));
    const text = item.text.trim();
    if (!kept || text.length === 0) continue;
    if (item.turnId !== null && turnIds.has(item.turnId)) turnsWithText.add(item.turnId);
    for (const turn of input.retained) {
      if (turn.userMessageId === item.id) turnsWithText.add(turn.turnId);
    }
    blocks.push(
      `[${item.role === "user" ? "User" : "Assistant"}]\n${escapeHandoffTags(clip(text, FORK_TRANSCRIPT_MESSAGE_MAX_CHARS))}`
    );
  }
  if (blocks.length === 0) return null;
  // Kept exchanges the fold's window no longer holds a word of (retention
  // evicted them): said, never passed off as the whole story. Only a turn that
  // had words to lose counts — a prompt or a recorded reply; a turn the
  // provider started itself with neither (a goal's continuation, a background
  // wake-up) lost nothing.
  const lostTurns = input.retained.filter(
    (turn) =>
      !turnsWithText.has(turn.turnId) &&
      (turn.userMessageId !== undefined || turn.assistantMessageId !== null)
  ).length;
  let used = 0;
  let first = blocks.length;
  while (first > 0 && used + blocks[first - 1]!.length + 2 <= FORK_TRANSCRIPT_MAX_CHARS) {
    first -= 1;
    used += blocks[first]!.length + 2;
  }
  const omitted = first;
  const title = escapeHandoffTags(input.parentTitle.replace(/\s+/g, " ").trim()) || "the original conversation";
  const preamble =
    `This conversation is a fork of "${title}". The user branched it off at the point below, so ` +
    "treat the transcript as what was said before their next message and continue from there." +
    (lostTurns > 0
      ? ` ${lostTurns} earlier exchange${lostTurns === 1 ? " is" : "s are"} no longer available and ${lostTurns === 1 ? "is" : "are"} missing from it.`
      : "") +
    (omitted > 0 ? ` The ${omitted} oldest message${omitted === 1 ? " was" : "s were"} left out for length.` : "");
  return `${OPEN_TAG}\n${preamble}\n\n${blocks.slice(first).join("\n\n")}\n${CLOSE_TAG}`;
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
  remove(threadId: string): Promise<void>;
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
    },
    async remove(threadId) {
      await rm(pathFor(threadId), { force: true });
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
    },
    async remove(threadId) {
      records.delete(threadId);
    }
  };
}
