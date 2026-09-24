/**
 * The tab's outbox (§7.4): everything this tab has on its way out — every
 * composer send still in flight and every queued message not yet delivered —
 * kept with its `commandId` until it settles, so a reload of the tab can
 * finish what the page it replaced started.
 *
 * `submit` clears the draft before a send leaves, so the draft cannot hold a
 * message that is on its way (a reload would resurrect it beside the post),
 * and a queued message lives in the thread store. Before this, a reload lost
 * both: a send came back only if its post had reached the host, and the queue
 * not at all. Now the thread store writes here as it sends and queues, and the
 * thread's first store after a reload takes what the previous page left for
 * its thread (`adoptOutboxLeftovers`): a send is re-posted under the SAME
 * `commandId` — the host's receipt makes a delivered one a no-op (§6.2) — or,
 * past {@link OUTBOX_REPLAY_MAX_AGE_MS}, comes back to the draft; the queue
 * comes back as it was.
 *
 * `sessionStorage`, not `localStorage`: per tab. A reload of this tab resumes
 * it; another tab — a second window on the same thread — never replays it,
 * because that tab's own page may still be posting it. A tab the browser
 * duplicates starts with a copy, and replays it under the same ids, which the
 * receipts dedupe.
 *
 * **Owned by the page that wrote it.** Each entry names the page (one id per
 * page load) that holds it. This page's entries are its own sends and queues,
 * never "left over"; every other page's are what a previous page of this tab
 * left, handed once to the first thread store of this page that asks for
 * their thread, which rewrites them as its own. An entry stays stored until it
 * settles, so a second reload mid-re-post finds it again.
 *
 * Loaded field-wise with a fallback (AGENTS.md: an old bundle's payload
 * outlives a deploy): a value that is not a v1 outbox reads as empty, an entry
 * missing what identifies it is dropped, and a malformed optional field is
 * dropped from its entry, never the entry.
 *
 * Component-free and React-free: the thread store is its one writer.
 */

import {
  DEFAULT_INTERACTION_MODE,
  type AttachmentRef,
  type ComposerContextRecord,
  type InteractionMode,
  type ModelSelection,
  type ProviderOptionSelection
} from "@orquester/api/agent-chat";

import {
  parsePersistedAttachmentRefs,
  parsePersistedContextRecords
} from "../../../lib/agent-chat/composer.logic";
import type { QueuedComposerMessage } from "../../../lib/agent-chat/contracts";

/** The tab's `sessionStorage` key. */
export const COMPOSER_OUTBOX_KEY = "orquester:agent-chat-outbox";

/**
 * How long after its post a send may still be re-posted under its own
 * `commandId` when a reload left it behind.
 *
 * A re-post is free only while the host still recognises the id: receipts are
 * a ring of the host's last 500 commands, every thread's together
 * (`AGENT_RECEIPTS_RING_SIZE`), and a re-post of a send that DID land, made
 * after its receipt left the ring, is a second turn. Ten minutes is far past
 * any reload of a send in flight — a post gives up within about 1¾ minutes
 * (four attempts of `COMMAND_ATTEMPT_TIMEOUT_MS` and the backoff), and after a
 * reload the thread's first store picks it up as soon as the thread is open
 * again — and far short of 500 commands, which would take one every 1.2 s for
 * the whole ten minutes on a single user's host. Past it a send comes back to
 * the draft, and a queued send is held at the front of its queue: nothing is
 * lost, nothing is sent twice, and the user decides.
 */
export const OUTBOX_REPLAY_MAX_AGE_MS = 10 * 60_000;

/**
 * The most entries the outbox keeps, newest last; past it the oldest go. A
 * tab's own sends and queues are a handful at a time — the bound only stops a
 * tab that never reopens a thread from carrying its leftovers forever.
 */
export const MAX_OUTBOX_ENTRIES = 100;

/** A `/turn` body minus its `commandId`, as the thread store posted it. */
export interface OutboxTurn {
  input: string;
  attachments?: AttachmentRef[];
  context?: ComposerContextRecord[];
  interactionMode?: InteractionMode;
  modelSelection?: ModelSelection;
}

/** A composer send (a turn or a steer), from its first post until it settles. */
export interface OutboxSend {
  kind: "send";
  /** The page that holds it. */
  pageId: string;
  sessionId: string;
  commandId: string;
  /** Epoch ms of its first post: what {@link OUTBOX_REPLAY_MAX_AGE_MS} is measured from. */
  sentAt: number;
  turn: OutboxTurn;
  /** An Implement's prompt: a send that does not go out gives nothing back to the draft. */
  generatedPrompt?: true;
}

export type OutboxQueuedMessage = QueuedComposerMessage & { commandId: string };

/** A queued message, from the moment it is queued until it is delivered, returned or drained. */
export interface OutboxQueued {
  kind: "queued";
  pageId: string;
  sessionId: string;
  message: OutboxQueuedMessage;
  /** Epoch ms of the post of it that is on its way; absent while it waits in the queue. */
  sentAt?: number;
}

export type OutboxEntry = OutboxSend | OutboxQueued;

