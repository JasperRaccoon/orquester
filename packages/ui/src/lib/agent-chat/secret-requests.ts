/**
 * Agent chat — the pending `request_secret` cards this client knows, per
 * chat session (design 2026-10-14 §5 "Secrets").
 *
 * The daemon holds the requests (memory only); this copy converges on it two
 * ways: a **load** (`GET …/secret-requests`) when a chat view mounts or the
 * connection comes back, and the `agentChat.secretRequest` bus event every
 * open and close publishes, routed here by the app store's `applyEvent`. A
 * closed request id is never brought back by a load that crossed its close.
 *
 * Only requests live here — name, prompt, purpose. The value the user types
 * stays in the card's own state and the answer's request body, never here.
 * No React import (the hook is `use-secret-requests.ts`).
 */

import { createStore } from "zustand/vanilla";

import {
  parseSecretRequestSummary,
  SECRET_REQUEST_EVENT_TYPE,
  type SecretRequestListResponse,
  type SecretRequestSummary
} from "@orquester/api/agent-chat";

export interface SecretRequestsState {
  /** Pending requests by session id, oldest first. */
  bySession: Readonly<Record<string, readonly SecretRequestSummary[]>>;
}

export const secretRequestsStore = createStore<SecretRequestsState>(() => ({ bySession: {} }));

/** Closed request ids: a load that started before the close never revives one. */
const closed = new Set<string>();
/** Bumped by a reset: a load answered for the previous connection is dropped. */
let generation = 0;

const EMPTY: readonly SecretRequestSummary[] = [];

export function secretRequestsFor(state: SecretRequestsState, sessionId: string): readonly SecretRequestSummary[] {
  return state.bySession[sessionId] ?? EMPTY;
}

function sorted(requests: SecretRequestSummary[]): SecretRequestSummary[] {
  return requests.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function setSession(sessionId: string, requests: SecretRequestSummary[]): void {
  secretRequestsStore.setState((state) => {
    const bySession = { ...state.bySession };
    if (requests.length === 0) {
      delete bySession[sessionId];
    } else {
      bySession[sessionId] = sorted(requests);
    }
    return { bySession };
  });
}

function upsert(request: SecretRequestSummary): void {
  if (closed.has(request.requestId)) return;
  const current = secretRequestsFor(secretRequestsStore.getState(), request.sessionId);
  setSession(request.sessionId, [...current.filter((entry) => entry.requestId !== request.requestId), request]);
}

/** Enough to outlive any load in flight; the oldest id goes first past it. */
const CLOSED_IDS_KEPT = 1024;

function remove(sessionId: string, requestId: string): void {
  closed.add(requestId);
  if (closed.size > CLOSED_IDS_KEPT) {
    const oldest = closed.values().next().value;
    if (oldest !== undefined) closed.delete(oldest);
  }
  const current = secretRequestsFor(secretRequestsStore.getState(), sessionId);
  if (current.some((entry) => entry.requestId === requestId)) {
    setSession(
      sessionId,
      current.filter((entry) => entry.requestId !== requestId)
    );
  }
}

/** Apply one `/events` message; anything that is not a well-formed secret-request event is ignored. */
export function applySecretRequestEvent(event: { type: string; payload: unknown }): void {
  if (event.type !== SECRET_REQUEST_EVENT_TYPE) return;
  const payload = event.payload as { request?: unknown; open?: unknown } | null;
  if (payload === null || typeof payload !== "object" || typeof payload.open !== "boolean") return;
  const request = parseSecretRequestSummary(payload.request);
  if (request === null) return;
  if (payload.open) {
    upsert(request);
  } else {
    remove(request.sessionId, request.requestId);
  }
}

/** The answer was taken (or the request had already ended): drop the card now rather than on the bus event. */
export function markSecretRequestClosed(sessionId: string, requestId: string): void {
  remove(sessionId, requestId);
}

/** The route the load calls — `ApiClient` satisfies it; tests pass a fake. */
export interface SecretRequestsApi {
  listSecretRequests(sessionId: string, signal?: AbortSignal): Promise<SecretRequestListResponse>;
}

/**
 * Replace one session's requests with the daemon's list. A request an event
 * opened while the load was in flight is kept; one closed meanwhile stays
 * closed. A failure leaves the copy as it was (the events still apply).
 */
export async function loadSecretRequests(
  api: SecretRequestsApi,
  sessionId: string,
  signal?: AbortSignal
): Promise<void> {
  const startedIn = generation;
  const before = new Set(secretRequestsFor(secretRequestsStore.getState(), sessionId).map((entry) => entry.requestId));
  let response: SecretRequestListResponse;
  try {
    response = await api.listSecretRequests(sessionId, signal);
  } catch {
    return;
  }
  if (startedIn !== generation || signal?.aborted) return;
  const listed = (Array.isArray(response?.requests) ? response.requests : [])
    .map(parseSecretRequestSummary)
    .filter((entry): entry is SecretRequestSummary => entry !== null && entry.sessionId === sessionId)
    .filter((entry) => !closed.has(entry.requestId));
  const listedIds = new Set(listed.map((entry) => entry.requestId));
  // Opened by an event during the load: the list may predate it.
  const openedMeanwhile = secretRequestsFor(secretRequestsStore.getState(), sessionId).filter(
    (entry) => !before.has(entry.requestId) && !listedIds.has(entry.requestId)
  );
  setSession(sessionId, [...listed, ...openedMeanwhile]);
}

/** A connection switch or sign-out: everything here belonged to the old daemon. */
export function resetSecretRequests(): void {
  generation += 1;
  closed.clear();
  secretRequestsStore.setState({ bySession: {} });
}
