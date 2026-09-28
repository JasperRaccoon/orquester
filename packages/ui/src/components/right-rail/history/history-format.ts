/**
 * The History panel's words — pure, so the render check and the tests read
 * the same strings the panel shows.
 */

import type { DiffSummary } from "../../../lib/prompt-history/checkpoints.logic";
import {
  catchUpDelayMs,
  searchIsPaging,
  type PromptIndexState
} from "../../../lib/prompt-history/index-cache";
import type { HistoryPrompt } from "../../../lib/prompt-history/prompts.logic";
import { formatRowTimestamp } from "../../agent-chat/timeline/timestamp-format";
import { deliveredText, type ChatDelivery } from "../chat-target";

export const NO_CHAT_TITLE = "Open a chat tab to see its prompts and checkpoints.";
export const SEARCH_PLACEHOLDER = "Search this chat's prompts…";
export const FALLBACK_NOTE = "Showing the prompts this chat has loaded.";
export const NO_PROMPTS_TITLE = "No prompts yet";
export const NO_PROMPTS_HINT = "The prompts you send in this chat show up here.";
export const NO_CHECKPOINTS_TITLE = "No checkpoints yet";
export const CHECKPOINTS_HINT = "Checkpoints are captured per turn in git projects.";
export const NOT_A_REPO_HINT =
  "This project isn't a git repository, so its turns have no checkpoints.";
export const STARTED_BY_AGENT = "Started by the agent";
export const STARTED_BY_PLAN = "Started by Implement on a proposed plan";
export const STARTED_BY_UNLISTED = "Started by a prompt not shown here";
export const WHOLE_TEXT_LOADING = "Loading the whole prompt…";
export const HOST_CUT_NOTE = "The host keeps only the start of this very long prompt.";
export const SEARCH_OLDER_HINT = "Load older prompts to search further back.";
/** While a search pages the rest of the thread in by itself. */
export const SEARCHING_OLDER = "Searching older prompts…";
/** The host's index is still reading this thread's log; the panel asks again by itself. */
export const CATCHING_UP_NOTE = "Still indexing this chat's history…";
/** The asking gave up: the fallback note's tooltip, over its Retry. */
export const CATCHING_UP_GAVE_UP = "The host was still indexing this chat's history.";

/** A collapsed card previews this many characters of its prompt — never a whole pasted log. */
export const PROMPT_PREVIEW_CHARS = 500;

/** The list mounts this many cards, and this many more per "Show more". */
export const LIST_RENDER_STEP = 200;

/** At most this many changed files are listed in an open checkpoint. */
export const CHECKPOINT_FILES_SHOWN = 50;

/** How long "Inserted" / "Sent" stays up. */
export const DELIVERY_FEEDBACK_MS = 2_000;

/**
 * The start of `text` — at most `max` UTF-16 units, never ending on half a
 * surrogate pair — with "…" when it was cut. What a collapsed card, a
 * checkpoint's one line and a rewind's quote render: the whole text only ever
 * reaches the DOM on an open card.
 */
export function previewText(text: string): string {
  const max = PROMPT_PREVIEW_CHARS;
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end).trimEnd()}…`;
}

/** "Show 200 more" under a list the render cap cut. */
export function showMoreLabel(hidden: number, step: number = LIST_RENDER_STEP): string {
  return `Show ${Math.min(hidden, step)} more`;
}

/** `No prompts match “foo”`. */
export function noMatchTitle(kind: "prompts" | "checkpoints", query: string): string {
  return `No ${kind} match “${query.trim()}”`;
}

/**
 * A prompt's meta line: "Turn 12 · 14:05" for a prompt that started a turn,
 * "Steer · 14:05" for one that joined a running turn, else just the time.
 */
export function promptMetaLabel(
  prompt: Pick<HistoryPrompt, "turnOrdinal" | "turnId" | "createdAt">,
  now?: Date
): string {
  const what =
    prompt.turnOrdinal !== null ? `Turn ${prompt.turnOrdinal}` : prompt.turnId !== null ? "Steer" : "";
  return joinMeta(what, formatRowTimestamp(prompt.createdAt, now));
}

/** A checkpoint's meta line: "Turn 12 · 14:05" (when the turn ended). */
export function checkpointMetaLabel(turnNumber: number, completedAt: string, now?: Date): string {
  return joinMeta(`Turn ${turnNumber}`, formatRowTimestamp(completedAt, now));
}

function joinMeta(what: string, when: string): string {
  return [what, when].filter((part) => part.length > 0).join(" · ");
}

/** "1 file" / "3 files" / "No file changes". */
export function filesLabel(count: number): string {
  if (count === 0) return "No file changes";
  return `${count} file${count === 1 ? "" : "s"}`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** The chip's full sentence, for its tooltip and screen readers. */
export function diffSummaryTitle(summary: DiffSummary): string {
  if (summary.fileCount === 0) return "This turn changed no files";
  const parts = [`${plural(summary.fileCount, "file")} changed`];
  if (summary.additions > 0) parts.push(`${plural(summary.additions, "line")} added`);
  if (summary.deletions > 0) parts.push(`${plural(summary.deletions, "line")} removed`);
  return parts.join(", ");
}

/** "+3 more" under a cut file list. */
export function moreFilesLabel(hidden: number): string {
  return `+${hidden} more`;
}

export interface Feedback {
  tone: "ok" | "error";
  text: string;
}

/** What an Insert or a Send says once it is done. */
export function deliveryFeedback(delivery: ChatDelivery): Feedback {
  if (!delivery.ok) return { tone: "error", text: delivery.reason };
  return { tone: "ok", text: deliveredText(delivery) };
}

/** Where the index stands, as the list's edges show it. */
export type IndexView =
  /** The first page is on its way. */
  | { kind: "loading" }
  | {
      kind: "ready";
      hasOlder: boolean;
      loadingOlder: boolean;
      olderError: string | null;
      /** A search is paging the rest of the thread in by itself (`searchIsPaging`). */
      autoPaging: boolean;
    }
  /**
   * Listing what the chat has loaded, with a one-line note saying why:
   * `busy` while the host's index is still catching up (asked again by
   * itself), `retryable` after a failure — never for a host with no index.
   */
  | { kind: "fallback"; note: string; busy: boolean; retryable: boolean; detail: string | null };

export function indexViewOf(
  state: PromptIndexState | undefined,
  options: {
    /** A search is typed: its pager may be running. */
    searching?: boolean;
  } = {}
): IndexView {
  if (state === undefined || state.status === "loading") return { kind: "loading" };
  switch (state.status) {
    case "ready":
      return {
        kind: "ready",
        hasOlder: state.before !== null,
        loadingOlder: state.loadingOlder,
        olderError: state.olderError,
        autoPaging: options.searching === true && searchIsPaging(state)
      };
    case "catchingUp":
      // Asked again by itself until it gives up; then the user's Retry.
      return catchUpDelayMs(state.catchUpAttempts) !== null || state.refreshing
        ? { kind: "fallback", note: CATCHING_UP_NOTE, busy: true, retryable: false, detail: null }
        : { kind: "fallback", note: FALLBACK_NOTE, busy: false, retryable: true, detail: CATCHING_UP_GAVE_UP };
    case "unindexed":
      return { kind: "fallback", note: FALLBACK_NOTE, busy: false, retryable: false, detail: null };
    case "failed":
      return { kind: "fallback", note: FALLBACK_NOTE, busy: false, retryable: true, detail: state.error };
  }
}
