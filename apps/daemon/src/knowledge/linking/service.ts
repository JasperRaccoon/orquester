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
 * - A daemon restart re-runs an interrupted run under the same id (a survivor child is stopped
 *   first): `--update` resumes from myKG's finished steps, cached shards and answered tasks; a
 *   full/rebuild run resumes its session. Worker chats still working are adopted. Every update
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
 * keeps waiting on its inbox — its task timeout is 48 h), `error` (a failed run, retried later).
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
import { InboxBroker, type InboxWatch } from "./inbox.ts";
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
import { startMykgRun, stopStaleMykg, type MykgRun, type MykgRunResult, type SpawnMykg } from "./runner.ts";
import { LinkingStateFile } from "./state.ts";
import { WorkerPool, type WorkerCandidate, type WorkerPoolEvent, type WorkerSessionPort } from "./workers.ts";

export const GROW_MIN_ENTRIES = 20;
export const GROW_RATIO = 0.5;

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
  /** Run ids (`kr_` + 12 hex by default). */
  mintId?: () => string;
  spawn?: SpawnMykg;
  timings?: Partial<typeof DEFAULT_TIMINGS>;
  /** Worker chat budget (`inbox.ts` `DEFAULT_SESSION_BUDGET`). */
  sessionBudget?: { tasks: number; tokens: number };
  /** `InboxBroker` long-poll (`DEFAULT_NEXT_WAIT_MS`). */
  nextWaitMs?: number;
  /** `null` = rescans on demand only (tests). */
  inboxWatch?: InboxWatch | null;
  /** Reads a pid's command line (stale-child check); tests stub it. */
  readCmdline?: (pid: number) => Promise<string | null>;
  logger?: KnowledgeLinkingLogger;
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
}

export class KnowledgeLinkingService implements KnowledgeLinkingPort {
  readonly events = new EventEmitter<KnowledgeLinkingEvents>();
  private readonly opts: KnowledgeLinkingOptions;
  private readonly timings: typeof DEFAULT_TIMINGS;
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
  private stopped = false;
  /** Changes reported before `start` loaded the state. */
  private early: KnowledgeEntryChange[] = [];
  private readonly offs: (() => void)[] = [];

  constructor(options: KnowledgeLinkingOptions) {
    this.opts = options;
    this.timings = { ...DEFAULT_TIMINGS, ...options.timings };
    this.stateFile = new LinkingStateFile(knowledgeStatePath(options.appdir), () => options.clock.now());
    this.mykgDir = knowledgeMykgDir(options.appdir);
    this.homeDir = knowledgeMykgHomeDir(options.appdir);
    this.workersDir = knowledgeWorkersDir(options.appdir);
  }

  // --- lifecycle -------------------------------------------------------------------------------

