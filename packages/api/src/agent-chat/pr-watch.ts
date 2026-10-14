/**
 * Pull request watches (spec `docs/superpowers/specs/2026-10-14-agent-visuals-and-session-tools-design.md`
 * §5 "PR watch") — the wire contract between the daemon, its session tools and the chat GUI.
 *
 * A chat thread's agent asks the daemon to watch a pull request (`watch_pull_request`); the daemon
 * reads it through the project's git-host account and, on news — checks failing or passing,
 * someone else's comment or review, a new conflict with the base branch, a merge or a close —
 * sends the thread one concise message, written by Orquester, through the ordinary `/turn` path.
 * The message starts with {@link PR_WATCH_MESSAGE_PREFIX}, which is what lets the timeline show it
 * as automated ({@link parsePullRequestWatchMessage}).
 *
 * Routes (both transports; the bearer hook gates HTTP): `GET`/`POST`
 * `agentChatRoutes.prWatches(sessionId)`, `DELETE agentChatRoutes.prWatch(sessionId, watchId)`.
 * Every change is also published on {@link PR_WATCHES_CHANNEL} with the thread's whole list.
 */

/** `/events` channel carrying {@link PullRequestWatchesChangedEvent}. */
export const PR_WATCHES_CHANNEL = "pr-watches";
/** The one event type on {@link PR_WATCHES_CHANNEL}. */
export const PR_WATCHES_CHANGED = "pr-watches.changed";

/** At most this many live watches per thread. */
export const MAX_PR_WATCHES_PER_THREAD = 10;

export type PullRequestWatchState = "open" | "merged" | "closed";
export type PullRequestMergeability = "clean" | "conflicting" | "unknown";

/** One watch as the GUI and the tools see it. Never carries a credential. */
export interface PullRequestWatchSummary {
  id: string;
  sessionId: string;
  /** "owner/repo" (Bitbucket Server: "PROJECT/repo"). */
  repository: string;
  number: number;
  /** The pull request's web page. */
  url: string;
  /** From the last read; "" before one succeeded. */
  title: string;
  startedAt: string;
  lastCheckedAt: string | null;
  /** The last read, digested; null before one succeeded. */
  status: {
    state: PullRequestWatchState;
    mergeability: PullRequestMergeability;
    headSha: string | null;
    baseBranch: string;
    checks: { total: number; passed: number; failed: number; pending: number };
  } | null;
  /** Why the last read failed (credential-free), or null. */
  lastError: string | null;
  /** A wake is waiting for the thread to be idle (or for the agent host to come back). */
  wakePending: boolean;
}

export interface PullRequestWatchListResponse {
  watches: PullRequestWatchSummary[];
}

/**
 * `GET agentChatRoutes.prWatches(id)` query: with `url` or `number`, only the watches of that pull
 * request (matched by repository and number; a number alone in the project's origin first).
 */
export interface PullRequestWatchListQuery {
  url?: string;
  number?: number;
}

/** `POST agentChatRoutes.prWatches(id)`: exactly one of `url` and `number`. */
export interface CreatePullRequestWatchRequest {
  /** The pull request's web URL (GitHub, Bitbucket Cloud, Bitbucket Server). */
  url?: string;
  /** A number alone is read from the thread project's `origin` repository. */
  number?: number;
}

export interface CreatePullRequestWatchResponse {
  watch: PullRequestWatchSummary;
  /** False when the thread already watched this pull request (the existing watch is answered). */
  created: boolean;
  /**
   * Set when the first read failed for a passing reason (a rate limit, a timeout): the watch
   * started without a baseline, and its first successful read reports the current checks.
   */
  note?: string;
}

/** `DELETE agentChatRoutes.prWatch(id, watchId)` (a watch the thread does not have is a 404). */
export interface DeletePullRequestWatchResponse {
  removed: true;
}

/**
 * Refusals of the pr-watch routes, as `{error: {code, message}}`. The message is written for the
 * agent that called `watch_pull_request` and names the fix.
 */
