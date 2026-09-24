/**
 * Agent host — the internal service seams every host package codes against
 * (spec §3.1, §3.3, §5.1, §5.4, §5.6, §6.3, §6.4).
 *
 * These are interfaces only. W1 wires them, W2 implements {@link ThreadStore},
 * W3 {@link Ingestion}, W4 {@link CheckpointService}; the adapters (W6–W9) see
 * only `AdapterContext`. Keeping them here means a package can be built and
 * tested against a fake before its neighbour exists.
 */

import type {
  AttachmentRef,
  BackgroundLiveness,
  Checkpoint,
  CheckpointFile,
  CheckpointStatus,
  CommandReceipt,
  DomainEvent,
  FoldSnapshotFile,
  ProviderSessionBinding,
  ProviderSessionBindingPatch,
  ProviderSnapshot,
  RuntimeEvent,
  ThreadFoldState,
  ThreadHead,
  AgentAdapterId
} from "@orquester/api/agent-chat";

import type { Clock, IdGen } from "./adapter.ts";

export type { Clock, IdGen };

// ---------------------------------------------------------------------------
// ThreadStore (§5.1)
// ---------------------------------------------------------------------------

/**
 * An event as it is handed to the store: everything but the sequence, which
 * only the store may assign. Distributes over the union so each arm keeps its
 * own `type`/`payload` pairing.
 */
type OmitSeq<T> = T extends unknown ? Omit<T, "seq"> : never;
export type AppendableDomainEvent = OmitSeq<DomainEvent>;

/**
 * Where one event's line sits in `events.ndjson`: `byteOffset` is the file's
 * length before the line, `byteLength` the line's UTF-8 bytes INCLUDING its
 * newline — so the next line starts at `byteOffset + byteLength`. Bytes, never
 * characters: a history page is read back by byte range.
 */
export interface EventPosition {
  seq: number;
  byteOffset: number;
  byteLength: number;
}

export interface AppendResult {
  /** The sequence the last appended event landed at. */
  seq: number;
  /** The events as persisted, with their sequences stamped. */
  events: DomainEvent[];
  /** positions[i] describes events[i]'s line in events.ndjson. */
  positions: EventPosition[];
  /** Byte length of events.ndjson right after this append. */
  logBytes: number;
}

export interface EventsFromResult {
  events: DomainEvent[];
  positions: EventPosition[];
  /** The log was cut at a malformed line (same meaning as ThreadTail.truncated). */
  truncated: boolean;
  /** Highest seq decoded. */
  seq: number;
  /** Byte length of the log consumed (offset just past the last decoded line). */
  logBytes: number;
  /**
   * True when the log at `byteOffset` does not start with seq `afterSeq + 1`
   * (or is shorter than `byteOffset`): the caller's cursor is stale and it must
   * re-read from byte 0. `events` is then empty.
   */
  mismatch: boolean;
}

export interface ThreadTail {
  /** Events strictly after the requested sequence, in order. */
  events: DomainEvent[];
  /** The thread's current head sequence. */
  seq: number;
  /**
   * True when the log was truncated at a malformed line rather than read whole
   * (§5.1). The caller must answer a snapshot, not a replay.
   */
  truncated: boolean;
}

export interface AttachmentPutInput {
  threadId: string;
  /** Original filename; sanitised into the stored id by the store. */
  name: string;
  mimeType?: string;
  /** Absolute path of a file already on disk, which is COPIED, never linked. */
  sourcePath: string;
}

/**
 * The thread store owns `<appdir>/daemon/agent/`.
 *
 * Two invariants it must keep, both from §5.1:
 * - `seq` is **per thread** and monotonic. There is no global ordering to wait
 *   on, because subscriptions are per thread anyway.
 * - the receipt is written **in the same step** that appends the events, so a
 *   receipt never exists for events that did not land.
 */
