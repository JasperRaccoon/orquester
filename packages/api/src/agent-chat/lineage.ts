/**
 * Thread lineage (spec 2026-10-14 "agent visuals and session tools" §6): a
 * chat thread forked from another one's message, or delegated by another
 * thread, remembers its parent.
 *
 * One spelling shared by the daemon (the tab record, the routes, the MCP), the
 * host (`thread.created`, the head) and the UI (the chip, the children list,
 * the "merged from a fork" bubble), so no surface can drift.
 *
 * Additive everywhere it is persisted: a record without lineage is a thread
 * with no parent, and a lineage that does not read is dropped — never the
 * record that carries it.
 */

import type { CausedBy } from "./thread.ts";

/**
 * How a child thread came to be: forked from the parent, delegated a task by it, or `opened` by it
 * — a chat another chat opened through `create_session` without `delegate` (unified MCP design
 * 2026-10-15 §4.1, D-15). An older build reads `opened` as no lineage (the record survives).
 */
export type ThreadLineageRelation = "fork" | "delegate" | "opened";

export const THREAD_LINEAGE_RELATIONS: readonly ThreadLineageRelation[] = ["fork", "delegate", "opened"];

/** Where in the parent a fork was taken: the message it was forked from, and that message's turn. */
export interface ThreadForkPoint {
  messageId: string;
  turnId: string;
}

export interface ThreadLineage {
  /** The parent's thread id — equal to its chat session (tab) id. */
  parentThreadId: string;
  relation: ThreadLineageRelation;
  /** Set for a fork taken from a message; absent for a delegate and a fork of the whole thread. */
  forkedFrom?: ThreadForkPoint;
  /** When the child was created. */
  createdAt: string;
  /**
   * How many agent links lie between the top-level thread and this one, this one's own included:
   * every AGENT-CREATED `delegate` or `opened` link counts (unified MCP design 2026-10-15 §5.6,
   * §13 c); a fork carries its parent's, and a link the user or an external client made adds
   * nothing. A top-level thread's delegate: 1. Stamped by the daemon at creation, so closing a
   * thread in the middle never resets it — the agent-depth cap (2) reads it. Absent on records
   * written before it (records written before the unified MCP counted delegate links only).
   */
  delegationDepth?: number;
  /**
   * `true` when a chat tool created this child (`create_session`, `delegate`, `fork_session` from
   * a chat caller; §13 c): only such children are the parent agent's own — counted by the open
   * children cap, and the only ones it may stop, rewind, compact, close or reconfigure. A fork the
   * user made in the GUI, or a session an external client created, carries none. Additive.
   */
  agentCreated?: true;
}

/** The deepest delegation depth a lineage may record (well past any cap). */
export const MAX_LINEAGE_DELEGATION_DEPTH = 64;

/** The longest id a lineage field may carry. Thread ids are UUIDs; message ids are host-minted. */
const MAX_LINEAGE_ID_CHARS = 200;

function lineageId(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_LINEAGE_ID_CHARS &&
    /\S/.test(value)
    ? value
    : undefined;
}

/**
 * Read a lineage field-wise and tolerantly: `undefined` for anything that is
 * not one (absent, a newer shape, a hand edit), and a `forkedFrom` that does
 * not read is dropped on its own. A persisted record must never be lost to a
 * lineage it cannot read.
 */
export function parseThreadLineage(value: unknown): ThreadLineage | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const parentThreadId = lineageId(record.parentThreadId);
  const relation = record.relation;
  if (
    parentThreadId === undefined ||
    typeof relation !== "string" ||
    !(THREAD_LINEAGE_RELATIONS as readonly string[]).includes(relation)
  ) {
    return undefined;
  }
  const createdAt =
    typeof record.createdAt === "string" && record.createdAt.length > 0 ? record.createdAt : "";
  const point = record.forkedFrom;
  let forkedFrom: ThreadForkPoint | undefined;
  if (point !== null && typeof point === "object" && !Array.isArray(point)) {
    const messageId = lineageId((point as Record<string, unknown>).messageId);
    const turnId = lineageId((point as Record<string, unknown>).turnId);
    if (messageId !== undefined && turnId !== undefined) {
      forkedFrom = { messageId, turnId };
    }
  }
  const depth = record.delegationDepth;
  const delegationDepth =
    typeof depth === "number" && Number.isInteger(depth) && depth >= 0 && depth <= MAX_LINEAGE_DELEGATION_DEPTH ? depth : undefined;
  return {
    parentThreadId,
    relation: relation as ThreadLineageRelation,
    ...(forkedFrom !== undefined ? { forkedFrom } : {}),
    createdAt,
    ...(delegationDepth !== undefined ? { delegationDepth } : {}),
    ...(record.agentCreated === true ? { agentCreated: true as const } : {})
  };
}

// ---------------------------------------------------------------------------
// Fork
// ---------------------------------------------------------------------------

