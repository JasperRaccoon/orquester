/**
 * The right rail's History — the host's prompt index, page by page.
 *
 * `GET …/prompts` lists every prompt a thread ever had, newest first, 100 to a
 * page, with a cursor to the next older page. This cache holds the pages a
 * panel has fetched, per session, for as long as the panel lives: switching
 * to another chat and back does not ask again (what is newer than a cached
 * first page is in the chat's own window, and what a rewind removed is
 * dropped against the fold's turns when the lists are merged).
 *
 * Until the index answers, and whenever it cannot, the panel lists what the
 * chat itself has loaded. Three different reasons, handled three ways:
 * - `indexed:false, catchingUp:true` — the host's index exists but is still
 *   reading this thread's log (a rebuild, the boot catch-up): the answer WILL
 *   change, so the panel asks again by itself, backing off
 *   ({@link catchUpDelayMs});
 * - a failure — a 404 from a host that predates the route, a 503 (the index
 *   could not answer, the host is down), a dropped connection — can be
 *   retried by the user;
 * - `indexed:false` alone — the host has no usable index at all, which only a
 *   host restart changes: not asked again, unless the thread's own snapshot
 *   later says its history IS indexed ({@link PromptIndexCache.recheckUnindexed}).
 *
 * Also the whole text of an entry the page cut (`truncated`), fetched once per
 * prompt when the user opens it.
 *
 * An external store (`subscribe` / `get`) for `useSyncExternalStore`; every
 * change replaces the session's state object, so a reader compares by identity.
 */

import {
  THREAD_PROMPTS_MAX_LIMIT,
  type ThreadPromptEntry,
  type ThreadPromptsQuery,
  type ThreadPromptsResponse,
  type ThreadPromptTextResponse
} from "@orquester/api/agent-chat";

import { ApiError } from "../api-client";

/** Prompts per page. */
export const PROMPT_PAGE_LIMIT = 100;

/**
 * A search reaches the whole thread, not just the pages the user scrolled to:
 * while one is typed, the older pages are fetched on their own, this many to
 * a page (the host's maximum), until the thread's first prompt — or until
 * {@link SEARCH_PROMPT_CAP} prompts are held, past which "Load older prompts"
 * stays the user's to press.
 */
export const SEARCH_PAGE_LIMIT = THREAD_PROMPTS_MAX_LIMIT;
export const SEARCH_PROMPT_CAP = 5_000;

/** Whether a search should fetch the next older page now (see {@link SEARCH_PAGE_LIMIT}). */
export function searchWantsOlder(
  state: PromptIndexState | undefined,
  cap: number = SEARCH_PROMPT_CAP
): boolean {
  return (
    state !== undefined &&
    state.status === "ready" &&
    state.before !== null &&
    !state.loadingOlder &&
    // A failed page waits for the user's Retry rather than looping.
    state.olderError === null &&
    state.prompts.length < cap
  );
}

/**
 * Whether the list should fetch the next older page by itself without a
 * search: a page can come back SHORT — even empty — and still carry a
 * `before` cursor, because the host walks at most a budget of rows per
 * request and a stretch of rows that are no prompts (a subagent fleet's task
 * notifications) can fill it. Until the list holds a page's worth of
 * prompts, the next page comes in on its own, so the first screen is never a
 * false "No prompts yet".
 */
export function fillWantsOlder(state: PromptIndexState | undefined): boolean {
  return searchWantsOlder(state, PROMPT_PAGE_LIMIT);
}

/** A search is still paging older prompts in by itself: one is on its way, or the next one will be. */
export function searchIsPaging(
  state: PromptIndexState | undefined,
  cap: number = SEARCH_PROMPT_CAP
): boolean {
  return state !== undefined && state.status === "ready" && (state.loadingOlder || searchWantsOlder(state, cap));
}

// ---------------------------------------------------------------------------
// Asking again while the host's index catches up
// ---------------------------------------------------------------------------

