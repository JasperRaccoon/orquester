/**
 * Checkpoints — the {@link CheckpointService} implementation (spec §5.4, §5.5).
 *
 * What this service does NOT do is as load-bearing as what it does: there is
 * no restore path at all. §5.5 reverts the conversation only, so nothing here
 * ever writes the working tree, the index, HEAD, a branch or the stash. The
 * one write is `update-ref` under `refs/orquester/checkpoints/**`, plus the
 * loose objects a capture's tree needs.
 *
 * Ported from T3 Code (MIT): apps/server/src/orchestration/Layers/CheckpointReactor.ts,
 * apps/server/src/checkpointing/CheckpointDiffQuery.ts
 */

import { randomUUID } from "node:crypto";

import type { AgentAdapterId, Checkpoint, CheckpointFile } from "@orquester/api/agent-chat";

import type { CaptureResult, CheckpointService, Clock, TurnDiffSummary } from "../services.ts";
import {
  CHECKPOINT_CAPTURE_OPERATION,
  captureCheckpoint,
  isInsideWorkTree,
  resolveCheckpointCommit
} from "./capture.ts";
import { redactStderr } from "../support/stderr.ts";
import { createGitRunner, type GitRunner, type GitRunnerOptions } from "./git.ts";
import { parseTurnDiffFilesFromNumstat } from "./numstat.ts";
import {
  checkpointRefForThreadTurn,
  checkpointRefNamespace,
  turnCountFromCheckpointRef
} from "./refs.ts";

/** At most this many checkpoint refs per thread; older ones prune oldest-first. */
export const CHECKPOINT_REF_LIMIT = 200;

/** §5.4: diff output is capped at 10 MB. */
export const CHECKPOINT_DIFF_MAX_OUTPUT_BYTES = 10_000_000;

/** Derived state, dropped freely. Entry bound; the byte bound below is the real one. */
export const CHECKPOINT_DIFF_CACHE_LIMIT = 32;

/**
 * The cache's total footprint. A patch may be up to
 * {@link CHECKPOINT_DIFF_MAX_OUTPUT_BYTES}, so entries alone bound nothing: 32
 * of them would be ~320 MB of retained V8 strings on a 2 GB VPS.
 */
export const CHECKPOINT_DIFF_CACHE_MAX_BYTES = 32 * 1024 * 1024;

/**
 * The one adapter without conversation rollback (§4.5 Grok, §5.5 step 2).
 * Checked before anything on disk is touched.
 */
const CONVERSATION_ROLLBACK_UNSUPPORTED: ReadonlySet<string> = new Set<AgentAdapterId>(["grok"]);

/** A revert asked of an adapter that cannot roll its conversation back. */
export class CheckpointRollbackUnsupportedError extends Error {
  readonly adapter: AgentAdapterId;

  constructor(adapter: AgentAdapterId) {
    super(
      `${adapter} cannot rewind a conversation: the provider has no rollback. ` +
        "Start a new thread instead."
    );
    this.name = "CheckpointRollbackUnsupportedError";
    this.adapter = adapter;
  }
}

/** A turn above the thread's highest checkpoint — the route answers 404. */
export class CheckpointTurnRangeError extends Error {
  readonly requestedTurnCount: number;
  readonly availableTurnCount: number;

  constructor(requestedTurnCount: number, availableTurnCount: number) {
    super(
      `checkpoint turn ${requestedTurnCount} is above this thread's highest checkpoint ` +
        `(${availableTurnCount})`
    );
    this.name = "CheckpointTurnRangeError";
    this.requestedTurnCount = requestedTurnCount;
    this.availableTurnCount = availableTurnCount;
  }
}

/** A turn inside the range whose ref is gone (pruned, or never captured). */
export class CheckpointRefUnavailableError extends Error {
  readonly turnCount: number;
  readonly side: "from" | "to";

  constructor(turnCount: number, side: "from" | "to") {
    super(`checkpoint ref for turn ${turnCount} is unavailable (${side})`);
    this.name = "CheckpointRefUnavailableError";
    this.turnCount = turnCount;
    this.side = side;
  }
}

/**
 * Refs that are still on disk after both delete attempts. Raised rather than
 * swallowed: a revert that leaves `turn/<target+1…N>` behind would report
 * success and then anchor the next turn on the branch the user discarded.
 */
export class CheckpointRefDeleteError extends Error {
  readonly refs: readonly string[];

