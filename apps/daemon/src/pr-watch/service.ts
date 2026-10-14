/**
 * Pull request watches — the daemon service (spec 2026-10-14 §5 "PR watch").
 *
 * A chat thread's agent asks to watch a pull request (`watch_pull_request`, through the
 * `routes.ts` routes). The service reads it through the thread project's git-host account
 * (`AccountsService.pullRequestStatus`, the same provider seam and credential resolution as the
 * workflow git trigger), every two minutes (Bitbucket Cloud three; an anonymous GitHub read ten,
 * as those share 60 requests an hour), with exponential backoff on a failure and the host's own
 * wait on a rate limit. Every thread watching one pull request through one account shares a read.
 *
 * News — a check failing, the checks passing, someone else's comment or review, a new conflict,
 * a merge or a close — becomes ONE concise message to the thread (`evaluate.ts`), sent through
 * the ordinary `/turn` route only while the thread is idle: a busy thread's news waits, and the
 * wait coalesces (the told state only moves when a wake is sent, so the next idle point reports
 * the pull request as it is then). A wake is persisted with its `commandId` BEFORE it is posted
 * and re-posted under the same id until it lands, so the host's command receipts deliver it once
 * across restarts. One wake per idle point: after a send, the next waits until the thread's latest
 * turn has moved on.
 *
 * Watches end on merge, close, `unwatch_pull_request` or the GUI's stop, after
 * `PULL_REQUEST_WATCH_READ_FAILURE_LIMIT` failed reads in a row, after
 * `PULL_REQUEST_WATCH_WAKE_LIMIT` comment-only wakes in a row, and when the thread is deleted.
 * An ended watch disappears from the list at once; its record stays only until its last message
 * is delivered.
 *
 * Persisted in `pr-watches.json` (`@orquester/config`, tolerant; 0600, tmp + rename). No
 * credential is stored, logged or returned: reads resolve the account per pass, and a failed
 * read is described in a few credential-free words.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { EventMessage, SessionSummary } from "@orquester/api";
import {
  agentChatCommandPath,
  MAX_PR_WATCHES_PER_THREAD,
  type CreatePullRequestWatchRequest,
  type CreatePullRequestWatchResponse,
  type PullRequestWatchErrorCode,
  type PullRequestWatchesChangedEvent,
  type PullRequestWatchSummary
} from "@orquester/api/agent-chat";
import {
  parsePullRequestWatchFile,
  serializePullRequestWatchFile,
  type PullRequestWatchFile,
  type PullRequestWatchRecord,
  type PullRequestWatchStatusRecord
} from "@orquester/config";

import type { DaemonApi } from "../mcp/daemon-api.ts";
import type { PullRequestStatus, PullRequestStatusOptions } from "../providers/types.ts";
import type { Clock, WorkflowLogger } from "../workflows/contracts.ts";
import { parseRemoteUrl, redactUrlUserinfo, repoKeyOf } from "../workflows/git-remote/index.ts";
import {
  evaluatePullRequestWatch,
  initialTold,
  isFailedCheck,
  PULL_REQUEST_WATCH_READ_FAILURE_LIMIT,
  pullRequestWakeMessage,
  type PullRequestWakeSection
} from "./evaluate.ts";
import { parsePullRequestUrl, targetInRemote, type PullRequestTarget } from "./target.ts";

const REST_POLL_MS = 120_000;
const BITBUCKET_CLOUD_POLL_MS = 180_000;
/** Anonymous GitHub reads share 60 requests an hour per IP; one read is about six. */
const ANONYMOUS_GITHUB_POLL_MS = 600_000;
const POLL_JITTER = 0.1;
const MAX_BACKOFF_MS = 15 * 60_000;
/** A provider's Retry-After is honoured up to this. */
const MAX_RETRY_AFTER_MS = 60 * 60_000;
/** The service looks for due reads and undelivered wakes this often. */
const TICK_MS = 30_000;
/** The first tick after a start, so a restart does not read every pull request at once. */
const FIRST_TICK_MS = 5_000;
/** Reads run at most this many at a time. */
const READ_CONCURRENCY = 4;
/**
 * A read that has not answered by then counts as a timed-out read: the provider fetches carry no
 * deadline of their own, and one hung read must not hold every later pass.
 */
const READ_TIMEOUT_MS = 90_000;
/** A wake refused this many times (for a passing reason) is given up. */
const MAX_WAKE_ATTEMPTS = 3;
/** After a send, the next wake waits for the thread's latest turn to move on — or this long. */
const SENT_TURN_GRACE_MS = 5 * 60_000;