  /** Loads `state.json`, loads the recorded graph, resumes an interrupted run or schedules one. */
  async start(): Promise<void> {
    this.stopped = false;
    this.state = await this.stateFile.load();
    for (const change of this.early.splice(0)) this.entriesChanged(change);
    this.offs.push(this.opts.settings.onChange(() => this.onEnvironmentChanged()));
    this.offs.push(this.opts.runtime.onChange(() => this.onEnvironmentChanged()));
    const session = this.state.session;
    if (session && isMykgSessionName(session)) {
      const paths = mykgSessionPaths(this.mykgDir, session);
      if (await exists(paths.nodes)) {
        await this.opts.graph.load(paths.output).catch((error: unknown) => {
          this.opts.logger?.warn("knowledge linking: the recorded graph could not be loaded", { error: String(error) });
        });
      }
    }
    const current = this.state.currentRun;
    if (current) {
      await stopStaleMykg(current.pid, this.opts.readCmdline);
      if (this.canRun()) await this.launch(current, { resume: true });
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
  }

  // --- KnowledgeLinkingPort --------------------------------------------------------------------

  entriesChanged(change: KnowledgeEntryChange): void {
    if (change.kind === "relabelled" || change.entryIds.length === 0) return;
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
    const pendingEntries = state?.pendingEntryIds.length ?? 0;
    if (!this.opts.settings.enabled()) {
      return { state: "paused", reason: "plugin-off", message: "The Knowledge Graph plugin is off.", resumesAt: null, pendingEntries };
    }
    if (!this.opts.runtime.current()) {
      return { state: "paused", reason: "not-installed", message: "myKG is not installed.", resumesAt: null, pendingEntries };
    }
    const active = this.active;
    if (active) {
      if (active.poolPause) return { state: "paused", ...active.poolPause, pendingEntries };
      return { state: "running", runId: active.record.id, mode: active.record.mode, step: active.step, progress: active.progress, pendingEntries };
    }
    if (state?.pause) {
      return { state: "paused", reason: state.pause.reason, message: state.pause.message, resumesAt: state.pause.resumesAt, pendingEntries };
    }
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

  /** Expected myKG tasks for a rebuild (information only; spec "Schema growth"). */
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
    // Pass 1: one call per 16k-token batch, at most 25 proposals, then harmonize + review;
    // name normalization: one call per ~16k tokens of names (about one per 40 entries).
    const pass1 = Math.min(25, Math.max(1, Math.ceil(total / 16_000))) + 2;
    const normalize = Math.max(1, Math.ceil(entries.length / 40));
    return { entries: entries.length, tasks: pass1 + pass2 + normalize };
  }

  // --- worker protocol ---------------------------------------------------------------------------

  /** The session is a worker chat of the run in flight (its owner names that run). */
  isActiveWorker(owner: SessionOwner | undefined): boolean {
    return owner?.kind === "knowledge-indexer" && this.active !== null && owner.runId === this.active.record.id;
  }

  workerNext(sessionId: string, signal?: AbortSignal): Promise<KnowledgeWorkerNextResponse> {
    const active = this.active;
    if (!active) return Promise.resolve({ kind: "done", reason: "run-finished" });
    return active.broker.next(sessionId, signal);
  }

  workerSubmit(sessionId: string, taskId: string, answer: string, signal?: AbortSignal): Promise<KnowledgeWorkerSubmitResponse> {
    const active = this.active;
    if (!active) return Promise.resolve({ accepted: false, error: "No linking run is in flight; end your turn." });
    return active.broker.submit(sessionId, taskId, answer, signal);
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
      lastError: state?.lastError ? { message: state.lastError.message, at: state.lastError.at } : null
    };
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
    return !this.stopped && this.opts.settings.enabled() && this.opts.runtime.current() !== null;
  }

