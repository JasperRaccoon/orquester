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
 * comes back as it was — held for the user's Send now when nobody has seen it
 * for {@link OUTBOX_QUEUE_ABSENCE_MAX_MS}.
 *
 * `sessionStorage`, not `localStorage`: per tab. A reload of this tab resumes
 * it; another tab — a second window on the same thread — never replays it,
 * because that tab's own page may still be posting it. One exception: a tab
 * the browser DUPLICATES starts with a copy of this one's storage, and its
 * page adopts every send this tab still has in flight and every message in
 * its queue. Their posts carry the same ids, so the host's receipts dedupe
 * them — but a message taken back in one tab (its ✗, or a Stop) is still sent
 * by the other, and a re-post that fails in both comes back into the shared
 * draft twice. Nothing coordinates the two tabs.
 *
 * **Owned by the page that wrote it.** Each entry names the page (one id per
 * page load) that holds it. This page's entries are its own sends and queues,
 * never "left over"; every other page's are what a previous page of this tab
 * left, handed once to the first thread store of this page that asks for
 * their thread, which rewrites them as its own. An entry stays stored until it
 * settles, so a second reload mid-re-post finds it again.
 *
 * Beside the entries, the moment each thread's queue was last on screen or
 * last driven by a live page (`shown`, {@link stampOutboxQueueShown}) —
 * stamped by the thread's store when the page is hidden, on `pagehide`, and
 * when the store generation is torn down — which is what the absence bound
 * measures. A page hidden for hours still drives its queue (each message goes
 * out as it falls due), so its `pagehide` stamps it: an unload of a live page
 * is never an absence.
 *
 * Loaded field-wise with a fallback (AGENTS.md: an old bundle's payload
 * outlives a deploy): a value that is not a v1 outbox reads as empty, an entry
 * missing what identifies it is dropped, a malformed optional field is
 * dropped from its entry, never the entry, and a stamp that is not a time is
 * no stamp.
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
 * How long a thread's queue may go unseen and still go out by itself when it
 * comes back — after a reload, or in a store generation that starts from the
 * queue this page kept because the snapshot it would have painted expired.
 *
 * A queued message is due as soon as its thread is idle, so a queue that
 * comes back is sent on the thread's first frame, before anyone sees it. That
 * is right after an ordinary reload; it is not for a queue nobody has looked
 * at for an hour or a day (a tab the browser discarded and reloaded, a
 * restored session), whose "push and deploy" may no longer be what the user
 * wants. Past this bound, measured from when the queue was last on screen or
 * last driven by a live page — never from when a message was queued: one
 * queued twenty minutes ago behind a turn still running is live after a quick
 * reload — every message comes back held, in order, under its own
 * `commandId`, waiting for its Send now.
 */
export const OUTBOX_QUEUE_ABSENCE_MAX_MS = 10 * 60_000;

/**
 * The most entries the outbox keeps. Past it the oldest messages still
 * WAITING in a queue go first — never a send in flight, whose entry is the one
 * copy of a message that may be on its way. A tab's own sends and queues are a
 * handful at a time; the bound only stops a tab that never reopens a thread
 * from carrying its queue forever.
 */
const MAX_OUTBOX_ENTRIES = 100;

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
  /**
   * Not the draft's — an Implement's prompt or a goal chip action: a send that
   * does not go out gives nothing back to the draft.
   */
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

/** The stored document: the entries, and when each thread's queue was last on screen or driven. */
interface OutboxDocument {
  entries: OutboxEntry[];
  shown: Record<string, number>;
}

