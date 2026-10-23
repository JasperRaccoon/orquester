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
  McpAppCallToolResult,
  ModelSelection,
  ProviderSession,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeMode,
  Skill,
  SlashCommand,
  ThreadSnapshot
} from "@orquester/api/agent-chat";

import type { HostThreadBox, HostThreadProfile, HostThreadServerPool } from "./host-protocol.ts";
import type { SessionToolsHost } from "./session-tools/index.ts";
import type { AgentHostBoxes } from "./boxes/index.ts";

// ---------------------------------------------------------------------------
// Operation inputs
// ---------------------------------------------------------------------------

/**
 * Registry `args` are the terminal launcher's flags; a chat launch never sees
 * them. Permissions come only from `runtimeMode`.
 */
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
  /**
   * The keyed provider server this thread runs on, from its `launch.json`
   * (`CreateHostThreadRequest.serverPool`). Read only by an adapter that
   * shares one server between threads (OpenCode: the server for
   * `(projectPath, serverPool.key)`, started with `serverPool`'s env on top of
   * the launcher env); every other adapter ignores it. Omitted: the project's
   * global server.
   */
  serverPool?: HostThreadServerPool;
  /**
   * The Agent Profile this thread launches with (spec 2026-10-18), from its
   * `launch.json` (`CreateHostThreadRequest.profile`, or the latest
   * `SetThreadIdentityRequest.profile`). Present on EVERY start of a profile
   * thread: create, resume, a crash restart, a host restart's rehydrate, an
   * identity switch's restart and a fork's child. Omitted: Global.
   *
   * An adapter that supports profiles reads its section with
   * `loadProfileManifest(input, agent)` (`adapters/profile-manifest.ts`),
   * which throws when the prepared directory cannot be launched from — the
   * start must then FAIL, never fall back to Global.
   */
  profile?: HostThreadProfile;
  /**
   * boxes: the project lives in a box (spec 2026-10-19 §8.5), from `launch.json` on EVERY start:
   * the CLI runs there — `AdapterContext.boxes.launch(...)` prepares it. Omitted: this machine.
   * An adapter must never start a box thread's CLI here instead.
   */
  box?: HostThreadBox;
  title?: string;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
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
  /**
   * True when the host will ask for {@link AgentAdapter.readThread} right
   * after this start to replay a resumed thread's history (E6). An adapter
   * whose history read is slow may begin it now, alongside its own start-up,
   * and answer that `readThread` from it. Purely a hint: ignoring it is correct.
   */
  prefetchHistory?: boolean;
}

