/**
 * The right rail's History — the thread's own prompts, as the panel lists them.
 *
 * Two sources, one list:
 *
 *  - **What the chat has loaded** — the retained window, plus the older history
 *    the chat itself pulled in (its loaded history pages and the bridge). Whole
 *    texts, live, and in log order.
 *  - **The host's index** (`GET …/prompts`) — every prompt the thread ever had,
 *    newest first, each cut at `THREAD_PROMPT_TEXT_MAX_CHARS`.
 *
 * The chat's copy wins wherever both hold a prompt (its text is whole), and the
 * index fills in what is older. Which user messages are prompts at all, and
 * their text, is ONE rule for the host and this client: `recallablePromptText`.
 *
 * Pure and React-free; `hooks.ts` is the only React module here.
 */

import {
  isPlanImplementationMessage,
  isProviderInternalUserText,
  recallablePromptText,
  startedTurns
} from "@orquester/api/agent-chat";
import type {
  ThreadHistoryPage,
  ThreadItem,
  ThreadMessageItem,
  ThreadPromptEntry,
  Turn
} from "@orquester/api/agent-chat";

// ---------------------------------------------------------------------------
// The list's row
// ---------------------------------------------------------------------------

export interface HistoryPrompt {
  messageId: string;
  /** The reusable text (`recallablePromptText`), cut when {@link truncated}. */
  text: string;
  /** The index cut `text`; the whole one is `GET …/prompts/:messageId` away. */
  truncated: boolean;
  /**
   * The turn the prompt STARTED; for a steer, the turn it steered; null when
   * no turn claims it (yet).
   */
  turnId: string | null;
  /**
   * The 1-based ordinal — by ORDER of started turns, the count `/revert`
   * speaks — of the turn this prompt started. Null for a steer, a
   * message-mode answer, or a prompt whose turn has not started.
   */
  turnOrdinal: number | null;
  createdAt: string;
  /** Held by the chat (whole text), or known only from the host's index. */
  source: "loaded" | "index";
  /** The index's `rewindable`; null for a loaded prompt, whose timeline row decides. */
  indexRewindable: boolean | null;
}

/**
 * A parent user message the chat holds that is NOT a reusable prompt — what
 * opened a turn when no listed prompt did:
 * - `agent`: a row the provider's transcript wrote itself (a task
 *   notification, a command echo) — the CLI started that turn;
 * - `plan`: the Implement prompt the app composed from a proposed plan;
 * - `other`: anything else (a verbatim `/compact`, an image-only message).
 */
export type UnlistedPromptKind = "agent" | "plan" | "other";

export interface LoadedPrompts {
  /** Newest first. */
  prompts: readonly HistoryPrompt[];
  /** Every loaded parent user message that is not a prompt, by id. */
  unlisted: ReadonlyMap<string, UnlistedPromptKind>;
}

export const EMPTY_LOADED_PROMPTS: LoadedPrompts = { prompts: [], unlisted: new Map() };

// ---------------------------------------------------------------------------
// Turn claims
// ---------------------------------------------------------------------------

interface PromptTurnClaim {
  turnId: string;
  /** 1-based, among the started turns. */
  ordinal: number;
}

/**
 * Which prompt opened which started turn: `Turn.userMessageId` → the turn and
 * its ordinal among `startedTurns`. A live prompt is persisted before the
 * provider mints its turn id, so the turn row naming it is its only link to
 * that turn. First turn wins, as in the timeline's rewind numbering
 * (`rows.logic.ts` `buildRevertTurnCountByUserMessageId`).
 */
function promptTurnClaims(turns: readonly Turn[]): ReadonlyMap<string, PromptTurnClaim> {
  const claims = new Map<string, PromptTurnClaim>();
  startedTurns(turns).forEach((turn, index) => {
    if (turn.userMessageId !== undefined && !claims.has(turn.userMessageId)) {
      claims.set(turn.userMessageId, { turnId: turn.turnId, ordinal: index + 1 });
    }
  });
  return claims;
}

/** The ids of every turn the fold knows. A revert removes its turns — and so what they claimed. */
export function knownTurnIdsOf(turns: readonly Turn[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const turn of turns) {
    if (turn.turnId !== null) ids.add(turn.turnId);
  }
  return ids;
}