export interface ThreadStore {
  /**
   * Append events and, atomically with them, the command receipt. Returns the
   * stamped events so the caller can publish exactly what was persisted.
   */
  append(input: {
    threadId: string;
    events: AppendableDomainEvent[];
    receipt?: Omit<CommandReceipt, "seq">;
  }): Promise<AppendResult>;

  /** Events after `afterSeq`, bounded by the caller's own budget (§6.3). */
  readTail(threadId: string, afterSeq: number): Promise<ThreadTail>;

  /** The whole log, for a cold fold. Truncates at a malformed line. */
  readAll(threadId: string): Promise<ThreadTail>;

  /**
   * The log from a recorded cursor — a fold snapshot's or the index's — to
   * its end, with every event's position. The line at `byteOffset` must carry
   * `afterSeq + 1`; anything else answers `mismatch` and the caller re-reads
   * from byte 0.
   */
  readEventsFrom(
    threadId: string,
    input: { byteOffset: number; afterSeq: number }
  ): Promise<EventsFromResult>;

  /** Events whose lines lie in [fromByte, toByte). Both are line boundaries the index recorded. */
  readEventRange(
    threadId: string,
    input: { fromByte: number; toByte: number }
  ): Promise<{ events: DomainEvent[]; truncated: boolean }>;

  /** entry.seq after ensureLoaded — meta.json + the log's last line, no fold. */
  lastSeq(threadId: string): Promise<number>;

  /** Current byte length of events.ndjson (0 when absent). */
  logLength(threadId: string): Promise<number>;

  /**
   * `state.json`, the fold snapshot (A2). A cache of the log, never an
   * authority: parsed and validated; null when missing/corrupt/other
   * version/other thread. Never throws.
   */
  loadFoldSnapshot(threadId: string): Promise<FoldSnapshotFile | null>;

  /** Atomic (tmp + rename), 0600, on the thread's write queue. */
  saveFoldSnapshot(input: {
    threadId: string;
    seq: number;
    logBytes: number;
    state: ThreadFoldState;
    extras?: Record<string, unknown>;
  }): Promise<void>;

  /**
   * `meta.json`, or null when the thread does not exist or does not parse.
   * `seedRuntime:false` is the metadata-only path the boot reconcile and the
   * stop handover decide on: it must not inspect `events.ndjson` merely to
   * decide whether a thread needs any work. A thread the store has already
   * seeded answers its in-memory head, which is at least as new as the file.
   */
  loadHead(threadId: string, options?: { seedRuntime?: boolean }): Promise<ThreadHead | null>;

  /** Atomic (tmp + rename). Called every 50 events and on turn end (§5.1). */
  saveHead(head: ThreadHead): Promise<void>;

  /**
   * `binding.json`, or null when the thread has none or it does not decode
   * (§8: a missing binding means "use the head's cursor").
   */
  loadBinding(threadId: string): Promise<ProviderSessionBinding | null>;

  /**
   * The ONE writer of the provider-session binding, and the reason the resume
   * cursor cannot be lost: every write is field-wise, `undefined` means
   * unchanged and `null` means cleared (§3.3, §4.1). Returns the merged
   * binding as it was persisted.
   */
  upsertSessionBinding(input: {
    threadId: string;
    /** Used only when there is no binding yet — a binding always names one. */
    adapter: AgentAdapterId;
    patch: ProviderSessionBindingPatch;
  }): Promise<ProviderSessionBinding>;

  /** Every thread id with a directory on disk. */
  listThreads(): Promise<string[]>;

  /**
   * Delete the thread directory, its attachments and every checkpoint ref
   * under its prefix. A closed tab whose record is gone is gone (§6.1).
   */
  deleteThread(threadId: string): Promise<void>;

  /** The recorded receipt for a `commandId`, or null. */
  getReceipt(commandId: string): Promise<CommandReceipt | null>;

  /** Record a receipt outside an append (a rejection that produced no events). */
  putReceipt(receipt: CommandReceipt): Promise<void>;

