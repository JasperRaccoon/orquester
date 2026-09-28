// Automated workflows — the engine's pure helpers: limits, per-type timeouts, output capping,
// the run views that cross the wire, the live inputs of a block, and a resumable wall-clock sleep
// (spec §3.2, §5.8, §5.9).

import {
  WORKFLOW_LIMITS,
  type WorkflowBlockRun,
  type WorkflowErrorCode,
  type WorkflowNode,
  type WorkflowProblem,
  type WorkflowRun,
  type WorkflowRunSummary
} from "@orquester/api";

import type { Clock, PersistedBlockState, PersistedRun } from "./contracts.ts";

// ---------------------------------------------------------------------------
// Errors the engine throws at its callers (routes, MCP)
// ---------------------------------------------------------------------------

/** A refusal with a wire code and an HTTP status; `problems` for INVALID_WORKFLOW. */
export class WorkflowEngineError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: WorkflowErrorCode,
    message: string,
    readonly problems?: WorkflowProblem[]
  ) {
    super(message);
    this.name = "WorkflowEngineError";
  }
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export interface EngineLimits {
  maxConcurrentRuns: number;
  maxConcurrentAgentBlocks: number;
  maxConcurrentProcesses: number;
  maxSubWorkflowDepth: number;
  maxOutputBytes: number;
  inlineOutputPreviewBytes: number;
  /** Minimum spacing of `workflowRun.updated` per run (≤ 4/s). */
  eventIntervalMs: number;
  /** How long an ending run waits for blocks that ignore their abort before finalizing anyway. */
  endingGraceMs: number;
  /** How many recent runs `fromNodeId` searches for upstream outputs. */
  seedSearchRuns: number;
}

export const DEFAULT_ENGINE_LIMITS: EngineLimits = {
  maxConcurrentRuns: WORKFLOW_LIMITS.maxConcurrentRuns,
  maxConcurrentAgentBlocks: WORKFLOW_LIMITS.maxConcurrentAgentBlocks,
  maxConcurrentProcesses: WORKFLOW_LIMITS.maxConcurrentProcesses,
  maxSubWorkflowDepth: WORKFLOW_LIMITS.maxSubWorkflowDepth,
  maxOutputBytes: WORKFLOW_LIMITS.maxOutputBytes,
  inlineOutputPreviewBytes: WORKFLOW_LIMITS.inlineOutputPreviewBytes,
  eventIntervalMs: 250,
  endingGraceMs: 30_000,
  seedSearchRuns: 20
};

const MINUTE = 60_000;

/** A block's timeout in ms, its type's default and maximum applied (§5.9). */
export function blockTimeoutMs(node: WorkflowNode): number {
  const nodeMinutes = typeof node.timeoutMinutes === "number" && node.timeoutMinutes > 0 ? node.timeoutMinutes : undefined;
  switch (node.type) {
    case "code":
    case "shell": {
      const { default: fallback, max } = WORKFLOW_LIMITS.processTimeoutMinutes;
      const minutes = node.config.timeoutMinutes ?? nodeMinutes ?? fallback;
      return Math.min(minutes, max) * MINUTE;
    }
    case "http": {
      const { default: fallback, max } = WORKFLOW_LIMITS.httpTimeoutSeconds;
      const seconds = node.config.timeoutSeconds ?? (nodeMinutes !== undefined ? nodeMinutes * 60 : fallback);
      return Math.min(seconds, max) * 1000;
    }
    case "agent": {
      const { default: fallback, max } = WORKFLOW_LIMITS.agentMaxMinutes;
      return Math.min(nodeMinutes ?? node.config.maxMinutes ?? fallback, max) * MINUTE;
    }
    case "wait":
      return WORKFLOW_LIMITS.waitMaxMinutes * MINUTE;
    case "workflow":
      return nodeMinutes !== undefined ? nodeMinutes * MINUTE : Number.POSITIVE_INFINITY;
    default:
      return (nodeMinutes ?? 5) * MINUTE;
  }
}

export function maxTriesOf(node: WorkflowNode): number {
  const tries = node.retry?.maxTries;
  return typeof tries === "number" && tries >= 1 ? Math.min(10, Math.floor(tries)) : 1;
}