export interface PullRequestWatchRead {
  status: PullRequestStatus;
  /** The reading account's own logins (its comments are never news); empty when anonymous. */
  viewer: string[];
}

export type WakeDelivery =
  | { kind: "sent" }
  /** The host is restarting: keep the wake, try again. */
  | { kind: "unavailable" }
  /** The thread is gone. */
  | { kind: "gone" }
  | { kind: "refused"; retryable: boolean; message: string };

export interface PullRequestWatchServiceDeps {
  /** `pullRequestWatchesPath(appdir)`. */
  file: string;
  read(input: { accountId: string | null; repoUrl: string; number: number } & PullRequestStatusOptions): Promise<PullRequestWatchRead>;
  /** The project's `origin` URL (credential-free), or null. */
  projectRemote(projectPath: string): Promise<string | null>;
  /** The project's workspace git account, or null (anonymous reads). */
  projectAccount(projectPath: string): Promise<string | null>;
  /** The tab record, with the chat fields (status, latest turn, pending requests, goal). */
  session(id: string): SessionSummary | undefined;
  /** The daemon's event bus (`sessions` channel): idle points and closed tabs. */
  subscribe(listener: (event: EventMessage) => void): () => void;
  /** POST the thread's `/turn` with this body (the normal send path). */
  deliver(sessionId: string, body: { commandId: string; input: string }): Promise<WakeDelivery>;
  publish(event: PullRequestWatchesChangedEvent): void;
  clock: Clock;
  logger: WorkflowLogger;
  mintId?: () => string;
  random?: () => number;
}

export class PullRequestWatchError extends Error {
  constructor(
    readonly status: number,
    readonly code: PullRequestWatchErrorCode,
    message: string
  ) {
    super(message);
    this.name = "PullRequestWatchError";
  }
}

export interface PullRequestWatchService {
  start(): Promise<void>;
  /** Cancels the timers; work in flight finishes. */
  stop(): void;
  /** The thread's live watches, oldest first. Throws THREAD_NOT_FOUND for an unknown thread. */
  list(sessionId: string): PullRequestWatchSummary[];
  create(sessionId: string, request: CreatePullRequestWatchRequest): Promise<CreatePullRequestWatchResponse>;
  /** Throws WATCH_NOT_FOUND when the thread has no such live watch. */
  remove(sessionId: string, watchId: string): Promise<void>;
  /** One pass now: due reads, then undelivered wakes (tests; the timer runs it in production). */
  tick(): Promise<void>;
  /** Resolves once nothing is in flight (tests). */
  idle(): Promise<void>;
}

/**
 * Whether the thread can take a wake now: a chat tab with no turn running or starting, no open
 * approval or question, no continuing goal (it starts turns by itself), and not in error (a
 * `/turn` would be refused).
 */
export function acceptsWake(summary: SessionSummary | undefined): boolean {
  if (!summary || summary.kind !== "agent-chat") return false;
  const status = summary.chatSessionStatus;
  if (status === "running" || status === "starting" || status === "error") return false;
  const turn = summary.latestTurn;
  if (turn && (turn.state === "running" || turn.state === "pending")) return false;
  if (summary.hasPendingApprovals === true || summary.hasPendingUserInput === true) return false;
  return summary.goal?.continuing !== true;
}

function turnKey(summary: SessionSummary): string {
  const turn = summary.latestTurn;
  return turn ? `${turn.turnId ?? ""}|${turn.startedAt ?? ""}|${turn.state}` : "";
}

/** A short, credential-free reason for a failed read: "auth rejected", "not found", … */
export function describeReadError(error: unknown): string {
  const kind = (error as { kind?: unknown } | null)?.kind;
  switch (kind) {
    case "auth":
      return "auth rejected";
    case "missing_scope":
      return "the token lacks a scope to read pull requests";
    case "rate_limited":
      return "rate limited";
    case "not_found":
      return "not found";
    case "timeout":
      return "timed out";
    case "unsupported":
      return error instanceof Error ? error.message.slice(0, 300) : "unsupported";
    default: {
      const message = error instanceof Error ? error.message : String(error);
      const flat = redactUrlUserinfo(message).replace(/\s+/g, " ").trim();
      return flat.length > 300 ? `${flat.slice(0, 299)}…` : flat || "read failed";
    }
  }
}

