/**
 * Knowledge Graph linking — the coalesced, single-flight run queue (implements
 * `KnowledgeLinkingPort`; spec "Linking runs", "Schema growth").
 *
 * Queue:
 * - `entriesChanged`: `relabelled` never links (collections are not in the graph). Anything else
 *   adds its entries to the pending set (persisted) and starts a run
 *   `KNOWLEDGE_LINK_DEBOUNCE_MS` after the LAST change, never later than
 *   `KNOWLEDGE_LINK_MAX_WAIT_MS` after the FIRST pending one (injected clock).
 * - One run at a time. Changes during a run wait for the next one, scheduled when it ends.
 * - `rebuild()` asks for a full re-extraction into a fresh myKG session; it starts at once, or
 *   after the run in flight. The recorded session switches only when the rebuild succeeds.
 *
 * A run (`state.currentRun`, persisted BEFORE its child is spawned):
 *   mode `full` (no session yet) | `update` | `grow-schema` | `rebuild` → `runner.ts` argv;
 *   the inbox broker (`inbox.ts`) and the worker pool (`workers.ts`) answer its tasks;
 *   success → `KnowledgeGraphPort.load(<session>/output)`, then the run's entries are `linked`
 *   (those in `failed_chunks.json` `failed`); failure → `failed`, the error kept as `lastError`,
 *   the entries back in the pending set and a retry after `errorRetryMs` (any new change retries
 *   sooner); cancelled → back in the pending set.
 * - A daemon restart re-runs an interrupted run under the same id. A survivor child is stopped
 *   first (`runner.ts` `stopStaleMykg`: only the recorded pid while it is still that myKG child,
 *   by command line and start time; SIGTERM, a wait for its exit on the clock, SIGKILL after the
 *   grace); one that outlives that pauses the run with an error rather than start a second myKG on
 *   its session. Every new child on a known session starts from an inbox holding only answered
 *   tasks (`inbox.ts` `clearUnansweredTasks`), so workers answer only what that child asks for, and
 *   myKG's answer cache stays. `--update` resumes from myKG's finished steps, cached shards and
 *   answered tasks; a full/rebuild run resumes its session. Worker chats still working are
 *   adopted. Every update
 *   after one that did not succeed (interrupted, failed, cancelled) first puts back the last good
 *   run's `file_manifest.json` (`mykg-files.ts` `guardMykgManifest`), else myKG would never see
 *   that run's edits and deletes again.
 *
 * Schema growth policy (spec: thresholds are the builder's call). myKG's `detect-schema-drift`
 * only reports schema entries the graph no longer uses (a prune signal), not new topics, so growth
 * is driven by volume: a run uses `--append-with-grow-schema` once the entries changed since the
 * schema was last induced or grown reach `max(GROW_MIN_ENTRIES, GROW_RATIO × entries at that
 * time)` — at least 20, and at least half as many as the schema was built from.
 *
 * Pauses (status `paused` with a reason): `plugin-off` (a run in flight is cancelled and its chats
 * ended), `not-installed` (likewise), `usage-limit` / `no-account` (the pool waits, the myKG child
 * keeps waiting on its inbox — its task timeout is 48 h), `error` (a failed run, retried later;
 * also, with no retry, a `state.json` a newer Orquester wrote: nothing is linked or written over —
 * `state.ts` — while the graph it built is still loaded).
 *
 * Phase 2 (docs/superpowers/specs/2026-10-27-knowledge-phase2-cross-graph-design.md, section L),
 * all through `graphView` (search and the concept graph, injected; absent: none of it):
 * - Neighbour context: a run's broker shows Pass 2 tasks with the concepts of the entry's nearest
 *   neighbours (`context.ts`); the entries whose task was shown a block (`contextEntryIds`, persisted
 *   with the run) record `LINK_CONTEXT_VERSION` when the run links them
 *   (`KnowledgeStorePort.setLinkContext`).
 * - Automatic re-linking (`relink.ts`): with no save waiting, a run takes up to 25 entries with a
 *   vector linked with an older context version, queued by a link gap, or whose re-link failed (a
 *   bounded retry); their manifest keys and cached answers go first, so myKG extracts them again and
 *   the worker sees the context. Each re-link is recorded per version and content hash
 *   (`relink.attempts`), so an entry is never re-linked twice for the same reason. Status `relink`.
 * - Link gaps: after each graph load linking does, `findLinkGaps` queues both entries of each new
 *   pair once per pair of content hashes ({@link KnowledgeLinkingService.gapQueued}).
 * - Pair checks (`pair-checks.ts`, {@link KnowledgeLinkingService.pairChecks}): after a graph load,
 *   once nothing is left to link or re-link, a round of up to 30 daemon-written tasks is answered
 *   by worker chats of its own (own inbox, broker and pool, `kp_` id); a run that wants to start
 *   ends the round first, and a pool that finds no account ends it. Its tokens count.
 */

import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  KNOWLEDGE_LINK_DEBOUNCE_MS,
  KNOWLEDGE_LINK_MAX_WAIT_MS,
  type KnowledgeLinkingState,
  type KnowledgePauseReason,
  type KnowledgeRebuildEstimate,
  type KnowledgeRunMode,
  type KnowledgeRunSummary,
  type KnowledgeWorkerNextResponse,
  type KnowledgeWorkerSubmitResponse,
  type KnowledgeWorkerView,
  type SessionOwner
} from "@orquester/api";
import {
  KNOWLEDGE_RECENT_RUNS_MAX,
  KNOWLEDGE_RECENT_WORKERS_MAX,
  KNOWLEDGE_TOKEN_DAYS_MAX,
  knowledgeMykgDir,
  knowledgeMykgHomeDir,
  knowledgePairChecksInboxDir,
  knowledgePairChecksPath,
  knowledgeStatePath,
  knowledgeWorkersDir,
  type KnowledgeCurrentRunRecord,
  type KnowledgeLinkingStateRecord,
  type KnowledgeRunRecord,
  type KnowledgeWorkerRecord
} from "@orquester/config";
import type { Clock } from "../../workflows/contracts.ts";
import type {
  KnowledgeEntryChange,
  KnowledgeGraphPort,
  KnowledgeLinkingPort,
  KnowledgeRuntimePort,
  KnowledgeSettingsPort,
  KnowledgeStorePort
} from "../ports.ts";
import { contextReady, EntryDocumentLocator, LINK_CONTEXT_VERSION, linkContextProvider, type KnowledgeLinkGraphView } from "./context.ts";
import { clearUnansweredTasks, InboxBroker } from "./inbox.ts";
import { writeMykgConfig } from "./mykg-config.ts";
import {
  commitMykgManifest,
  guardMykgManifest,
  isMykgSessionName,
  mykgSessionPaths,
  readFailedEntryIds,
  readManifestEntryIds,
  readMykgProgress
} from "./mykg-files.ts";
import {
  harvestPairCheckInbox,
  KnowledgePairChecks,
  PAIR_CHECK_MAX_PER_RUN,
  PAIR_CHECK_STEP,
  pairCheckCandidates,
  parsePairCheckAnswer,
  removePairCheckTask,
  validatePairCheckAnswer,
  writePairCheckTask,
  type PairKey
} from "./pair-checks.ts";
import {
  pickRelinkBatch,
  prepareRelinkBatch,
  queueLinkGaps,
  recordRelinkAttempts,
  RELINK_RETRIES_MAX,
  relinkBacklog,
  relinkStatus,
  resetRelinkWave,
  settleRelink
} from "./relink.ts";
import { MykgRun, procMykgProbe, stopStaleMykg, type MykgProcessProbe, type MykgRunResult, type SpawnMykg } from "./runner.ts";
import { LinkingStateFile } from "./state.ts";
import { WorkerPool, type WorkerCandidate, type WorkerPoolEvent, type WorkerSessionPort } from "./workers.ts";