  /**
   * Claim an uploaded file into the thread's attachment namespace. Copies,
   * never hard-links, because an agent editing the delivered file in place
   * must not mutate the retry source (§6.3). Bounds are validated against the
   * **stat'd** file, not the declared size. Answers the ref with `path` — the
   * absolute destination — for the upload reply (§7.4).
   */
  putAttachment(input: AttachmentPutInput): Promise<AttachmentRef>;

  /** Absolute path for an attachment id owned by this thread. */
  resolveAttachment(threadId: string, attachmentId: string): Promise<string>;

  /**
   * Sweep: `pending`-segment uploads after 24 h, `.part` files after 1 h, and
   * attachments referenced only by messages a revert truncated (§5.5).
   */
  pruneAttachments(input?: { threadId?: string; now?: Date }): Promise<void>;

  /** Raw-frame writer for `AdapterContext.logRawFrame`. Best-effort, non-blocking. */
  logRawFrame(threadId: string, frame: unknown): void;

  /** Flush every pending writer. The drain seam every test waits on (§9). */
  drain(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Ingestion (§5.1 ingestion rules, §5.6 batching)
// ---------------------------------------------------------------------------

/**
 * The runtime → domain hop. This is where the §5.1 ingestion rules live, so no
 * adapter decides which runtime event becomes what.
 *
 * Batching is a **write** reducer, not just a wire one (§5.6): assistant,
 * reasoning and plan deltas buffer per message and flush every 250 ms or 8 KB,
 * whichever first, preferring a paragraph or closed-fence boundary. It sits
 * upstream of `events.ndjson`, so a token-by-token provider becomes a few
 * appended events per second per message.
 */
export interface Ingestion {
  /**
   * Translate one runtime event into zero or more domain events. Buffered
   * output is not returned here — it is emitted through the flush hooks.
   */
  ingest(event: RuntimeEvent): Promise<void>;

  /**
   * Flush and finalise the buffered assistant and reasoning text for a turn.
   * Two call sites are **mandatory rather than opportunistic** (§5.6): a
   * `request.opened` and a blocking `user-input.requested`, or the approval
   * banner appears above text the agent had already produced.
   */
  flushTurn(threadId: string, turnId: string | undefined): Promise<void>;

  /**
   * Close the active reasoning segment. Called on a tool `item.started`, or
   * post-tool thinking is appended to a block that already sits above the tool
   * row (§5.6).
   */
  finalizeReasoning(threadId: string, turnId: string | undefined): Promise<void>;

  /** Flush every buffer for a thread (turn settled, session exited). */
  flushThread(threadId: string): Promise<void>;

  /**
   * Release every in-memory structure ingestion holds for a thread, without
   * flushing: the thread is gone (`deleteThread`) or its tab was closed.
   *
   * Ingestion keeps per-thread segment, buffer, phase and dedupe state, some
   * of which grows once per activity, and the host is designed to run for
   * weeks across deploys — so a thread whose record is gone must not stay
   * resident. Idempotent, and safe to call for a thread ingestion never saw.
   *
   * *Added additively for Q1 #9 (W3 implements, W1 calls it).*
   */
  forget(threadId: string): Promise<void>;

  /** Flush everything. The drain seam every test waits on instead of sleeping (§9). */
  drain(): Promise<void>;

}

// ---------------------------------------------------------------------------
// Checkpoints (§5.4, §5.5)
// ---------------------------------------------------------------------------

export interface CaptureResult {
  turnCount: number;
  ref: string;
  status: CheckpointStatus;
  /**
   * Why the capture or the diff was not clean, for the
   * `checkpoint.capture.failed` activity's payload (§5.4). Present with
   * `status: "error"` (the capture itself failed) and also with
   * `status: "ready"` when only the diff summary was unavailable. Absent on a
   * clean capture, which is the `checkpoint.captured` case.
   */
  detail?: string;
}

export interface TurnDiffSummary extends CaptureResult {
  turnId: string | null;
  files: CheckpointFile[];
  assistantMessageId: string | null;
  completedAt: string;
}

/**
 * One hidden ref per turn:
 * `refs/orquester/checkpoints/<base64url(threadId)>/turn/<n>`. Nothing touches
 * the user's branch, HEAD or visible reflog. **Non-git projects skip
 * checkpoints silently**, and a capture or diff failure appends
 * `checkpoint.capture.failed` and never fails the turn (§5.4).
 */
export interface CheckpointService {
  /**
   * On `turn.started` — and on the `/turn` dispatch, before the provider is
   * asked, so the baseline really is the tree as it was before the turn:
   * capture the baseline at `turn/<turnCount>` if absent.
   *
   * Checkpoints are numbered by turn ORDER (§5.5, `@orquester/api`'s
   * `turns.ts`): the turn with ordinal N has its baseline at `turn/<N - 1>`
   * and its completion checkpoint at `turn/<N>`, so the numbers stay pinned to
   * the turns they describe even where a non-git stretch, a failed capture or
   * a resumed history left no checkpoint — sparse ref numbers are expected.
   * The host names the count through `turnCount`; without it the count is
   * derived as it always was, as the highest checkpoint turn count the thread
   * already has.
   *
   * **`null` means this project has no checkpoints at all** (it is not a git
   * work tree). A baseline that was already published answers
   * `status: "ready"` instead, because the two are not the same thing: from a
   * thread's second turn onwards the baseline is always already there.
   */
  captureBaseline(input: {
    threadId: string;
    cwd: string;
    /**
     * The fold's checkpoint rows, when the caller has them. A `missing`
     * placeholder carries a turn count but no ref, so the derived counter must
     * see it; without this the counter falls back to the refs on disk alone.
     */
    checkpoints?: readonly Checkpoint[];
    /**
     * The turn this baseline precedes. Recorded as the thread's started turn,
     * which is what lets a stale `turn.aborted` for a DIFFERENT turn be
     * refused at turn end rather than minting a checkpoint nobody expects.
     */
    turnId?: string | null;
    /**
     * The baseline's own turn count: the ordinal of the turn about to start,
     * minus one. Overrides the derived counter; the ref it names answers
     * `ready` untouched when it already exists and is captured otherwise.
     */
    turnCount?: number;
  }): Promise<CaptureResult | null>;

  /**
   * On `turn.completed` / `turn.aborted`: capture the turn's completion
   * checkpoint and diff it against the baseline one below it. The count is the
   * completing turn's ordinal when the host names it (`turnCount`), else the
   * count of a placeholder left by `turn.diff.updated` — **reused at its own
   * turn count** rather than incremented past — else the highest existing
   * count plus one. Only the session's active turn may produce a completion
   * checkpoint, and a turn that already has a non-placeholder checkpoint is
   * skipped. A missing baseline keeps the post ref and records an empty file
   * list.
   */
  captureTurnEnd(input: {
    threadId: string;
    cwd: string;
    turnId: string | null;
    assistantMessageId: string | null;
    /** As above: placeholders and already-captured turns live in the fold. */
    checkpoints?: readonly Checkpoint[];
    /** The session's active turn, when known — the guard above needs it. */
    activeTurnId?: string | null;
    /**
     * The turn the host recorded as started, when it tracks one itself;
     * otherwise the service uses what `captureBaseline` told it.
     */
    startedTurnId?: string | null;
    /** The completing turn's ordinal (§5.5) — preferred over every derivation. */
    turnCount?: number;
  }): Promise<TurnDiffSummary | null>;

  /**
   * `GET …/turns/:n/diff`. `from === to` short-circuits to an empty diff
   * without touching git; a turn above the thread's highest checkpoint is a
   * 404 rather than an empty result. Cached in memory by
   * `(threadId, from, to, ignoreWhitespace)` — derived state, dropped freely.
   */
  readTurnDiff(input: {
    threadId: string;
    cwd: string;
    fromTurnCount: number;
    toTurnCount: number;
    ignoreWhitespace?: boolean;
  }): Promise<string>;

  /**
   * §5.5 step 4: delete every checkpoint ref above the target turn count, and
   * every ref whose count is in `droppedTurnCounts` — the checkpoint counts of
   * the turns the rewind drops. A thread written before checkpoints were
   * numbered by turn order carries DENSE counts (a resumed thread's 28th turn
   * can own `turn/2`), which a bare `> target` test would leave behind.
   */
  pruneAbove(input: {
    threadId: string;
    cwd: string;
    targetTurnCount: number;
    droppedTurnCounts?: readonly number[];
  }): Promise<void>;

  /** §6.1 cascade: delete every ref under the thread's prefix. */
  deleteThreadRefs(input: { threadId: string; cwd: string }): Promise<void>;

  /**
   * §5.5 step 2, run **before anything on disk is touched**. Rejects for an
   * adapter with `supportsConversationRollback: false` (Grok).
   */
  assertRollbackSupported(adapter: AgentAdapterId): void;
}

// ---------------------------------------------------------------------------
// Liveness (§3.1, §6.4)
// ---------------------------------------------------------------------------

/**
 * T3's two-state background liveness, per thread and **in memory only**.
 *
 * Fed from the same task events the roster folds, classifying each transition
 * rather than making it sticky: a task reporting `idle` or any terminal status
 * drops out, a status-free progress row never resurrects one, and a
 * subagent's own shells are covered by the owning agent's entry while a
 * *nested* agent counts on its own.
 *
 * Deliberately not persisted: after a host restart the registry is empty,
 * which is correct, because orphaned background work is not live.
 */
export interface LivenessRegistry {
  /** Fold one task event into the registry. */
  observe(event: RuntimeEvent): void;
  /** `"working"` | `"monitoring"` | `null`, per §3.1. */
  liveness(threadId: string): BackgroundLiveness | null;
  /** How many live *agent* rows the thread has, for the banner's copy (§7.6). */
  liveAgentCount(threadId: string): number;
  /** `session.exited` clears the thread. */
  clear(threadId: string): void;
}

// ---------------------------------------------------------------------------
// Provider snapshots (§3.2, §4.1, §6.3)
// ---------------------------------------------------------------------------

/**
 * Snapshots refresh on a slow interval, not per request (§3.2): computed on
 * demand, cached, re-probed in the background every few minutes. Refreshes are
 * **serialised** so two clients opening Settings cannot run two probes, an
 * identical configuration short-circuits to the cached value, and a refresh
 * only runs while something is actually watching provider status.
 *
 * The last snapshot is persisted next to the registry so a restarted host can
 * render agent cards before the first live probe returns, and it is **keyed by
 * the agent id it was written for** rather than trusted by filename.
 */
export interface ProviderSnapshotRegistry {
  /** Cached snapshots for every adapter. Never blocks on a probe. */
  all(): ProviderSnapshot[];
  get(adapterId: AgentAdapterId): ProviderSnapshot | null;
  /**
   * Explicit user refresh (`POST /api/agent/providers/:id/refresh`) — the only
   * refresh allowed to re-read model catalogs (§6.3). `cwd` refreshes just
   * that directory's overlay (§4.6.4).
   */
  refresh(adapterId: AgentAdapterId, input?: { cwd?: string }): Promise<ProviderSnapshot>;
  /**
   * Forked off session start and off the reused-session path so it never
   * delays a turn (§4.6.4). Collapses concurrent requests for the same
   * `(adapter, cwd)` into one and never re-probes a cwd already present.
   */
  ensureWorkspaceSnapshot(adapterId: AgentAdapterId, cwd: string): void;
  /** Merge a sparse `account.rate-limits.updated` onto the cached snapshot by window id. */
  applyUsageLimits(adapterId: AgentAdapterId, event: RuntimeEvent): void;
  /** Subscribe to changes; the host broadcasts `agent.providers.changed` from this. */
  onChange(listener: (adapterId: AgentAdapterId) => void): () => void;
}