function digest(status: PullRequestStatus): PullRequestWatchStatusRecord {
  const failed = status.checks.filter(isFailedCheck).length;
  const pending = status.checks.filter((check) => check.status === "pending").length;
  return {
    state: status.state,
    title: status.title,
    headSha: status.headSha,
    baseBranch: status.baseBranch,
    mergeability: status.mergeability,
    checks: { total: status.checks.length, failed, pending, passed: status.checks.length - failed - pending }
  };
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, content, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);
}

export function createPullRequestWatchService(deps: PullRequestWatchServiceDeps): PullRequestWatchService {
  const { clock, logger } = deps;
  const mintId = deps.mintId ?? randomUUID;
  const random = deps.random ?? Math.random;

  let file: PullRequestWatchFile = { watches: [], unreadable: [] };
  /** The last good read of each live watch: what an idle point evaluates. Memory only. */
  const lastReads = new Map<string, PullRequestWatchRead>();
  /** When each live watch is next read (epoch ms). Memory only: a restart reads each once. */
  const nextReadAt = new Map<string, number>();
  /** Per thread, the latest turn when a wake was last sent. */
  const sentTurn = new Map<string, { key: string; at: number }>();
  const lanes = new Map<string, Promise<void>>();
  const published = new Map<string, string>();
  const inflight = new Set<Promise<unknown>>();
  let writes: Promise<void> = Promise.resolve();
  let timer: { cancel(): void } | null = null;
  let unsubscribe: (() => void) | null = null;
  let ticking: Promise<void> | null = null;
  let stopped = false;

  const now = () => clock.now().getTime();
  const nowIso = () => clock.now().toISOString();
  const live = (watch: PullRequestWatchRecord) => watch.endedAt === null;
  const watchesOf = (sessionId: string) => file.watches.filter((watch) => watch.sessionId === sessionId);

  function track<T>(promise: Promise<T>): Promise<T> {
    inflight.add(promise);
    void promise.finally(() => inflight.delete(promise)).catch(() => undefined);
    return promise;
  }

  function persist(): Promise<void> {
    const body = serializePullRequestWatchFile(file);
    writes = writes
      .then(() => writeAtomic(deps.file, body))
      .catch((error: unknown) => {
        logger.error("pr watch: could not save the watches", { error: error instanceof Error ? error.message : String(error) });
      });
    return writes;
  }

  function hasHeldNews(watch: PullRequestWatchRecord): boolean {
    const read = lastReads.get(watch.id);
    if (!read || !live(watch)) return false;
    if (read.status.state !== "open") return true;
    return evaluatePullRequestWatch(watch.told, read.status, read.status.remarks, read.viewer).changes.length > 0;
  }

  function summaryOf(watch: PullRequestWatchRecord): PullRequestWatchSummary {
    const status = watch.lastStatus;
    return {
      id: watch.id,
      sessionId: watch.sessionId,
      repository: watch.repository,
      number: watch.number,
      url: watch.url,
      title: status?.title ?? "",
      startedAt: watch.startedAt,
      lastCheckedAt: watch.lastCheckedAt,
      status: status
        ? { state: status.state, mergeability: status.mergeability, headSha: status.headSha, baseBranch: status.baseBranch, checks: { ...status.checks } }
        : null,
      lastError: watch.lastError,
      wakePending: watch.pendingWake !== null || hasHeldNews(watch)
    };
  }

  function liveSummaries(sessionId: string): PullRequestWatchSummary[] {
    return watchesOf(sessionId).filter(live).map(summaryOf);
  }

  /** Tell every client the thread's list, when it changed since the last time. */
  function publish(sessionId: string): void {
    const watches = liveSummaries(sessionId);
    const body = JSON.stringify(watches);
    if (published.get(sessionId) === body) return;
    if (watches.length === 0) published.delete(sessionId);
    else published.set(sessionId, body);
    deps.publish({ sessionId, watches });
  }

  function lane(sessionId: string, work: () => Promise<void>): Promise<void> {
    const previous = lanes.get(sessionId) ?? Promise.resolve();
    const next = previous.then(work).catch((error: unknown) => {
      logger.error("pr watch: thread work failed", { sessionId, error: error instanceof Error ? error.message : String(error) });
    });
    lanes.set(sessionId, next);
    void next.finally(() => {
      if (lanes.get(sessionId) === next) lanes.delete(sessionId);
    });
    return track(next);
  }

  function forget(watchId: string): void {
    lastReads.delete(watchId);
    nextReadAt.delete(watchId);
  }

  /** The thread is gone: its watches go with it, undelivered wakes included. */
  async function dropThread(sessionId: string): Promise<void> {
    const gone = watchesOf(sessionId);
    if (gone.length === 0) return;
    for (const watch of gone) forget(watch.id);
    file = { ...file, watches: file.watches.filter((watch) => watch.sessionId !== sessionId) };
    sentTurn.delete(sessionId);
    logger.info("pr watch: thread deleted, its watches ended", { sessionId, count: gone.length });
    await persist();
    publish(sessionId);
  }

  // -------------------------------------------------------------------------
  // Waking a thread
  // -------------------------------------------------------------------------

  function awaitingSentTurn(sessionId: string, summary: SessionSummary): boolean {
    const sent = sentTurn.get(sessionId);
    if (!sent) return false;
    if (turnKey(summary) !== sent.key || now() - sent.at >= SENT_TURN_GRACE_MS) {
      sentTurn.delete(sessionId);
      return false;
    }
    return true;
  }

  function wakeThread(sessionId: string): Promise<void> {
    return lane(sessionId, () => wakeNow(sessionId));
  }

  async function wakeNow(sessionId: string): Promise<void> {
    if (stopped) return;
    const watches = watchesOf(sessionId);
    if (watches.length === 0) return;
    const summary = deps.session(sessionId);
    if (!summary) {
      await dropThread(sessionId);
      return;
    }
    if (!acceptsWake(summary) || awaitingSentTurn(sessionId, summary)) return;

    // A wake already persisted goes first, under its own id.
    const pending = watches
      .filter((watch) => watch.pendingWake !== null)
      .sort((a, b) => a.pendingWake!.createdAt.localeCompare(b.pendingWake!.createdAt))[0];
    if (pending) {
      await deliver(sessionId, pending.pendingWake!.commandId, summary);
      return;
    }

    const sections: PullRequestWakeSection[] = [];
    /** The watches this wake speaks for: each carries it until it lands. */
    const involved: PullRequestWatchRecord[] = [];
    const apply: Array<() => void> = [];
    const at = nowIso();
    for (const watch of watches) {
      if (!live(watch)) {
        // An end not told yet (merged, closed, unreadable): its last message.
        const end =
          watch.endReason === "merged" || watch.endReason === "closed"
            ? ({ kind: watch.endReason } as const)
            : watch.endReason === "unreadable"
              ? ({ kind: "unreadable", reason: watch.lastError ?? "read failed" } as const)
              : null;
        if (end) {
          sections.push({ kind: "ended", number: watch.number, url: watch.url, end });
          involved.push(watch);
        }
        continue;
      }
      const read = lastReads.get(watch.id);
      if (!read || read.status.state !== "open") continue;
      const report = evaluatePullRequestWatch(watch.told, read.status, read.status.remarks, read.viewer);
      if (report.changes.length === 0) continue;
      sections.push({ kind: "update", number: watch.number, url: watch.url, report, baseBranch: read.status.baseBranch, headSha: report.next.headSha });
      involved.push(watch);
      apply.push(() => {
        watch.told = report.next;
        if (report.exhausted) {
          watch.endedAt = at;
          watch.endReason = "comment-limit";
          forget(watch.id);
        }
      });
    }
    if (sections.length === 0) {
      // An ended watch with nothing left to say (its last word was given up) is dropped.
      const done = watches.filter((watch) => !live(watch));
      if (done.length > 0) {
        file = { ...file, watches: file.watches.filter((watch) => !done.includes(watch)) };
        await persist();
      }
      return;
    }
    const wake = { commandId: `pr-watch:${mintId()}`, input: pullRequestWakeMessage(sections), createdAt: at, attempts: 0 };
    for (const step of apply) step();
    for (const watch of involved) watch.pendingWake = { ...wake };
    // Persisted BEFORE the post: a crash after it re-posts the same id, which the host dedupes.
    await persist();
    publish(sessionId);
    await deliver(sessionId, wake.commandId, summary);
  }

  async function deliver(sessionId: string, commandId: string, summary: SessionSummary): Promise<void> {
    const holders = () => file.watches.filter((watch) => watch.sessionId === sessionId && watch.pendingWake?.commandId === commandId);
    const first = holders()[0];
    if (!first) return;
    const result = await deps.deliver(sessionId, { commandId, input: first.pendingWake!.input });
    if (result.kind === "unavailable") return;
    if (result.kind === "gone") {
      await dropThread(sessionId);
      return;
    }
    if (result.kind === "sent") {
      sentTurn.set(sessionId, { key: turnKey(summary), at: now() });
      settle(holders());
    } else {
      const attempts = first.pendingWake!.attempts + 1;
      if (!result.retryable || attempts >= MAX_WAKE_ATTEMPTS) {
        logger.warn("pr watch: the thread refused a wake; dropped", { sessionId, commandId, reason: result.message });
        settle(holders());
      } else {
        for (const watch of holders()) watch.pendingWake = { ...watch.pendingWake!, attempts };
      }
    }
    await persist();
    publish(sessionId);
  }

  /** A wake is done with: clear it, and drop the ended watches it was the last word of. */
  function settle(holders: PullRequestWatchRecord[]): void {
    for (const watch of holders) watch.pendingWake = null;
    const done = new Set(holders.filter((watch) => !live(watch)));
    if (done.size > 0) file = { ...file, watches: file.watches.filter((watch) => !done.has(watch)) };
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  function intervalFor(repoUrl: string, accountId: string | null): number {
    const host = parseRemoteUrl(repoUrl)?.host;
    if (host === "bitbucket.org") return BITBUCKET_CLOUD_POLL_MS;
    if (host === "github.com" && accountId === null) return ANONYMOUS_GITHUB_POLL_MS;
    return REST_POLL_MS;
  }

  const jitter = (ms: number) => Math.round(ms * (1 + (random() * 2 - 1) * POLL_JITTER));

  function readWithDeadline(input: Parameters<PullRequestWatchServiceDeps["read"]>[0]): Promise<PullRequestWatchRead> {
    return new Promise((resolve, reject) => {
      const timer = clock.setTimeout(() => reject(Object.assign(new Error("The read timed out."), { kind: "timeout" })), READ_TIMEOUT_MS);
      deps.read(input).then(
        (value) => {
          timer.cancel();
          resolve(value);
        },
        (error: unknown) => {
          timer.cancel();
          reject(error);
        }
      );
    });
  }

  async function accountOf(projectPath: string, cache: Map<string, Promise<string | null>>): Promise<string | null> {
    let pending = cache.get(projectPath);
    if (!pending) {
      pending = deps.projectAccount(projectPath).catch(() => null);
      cache.set(projectPath, pending);
    }
    return pending;
  }

  async function readGroup(members: PullRequestWatchRecord[], accountId: string | null): Promise<void> {
    const head = members[0]!;
    const since = members.map((watch) => watch.told.remarksThrough).sort()[0];
    const interval = intervalFor(head.repoUrl, accountId);
    let read: PullRequestWatchRead;
    try {
      read = await readWithDeadline({ accountId, repoUrl: head.repoUrl, number: head.number, ...(since ? { remarksSince: since } : {}) });
    } catch (error) {
      const reason = describeReadError(error);
      const rateLimited = (error as { kind?: unknown } | null)?.kind === "rate_limited";
      const hinted = (error as { retryAfterMs?: unknown } | null)?.retryAfterMs;
      const retryAfter = typeof hinted === "number" && hinted > 0 ? Math.min(hinted, MAX_RETRY_AFTER_MS) : 0;
      const sessions = new Set<string>();
      for (const member of members) {
        const watch = file.watches.find((candidate) => candidate === member && live(candidate));
        if (!watch) continue;
        watch.lastError = reason;
        // A rate limit is the host asking to wait, not a sign the pull request cannot be read.
        if (!rateLimited) watch.failures += 1;
        const backoff = rateLimited ? interval : Math.min(MAX_BACKOFF_MS, interval * 2 ** watch.failures);
        nextReadAt.set(watch.id, now() + Math.max(jitter(backoff), retryAfter));
        if (!rateLimited && watch.failures >= PULL_REQUEST_WATCH_READ_FAILURE_LIMIT) {
          watch.endedAt = nowIso();
          watch.endReason = "unreadable";
          forget(watch.id);
          logger.info("pr watch: ended, unreadable", { sessionId: watch.sessionId, repository: watch.repository, number: watch.number, reason });
        }
        sessions.add(watch.sessionId);
      }
      logger.warn("pr watch: read failed", { repository: head.repository, number: head.number, reason });
      await persist();
      for (const sessionId of sessions) {
        publish(sessionId);
        void wakeThread(sessionId);
      }
      return;
    }

    const sessions = new Set<string>();
    const at = nowIso();
    for (const member of members) {
      // A stop or a delete that landed during the read wins.
      const watch = file.watches.find((candidate) => candidate === member && live(candidate));
      if (!watch) continue;
      watch.failures = 0;
      watch.lastError = null;
      watch.lastCheckedAt = at;
      watch.lastStatus = digest(read.status);
      if (read.status.url) watch.url = read.status.url;
      sessions.add(watch.sessionId);
      if (read.status.state !== "open") {
        // Ended: no more reads. The thread hears it at its next idle point.
        watch.endedAt = at;
        watch.endReason = read.status.state;
        forget(watch.id);
        logger.info("pr watch: ended", { sessionId: watch.sessionId, repository: watch.repository, number: watch.number, reason: read.status.state });
        continue;
      }
      lastReads.set(watch.id, read);
      nextReadAt.set(watch.id, now() + jitter(interval));
      const report = evaluatePullRequestWatch(watch.told, read.status, read.status.remarks, read.viewer);
      // Progress with nothing to tell (a push, a rerun, the remark watermark) is recorded now;
      // news waits for the thread's idle point, unmoved, so a busy thread's news coalesces.
      if (report.changes.length === 0) watch.told = report.next;
    }
    await persist();
    for (const sessionId of sessions) {
      publish(sessionId);
      void wakeThread(sessionId);
    }
  }

  async function runTick(): Promise<void> {
    // Wakes the host could not take last time (restarting) are tried again after the reads; a
    // thread a read of this pass wakes is not posted twice.
    const retry = new Set(file.watches.filter((watch) => watch.pendingWake !== null || !live(watch)).map((watch) => watch.sessionId));
    // Watches of deleted threads end.
    for (const sessionId of new Set(file.watches.map((watch) => watch.sessionId))) {
      if (!deps.session(sessionId)) await dropThread(sessionId);
    }
    const due = file.watches.filter((watch) => live(watch) && (nextReadAt.get(watch.id) ?? 0) <= now());
    const accounts = new Map<string, Promise<string | null>>();
    const groups = new Map<string, { accountId: string | null; members: PullRequestWatchRecord[] }>();
    for (const watch of due) {
      const accountId = await accountOf(watch.projectPath, accounts);
      const key = `${repoKeyOf(watch.repoUrl) ?? watch.repoUrl}#${watch.number}|${accountId ?? "anonymous"}`;
      const group = groups.get(key) ?? { accountId, members: [] };
      group.members.push(watch);
      groups.set(key, group);
    }
    const queue = [...groups.values()];
    const workers = Array.from({ length: Math.min(READ_CONCURRENCY, queue.length) }, async () => {
      for (let group = queue.shift(); group !== undefined && !stopped; group = queue.shift()) {
        await readGroup(group.members, group.accountId);
      }
    });
    await Promise.all(workers);
    for (const sessionId of retry) {
      if (watchesOf(sessionId).some((watch) => watch.pendingWake !== null || !live(watch))) void wakeThread(sessionId);
    }
  }

  function tick(): Promise<void> {
    if (ticking) return ticking;
    ticking = track(
      runTick()
        .catch((error: unknown) => {
          logger.error("pr watch: pass failed", { error: error instanceof Error ? error.message : String(error) });
        })
        .finally(() => {
          ticking = null;
        })
    );
    return ticking;
  }

  function schedule(ms: number): void {
    timer?.cancel();
    timer = null;
    if (stopped) return;
    timer = clock.setTimeout(() => {
      timer = null;
      void tick().finally(() => schedule(TICK_MS));
    }, ms);
  }

  function onEvent(event: EventMessage): void {
    if (stopped || event.channel !== "sessions") return;
    const id = (event.payload as { id?: unknown } | null)?.id;
    if (typeof id !== "string" || !file.watches.some((watch) => watch.sessionId === id)) return;
    if (event.type === "session.closed") {
      void lane(id, () => dropThread(id));
    } else if (event.type === "session.updated" || event.type === "session.exited") {
      void wakeThread(id);
    }
  }

  // -------------------------------------------------------------------------
  // Creating and stopping
  // -------------------------------------------------------------------------

  function requireThread(sessionId: string): SessionSummary {
    const summary = deps.session(sessionId);
    if (!summary || summary.kind !== "agent-chat") {
      throw new PullRequestWatchError(404, "THREAD_NOT_FOUND", "No chat thread with that id.");
    }
    return summary;
  }

  async function resolveTarget(summary: SessionSummary, request: CreatePullRequestWatchRequest): Promise<PullRequestTarget> {
    const hasUrl = typeof request.url === "string" && request.url.trim().length > 0;
    const hasNumber = request.number !== undefined && request.number !== null;
    if (hasUrl === hasNumber) {
      throw new PullRequestWatchError(400, "INVALID_ARGUMENT", "Pass either url (the pull request's web URL) or number, not both.");
    }
    if (hasUrl) {
      const target = parsePullRequestUrl(request.url!);
      if (!target) {
        throw new PullRequestWatchError(
          400,
          "INVALID_ARGUMENT",
          "That is not a pull request URL Orquester recognises (GitHub …/pull/<n>, Bitbucket …/pull-requests/<n>). Pass the URL of the pull request's page, or its number."
        );
      }
      return target;
    }
    if (typeof request.number !== "number" || !Number.isSafeInteger(request.number) || request.number <= 0) {
      throw new PullRequestWatchError(400, "INVALID_ARGUMENT", "number must be a positive whole number.");
    }
    const remote = summary.projectPath ? await deps.projectRemote(summary.projectPath).catch(() => null) : null;
    const target = remote ? targetInRemote(remote, request.number) : null;
    if (!target) {
      throw new PullRequestWatchError(409, "NO_REMOTE", "This thread's project has no recognised origin remote. Pass the pull request's URL instead.");
    }
    return target;
  }

  async function create(sessionId: string, request: CreatePullRequestWatchRequest): Promise<CreatePullRequestWatchResponse> {
    const summary = requireThread(sessionId);
    const projectPath = summary.projectPath ?? "";
    if (!projectPath) throw new PullRequestWatchError(409, "NO_REMOTE", "This thread has no project, so it has no repository to read.");
    const target = await resolveTarget(summary, request);
    const same = (watch: PullRequestWatchRecord) =>
      watch.sessionId === sessionId && live(watch) && watch.number === target.number && repoKeyOf(watch.repoUrl) === target.repoKey;
    const existing = file.watches.find(same);
    if (existing) return { watch: summaryOf(existing), created: false };
    if (watchesOf(sessionId).filter(live).length >= MAX_PR_WATCHES_PER_THREAD) {
      throw new PullRequestWatchError(
        409,
        "WATCH_LIMIT",
        `This thread already watches ${MAX_PR_WATCHES_PER_THREAD} pull requests. Call unwatch_pull_request for one first.`
      );
    }

    const accountId = await deps.projectAccount(projectPath).catch(() => null);
    const startedAt = nowIso();
    let read: PullRequestWatchRead | null = null;
    let note: string | undefined;
    try {
      read = await readWithDeadline({ accountId, repoUrl: target.repoUrl, number: target.number, remarksSince: startedAt });
    } catch (error) {
      const kind = (error as { kind?: unknown } | null)?.kind;
      if (kind === "not_found") {
        throw new PullRequestWatchError(404, "PULL_REQUEST_NOT_FOUND", `Pull request #${target.number} was not found in ${target.repository} (or this project's git account cannot see it).`);
      }
      const status = (error as { status?: unknown } | null)?.status;
      // A refusal that will not pass by itself: the token, its scope, a host the account does not
      // cover — or an account error without a kind (the workspace names a deleted account).
      const lasting = kind === undefined && typeof status === "number" && status >= 400 && status < 500 && status !== 429;
      if (kind === "auth" || kind === "missing_scope" || kind === "unsupported" || lasting) {
        throw new PullRequestWatchError(400, "PULL_REQUEST_UNREADABLE", `Orquester cannot read pull request #${target.number} in ${target.repository}: ${describeReadError(error)}.`);
      }
      // A passing failure (rate limit, timeout, the host down): watch without a baseline.
      note = `Could not read the pull request just now (${describeReadError(error)}); the first successful check reports its current checks.`;
    }
    if (read && read.status.state !== "open") {
      throw new PullRequestWatchError(409, "PULL_REQUEST_NOT_OPEN", `Pull request #${target.number} is ${read.status.state}, so there is nothing to watch.`);
    }
    // A concurrent create of the same pull request may have landed during the read.
    const raced = file.watches.find(same);
    if (raced) return { watch: summaryOf(raced), created: false };

    const watch: PullRequestWatchRecord = {
      id: mintId(),
      sessionId,
      projectPath,
      repoUrl: target.repoUrl,
      repository: target.repository,
      number: target.number,
      url: read?.status.url ?? "",
      startedAt,
      // The baseline: what the call's answer shows now is not news later. Only remarks after the
      // call count.
      told: read
        ? evaluatePullRequestWatch(initialTold(startedAt), read.status, [], read.viewer).next
        : initialTold(startedAt),
      lastStatus: read ? digest(read.status) : null,
      lastCheckedAt: read ? startedAt : null,
      lastError: null,
      failures: 0,
      pendingWake: null,
      endedAt: null,
      endReason: null
    };
    file = { ...file, watches: [...file.watches, watch] };
    if (read) {
      lastReads.set(watch.id, read);
      nextReadAt.set(watch.id, now() + jitter(intervalFor(target.repoUrl, accountId)));
    }
    await persist();
    publish(sessionId);
    logger.info("pr watch: started", { sessionId, repository: watch.repository, number: watch.number });
    return { watch: summaryOf(watch), created: true, ...(note ? { note } : {}) };
  }

  async function remove(sessionId: string, watchId: string): Promise<void> {
    requireThread(sessionId);
    const watch = file.watches.find((candidate) => candidate.id === watchId && candidate.sessionId === sessionId && live(candidate));
    if (!watch) throw new PullRequestWatchError(404, "WATCH_NOT_FOUND", "This thread has no such pull request watch.");
    forget(watch.id);
    file = { ...file, watches: file.watches.filter((candidate) => candidate !== watch) };
    await persist();
    publish(sessionId);
    logger.info("pr watch: stopped", { sessionId, repository: watch.repository, number: watch.number });
  }

  async function load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(deps.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.error("pr watch: could not read the watches", { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    try {
      file = parsePullRequestWatchFile(JSON.parse(raw) as unknown);
    } catch {
      // Not JSON at all: kept aside, never overwritten.
      const aside = `${deps.file}.unreadable-${Date.now()}`;
      await rename(deps.file, aside).catch(() => undefined);
      logger.error("pr watch: the watches file was not JSON; kept aside", { file: aside });
    }
  }

  return {
    async start() {
      stopped = false;
      await load();
      unsubscribe = deps.subscribe(onEvent);
      for (const sessionId of new Set(file.watches.map((watch) => watch.sessionId))) void wakeThread(sessionId);
      schedule(FIRST_TICK_MS + Math.round(random() * FIRST_TICK_MS));
    },
    stop() {
      stopped = true;
      timer?.cancel();
      timer = null;
      unsubscribe?.();
      unsubscribe = null;
    },
    list(sessionId) {
      requireThread(sessionId);
      return liveSummaries(sessionId);
    },
    create: (sessionId, request) => track(create(sessionId, request)),
    remove: (sessionId, watchId) => track(lane(sessionId, async () => undefined).then(() => remove(sessionId, watchId))),
    tick,
    async idle() {
      for (;;) {
        const pending = [...inflight, writes];
        await Promise.allSettled(pending);
        if (inflight.size === 0 && pending.at(-1) === writes) return;
      }
    }
  };
}

/**
 * The normal send path: the thread's own `/turn` route through the daemon's in-process API, so
 * every gate the GUI meets applies, and the host's receipts make a re-post under the same
 * `commandId` a no-op. A 503 (host restarting) keeps the wake; a 404 is a deleted thread; a 409
 * `COMMAND_REJECTED` / `COMPACTION_UNAVAILABLE` is a refusal of the moment.
 */
export function deliverThroughTurnRoute(api: () => DaemonApi | null): PullRequestWatchServiceDeps["deliver"] {
  return async (sessionId, body) => {
    const client = api();
    if (!client) return { kind: "unavailable" };
    let res: { status: number; body: unknown };
    try {
      res = await client.request("POST", agentChatCommandPath(sessionId, "turn"), {
        body: { commandId: body.commandId, input: body.input, interactionMode: "default" }
      });
    } catch {
      return { kind: "unavailable" };
    }
    if (res.status < 400) return { kind: "sent" };
    const error = (res.body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
    const code = typeof error?.code === "string" ? error.code : "";
    if (res.status === 503 || code === "HOST_UNAVAILABLE") return { kind: "unavailable" };
    if (res.status === 404) return { kind: "gone" };
    return {
      kind: "refused",
      retryable: res.status === 409 && (code === "COMMAND_REJECTED" || code === "COMPACTION_UNAVAILABLE"),
      message: typeof error?.message === "string" ? error.message.slice(0, 500) : `The thread answered ${res.status}.`
    };
  };
}

const metaText = (meta?: Record<string, unknown>): string => {
  if (!meta) return "";
  try {
    return ` ${JSON.stringify(meta)}`;
  } catch {
    return "";
  }
};

/** The daemon's log lines for watches (never a credential: only ids, repositories, reasons). */
export const consolePullRequestWatchLogger: WorkflowLogger = {
  debug() {},
  info: (msg, meta) => console.log(`[pr-watch] ${msg}${metaText(meta)}`),
  warn: (msg, meta) => console.warn(`[pr-watch] ${msg}${metaText(meta)}`),
  error: (msg, meta) => console.error(`[pr-watch] ${msg}${metaText(meta)}`)
};
