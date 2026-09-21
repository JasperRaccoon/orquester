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

/** Derived state, dropped freely — this only bounds the memory it may hold. */
export const CHECKPOINT_DIFF_CACHE_LIMIT = 32;

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
}

export interface CaptureTurnEndInput {
  threadId: string;
  cwd: string;
  turnId: string | null;
  assistantMessageId: string | null;
  checkpoints?: readonly Checkpoint[];
  /** When set, only this turn may produce a completion checkpoint (§5.4). */
  activeTurnId?: string | null;
}

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

  const diffCache = new Map<string, string>();

  const dropCache = (threadId: string): void => {
    const prefix = `${threadId}\u0000`;
    for (const key of diffCache.keys()) {
      if (key.startsWith(prefix)) {
        diffCache.delete(key);
      }
    }
  };

  /** Every turn count this thread has a ref for, ascending. */
  const listRefTurnCounts = async (threadId: string, cwd: string): Promise<number[]> => {
    const namespace = checkpointRefNamespace(threadId);
    const result = await runner.run({
      operation: "checkpoints.listRefs",
      cwd,
      args: ["for-each-ref", "--format=%(refname)", namespace],
      maxOutputBytes: 1_000_000
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
      maxOutputBytes: 1_000_000
    });
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  };

  const deleteRefs = async (cwd: string, refs: readonly string[]): Promise<void> => {
    if (refs.length === 0) {
      return;
    }
    const stdin = refs.map((ref) => `delete ${ref}\0\0`).join("");
    try {
      await runner.run({
        operation: "checkpoints.deleteRefs",
        cwd,
        args: ["update-ref", "-z", "--stdin"],
        stdin
      });
      return;
    } catch (error) {
      log("checkpoint batch ref delete failed; falling back to one at a time", {
        detail: errorDetail(error)
      });
    }
    for (const ref of refs) {
      await runner
        .run({
          operation: "checkpoints.deleteRefs",
          cwd,
          args: ["update-ref", "-d", ref],
          allowNonZeroExit: true
        })
        .catch(() => undefined);
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
    await deleteRefs(cwd, doomed);
    dropCache(threadId);
  };

  const captureBaseline = async (input: CaptureBaselineInput): Promise<CaptureResult | null> => {
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
      // Idempotent: the baseline for this turn is already published.
      return null;
    }
    try {
      await captureCheckpoint(runner, { cwd: input.cwd, ref, uuid: uuid() });
    } catch (error) {
      log("checkpoint baseline capture failed", {
        threadId: input.threadId,
        turnCount,
        detail: errorDetail(error)
      });
      return { turnCount, ref, status: "error", detail: errorDetail(error) };
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

    // The stamp is the time the diff finished; §5.4 is explicit that a late
    // diff never extends the turn's recorded duration — the turn is settled by
    // the fold from session status, and this event carries no turn timing.
    const completedAt = clock.nowIso();

    try {
      await captureCheckpoint(runner, { cwd, ref, uuid: uuid() });
    } catch (error) {
      log("checkpoint capture failed", { threadId, turnCount, detail: errorDetail(error) });
      return {
        turnCount,
        ref,
        status: "error",
        turnId,
        files: [],
        assistantMessageId,
        completedAt,
        detail: errorDetail(error)
      };
    }
    dropCache(threadId);

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
        detail = `Checkpoint captured, but the turn diff summary is unavailable: ${errorDetail(error)}`;
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
    if (!refTurnCounts.includes(input.fromTurnCount)) {
      throw new CheckpointRefUnavailableError(input.fromTurnCount, "from");
    }
    if (!refTurnCounts.includes(input.toTurnCount)) {
      throw new CheckpointRefUnavailableError(input.toTurnCount, "to");
    }

    const fromRef = checkpointRefForThreadTurn(input.threadId, input.fromTurnCount);
    const toRef = checkpointRefForThreadTurn(input.threadId, input.toTurnCount);
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
        `${fromRef}^{commit}`,
        `${toRef}^{commit}`
      ],
      maxOutputBytes: CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
      outputMode: "truncate",
      appendTruncationMarker: true
    });

    if (diffCache.size >= CHECKPOINT_DIFF_CACHE_LIMIT) {
      // Derived state: the oldest insertion goes, no bookkeeping needed.
      const oldest = diffCache.keys().next();
      if (!oldest.done) {
        diffCache.delete(oldest.value);
      }
    }
    diffCache.set(cacheKey, result.stdout);
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
    await deleteRefs(input.cwd, doomed);
    dropCache(input.threadId);
  };

  const deleteThreadRefs = async (input: { threadId: string; cwd: string }): Promise<void> => {
    if (!(await isInsideWorkTree(runner, input.cwd))) {
      return;
    }
    const refs = await listRefNames(input.threadId, input.cwd);
    await deleteRefs(input.cwd, refs);
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

function errorDetail(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export { CHECKPOINT_CAPTURE_OPERATION };
export type { GitRunner };
