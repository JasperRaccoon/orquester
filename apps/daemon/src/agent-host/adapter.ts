/**
 * Agent host — the adapter interface (spec §4.1).
 *
 * Ported from T3 Code (MIT):
 * `apps/server/src/provider/Services/ProviderAdapter.ts` (`ProviderAdapterShape`),
 * translated from Effect into plain promises.
 *
 * Every adapter is a **plain object** implementing {@link AgentAdapter}.
 * Complexity belongs at this boundary: orchestration records intent and state
 * without knowing which provider runs a thread, and every protocol, account,
 * permission and capability difference is normalised here rather than spread
 * through the routes and the client.
 *
 * The rules below are enforced by the orchestration layer so no adapter can
 * forget them.
 */

import type {
  AccountHome,
  AdapterCapabilities,
  AgentAdapterId,
  ApprovalDecision,
  AttachmentRef,
  InteractionMode,
  ModelSelection,
  ProviderSession,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeMode,
  ThreadSnapshot
} from "@orquester/api/agent-chat";

// ---------------------------------------------------------------------------
// Operation inputs
// ---------------------------------------------------------------------------

export interface StartSessionInput {
  threadId: string;
  cwd: string;
  /**
   * The PROJECT ROOT the daemon validated — the `<workspacesDir>/<ws>/<project>`
   * dir the tab belongs to, never a subdirectory.
   *
   * Any per-project pooling keys on **this**, not on `cwd`: OpenCode runs one
   * `opencode serve` per project (§3.2), and a thread opened on a subdirectory
   * would otherwise spawn a second server for the same checkout. Optional so
   * an adapter can still fall back to `cwd`.
   */
  projectPath?: string;
  home: AccountHome;
  title?: string;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  /**
   * The registry entry's own launch args (claudex/claudemix proxy flags, a
   * user's configured flags). Adapters that can fold a flag into their
   * protocol — Claude's `--permission-mode` /
   * `--dangerously-skip-permissions` — read them here; the rest ignore them.
   * Empty when the entry declares none.
   */
  launchArgs?: readonly string[];
  /**
   * The adapter's own cursor from `meta.json`. `unknown` by contract — each
   * adapter owns its shape and it is the only thing persisted for resume. A
   * cursor that fails its own shape check means "no resume", **never** an
   * error.
   */
  resumeCursor?: unknown;
}

export interface SendTurnInput {
  threadId: string;
  /** One flat string, already trimmed and bounds-checked by the host (§4.1). */
  input: string;
  /** References only, resolved by the host against the thread's attachments dir. */
  attachments: AttachmentRef[];
  modelSelection?: ModelSelection;
  interactionMode: InteractionMode;
  /**
   * §3.3 recovery. A `continuation: true` turn with no `input` and no
   * attachments against an adapter that does not declare
   * `promptlessTurnContinuation` is a validation error, not a silently empty
   * turn — the host checks that before calling.
   */
  continuation?: boolean;
}

export interface SendTurnResult {
  /** The provider's own turn id, stringified. Never host-minted. */
  turnId: string;
  /** Persisted to `meta.json` every time (§4.1 "Cursor per turn"). */
  resumeCursor?: unknown;
}

// ---------------------------------------------------------------------------
// The interface
// ---------------------------------------------------------------------------