function mintPageId(): string {
  const cryptoRef = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoRef?.randomUUID) return cryptoRef.randomUUID();
  return `page-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

/** This page's id: every entry it writes or adopts carries it. */
const pageId = mintPageId();

function commandIdOf(entry: OutboxEntry): string {
  return entry.kind === "send" ? entry.commandId : entry.message.commandId;
}

/** A send whose post may be on its way: never dropped to stay under the cap. */
function inFlight(entry: OutboxEntry): boolean {
  return entry.kind === "send" || entry.sentAt !== undefined;
}

/** Whether a send posted at `sentAt` may still be re-posted under its id at `now` (epoch ms). */
export function outboxReplayable(sentAt: number, now: number): boolean {
  const age = now - sentAt;
  // A clock that ran backwards proves nothing about the receipt: not replayed.
  return age >= 0 && age <= OUTBOX_REPLAY_MAX_AGE_MS;
}

/**
 * Whether a queued message coming back may still go out by itself at `now`:
 * its queue was on screen, or driven by a live page, within
 * {@link OUTBOX_QUEUE_ABSENCE_MAX_MS} — at the thread's last stamp
 * (`shownAt`), or when the message was queued, whichever is later (queued in
 * plain sight after the last stamp, it was seen then).
 * Nothing to measure from, or a clock that ran backwards, is not fresh: such
 * a message waits for the user rather than going out on a guess.
 */
export function outboxQueueFresh(input: {
  shownAt: number | null;
  queuedAt: string;
  now: number;
}): boolean {
  const queuedAt = Date.parse(input.queuedAt);
  const seen = Math.max(
    input.shownAt ?? Number.NEGATIVE_INFINITY,
    Number.isFinite(queuedAt) ? queuedAt : Number.NEGATIVE_INFINITY
  );
  if (!Number.isFinite(seen)) return false;
  const absence = input.now - seen;
  return absence >= 0 && absence <= OUTBOX_QUEUE_ABSENCE_MAX_MS;
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
    ...(typeof value.holdReason === "string" ? { holdReason: value.holdReason } : {}),
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

/** The stamps, field-wise: a thread id and a time, or nothing. */
function parseShown(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  const shown: Record<string, number> = {};
  for (const [sessionId, at] of Object.entries(value)) {
    if (sessionId.length > 0 && isTime(at)) shown[sessionId] = at;
  }
  return shown;
}

function decodeDocument(raw: string | null): OutboxDocument {
  const empty: OutboxDocument = { entries: [], shown: {} };
  if (!raw) return empty;
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (!isRecord(decoded) || decoded.v !== 1 || !Array.isArray(decoded.entries)) return empty;
  const seen = new Set<string>();
  const entries: OutboxEntry[] = [];
  for (const value of decoded.entries) {
    const entry = parseEntry(value);
    if (entry === null || seen.has(commandIdOf(entry))) continue;
    seen.add(commandIdOf(entry));
    entries.push(entry);
  }
  return { entries, shown: parseShown(decoded.shown) };
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function readDocument(): OutboxDocument {
  try {
    if (typeof sessionStorage === "undefined") return { entries: [], shown: {} };
    return decodeDocument(sessionStorage.getItem(COMPOSER_OUTBOX_KEY));
  } catch {
    return { entries: [], shown: {} };
  }
}

/** Under the cap, dropping the oldest WAITING messages only — never a send in flight. */
function bounded(entries: readonly OutboxEntry[]): OutboxEntry[] {
  let excess = entries.length - MAX_OUTBOX_ENTRIES;
  if (excess <= 0) return [...entries];
  return entries.filter((entry) => {
    if (excess > 0 && !inFlight(entry)) {
      excess -= 1;
      return false;
    }
    return true;
  });
}

/** Write the document; `false` when the tab has no storage to keep it in. */
function writeDocument(document: OutboxDocument): boolean {
  try {
    if (typeof sessionStorage === "undefined") return false;
    const entries = bounded(document.entries);
    // A stamp is kept only for a thread that still has a queue to measure.
    const queued = new Set(
      entries.filter((entry) => entry.kind === "queued").map((entry) => entry.sessionId)
    );
    const shown = Object.fromEntries(
      Object.entries(document.shown).filter(([sessionId]) => queued.has(sessionId))
    );
    if (entries.length === 0) {
      sessionStorage.removeItem(COMPOSER_OUTBOX_KEY);
      return true;
    }
    sessionStorage.setItem(
      COMPOSER_OUTBOX_KEY,
      JSON.stringify({ v: 1, entries, ...(Object.keys(shown).length > 0 ? { shown } : {}) })
    );
    return true;
  } catch {
    /* blocked storage, the quota — the outbox is a safety net, never a failure */
    return false;
  }
}

function rewrite(change: (entries: OutboxEntry[]) => OutboxEntry[]): boolean {
  const document = readDocument();
  return writeDocument({ ...document, entries: change(document.entries) });
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
 * queued without one. `false` when the write did not reach the storage (none,
 * or full): the kept queue is then behind the thread's own, and the caller
 * must not start a generation from it as if it were current.
 */
export function writeOutboxQueue(
  sessionId: string,
  messages: readonly QueuedComposerMessage[]
): boolean {
  const queued = messages.flatMap((message): OutboxQueued[] =>
    message.commandId === undefined
      ? []
      : [{ kind: "queued", pageId, sessionId, message: { ...message, commandId: message.commandId } }]
  );
  const ids = new Set(queued.map((entry) => entry.message.commandId));
  return rewrite((entries) => [
    ...entries.filter((entry) => !ownQueueOf(entry, sessionId) && !ids.has(commandIdOf(entry))),
    ...queued
  ]);
}

/**
 * A held message put at the FRONT of this page's queue of a thread — a queued
 * send that failed while no store generation of the thread was live, whose
 * queue is then only here (§7.4): the next generation starts from it, the
 * message first, so nothing queued behind it drains ahead of it. `behind`
 * names the messages (by id) it must follow, as `holdAtFront` has it: sends
 * failing one after the other keep the order they were posted in. `false`
 * when the tab has no storage to keep it in, for the caller to keep it
 * elsewhere.
 */
export function holdOutboxQueuedAtFront(
  sessionId: string,
  message: OutboxQueuedMessage,
  behind?: ReadonlySet<string>
): boolean {
  const held: OutboxQueued = {
    kind: "queued",
    pageId,
    sessionId,
    message: { ...message, holdUntilUserAction: true }
  };
  return rewrite((entries) => {
    const rest = entries.filter((entry) => commandIdOf(entry) !== message.commandId);
    let at = -1;
    if (behind !== undefined) {
      for (let index = rest.length - 1; index >= 0; index -= 1) {
        const entry = rest[index]!;
        if (ownQueueOf(entry, sessionId) && behind.has(entry.message.id)) {
          at = index + 1;
          break;
        }
      }
    }
    if (at === -1) {
      const first = rest.findIndex((entry) => ownQueueOf(entry, sessionId));
      at = first === -1 ? rest.length : first;
    }
    return [...rest.slice(0, at), held, ...rest.slice(at)];
  });
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

/**
 * A thread's queue was on screen, or driven by a live page, until `at` (epoch
 * ms): the page is being hidden or unloaded, or the thread's store generation
 * is being torn down. Kept only while the thread has a queue to measure.
 */
export function stampOutboxQueueShown(sessionId: string, at: number): void {
  const document = readDocument();
  if (!document.entries.some((entry) => entry.kind === "queued" && entry.sessionId === sessionId)) {
    return;
  }
  writeDocument({ ...document, shown: { ...document.shown, [sessionId]: at } });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The messages this page has queued on a thread and not yet posted, in order —
 * what a generation of the thread's store starts its queue from: this page's
 * own queue as it last stood, a message held while no generation was live
 * included.
 */
export function outboxQueue(sessionId: string): OutboxQueuedMessage[] {
  return readDocument()
    .entries.filter((entry): entry is OutboxQueued => ownQueueOf(entry, sessionId))
    .map((entry) => entry.message);
}

/**
 * When a thread's queue was last on screen or driven, by
 * {@link stampOutboxQueueShown}; `null` if never.
 */
export function outboxQueueShownAt(sessionId: string): number | null {
  return readDocument().shown[sessionId] ?? null;
}

/**
 * What a previous page of this tab left for a thread, in the order it was
 * written — and from now on this page's: handed once, and kept stored until
 * each settles.
 */
export function adoptOutboxLeftovers(sessionId: string): OutboxEntry[] {
  const document = readDocument();
  const isLeftover = (entry: OutboxEntry): boolean =>
    entry.sessionId === sessionId && entry.pageId !== pageId;
  if (!document.entries.some(isLeftover)) return [];
  const adopted = document.entries.map((entry) => (isLeftover(entry) ? { ...entry, pageId } : entry));
  writeDocument({ ...document, entries: adopted });
  return adopted.filter((entry, index) => isLeftover(document.entries[index]!));
}