export function retryDelayMs(node: WorkflowNode): number {
  const seconds = node.retry?.delaySeconds;
  return typeof seconds === "number" && seconds > 0 ? Math.min(3600, seconds) * 1000 : 0;
}

// ---------------------------------------------------------------------------
// Waiting on the wall clock
// ---------------------------------------------------------------------------

/** Re-armed at most this far ahead, so a clock jump is absorbed within a minute. */
const MAX_TIMER_STEP_MS = 60_000;

/**
 * Resolves true once the wall clock reaches `until`, false when `signal` aborts first. Re-arms in
 * steps of at most a minute and reads the clock each time — a restart or a clock jump never
 * stretches a deadline.
 */
export function sleepUntil(clock: Clock, until: Date, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    let timer: { cancel(): void } | null = null;
    const onAbort = (): void => {
      timer?.cancel();
      resolve(false);
    };
    const arm = (): void => {
      const left = until.getTime() - clock.now().getTime();
      if (left <= 0) {
        signal.removeEventListener("abort", onAbort);
        resolve(true);
        return;
      }
      timer = clock.setTimeout(arm, Math.min(left, MAX_TIMER_STEP_MS));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    arm();
  });
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

/** JSON text of a value; undefined for `undefined`; null when it cannot be serialized. */
export function jsonText(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

/** The first `maxBytes` UTF-8 bytes of `text`, never splitting a character. */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const buf = Buffer.from(text, "utf8");
  let end = Math.max(0, maxBytes);
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString("utf8");
}

/** The last `maxBytes` UTF-8 bytes of `text`, never splitting a character. */
export function tailUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  let start = buf.length - Math.max(0, maxBytes);
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start += 1;
  return buf.subarray(start).toString("utf8");
}

/** The inline preview of an output too big to inline: its text (a string's own, else pretty JSON), cut. */
export function outputPreview(value: unknown, maxBytes: number): string {
  const text = typeof value === "string" ? value : (() => {
    try {
      return JSON.stringify(value, null, 2) ?? "";
    } catch {
      return "";
    }
  })();
  return `${truncateUtf8(text, Math.max(0, maxBytes - 64))}\n… (truncated — the whole output is available separately)`;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export function toRunSummary(run: PersistedRun): WorkflowRunSummary {
  const summary: WorkflowRunSummary = {
    id: run.id,
    workflowId: run.workflowId,
    workflowName: run.workflowName,
    status: run.status,
    trigger: { ...run.trigger },
    test: run.test,
    queuedAt: run.queuedAt
  };
  if (run.skipReason !== undefined) summary.skipReason = run.skipReason;
  if (run.startedAt !== undefined) summary.startedAt = run.startedAt;
  if (run.endedAt !== undefined) summary.endedAt = run.endedAt;
  if (run.durationMs !== undefined) summary.durationMs = run.durationMs;
  if (run.current !== undefined) summary.current = { ...run.current };
  if (run.error !== undefined) summary.error = run.error;
  if (run.projectPath !== undefined) summary.projectPath = run.projectPath;
  if (run.tempProject !== undefined) summary.tempProject = { ...run.tempProject };
  if (run.parentRunId !== undefined) summary.parentRunId = run.parentRunId;
  if (run.retryOf !== undefined) summary.retryOf = run.retryOf;
  return summary;
}

/** A block as it crosses the wire: no `waitingOn`, no output file path. */
export function publicBlock(block: PersistedBlockState): WorkflowBlockRun {
  const { waitingOn: _waitingOn, outputFile: _outputFile, ...rest } = block;
  void _waitingOn;
  void _outputFile;
  return structuredClone(rest);
}

export function publicRun(run: PersistedRun): WorkflowRun {
  const blocks: Record<string, WorkflowBlockRun> = {};
  for (const [id, block] of Object.entries(run.blocks)) blocks[id] = publicBlock(block);
  const out: WorkflowRun = {
    ...toRunSummary(run),
    definition: structuredClone(run.definition),
    triggerPayload: run.triggerPayload === null ? null : structuredClone(run.triggerPayload),
    blocks,
    takenEdges: [...run.takenEdges],
    deadEdges: [...run.deadEdges]
  };
  if (run.finalOutput !== undefined) out.finalOutput = structuredClone(run.finalOutput);
  return out;
}

export function isFinishedBlockStatus(status: WorkflowBlockRun["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "skipped" || status === "cancelled";
}