/**
 * One adapter serves one provider.
 *
 * **Interface rules** (§4.1), enforced by orchestration:
 *
 * - **Cursor per turn.** `sendTurn`'s returned cursor is persisted every time.
 *   Claude also refreshes it on every assistant message.
 * - **Steering.** `sendTurn` while a turn is active reuses the active turn id
 *   and injects into the running loop. It is neither an error nor a second
 *   turn.
 * - **Settle before interrupt.** Every pending approval and user-input request
 *   is resolved with `cancel` and emitted as `request.resolved` /
 *   `user-input.resolved` **before** `interruptTurn` or `stopSession` reaches
 *   the provider. This is not a UI nicety: a transport that answers server
 *   requests inline on its read loop is blocked by an open prompt, so
 *   cancelling after the interrupt RPC deadlocks Stop exactly when a card is
 *   open (§3.1).
 * - **Interrupt has two scopes.** With a `turnId` it is turn-scoped: it
 *   carries the turn the user pressed Stop on and is a no-op when that turn
 *   is no longer the active one, so a Stop that races a settling turn cannot
 *   kill the next one. **Without** one it is session-scoped and is valid
 *   with no turn running (§6.2): it is the only way to stop background
 *   work, and it stops ALL of it — every live subagent, background shell
 *   and watch loop — closing each with `task.completed {status:"stopped"}`
 *   so the roster and the liveness registry clear. Returning early there
 *   leaves the client's "Stopping…" latch set forever.
 * - **Lazy recovery.** `sendTurn` on a thread with no live session starts one
 *   from the persisted cursor first. A crashed, OOM-killed or restarted
 *   session is indistinguishable from a fresh one.
 * - **Two-phase rollback.** `assertRollbackSupported` runs after the revert's
 *   turn-count validation and **before anything on disk, in the ref store or
 *   in the provider is touched** (§5.5 step 2).
 * - **A running state never outlives its process.** Before `session.exited` is
 *   emitted the adapter settles the in-flight turn — `interrupted` when the
 *   stream simply ended, `failed` with the first captured failure when it
 *   ended in error — closes every live task with
 *   `task.completed {status: "stopped"}`, and fails every request still parked
 *   on that transport (§3.1).
 * - **Every step that waits on a child has a deadline** (§3.1). Use
 *   `support/deadline.ts`; an expired deadline kills the child rather than
 *   leaving the thread `starting` forever.
 * - **No lazy dynamic `import()`** anywhere under the host (§8): a surviving
 *   host must never load changed source after a deploy.
 * - **An unknown frame is surfaced, never dropped by a catch-all** (§10). The
 *   demux switch ends in `satisfies never`, and the runtime fallback emits
 *   `runtime.warning` — which never ends an active turn.
 *
 * `uploadFeedback` (Codex-only, `feedback/upload`) is deliberately **not** part
 * of this interface — provider feedback upload is a non-goal (§2).
 */
export interface AgentAdapter {
  readonly id: AgentAdapterId;
  readonly capabilities: AdapterCapabilities;

  startSession(input: StartSessionInput): Promise<ProviderSession>;
  sendTurn(input: SendTurnInput): Promise<SendTurnResult>;

  interruptTurn(threadId: string, turnId?: string): Promise<void>;
  /** T3 names it `respondToRequest`; same contract. */
  respondToApproval(
    threadId: string,
    requestId: string,
    decision: ApprovalDecision
  ): Promise<void>;
  /** Attachments are folded into the answer text by the host before this call. */
  respondToUserInput(
    threadId: string,
    requestId: string,
    answers: Record<string, unknown>
  ): Promise<void>;
  compact(threadId: string): Promise<void>;
  readThread(threadId: string): Promise<ThreadSnapshot>;

  /**
   * Project a {@link ThreadSnapshot} — the provider's OWN transcript — into the
   * §4.2 event union, so a resumed thread has a timeline.
   *
   * A resume replays nothing onto the message stream (verified for Claude:
   * `replayUuids: []`), so without this the thread opens empty even though the
   * provider has the whole conversation. Every event carries
   * `raw.source = HISTORICAL_RAW_SOURCE`: it describes something that already
   * happened, so a consumer must not let it raise attention, fire a push or
   * move a live turn.
   *
   * Pure and synchronous — the reading already happened in `readThread`.
   * Optional: an adapter whose snapshot items are not projectable omits it and
   * the host falls back to an empty timeline.
   */
  projectHistory?(snapshot: ThreadSnapshot): RuntimeEvent[];
  rollbackThread(threadId: string, numTurns: number): Promise<ThreadSnapshot>;

  /**
   * Translate a {@link readThread} result into the events §7.3 renders, so a
   * RESUMED thread does not open as a blank page (E2E finding E6).
   *
   * `ThreadSnapshot.turns[].items` is **opaque by contract** — only the
   * adapter that produced it can read it — which is why the projection lives
   * behind the adapter rather than in the host.
   *
   * Optional: an adapter whose provider cannot hand back a transcript simply
   * omits it, and the host falls back to an empty timeline exactly as today.
   * Every event it returns is already settled and claims no token usage; the
   * `raw.source` says "history", never live traffic.
   */
  projectHistory?(snapshot: ThreadSnapshot): RuntimeEvent[];

