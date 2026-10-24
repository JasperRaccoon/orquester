/**
 * Agent chat — loading on-demand agent rows (`@orquester/api`'s
 * `agent-rows.ts`): which omitted agents to ask for, on which stream, and
 * what each answer means.
 *
 * A stream opened with `?agentRows=on-demand` may get a snapshot that leaves
 * out the settled agents' own rows (`slice.omittedAgentIds`). An agent is
 * asked for — `POST …/agent-rows` naming the stream's `synchronized.streamId`,
 * batched, at most `AGENT_ROWS_MAX_AGENTS` a request — while it is omitted
 * and:
 *
 * - a drill-in of it is open ({@link AgentRowsLoader.want}), or
 * - it is live again: the roster shows it at work (`activeAgentIds`), or a
 *   live event of its own arrived ({@link AgentRowsLoader.touch}) — a resumed
 *   or relaunched agent always gets its whole rows.
 *
 * The rows come back on the stream itself, as one `agent-rows` frame in order
 * with its events; the reducer applies it and the agent leaves the omitted
 * set. Nothing is asked before the stream is live, and everything asked is
 * forgotten when the stream changes (a reconnect: its new snapshot says
 * what is omitted now, a replay keeps what was), so a drill-in still open is
 * asked for again on the new stream.
 *
 * Answers: 404 `STREAM_NOT_FOUND` — that stream is gone; asked again on the
 * next one. A lost answer or a 503 — asked again after a backoff. Anything
 * else — above all the route miss of a daemon or host from before the route —
 * and the store stops asking and reads the thread whole
 * ({@link AgentRowsLoaderDeps.onUnsupported}): a drill-in never waits for
 * good.
 *
 * No React import, no store: `store.ts` feeds it the slice and frames.
 */

import { AGENT_ROWS_MAX_AGENTS, type AgentRowsRequest } from "@orquester/api/agent-chat";

import { backoffDelayMs } from "../connection/backoff";

/** What the loader reads off the thread's state at each step. */
export interface AgentRowsView {
  /** `slice.omittedAgentIds`. */
  readonly omitted: readonly string[] | undefined;
  /** The live stream's id (`synchronized.streamId`), null without one. */
  readonly streamId: string | null;
  /** The stream is live (`synchronized`): its frames are in order from here. */
  readonly live: boolean;
  /** The roster's agents at work (`messageStreamingContext(...).activeAgentIds`). */
  readonly activeAgentIds: ReadonlySet<string>;
}

/** How a failed request ended, as {@link AgentRowsLoader} reads it. */
export interface AgentRowsFailure {
  readonly status?: number;
  readonly code?: string;
  readonly retryable?: boolean;
}

export interface AgentRowsLoaderDeps {
  /** `POST …/agent-rows`; rejects with the §6.2 error (`AgentChatCommandError`). */
  request(body: AgentRowsRequest): Promise<unknown>;
  /** The route is unknown to the daemon or host: stop asking, and have every row. */
  onUnsupported(): void;
  /**
   * The stream is live, rows are omitted, and it has no id to ask on — a
   * host that predates on-demand rows answered a resume of a copy that has
   * them (a device copy, a retained one). Its rows can only come whole: the
   * store re-reads the thread. Called once per loader.
   */
  onNoStream(): void;
  /** Defaults to `setTimeout`; for tests. */
  schedule?(run: () => void, delayMs: number): () => void;
  /** Defaults to a microtask; for tests. */
  defer?(run: () => void): void;
}

const RETRY_POLICY = { baseMs: 1_000, maxMs: 15_000 };

export class AgentRowsLoader {
  private readonly wanted = new Map<string, number>();
  /** Live events of these omitted agents arrived; asked for until they load. */
  private readonly touched = new Set<string>();
  /** Asked for on {@link stream}, not landed yet. */
  private readonly requested = new Set<string>();
  /** Refused on {@link stream}: not asked again until the stream changes. */
  private readonly refused = new Set<string>();
  private stream: string | null = null;
  private view: AgentRowsView | null = null;
  private flushQueued = false;
  private retryAttempt = 0;
  private cancelRetry: (() => void) | null = null;
  private closed = false;
  private unsupported = false;
  private noStreamReported = false;

  constructor(private readonly deps: AgentRowsLoaderDeps) {}

  /** Whether streams should opt in: false once the route proved unknown. */
  get enabled(): boolean {
    return !this.unsupported && !this.closed;
  }

