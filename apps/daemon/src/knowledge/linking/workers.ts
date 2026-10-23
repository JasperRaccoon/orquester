/**
 * Knowledge Graph linking — the worker chats that answer myKG's inbox (spec "Indexing on the
 * subscription").
 *
 * Every LLM call myKG needs is answered inside an ordinary Orquester agent chat running the real
 * Claude Code CLI on one of the user's accounts — never a proxy, a gateway or a raw completion.
 * The pool runs up to `concurrency` of them for one linking run:
 *
 * - it starts a chat only when the inbox has a task no running chat will pick up
 *   (`InboxBroker.demand`), so an empty inbox costs nothing;
 * - each chat loops through the two worker tools inside ONE turn and ends it when the broker says
 *   `done` (its budget, or the run ended); the pool then closes it and starts a fresh one while
 *   tasks remain — the cost per task stays flat;
 * - a chat that hits a usage limit (or a refused sign-in) cools its account down through the
 *   workflow Agent block's failover (`workflows/agent/failover.ts`) and the next start picks
 *   another account; when no account is left the pool pauses until the earliest reset
 *   (`resumesAt`) and says so;
 * - a chat that ends or fails has its lease released, so another chat answers its task;
 * - repeated failures to start or run a chat (no task answered) stop the pool with an error.
 *
 * The chats themselves are behind {@link WorkerSessionPort} (`daemon-workers.ts`: the daemon's
 * own session create, the same way the Agent block creates its chats); tests use a fake.
 */

import type { KnowledgeWorkerRecord } from "@orquester/config";
import type { Clock } from "../../workflows/contracts.ts";
import { emptyMemory, type FailoverMemory } from "../../workflows/agent/failover.ts";
import type { InboxBroker } from "./inbox.ts";

/** The account (and model) one worker chat runs on. Opaque to the pool. */
export interface WorkerCandidate {
  accountId: string;
  accountLabel?: string;
  model: string;
}

export type WorkerPick<C extends WorkerCandidate = WorkerCandidate> =
  | { kind: "chosen"; candidate: C }
  | { kind: "none"; reason: "usage-limit" | "no-account"; resumesAt: string | null; message: string };

export type WorkerOutcome =
  /** The chat's turn ended normally (the broker told it `done`). */
  | { kind: "done" }
  /** The account ran out (or its sign-in was refused): fail over. */
  | { kind: "limit"; reason: "usage_limit" | "auth"; resetsAt?: string; message: string }
  | { kind: "failed"; message: string }
  | { kind: "closed" }
  | { kind: "cancelled" };

/** Thrown by `start` when no account can help (e.g. the indexer profile cannot be prepared). */
export class WorkerStartError extends Error {
  constructor(
    message: string,
    /** `fatal`: every start would fail the same way — the pool stops with this error. */
    readonly fatal: boolean
  ) {
    super(message);
    this.name = "WorkerStartError";
  }
}

export interface WorkerSessionPort<C extends WorkerCandidate = WorkerCandidate> {
  /** The account to start the next chat on (failover-aware: `memory` is the run's). */
  pick(memory: FailoverMemory): Promise<WorkerPick<C>>;
  /** Creates the chat and sends its first turn. Throws {@link WorkerStartError}. */
  start(input: { candidate: C; runId: string; memory: FailoverMemory }): Promise<{ sessionId: string }>;
  /** Until the chat's work ends (or `signal` aborts: `cancelled`). */
  watch(sessionId: string, signal: AbortSignal): Promise<WorkerOutcome>;
  /** Cools the candidate's account down after a limit (shared with the workflows). */
  coolDown(candidate: C, memory: FailoverMemory, outcome: Extract<WorkerOutcome, { kind: "limit" }>): Promise<void>;
  /** Tokens the chat's turns used (provider-reported; 0 when unknown). */
  usage(sessionId: string): Promise<{ in: number; out: number }>;
  /** Ends the chat: interrupts its turn when asked, then closes the tab. Never throws. */
  stop(sessionId: string, options: { interrupt: boolean }): Promise<void>;
  /** A chat from before a restart still has a turn running (it may ask for work again). */
  isRunning(sessionId: string): Promise<boolean>;
}

export type WorkerPoolEvent =
  | { kind: "worker"; record: KnowledgeWorkerRecord }
  | { kind: "tokens"; sessionId: string; in: number; out: number }
  | { kind: "paused"; reason: "usage-limit" | "no-account"; resumesAt: string | null; message: string }
  | { kind: "resumed" }
  | { kind: "error"; message: string };