const CATCH_UP_FIRST_DELAY_MS = 3_000;
const CATCH_UP_MAX_DELAY_MS = 30_000;
/**
 * Past this many "still catching up" answers in a row (about 19 minutes of
 * asking) the panel stops asking by itself and offers Retry instead.
 */
const CATCH_UP_MAX_ATTEMPTS = 40;

/**
 * How long to wait before asking again after the `attempts`-th "still
 * catching up" answer in a row: 3 s, 6 s, 12 s, 24 s, then every 30 s — or
 * null once {@link CATCH_UP_MAX_ATTEMPTS} answers said so (or none did).
 */
export function catchUpDelayMs(attempts: number): number | null {
  if (attempts < 1 || attempts > CATCH_UP_MAX_ATTEMPTS) return null;
  return Math.min(CATCH_UP_MAX_DELAY_MS, CATCH_UP_FIRST_DELAY_MS * 2 ** (attempts - 1));
}

/** When the session asks again by itself; null when it does not (it is not catching up, or gave up). */
function catchUpReaskDelay(state: PromptIndexState | undefined): number | null {
  if (state === undefined || state.status !== "catchingUp" || state.refreshing) return null;
  return catchUpDelayMs(state.catchUpAttempts);
}

/**
 * Arm the next quiet re-ask of a catching-up session and hand back its
 * cancel — an effect's cleanup, so the asking stops when the panel goes — or
 * null when none is due.
 */
export function scheduleCatchUpReask(
  cache: Pick<PromptIndexCache, "retry">,
  sessionId: string,
  state: PromptIndexState | undefined
): (() => void) | null {
  const delay = catchUpReaskDelay(state);
  if (delay === null) return null;
  const handle = setTimeout(() => cache.retry(sessionId), delay);
  return () => clearTimeout(handle);
}

// ---------------------------------------------------------------------------
// The cache
// ---------------------------------------------------------------------------

export type PromptIndexStatus =
  /** The first page is on its way. */
  | "loading"
  /** At least the first page landed. */
  | "ready"
  /** The host's index is still catching up with this thread: asked again by itself. */
  | "catchingUp"
  /** The host has no usable index (`indexed:false` alone): the panel lists what the chat holds. */
  | "unindexed"
  /** The first page failed (a 404 from an older host, a 503, the network): retryable. */
  | "failed";

export interface PromptIndexState {
  status: PromptIndexStatus;
  /** Every page fetched so far, newest first, once per message. */
  prompts: readonly ThreadPromptEntry[];
  /** Cursor of the next OLDER page; null once the thread's first prompt was reached. */
  before: string | null;
  /** A "Load older prompts" request is in flight. */
  loadingOlder: boolean;
  /** Why the last "Load older prompts" failed; cleared by the next attempt. */
  olderError: string | null;
  /** Why the first page failed, when `status` is `failed`. */
  error: string | null;
  /** "Still catching up" answers in a row (`catchingUp`); 0 otherwise. */
  catchUpAttempts: number;
  /** The first page is being asked again while this state still shows. */
  refreshing: boolean;
}

export type PromptTextState =
  | { status: "loading" }
  | {
      status: "ready";
      text: string;
      /** Even the host's copy is cut (the index keeps 128 K characters of a message). */
      truncated: boolean;
    }
  | { status: "failed"; error: string };

export interface PromptIndexFetchers {
  page(sessionId: string, query: ThreadPromptsQuery): Promise<ThreadPromptsResponse>;
  text(sessionId: string, messageId: string): Promise<ThreadPromptTextResponse>;
}

const LOADING: PromptIndexState = {
  status: "loading",
  prompts: [],
  before: null,
  loadingOlder: false,
  olderError: null,
  error: null,
  catchUpAttempts: 0,
  refreshing: false
};