/** Turn id → its 1-based ordinal among the started turns. */
export function turnOrdinalsOf(turns: readonly Turn[]): ReadonlyMap<string, number> {
  const ordinals = new Map<string, number>();
  startedTurns(turns).forEach((turn, index) => ordinals.set(turn.turnId, index + 1));
  return ordinals;
}

// ---------------------------------------------------------------------------
// What the chat has loaded
// ---------------------------------------------------------------------------

/** A user message of the PARENT conversation — never a subagent's (§7.2). */
function isParentUserMessage(item: ThreadItem): item is ThreadMessageItem {
  return (
    item.kind === "message" &&
    item.role === "user" &&
    (item.agentId === undefined || item.agentId.length === 0)
  );
}

/** Messages keep their identity until they change, so the rule runs once per message. */
const recallableTextCache = new WeakMap<ThreadMessageItem, string | null>();

function recallableTextOf(message: ThreadMessageItem): string | null {
  const cached = recallableTextCache.get(message);
  if (cached !== undefined) return cached;
  const text = recallablePromptText(message.text);
  recallableTextCache.set(message, text);
  return text;
}

function unlistedKindOf(message: ThreadMessageItem): UnlistedPromptKind {
  if (isProviderInternalUserText(message.text)) return "agent";
  if (isPlanImplementationMessage(message.text)) return "plan";
  return "other";
}

/** The parent user messages of one list, in its order. */
function parentUserMessagesOf(items: readonly ThreadItem[]): ThreadMessageItem[] {
  const messages: ThreadMessageItem[] = [];
  for (const item of items) {
    if (isParentUserMessage(item)) messages.push(item);
  }
  return messages;
}

/** The loaded history's parent user messages — every page (oldest first), then the bridge — once each. */
interface HistoryUserMessages {
  messages: readonly ThreadMessageItem[];
  /** Message id → its place in {@link messages}. */
  at: ReadonlyMap<string, number>;
}

const EMPTY_HISTORY_MESSAGES: HistoryUserMessages = { messages: [], at: new Map() };

/**
 * The loaded history's parent user messages, oldest first, once each: the
 * pages, then the bridge. A message two of them hold keeps its OLDEST place
 * with the newest copy — the timeline's own rule for rows a page shares with
 * the window.
 */
function historyUserMessages(
  pages: readonly ThreadHistoryPage[],
  bridge: readonly ThreadItem[]
): HistoryUserMessages {
  if (pages.length === 0 && bridge.length === 0) return EMPTY_HISTORY_MESSAGES;
  const messages: ThreadMessageItem[] = [];
  const at = new Map<string, number>();
  const take = (item: ThreadItem): void => {
    if (!isParentUserMessage(item)) return;
    const index = at.get(item.id);
    if (index === undefined) {
      at.set(item.id, messages.length);
      messages.push(item);
    } else {
      messages[index] = item;
    }
  };
  for (const page of pages) page.items.forEach(take);
  bridge.forEach(take);
  return { messages, at };
}

/**
 * The window's parent user messages joined under the loaded history's: a
 * message both hold stays at the history's (older) place with the window's
 * (newer) copy, and the rest follow in the window's order.
 */
function joinLoadedUserMessages(
  history: HistoryUserMessages,
  windowMessages: readonly ThreadMessageItem[]
): ThreadMessageItem[] {
  if (history.messages.length === 0) return [...windowMessages];
  let replaced: ThreadMessageItem[] | null = null;
  const after: ThreadMessageItem[] = [];
  for (const message of windowMessages) {
    const index = history.at.get(message.id);
    if (index === undefined) {
      after.push(message);
    } else if (history.messages[index] !== message) {
      (replaced ??= [...history.messages])[index] = message;
    }
  }
  return [...(replaced ?? history.messages), ...after];
}

/** One loaded message as a listed prompt, or null when it is not one the user can reuse. */
function loadedPrompt(
  message: ThreadMessageItem,
  claims: ReadonlyMap<string, PromptTurnClaim>
): HistoryPrompt | null {
  const text = recallableTextOf(message);
  if (text === null) return null;
  const claim = claims.get(message.id);
  return {
    messageId: message.id,
    text,
    truncated: false,
    turnId: claim?.turnId ?? message.turnId,
    turnOrdinal: claim?.ordinal ?? null,
    createdAt: message.createdAt,
    source: "loaded",
    indexRewindable: null
  };
}

export interface LoadedPromptsInput {
  pages: readonly ThreadHistoryPage[];
  bridge: readonly ThreadItem[];
  entries: readonly ThreadItem[];
  turns: readonly Turn[];
}

