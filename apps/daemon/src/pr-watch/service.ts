/**
 * Pull request watches — the daemon service (spec 2026-10-14 §5 "PR watch").
 *
 * A chat thread's agent asks to watch a pull request (`watch_pull_request`, through the
 * `routes.ts` routes). The service reads it through the thread project's git-host account
 * (`AccountsService.pullRequestStatus`, the same provider seam and credential resolution as the
 * workflow git trigger), every two minutes (Bitbucket Cloud three; an anonymous GitHub read ten,
 * as those share 60 requests an hour), with exponential backoff on a failure and the host's own
 * wait on a rate limit. Every thread watching one pull request through one account shares a read;
 * one host + account's reads run one after another in their own lane, which a pass starts but never
 * waits for (a read has a 45 s deadline).
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
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { EventMessage, SessionSummary } from "@orquester/api";
import {
  agentChatCommandPath,
  agentChatRoutes,
  MAX_PR_WATCHES_PER_THREAD,
  type CreatePullRequestWatchRequest,
  type CreatePullRequestWatchResponse,
  type PullRequestWatchErrorCode,
  type PullRequestWatchListQuery,
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
  composeWake,
  renderWakeSection,
  type PullRequestWakePart,
  type PullRequestWakeSection
} from "./evaluate.ts";
import { parsePullRequestUrl, targetInRemote, type PullRequestTarget } from "./target.ts";

const REST_POLL_MS = 120_000;
const BITBUCKET_CLOUD_POLL_MS = 180_000;
/** Anonymous GitHub reads share 60 requests an hour per IP; one read is about six. */
const ANONYMOUS_POLL_MS = 600_000;
const POLL_JITTER = 0.1;
const MAX_BACKOFF_MS = 15 * 60_000;
/** A provider's Retry-After is honoured up to this. */
const MAX_RETRY_AFTER_MS = 60 * 60_000;
/** The service looks for due reads and undelivered wakes this often. */
const TICK_MS = 30_000;
/** The first tick after a start, so a restart does not read every pull request at once. */
const FIRST_TICK_MS = 5_000;
/**
 * A read that has not answered by then counts as a timed-out read: the provider fetches carry no
 * deadline of their own, and one hung read must not hold every later pass.
 */
const READ_TIMEOUT_MS = 45_000;
/** A wake a live tab's host keeps refusing as a missing thread is retried this far apart, at most. */
const MAX_DELIVERY_BACKOFF_MS = 15 * 60_000;
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
  /**
   * Whether the tab records loaded at boot: until they did, a missing tab may only be unknown, so
   * no watch is dropped for it (an explicit `session.closed` still drops). Default: loaded.
   */
  sessionsLoaded?: () => boolean;
  /** The daemon's event bus (`sessions` channel): idle points and closed tabs. */
  subscribe(listener: (event: EventMessage) => void): () => void;
  /** POST the thread's `/turn` with this body (the normal send path). */
  deliver(sessionId: string, body: { commandId: string; input: string }): Promise<WakeDelivery>;
  publish(event: PullRequestWatchesChangedEvent): void;
  clock: Clock;
  logger: WorkflowLogger;
  mintId?: () => string;
  random?: () => number;
  /** Writes the store (tests inject failures); default: 0600 tmp + rename. */
  write?: (path: string, content: string) => Promise<void>;
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
  /**
   * The thread's live watches of the pull request a URL or a number (in the project's origin)
   * names, matched by repository key and number — never by the text of the URL.
   */
  match(sessionId: string, query: PullRequestWatchListQuery): Promise<PullRequestWatchSummary[]>;
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