export interface WorkerPoolOptions<C extends WorkerCandidate = WorkerCandidate> {
  port: WorkerSessionPort<C>;
  broker: InboxBroker;
  runId: string;
  concurrency: number;
  clock: Clock;
  onEvent: (event: WorkerPoolEvent) => void;
  /** Wait before trying again after a start failed, or with no account and no known reset (5 min). */
  retryMs?: number;
  /** Chats in a row that ended or failed without answering a task before the pool gives up (3). */
  maxConsecutiveFailures?: number;
  logger?: { warn(message: string, meta?: Record<string, unknown>): void };
}

interface Worker<C> {
  record: KnowledgeWorkerRecord;
  candidate: C | null;
  abort: AbortController;
}

const DEFAULT_RETRY_MS = 5 * 60_000;
const START_RETRY_MS = 5_000;

export class WorkerPool<C extends WorkerCandidate = WorkerCandidate> {
  private readonly workers = new Map<string, Worker<C>>();
  private readonly memory: FailoverMemory = emptyMemory();
  private starting = 0;
  private concurrency: number;
  private stopped = false;
  private failed = false;
  private failures = 0;
  private paused: { until: { cancel(): void } } | null = null;
  private retry: { cancel(): void } | null = null;
  private readonly idleWaiters = new Set<() => void>();
  private readonly offBroker: () => void;

  constructor(private readonly options: WorkerPoolOptions<C>) {
    this.concurrency = options.concurrency;
    const onChange = (): void => this.reconcile();
    options.broker.events.on("change", onChange);
    this.offBroker = () => options.broker.events.off("change", onChange);
  }

  /** Worker chats running or starting. */
  get size(): number {
    return this.workers.size + this.starting;
  }

  isPaused(): boolean {
    return this.paused !== null;
  }

  setConcurrency(concurrency: number): void {
    this.concurrency = concurrency;
    this.reconcile();
  }

  /** Chats a previous daemon process started for this run: watched again when still working, else closed. */
  async adopt(records: readonly KnowledgeWorkerRecord[]): Promise<void> {
    for (const record of records) {
      if (record.runId !== this.options.runId || record.state !== "running" || this.workers.has(record.sessionId)) continue;
      let running = false;
      try {
        running = await this.options.port.isRunning(record.sessionId);
      } catch {
        running = false;
      }
      if (!running || this.stopped) {
        await this.options.port.stop(record.sessionId, { interrupt: false });
        this.emitWorker({ ...record, state: "done", finishedAt: this.now() });
        continue;
      }
      this.options.broker.register(record.sessionId);
      const worker: Worker<C> = { record: { ...record }, candidate: null, abort: new AbortController() };
      this.workers.set(record.sessionId, worker);
      void this.watchWorker(worker);
    }
    this.reconcile();
  }

  /** Starts chats while tasks wait for one (see the module header). */
  reconcile(): void {
    const broker = this.options.broker;
    if (this.stopped || this.failed || this.paused || this.retry || broker.isFinished) return;
    const { pending, waiting } = broker.counts();
    let unengaged = this.starting;
    for (const id of this.workers.keys()) if (!broker.engaged(id)) unengaged += 1;
    const wanted = pending - waiting - unengaged;
    const room = this.concurrency - this.size;
    for (let i = 0; i < Math.min(wanted, room); i += 1) void this.startOne();
  }