  listSessions(): ProviderSession[];
  hasSession(threadId: string): boolean;
  stopSession(threadId: string): Promise<void>;
  stopAll(): Promise<void>;

  /**
   * Driver-level probe. One call, not two (§4.1). Probes never authenticate
   * and never open a real session; the background refresh that keeps
   * `installed`/`version`/`auth` current must never open a provider session
   * (§6.3). `cwd` scopes the per-directory overlay of §4.6.4.
   *
   * `home` names the account the snapshot should describe. Without it the
   * probe runs under the HOST's identity, so `auth`, the subscription label
   * and the usage windows report the daemon user's own login rather than the
   * identity a thread runs under — which is the wrong answer on any host using
   * managed accounts. It is optional so an adapter that has no per-account
   * notion can ignore it; §4.5's cache key (`binaryPath\0configDir\0cwd`)
   * already assumes the config dir varies with it.
   */
  refreshSnapshot(input?: { cwd?: string; home?: AccountHome }): Promise<ProviderSnapshot>;

  /** The adapter's canonical event stream. One consumer: the host's ingestion. */
  readonly events: AsyncIterable<RuntimeEvent>;
}

// ---------------------------------------------------------------------------
// Context handed to every factory
// ---------------------------------------------------------------------------

export interface AdapterLogger {
  debug(message: string, detail?: unknown): void;
  info(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
}

/** A seam, so log rotation and retention are testable against a set clock (§9). */
export interface Clock {
  now(): Date;
  /** ISO-8601, the only stamp format that reaches an event. */
  nowIso(): string;
}

/** A seam, so an event log is byte-stable in a test (§9). */
export interface IdGen {
  eventId(): string;
  /** Message ids are minted by the host, never by the provider (§5.1). */
  messageId(prefix: string): string;
  uuid(): string;
}

export interface AdapterContext {
  logger: AdapterLogger;
  clock: Clock;
  ids: IdGen;
  /**
   * Resolve an {@link AttachmentRef} id to an absolute host path inside the
   * thread's `attachments/` dir. Rejects an id that does not belong to this
   * thread — an id names its owning thread by construction (§5.1).
   */
  resolveAttachmentPath(threadId: string, attachmentId: string): Promise<string>;
  /** The thread's attachments dir, handed to Claude as an additional directory. */
  attachmentsDir(threadId: string): string;
  /**
   * Append one untranslated provider frame to `raw.ndjson`. Best-effort and
   * never blocking; transient delta frames are dropped by the writer (§3.1).
   */
  logRawFrame(threadId: string, frame: unknown): void;
  /**
   * Build the complete child environment (`support/env.ts`). Never spreads
   * `process.env`.
   */
  buildEnv(input: {
    threadId: string;
    home: AccountHome;
    /** The project root, for a child shared by a project rather than a thread. */
    projectPath?: string;
    extraEnv?: Readonly<Record<string, string | undefined>>;
  }): Record<string, string>;
  /**
   * Absolute path of the registry-resolved binary for a chat `refId`. Must be
   * a real executable, not a shim or a bare name: the Claude SDK spawns the
   * path directly, without a shell and without PATH resolution (§10).
   */
  resolveBin(refId: string): Promise<string | null>;
  /** The session PATH (`sessionPath()`), wider than the daemon's own. */
  sessionPath(): string;
  /** `<appdir>/tmp` — `/tmp` is unavailable under `ProtectSystem=strict`. */
  tmpDir(): string;
  /** Aborted when the host is shutting down; every adapter must honour it. */
  signal: AbortSignal;
}

/**
 * How the host acquires an adapter. Acquiring happens **before** the command
 * gate opens (§3.1), so a factory may do real work — resolving a binary,
 * reading a manifest — but must not start a provider session.
 */
export type AdapterFactory = (context: AdapterContext) => Promise<AgentAdapter>;