/**
 * How a fork's conversation was carried over:
 * - `native` — the provider's own fork (Claude `forkSession`, Codex
 *   `thread/fork`, OpenCode `POST /session/:id/fork`); the child resumes it and
 *   its timeline replays the inherited history.
 * - `transcript` — the provider has no fork (Grok's ACP agent advertises none):
 *   a fresh session, handed the conversation so far as a transcript together
 *   with the child's first message.
 * - `empty` — nothing preceded the fork point (forked before the first
 *   message): a fresh session with the lineage alone.
 * - `unavailable` — turns preceded the fork point, but neither the provider
 *   could fork them nor does the host still hold any of their words (the
 *   parent's window evicted them): a fresh session, and its first row says
 *   the earlier conversation could not be carried over.
 */
export type ThreadForkStrategy = "native" | "transcript" | "empty" | "unavailable";

/**
 * Which part of the parent a fork keeps, by message (§6 "conversation up to
 * that message"). Providers fork at turn boundaries, so the cut is the
 * message's TURN:
 * - an assistant message keeps every turn through its own;
 * - a user message keeps every turn before its own — the fork starts just
 *   before that prompt, and the client offers its text as the fork's draft.
 *
 * No message: the thread's latest settled turn and everything before it.
 */
export interface ThreadForkTarget {
  messageId?: string;
  /**
   * With `messageId`: the message's turn and author as the CLIENT saw them —
   * used only when the host's retained window no longer holds the message (a
   * page loaded with "Load older"); the host's own fold wins whenever it has
   * the message. Without one: the cut by turn alone — through that turn, or
   * before it for `role: "user"` (the MCP's `throughTurn`).
   */
  turnId?: string;
  role?: "user" | "assistant";
}

/** `POST /api/sessions/:id/fork`. */
export interface ForkSessionRequest extends ThreadForkTarget {
  /** The fork's tab title. Defaults to the parent's title with " (fork)". */
  title?: string;
  /**
   * Idempotency key (≤ 200 characters). The same key on the same parent is the
   * same fork: a repeat — in flight or after it landed, across a daemon
   * restart too — answers the tab the first created, never a second one.
   */
  commandId?: string;
  /**
   * Mark the fork agent-created (`ThreadLineage.agentCreated`, unified MCP design 2026-10-15
   * §13 c). PRINCIPAL-GATED: honoured only when the request's server-stamped principal is an agent
   * whose `threadId` is the forked chat (`principal.ts`); ignored from any other caller, socket
   * callers included — a fork the user makes in the GUI is never the agent's child.
   */
  agentCreated?: true;
}

/** The fork tab's default title. */
export function forkTitle(parentTitle: string): string {
  const base = parentTitle.trim() || "Chat";
  return base.endsWith("(fork)") ? base : `${base} (fork)`;
}

// ---------------------------------------------------------------------------
// Merge back
// ---------------------------------------------------------------------------

/** `POST /api/sessions/:id/merge-back` — sent by (or on behalf of) the CHILD. */
export interface MergeBackRequest {
  /**
   * What to send the parent. Absent: the child's final assistant reply (the
   * last settled turn's reply). Trimmed; must leave room for the header.
   */
  text?: string;
  /**
   * Idempotency key — the merge's id: 1 to 180 characters, no `:` (refused
   * with INVALID_COMMAND otherwise, never replaced). A repeat with the same
   * id is the same merge: answered from the queue, or by the parent's
   * receipt. Its first `/turn` goes out under this id; a retry of a QUEUED
   * merge after the parent refused it goes out as `<id>:<n>`, a new command,
   * since the host replays a recorded rejection for an id it has seen. So a
   * merge sent at once and refused at once (the caller hears the refusal;
   * nothing is queued) cannot be sent again under the same id — the parent
   * would answer the same rejection: send it with a new id. The one refusal
   * that is retried is the host's deadline (`isDeadlineRefusal`): a merge it
   * meets is queued (or stays queued) and tried again after a delay.
   */
  commandId?: string;
  /**
   * The mode the parent's turn runs in: `"plan"` when the merge comes from a turn that is
   * planning (session tools' turn policy, `apps/daemon/src/session-tools/turn-policy.ts`), so a
   * planning fork never starts editing work in its parent. Absent: `"default"`.
   */
  interactionMode?: "default" | "plan";
  /**
   * The exchange of the parent turn this merge causes (unified MCP design 2026-10-15 §8.4).
   * SOCKET-TRUSTED (`principal.ts`): honoured from any unix-socket / in-process caller (the
   * catalog executor, the delivery queue) and stripped by the remote transport
   * (`stripRemoteMergeBackFields`), like `TurnCommandBody.causedBy`; the GUI's and external
   * clients' merges start no exchange.
   */
  causedBy?: CausedBy;
}

export type MergeBackDelivery = "sent" | "queued";

export interface MergeBackResponse {
  parentSessionId: string;
  /** `sent`: the parent took the message now. `queued`: it is busy; it gets it once idle. */
  delivery: MergeBackDelivery;
  /** The merge's id (= the `/turn` commandId it is delivered with). */
  mergeId: string;
  /** The parent's sequence after a `sent` delivery. */
  seq?: number;
}