function mintPageId(): string {
  const cryptoRef = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoRef?.randomUUID) return cryptoRef.randomUUID();
  return `page-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

/** This page's id: every entry it writes or adopts carries it. */
let pageId = mintPageId();

/** Test seam: this page forgets everything it wrote — what a reload is. The storage stays. */
export function resetComposerOutbox(): void {
  pageId = mintPageId();
}

function commandIdOf(entry: OutboxEntry): string {
  return entry.kind === "send" ? entry.commandId : entry.message.commandId;
}

/** Whether a send posted at `sentAt` may still be re-posted under its id at `now` (epoch ms). */
export function outboxReplayable(sentAt: number, now: number): boolean {
  const age = now - sentAt;
  // A clock that ran backwards proves nothing about the receipt: not replayed.
  return age >= 0 && age <= OUTBOX_REPLAY_MAX_AGE_MS;
}

// ---------------------------------------------------------------------------
// Load (field-wise, with a fallback)
// ---------------------------------------------------------------------------

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0;

const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function parseInteractionMode(value: unknown): InteractionMode | undefined {
  return value === "default" || value === "plan" ? value : undefined;
}

function isOptionSelection(value: unknown): value is ProviderOptionSelection {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    (typeof value.value === "string" || typeof value.value === "boolean")
  );
}

function parseModelSelection(value: unknown): ModelSelection | undefined {
  if (!isRecord(value) || !isId(value.model)) return undefined;
  return {
    ...(typeof value.instanceId === "string" ? { instanceId: value.instanceId } : {}),
    model: value.model,
    // Kept as present or absent, as it was posted: a selection is compared
    // whole when a Claude session decides whether to restart (§3.4).
    ...(Array.isArray(value.options)
      ? {
          options: value.options
            .filter(isOptionSelection)
            .map((option) => ({ id: option.id, value: option.value }))
        }
      : {})
  };
}

function parseTurn(value: unknown): OutboxTurn | null {
  if (!isRecord(value) || typeof value.input !== "string") return null;
  const interactionMode = parseInteractionMode(value.interactionMode);
  const modelSelection = parseModelSelection(value.modelSelection);
  return {
    input: value.input,
    ...(Array.isArray(value.attachments)
      ? { attachments: parsePersistedAttachmentRefs(value.attachments) }
      : {}),
    ...(Array.isArray(value.context) ? { context: parsePersistedContextRecords(value.context) } : {}),
    ...(interactionMode ? { interactionMode } : {}),
    ...(modelSelection ? { modelSelection } : {})
  };
}

function parseQueuedMessage(value: unknown): OutboxQueuedMessage | null {
  if (!isRecord(value) || !isId(value.id) || !isId(value.commandId) || typeof value.text !== "string") {
    return null;
  }
  return {
    id: value.id,
    commandId: value.commandId,
    text: value.text,
    attachments: parsePersistedAttachmentRefs(value.attachments),
    context: parsePersistedContextRecords(value.context),
    interactionMode: parseInteractionMode(value.interactionMode) ?? DEFAULT_INTERACTION_MODE,
    queuedAfterToolActivityId:
      typeof value.queuedAfterToolActivityId === "string" ? value.queuedAfterToolActivityId : null,
    holdUntilUserAction: value.holdUntilUserAction === true,
    queuedAt: typeof value.queuedAt === "string" ? value.queuedAt : ""
  };
}

function parseEntry(value: unknown): OutboxEntry | null {
  if (!isRecord(value) || !isId(value.pageId) || !isId(value.sessionId)) return null;
  const { pageId: owner, sessionId } = value;
  if (value.kind === "send") {
    const turn = parseTurn(value.turn);
    if (!isId(value.commandId) || !isTime(value.sentAt) || turn === null) return null;
    return {
      kind: "send",
      pageId: owner,
      sessionId,
      commandId: value.commandId,
      sentAt: value.sentAt,
      turn,
      ...(value.generatedPrompt === true ? { generatedPrompt: true as const } : {})
    };
  }
  if (value.kind === "queued") {
    const message = parseQueuedMessage(value.message);
    // A post whose time cannot be read may or may not be on its way: unreadable.
    if (message === null || (value.sentAt !== undefined && !isTime(value.sentAt))) return null;
    return {
      kind: "queued",
      pageId: owner,
      sessionId,
      message,
      ...(value.sentAt === undefined ? {} : { sentAt: value.sentAt })
    };
  }
  return null;
}

/**
 * The outbox as stored. Raw `JSON.parse` output never reaches typed code: a
 * value that is not a v1 outbox is empty, and each entry is read on its own
 * — one it cannot read is dropped, and so is a second entry under an id an
 * earlier one already holds.
 */
export function parseComposerOutbox(raw: string | null): OutboxEntry[] {
  if (!raw) return [];
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isRecord(decoded) || decoded.v !== 1 || !Array.isArray(decoded.entries)) return [];
  const seen = new Set<string>();
  const entries: OutboxEntry[] = [];
  for (const value of decoded.entries) {
    const entry = parseEntry(value);
    if (entry === null || seen.has(commandIdOf(entry))) continue;
    seen.add(commandIdOf(entry));
    entries.push(entry);
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function readEntries(): OutboxEntry[] {
  try {
    if (typeof sessionStorage === "undefined") return [];
    return parseComposerOutbox(sessionStorage.getItem(COMPOSER_OUTBOX_KEY));
  } catch {
    return [];
  }
}

function writeEntries(entries: readonly OutboxEntry[]): void {
  try {
    if (typeof sessionStorage === "undefined") return;
    const bounded = entries.slice(Math.max(0, entries.length - MAX_OUTBOX_ENTRIES));
    if (bounded.length === 0) {
      sessionStorage.removeItem(COMPOSER_OUTBOX_KEY);
      return;
    }
    sessionStorage.setItem(COMPOSER_OUTBOX_KEY, JSON.stringify({ v: 1, entries: bounded }));
  } catch {
    /* blocked storage, the quota — the outbox is a safety net, never a failure */
  }
}

function rewrite(change: (entries: OutboxEntry[]) => OutboxEntry[]): void {
  writeEntries(change(readEntries()));
}

const ownQueueOf = (entry: OutboxEntry, sessionId: string): entry is OutboxQueued =>
  entry.kind === "queued" &&
  entry.sessionId === sessionId &&
  entry.pageId === pageId &&
  entry.sentAt === undefined;

// ---------------------------------------------------------------------------
// This page's writes
// ---------------------------------------------------------------------------

/** A composer send about to be posted: kept until {@link removeOutboxEntry}. */
export function recordOutboxSend(input: {
  sessionId: string;
  commandId: string;
  sentAt: number;
  turn: OutboxTurn;
  generatedPrompt?: boolean;
}): void {
  const entry: OutboxSend = {
    kind: "send",
    pageId,
    sessionId: input.sessionId,
    commandId: input.commandId,
    sentAt: input.sentAt,
    turn: input.turn,
    ...(input.generatedPrompt === true ? { generatedPrompt: true as const } : {})
  };
  rewrite((entries) => [...entries.filter((stored) => commandIdOf(stored) !== input.commandId), entry]);
}

/**
 * A queued message about to be posted. Marked in place, BEFORE the queue drops
 * it — so it keeps its place ahead of the messages queued behind it, and is
 * never missing from the outbox in between.
 */
export function recordOutboxQueuedPost(
  sessionId: string,
  message: OutboxQueuedMessage,
  sentAt: number
): void {
  const posted: OutboxQueued = { kind: "queued", pageId, sessionId, message, sentAt };
  rewrite((entries) => {
    const index = entries.findIndex((entry) => commandIdOf(entry) === message.commandId);
    return index === -1
      ? [...entries, posted]
      : entries.map((entry, position) => (position === index ? posted : entry));
  });
}

/**
 * This page's queue of a thread, as it now stands, in order: it replaces the
 * thread's waiting messages this page holds — and any stored copy of one of
 * them, should the page that adopted it have failed to store that — and leaves
 * alone every send in flight, every other thread's entries and whatever a
 * previous page left. A message without a `commandId` is not kept — none is
 * queued without one.
 */
export function writeOutboxQueue(sessionId: string, messages: readonly QueuedComposerMessage[]): void {
  const queued = messages.flatMap((message): OutboxQueued[] =>
    message.commandId === undefined
      ? []
      : [{ kind: "queued", pageId, sessionId, message: { ...message, commandId: message.commandId } }]
  );
  const ids = new Set(queued.map((entry) => entry.message.commandId));
  rewrite((entries) => [
    ...entries.filter((entry) => !ownQueueOf(entry, sessionId) && !ids.has(commandIdOf(entry))),
    ...queued
  ]);
}

/**
 * A send, or a queued message, that settled — delivered, given back, or held
 * anew under a new id. Forgotten whichever page it is stored under: a page
 * settles only what it wrote or adopted, and one whose adoption never reached
 * the storage would otherwise be adopted, and re-posted, again and again.
 */
export function removeOutboxEntry(commandId: string): void {
  rewrite((entries) => entries.filter((entry) => commandIdOf(entry) !== commandId));
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The messages this page has queued on a thread and not yet posted, in order —
 * what a generation of the thread's store created with nothing retained (the
 * snapshot it would have painted expired) starts its queue from.
 */
export function outboxQueue(sessionId: string): OutboxQueuedMessage[] {
  return readEntries()
    .filter((entry): entry is OutboxQueued => ownQueueOf(entry, sessionId))
    .map((entry) => entry.message);
}

/**
 * What a previous page of this tab left for a thread, in the order it was
 * written — and from now on this page's: handed once, and kept stored until
 * each settles.
 */
export function adoptOutboxLeftovers(sessionId: string): OutboxEntry[] {
  const entries = readEntries();
  const isLeftover = (entry: OutboxEntry): boolean =>
    entry.sessionId === sessionId && entry.pageId !== pageId;
  if (!entries.some(isLeftover)) return [];
  const adopted = entries.map((entry) => (isLeftover(entry) ? { ...entry, pageId } : entry));
  writeEntries(adopted);
  return adopted.filter((entry, index) => isLeftover(entries[index]!));
}
