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
  AgentGoal,
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
  /**
   * The goal the host's fold holds for this thread, without its `updatedAt`
   * (goals §4.6, §5.3). An adapter seeds the goal it tracks from it, so it
   * emits `thread.goal.updated` only for a real change — a resumed provider
   * repeating the goal the thread already shows is not one. `null`: the fold
   * has no goal.
   */
  knownGoal?: AgentGoal | null;
  /**
   * True only when this start restarts the session for an account switch
   * (goals §4.6, §5.3). A goal can live in the old account's home (Codex's
   * `goals_1.sqlite`), so the new session may not know it: the adapter then
   * re-creates {@link knownGoal} rather than reporting it cleared.
   */
  carryGoal?: boolean;
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

/**
 * A `/goal …` the HOST parsed (goals §4.6, §5.1) — only ever handed to an
 * adapter whose `capabilities.goals.command` is `"host"` (Codex). Any other
 * adapter receives `/goal …` as an ordinary turn, which its CLI parses.
 */
export type HostGoalCommand =
  | { kind: "status" }
  | { kind: "set"; objective: string }
  | { kind: "edit"; objective: string }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "clear" };

export interface GoalCommandResult {
  /** Human text for a visible `goal.status` row; "" when the provider's own updates tell the story. */
  summary: string;
}

/** What the host hands a `/goal …` besides the command itself (goals §4.6). */
export interface GoalCommandOptions {
  /**
   * The model the user picked in the composer together with the command,
   * passed when it differs from the one the thread last ran. An adapter whose
   * provider starts the goal's turns by itself
   * (`capabilities.goals.continuesAcrossTurns`, Codex) applies it BEFORE the
   * goal request: those turns run on the thread's own settings, and the next
   * turn the user sends would be too late. Best-effort — failing to apply it
   * is logged and never fails the command. Absent: nothing changes.
   */
  modelSelection?: ModelSelection;
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
/**
 * The cut a rewind makes, by turn id (§5.5). `firstRemovedTurnId` is the
 * first turn that goes; `droppedTurnIds` are every turn from it onwards and
 * `retainedTurnIds` every started turn before it, both in start order. Ids
 * are the fold's — the provider's own turn ids (§5.1) — so an adapter can
 * look them up in its own turn list.
 */
export interface RollbackTarget {
  firstRemovedTurnId: string;
  droppedTurnIds: readonly string[];
  retainedTurnIds: readonly string[];
}

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
  /**
   * Move one running tool call (`toolUseId`) or every foreground task to the
   * background, so the turn continues while the command keeps running — the
   * user's Ctrl+B. Present only when `capabilities.supportsBackgroundTasks`;
   * the host refuses the `/background` command otherwise. Resolves `false`
   * when the provider had nothing to move.
   */
  backgroundTasks?(threadId: string, toolUseId?: string): Promise<boolean>;
  /**
   * Run a host-parsed `/goal …` (goals §4.6, §5.1). Present exactly when
   * `capabilities.goals?.command === "host"`. The goal itself moves only
   * through this adapter's `thread.goal.updated` events, never through the
   * result; a provider error rejects with the provider's message.
   * `options.modelSelection` is the model picked together with the command
   * ({@link GoalCommandOptions}).
   */
  goalCommand?(
    threadId: string,
    command: HostGoalCommand,
    options?: GoalCommandOptions
  ): Promise<GoalCommandResult>;
  readThread(threadId: string): Promise<ThreadSnapshot>;

  /**
   * Project a {@link ThreadSnapshot} — the provider's OWN transcript — into the
   * §4.2 event union, so a resumed thread has a timeline.
   *
   * A resume replays nothing onto the message stream (verified for Claude:
   * `replayUuids: []`), so without this the thread opens empty even though the
   * provider has the whole conversation. `ThreadSnapshot.turns[].items` is
   * opaque by contract — only the adapter knows its provider's shape — so only
   * the adapter can project it. The host calls this once, at session start,
   * for a thread that resumes from a cursor and has no items of its own.
   *
   * Every event carries `raw.source = HISTORICAL_RAW_SOURCE`: it describes
   * something that already happened, so ingestion persists it while a consumer
   * must not let it raise attention, fire a push or move a live turn.
   *
   * Shape the host expects per historical turn: one `turn.started`, the turn's
   * `item.completed` rows (`user_message` / `assistant_message` with their
   * final text, tool items under their tool-lifecycle item type), then one
   * `turn.completed {state: "completed"}` whose `tokenUsage` is `unavailable`
   * — history carries no live accounting.
   *
   * Pure and synchronous — the reading already happened in `readThread`.
   * Optional: an adapter that cannot project its own history omits it, and the
   * host says so in the timeline rather than rendering an empty thread.
   */
  projectHistory?(snapshot: ThreadSnapshot): RuntimeEvent[];
  /**
   * §5.5 step 3: drop the last `numTurns` turns of the provider's conversation.
   *
   * `target` names the same cut by turn ID — the fold's ids, which for every
   * adapter are the provider's own (§5.1). An adapter that can resolve ids
   * MUST prefer them: `numTurns` is counted over the host's fold, and a
   * provider whose own turn list is longer (a resumed transcript with more
   * history than the cursor recorded) or shorter (a compaction that wrote
   * extra rows) would land a count-based cut on the wrong turn without
   * refusing. An id it cannot resolve is a refusal, never a guess. `target`
   * is absent only from a caller that predates it.
   */
  rollbackThread(
    threadId: string,
    numTurns: number,
    target?: RollbackTarget
  ): Promise<ThreadSnapshot>;

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

  /**
   * The PENDING snapshot (§3.2): what this provider looks like before anything
   * has been probed in this host process. **Synchronous and free of I/O** — it
   * is what the snapshot registry seeds itself with at construction, before
   * the disk cache is read and before any adapter has been acquired, so
   * `GET /api/agent/providers` is never `[]`.
   *
   * *T3: `apps/server/src/provider/makeManagedServerProvider.ts:69-73`
   * (`initialSnapshot(settings)`) and
   * `apps/server/src/provider/Layers/ClaudeProvider.ts:595-640`
   * (`makePendingClaudeProvider`).*
   *
   * Two invariants, both in `adapters/pending.ts`: it must never be
   * `status:"error"` (that would raise the client's "sign in again" toast for
   * a provider nobody has looked at), and it must carry the best model catalog
   * the adapter can name without probing — a snapshot with no model is still
   * unlaunchable.
   *
   * The registry never calls this on an adapter instance (it has none at
   * construction time); it reads the same module-level function through
   * `ADAPTER_PENDING_SNAPSHOTS`. The method exists so the pending shape is
   * reachable from an adapter reference, and so a new adapter cannot forget it.
   */
  pendingSnapshot(checkedAt: string): ProviderSnapshot;

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