  /** A drill-in of `agentId` is open; the release closes it. */
  want(agentId: string): () => void {
    this.wanted.set(agentId, (this.wanted.get(agentId) ?? 0) + 1);
    this.resync();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (this.wanted.get(agentId) ?? 1) - 1;
      if (count > 0) this.wanted.set(agentId, count);
      else this.wanted.delete(agentId);
    };
  }

  /** Whether a drill-in of `agentId` is open. */
  isWanted(agentId: string): boolean {
    return this.wanted.has(agentId);
  }

  /** Live events of these agents arrived (only the omitted ones matter). */
  touch(agentIds: Iterable<string>): void {
    for (const agentId of agentIds) this.touched.add(agentId);
  }

  /** `agent-rows` frames the reducer could not apply (older than the fold): ask again. */
  dropped(agentIds: Iterable<string>): void {
    for (const agentId of agentIds) this.requested.delete(agentId);
  }

  /** Read the thread's state after a step, and ask for what it now needs. */
  sync(view: AgentRowsView): void {
    if (this.closed) return;
    this.view = view;
    if (view.streamId !== this.stream) {
      this.stream = view.streamId;
      this.requested.clear();
      this.refused.clear();
      this.retryAttempt = 0;
      this.cancelRetry?.();
      this.cancelRetry = null;
    }
    const omitted = new Set(view.omitted ?? []);
    for (const set of [this.touched, this.requested, this.refused]) {
      for (const agentId of set) if (!omitted.has(agentId)) set.delete(agentId);
    }
    if (omitted.size === 0 || !view.live || this.unsupported) return;
    if (view.streamId === null) {
      if (!this.noStreamReported) {
        this.noStreamReported = true;
        this.deps.onNoStream();
      }
      return;
    }
    if (this.due().length > 0 && !this.flushQueued) {
      this.flushQueued = true;
      (this.deps.defer ?? queueMicrotask)(() => {
        this.flushQueued = false;
        this.flush();
      });
    }
  }

  close(): void {
    this.closed = true;
    this.cancelRetry?.();
    this.cancelRetry = null;
  }

  private resync(): void {
    if (this.view !== null) this.sync(this.view);
  }

  /** The omitted agents to ask for now. */
  private due(): string[] {
    const view = this.view;
    if (view === null) return [];
    const due: string[] = [];
    for (const agentId of view.omitted ?? []) {
      if (this.requested.has(agentId) || this.refused.has(agentId)) continue;
      if (this.wanted.has(agentId) || this.touched.has(agentId) || view.activeAgentIds.has(agentId)) {
        due.push(agentId);
      }
    }
    return due;
  }

  private flush(): void {
    const view = this.view;
    if (this.closed || this.unsupported || view === null || !view.live || view.streamId === null) return;
    const streamId = view.streamId;
    const due = this.due();
    for (let start = 0; start < due.length; start += AGENT_ROWS_MAX_AGENTS) {
      const agentIds = due.slice(start, start + AGENT_ROWS_MAX_AGENTS);
      for (const agentId of agentIds) this.requested.add(agentId);
      void this.deps.request({ streamId, agentIds }).then(
        () => {
          if (this.stream === streamId) this.retryAttempt = 0;
        },
        (error: unknown) => this.failed(streamId, agentIds, error as AgentRowsFailure | null)
      );
    }
  }

  private failed(streamId: string, agentIds: readonly string[], error: AgentRowsFailure | null): void {
    if (this.closed || this.stream !== streamId) return;
    for (const agentId of agentIds) this.requested.delete(agentId);
    const status = error?.status;
    const code = error?.code;
    if (status === 404 && code === "STREAM_NOT_FOUND") {
      // That stream is gone: its successor's `synchronized` brings a new id.
      for (const agentId of agentIds) this.refused.add(agentId);
      return;
    }
    if (error?.retryable === true || status === 503 || status === 0) {
      const delay = backoffDelayMs(this.retryAttempt, RETRY_POLICY);
      this.retryAttempt = Math.min(this.retryAttempt + 1, 16);
      this.cancelRetry?.();
      const schedule =
        this.deps.schedule ??
        ((run: () => void, ms: number) => {
          const timer = setTimeout(run, ms);
          return () => clearTimeout(timer);
        });
      this.cancelRetry = schedule(() => {
        this.cancelRetry = null;
        this.resync();
      }, delay);
      return;
    }
    // A daemon or host from before the route (its route miss), or a refusal no
    // retry changes: the rows can only come whole, and a drill-in must never
    // wait on them for good.
    this.unsupported = true;
    this.deps.onUnsupported();
  }
}