  /** Resolves once no chat runs or starts, or after `timeoutMs` (then the rest are stopped). */
  settle(timeoutMs: number): Promise<void> {
    if (this.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = this.options.clock.setTimeout(() => {
        this.idleWaiters.delete(done);
        void this.stop().then(resolve);
      }, timeoutMs);
      const done = (): void => {
        timer.cancel();
        resolve();
      };
      this.idleWaiters.add(done);
    });
  }

  /** Ends every chat (interrupted, closed) and starts no more. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.offBroker();
    this.paused?.until.cancel();
    this.paused = null;
    this.retry?.cancel();
    this.retry = null;
    const ending = [...this.workers.values()].map(async (worker) => {
      worker.abort.abort();
      this.options.broker.release(worker.record.sessionId);
      await this.options.port.stop(worker.record.sessionId, { interrupt: true });
      await this.finishWorker(worker, "done");
    });
    await Promise.all(ending);
  }

  /**
   * The daemon is stopping: stop watching and starting, but leave the chats alone — they live in
   * the agent host, and the next start adopts them (`adopt`).
   */
  detach(): void {
    this.stopped = true;
    this.offBroker();
    this.paused?.until.cancel();
    this.paused = null;
    this.retry?.cancel();
    this.retry = null;
    for (const worker of this.workers.values()) worker.abort.abort();
    this.workers.clear();
    this.checkIdle();
  }

  // --- internals ---------------------------------------------------------------------------------

  private now(): string {
    return this.options.clock.now().toISOString();
  }

  private async startOne(): Promise<void> {
    this.starting += 1;
    let sessionId: string | null = null;
    let candidate: C | null = null;
    try {
      const pick = await this.options.port.pick(this.memory);
      if (pick.kind === "none") {
        this.pause(pick);
        return;
      }
      candidate = pick.candidate;
      if (this.stopped) return;
      ({ sessionId } = await this.options.port.start({ candidate, runId: this.options.runId, memory: this.memory }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.logger?.warn("knowledge workers: a worker chat could not be started", { message });
      if (error instanceof WorkerStartError && error.fatal) {
        this.fail(message);
        return;
      }
      this.failures += 1;
      if (this.failures >= this.maxFailures()) {
        this.fail(`Worker chats could not be started: ${message}`);
        return;
      }
      this.scheduleRetry(START_RETRY_MS);
      return;
    } finally {
      this.starting -= 1;
      if (sessionId === null) this.checkIdle();
    }
    if (this.stopped) {
      await this.options.port.stop(sessionId, { interrupt: true });
      return;
    }
    this.options.broker.register(sessionId);
    const worker: Worker<C> = {
      record: { sessionId, accountId: candidate.accountId, runId: this.options.runId, state: "running", tasks: 0, startedAt: this.now(), finishedAt: null },
      candidate,
      abort: new AbortController()
    };
    this.workers.set(sessionId, worker);
    this.emitWorker(worker.record);
    void this.watchWorker(worker);
  }

  private async watchWorker(worker: Worker<C>): Promise<void> {
    const { port, broker } = this.options;
    const sessionId = worker.record.sessionId;
    let outcome: WorkerOutcome;
    try {
      outcome = await port.watch(sessionId, worker.abort.signal);
    } catch (error) {
      outcome = { kind: "failed", message: error instanceof Error ? error.message : String(error) };
    }
    if (outcome.kind === "cancelled" || !this.workers.has(sessionId)) return; // `stop` ends it
    broker.release(sessionId);
    const answered = broker.tasksOf(sessionId) > 0;
    if (outcome.kind === "limit") {
      if (worker.candidate) await port.coolDown(worker.candidate, this.memory, outcome).catch(() => undefined);
      await port.stop(sessionId, { interrupt: true });
    } else {
      await port.stop(sessionId, { interrupt: outcome.kind !== "done" });
    }
    // A chat that answered something proves the setup works; one that failed without doing so counts.
    if (answered) this.failures = 0;
    else if (outcome.kind === "failed" || outcome.kind === "closed") this.failures += 1;
    await this.finishWorker(worker, outcome.kind === "done" || outcome.kind === "limit" ? "done" : "failed");
    if (this.failures >= this.maxFailures()) {
      this.fail(outcome.kind === "failed" ? `Worker chats keep failing: ${outcome.message}` : "Worker chats keep ending without answering a task.");
      return;
    }
    this.reconcile();
  }

  private async finishWorker(worker: Worker<C>, state: "done" | "failed"): Promise<void> {
    const sessionId = worker.record.sessionId;
    if (!this.workers.delete(sessionId)) return;
    const tokens = await this.options.port.usage(sessionId).catch(() => ({ in: 0, out: 0 }));
    if (tokens.in > 0 || tokens.out > 0) this.options.onEvent({ kind: "tokens", sessionId, ...tokens });
    this.emitWorker({ ...worker.record, state, tasks: this.options.broker.tasksOf(sessionId), finishedAt: this.now() });
    this.checkIdle();
  }

  private emitWorker(record: KnowledgeWorkerRecord): void {
    this.options.onEvent({ kind: "worker", record: { ...record } });
  }

  private pause(pick: Extract<WorkerPick, { kind: "none" }>): void {
    if (this.paused || this.stopped) return;
    const resumesMs = pick.resumesAt ? Date.parse(pick.resumesAt) : Number.NaN;
    const wait = Number.isFinite(resumesMs) ? Math.max(1_000, resumesMs - this.options.clock.now().getTime()) : this.options.retryMs ?? DEFAULT_RETRY_MS;
    const until = this.options.clock.setTimeout(() => {
      this.paused = null;
      this.options.onEvent({ kind: "resumed" });
      this.reconcile();
    }, wait);
    this.paused = { until };
    this.options.onEvent({ kind: "paused", reason: pick.reason, resumesAt: pick.resumesAt, message: pick.message });
  }

  private scheduleRetry(ms: number): void {
    if (this.retry || this.stopped) return;
    this.retry = this.options.clock.setTimeout(() => {
      this.retry = null;
      this.reconcile();
    }, ms);
  }

  private fail(message: string): void {
    if (this.failed) return;
    this.failed = true;
    this.options.onEvent({ kind: "error", message });
  }

  private maxFailures(): number {
    return this.options.maxConsecutiveFailures ?? 3;
  }

  private checkIdle(): void {
    if (this.size !== 0) return;
    const waiters = [...this.idleWaiters];
    this.idleWaiters.clear();
    for (const wake of waiters) wake();
  }
}