/** The daemon's (or the host's) error code — `body.code` — when the body carried one. */
function errorCodeOf(error: ApiError): string | null {
  const body = error.body;
  if (typeof body !== "object" || body === null) return null;
  const code = (body as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/** What a failed `GET …/prompts` says: the fallback note's detail, a failed older page. */
function promptListErrorMessage(
  error: unknown,
  fallback: string = "Couldn't load this chat's prompts."
): string {
  if (error instanceof ApiError) {
    const code = errorCodeOf(error);
    if (code === "INDEX_UNAVAILABLE") return "The prompt index couldn't answer just now.";
    if (code === "HOST_UNAVAILABLE") return "The agent host isn't available right now.";
    // A host that predates the route answers its generic route-miss
    // `THREAD_NOT_FOUND`: the chat itself is open, so it is the route.
    if (error.status === 404) return "This agent host can't list a chat's prompts yet.";
    if (error.status === 503) return "The prompt index is unavailable right now.";
    if (error.status === 0) return "Couldn't reach the daemon.";
    return error.serverMessage ?? fallback;
  }
  return fallback;
}

/** What a failed `GET …/prompts/:messageId` says on the open card. */
function promptTextErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const code = errorCodeOf(error);
    if (code === "PROMPT_NOT_FOUND") return "That prompt is no longer in this chat.";
    if (code === "INDEX_UNAVAILABLE") {
      return "The host can't read the whole prompt yet — try again in a moment.";
    }
    if (code === "HOST_UNAVAILABLE") return "The agent host isn't available right now.";
    if (code === "THREAD_NOT_FOUND") return "This chat is no longer available.";
    if (error.status === 503) return "The whole prompt can't be read right now — try again in a moment.";
    if (error.status === 0) return "Couldn't reach the daemon.";
    return error.serverMessage ?? "Couldn't read the whole prompt.";
  }
  return "Couldn't read the whole prompt.";
}

/** New entries appended after what is held, once per message id. */
function appendPrompts(
  held: readonly ThreadPromptEntry[],
  page: readonly ThreadPromptEntry[]
): readonly ThreadPromptEntry[] {
  if (page.length === 0) return held;
  const seen = new Set(held.map((entry) => entry.messageId));
  const added = page.filter((entry) => {
    if (seen.has(entry.messageId)) return false;
    seen.add(entry.messageId);
    return true;
  });
  return added.length === 0 ? held : [...held, ...added];
}