  constructor(refs: readonly string[], detail: string) {
    super(`could not delete ${refs.length} checkpoint ref(s): ${detail}`);
    this.name = "CheckpointRefDeleteError";
    this.refs = refs;
  }
}

export interface CheckpointServiceOptions extends Omit<GitRunnerOptions, "maxConcurrentGit"> {
  clock?: Clock;
  /** Host-wide permit count for concurrent git work (§5.4). */
  maxConcurrentGit?: number;
  /** Test seam: deterministic temp-index names. */
  uuid?: () => string;
  /** Best-effort diagnostics; never throws into a turn. */
  log?: (message: string, detail?: Record<string, unknown>) => void;
}

/**
 * Inputs the host may enrich. Every extra field is optional: with none of them
 * the service derives everything it can from the refs on disk, which is what a
 * test (and a host that lost `meta.json`) gets.
 */
export interface CaptureBaselineInput {
  threadId: string;
  cwd: string;
  /** The fold's checkpoint rows, so a placeholder counts toward the turn count. */
  checkpoints?: readonly Checkpoint[];
  /**
   * The turn this baseline precedes, when the caller knows it. Recorded as the
   * thread's started turn (T3's `startedTurns`), which is what lets a stale
   * `turn.aborted` for some *other* turn be refused at turn end.
   */
  turnId?: string | null;
}

export interface CaptureTurnEndInput {
  threadId: string;
  cwd: string;
  turnId: string | null;
  assistantMessageId: string | null;
  checkpoints?: readonly Checkpoint[];
  /** When set, only this turn may produce a completion checkpoint (§5.4). */
  activeTurnId?: string | null;
  /**
   * The turn the host recorded as started, when it tracks one itself. Overrides
   * what `captureBaseline` recorded for this thread.
   */
  startedTurnId?: string | null;
}

/** How many completed turn ids are remembered per thread, for replay refusal. */
const COMPLETED_TURN_MEMORY = 64;

const defaultClock: Clock = {
  now: () => new Date(),
  nowIso: () => new Date().toISOString()
};