/** Temp file + rename, 0600; a failed write or rename leaves no temp file behind. */
export async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, content, { encoding: "utf8", mode: 0o600 });
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
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
  const write = deps.write ?? writeAtomic;
  const sessionsLoaded = deps.sessionsLoaded ?? (() => true);
  /** Saves that failed in a row, and when posting may be tried again. */
  let saveFailures = 0;
  let saveRetryAt = 0;
  /** Creates in flight per thread: each holds a slot of the per-thread cap. */
  const reserved = new Map<string, number>();
  /**
   * Threads whose host answers THREAD_NOT_FOUND while the daemon still has the tab (a route miss of
   * a host build): their wake waits, backing off, instead of posting every pass.
   */
  const deliveryHolds = new Map<string, { failures: number; retryAt: number }>();
  /** One chain of reads per host + account, never more: a slow or hung read holds only its own. */
  const readLanes = new Map<string, Promise<void>>();
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

  /**
   * Save the watches; resolves false when the write failed. Nothing is posted on an unsaved wake:
   * a restart would re-report the same news under a new id. Posting backs off while saves fail.
   */
  function persist(): Promise<boolean> {
    const body = serializePullRequestWatchFile(file);
    const attempt = writes.then(
      () =>
        write(deps.file, body).then(
          () => {
            saveFailures = 0;
            return true;
          },
          (error: unknown) => {
            saveFailures += 1;
            saveRetryAt = now() + Math.min(MAX_BACKOFF_MS, TICK_MS * 2 ** (saveFailures - 1));
            logger.error("pr watch: could not save the watches", { error: error instanceof Error ? error.message : String(error) });
            return false;
          }
        )
    );
    writes = attempt.then(() => undefined);
    return attempt;
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
      if (sessionsLoaded()) await dropThread(sessionId);
      return;
    }
    if (!acceptsWake(summary) || awaitingSentTurn(sessionId, summary)) return;
    if (saveFailures > 0 && now() < saveRetryAt) return;
    const hold = deliveryHolds.get(sessionId);
    if (hold && now() < hold.retryAt) return;

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
    const parts = sections.map(renderWakeSection);
    const wake = { commandId: `pr-watch:${mintId()}`, input: composeWake(parts), createdAt: at, attempts: 0, posted: false };
    for (const step of apply) step();
    involved.forEach((watch, index) => {
      watch.pendingWake = { ...wake, part: parts[index]! };
    });
    publish(sessionId);
    await deliver(sessionId, wake.commandId, summary);
  }

  async function deliver(sessionId: string, commandId: string, summary: SessionSummary): Promise<void> {
    const holders = () => file.watches.filter((watch) => watch.sessionId === sessionId && watch.pendingWake?.commandId === commandId);
    const first = holders()[0];
    if (!first) return;
    // Saved BEFORE the post, marked posted: a crash after it re-posts the same id (the host's
    // receipts dedupe), and the text can no longer be rewritten. No save, no post.
    const was = new Map(holders().map((watch) => [watch, watch.pendingWake!.posted]));
    for (const watch of was.keys()) watch.pendingWake = { ...watch.pendingWake!, posted: true };
    if (!(await persist())) {
      for (const [watch, posted] of was) if (watch.pendingWake?.commandId === commandId) watch.pendingWake = { ...watch.pendingWake, posted };
      return;
    }
    const result = await deps.deliver(sessionId, { commandId, input: first.pendingWake!.input });
    if (result.kind === "unavailable") return;
    if (result.kind === "gone") {
      // Only a thread the daemon no longer has is gone; a host-side miss on a live tab is not: the
      // wake waits, counted, backing off, and the state change is logged once.
      if (!deps.session(sessionId) && sessionsLoaded()) {
        deliveryHolds.delete(sessionId);
        await dropThread(sessionId);
        return;
      }
      const failures = (deliveryHolds.get(sessionId)?.failures ?? 0) + 1;
      deliveryHolds.set(sessionId, { failures, retryAt: now() + Math.min(MAX_DELIVERY_BACKOFF_MS, TICK_MS * 2 ** (failures - 1)) });
      if (failures === 1) {
        logger.warn("pr watch: the agent host does not know this thread; the wake waits and is retried with backoff", { sessionId, commandId });
      }
      for (const watch of holders()) watch.pendingWake = { ...watch.pendingWake!, attempts: watch.pendingWake!.attempts + 1 };
      await persist();
      publish(sessionId);
      return;
    }
    if (deliveryHolds.delete(sessionId)) {
      logger.info("pr watch: the agent host knows the thread again", { sessionId });
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
    // Anonymous reads share small per-IP limits (GitHub 60/h, Bitbucket Cloud 60/h).
    if (accountId === null) return ANONYMOUS_POLL_MS;
    if (host === "bitbucket.org") return BITBUCKET_CLOUD_POLL_MS;
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
    // Watches of deleted threads end — once the tab records are known to have loaded.
    if (sessionsLoaded()) {
      for (const sessionId of new Set(file.watches.map((watch) => watch.sessionId))) {
        if (!deps.session(sessionId)) await dropThread(sessionId);
      }
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
    // One chain per host + account: its pull requests are read one after another, and the pass does
    // not wait for it. A lane still reading from an earlier pass is left alone; its due watches are
    // read once it is free.
    const byLane = new Map<string, Array<{ accountId: string | null; members: PullRequestWatchRecord[] }>>();
    for (const group of groups.values()) {
      const host = parseRemoteUrl(group.members[0]!.repoUrl)?.host ?? "";
      const lane = `${host}|${group.accountId ?? "anonymous"}`;
      byLane.set(lane, [...(byLane.get(lane) ?? []), group]);
    }
    for (const [lane, queue] of byLane) {
      if (readLanes.has(lane)) continue;
      const chain = (async () => {
        for (const group of queue) {
          if (stopped) return;
          await readGroup(group.members, group.accountId);
        }
      })()
        .catch((error: unknown) => {
          logger.error("pr watch: reads failed", { error: error instanceof Error ? error.message : String(error) });
        })
        .finally(() => {
          readLanes.delete(lane);
        });
      readLanes.set(lane, chain);
      track(chain);
    }
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
    if (watchesOf(sessionId).filter(live).length + (reserved.get(sessionId) ?? 0) >= MAX_PR_WATCHES_PER_THREAD) {
      throw new PullRequestWatchError(
        409,
        "WATCH_LIMIT",
        `This thread already watches ${MAX_PR_WATCHES_PER_THREAD} pull requests. Call unwatch_pull_request for one first.`
      );
    }
    // The slot is held across the awaited read, so concurrent creates cannot pass the cap.
    reserved.set(sessionId, (reserved.get(sessionId) ?? 0) + 1);
    try {
      return await createReserved(sessionId, target, projectPath, same);
    } finally {
      const left = (reserved.get(sessionId) ?? 1) - 1;
      if (left > 0) reserved.set(sessionId, left);
      else reserved.delete(sessionId);
    }
  }

  async function createReserved(
    sessionId: string,
    target: PullRequestTarget,
    projectPath: string,
    same: (watch: PullRequestWatchRecord) => boolean
  ): Promise<CreatePullRequestWatchResponse> {

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
    if (!(await persist())) {
      // Not saved, not started: memory goes back to what the disk holds.
      forget(watch.id);
      file = { ...file, watches: file.watches.filter((candidate) => candidate !== watch) };
      throw new PullRequestWatchError(503, "UNAVAILABLE", "Orquester could not save the watch; try again in a moment.");
    }
    publish(sessionId);
    logger.info("pr watch: started", { sessionId, repository: watch.repository, number: watch.number });
    return { watch: summaryOf(watch), created: true, ...(note ? { note } : {}) };
  }

  async function remove(sessionId: string, watchId: string): Promise<void> {
    requireThread(sessionId);
    const watch = file.watches.find((candidate) => candidate.id === watchId && candidate.sessionId === sessionId && live(candidate));
    if (!watch) throw new PullRequestWatchError(404, "WATCH_NOT_FOUND", "This thread has no such pull request watch.");
    const index = file.watches.indexOf(watch);
    const others = watch.pendingWake ? file.watches.filter((candidate) => candidate !== watch && candidate.pendingWake?.commandId === watch.pendingWake!.commandId) : [];
    const wakesBefore = new Map(others.map((candidate) => [candidate, candidate.pendingWake]));
    file = { ...file, watches: file.watches.filter((candidate) => candidate !== watch) };
    pruneWake(watch);
    if (!(await persist())) {
      // Not saved, not stopped: the watch and the wake it shared go back as they were.
      const watches = [...file.watches];
      watches.splice(Math.min(index, watches.length), 0, watch);
      file = { ...file, watches };
      for (const [candidate, wake] of wakesBefore) if (file.watches.includes(candidate)) candidate.pendingWake = wake ?? null;
      throw new PullRequestWatchError(503, "UNAVAILABLE", "Orquester could not save the change; the pull request is still watched. Try again in a moment.");
    }
    forget(watch.id);
    publish(sessionId);
    logger.info("pr watch: stopped", { sessionId, repository: watch.repository, number: watch.number });
  }

  /**
   * A stopped watch leaves the wake it was part of: a wake not posted yet is recomposed from the
   * other watches' parts under a new id (or dropped when none is left). A posted one may already be
   * with the host, so its text stays as it was.
   */
  function pruneWake(stopped: PullRequestWatchRecord): void {
    const wake = stopped.pendingWake;
    if (!wake || wake.posted) return;
    const others = file.watches.filter((watch) => watch.pendingWake?.commandId === wake.commandId);
    if (others.length === 0) return;
    const parts = others.map((watch) => watch.pendingWake!.part);
    if (parts.some((part) => part === undefined)) return;
    const next = { commandId: `pr-watch:${mintId()}`, input: composeWake(parts as PullRequestWakePart[]), createdAt: wake.createdAt, attempts: 0, posted: false };
    for (const watch of others) watch.pendingWake = { ...next, part: watch.pendingWake!.part };
  }

  async function match(sessionId: string, query: PullRequestWatchListQuery): Promise<PullRequestWatchSummary[]> {
    const summary = requireThread(sessionId);
    const watches = watchesOf(sessionId).filter(live);
    if (query.url !== undefined) {
      const target = parsePullRequestUrl(query.url);
      if (!target) throw new PullRequestWatchError(400, "INVALID_ARGUMENT", "That is not a pull request URL. Pass watchId or number instead.");
      return watches.filter((watch) => watch.number === target.number && repoKeyOf(watch.repoUrl) === target.repoKey).map(summaryOf);
    }
    if (query.number !== undefined) {
      const remote = summary.projectPath ? await deps.projectRemote(summary.projectPath).catch(() => null) : null;
      const origin = remote ? targetInRemote(remote, query.number) : null;
      const numbered = watches.filter((watch) => watch.number === query.number);
      const inOrigin = origin ? numbered.filter((watch) => repoKeyOf(watch.repoUrl) === origin.repoKey) : [];
      return (inOrigin.length > 0 ? inOrigin : numbered).map(summaryOf);
    }
    return watches.map(summaryOf);
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
    match: (sessionId, query) => match(sessionId, query),
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
  /**
   * The mode each pending wake is sent in, read once per wake: no lighter route names a thread's
   * mode (the summary does not carry it), so the snapshot is read on the first attempt only and
   * a retry reuses it. Bounded; an entry goes once its wake is settled.
   */
  const modes = new Map<string, "default" | "plan">();
  const remember = (commandId: string, mode: "default" | "plan") => {
    modes.set(commandId, mode);
    while (modes.size > 200) {
      const oldest = modes.keys().next().value;
      if (oldest === undefined) break;
      modes.delete(oldest);
    }
  };
  return async (sessionId, body) => {
    const outcome = await post(sessionId, body);
    if (outcome.kind !== "unavailable" && !(outcome.kind === "refused" && outcome.retryable) && outcome.kind !== "gone") modes.delete(body.commandId);
    return outcome;
  };

  async function post(sessionId: string, body: { commandId: string; input: string }): Promise<WakeDelivery> {
    const client = api();
    if (!client) return { kind: "unavailable" };
    let res: { status: number; body: unknown };
    try {
      // The thread's current mode is its latest turn's: the host takes a missing mode as
      // "default", which would flip a thread out of plan mode.
      let interactionMode = modes.get(body.commandId);
      if (interactionMode === undefined) {
        const thread = await client.request("GET", agentChatRoutes.thread(sessionId));
        const threadCode = (thread.body as { error?: { code?: unknown } } | null)?.error?.code;
        if (thread.status === 404 && threadCode === "THREAD_NOT_FOUND") return { kind: "gone" };
        if (thread.status >= 400) return { kind: "unavailable" };
        const turns = (thread.body as { kind?: unknown; thread?: { turns?: Array<{ interactionMode?: unknown }> } } | null)?.thread?.turns ?? [];
        const latest = [...turns].reverse().find((turn) => turn.interactionMode === "plan" || turn.interactionMode === "default");
        interactionMode = latest?.interactionMode === "plan" ? "plan" : "default";
        remember(body.commandId, interactionMode);
      }
      res = await client.request("POST", agentChatCommandPath(sessionId, "turn"), {
        body: { commandId: body.commandId, input: body.input, interactionMode }
      });
    } catch {
      return { kind: "unavailable" };
    }
    if (res.status < 400) return { kind: "sent" };
    const error = (res.body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
    const code = typeof error?.code === "string" ? error.code : "";
    if (res.status === 503 || code === "HOST_UNAVAILABLE") return { kind: "unavailable" };
    if (res.status === 404 && code === "THREAD_NOT_FOUND") return { kind: "gone" };
    return {
      kind: "refused",
      retryable: res.status === 409 && (code === "COMMAND_REJECTED" || code === "COMPACTION_UNAVAILABLE"),
      message: typeof error?.message === "string" ? error.message.slice(0, 500) : `The thread answered ${res.status}.`
    };
  }
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