export type PullRequestWatchErrorCode =
  /** 404 — no chat thread with that id. */
  | "THREAD_NOT_FOUND"
  /** 400 — neither or both of `url` and `number`, an unrecognised URL, a bad number. */
  | "INVALID_ARGUMENT"
  /** 409 — a number alone, but the thread's project has no `origin` remote. */
  | "NO_REMOTE"
  /** 409 — the thread already watches {@link MAX_PR_WATCHES_PER_THREAD} pull requests. */
  | "WATCH_LIMIT"
  /** 409 — the pull request is merged or closed. */
  | "PULL_REQUEST_NOT_OPEN"
  /** 404 — the host has no such pull request (or the account cannot see it). */
  | "PULL_REQUEST_NOT_FOUND"
  /** 400 — the host refused the read (token, scope, an unsupported host). */
  | "PULL_REQUEST_UNREADABLE"
  /** 404 — `DELETE` of a watch the thread does not have. */
  | "WATCH_NOT_FOUND"
  /** 503 — the watch service is not running yet. */
  | "UNAVAILABLE";

export interface PullRequestWatchErrorEnvelope {
  error: { code: PullRequestWatchErrorCode; message: string };
}

/** Payload of {@link PR_WATCHES_CHANGED}: the thread's whole live list after the change. */
export interface PullRequestWatchesChangedEvent {
  sessionId: string;
  watches: PullRequestWatchSummary[];
}

/**
 * The first characters of every wake. The rest of that first line is the short summary the
 * timeline shows ("#12: checks failed, new comments"); the lines after it are what the agent reads.
 */
export const PR_WATCH_MESSAGE_PREFIX = "[Pull request watch] ";

export interface ParsedPullRequestWatchMessage {
  /** "#12: checks failed, new comments". */
  summary: string;
  /** Everything after the first line. */
  body: string;
}

/**
 * The wake's parts, or null for any other message. A user who types the prefix gets the same
 * styling — it is a presentation cue, not an authority claim.
 */
export function parsePullRequestWatchMessage(text: string): ParsedPullRequestWatchMessage | null {
  if (!text.startsWith(PR_WATCH_MESSAGE_PREFIX)) return null;
  const newline = text.indexOf("\n");
  const head = (newline < 0 ? text : text.slice(0, newline)).slice(PR_WATCH_MESSAGE_PREFIX.length).trim();
  if (head.length === 0) return null;
  return { summary: head, body: newline < 0 ? "" : text.slice(newline + 1).trim() };
}

/** Whether a `/events` payload is a well-formed {@link PullRequestWatchesChangedEvent}. */
export function isPullRequestWatchesChangedEvent(value: unknown): value is PullRequestWatchesChangedEvent {
  if (value === null || typeof value !== "object") return false;
  const event = value as { sessionId?: unknown; watches?: unknown };
  return typeof event.sessionId === "string" && Array.isArray(event.watches) && event.watches.every(isPullRequestWatchSummary);
}

/** Shape check for one summary (a client validates what it puts into state). */
export function isPullRequestWatchSummary(value: unknown): value is PullRequestWatchSummary {
  if (value === null || typeof value !== "object") return false;
  const watch = value as Record<string, unknown>;
  return (
    typeof watch.id === "string" &&
    typeof watch.sessionId === "string" &&
    typeof watch.repository === "string" &&
    typeof watch.number === "number" &&
    typeof watch.url === "string" &&
    typeof watch.title === "string" &&
    typeof watch.startedAt === "string" &&
    (watch.lastCheckedAt === null || typeof watch.lastCheckedAt === "string") &&
    (watch.lastError === null || typeof watch.lastError === "string") &&
    typeof watch.wakePending === "boolean" &&
    (watch.status === null || isWatchStatus(watch.status))
  );
}

const count = (value: unknown): boolean => typeof value === "number" && Number.isInteger(value) && value >= 0;

function isWatchStatus(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const status = value as Record<string, unknown>;
  const checks = status.checks as Record<string, unknown> | null | undefined;
  return (
    (status.state === "open" || status.state === "merged" || status.state === "closed") &&
    (status.mergeability === "clean" || status.mergeability === "conflicting" || status.mergeability === "unknown") &&
    (status.headSha === null || typeof status.headSha === "string") &&
    typeof status.baseBranch === "string" &&
    checks !== null &&
    typeof checks === "object" &&
    count(checks.total) &&
    count(checks.passed) &&
    count(checks.failed) &&
    count(checks.pending)
  );
}
