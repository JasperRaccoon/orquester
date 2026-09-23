/**
 * The command palette's "Search conversations" mode — the pure half (design
 * 2026-09-23 "thread index and lazy boot", §C "Search" and "Client").
 *
 * The palette searches every indexed chat thread on the host
 * (`GET /api/agent/search`, full text, ranked by the host) and a hit opens
 * its tab and reveals its turn. Everything here is a decision about text and
 * state; the component owns the debounce, the request and the keyboard.
 */

import {
  THREAD_SEARCH_MAX_QUERY_CHARS,
  type ThreadSearchHit,
  type ThreadSearchResponse
} from "@orquester/api/agent-chat";

import { AgentChatCommandError } from "../../lib/agent-chat/transport";

/** "go" is the palette as it always was; "search" is the conversation search. */
export type PaletteMode = "go" | "search";

/** Typed first in the input, it switches the palette into search mode. */
export const CONVERSATION_SEARCH_PREFIX = "?";

/** The design's debounce: one request per pause, not one per keystroke. */
export const CONVERSATION_SEARCH_DEBOUNCE_MS = 250;

/** Hits asked for per search. */
export const CONVERSATION_SEARCH_LIMIT = 20;

/**
 * An input change in `mode`: a `?` typed as the FIRST character of an
 * ordinary query switches to search mode and is swallowed — the chip lights
 * up instead — while a `?` typed inside the mode is just text.
 */
export function paletteInputChange(
  mode: PaletteMode,
  value: string
): { mode: PaletteMode; query: string } {
  if (mode === "go" && value.startsWith(CONVERSATION_SEARCH_PREFIX)) {
    return { mode: "search", query: value.slice(CONVERSATION_SEARCH_PREFIX.length) };
  }
  return { mode, query: value };
}

/** What is sent: trimmed, and never longer than the host reads. "" sends nothing. */
export function conversationSearchQuery(text: string): string {
  return text.trim().slice(0, THREAD_SEARCH_MAX_QUERY_CHARS).trim();
}

export interface SnippetSegment {
  text: string;
  /** Inside the host's `«…»` marks: the words that matched. */
  match: boolean;
}

const MARK_OPEN = "«";
const MARK_CLOSE = "»";

/**
 * Split a hit's snippet on the host's `«`/`»` marks. An opening mark with no
 * closing one is text, not the start of a highlight that swallows the rest.
 */
export function snippetSegments(snippet: string): SnippetSegment[] {
  const segments: SnippetSegment[] = [];
  const push = (text: string, match: boolean): void => {
    if (text.length > 0) {
      segments.push({ text, match });
    }
  };
  let rest = snippet;
  while (rest.length > 0) {
    const open = rest.indexOf(MARK_OPEN);
    const close = open === -1 ? -1 : rest.indexOf(MARK_CLOSE, open + MARK_OPEN.length);
    if (open === -1 || close === -1) {
      push(rest, false);
      break;
    }
    push(rest.slice(0, open), false);
    push(rest.slice(open + MARK_OPEN.length, close), true);
    rest = rest.slice(close + MARK_CLOSE.length);
  }
  return segments;
}

/** "You" / "Assistant" / "Thinking" for a message; an activity's kind family. */
export function searchHitKindLabel(hit: ThreadSearchHit): string {
  if (hit.kind === "message") {
    switch (hit.role) {
      case "user":
        return "You";
      case "reasoning":
        return "Thinking";
      default:
        return "Assistant";
    }
  }
  const family = (hit.activityKind ?? "").split(".")[0]?.trim() ?? "";
  if (family.length === 0) {
    return "Activity";
  }
  const words = family.replace(/[-_]+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export type ConversationSearchState =
  /** Nothing typed yet. */
  | { status: "idle" }
  /** A request is pending; `previous` keeps the last answer on screen meanwhile. */
  | { status: "loading"; query: string; previous: ThreadSearchResponse | null }
  | { status: "done"; query: string; response: ThreadSearchResponse }
  /**
   * The request itself failed. `retryable` marks a host the client could not
   * reach — a dropped connection, a 503 `HOST_UNAVAILABLE` while it restarts —
   * as opposed to one that answered with an error.
   */
  | { status: "error"; query: string; message: string; retryable: boolean };

/**
 * A failed search request. **Never** "unavailable": an index the host cannot
 * use is a 200 with `indexed: false` (also what a host older than search
 * answers), and only that reads as "Search is unavailable on this host". An
 * HTTP error is a failure of this request, and the list offers to retry it.
 */
export function conversationSearchFailure(query: string, error: unknown): ConversationSearchState {
  if (error instanceof AgentChatCommandError && error.retryable) {
    return { status: "error", query, message: error.message, retryable: true };
  }
  const message =
    error instanceof Error && error.message.trim().length > 0 ? error.message : "The search failed.";
  return { status: "error", query, message, retryable: false };
}

/** The answer whose hits are on screen: the current one, or the previous while loading. */
export function shownSearchResponse(state: ConversationSearchState): ThreadSearchResponse | null {
  if (state.status === "done") {
    return state.response;
  }
  return state.status === "loading" ? state.previous : null;
}

export interface SearchNotice {
  kind: "hint" | "loading" | "unavailable" | "empty" | "error" | "truncated";
  text: string;
}

export const SEARCH_UNAVAILABLE_TEXT = "Search is unavailable on this host";

/**
 * What the list says instead of its rows — or, for `truncated`, under them.
 * `visibleCount` is how many hits the palette may actually show: a hit in an
 * archived project stays behind the curtain, so "No matches" is judged on
 * what is visible, never on what the host found.
 */
export function conversationSearchNotice(
  state: ConversationSearchState,
  visibleCount: number
): SearchNotice | null {
  switch (state.status) {
    case "idle":
      return { kind: "hint", text: "Search every open conversation" };
    case "error":
      return state.retryable
        ? { kind: "error", text: "Couldn't reach the agent host — try again" }
        : { kind: "error", text: `Search failed: ${state.message}` };
    case "loading":
      return state.previous === null || visibleCount === 0
        ? { kind: "loading", text: "Searching…" }
        : null;
    case "done": {
      if (!state.response.indexed) {
        return { kind: "unavailable", text: SEARCH_UNAVAILABLE_TEXT };
      }
      if (visibleCount === 0) {
        return { kind: "empty", text: "No matches" };
      }
      return state.response.truncated
        ? { kind: "truncated", text: "More matches than shown — keep typing to narrow them" }
        : null;
    }
  }
}