function sameMessages(left: readonly ThreadMessageItem[], right: readonly ThreadMessageItem[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function sameClaim(prompt: HistoryPrompt, claim: PromptTurnClaim | undefined, message: ThreadMessageItem): boolean {
  return (
    prompt.turnId === (claim?.turnId ?? message.turnId) &&
    prompt.turnOrdinal === (claim?.ordinal ?? null)
  );
}

/**
 * {@link LoadedPrompts} for a thread, memoised for a surface that must not
 * re-render on every streamed token. The window's `entries` array is replaced
 * on every token, but its user messages keep their identity (they never
 * stream) — so the result is handed back BY IDENTITY until a prompt appears,
 * leaves, or moves to another turn, and every unchanged prompt keeps its
 * object. The loaded history (pages, bridge) is walked only when one of its
 * arrays is replaced; per token, only the window's own array is.
 *
 * One memo per consumer: it remembers only the last input it saw.
 */
export function createLoadedPromptsMemo(): (input: LoadedPromptsInput) => LoadedPrompts {
  let lastPages: readonly ThreadHistoryPage[] | null = null;
  let lastBridge: readonly ThreadItem[] | null = null;
  let lastEntries: readonly ThreadItem[] | null = null;
  let lastTurns: readonly Turn[] | null = null;
  let history: HistoryUserMessages = EMPTY_HISTORY_MESSAGES;
  let claims: ReadonlyMap<string, PromptTurnClaim> = new Map();
  let lastHistory: HistoryUserMessages | null = null;
  let lastWindow: readonly ThreadMessageItem[] = [];
  let lastClaims: ReadonlyMap<string, PromptTurnClaim> | null = null;
  let result: LoadedPrompts = EMPTY_LOADED_PROMPTS;
  const promptByMessage = new WeakMap<ThreadMessageItem, HistoryPrompt>();

  return (input) => {
    if (
      input.pages === lastPages &&
      input.bridge === lastBridge &&
      input.entries === lastEntries &&
      input.turns === lastTurns
    ) {
      return result;
    }
    if (input.pages !== lastPages || input.bridge !== lastBridge) {
      lastPages = input.pages;
      lastBridge = input.bridge;
      history = historyUserMessages(input.pages, input.bridge);
    }
    if (input.turns !== lastTurns) {
      lastTurns = input.turns;
      claims = promptTurnClaims(input.turns);
    }
    lastEntries = input.entries;
    const windowMessages = parentUserMessagesOf(input.entries);
    if (history === lastHistory && claims === lastClaims && sameMessages(windowMessages, lastWindow)) {
      return result;
    }
    lastHistory = history;
    lastClaims = claims;
    lastWindow = windowMessages;
    const messages = joinLoadedUserMessages(history, windowMessages);
    const prompts: HistoryPrompt[] = [];
    const unlisted = new Map<string, UnlistedPromptKind>();
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]!;
      const kept = promptByMessage.get(message);
      const claim = claims.get(message.id);
      if (kept !== undefined && sameClaim(kept, claim, message)) {
        prompts.push(kept);
        continue;
      }
      const prompt = loadedPrompt(message, claims);
      if (prompt === null) {
        unlisted.set(message.id, unlistedKindOf(message));
        continue;
      }
      promptByMessage.set(message, prompt);
      prompts.push(prompt);
    }
    // Both halves are compared by content before they may replace the last
    // ones: a message that moved in the window but not in the list (a page
    // landing under it) must not hand the panel a new array.
    const nextPrompts = sameList(prompts, result.prompts) ? result.prompts : prompts;
    const nextUnlisted = sameUnlisted(unlisted, result.unlisted) ? result.unlisted : unlisted;
    if (nextPrompts !== result.prompts || nextUnlisted !== result.unlisted) {
      result = { prompts: nextPrompts, unlisted: nextUnlisted };
    }
    return result;
  };
}

function sameUnlisted(
  left: ReadonlyMap<string, UnlistedPromptKind>,
  right: ReadonlyMap<string, UnlistedPromptKind>
): boolean {
  if (left.size !== right.size) return false;
  for (const [id, kind] of left) {
    if (right.get(id) !== kind) return false;
  }
  return true;
}

