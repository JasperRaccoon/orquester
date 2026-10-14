/**
 * Pull request watches — this client's copy of each chat thread's watches
 * (`agentChatRoutes.prWatches`, spec 2026-10-14 §5 "PR watch").
 *
 * One module-level store, like the saved prompts': the daemon owns the list,
 * and this copy converges on it three ways — a load answers one thread's list,
 * a stop removes the watch at once, and every change arrives on `/events`
 * (`PR_WATCHES_CHANNEL`, the thread's WHOLE list), routed here by the app
 * store's `applyEvent`. An event is newer than a load that crossed it, so a
 * load's answer never replaces a list an event set while it was in flight.
 * Every payload is shape-checked before it reaches state.
 *
 * Per connection: `resetPullRequestWatches()` runs on a connection switch (the
 * app store), and a load through a client of another connection resets first.
 * No React import.
 */

import { createStore } from "zustand/vanilla";

import {
  isPullRequestWatchesChangedEvent,
  isPullRequestWatchSummary,
  PR_WATCHES_CHANGED,
  type PullRequestWatchListResponse,
  type PullRequestWatchSummary
} from "@orquester/api/agent-chat";

/** The routes this store calls — `ApiClient` satisfies it; tests pass a fake. */
export interface PullRequestWatchesApi {
  readonly connection?: { readonly id: string };
  listPullRequestWatches(sessionId: string, signal?: AbortSignal): Promise<PullRequestWatchListResponse>;
  stopPullRequestWatch(sessionId: string, watchId: string): Promise<unknown>;
}

export interface PullRequestWatchesState {
  /** Each loaded (or event-fed) thread's live watches, oldest first. */
  bySession: ReadonlyMap<string, readonly PullRequestWatchSummary[]>;
  /** Watches whose stop is in flight. */
  stopping: ReadonlySet<string>;
  /** The last failed stop per thread, until the next stop or load. */
  errors: ReadonlyMap<string, string>;
}

const INITIAL: PullRequestWatchesState = { bySession: new Map(), stopping: new Set(), errors: new Map() };

export const pullRequestWatchesStore = createStore<PullRequestWatchesState>(() => INITIAL);

/** Bumped by a reset: an answer from before it is dropped. */
let generation = 0;
let boundConnectionId: string | null = null;
/** Per thread, bumped by every event: a load that crossed one keeps the event's list. */
const eventSeq = new Map<string, number>();
const inFlight = new Map<string, Promise<void>>();

const NO_WATCHES: readonly PullRequestWatchSummary[] = [];

export function pullRequestWatchesOf(state: PullRequestWatchesState, sessionId: string): readonly PullRequestWatchSummary[] {
  return state.bySession.get(sessionId) ?? NO_WATCHES;
}

function setList(sessionId: string, watches: readonly PullRequestWatchSummary[]): void {
  pullRequestWatchesStore.setState((state) => {
    const bySession = new Map(state.bySession);
    bySession.set(sessionId, watches);
    return { ...state, bySession };
  });
}

function setError(sessionId: string, error: string | null): void {
  pullRequestWatchesStore.setState((state) => {
    if ((state.errors.get(sessionId) ?? null) === error) return state;
    const errors = new Map(state.errors);
    if (error === null) errors.delete(sessionId);
    else errors.set(sessionId, error);
    return { ...state, errors };
  });
}

function bind(api: PullRequestWatchesApi): void {
  const id = api.connection?.id ?? null;
  if (boundConnectionId !== null && id !== null && boundConnectionId !== id) resetPullRequestWatches();
  if (id !== null) boundConnectionId = id;
}

/** Load one thread's watches (one request at a time per thread). */
export function loadPullRequestWatches(api: PullRequestWatchesApi, sessionId: string): Promise<void> {
  bind(api);
  const running = inFlight.get(sessionId);
  if (running) return running;
  const started = generation;
  const seq = eventSeq.get(sessionId) ?? 0;
  const work = api
    .listPullRequestWatches(sessionId)
    .then((answer) => {
      if (started !== generation || (eventSeq.get(sessionId) ?? 0) !== seq) return;
      const watches = Array.isArray(answer?.watches) ? answer.watches.filter(isPullRequestWatchSummary) : [];
      setList(sessionId, watches);
    })
    .catch(() => {
      // A thread without watches support (an older daemon) or a passing failure shows nothing;
      // the next event or load corrects it.
    })
    .finally(() => {
      if (inFlight.get(sessionId) === work) inFlight.delete(sessionId);
    });
  inFlight.set(sessionId, work);
  return work;
}

/** Apply one `/events` message of `PR_WATCHES_CHANNEL`; a malformed payload is ignored. */
export function applyPullRequestWatchesEvent(event: { type: string; payload: unknown }): void {
  if (event.type !== PR_WATCHES_CHANGED || !isPullRequestWatchesChangedEvent(event.payload)) return;
  const { sessionId, watches } = event.payload;
  eventSeq.set(sessionId, (eventSeq.get(sessionId) ?? 0) + 1);
  setList(sessionId, watches);
}

/** Stop a watch. It leaves the list at once on success (the event confirms it). */
export async function stopPullRequestWatch(api: PullRequestWatchesApi, sessionId: string, watchId: string): Promise<boolean> {
  bind(api);
  if (pullRequestWatchesStore.getState().stopping.has(watchId)) return false;
  pullRequestWatchesStore.setState((state) => ({ ...state, stopping: new Set(state.stopping).add(watchId) }));
  setError(sessionId, null);
  const started = generation;
  let ok = false;
  try {
    await api.stopPullRequestWatch(sessionId, watchId);
    ok = true;
  } catch (error) {
    // Already gone (merged, stopped elsewhere): what the user asked for.
    const status = (error as { status?: unknown } | null)?.status;
    if (status === 404) ok = true;
    else if (started === generation) setError(sessionId, "Couldn't stop watching the pull request. Try again.");
  }
  if (started !== generation) return ok;
  pullRequestWatchesStore.setState((state) => {
    const stopping = new Set(state.stopping);
    stopping.delete(watchId);
    if (!ok) return { ...state, stopping };
    const bySession = new Map(state.bySession);
    bySession.set(sessionId, pullRequestWatchesOf(state, sessionId).filter((watch) => watch.id !== watchId));
    return { ...state, stopping, bySession };
  });
  return ok;
}

/** Forget everything (a connection switch). */
export function resetPullRequestWatches(): void {
  generation += 1;
  boundConnectionId = null;
  eventSeq.clear();
  inFlight.clear();
  pullRequestWatchesStore.setState(INITIAL);
}