export interface SendTurnInput {
  threadId: string;
  /**
   * One flat string, already trimmed and bounds-checked by the host (§4.1) —
   * except a message-mode answer's echo (§6.2), which the host builds itself
   * from the questions and answers and does not bound.
   */
  input: string;
  /**
   * References only, resolved by the host against the thread's attachments
   * dir, each carrying the `sizeBytes` the host STAT'd (never the size the
   * client declared). The adapter hands its provider what it ingests natively
   * and names every other file in an `Attached files:` block after the text
   * (`adapters/attachment-lines.ts`, §4.1).
   */
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
  /**
   * A `resume` handed {@link GoalCommandOptions.onlyIfPaused} found the goal
   * not paused, so nothing was sent: it was going already, or it ended,
   * blocked or hit a limit, or there is none. `summary` is then "".
   */
  notPaused?: true;
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
  /**
   * Goals §5.7, `resume` only — the host's own resume of a goal it held for a
   * deploy: set the goal going again only if the PROVIDER holds it `paused`
   * as it answers. The host's fold can trail the provider (a set's own
   * notification trails its reply), so the host cannot decide this itself; a
   * goal going already, or one that ended, blocked or hit a limit meanwhile,
   * is left as it is and answered {@link GoalCommandResult.notPaused}.
   */
  onlyIfPaused?: true;
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

/**
 * Thread lineage (spec 2026-10-14 §6): which turns of the SOURCE thread a fork
 * keeps, in the source fold's turn ids — the provider's own (§5.1), as for a
 * {@link RollbackTarget}. `retainedTurnIds` is never empty (a fork that keeps
 * nothing is a fresh thread, and the host never asks for one);
 * `firstRemovedTurnId` is the first started turn after them, or `null` when
 * the fork keeps the whole conversation.
 */
export interface ForkCut {
  retainedTurnIds: readonly string[];
  firstRemovedTurnId: string | null;
}

/** {@link AgentAdapter.sessionCatalog}'s answer. */
export interface SessionCatalog {
  slashCommands: SlashCommand[];
  skills: Skill[];
}

/** {@link AgentAdapter.forkConversation}'s input. */
export interface ForkConversationInput {
  /** The thread whose conversation is copied. Its live session, if any, is never touched. */
  sourceThreadId: string;
  /** The SOURCE's resume cursor — its binding's, else its head's. */
  sourceResumeCursor: unknown;
  /** The new thread the fork is for; the answered cursor belongs to it. */
  threadId: string;
  /** The project root, for an adapter that pools by project (OpenCode). */
  projectPath: string;
  cwd: string;
  /**
   * The SOURCE's account home. A provider's resume identity stays in the home
   * that created it, so the fork is written there and the child runs there.
   */
  home: AccountHome;
  /**
   * The CHILD's keyed server ({@link StartSessionInput.serverPool}), for an
   * adapter that forks on a shared server: the fork is made where the child
   * will run. Omitted: the global server.
   */
  serverPool?: HostThreadServerPool;
  /**
   * The CHILD's Agent Profile ({@link StartSessionInput.profile}): the
   * parent's unless the fork request named another. Omitted: Global.
   */
  profile?: HostThreadProfile;
  /** boxes: the box the SOURCE's conversation lives in; the fork is made there. */
  box?: HostThreadBox;
  cut: ForkCut;
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
  /**
   * Attachments are folded into the answer text by the host before this call.
   *
   * `options.cancel` is the HOST's cancel — a Stop, the session's stop, a
   * closed tab (`settlePendingRequests`): nobody answered, and `answers` is
   * then `{}`. An adapter whose provider has a cancel of its own answers with
   * it — Grok's `{outcome: "cancelled"}`, where `{}` reached the CLI as an
   * empty answer — and every other one answers `{}` as it always has. A
   * user's answer, an empty one or a skip included, never carries it.
   */
  respondToUserInput(
    threadId: string,
    requestId: string,
    answers: Record<string, unknown>,
    options?: { cancel?: boolean }
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
   * Stop ONE live background task by the id its roster row carries — a
   * workflow run, a subagent, a background shell — leaving the turn and every
   * other task running. Present only when `capabilities.supportsTaskStop`; the
   * host refuses the `/task/stop` command otherwise, and checks that the roster
   * lists the task live before calling. Resolving means the provider accepted
   * the stop; the task's own `task.completed` (`stopped`) closes its row.
   */
  stopTask?(threadId: string, taskId: string): Promise<void>;
  /**
   * The commands and skills the thread's LIVE session loaded — what an Agent Profile chat's
   * composer offers instead of the provider's Global catalog (`GET /threads/:id/catalog`).
   * `null`: no live session, or it has not reported one yet. Never starts a session; bounded
   * reads only; never rejects for a provider that cannot answer (it answers `null`).
   */
  sessionCatalog?(threadId: string): Promise<SessionCatalog | null>;
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

  /**
   * Thread lineage (spec 2026-10-14 §6): copy a thread's provider conversation,
   * through `input.cut`, into a NEW provider conversation and answer the
   * resume cursor the child thread starts from — the host then creates the
   * child exactly as a §6.1 create-time resume, history replay included.
   *
   * Never moves the source: its session, cursor and binding stay as they are,
   * and a source mid-turn is fine as long as the cut keeps only settled turns
   * (the host checks). A refusal throws before anything is written where the
   * provider allows it. Present only where the provider has a native fork
   * (Claude `forkSession`, Codex `thread/fork`, OpenCode `session.fork`); the
   * host hands the conversation over as a transcript otherwise (Grok).
   */
  forkConversation?(input: ForkConversationInput): Promise<{ resumeCursor: unknown }>;

  listSessions(): ProviderSession[];
  hasSession(threadId: string): boolean;
  /**
   * Whether a background task this adapter reported — a background shell, a watch loop, a
   * subagent — is still running: `true` it runs (however long it has said nothing), `false` it
   * is gone (its own process exited, the provider dropped it from its live set, the session
   * that ran it ended), `undefined` the adapter cannot tell. The host's liveness registry asks
   * it on every read, so it must be synchronous and cheap, and it decides what a deploy's drain
   * waits on: a running shell is never read as done because it fell silent. Optional — without
   * it every task is bounded by time (`UNCHECKED_BACKGROUND_TTL_MS`).
   */
  backgroundTaskLive?(threadId: string, taskId: string): boolean | undefined;
  /**
   * `options.endedByUser`: the user ended the session — the session stop
   * command or a closed tab (`stopSessionInternal`) — rather than the host
   * restarting it for a thread that goes on (an account, permission-mode or
   * cwd change; a stale adapter's session) or tearing down (`stopAll`, a
   * drain-restart included). An adapter whose provider leaves the processes
   * its work started running past its own exit stops them only then (Grok:
   * `GrokSession.stop`): a deploy must never kill running work. Every other
   * adapter ignores it.
   */
  stopSession(threadId: string, options?: { endedByUser?: boolean }): Promise<void>;
  /**
   * The user is ending the thread's live session — the session stop command
   * or a closed tab (`stopSessionInternal`) — and the host is about to answer
   * its open cards with a cancel, which can end the provider before
   * `stopSession(…, {endedByUser: true})` runs (and a provider that is gone
   * gets no `stopSession` at all). Called FIRST, before any card is answered,
   * so an adapter that must read what its provider started while it lives,
   * or mark the end as the user's, does so now (Grok: its task sessions,
   * recorded and remembered for the end's sweep; an exit in between closes
   * its work stopped, not "Left running…"). Optional; never the host's
   * teardown or a restart.
   */
  prepareUserEnd?(threadId: string): Promise<void>;
  /**
   * The user ended the thread's session — the session stop command, a closed
   * tab — so stop what EARLIER launches of the thread left running that only
   * a user's end may stop, live session or not (Grok: the work its agent
   * started, which a deploy, a restart or a crash left running;
   * `support/leftover-work.ts`). Called after `stopSession(…, {endedByUser:
   * true})` when a session was live, and on its own when none was. Optional:
   * an adapter that leaves no such work has nothing to sweep.
   */
  sweepEndedSession?(threadId: string): Promise<void>;
  /**
   * Agent profile §4.8 (`POST /opencode/recycle-idle`), OpenCode only: restart
   * the long-lived provider servers so the next turn reads config the agent
   * profile just wrote. A server with nothing running is stopped now, one with
   * work running when it next goes idle; running turns are never disturbed and
   * no thread's session binding or cursor moves. `recycled` counts servers
   * stopped by the call, `deferred` the ones left to recycle when idle.
   * `poolKey` narrows it to the servers started for that key (see
   * {@link StartSessionInput.serverPool}); omitted, every server is recycled.
   */
  recycleIdleServers?(input?: { poolKey?: string }): Promise<{ recycled: number; deferred: number }>;
  /**
   * The host's teardown: never the user ending a session (see {@link
   * stopSession}). Called twice by it — by the adapter's own listener on the
   * host's abort signal, then by `main.ts`'s `stop()` — so no call may
   * resolve before the stops an earlier call started have written their rows
   * and done their work (Grok's and Codex's took the session map, OpenCode's
   * server pool its servers, and returned at once on the second call), and
   * the event stream must end only after those rows: `stop()` then lets the
   * consumer read the stream to its end (bounded), stops the orchestrator,
   * and the process exits.
   */
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

  /**
   * MCP Apps (spec 2026-10-14 §3): what an app a tool call produced may ask
   * of its own MCP server, run through the thread's LIVE provider session —
   * whose MCP client owns the connection and its credentials, so no server
   * process is ever duplicated. Present only on an adapter whose provider
   * exposes an MCP Apps UI resource and a way to reach the server (Codex,
   * Grok); the host checks which app and which server before calling.
   */
  readonly mcpApps?: AdapterMcpApps;

  /** The adapter's canonical event stream. One consumer: the host's ingestion. */
  readonly events: AsyncIterable<RuntimeEvent>;
}

/** One tool of an MCP server, as a live provider session lists it. */
export interface AdapterMcpTool {
  name: string;
  /** `annotations.title`, when the server gave one. */
  title?: string;
  /** `annotations.readOnlyHint === true`; false when the provider does not say. */
  readOnly: boolean;
  /** The tool's own `_meta` (its `ui.visibility` decides whether an app may call it). */
  meta?: unknown;
  /** The MCP `Tool` definition as the provider reports it, handed to the app as `toolInfo`. */
  definition: unknown;
}

/**
 * Thrown by {@link AdapterMcpApps} when the thread has no live session: an
 * app view never starts one (a provider session is the user's to start).
 */
export class McpAppSessionUnavailableError extends Error {
  constructor(message = "The agent's session is not running. Send a message to start it, then try again.") {
    super(message);
    this.name = "McpAppSessionUnavailableError";
  }
}

export interface AdapterMcpApps {
  /**
   * The provider takes {@link setModelContext} into the agent's next turn
   * through an additive context channel (Codex's `additionalContext`).
   */
  readonly modelContext: boolean;
  listTools(threadId: string, server: string): Promise<AdapterMcpTool[]>;
  callTool(
    threadId: string,
    input: { server: string; tool: string; arguments: Record<string, unknown> }
  ): Promise<McpAppCallToolResult>;
  readResource(threadId: string, input: { server: string; uri: string }): Promise<{ contents: unknown[] }>;
  /**
   * Replace what one app (`key`, its tool call's row) tells the agent on its
   * next turn; `null` clears it. Present exactly when {@link modelContext}.
   */
  setModelContext?(threadId: string, key: string, context: { server: string; tool: string; text: string } | null): void;
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
   * Store bytes the ADAPTER produced as one of the thread's attachments (an
   * MCP App's snapshot, spec 2026-10-14 §3) and answer its id. The id's
   * suffix is the name's extension (`app.html` → `…-html`). Optional: a
   * context without it captures nothing.
   */
  storeAttachment?(threadId: string, input: { name: string; mimeType: string; bytes: string }): Promise<string>;
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
  /**
   * The thread's `leftover-work.json` (`agentChatThreadLeftoverWorkPath`):
   * where an adapter whose provider leaves the user's work running past its
   * own exit remembers each launch's task sessions until the user ends the
   * thread's session (Grok). Optional: a context without it remembers
   * nothing, and a later user end sweeps only a live session.
   */
  leftoverWorkPath?(threadId: string): string;
  /** Aborted when the host is shutting down; every adapter must honour it. */
  signal: AbortSignal;
  /**
   * Session tools (design `2026-10-14-agent-visuals-and-session-tools-design.md`
   * §1): the thread-scoped `orquester` MCP server, its instruction block and
   * its credentials. Present only when at least one toolkit is registered —
   * without it an adapter attaches no server, adds no instructions and
   * changes nothing it sends. `session-tools/index.ts`.
   */
  sessionTools?: SessionToolsHost;
  /**
   * boxes: agent CLIs in boxes (spec 2026-10-19 §8.5, `boxes/index.ts`). A start whose input
   * names `box` launches through it; absent, such a start fails (never runs here instead).
   */
  boxes?: AgentHostBoxes;
}

/**
 * How the host acquires an adapter. Acquiring happens **before** the command
 * gate opens (§3.1), so a factory may do real work — resolving a binary,
 * reading a manifest — but must not start a provider session.
 */
export type AdapterFactory = (context: AdapterContext) => Promise<AgentAdapter>;
