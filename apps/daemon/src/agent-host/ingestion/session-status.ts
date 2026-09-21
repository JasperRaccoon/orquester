// Ported from T3 Code (MIT): apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:376-398, 1790-1846
/**
 * Runtime session/turn lifecycle → `thread.session-set` (spec §5.1).
 *
 * `session.*`, `thread.started`, the turn lifecycle and `runtime.error` all
 * fold onto one `ThreadSessionState`. The turn itself is settled **by the fold
 * from session status**, not by `turn.completed`: leaving `running` for
 * `idle`/`ready` settles it `completed`, for `stopped` `interrupted`, for
 * `error` `failed`. That is what keeps a late checkpoint or diff from
 * extending the recorded duration.
 *
 * *differs from T3: there is no `interrupted` session status here — §5.1 folds
 * it into `stopped`. T3's `waiting → running` collapse IS kept, even though
 * `RuntimeSessionState` has no `waiting` arm: Codex puts the state on the wire
 * anyway (see {@link threadStatusFromRuntimeState}).*
 */

import type {
  RuntimeEvent,
  RuntimeSessionState,
  ThreadSessionState,
  ThreadSessionStatus
} from "@orquester/api/agent-chat";

/** Runtime events that move the session state machine. */
export type SessionLifecycleEvent = Extract<
  RuntimeEvent,
  {
    type:
      | "session.started"
      | "session.state.changed"
      | "session.exited"
      | "thread.started"
      | "turn.started"
      | "turn.completed"
      | "turn.aborted"
      | "runtime.error";
  }
>;

const SESSION_LIFECYCLE_TYPES: ReadonlySet<RuntimeEvent["type"]> = new Set([
  "session.started",
  "session.state.changed",
  "session.exited",
  "thread.started",
  "turn.started",
  "turn.completed",
  "turn.aborted",
  "runtime.error"
]);

export function isSessionLifecycleEvent(event: RuntimeEvent): event is SessionLifecycleEvent {
  return SESSION_LIFECYCLE_TYPES.has(event.type);
}

/**
 * `RuntimeSessionState` has no `waiting` arm — §4.2 says `waiting` is derived
 * from an unresolved request and is never emitted. Codex nevertheless puts it
 * on the wire as a `thread/status/changed` active flag
 * (`apps/daemon/test/fixtures/codex/README.md`, observation 4), so the string
 * is accepted here and mapped to `running`, per §5.1 ("a runtime `waiting`
 * state maps to session status `running` — `waiting` is a derived UI state
 * from an unresolved request, never a stored status"). Keeping the mapping in
 * one place means no adapter has to remember it.
 */
export function threadStatusFromRuntimeState(
  state: RuntimeSessionState | "waiting"
): ThreadSessionStatus {
  switch (state) {
    case "starting":
      return "starting";
    case "running":
    case "waiting":
      return "running";
    case "ready":
      return "ready";
    case "stopped":
      return "stopped";
    case "error":
      return "error";
    default: {
      const exhaustive: never = state;
      void exhaustive;
      // An unrecognised state from a future adapter means "alive, doing
      // something". A real stop always arrives as `session.exited`, which maps
      // to `stopped` without going through here, so guessing `running` cannot
      // strand a dead session — guessing `error` would kill a live one.
      return "running";
    }
  }
}

function statusAllowsActiveTurn(status: ThreadSessionStatus): boolean {
  return status === "starting" || status === "running";
}

/**
 * Fold one lifecycle event onto the previous session state. `previous` is what
 * ingestion last emitted for the thread (or the head, after a host restart);
 * the result is what `thread.session-set` carries.
 */
export function nextSessionState(input: {
  event: SessionLifecycleEvent;
  previous: ThreadSessionState;
}): ThreadSessionState {
  const { event, previous } = input;
  const eventTurnId = event.turnId !== undefined ? String(event.turnId) : undefined;
  const activeTurnId = previous.activeTurnId;

  const status: ThreadSessionStatus = (() => {
    switch (event.type) {
      case "session.state.changed":
        return threadStatusFromRuntimeState(event.payload.state);
      case "turn.started":
        return "running";
      case "session.exited":
        return "stopped";
      // §5.1 folds T3's `interrupted` session status into `stopped`.
      case "turn.aborted":
        return "stopped";
      case "turn.completed":
        return event.payload.state === "failed" ? "error" : "ready";
      case "runtime.error":
        return "error";
      case "session.started":
      case "thread.started":
        // A provider thread/session start notification can arrive during an
        // active turn; preserve that lifecycle state.
        return activeTurnId !== null ? "running" : "ready";
      default: {
        const exhaustive: never = event;
        void exhaustive;
        return previous.status;
      }
    }
  })();

  const nextActiveTurnId: string | null = (() => {
    switch (event.type) {
      case "turn.started":
        return eventTurnId ?? null;
      case "turn.completed":
      case "turn.aborted":
      case "session.exited":
        return null;
      case "runtime.error":
        // A runtime error stops the turn: the projector settles it `failed`.
        return null;
      case "session.state.changed":
        return statusAllowsActiveTurn(status) ? activeTurnId : null;
      default:
        return activeTurnId;
    }
  })();

  const lastError: string | undefined = (() => {
    switch (event.type) {
      case "session.state.changed":
        return event.payload.state === "error"
          ? (event.payload.reason ?? previous.lastError ?? "Provider session error")
          : status === "ready"
            ? undefined
            : previous.lastError;
      case "turn.completed":
        return event.payload.state === "failed"
          ? (event.payload.errorMessage ?? previous.lastError ?? "Turn failed")
          : undefined;
      case "turn.aborted":
        return undefined;
      case "session.exited":
        return event.payload.exitKind === "error"
          ? (event.payload.reason ?? previous.lastError ?? "Provider exited")
          : undefined;
      case "runtime.error":
        return event.payload.message;
      default:
        return status === "ready" ? undefined : previous.lastError;
    }
  })();

  const providerThreadId =
    event.type === "thread.started" ? event.payload.providerThreadId : previous.providerThreadId;
  const resumeCursor =
    event.type === "session.started" && event.payload.resume !== undefined
      ? event.payload.resume
      : previous.resumeCursor;

  return {
    status,
    activeTurnId: nextActiveTurnId,
    ...(providerThreadId !== undefined ? { providerThreadId } : {}),
    ...(resumeCursor !== undefined ? { resumeCursor } : {}),
    ...(lastError !== undefined ? { lastError } : {})
  };
}

/**
 * Whether two session states are the same fact. Claude's CLI emits ~3
 * `system/status` frames per turn whose only value is `"requesting"`, so
 * without this every turn writes three identical `thread.session-set` rows
 * (`apps/daemon/test/fixtures/claude/README.md`, observation 6).
 */
export function sameSessionState(a: ThreadSessionState, b: ThreadSessionState): boolean {
  return (
    a.status === b.status &&
    a.activeTurnId === b.activeTurnId &&
    a.providerThreadId === b.providerThreadId &&
    a.lastError === b.lastError &&
    a.resumeCursor === b.resumeCursor
  );
}

/** The state a thread starts from when ingestion has never seen it. */
export function initialSessionState(): ThreadSessionState {
  return { status: "idle", activeTurnId: null };
}