function sameList<T>(left: readonly T[], right: readonly T[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// The index's pages
// ---------------------------------------------------------------------------

/** Entries keep their identity while their page is cached, and so does their row. */
const indexPromptCache = new WeakMap<ThreadPromptEntry, HistoryPrompt>();

/** One index entry as a listed prompt. */
function indexPrompt(entry: ThreadPromptEntry): HistoryPrompt {
  const cached = indexPromptCache.get(entry);
  if (cached !== undefined) return cached;
  const prompt: HistoryPrompt = {
    messageId: entry.messageId,
    text: entry.text,
    truncated: entry.truncated,
    turnId: entry.turnId,
    turnOrdinal: entry.turnOrdinal,
    createdAt: entry.createdAt,
    source: "index",
    indexRewindable: entry.rewindable
  };
  indexPromptCache.set(entry, prompt);
  return prompt;
}

/**
 * The panel's list, NEWEST FIRST.
 *
 * - **Dedupe by message id; the chat's copy wins** — its text is whole and its
 *   turn is the live fold's.
 * - **An index entry whose turn the fold no longer knows is dropped**: the
 *   fold keeps every turn (retention evicts rows, never turns), so such a turn
 *   was reverted away — and a page fetched before the rewind still lists it.
 *   `knownTurnIds` is null while the thread has no snapshot to judge by.
 * - **Order**: the loaded prompts keep their log order and the index entries
 *   theirs (by `seq`, as the host sent them). The two are merged by
 *   `createdAt`, newest first, each list's own order preserved — so a loaded
 *   prompt never moves relative to another loaded one, and an index entry the
 *   chat lacks lands where its time puts it. On equal times the loaded prompt
 *   comes first. Deterministic for the same inputs.
 */
export function mergeHistoryPrompts(
  loaded: readonly HistoryPrompt[],
  index: readonly ThreadPromptEntry[],
  knownTurnIds: ReadonlySet<string> | null
): HistoryPrompt[] {
  const seen = new Set<string>();
  for (const prompt of loaded) seen.add(prompt.messageId);
  const older: HistoryPrompt[] = [];
  for (const entry of index) {
    if (seen.has(entry.messageId)) continue;
    if (entry.turnId !== null && knownTurnIds !== null && !knownTurnIds.has(entry.turnId)) continue;
    seen.add(entry.messageId);
    older.push(indexPrompt(entry));
  }
  if (older.length === 0) return [...loaded];
  if (loaded.length === 0) return older;
  const merged: HistoryPrompt[] = [];
  let left = 0;
  let right = 0;
  while (left < loaded.length && right < older.length) {
    // Strictly newer index entries go first; a tie keeps the loaded one ahead.
    if (older[right]!.createdAt > loaded[left]!.createdAt) {
      merged.push(older[right]!);
      right += 1;
    } else {
      merged.push(loaded[left]!);
      left += 1;
    }
  }
  while (left < loaded.length) merged.push(loaded[left++]!);
  while (right < older.length) merged.push(older[right++]!);
  return merged;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Text as search compares it: compatibility-decomposed, every combining mark
 * dropped, lower-cased — so "café" matches "cafe", "ÉCOLE" matches "ecole",
 * and "ﬁle" matches "file".
 */
export function foldSearchText(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase();
}

/** The query's words, folded; blank words dropped. */
export function searchTermsOf(query: string): string[] {
  return foldSearchText(query)
    .split(/\s+/u)
    .filter((term) => term.length > 0);
}

/** Every term appears in the (folded) text. No terms matches everything. */
export function matchesSearchTerms(foldedText: string, terms: readonly string[]): boolean {
  return terms.every((term) => foldedText.includes(term));
}

const foldedTextCache = new WeakMap<HistoryPrompt, string>();

function foldedTextOf(prompt: HistoryPrompt): string {
  const cached = foldedTextCache.get(prompt);
  if (cached !== undefined) return cached;
  const folded = foldSearchText(prompt.text);
  foldedTextCache.set(prompt, folded);
  return folded;
}

/**
 * The prompts whose text holds every word of `query` — case- and
 * diacritic-insensitive, in any order. A blank query hands the list back.
 */
export function filterPromptsBySearch(
  prompts: readonly HistoryPrompt[],
  query: string
): readonly HistoryPrompt[] {
  const terms = searchTermsOf(query);
  if (terms.length === 0) return prompts;
  return prompts.filter((prompt) => matchesSearchTerms(foldedTextOf(prompt), terms));
}
