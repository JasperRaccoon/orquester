import type { GitStatusChangedPayload } from "@orquester/api";
import { ApiError, type ApiClient } from "../../lib/api-client";

/**
 * One shared `/events?project=<path>` subscription per project, refcounted
 * across every mounted Git view.
 *
 * Why shared: in grid view EVERY visible cell mounts a live `GitView`, and a
 * stream per cell burns one of the browser's ~6 HTTP/1.1 connections per origin
 * (plain HTTP — dev and a self-hosted daemon without h2), which is exactly the
 * budget the terminals need. All cells of a grid belong to one project, so one
 * stream serves them all.
 *
 * Why here rather than in the component: the reconnect policy (backoff, give-up)
 * has to survive an individual view unmounting, and the daemon-side refcount
 * wants the subscription's lifetime to be "somebody is looking at this project",
 * not "this React node exists".
 */

/** First reconnect delay, doubled per consecutive failure up to the cap. */
const RETRY_BASE_MS = 3000;
const RETRY_MAX_MS = 30_000;
/**
 * Consecutive failed opens (a stream that ended without ever delivering an
 * event) before giving up. A live stream sends a heartbeat every 15s, so any
 * open that produced data resets this.
 */
const MAX_ATTEMPTS = 6;

export interface GitWatchState {
  /** True once the daemon has actually pushed a change for this project. */
  pushed: boolean;
  /** Quiet inline notice when live updates are off for good; null while healthy. */
  notice: string | null;
}

interface Handlers {
  onChange: (payload: GitStatusChangedPayload) => void;
  onState: (state: GitWatchState) => void;
}

interface Entry {
  handlers: Set<Handlers>;
  /**
   * The connection currently owned by this entry. Held in an object created
   * BEFORE `openEvents` so a synchronous `onEnd` (a transport that fails
   * immediately) can mark it closed and the assignment below can't resurrect a
   * dead handle.
   */
  conn: { closed: boolean; close: (() => void) | null } | null;
  retry: ReturnType<typeof setTimeout> | null;
  attempts: number;
  state: GitWatchState;
  disposed: boolean;
}

const byApi = new WeakMap<ApiClient, Map<string, Entry>>();

const NO_LIVE_UPDATES = "Live updates are off — refreshing periodically.";

/**
 * Subscribe to a project's server-pushed git status. Returns an unsubscribe
 * function; the underlying stream is opened on the first subscriber and closed
 * after the last one leaves.
 */
export function subscribeProjectGit(
  api: ApiClient,
  projectPath: string,
  handlers: Handlers
): () => void {
  let byPath = byApi.get(api);
  if (!byPath) {
    byPath = new Map();
    byApi.set(api, byPath);
  }

  let entry = byPath.get(projectPath);
  if (!entry) {
    entry = {
      handlers: new Set(),
      conn: null,
      retry: null,
      attempts: 0,
      state: { pushed: false, notice: null },
      disposed: false
    };
    byPath.set(projectPath, entry);
    open(api, projectPath, entry);
  }
  const current = entry;
  current.handlers.add(handlers);
  handlers.onState(current.state);

  return () => {
    current.handlers.delete(handlers);
    if (current.handlers.size > 0) return;
    current.disposed = true;
    if (current.retry) clearTimeout(current.retry);
    current.conn?.close?.();
    current.conn = null;
    byApi.get(api)?.delete(projectPath);
  };
}

function setState(entry: Entry, patch: Partial<GitWatchState>): void {
  entry.state = { ...entry.state, ...patch };
  for (const handler of entry.handlers) handler.onState(entry.state);
}

function open(api: ApiClient, projectPath: string, entry: Entry): void {
  if (entry.disposed) return;
  entry.retry = null;

  const conn: { closed: boolean; close: (() => void) | null } = { closed: false, close: null };
  entry.conn = conn;
  let received = false;

  const dispose = api.openEvents(
    (event) => {
      received = true;
      entry.attempts = 0;
      if (event.type !== "project.git.changed") return;
      const payload = event.payload as GitStatusChangedPayload | undefined;
      if (!payload?.status) return;
      setState(entry, { pushed: true, notice: null });
      for (const handler of entry.handlers) handler.onChange(payload);
    },
    () => {
      conn.closed = true;
      if (entry.conn === conn) entry.conn = null;
      if (entry.disposed) return;
      setState(entry, { pushed: false });
      if (received) {
        // The stream carried traffic and then dropped (daemon restart,
        // sleep/wake): treat it as a healthy reconnect, not a failure.
        entry.attempts = 0;
        schedule(api, projectPath, entry, RETRY_BASE_MS);
        return;
      }
      entry.attempts += 1;
      void giveUpOn4xx(api, projectPath, entry).then((gaveUp) => {
        if (gaveUp || entry.disposed) return;
        if (entry.attempts >= MAX_ATTEMPTS) {
          setState(entry, { notice: NO_LIVE_UPDATES });
          return;
        }
        schedule(
          api,
          projectPath,
          entry,
          Math.min(RETRY_BASE_MS * 2 ** (entry.attempts - 1), RETRY_MAX_MS)
        );
      });
    },
    { project: projectPath }
  );

  // A transport can fail (and call onEnd) synchronously inside openEvents, in
  // which case the handle above is already dead — closing it is the only safe
  // thing to do with it, and it must NOT overwrite the null set by that onEnd.
  if (conn.closed) {
    dispose();
  } else {
    conn.close = dispose;
  }
}

function schedule(api: ApiClient, projectPath: string, entry: Entry, delay: number): void {
  if (entry.disposed || entry.retry) return;
  entry.retry = setTimeout(() => open(api, projectPath, entry), delay);
}

/**
 * A stream that dies without a single byte is usually a transient network drop —
 * but it is also what a 4xx looks like from `openStream`, which reports no
 * status (the error body is not NDJSON, so it never reaches a handler). The
 * `?project=` subscription is refused by exactly one check, `assertInsideFsRoot`,
 * and `/api/git/status` runs the same one — so a cheap status probe tells the
 * two apart. A 4xx is permanent: stop retrying and leave a quiet notice.
 */
async function giveUpOn4xx(api: ApiClient, projectPath: string, entry: Entry): Promise<boolean> {
  try {
    await api.gitStatus(projectPath);
    return false;
  } catch (error) {
    if (!(error instanceof ApiError) || error.status < 400 || error.status >= 500) return false;
    if (entry.disposed) return true;
    setState(entry, { notice: error.serverMessage ?? NO_LIVE_UPDATES });
    return true;
  }
}