export class PromptIndexCache {
  private readonly states = new Map<string, PromptIndexState>();
  private readonly texts = new Map<string, PromptTextState>();
  /** Per session: bumped by every first-page (re)load, so a stale answer lands nowhere. */
  private readonly generations = new Map<string, number>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly fetchers: PromptIndexFetchers) {}

  /** `useSyncExternalStore`'s subscribe: stable, returns the unsubscribe. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** The session's pages; undefined until {@link ensure} first asks. */
  get(sessionId: string): PromptIndexState | undefined {
    return this.states.get(sessionId);
  }

  /** One prompt's whole text; undefined until {@link ensureText} first asks. */
  text(sessionId: string, messageId: string): PromptTextState | undefined {
    return this.texts.get(textKey(sessionId, messageId));
  }

  /** Ask for the first page unless this session already has (or is getting) one. */
  ensure(sessionId: string): void {
    if (this.states.has(sessionId)) return;
    this.loadFirst(sessionId);
  }

  /**
   * Ask again what can change: the first page after a failure; the first page
   * of an index still catching up — quietly, its note staying up meanwhile
   * (the re-ask timer's door, and the user's once it gave up); or the last
   * "Load older prompts". A host with no index at all is not asked again —
   * see {@link recheckUnindexed}.
   */
  retry(sessionId: string): void {
    const state = this.states.get(sessionId);
    if (state === undefined || state.status === "failed") {
      this.loadFirst(sessionId);
      return;
    }
    if (state.status === "catchingUp") {
      if (state.refreshing) return;
      // The user's Retry once the asking gave up starts the backoff over.
      const gaveUp = catchUpDelayMs(state.catchUpAttempts) === null;
      this.loadFirst(sessionId, gaveUp ? { ...state, catchUpAttempts: 0 } : state);
      return;
    }
    if (state.status === "ready" && state.olderError !== null) {
      this.loadOlder(sessionId);
    }
  }

  /**
   * Ask a session the host said it has no index for once more — when the
   * thread's own snapshot has since said its history IS indexed (a host that
   * restarted with a working index). Anything else is left as it is.
   */
  recheckUnindexed(sessionId: string): void {
    if (this.states.get(sessionId)?.status === "unindexed") this.loadFirst(sessionId);
  }

  /**
   * The next older page, when there is one and none is on its way — `limit`
   * prompts of it (a search asks for {@link SEARCH_PAGE_LIMIT}).
   */
  loadOlder(sessionId: string, limit: number = PROMPT_PAGE_LIMIT): void {
    const state = this.states.get(sessionId);
    if (state === undefined || state.status !== "ready" || state.before === null || state.loadingOlder) {
      return;
    }
    const generation = this.generations.get(sessionId) ?? 0;
    const before = state.before;
    this.set(sessionId, { ...state, loadingOlder: true, olderError: null });
    this.fetchers
      .page(sessionId, { before, limit })
      .then((response) => {
        const current = this.states.get(sessionId);
        if (current === undefined || this.generations.get(sessionId) !== generation) return;
        this.set(sessionId, {
          ...current,
          prompts: appendPrompts(current.prompts, response.prompts),
          before: response.before,
          loadingOlder: false,
          olderError: null
        });
      })
      .catch((error: unknown) => {
        const current = this.states.get(sessionId);
        if (current === undefined || this.generations.get(sessionId) !== generation) return;
        this.set(sessionId, {
          ...current,
          loadingOlder: false,
          olderError: promptListErrorMessage(error, "Couldn't load older prompts.")
        });
      });
  }

  /** Fetch one prompt's whole text, once (again after a failure). */
  ensureText(sessionId: string, messageId: string): void {
    const key = textKey(sessionId, messageId);
    const held = this.texts.get(key);
    if (held !== undefined && held.status !== "failed") return;
    this.setText(key, { status: "loading" });
    this.fetchers
      .text(sessionId, messageId)
      .then((response) => {
        this.setText(key, { status: "ready", text: response.text, truncated: response.truncated });
      })
      .catch((error: unknown) => {
        this.setText(key, { status: "failed", error: promptTextErrorMessage(error) });
      });
  }

  /**
   * (Re)ask for the first page. A quiet re-ask — `showing` is the
   * catching-up state on screen — keeps that state up, marked `refreshing`,
   * until the answer replaces it; any other load starts from `loading`.
   */
  private loadFirst(sessionId: string, showing?: PromptIndexState): void {
    const generation = (this.generations.get(sessionId) ?? 0) + 1;
    this.generations.set(sessionId, generation);
    const previousAttempts = showing?.status === "catchingUp" ? showing.catchUpAttempts : 0;
    this.set(sessionId, showing !== undefined ? { ...showing, refreshing: true } : LOADING);
    this.fetchers
      .page(sessionId, { limit: PROMPT_PAGE_LIMIT })
      .then((response) => {
        if (this.generations.get(sessionId) !== generation) return;
        if (response.indexed) {
          this.set(sessionId, {
            ...LOADING,
            status: "ready",
            prompts: appendPrompts([], response.prompts),
            before: response.before
          });
        } else if (response.catchingUp === true) {
          this.set(sessionId, {
            ...LOADING,
            status: "catchingUp",
            catchUpAttempts: previousAttempts + 1
          });
        } else {
          this.set(sessionId, { ...LOADING, status: "unindexed" });
        }
      })
      .catch((error: unknown) => {
        if (this.generations.get(sessionId) !== generation) return;
        this.set(sessionId, { ...LOADING, status: "failed", error: promptListErrorMessage(error) });
      });
  }

  private set(sessionId: string, state: PromptIndexState): void {
    this.states.set(sessionId, state);
    this.notify();
  }

  private setText(key: string, state: PromptTextState): void {
    this.texts.set(key, state);
    this.notify();
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

function textKey(sessionId: string, messageId: string): string {
  return `${sessionId}\u0000${messageId}`;
}