  private onEnvironmentChanged(): void {
    if (this.stopped) return;
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
      at = Math.min(last + this.timings.debounceMs, Number.isFinite(first) ? first + this.timings.maxWaitMs : last + this.timings.debounceMs);
    } else {
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
    if (!state || this.active || this.starting || !this.canRun()) return;
    if (state.pause?.reason === "error") state.pause = null;
    const mode = this.nextMode();
    if (mode === null) {
      this.emitStatus();
      return;
    }
    this.starting = true;
    try {
      const metas = this.opts.store.listMeta();
      const all = metas.map((entry) => entry.id);
      const now = this.opts.clock.now().toISOString();
      const resumable = (mode === "full" || mode === "rebuild") && state.resumeSession && isMykgSessionName(state.resumeSession) ? state.resumeSession : null;
      const record: KnowledgeCurrentRunRecord = {
        id: this.mintRunId(),
        mode,
        startedAt: now,
        session: mode === "update" || mode === "grow-schema" ? state.session : resumable,
        entryIds: mode === "full" || mode === "rebuild" ? all : [...state.pendingEntryIds],
        entryHashes: {},
        tasks: 0,
        tokensIn: 0,
        tokensOut: 0,
        pid: null
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
        else state.pendingEntryIds = [...new Set([...record.entryIds, ...state.pendingEntryIds])];
        state.pendingSince ??= now;
        state.lastError = { message, at: at.toISOString() };
        state.pause = { reason: "error", message, resumesAt: new Date(at.getTime() + this.timings.errorRetryMs).toISOString() };
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
    if (state.pendingEntryIds.length === 0) return null;
    const changed = state.schema.changedSince + state.pendingEntryIds.length;
    const threshold = Math.max(GROW_MIN_ENTRIES, Math.ceil(GROW_RATIO * state.schema.entriesAtChange));
    return changed >= threshold ? "grow-schema" : "update";
  }

  private mintRunId(): string {
    return this.opts.mintId?.() ?? `kr_${randomBytes(6).toString("hex")}`;
  }

  // --- a run ---------------------------------------------------------------------------------------

  private async launch(record: KnowledgeCurrentRunRecord, options: { resume: boolean }): Promise<void> {
    const state = this.requireState();
    const runtime = this.opts.runtime.current();
    if (!runtime || this.active) return;
    // A record that names no session cannot update one: it extracts in full.
    if ((record.mode === "update" || record.mode === "grow-schema") && !record.session) record.mode = "full";
    const settings = this.opts.settings.get();
    await mkdir(this.mykgDir, { recursive: true, mode: 0o700 });
    await mkdir(join(this.homeDir, "tmp"), { recursive: true, mode: 0o700 });
    await mkdir(this.workersDir, { recursive: true, mode: 0o700 });
    await writeMykgConfig(this.mykgDir, { concurrency: settings.concurrency, model: settings.model });
    // An update after one that did not succeed starts from the last good run's manifest (`guardMykgManifest`).
    if ((record.mode === "update" || record.mode === "grow-schema") && record.session && isMykgSessionName(record.session)) {
      await guardMykgManifest(mykgSessionPaths(this.mykgDir, record.session));
    }

    const broker = new InboxBroker({
      clock: this.opts.clock,
      ...(this.opts.sessionBudget ? { budget: this.opts.sessionBudget } : {}),
      ...(this.opts.nextWaitMs !== undefined ? { nextWaitMs: this.opts.nextWaitMs } : {}),
      ...(this.opts.inboxWatch !== undefined ? { watch: this.opts.inboxWatch } : {}),
      ...(this.opts.logger ? { logger: this.opts.logger } : {})
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
    const run = startMykgRun(
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
    }, this.timings.progressMs);
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
    await active.pool.settle(this.timings.settleMs);
    active.broker.dispose();

    // Only entries still as the run saw them get a verdict; one edited mid-run (it is pending
    // again already) is linked by the next run.
    const existing = record.entryIds.filter((id) => {
      const meta = this.opts.store.getMeta(id);
      return meta !== null && (record.entryHashes[id] === undefined || meta.contentHash === record.entryHashes[id]);
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
        const previous = state.session;
        state.session = session;
        state.resumeSession = null;
        if (record.mode === "full" || record.mode === "rebuild" || record.mode === "grow-schema") {
          state.schema = { entriesAtChange: this.opts.store.listMeta().length, changedSince: 0 };
        } else {
          state.schema = { ...state.schema, changedSince: state.schema.changedSince + record.entryIds.length };
        }
        state.pause = null;
        if (record.mode === "rebuild" && previous && previous !== session && isMykgSessionName(previous)) {
          // The old session's copy of every entry and its answers are not needed any more.
          await rm(mykgSessionPaths(this.mykgDir, previous).root, { recursive: true, force: true }).catch(() => undefined);
        }
      }
    }
    if (outcome === "failed") {
      if (existing.length > 0) await this.opts.store.setLinkState(existing, "failed");
      const at = this.opts.clock.now();
      state.lastError = { message: error ?? "The linking run failed.", at: at.toISOString() };
      state.pause = { reason: "error", message: state.lastError.message, resumesAt: new Date(at.getTime() + this.timings.errorRetryMs).toISOString() };
    }
    if (outcome !== "ok") {
      // Linked by the next run (a rebuild's whole corpus is the next rebuild's again).
      if (record.mode === "rebuild") state.rebuildRequested = true;
      else {
        const pending = new Set([...record.entryIds, ...state.pendingEntryIds]);
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
    state.recentRuns = [summary, ...state.recentRuns.filter((run) => run.id !== record.id)].slice(0, KNOWLEDGE_RECENT_RUNS_MAX);
    state.workers = state.workers.map((worker) => (worker.runId === record.id && worker.state === "running" ? { ...worker, state: "done", finishedAt: finishedAt.toISOString() } : worker));
    state.currentRun = null;
    await this.stateFile.save(state);
    this.opts.logger?.info?.("knowledge linking: run ended", { runId: record.id, mode: record.mode, outcome, tasks: record.tasks });
  }

  // --- helpers ---------------------------------------------------------------------------------------

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