/**
 * One merge the parent has not taken yet: `queued` — waiting for the parent
 * to be idle (or for the host, when it was restarting); `failed` — the parent
 * refused it (`error` says why), and it stays here, delivered again only by
 * the user (`deliver`) or dropped by them (`discard`) — never silently.
 */
export interface PendingMergeBack {
  /**
   * What the queued turn is (unified MCP design 2026-10-15 §8.3): a fork's `merge` (absent reads
   * as `merge`, as from every daemon before the field), a `reply` another chat's turn produced for
   * this one, or a `message` sent with `reply: "wait" | "notify"` that waits for this busy chat's
   * next idle point. For `reply` and `message`, `childSessionId` is the other chat (the one that
   * replied / sent) and `parentSessionId` the one that receives it.
   */
  kind?: "merge" | "reply" | "message";
  mergeId: string;
  parentSessionId: string;
  childSessionId: string;
  queuedAt: string;
  state: "queued" | "failed";
  /** The result as the parent will read it, cut to {@link MERGE_PREVIEW_CHARS}. */
  preview: string;
  /** Refused deliveries so far. */
  attempts: number;
  /** The last refusal, in the parent's words. */
  error?: string;
}

/** How much of a pending merge's text the lineage views show. */
export const MERGE_PREVIEW_CHARS = 200;

/** `POST …/merge-back/:mergeId` — act on a pending merge, from the fork or its parent. */
export interface MergeBackActionRequest {
  /**
   * `deliver`: send it now, whatever the parent is doing — an ordinary
   * `/turn`, so a running turn is steered (Claude, Codex) as any message sent
   * then would be, and a refused one is retried from scratch. `discard`: drop it.
   */
  action: "deliver" | "discard";
}

export interface MergeBackActionResponse {
  mergeId: string;
  outcome: "sent" | "discarded";
  /** The parent's sequence after a `sent`. */
  seq?: number;
}

const MERGE_BACK_HEADER = /^\[Merged back from (fork|delegated task|opened chat) "((?:[^"\\\n]|\\.)*)"\]$/;

const MERGE_BACK_EXPLANATIONS: Record<ThreadLineageRelation, string> = {
  fork: "This conversation was forked earlier; what the fork concluded follows.",
  delegate: "A task delegated from this conversation finished; its result follows.",
  opened: "A chat opened from this conversation sent back its result; it follows."
};

const MERGE_BACK_LABELS: Record<ThreadLineageRelation, string> = {
  fork: "fork",
  delegate: "delegated task",
  opened: "opened chat"
};

function headerLabel(relation: ThreadLineageRelation): string {
  return MERGE_BACK_LABELS[relation];
}

/** Quote a title for the header: one line, `"` and `\` escaped. */
function quoteTitle(title: string): string {
  const oneLine = title.replace(/\s+/g, " ").trim().slice(0, 200) || "Untitled";
  return oneLine.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * The parent's message for a merge back: a header naming the child, one
 * sentence the model reads as context, then the result. Plain text on
 * purpose — every provider reads it as an ordinary user turn, and the UI
 * recognises it ({@link parseMergeBackMessage}) to show a "From a fork" chip.
 */
export function buildMergeBackMessage(input: {
  childTitle: string;
  relation: ThreadLineageRelation;
  text: string;
}): string {
  return `[Merged back from ${headerLabel(input.relation)} "${quoteTitle(input.childTitle)}"]\n${MERGE_BACK_EXPLANATIONS[input.relation]}\n\n${input.text.trim()}`;
}

/** The characters {@link buildMergeBackMessage} adds around `text`, at most. */
export const MERGE_BACK_OVERHEAD_CHARS = 512;

/** A merge-back message read back: who it came from and the result alone. */
export interface ParsedMergeBackMessage {
  relation: ThreadLineageRelation;
  childTitle: string;
  body: string;
}

/** The inverse of {@link buildMergeBackMessage}, or null for any other text. */
export function parseMergeBackMessage(text: string): ParsedMergeBackMessage | null {
  if (!text.startsWith("[Merged back from ")) return null;
  const newline = text.indexOf("\n");
  const header = newline === -1 ? text : text.slice(0, newline);
  const match = MERGE_BACK_HEADER.exec(header);
  if (!match) return null;
  const relation: ThreadLineageRelation = match[1] === "delegated task" ? "delegate" : match[1] === "opened chat" ? "opened" : "fork";
  const childTitle = match[2]!.replace(/\\(.)/g, "$1");
  let rest = newline === -1 ? "" : text.slice(newline + 1);
  const explanation = MERGE_BACK_EXPLANATIONS[relation];
  if (rest.startsWith(explanation)) rest = rest.slice(explanation.length);
  return { relation, childTitle, body: rest.replace(/^\n+/, "") };
}
