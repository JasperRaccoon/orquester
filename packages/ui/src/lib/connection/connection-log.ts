import type { ConnectionFailure } from "./failure";

/**
 * What the client has learned about its connection to the active daemon: the
 * last failure and a short history of them, what the daemon said about itself,
 * whether it announced a restart, and how the terminal WebSocket fares. The
 * connection diagnosis reads it; nothing here decides on a retry.
 *
 * A small external store (`useSyncExternalStore`) rather than app-store state,
 * so the WebSocket channels can write to it without importing the store.
 */

/** How many failures the diagnostics report keeps. */
export const CONNECTION_LOG_LIMIT = 20;

export interface LoggedFailure extends ConnectionFailure {
  /** How many times in a row it happened (the latest at `at`). */
  count: number;
}

export interface WsHealth {
  /** Closes since the socket last opened, counted only while HTTP is connected. */
  failures: number;
  lastOpenAt: number | null;
  lastCloseCode: number | null;
  lastFailureAt: number | null;
}

export interface ConnectionLogState {
  /** The failure that explains the current trouble; cleared by a connect. */
  lastFailure: ConnectionFailure | null;
  /** Oldest first, at most {@link CONNECTION_LOG_LIMIT}; kept across connects for the report. */
  recent: LoggedFailure[];
  /** The daemon's protocol from `/health`, when it reports one. */
  serverProtocol: number | null;
  /** The daemon checkout's commit from `/api/info`, when it reports one. */
  serverBuild: string | null;
  /** When the daemon last announced it is stopping (restart, deploy, Remote access change). */
  stoppingAt: number | null;
  /** Epoch ms of the last established connection. */
  connectedAt: number | null;
  /** Per WebSocket URL (one terminal channel per daemon origin). */
  ws: Record<string, WsHealth>;
}

const EMPTY: ConnectionLogState = {
  lastFailure: null,
  recent: [],
  serverProtocol: null,
  serverBuild: null,
  stoppingAt: null,
  connectedAt: null,
  ws: {}
};

let state: ConnectionLogState = EMPTY;
const listeners = new Set<() => void>();

function update(next: ConnectionLogState): void {
  state = next;
  for (const listener of [...listeners]) listener();
}

export function subscribeConnectionLog(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getConnectionLog(): ConnectionLogState {
  return state;
}

/** Record a failed attempt. A repeat of the last one bumps its count instead of a new row. */
export function recordConnectionFailure(failure: ConnectionFailure): void {
  const recent = [...state.recent];
  const last = recent[recent.length - 1];
  if (last && last.kind === failure.kind && last.status === failure.status && last.detail === failure.detail) {
    recent[recent.length - 1] = { ...failure, count: last.count + 1 };
  } else {
    recent.push({ ...failure, count: 1 });
    if (recent.length > CONNECTION_LOG_LIMIT) recent.splice(0, recent.length - CONNECTION_LOG_LIMIT);
  }
  update({ ...state, lastFailure: failure, recent });
}

/** The daemon answered `/health`. */
export function noteServerHealth(health: { protocol?: number }): void {
  const serverProtocol = health.protocol ?? null;
  if (serverProtocol !== state.serverProtocol) update({ ...state, serverProtocol });
}

/** The daemon answered `/api/info`. */
export function noteServerInfo(info: { protocol?: number; build?: string | null }): void {
  update({
    ...state,
    serverProtocol: info.protocol ?? state.serverProtocol,
    serverBuild: typeof info.build === "string" ? info.build : null
  });
}

/**
 * The connection is established. Clears the explanation (the history stays for
 * the report) and starts counting WebSocket failures afresh: closes during the
 * outage say nothing about whether WebSockets get through.
 */
export function noteConnected(at = Date.now()): void {
  const ws: Record<string, WsHealth> = {};
  for (const [url, health] of Object.entries(state.ws)) ws[url] = { ...health, failures: 0 };
  update({ ...state, lastFailure: null, connectedAt: at, ws });
}

/** The daemon published `daemon.stopping`. */
export function noteDaemonStopping(at = Date.now()): void {
  update({ ...state, stoppingAt: at });
}

const wsHealth = (url: string): WsHealth =>
  state.ws[url] ?? { failures: 0, lastOpenAt: null, lastCloseCode: null, lastFailureAt: null };

export function noteWsOpened(url: string, at = Date.now()): void {
  update({ ...state, ws: { ...state.ws, [url]: { ...wsHealth(url), failures: 0, lastOpenAt: at } } });
}

export function noteWsClosed(url: string, code: number | null, at = Date.now()): void {
  const health = wsHealth(url);
  update({
    ...state,
    ws: { ...state.ws, [url]: { ...health, failures: health.failures + 1, lastCloseCode: code, lastFailureAt: at } }
  });
}

/** Forget everything: another daemon is now the active connection. */
export function resetConnectionLog(): void {
  update(EMPTY);
}