export const GROW_MIN_ENTRIES = 20;
export const GROW_RATIO = 0.5;
/** Name-normalization calls a rebuild estimate counts while there is no graph to count types in. */
export const DEFAULT_NORMALIZE_TYPES = 10;

const DEFAULT_TIMINGS = {
  debounceMs: KNOWLEDGE_LINK_DEBOUNCE_MS,
  maxWaitMs: KNOWLEDGE_LINK_MAX_WAIT_MS,
  /** Progress files re-read while a run is in flight. */
  progressMs: 5_000,
  /** How long a finished run waits for its chats to end their turns (their tokens are counted). */
  settleMs: 120_000,
  /** A failed run is tried again after this (sooner on any new change). */
  errorRetryMs: 30 * 60_000
};

export interface KnowledgeLinkingLogger {
  info?(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface KnowledgeLinkingOptions {
  appdir: string;
  runtime: KnowledgeRuntimePort;
  settings: KnowledgeSettingsPort;
  store: KnowledgeStorePort;
  graph: KnowledgeGraphPort;
  /** The worker chats (`createDaemonWorkerSessions`). */
  workers: WorkerSessionPort<WorkerCandidate>;
  clock: Clock;
  spawn?: SpawnMykg;
  /** Reads and signals a pid (the stale-child check, `runner.ts` `stopStaleMykg`); tests stub it. */
  processProbe?: MykgProcessProbe;
  logger?: KnowledgeLinkingLogger;
  /**
   * Search and the concept graph as phase 2 reads them (`context.ts`): neighbour context, automatic
   * re-linking, link gaps and pair checks. Absent: none of them (linking as before phase 2).
   */
  graphView?: KnowledgeLinkGraphView;
}

interface ActiveRun {
  record: KnowledgeCurrentRunRecord;
  run: MykgRun;
  broker: InboxBroker;
  pool: WorkerPool<WorkerCandidate>;
  progressTimer: { cancel(): void } | null;
  step: string;
  progress: { done: number; total: number } | null;
  poolPause: { reason: Extract<KnowledgePauseReason, "usage-limit" | "no-account">; message: string; resumesAt: string | null } | null;
  /** Set when the run is stopped from here: what to record instead of the child's own result. */
  stopReason: { kind: "error"; message: string } | { kind: "cancel" } | { kind: "detach" } | null;
  finished: Promise<void>;
}

/** A round of pair checks between linking runs (see the module header). */
interface PairRound {
  id: string;
  broker: InboxBroker;
  pool: WorkerPool<WorkerCandidate>;
  /** Task id → the pair it checks. */
  tasks: Map<string, PairKey>;
  ending: boolean;
  /** Resolves once the round's chats ended and its inbox was cleaned. */
  ended: Promise<void>;
}

export interface KnowledgeLinkingEvents {
  /** The linking status, last run, workers or tokens moved: re-publish `KnowledgeStatus`. */
  status: [];
}

/** The linking parts of `KnowledgeStatus` (`routes-linking.ts` adds the counts). */
export interface KnowledgeLinkingSnapshot {
  linking: KnowledgeLinkingState;
  lastRun: KnowledgeRunSummary | null;
  recentRuns: KnowledgeRunSummary[];
  workers: KnowledgeWorkerView[];
  tokens: { week: { in: number; out: number }; total: { in: number; out: number } };
  lastError: { message: string; at: string } | null;
  /** Automatic re-linking (`KnowledgeStatus.relink`): null when nothing is left; absent without `graphView`. */
  relink?: { pending: number; done: number; total: number } | null;
}

export class KnowledgeLinkingService implements KnowledgeLinkingPort {
  readonly events = new EventEmitter<KnowledgeLinkingEvents>();
  private readonly opts: KnowledgeLinkingOptions;
  private readonly stateFile: LinkingStateFile;
  private readonly mykgDir: string;
  private readonly homeDir: string;
  private readonly workersDir: string;
  private state: KnowledgeLinkingStateRecord | null = null;
  private active: ActiveRun | null = null;
  private timer: { cancel(): void } | null = null;
  private startsAt: number | null = null;
  private lastChangeAt: number | null = null;
  private starting = false;
  /** `launch` is between its first await and `this.active` (so no second child is spawned beside it). */
  private launching = false;
  private stopped = false;
  /** Changes reported before `start` loaded the state. */
  private early: KnowledgeEntryChange[] = [];
  /** `state.json` is a newer Orquester's: nothing is linked (see `state.ts`), and this says why. */
  private newerNotice: { message: string; at: string } | null = null;
  private readonly offs: (() => void)[] = [];
  /**
   * LLM pair checks of two entries (`KnowledgePairChecksPort`, phase 2 spec "Pair checks"): hand it
   * to search/insights (W3). Loaded by `start`.
   */
  readonly pairChecks: KnowledgePairChecks;
  private readonly pairInboxDir: string;
  private pairRound: PairRound | null = null;
  private pairStarting = false;
  /** A graph load since the last pair-check round. */
  private pairRoundDue = false;

  constructor(options: KnowledgeLinkingOptions) {
    this.opts = options;
    this.stateFile = new LinkingStateFile(knowledgeStatePath(options.appdir), () => options.clock.now());
    this.mykgDir = knowledgeMykgDir(options.appdir);
    this.homeDir = knowledgeMykgHomeDir(options.appdir);
    this.workersDir = knowledgeWorkersDir(options.appdir);
    this.pairInboxDir = knowledgePairChecksInboxDir(options.appdir);
    this.pairChecks = new KnowledgePairChecks({
      path: knowledgePairChecksPath(options.appdir),
      hashOf: (id) => options.store.getMeta(id)?.contentHash ?? null,
      now: () => options.clock.now(),
      ...(options.logger ? { logger: options.logger } : {})
    });
  }

  // --- lifecycle -------------------------------------------------------------------------------

  /** Loads `state.json`, loads the recorded graph, resumes an interrupted run or schedules one. */
  async start(): Promise<void> {
    this.stopped = false;
    this.state = await this.stateFile.load();
    const newer = this.stateFile.newer;
    this.newerNotice = newer
      ? {
          message:
            `The linking state was written by a newer Orquester (state version ${newer.version}). Linking is paused so this version does not ` +
            `change that version's runs; the graph it built is still shown. Update Orquester to link again.` +
            (newer.writable ? "" : " The state file is kept exactly as it is."),
          at: this.opts.clock.now().toISOString()
        }
      : null;
    for (const change of this.early.splice(0)) this.entriesChanged(change);
    this.offs.push(this.opts.settings.onChange(() => this.onEnvironmentChanged()));
    this.offs.push(this.opts.runtime.onChange(() => this.onEnvironmentChanged()));
    if (this.opts.graphView) {
      await this.pairChecks.load().catch((error: unknown) => this.opts.logger?.warn("knowledge linking: pair-checks.json could not be read", { error: String(error) }));
    }
    const session = this.state.session;
    if (session && isMykgSessionName(session)) {
      const paths = mykgSessionPaths(this.mykgDir, session);
      if (await exists(paths.nodes)) {
        const loaded = await this.opts.graph.load(paths.output).then(
          () => true,
          (error: unknown) => {
            this.opts.logger?.warn("knowledge linking: the recorded graph could not be loaded", { error: String(error) });
            return false;
          }
        );
        if (loaded && !this.newerNotice) await this.afterGraphLoad();
      }
    }
    const current = this.state.currentRun;
    if (this.newerNotice) {
      // A newer build's run is not this build's to resume or stop.
    } else if (current) {
      // A resumed run stops the previous daemon's child itself (`launchNow`); else it is stopped here.
      if (this.canRun()) await this.launch(current, { resume: true });
      else await this.stopStale(current);
    } else {
      this.schedule();
    }
    this.emitStatus();
  }

  /**
   * The daemon is stopping: the child is stopped (the run stays recorded, so the next start
   * re-runs it), its chats are left in the agent host, timers end.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const off of this.offs.splice(0)) off();
    this.timer?.cancel();
    this.timer = null;
    const active = this.active;
    if (active) {
      active.stopReason = { kind: "detach" };
      active.pool.detach();
      active.run.cancel();
      await active.finished;
    }
    const round = this.pairRound;
    if (round) {
      this.endPairRound(round, { interrupt: true });
      await round.ended;
    }
    await this.stateFile.flush();
    await this.pairChecks.flush();
  }

  // --- KnowledgeLinkingPort --------------------------------------------------------------------

  entriesChanged(change: KnowledgeEntryChange): void {
    if (change.kind === "relabelled" || change.entryIds.length === 0) return;
    this.pairChecks.entriesChanged(change.entryIds);
    const state = this.state;
    if (!state) {
      this.early.push(change);
      return;
    }
    const pending = new Set(state.pendingEntryIds);
    for (const id of change.entryIds) pending.add(id);
    state.pendingEntryIds = [...pending];
    const now = this.opts.clock.now();
    this.lastChangeAt = now.getTime();
    state.pendingSince ??= now.toISOString();
    // A new change retries a failed run (with the next debounce) rather than waiting for the retry.
    if (state.pause?.reason === "error") state.pause = null;
    this.persist();
    if (!this.active) this.schedule();
    this.emitStatus();
  }

  status(): KnowledgeLinkingState {
    const state = this.state;
    // Before `start()` has loaded the state, the changes it buffered (`early`) are what waits: they
    // are replayed once it has, so a save made meanwhile is queued, never "nothing to link".
    const pendingEntries = state ? state.pendingEntryIds.length : new Set(this.early.flatMap((change) => change.entryIds)).size;
    if (!this.opts.settings.enabled()) {
      return { state: "paused", reason: "plugin-off", message: "The Knowledge Graph plugin is off.", resumesAt: null, pendingEntries };
    }
    if (!this.opts.runtime.current()) {
      return { state: "paused", reason: "not-installed", message: "myKG is not installed.", resumesAt: null, pendingEntries };
    }
    if (this.newerNotice) return { state: "paused", reason: "error", message: this.newerNotice.message, resumesAt: null, pendingEntries };
    const active = this.active;
    if (active) {
      if (active.poolPause) return { state: "paused", ...active.poolPause, pendingEntries };
      return { state: "running", runId: active.record.id, mode: active.record.mode, step: active.step, progress: active.progress, pendingEntries };
    }
    if (state?.pause) {
      return { state: "paused", reason: state.pause.reason, message: state.pause.message, resumesAt: state.pause.resumesAt, pendingEntries };
    }
    if (!state && pendingEntries > 0) return { state: "queued", pendingEntries, startsAt: this.opts.clock.now().toISOString() };
    if (state && (pendingEntries > 0 || state.rebuildRequested || state.currentRun)) {
      const at = this.startsAt ?? this.opts.clock.now().getTime();
      return { state: "queued", pendingEntries, startsAt: new Date(at).toISOString() };
    }
    return { state: "idle" };
  }

  // --- rebuild -----------------------------------------------------------------------------------

  /** Asks for a full re-extraction (spec "Rebuild graph"): now, or after the run in flight. */
  async rebuild(): Promise<{ queued: boolean; running: boolean }> {
    const state = this.requireState();
    if (this.active?.record.mode === "rebuild") return { queued: false, running: true };
    state.rebuildRequested = true;
    if (state.pause?.reason === "error") state.pause = null;
    await this.stateFile.save(state);
    if (this.active || !this.canRun()) {
      this.emitStatus();
      return { queued: true, running: false };
    }
    this.timer?.cancel();
    this.timer = null;
    await this.maybeStart();
    return { queued: false, running: this.active !== null };
  }

  /**
   * Expected myKG tasks for a rebuild — an APPROXIMATION shown as information only (spec "Schema
   * growth"); the rebuild induces its schema afresh, so its types, and myKG's batching, may differ:
   * - Pass 1: one call per ~16k-token batch of the corpus (at most 25), plus harmonize and review;
   * - Pass 2: one call per ~16k tokens of each entry (one entry per call, `batch_per_file`);
   * - name normalization: one call per concept type (`batch_token_target: 1`, `mykg-config.ts`)
   *   that has at least two names to merge (myKG skips a type with one) — counted on the CURRENT
   *   graph's types, or {@link DEFAULT_NORMALIZE_TYPES} while there is no graph.
   */
  async rebuildEstimate(): Promise<KnowledgeRebuildEstimate> {
    const entries = this.opts.store.listMeta();
    let total = 0;
    let pass2 = 0;
    for (const entry of entries) {
      let tokens = 0;
      try {
        tokens = Math.ceil((await stat(join(this.opts.store.mykgInputDir, `${entry.id}.md`))).size / 4);
      } catch {
        tokens = 0;
      }
      total += tokens;
      pass2 += Math.max(1, Math.ceil(tokens / 16_000));
    }
    if (entries.length === 0) return { entries: 0, tasks: 0 };
    const pass1 = Math.min(25, Math.max(1, Math.ceil(total / 16_000))) + 2;
    const types = [...this.opts.graph.conceptTypes().values()];
    const normalize = types.length === 0 ? DEFAULT_NORMALIZE_TYPES : types.filter((concepts) => concepts >= 2).length;
    return { entries: entries.length, tasks: pass1 + pass2 + normalize };
  }

  // --- worker protocol ---------------------------------------------------------------------------

  /** The session is a worker chat of the run in flight (its owner names that run). */
  isActiveWorker(owner: SessionOwner | undefined): boolean {
    if (owner?.kind !== "knowledge-indexer") return false;
    return (this.active !== null && owner.runId === this.active.record.id) || (this.pairRound !== null && owner.runId === this.pairRound.id);
  }

  workerNext(sessionId: string, signal?: AbortSignal): Promise<KnowledgeWorkerNextResponse> {
    const broker = this.brokerFor(sessionId);
    if (!broker) return Promise.resolve({ kind: "done", reason: "run-finished" });
    return broker.next(sessionId, signal);
  }

  workerSubmit(sessionId: string, taskId: string, answer: string, signal?: AbortSignal): Promise<KnowledgeWorkerSubmitResponse> {
    const broker = this.brokerFor(sessionId);
    if (!broker) return Promise.resolve({ accepted: false, error: "No linking run is in flight; end your turn." });
    return broker.submit(sessionId, taskId, answer, signal);
  }

  /** The pair-check round's broker for its own chats (or any chat while no run is in flight), else the run's. */
  private brokerFor(sessionId: string): InboxBroker | null {
    const round = this.pairRound;
    if (round && (round.broker.knows(sessionId) || !this.active)) return round.broker;
    return this.active?.broker ?? null;
  }

  // --- status parts ------------------------------------------------------------------------------

  snapshot(): KnowledgeLinkingSnapshot {
    const state = this.state;
    const running = this.active ? runningSummary(this.active.record) : null;
    const recent = (state?.recentRuns ?? []).map(toRunSummary);
    const recentRuns = running ? [running, ...recent].slice(0, KNOWLEDGE_RECENT_RUNS_MAX) : recent;
    return {
      linking: this.status(),
      lastRun: recentRuns[0] ?? null,
      recentRuns,
      workers: (state?.workers ?? []).map(toWorkerView),
      tokens: {
        week: weekTokens(state, this.opts.clock.now()),
        total: { in: state?.tokens.total.in ?? 0, out: state?.tokens.total.out ?? 0 }
      },
      lastError: this.newerNotice ? { ...this.newerNotice } : state?.lastError ? { message: state.lastError.message, at: state.lastError.at } : null,
      ...(this.opts.graphView ? { relink: state ? relinkStatus(state.relink, this.relinkBacklog().length) : null } : {})
    };
  }

  /**
   * Entries queued for re-linking by link gaps (phase 2 spec, "Link gaps"), until a run re-links
   * them: the insights' `queued` flag of a gap is "both of its entries are in here".
   */
  gapQueued(): ReadonlySet<string> {
    return new Set(this.state?.relink.gapQueue ?? []);
  }

  /** Resolves once no pair-check round runs (tests, shutdown). */
  async pairChecksIdle(): Promise<void> {
    while (this.pairRound || this.pairStarting) {
      if (this.pairRound) await this.pairRound.ended;
      else await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  /** The recorded myKG session's output dir (the graph), or null before the first run. */
  graphDir(): string | null {
    const session = this.state?.session;
    return session && isMykgSessionName(session) ? mykgSessionPaths(this.mykgDir, session).output : null;
  }

  /** Resolves when the run in flight (if any) has ended and been recorded (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.active) await this.active.finished;
  }

  // --- scheduling ----------------------------------------------------------------------------------

  private canRun(): boolean {
    return !this.stopped && this.newerNotice === null && this.opts.settings.enabled() && this.opts.runtime.current() !== null;
  }

  private onEnvironmentChanged(): void {
    if (this.stopped) return;
    if (this.pairRound && !this.canRun()) this.endPairRound(this.pairRound, { interrupt: true });
    const active = this.active;
    if (active && !this.canRun()) {
      // Plugin off or runtime gone: the run is cancelled and its chats end now.
      active.stopReason ??= { kind: "cancel" };
      void active.pool.stop();
      active.run.cancel();
      this.emitStatus();
      return;
    }
    if (active) {
      active.pool.setConcurrency(this.opts.settings.get().concurrency);
      return;
    }
    const current = this.state?.currentRun;
    if (current && this.canRun()) {
      void this.launch(current, { resume: true }).catch((error: unknown) => this.opts.logger?.warn("knowledge linking: resume failed", { error: String(error) }));
      return;
    }
    this.schedule();
    this.emitStatus();
  }

  private schedule(): void {
    this.timer?.cancel();
    this.timer = null;
    this.startsAt = null;
    const state = this.state;
    if (!state || this.active || !this.canRun()) return;
    const now = this.opts.clock.now().getTime();
    let at: number;
    // A failed run (a failed rebuild included) waits for its retry; asking again clears the pause.
    if (state.pause?.reason === "error") {
      const resumes = state.pause.resumesAt ? Date.parse(state.pause.resumesAt) : Number.NaN;
      if (!Number.isFinite(resumes)) return;
      at = resumes;
    } else if (state.rebuildRequested) {
      at = now;
    } else if (state.pendingEntryIds.length > 0 && state.pendingSince) {
      const first = Date.parse(state.pendingSince);
      const last = this.lastChangeAt ?? now;
      at = Math.min(last + DEFAULT_TIMINGS.debounceMs, Number.isFinite(first) ? first + DEFAULT_TIMINGS.maxWaitMs : last + DEFAULT_TIMINGS.debounceMs);
    } else if (state.session && this.relinkBacklog().length > 0) {
      // Re-linking goes through the normal cadence, one batch per run.
      at = now + DEFAULT_TIMINGS.debounceMs;
    } else {
      // Nothing to link: a pair-check round may use the workers now.
      void this.maybeStartPairRound().catch((error: unknown) => this.opts.logger?.warn("knowledge linking: a pair-check round could not start", { error: String(error) }));
      return;
    }
    this.startsAt = at;
    this.timer = this.opts.clock.setTimeout(() => {
      this.timer = null;
      void this.maybeStart().catch((error: unknown) => this.opts.logger?.warn("knowledge linking: a run could not start", { error: String(error) }));
    }, Math.max(0, at - now));
  }

  private async maybeStart(): Promise<void> {
    const state = this.state;
    if (!state || this.active || this.starting || this.launching || !this.canRun()) return;
    if (state.currentRun) {
      // A recorded run that did not get going (a failed resume): it goes first, under its id.
      await this.launch(state.currentRun, { resume: true });
      return;
    }
    if (state.pause?.reason === "error") state.pause = null;
    const mode = this.nextMode();
    if (mode === null) {
      this.emitStatus();
      return;
    }
    this.starting = true;
    try {
      // Linking goes first: a pair-check round in progress ends (its chats finish their task).
      if (this.pairRound) this.endPairRound(this.pairRound, { interrupt: false });
      const metas = this.opts.store.listMeta();
      const all = metas.map((entry) => entry.id);
      const now = this.opts.clock.now().toISOString();
      const relinkIds = mode === "update" || mode === "grow-schema" ? pickRelinkBatch(state.relink, this.relinkBacklog(), state.pendingEntryIds.length > 0) : [];
      const resumable = (mode === "full" || mode === "rebuild") && state.resumeSession && isMykgSessionName(state.resumeSession) ? state.resumeSession : null;
      const record: KnowledgeCurrentRunRecord = {
        id: this.mintRunId(),
        mode,
        startedAt: now,
        session: mode === "update" || mode === "grow-schema" ? state.session : resumable,
        entryIds: mode === "full" || mode === "rebuild" ? all : [...new Set([...state.pendingEntryIds, ...relinkIds])],
        entryHashes: {},
        tasks: 0,
        tokensIn: 0,
        tokensOut: 0,
        pid: null,
        pidStartTime: null,
        ...(relinkIds.length > 0 ? { relinkEntryIds: relinkIds } : {})
      };
      for (const meta of metas) if (record.entryIds.includes(meta.id)) record.entryHashes[meta.id] = meta.contentHash;
      state.currentRun = record;
      state.pendingEntryIds = [];
      state.pendingSince = null;
      if (mode === "rebuild") state.rebuildRequested = false;
      this.lastChangeAt = null;
      // Persisted BEFORE the child starts: a restart from here on re-runs this run.
      await this.stateFile.save(state);
      try {
        await this.launch(record, { resume: false });
      } catch (error) {
        // Nothing ran: the entries wait for the retry.
        if ((this.active as ActiveRun | null)?.record === record) throw error;
        const at = this.opts.clock.now();
        const message = `The linking run could not start: ${error instanceof Error ? error.message : String(error)}`;
        state.currentRun = null;
        if (mode === "rebuild") state.rebuildRequested = true;
        else state.pendingEntryIds = [...new Set([...record.entryIds.filter((id) => !relinkIds.includes(id)), ...state.pendingEntryIds])];
        state.pendingSince ??= now;
        state.lastError = { message, at: at.toISOString() };
        state.pause = { reason: "error", message, resumesAt: new Date(at.getTime() + DEFAULT_TIMINGS.errorRetryMs).toISOString() };
        await this.stateFile.save(state);
        this.schedule();
        this.emitStatus();
      }
    } finally {
      this.starting = false;
    }
  }

  /** The mode of the next run, or null when there is nothing to do. */
  private nextMode(): KnowledgeRunMode | null {
    const state = this.state!;
    const entries = this.opts.store.listMeta().length;
    if (state.rebuildRequested) return entries > 0 ? "rebuild" : null;
    if (!state.session) {
      if (entries === 0) {
        // Nothing to extract yet: what was pending (deletes of never-linked entries) is moot.
        state.pendingEntryIds = [];
        state.pendingSince = null;
        this.persist();
        return null;
      }
      return "full";
    }
    // No save waits: a re-link batch, if any (`relink.ts`).
    if (state.pendingEntryIds.length === 0) return this.relinkBacklog().length > 0 ? "update" : null;
    const changed = state.schema.changedSince + state.pendingEntryIds.length;
    const threshold = Math.max(GROW_MIN_ENTRIES, Math.ceil(GROW_RATIO * state.schema.entriesAtChange));
    return changed >= threshold ? "grow-schema" : "update";
  }

  private mintRunId(): string {
    return `kr_${randomBytes(6).toString("hex")}`;
  }

  // --- a run ---------------------------------------------------------------------------------------

  private async launch(record: KnowledgeCurrentRunRecord, options: { resume: boolean }): Promise<void> {
    if (this.launching) return;
    this.launching = true;
    try {
      await this.launchNow(record, options);
    } finally {
      this.launching = false;
    }
  }

  private async launchNow(record: KnowledgeCurrentRunRecord, options: { resume: boolean }): Promise<void> {
    const state = this.requireState();
    const runtime = this.opts.runtime.current();
    if (!runtime || this.active) return;
    // A record that names no session cannot update one: it extracts in full.
    if ((record.mode === "update" || record.mode === "grow-schema") && !record.session) record.mode = "full";
    if (options.resume && (await this.stopStale(record)) === "alive") {
      // Two myKG processes must never share a session: the run waits for the error retry.
      this.pauseForError(`A myKG process from before the restart (pid ${record.pid}) did not stop, so the run was not started again. It is tried again later.`);
      return;
    }
    const settings = this.opts.settings.get();
    await mkdir(this.mykgDir, { recursive: true, mode: 0o700 });
    await mkdir(join(this.homeDir, "tmp"), { recursive: true, mode: 0o700 });
    await mkdir(this.workersDir, { recursive: true, mode: 0o700 });
    await writeMykgConfig(this.mykgDir, { concurrency: settings.concurrency, model: settings.model });
    // An update after one that did not succeed starts from the last good run's manifest (`guardMykgManifest`).
    if ((record.mode === "update" || record.mode === "grow-schema") && record.session && isMykgSessionName(record.session)) {
      await guardMykgManifest(mykgSessionPaths(this.mykgDir, record.session));
    }
    // No myKG runs on the session now (a survivor was stopped above): the tasks an earlier process
    // left unanswered go, so workers are only handed what the new one asks for (`inbox.ts`).
    if (record.session && isMykgSessionName(record.session)) {
      const cleared = await clearUnansweredTasks(mykgSessionPaths(this.mykgDir, record.session).intermediate);
      if (cleared.length > 0) this.opts.logger?.info?.("knowledge linking: cleared tasks an earlier myKG process left unanswered", { runId: record.id, tasks: cleared.length });
    }
    // A re-link batch: its manifest keys and cached answers go, so myKG extracts it again with context.
    const relinkIds = record.relinkEntryIds ?? [];
    if (relinkIds.length > 0 && (record.mode === "update" || record.mode === "grow-schema") && record.session && isMykgSessionName(record.session)) {
      await this.prepareRelink(mykgSessionPaths(this.mykgDir, record.session), relinkIds, record.id);
    }
    // The daemon began stopping, or the plugin went off, meanwhile: the run stays recorded for later.
    if (!this.canRun() || this.active) return;

    const view = this.opts.graphView;
    const broker = new InboxBroker({
      clock: this.opts.clock,
      ...(this.opts.logger ? { logger: this.opts.logger } : {}),
      ...(view ? { contextFor: linkContextProvider(this.opts.store, view, (entryId) => this.contextShown(record, entryId)) } : {})
    });
    let active!: ActiveRun;
    const pool = new WorkerPool<WorkerCandidate>({
      port: this.opts.workers,
      broker,
      runId: record.id,
      concurrency: settings.concurrency,
      clock: this.opts.clock,
      onEvent: (event) => this.onPoolEvent(active, event),
      ...(this.opts.logger ? { logger: this.opts.logger } : {})
    });
    const run = new MykgRun(
      { runtime, mykgDir: this.mykgDir, homeDir: this.homeDir, inputDir: this.opts.store.mykgInputDir, mode: record.mode, session: record.session },
      { clock: this.opts.clock, ...(this.opts.spawn ? { spawn: this.opts.spawn } : {}) }
    );
    let resolveFinished!: () => void;
    active = {
      record,
      run,
      broker,
      pool,
      progressTimer: null,
      step: options.resume ? "resuming" : "starting",
      progress: null,
      poolPause: null,
      stopReason: null,
      finished: new Promise<void>((resolve) => (resolveFinished = resolve))
    };
    this.active = active;
    this.timer?.cancel();
    this.timer = null;
    this.startsAt = null;

    broker.events.on("answered", () => {
      record.tasks += 1;
      this.persist();
      this.emitStatus();
    });
    run.onSession((session) => {
      record.session = session;
      if (record.mode === "full" || record.mode === "rebuild") state.resumeSession = session;
      this.persist();
      void this.attachInbox(active, session);
    });
    record.pid = run.pid;
    // With its start time, so a later daemon never signals another process that reused the pid.
    record.pidStartTime = run.pid !== null ? await this.probe().startTime(run.pid).catch(() => null) : null;
    this.persist();
    // Chats from before a restart first, so no new chat is started beside one that still works.
    if (options.resume) {
      await pool.adopt(state.workers.filter((worker) => worker.runId === record.id && worker.state === "running"));
    }
    if (record.session) await this.attachInbox(active, record.session);
    this.scheduleProgress(active);
    this.emitStatus();

    void run.done
      .then((result) => this.finish(active, result))
      .catch((error: unknown) => this.opts.logger?.warn("knowledge linking: recording a run failed", { error: String(error) }))
      .finally(() => {
        if (this.active === active) this.active = null;
        resolveFinished();
        if (active.stopReason?.kind !== "detach") {
          this.schedule();
          this.emitStatus();
        }
      });
  }

  private async attachInbox(active: ActiveRun, session: string): Promise<void> {
    try {
      await active.broker.attach(mykgSessionPaths(this.mykgDir, session).intermediate);
    } catch (error) {
      this.opts.logger?.warn("knowledge linking: the inbox could not be watched", { error: String(error) });
    }
    active.pool.reconcile();
  }

  private scheduleProgress(active: ActiveRun): void {
    active.progressTimer = this.opts.clock.setTimeout(() => {
      active.progressTimer = null;
      if (this.active !== active) return;
      void this.refreshProgress(active).finally(() => {
        if (this.active === active) this.scheduleProgress(active);
      });
    }, DEFAULT_TIMINGS.progressMs);
  }

  private async refreshProgress(active: ActiveRun): Promise<void> {
    const session = active.record.session;
    if (!session) return;
    const progress = await readMykgProgress(mykgSessionPaths(this.mykgDir, session).intermediate);
    const counts = active.broker.counts();
    const step = progress.step ?? active.step;
    const value = progress.pass2 ?? (counts.known > 0 ? { done: counts.known - counts.pending - counts.leased, total: counts.known } : null);
    if (step !== active.step || JSON.stringify(value) !== JSON.stringify(active.progress)) {
      active.step = step;
      active.progress = value;
      this.emitStatus();
    }
  }

  private onPoolEvent(active: ActiveRun, event: WorkerPoolEvent): void {
    const state = this.state;
    if (!state) return;
    switch (event.kind) {
      case "worker": {
        const index = state.workers.findIndex((worker) => worker.sessionId === event.record.sessionId);
        if (index >= 0) state.workers[index] = event.record;
        else state.workers.unshift(event.record);
        state.workers = state.workers.slice(0, KNOWLEDGE_RECENT_WORKERS_MAX);
        break;
      }
      case "tokens": {
        active.record.tokensIn += event.in;
        active.record.tokensOut += event.out;
        addTokens(state, this.opts.clock.now(), event.in, event.out);
        break;
      }
      case "paused":
        active.poolPause = { reason: event.reason, message: event.message, resumesAt: event.resumesAt };
        break;
      case "resumed":
        active.poolPause = null;
        break;
      case "error":
        active.stopReason ??= { kind: "error", message: event.message };
        void active.pool.stop();
        active.run.cancel();
        break;
    }
    this.persist();
    this.emitStatus();
  }

  private async finish(active: ActiveRun, result: MykgRunResult): Promise<void> {
    active.progressTimer?.cancel();
    active.progressTimer = null;
    if (active.stopReason?.kind === "detach") {
      active.broker.dispose();
      return;
    }
    const state = this.requireState();
    const record = active.record;
    let outcome: Exclude<KnowledgeRunRecord["outcome"], "running">;
    let error: string | null = null;
    let session: string | null = result.session;
    if (active.stopReason?.kind === "error") {
      outcome = "failed";
      error = active.stopReason.message;
    } else if (active.stopReason?.kind === "cancel" || result.kind === "cancelled") {
      outcome = "cancelled";
    } else if (result.kind === "failed") {
      outcome = "failed";
      error = result.error;
    } else {
      outcome = "ok";
      session = result.session;
    }
    active.broker.finish(outcome === "cancelled" ? "run-cancelled" : "run-finished");
    await active.pool.settle(DEFAULT_TIMINGS.settleMs);
    active.broker.dispose();

    // Only entries still as the run saw them get a verdict; one edited mid-run (it is pending
    // again already — the pending set was emptied when the run started) is linked by the next run.
    // The pending set also catches an edit of the header line (title, author…), which leaves the
    // body's contentHash as it was.
    const changedMeanwhile = new Set(state.pendingEntryIds);
    const existing = record.entryIds.filter((id) => {
      const meta = this.opts.store.getMeta(id);
      return meta !== null && !changedMeanwhile.has(id) && (record.entryHashes[id] === undefined || meta.contentHash === record.entryHashes[id]);
    });
    const editedMeanwhile = record.entryIds.filter((id) => {
      const meta = this.opts.store.getMeta(id);
      return meta !== null && record.entryHashes[id] !== undefined && meta.contentHash !== record.entryHashes[id];
    });
    if (editedMeanwhile.length > 0) {
      state.pendingEntryIds = [...new Set([...state.pendingEntryIds, ...editedMeanwhile])];
      state.pendingSince ??= this.opts.clock.now().toISOString();
    }
    if (outcome === "ok" && session) {
      const paths = mykgSessionPaths(this.mykgDir, session);
      try {
        await this.opts.graph.load(paths.output);
      } catch (loadError) {
        outcome = "failed";
        error = `The graph myKG wrote could not be loaded: ${loadError instanceof Error ? loadError.message : String(loadError)}`;
      }
      if (outcome === "ok") {
        const failed = new Set(await readFailedEntryIds(paths.intermediate));
        // An entry myKG's manifest does not list was never ingested (a resumed full run or rebuild
        // skips ingest): it is not in the graph, so it waits for the next run instead.
        const ingested = await readManifestEntryIds(paths.intermediate);
        const missing = ingested ? existing.filter((id) => !ingested.has(id)) : [];
        if (missing.length > 0) {
          state.pendingEntryIds = [...new Set([...state.pendingEntryIds, ...missing])];
          state.pendingSince ??= this.opts.clock.now().toISOString();
        }
        const inGraph = existing.filter((id) => !missing.includes(id));
        const linked = inGraph.filter((id) => !failed.has(id));
        const notLinked = inGraph.filter((id) => failed.has(id));
        await commitMykgManifest(paths).catch(() => undefined);
        if (linked.length > 0) await this.opts.store.setLinkState(linked, "linked");
        if (notLinked.length > 0) await this.opts.store.setLinkState(notLinked, "failed");
        // Only the entries whose task was shown neighbour context were linked with it.
        const withContext = new Set(record.contextEntryIds ?? []);
        const contextLinked = linked.filter((id) => withContext.has(id));
        if (contextLinked.length > 0) {
          await this.opts.store.setLinkContext(contextLinked, LINK_CONTEXT_VERSION).catch((contextError: unknown) => {
            this.opts.logger?.warn("knowledge linking: the linking-context version could not be recorded", { error: String(contextError) });
          });
        }
        // Each re-link is recorded at its version and content hash (never repeated for the same
        // reason); one whose extraction failed is retried a bounded number of times.
        const batch = new Set(record.relinkEntryIds ?? []);
        const failedSet = new Set(notLinked);
        const givenUp = recordRelinkAttempts(
          state.relink,
          inGraph.filter((id) => batch.has(id)).map((id) => ({ id, contentHash: record.entryHashes[id] ?? this.opts.store.getMeta(id)!.contentHash, failed: failedSet.has(id) }))
        );
        if (givenUp.length > 0) {
          const names = givenUp.map((id) => `"${this.opts.store.getMeta(id)?.title ?? id}"`).join(", ");
          state.lastError = {
            message: `Re-linking with neighbour context failed ${RELINK_RETRIES_MAX + 1} times for ${givenUp.length === 1 ? "an entry" : `${givenUp.length} entries`} (${names}): ${givenUp.length === 1 ? "it is" : "they are"} left out of the graph until edited or rebuilt.`,
            at: this.opts.clock.now().toISOString()
          };
          this.opts.logger?.warn("knowledge linking: re-linking gave up on entries", { entries: givenUp });
        }
        settleRelink(state.relink, inGraph, record.relinkEntryIds ?? [], (id) => this.opts.store.getMeta(id) !== null);
        const previous = state.session;
        state.session = session;
        state.resumeSession = null;
        if (record.mode === "full" || record.mode === "rebuild" || record.mode === "grow-schema") {
          state.schema = { entriesAtChange: this.opts.store.listMeta().length, changedSince: 0 };
        } else {
          // Re-linked entries are not new content: they never count toward schema growth.
          const relinked = record.relinkEntryIds?.length ?? 0;
          state.schema = { ...state.schema, changedSince: state.schema.changedSince + Math.max(0, record.entryIds.length - relinked) };
        }
        state.pause = null;
        if (record.mode === "rebuild" && previous && previous !== session && isMykgSessionName(previous)) {
          // The old session's copy of every entry and its answers are not needed any more.
          await rm(mykgSessionPaths(this.mykgDir, previous).root, { recursive: true, force: true }).catch(() => undefined);
        }
        await this.afterGraphLoad();
      }
    }
    // A re-link batch that did not land stays with the re-linker (`relink.prepared`): its entries keep
    // their link state and the graph they are in, and are neither pending nor failed.
    const relinkOnly = new Set(record.relinkEntryIds ?? []);
    if (outcome === "failed") {
      const failedEntries = existing.filter((id) => !relinkOnly.has(id));
      if (failedEntries.length > 0) await this.opts.store.setLinkState(failedEntries, "failed");
      const at = this.opts.clock.now();
      state.lastError = { message: error ?? "The linking run failed.", at: at.toISOString() };
      state.pause = { reason: "error", message: state.lastError.message, resumesAt: new Date(at.getTime() + DEFAULT_TIMINGS.errorRetryMs).toISOString() };
    }
    if (outcome !== "ok") {
      // Linked by the next run (a rebuild's whole corpus is the next rebuild's again).
      if (record.mode === "rebuild") state.rebuildRequested = true;
      else {
        const pending = new Set([...record.entryIds.filter((id) => !relinkOnly.has(id)), ...state.pendingEntryIds]);
        state.pendingEntryIds = [...pending];
      }
      if (state.pendingEntryIds.length > 0) state.pendingSince ??= this.opts.clock.now().toISOString();
    }
    const finishedAt = this.opts.clock.now();
    const summary: KnowledgeRunRecord = {
      id: record.id,
      mode: record.mode,
      startedAt: record.startedAt,
      finishedAt: finishedAt.toISOString(),
      durationMs: Math.max(0, finishedAt.getTime() - Date.parse(record.startedAt)),
      entries: record.entryIds.length,
      tasks: record.tasks,
      tokensIn: record.tokensIn,
      tokensOut: record.tokensOut,
      outcome,
      error
    };
    resetRelinkWave(state.relink, this.relinkBacklog().length);
    state.recentRuns = [summary, ...state.recentRuns.filter((run) => run.id !== record.id)].slice(0, KNOWLEDGE_RECENT_RUNS_MAX);
    state.workers = state.workers.map((worker) => (worker.runId === record.id && worker.state === "running" ? { ...worker, state: "done", finishedAt: finishedAt.toISOString() } : worker));
    state.currentRun = null;
    await this.stateFile.save(state);
    this.opts.logger?.info?.("knowledge linking: run ended", { runId: record.id, mode: record.mode, outcome, tasks: record.tasks });
  }

  // --- phase 2: re-linking, link gaps, pair checks ----------------------------------------------------

  /** Entries still to re-link (`relink.ts` `relinkBacklog`); none without `graphView`. */
  private relinkBacklog(): string[] {
    const state = this.state;
    const view = this.opts.graphView;
    if (!state || !view) return [];
    const index = view.vectors();
    return relinkBacklog(state.relink, this.opts.store, new Set(state.pendingEntryIds), contextReady(view), (id) => index.entryVector(id) !== null);
  }

  /** A task of the run was shown neighbour context for this entry (`linkContextProvider`): persisted with the run. */
  private contextShown(record: KnowledgeCurrentRunRecord, entryId: string): void {
    const ids = record.contextEntryIds ?? [];
    if (ids.includes(entryId)) return;
    record.contextEntryIds = [...ids, entryId];
    this.persist();
  }

  /**
   * Before a run with a re-link batch spawns its child: drop the batch's manifest keys, clear the
   * cached answers of entries not prepared before, and persist them as prepared (`relink.ts`).
   */
  private async prepareRelink(paths: ReturnType<typeof mykgSessionPaths>, batch: readonly string[], runId: string): Promise<void> {
    const state = this.requireState();
    const prepared = new Set(state.relink.prepared);
    const fresh = new Set(batch.filter((id) => !prepared.has(id)));
    let owns: ((document: string) => boolean) | null = null;
    if (fresh.size > 0) {
      // Every mirror: a task's document belongs to the one entry it is exactly (`context.ts`).
      const locator = new EntryDocumentLocator(this.opts.store);
      await locator.load();
      owns = (document) => {
        const id = locator.locate(document);
        return id !== null && fresh.has(id);
      };
    }
    const cleared = await prepareRelinkBatch(paths, batch, owns);
    state.relink.prepared = [...new Set([...state.relink.prepared, ...batch])];
    await this.stateFile.save(state);
    this.opts.logger?.info?.("knowledge linking: re-linking entries with neighbour context", { runId, entries: batch.length, answersCleared: cleared.length });
  }

  /** After linking loaded a graph: link gaps are queued, and a pair-check round is due. */
  private async afterGraphLoad(): Promise<void> {
    if (!this.opts.graphView) return;
    this.pairRoundDue = true;
    try {
      await this.scanLinkGaps();
    } catch (error) {
      this.opts.logger?.warn("knowledge linking: link gaps could not be found", { error: String(error) });
    }
  }

  /** `findLinkGaps` over every linked entry; both entries of each new pair join the gap queue (`relink.ts`). */
  private async scanLinkGaps(): Promise<void> {
    const view = this.opts.graphView;
    const state = this.state;
    if (!view || !state) return;
    const index = view.vectors();
    const thresholds = index.thresholds();
    if (!thresholds) return;
    const store = this.opts.store;
    const ids = store.listMeta().filter((meta) => meta.linkState === "linked").map((meta) => meta.id);
    const added = await queueLinkGaps(state.relink, {
      ids,
      index,
      conceptsOf: (id) => view.conceptsOf(id).map((concept) => concept.id),
      hashOf: (id) => store.getMeta(id)?.contentHash ?? null,
      minimum: thresholds.strong
    });
    if (added.length > 0) this.opts.logger?.info?.("knowledge linking: link gaps queued for re-linking", { entries: added.length });
    this.persist();
  }

  /** Linking has nothing to do (no run, nothing pending or to re-link, no error): pair checks may use the workers. */
  private idleForPairChecks(): boolean {
    const state = this.state;
    const view = this.opts.graphView;
    return (
      state !== null &&
      view !== undefined &&
      contextReady(view) &&
      this.canRun() &&
      !this.active &&
      !this.starting &&
      !this.launching &&
      this.timer === null &&
      state.session !== null &&
      state.currentRun === null &&
      !state.rebuildRequested &&
      state.pendingEntryIds.length === 0 &&
      state.pause === null &&
      this.relinkBacklog().length === 0
    );
  }

  /** Starts a round of pair checks when one is due and linking is idle (see the module header). */
  private async maybeStartPairRound(): Promise<void> {
    if (!this.pairRoundDue || this.pairRound || this.pairStarting || !this.idleForPairChecks()) return;
    const view = this.opts.graphView!;
    // Vectors are still being computed after a start: wait for the next chance.
    if (view.vectors().embeddedIds().length === 0) return;
    this.pairStarting = true;
    try {
      this.pairRoundDue = false;
      await harvestPairCheckInbox(this.pairInboxDir, this.pairChecks);
      const store = this.opts.store;
      const candidates = await pairCheckCandidates({
        ids: store.listMeta().filter((meta) => meta.linkState === "linked").map((meta) => meta.id),
        view,
        hashOf: (id) => store.getMeta(id)?.contentHash ?? null,
        isChecked: (pair) => this.pairChecks.isChecked(pair),
        limit: PAIR_CHECK_MAX_PER_RUN
      });
      if (candidates.length === 0 || !this.idleForPairChecks()) return;
      const tasks = new Map<string, PairKey>();
      for (const candidate of candidates) {
        const [a, b] = await Promise.all([store.getEntry(candidate.a), store.getEntry(candidate.b)]);
        if (!a || !b || a.contentHash !== candidate.hashA || b.contentHash !== candidate.hashB) continue;
        const pair: PairKey = { a: candidate.a, b: candidate.b, hashA: candidate.hashA, hashB: candidate.hashB };
        tasks.set(await writePairCheckTask(this.pairInboxDir, pair, { a, b }, this.opts.clock.now()), pair);
      }
      if (tasks.size === 0 || !this.idleForPairChecks()) {
        for (const id of tasks.keys()) await removePairCheckTask(this.pairInboxDir, id);
        return;
      }
      await this.startPairRound(tasks);
    } finally {
      this.pairStarting = false;
    }
  }

  private async startPairRound(tasks: Map<string, PairKey>): Promise<void> {
    const broker = new InboxBroker({
      clock: this.opts.clock,
      ...(this.opts.logger ? { logger: this.opts.logger } : {}),
      validate: (step, value) => (step === PAIR_CHECK_STEP ? validatePairCheckAnswer(value) : null)
    });
    const id = `kp_${randomBytes(6).toString("hex")}`;
    let round!: PairRound;
    const pool = new WorkerPool<WorkerCandidate>({
      port: this.opts.workers,
      broker,
      runId: id,
      concurrency: this.opts.settings.get().concurrency,
      clock: this.opts.clock,
      onEvent: (event) => this.onPairPoolEvent(round, event),
      ...(this.opts.logger ? { logger: this.opts.logger } : {})
    });
    round = { id, broker, pool, tasks, ending: false, ended: Promise.resolve() };
    this.pairRound = round;
    broker.events.on("answered", ({ taskId, answer }) => {
      const pair = tasks.get(taskId);
      const parsed = parsePairCheckAnswer(answer);
      if (pair && parsed) {
        void this.pairChecks
          .record(pair, parsed.verdict, parsed.note)
          .then(() => removePairCheckTask(this.pairInboxDir, taskId))
          .catch((error: unknown) => this.opts.logger?.warn("knowledge linking: a pair check could not be recorded", { error: String(error) }));
      }
      const counts = broker.counts();
      if (counts.pending + counts.leased === 0) this.endPairRound(round, { interrupt: false });
    });
    try {
      await broker.attach(this.pairInboxDir);
    } catch (error) {
      this.opts.logger?.warn("knowledge linking: the pair-check inbox could not be watched", { error: String(error) });
      this.endPairRound(round, { interrupt: false });
      return;
    }
    this.opts.logger?.info?.("knowledge linking: pair checks started", { roundId: round.id, pairs: tasks.size });
    pool.reconcile();
    this.emitStatus();
  }

  /**
   * Ends a pair-check round: no task is handed out any more; its chats finish their turn (or are
   * interrupted), then the inbox is cleaned (answers recorded, the rest removed: written again while
   * still worth checking).
   */
  private endPairRound(round: PairRound, options: { interrupt: boolean }): void {
    if (round.ending) {
      if (options.interrupt) void round.pool.stop();
      return;
    }
    round.ending = true;
    round.broker.finish("run-finished");
    const settled = options.interrupt ? round.pool.stop() : round.pool.settle(DEFAULT_TIMINGS.settleMs);
    round.ended = settled
      .then(async () => {
        round.broker.dispose();
        await this.pairChecks.flush();
        await harvestPairCheckInbox(this.pairInboxDir, this.pairChecks);
      })
      .catch((error: unknown) => this.opts.logger?.warn("knowledge linking: ending a pair-check round failed", { error: String(error) }))
      .finally(() => {
        if (this.pairRound === round) this.pairRound = null;
        const state = this.state;
        if (state) {
          const at = this.opts.clock.now().toISOString();
          state.workers = state.workers.map((worker) => (worker.runId === round.id && worker.state === "running" ? { ...worker, state: "done", finishedAt: at } : worker));
          this.persist();
        }
        this.emitStatus();
      });
  }

  private onPairPoolEvent(round: PairRound, event: WorkerPoolEvent): void {
    const state = this.state;
    if (!state) return;
    switch (event.kind) {
      case "worker": {
        const index = state.workers.findIndex((worker) => worker.sessionId === event.record.sessionId);
        if (index >= 0) state.workers[index] = event.record;
        else state.workers.unshift(event.record);
        state.workers = state.workers.slice(0, KNOWLEDGE_RECENT_WORKERS_MAX);
        break;
      }
      case "tokens":
        addTokens(state, this.opts.clock.now(), event.in, event.out);
        break;
      case "paused":
      case "error":
        // Pair checks run only while an account can take them: the round ends, the pairs wait.
        this.endPairRound(round, { interrupt: event.kind === "error" });
        break;
      case "resumed":
        break;
    }
    this.persist();
    this.emitStatus();
  }

  // --- helpers ---------------------------------------------------------------------------------------

  private probe(): MykgProcessProbe {
    return this.opts.processProbe ?? procMykgProbe;
  }

  /** Stops the run's recorded child if a previous daemon left it running (`stopStaleMykg`). */
  private stopStale(record: KnowledgeCurrentRunRecord): Promise<"none" | "stopped" | "alive"> {
    return stopStaleMykg(
      { pid: record.pid, startTime: record.pidStartTime, inputDir: this.opts.store.mykgInputDir },
      { clock: this.opts.clock, probe: this.probe() }
    );
  }

  /** A run that could not start: the error is kept and the run is tried again after `errorRetryMs`. */
  private pauseForError(message: string): void {
    const state = this.requireState();
    const at = this.opts.clock.now();
    state.lastError = { message, at: at.toISOString() };
    state.pause = { reason: "error", message, resumesAt: new Date(at.getTime() + DEFAULT_TIMINGS.errorRetryMs).toISOString() };
    this.persist();
    this.schedule();
    this.emitStatus();
  }

  private requireState(): KnowledgeLinkingStateRecord {
    if (!this.state) throw new Error("The knowledge linking service is not started.");
    return this.state;
  }

  private persist(): void {
    const state = this.state;
    if (!state) return;
    void this.stateFile.save(state).catch((error: unknown) => this.opts.logger?.warn("knowledge linking: state.json could not be written", { error: String(error) }));
  }

  private emitStatus(): void {
    this.events.emit("status");
  }
}

function runningSummary(record: KnowledgeCurrentRunRecord): KnowledgeRunSummary {
  return {
    id: record.id,
    mode: record.mode,
    startedAt: record.startedAt,
    finishedAt: null,
    durationMs: null,
    entries: record.entryIds.length,
    tasks: record.tasks,
    tokensIn: record.tokensIn,
    tokensOut: record.tokensOut,
    outcome: "running",
    error: null
  };
}

function toRunSummary(record: KnowledgeRunRecord): KnowledgeRunSummary {
  return {
    id: record.id,
    mode: record.mode,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    durationMs: record.durationMs,
    entries: record.entries,
    tasks: record.tasks,
    tokensIn: record.tokensIn,
    tokensOut: record.tokensOut,
    outcome: record.outcome,
    error: record.error
  };
}

function toWorkerView(record: KnowledgeWorkerRecord): KnowledgeWorkerView {
  return {
    sessionId: record.sessionId,
    accountId: record.accountId,
    runId: record.runId,
    state: record.state,
    tasks: record.tasks,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt
  };
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addTokens(state: KnowledgeLinkingStateRecord, now: Date, tokensIn: number, tokensOut: number): void {
  state.tokens.total = { in: state.tokens.total.in + tokensIn, out: state.tokens.total.out + tokensOut };
  const key = dayKey(now);
  const day = state.tokens.byDay[key] ?? { in: 0, out: 0 };
  state.tokens.byDay[key] = { in: day.in + tokensIn, out: day.out + tokensOut };
  const keys = Object.keys(state.tokens.byDay).sort();
  for (const old of keys.slice(0, Math.max(0, keys.length - KNOWLEDGE_TOKEN_DAYS_MAX))) delete state.tokens.byDay[old];
}

/** The last 7 UTC days, today included. */
function weekTokens(state: KnowledgeLinkingStateRecord | null, now: Date): { in: number; out: number } {
  const week = { in: 0, out: 0 };
  if (!state) return week;
  for (let i = 0; i < 7; i += 1) {
    const day = state.tokens.byDay[dayKey(new Date(now.getTime() - i * 86_400_000))];
    if (!day) continue;
    week.in += day.in;
    week.out += day.out;
  }
  return week;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