export function createCheckpointService(options: CheckpointServiceOptions): CheckpointService {
  const clock = options.clock ?? defaultClock;
  const uuid = options.uuid ?? randomUUID;
  const log = options.log ?? (() => {});
  const runner = createGitRunner({
    gitEnv: options.gitEnv,
    ...(options.maxConcurrentGit === undefined
      ? {}
      : { maxConcurrentGit: options.maxConcurrentGit }),
    ...(options.resolveGitBinary === undefined
      ? {}
      : { resolveGitBinary: options.resolveGitBinary })
  });

  /**
   * Collapsed to `~` in any detail that reaches a timeline row. The git env is
   * the only home this service knows, and it is the one git's own messages
   * name.
   */
  const homeDirs = [options.gitEnv.HOME, options.gitEnv.USERPROFILE].filter(
    (dir): dir is string => typeof dir === "string" && dir.length > 1
  );
  const describeError = (error: unknown): string => errorDetail(error, homeDirs);

  const diffCache = new Map<string, string>();
  let diffCacheBytes = 0;
  /** Per thread: the turn `captureBaseline` was last called for. */
  const startedTurns = new Map<string, string>();
  /** Per thread: the turns that already produced a completion checkpoint. */
  const completedTurns = new Map<string, Set<string>>();

  const rememberCompletedTurn = (threadId: string, turnId: string): void => {
    let seen = completedTurns.get(threadId);
    if (seen === undefined) {
      seen = new Set<string>();
      completedTurns.set(threadId, seen);
    }
    seen.add(turnId);
    // Insertion-ordered: drop the oldest ids once the window is full.
    while (seen.size > COMPLETED_TURN_MEMORY) {
      const oldest = seen.values().next();
      if (oldest.done) {
        break;
      }
      seen.delete(oldest.value);
    }
  };

  const dropCache = (threadId: string): void => {
    const prefix = `${threadId}\u0000`;
    for (const [key, value] of diffCache) {
      if (key.startsWith(prefix)) {
        diffCache.delete(key);
        diffCacheBytes -= cachedSize(value);
      }
    }
  };

  /**
   * Insertion-ordered eviction against BOTH bounds. The byte budget is the one
   * that matters: a single patch may be 10 MB, so an entry-count-only cap would
   * hold ~320 MB resident on a box documented to run with 2 GB.
   */
  const cacheDiff = (key: string, diff: string): void => {
    const size = cachedSize(diff);
    if (size > CHECKPOINT_DIFF_CACHE_MAX_BYTES) {
      return;
    }
    const existing = diffCache.get(key);
    if (existing !== undefined) {
      diffCache.delete(key);
      diffCacheBytes -= cachedSize(existing);
    }
    while (
      diffCache.size >= CHECKPOINT_DIFF_CACHE_LIMIT ||
      diffCacheBytes + size > CHECKPOINT_DIFF_CACHE_MAX_BYTES
    ) {
      const oldest = diffCache.keys().next();
      if (oldest.done) {
        break;
      }
      const evicted = diffCache.get(oldest.value);
      diffCache.delete(oldest.value);
      diffCacheBytes -= cachedSize(evicted ?? "");
    }
    diffCache.set(key, diff);
    diffCacheBytes += size;
  };

  /** Every turn count this thread has a ref for, ascending. */
  const listRefTurnCounts = async (threadId: string, cwd: string): Promise<number[]> => {
    const namespace = checkpointRefNamespace(threadId);
    const result = await runner.run({
      operation: "checkpoints.listRefs",
      cwd,
      args: ["for-each-ref", "--format=%(refname)", namespace],
      maxOutputBytes: 1_000_000,
      // A truncated listing is indistinguishable from a complete one, and every
      // caller (prune, cap, delete) would then silently leave refs behind.
      outputMode: "error"
    });
    const counts: number[] = [];
    for (const line of result.stdout.split("\n")) {
      const ref = line.trim();
      if (ref.length === 0) {
        continue;
      }
      const turnCount = turnCountFromCheckpointRef(threadId, ref);
      if (turnCount !== null) {
        counts.push(turnCount);
      }
    }
    return counts.sort((left, right) => left - right);
  };

  /** Every ref under the thread's prefix, whatever its shape. */
  const listRefNames = async (threadId: string, cwd: string): Promise<string[]> => {
    const result = await runner.run({
      operation: "checkpoints.listRefs",
      cwd,
      args: ["for-each-ref", "--format=%(refname)", checkpointRefNamespace(threadId)],
      maxOutputBytes: 1_000_000,
      outputMode: "error"
    });
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  };

  /**
   * Delete refs and **prove it**. A swallowed failure here is not cosmetic:
   * §5.5 would report a completed revert while `turn/<target+1…N>` still exist,
   * and the next `captureTurnEnd` would then derive its turn count — and its
   * baseline — from the branch the user just discarded.
   *
   * Ref deletion is also the operation most exposed to `packed-refs.lock`
   * contention with a user's own git, which is exactly what the runner's
   * transient retry exists for.
   */
  const deleteRefs = async (
    threadId: string,
    cwd: string,
    refs: readonly string[]
  ): Promise<void> => {
    if (refs.length === 0) {
      return;
    }
    const stdin = refs.map((ref) => `delete ${ref}\0\0`).join("");
    let batchError: unknown;
    try {
      await runner.run({
        operation: "checkpoints.deleteRefs",
        cwd,
        args: ["update-ref", "-z", "--stdin"],
        stdin,
        retryTransient: true
      });
    } catch (error) {
      batchError = error;
      log("checkpoint batch ref delete failed; falling back to one at a time", {
        detail: describeError(error)
      });
      for (const ref of refs) {
        await runner
          .run({
            operation: "checkpoints.deleteRefs",
            cwd,
            args: ["update-ref", "-d", ref],
            allowNonZeroExit: true,
            retryTransient: true
          })
          .catch(() => undefined);
      }
    }
    if (batchError === undefined) {
      return;
    }
    // Only the fallback path pays for a re-listing: it is the only one whose
    // per-ref failures were deliberately tolerated.
    const remaining = new Set(await listRefNames(threadId, cwd));
    const survivors = refs.filter((ref) => remaining.has(ref));
    if (survivors.length > 0) {
      throw new CheckpointRefDeleteError(survivors, describeError(batchError));
    }
  };

  /**
   * The highest turn count the thread has, counting both the refs on disk and
   * the fold's rows (a placeholder has a turn count but no ref yet). Derived,
   * never stored — a lost `meta.json` cannot desynchronise it (§5.4).
   */
  const resolveCurrentTurnCount = (
    refTurnCounts: readonly number[],
    checkpoints: readonly Checkpoint[] | undefined
  ): number => {
    let current = 0;
    for (const turnCount of refTurnCounts) {
      current = Math.max(current, turnCount);
    }
    for (const checkpoint of checkpoints ?? []) {
      current = Math.max(current, checkpoint.checkpointTurnCount);
    }
    return current;
  };

  /** Keep the newest {@link CHECKPOINT_REF_LIMIT} refs; prune oldest-first. */
  const pruneToCap = async (threadId: string, cwd: string): Promise<void> => {
    const turnCounts = await listRefTurnCounts(threadId, cwd);
    if (turnCounts.length <= CHECKPOINT_REF_LIMIT) {
      return;
    }
    const doomed = turnCounts
      .slice(0, turnCounts.length - CHECKPOINT_REF_LIMIT)
      .map((turnCount) => checkpointRefForThreadTurn(threadId, turnCount));
    await deleteRefs(threadId, cwd, doomed);
    dropCache(threadId);
  };

  const captureBaseline = async (input: CaptureBaselineInput): Promise<CaptureResult | null> => {
    // Recorded before the early returns: knowing which turn started is useful
    // even when the ref is already there (the second, idempotent call).
    if (typeof input.turnId === "string" && input.turnId.length > 0) {
      startedTurns.set(input.threadId, input.turnId);
    }
    if (!(await isInsideWorkTree(runner, input.cwd))) {
      return null;
    }
    const refTurnCounts = await listRefTurnCounts(input.threadId, input.cwd).catch(() => null);
    if (refTurnCounts === null) {
      return null;
    }
    const turnCount = resolveCurrentTurnCount(refTurnCounts, input.checkpoints);
    const ref = checkpointRefForThreadTurn(input.threadId, turnCount);
    if (refTurnCounts.includes(turnCount)) {
      // Idempotent: the baseline for this turn is already published. This
      // answers `ready`, NOT `null` — `null` means "this project has no
      // checkpoints at all", and a caller that conflates the two would mark
      // every thread checkpoint-less from its second turn onwards, when the
      // baseline is always already there.
      return { turnCount, ref, status: "ready" };
    }
    try {
      await captureCheckpoint(runner, { cwd: input.cwd, ref, uuid: uuid() });
    } catch (error) {
      log("checkpoint baseline capture failed", {
        threadId: input.threadId,
        turnCount,
        detail: describeError(error)
      });
      return { turnCount, ref, status: "error", detail: describeError(error) };
    }
    dropCache(input.threadId);
    await pruneToCap(input.threadId, input.cwd).catch(() => undefined);
    return { turnCount, ref, status: "ready" };
  };

  const captureTurnEnd = async (input: CaptureTurnEndInput): Promise<TurnDiffSummary | null> => {
    const { threadId, cwd, turnId } = input;
    // When a primary turn is active, only that turn may produce a completion
    // checkpoint.
    if (
      input.activeTurnId !== undefined &&
      input.activeTurnId !== null &&
      turnId !== null &&
      input.activeTurnId !== turnId
    ) {
      return null;
    }
    // A late or replayed `turn.completed`/`turn.aborted` for a turn this
    // service already captured must not mint a second checkpoint: it would
    // consume a slot in the 200-ref cap and shift every later turn count. The
    // fold's rows below say the same thing when the caller passes them; this
    // memory holds even when it does not.
    if (turnId !== null && completedTurns.get(threadId)?.has(turnId) === true) {
      return null;
    }
    // A turn the host never recorded as started is not the session's turn
    // either (T3: `CheckpointReactor.ts:981-987`). Only positive knowledge
    // skips — with no record at all the capture proceeds, as before.
    const startedTurnId = input.startedTurnId ?? startedTurns.get(threadId);
    if (
      turnId !== null &&
      startedTurnId !== undefined &&
      startedTurnId !== null &&
      startedTurnId !== turnId &&
      input.activeTurnId !== turnId
    ) {
      return null;
    }
    const checkpoints = input.checkpoints ?? [];
    // Only skip for a real (non-placeholder) checkpoint: ingestion may insert
    // a `missing` placeholder before this runs, and that must not prevent the
    // real git capture.
    if (
      turnId !== null &&
      checkpoints.some(
        (checkpoint) => checkpoint.turnId === turnId && checkpoint.status !== "missing"
      )
    ) {
      return null;
    }
    if (!(await isInsideWorkTree(runner, cwd))) {
      return null;
    }
    const refTurnCounts = await listRefTurnCounts(threadId, cwd).catch(() => null);
    if (refTurnCounts === null) {
      return null;
    }

    const placeholder =
      turnId === null
        ? undefined
        : checkpoints.find(
            (checkpoint) => checkpoint.turnId === turnId && checkpoint.status === "missing"
          );
    const currentTurnCount = resolveCurrentTurnCount(refTurnCounts, checkpoints);
    // A placeholder is reused at its own turn count rather than incremented
    // past, or the turn the user sees would point at a ref nothing captured.
    const turnCount = placeholder ? placeholder.checkpointTurnCount : currentTurnCount + 1;
    const ref = checkpointRefForThreadTurn(threadId, turnCount);
    const assistantMessageId =
      input.assistantMessageId ?? placeholder?.assistantMessageId ?? null;

    const fromTurnCount = Math.max(0, turnCount - 1);
    const fromRef = checkpointRefForThreadTurn(threadId, fromTurnCount);
    // Git may have been initialised during this turn, leaving no baseline.
    const baselineCommit = await resolveCheckpointCommit(runner, cwd, fromRef).catch(() => null);

    // Stamped when the turn end was OBSERVED, deliberately not when the diff
    // finished: §5.4 is explicit that a late diff never extends the turn's
    // recorded duration. (The turn itself is settled by the fold from session
    // status; this event carries no turn timing at all.)
    const completedAt = clock.nowIso();

    try {
      await captureCheckpoint(runner, { cwd, ref, uuid: uuid() });
    } catch (error) {
      log("checkpoint capture failed", { threadId, turnCount, detail: describeError(error) });
      return {
        turnCount,
        ref,
        status: "error",
        turnId,
        files: [],
        assistantMessageId,
        completedAt,
        detail: describeError(error)
      };
    }
    dropCache(threadId);
    if (turnId !== null) {
      rememberCompletedTurn(threadId, turnId);
    }

    let files: CheckpointFile[] = [];
    let detail: string | undefined;
    if (baselineCommit !== null) {
      try {
        const numstat = await runner.run({
          operation: "checkpoints.numstat",
          cwd,
          args: [
            "diff",
            "--numstat",
            "-z",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            `${fromRef}^{commit}`,
            `${ref}^{commit}`
          ],
          maxOutputBytes: CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
          // A half-read numstat would under-report the turn's changed files,
          // which is worse than reporting none.
          outputMode: "error"
        });
        files = parseTurnDiffFilesFromNumstat(numstat.stdout);
      } catch (error) {
        detail = `Checkpoint captured, but the turn diff summary is unavailable: ${describeError(error)}`;
        log("checkpoint diff summary failed", { threadId, turnCount, detail });
      }
    } else {
      // Keep the completion checkpoint for future turns, but do not invent a
      // baseline or diff against a ref that does not exist.
      log("checkpoint capture has no pre-turn baseline", { threadId, fromTurnCount });
    }

    await pruneToCap(threadId, cwd).catch(() => undefined);

    return {
      turnCount,
      ref,
      status: "ready",
      turnId,
      files,
      assistantMessageId,
      completedAt,
      ...(detail === undefined ? {} : { detail })
    };
  };

  /**
   * What a diff uses when the `from` checkpoint has no ref: the current HEAD
   * commit, or the empty tree when the repository has no commit at all (the
   * oid is computed, never hard-coded — it differs between sha1 and sha256
   * repositories, and `hash-object` without `-w` writes nothing).
   */
  const baselineFallbackRevision = async (cwd: string): Promise<string> => {
    const head = await runner.run({
      operation: "checkpoints.resolveHeadCommit",
      cwd,
      args: ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
      allowNonZeroExit: true,
      maxOutputBytes: 4_096
    });
    const commit = head.stdout.trim();
    if (head.exitCode === 0 && commit.length > 0) {
      return commit;
    }
    const emptyTree = await runner.run({
      operation: "checkpoints.emptyTree",
      cwd,
      args: ["hash-object", "-t", "tree", "/dev/null"],
      maxOutputBytes: 4_096
    });
    return emptyTree.stdout.trim();
  };

  const readTurnDiff = async (input: {
    threadId: string;
    cwd: string;
    fromTurnCount: number;
    toTurnCount: number;
    ignoreWhitespace?: boolean;
  }): Promise<string> => {
    const ignoreWhitespace = input.ignoreWhitespace ?? true;
    // `from === to` short-circuits without touching git.
    if (input.fromTurnCount === input.toTurnCount) {
      return "";
    }
    const cacheKey = `${input.threadId}\u0000${input.fromTurnCount}\u0000${input.toTurnCount}\u0000${ignoreWhitespace ? "1" : "0"}`;
    const cached = diffCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const inRepo = await isInsideWorkTree(runner, input.cwd);
    const refTurnCounts = inRepo ? await listRefTurnCounts(input.threadId, input.cwd) : [];
    const availableTurnCount = refTurnCounts.reduce((max, turnCount) => Math.max(max, turnCount), 0);
    // A turn above the thread's highest checkpoint is a 404, not an empty diff.
    if (input.toTurnCount > availableTurnCount) {
      throw new CheckpointTurnRangeError(input.toTurnCount, availableTurnCount);
    }
    if (!refTurnCounts.includes(input.toTurnCount)) {
      throw new CheckpointRefUnavailableError(input.toTurnCount, "to");
    }

    const toRef = checkpointRefForThreadTurn(input.threadId, input.toTurnCount);
    // 404 is reserved for a turn ABOVE the highest checkpoint. A turn at or
    // below it whose baseline is simply gone — git was initialised during the
    // turn, or the 200-ref cap pruned it — still has a real answer: diff it
    // against HEAD, and against the empty tree when there is not even a HEAD.
    // (T3 does the same through `diffCheckpoints({fallbackFromToHead})`.)
    const fromRevision = refTurnCounts.includes(input.fromTurnCount)
      ? `${checkpointRefForThreadTurn(input.threadId, input.fromTurnCount)}^{commit}`
      : await baselineFallbackRevision(input.cwd);
    const result = await runner.run({
      operation: "checkpoints.diff",
      cwd: input.cwd,
      args: [
        "diff",
        "--patch",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        ...(ignoreWhitespace ? ["--ignore-all-space"] : []),
        fromRevision,
        `${toRef}^{commit}`
      ],
      maxOutputBytes: CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
      outputMode: "truncate",
      appendTruncationMarker: true
    });

    cacheDiff(cacheKey, result.stdout);
    return result.stdout;
  };

  const pruneAbove = async (input: {
    threadId: string;
    cwd: string;
    targetTurnCount: number;
  }): Promise<void> => {
    if (!(await isInsideWorkTree(runner, input.cwd))) {
      return;
    }
    const turnCounts = await listRefTurnCounts(input.threadId, input.cwd);
    const doomed = turnCounts
      .filter((turnCount) => turnCount > input.targetTurnCount)
      .map((turnCount) => checkpointRefForThreadTurn(input.threadId, turnCount));
    await deleteRefs(input.threadId, input.cwd, doomed);
    dropCache(input.threadId);
  };

  const deleteThreadRefs = async (input: { threadId: string; cwd: string }): Promise<void> => {
    // Per-thread memory goes whatever git says: the thread is being deleted,
    // so nothing may keep growing on its behalf.
    startedTurns.delete(input.threadId);
    completedTurns.delete(input.threadId);
    if (!(await isInsideWorkTree(runner, input.cwd))) {
      return;
    }
    const refs = await listRefNames(input.threadId, input.cwd);
    await deleteRefs(input.threadId, input.cwd, refs);
    dropCache(input.threadId);
  };

  const assertRollbackSupported = (adapter: AgentAdapterId): void => {
    if (CONVERSATION_ROLLBACK_UNSUPPORTED.has(adapter)) {
      throw new CheckpointRollbackUnsupportedError(adapter);
    }
  };

  return {
    captureBaseline,
    captureTurnEnd,
    readTurnDiff,
    pruneAbove,
    deleteThreadRefs,
    assertRollbackSupported
  };
}

/**
 * What a checkpoint row's `detail` may say. It is rendered in the timeline, so
 * it goes through the same redaction the stderr path uses: git messages name
 * absolute paths (`/var/lib/orquester/workspaces/...`, a home dir) and this is
 * the one place a raw host path could otherwise reach the browser.
 */
function errorDetail(error: unknown, homeDirs: readonly string[] = []): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactStderr(message, { homeDirs });
}

/** UTF-8 bytes, which is what the cached string actually costs on the wire. */
function cachedSize(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export { CHECKPOINT_CAPTURE_OPERATION };
export type { GitRunner };
