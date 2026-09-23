/**
 * Agent chat — the subagent roster fold (spec §7.6).
 *
 * Ported from T3 Code (MIT): `packages/client-runtime/src/state/subagentRuntime.ts`.
 *
 * Rules the implementation owes:
 * - the fold is keyed by `taskId` and carries the linkage bundle the task
 *   events repeat on **every** row, so it survives activity retention even if
 *   the `task.started` row aged out;
 * - metadata is **never downgraded to null** by a later partial event;
 * - a `task.completed {status: "stopped"}` folds to `interrupted`;
 * - when the session is not live, every still-**active** row becomes
 *   `interrupted`, while an `idle` row is left alone (a resumable child stays
 *   resumable);
 * - the roster is capped at {@link ROSTER_LIMIT}, evicting live rows last and
 *   newest-settled first, and updates must **never reshuffle rows that remain
 *   visible**.
 *
 * **Differs from T3 in one deliberate way (§7.6).** T3 drops background rows
 * from the roster entirely ("a 'Run 12s stall' shell is not a subagent") and
 * renders them as ordinary work-log rows. This design lists them in the same
 * roster with a distinct icon, so the fold keeps them and stamps
 * {@link RuntimeSubagent.agentKind} instead of breaking out.
 */

import type {
  RuntimeTaskStatus,
  TaskRunHandles,
  TaskWorkflowPhase
} from "./runtime-events.ts";
import type {
  AgentPanelModel,
  AgentPanelWorkflowGroup,
  RuntimeSubagent,
  RuntimeSubagentStatus,
  SubagentActivityEntry,
  SubagentUsage,
  ThreadActivityItem
} from "./thread.ts";
import { ACTIVE_SUBAGENT_STATUSES, ROSTER_LIMIT, TERMINAL_SUBAGENT_STATUSES } from "./thread.ts";

const RECENT_ACTIVITY_LIMIT = 6;
const SUMMARY_CHAR_LIMIT = 180;

/**
 * True when this activity's payload does NOT belong on the roster as an agent.
 * Classification happens exactly once, host-side at ingestion
 * (`classifyTaskAgentKind` → the persisted `agentKind` stamp); this only reads
 * it. Rows without a stamp are background by definition.
 *
 * *T3: `state/subagentRuntime.ts:110-112`.*
 */
export function isBackgroundTaskActivity(payload: Record<string, unknown>): boolean {
  return payload.agentKind !== "agent";
}

function isTerminal(status: RuntimeSubagentStatus): boolean {
  return TERMINAL_SUBAGENT_STATUSES.has(status);
}

function isActive(status: RuntimeSubagentStatus): boolean {
  return ACTIVE_SUBAGENT_STATUSES.has(status);
}

function bounded(value: string): string {
  return value.length <= SUMMARY_CHAR_LIMIT ? value : `${value.slice(0, SUMMARY_CHAR_LIMIT - 1)}…`;
}

/** Appends to the ring buffer, deduping consecutive identical summaries. */
function appendActivity(
  entries: readonly SubagentActivityEntry[],
  at: string,
  summary: string
): SubagentActivityEntry[] {
  const boundedSummary = bounded(summary);
  if (entries.length > 0 && entries[entries.length - 1]?.summary === boundedSummary) {
    return entries as SubagentActivityEntry[];
  }
  const next = [...entries, { at, summary: boundedSummary }];
  return next.length > RECENT_ACTIVITY_LIMIT ? next.slice(-RECENT_ACTIVITY_LIMIT) : next;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asUsage(value: unknown): SubagentUsage | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const totalTokens = asCount(record.totalTokens);
  if (totalTokens === undefined) {
    return undefined;
  }
  const usage: SubagentUsage = { totalTokens };
  const inputTokens = asCount(record.inputTokens);
  if (inputTokens !== undefined) usage.inputTokens = inputTokens;
  const cachedInputTokens = asCount(record.cachedInputTokens);
  if (cachedInputTokens !== undefined) usage.cachedInputTokens = cachedInputTokens;
  const outputTokens = asCount(record.outputTokens);
  if (outputTokens !== undefined) usage.outputTokens = outputTokens;
  const reasoningOutputTokens = asCount(record.reasoningOutputTokens);
  if (reasoningOutputTokens !== undefined) usage.reasoningOutputTokens = reasoningOutputTokens;
  const toolUses = asCount(record.toolUses);
  if (toolUses !== undefined) usage.toolUses = toolUses;
  const durationMs = asCount(record.durationMs);
  if (durationMs !== undefined) usage.durationMs = durationMs;
  return usage;
}

/**
 * Field-wise maximum merge. Cumulative totals never shrink, duplicate or late
 * frames are idempotent, and a terminal payload carrying only `totalTokens`
 * must not wipe a known breakdown.
 *
 * *T3: `state/subagentRuntime.ts:192-234`.*
 */
function mergeUsageMax(
  current: SubagentUsage | null,
  incoming: SubagentUsage | undefined
): SubagentUsage | null {
  if (!incoming) return current;
  if (!current) return incoming;
  const pick = (a: number | undefined, b: number | undefined): number | undefined =>
    a === undefined ? b : b === undefined ? a : Math.max(a, b);
  const merged: SubagentUsage = {
    totalTokens: Math.max(current.totalTokens, incoming.totalTokens)
  };
  const inputTokens = pick(current.inputTokens, incoming.inputTokens);
  if (inputTokens !== undefined) merged.inputTokens = inputTokens;
  const cachedInputTokens = pick(current.cachedInputTokens, incoming.cachedInputTokens);
  if (cachedInputTokens !== undefined) merged.cachedInputTokens = cachedInputTokens;
  const outputTokens = pick(current.outputTokens, incoming.outputTokens);
  if (outputTokens !== undefined) merged.outputTokens = outputTokens;
  const reasoningOutputTokens = pick(
    current.reasoningOutputTokens,
    incoming.reasoningOutputTokens
  );
  if (reasoningOutputTokens !== undefined) merged.reasoningOutputTokens = reasoningOutputTokens;
  const toolUses = pick(current.toolUses, incoming.toolUses);
  if (toolUses !== undefined) merged.toolUses = toolUses;
  const durationMs = pick(current.durationMs, incoming.durationMs);
  if (durationMs !== undefined) merged.durationMs = durationMs;
  return merged;
}

type MutableAgent = {
  -readonly [K in keyof RuntimeSubagent]: RuntimeSubagent[K];
};

function kindFromPayload(
  payload: Record<string, unknown>,
  agentId: string
): RuntimeSubagent["kind"] {
  if (payload.taskType === "subagent_batch") {
    return "subagent_batch";
  }
  if (asString(payload.taskType) === "local_workflow") {
    return "workflow";
  }
  if (payload.parentAgentId !== undefined || agentId.includes(":wf:")) {
    return "workflow_agent";
  }
  return "subagent";
}

/**
 * The task description, under either spelling: this design's task payloads
 * name it `description` (§4.2), T3's name it `detail`.
 */
function taskDescription(payload: Record<string, unknown>): string | undefined {
  return asString(payload.description) ?? asString(payload.detail);
}

/**
 * A task's agent, created by the task's FIRST `task.*` row of any of the four
 * kinds — completion can create an agent too (its start may have aged out of
 * retention). `tool.progress` never creates one.
 */
function createAgent(id: string, payload: Record<string, unknown>, at: string): MutableAgent {
  return {
    id,
    kind: kindFromPayload(payload, id),
    agentKind: payload.agentKind === "agent" ? "agent" : "background",
    title: asString(payload.title) ?? taskDescription(payload) ?? id,
    role: asString(payload.role) ?? null,
    model: asString(payload.model) ?? null,
    effort: asString(payload.effort) ?? null,
    status: "pending",
    activationCount: 0,
    usage: null,
    progress: null,
    lastToolName: null,
    result: null,
    error: null,
    outputFile: null,
    exitCode: null,
    isBackgrounded: typeof payload.isBackgrounded === "boolean" ? payload.isBackgrounded : null,
    parentAgentId: asString(payload.parentAgentId) ?? null,
    agentIndex: asCount(payload.agentIndex) ?? null,
    phaseIndex: asCount(payload.phaseIndex) ?? null,
    phaseTitle: asString(payload.phaseTitle) ?? null,
    attempt: asCount(payload.attempt) ?? null,
    workflowName: asString(payload.workflowName) ?? null,
    phases: [],
    runHandles: null,
    recentActivity: [],
    firstSeenAt: at,
    startedAt: null,
    completedAt: null,
    updatedAt: at
  };
}

/** Metadata fill from any payload: never downgrades known values to null. */
function fillMetadata(agent: MutableAgent, payload: Record<string, unknown>): void {
  if (payload.taskType === "subagent_batch") agent.kind = "subagent_batch";
  // Sticky per taskId: a later row with no stamp must not demote a known
  // agent to background, but a row that names it `agent` promotes one.
  if (payload.agentKind === "agent") agent.agentKind = "agent";
  const title = asString(payload.title);
  if (title) agent.title = title;
  const role = asString(payload.role);
  if (role) agent.role = role;
  const model = asString(payload.model);
  if (model) agent.model = model;
  const effort = asString(payload.effort);
  if (effort) agent.effort = effort;
  const parentAgentId = asString(payload.parentAgentId);
  if (parentAgentId) {
    agent.parentAgentId = parentAgentId;
    if (agent.kind === "subagent") agent.kind = "workflow_agent";
  }
  const workflowName = asString(payload.workflowName);
  if (workflowName) agent.workflowName = workflowName;
  if (asString(payload.taskType) === "local_workflow") agent.kind = "workflow";
  const agentIndex = asCount(payload.agentIndex);
  if (agentIndex !== undefined) agent.agentIndex = agentIndex;
  const phaseIndex = asCount(payload.phaseIndex);
  if (phaseIndex !== undefined) agent.phaseIndex = phaseIndex;
  const phaseTitle = asString(payload.phaseTitle);
  if (phaseTitle) agent.phaseTitle = phaseTitle;
  const attempt = asCount(payload.attempt);
  if (attempt !== undefined) {
    // A new attempt on a workflow slot is a reactivation of the same identity:
    // clear the previous attempt's terminal detail so the status transition
    // (terminal → running, in applyStatus) reads as a fresh run. The
    // activation bump lives ONLY in applyStatus — bumping here too counted
    // every retry twice.
    if (agent.attempt !== null && attempt > agent.attempt) {
      agent.result = null;
      agent.error = null;
      agent.completedAt = null;
    }
    agent.attempt = attempt;
  }
  const outputFile = asString(payload.outputFile);
  if (outputFile) agent.outputFile = outputFile;
  // Sticky upwards: a task that was moved to the background (Ctrl+B) stays
  // background; a later row that omits the flag never demotes it.
  if (payload.isBackgrounded === true) agent.isBackgrounded = true;
  else if (payload.isBackgrounded === false && agent.isBackgrounded === null) {
    agent.isBackgrounded = false;
  }
  // Any integer: a shell killed by a signal reports a negative code.
  const exitCode = payload.exitCode;
  if (typeof exitCode === "number" && Number.isInteger(exitCode)) {
    agent.exitCode = exitCode;
  }
  if (Array.isArray(payload.phases)) {
    const phases: TaskWorkflowPhase[] = [];
    for (const entry of payload.phases) {
      const record = asRecord(entry);
      if (!record) continue;
      const index = asCount(record.index);
      const phaseName = asString(record.title);
      if (index !== undefined && phaseName) {
        phases.push({ index, title: phaseName });
      }
    }
    if (phases.length > 0) {
      agent.phases = phases.slice().sort((a, b) => a.index - b.index);
    }
  }
  const runHandlesRecord = asRecord(payload.runHandles);
  if (runHandlesRecord) {
    const runHandles: TaskRunHandles = {};
    const runId = asString(runHandlesRecord.runId);
    if (runId) runHandles.runId = runId;
    const scriptPath = asString(runHandlesRecord.scriptPath);
    if (scriptPath) runHandles.scriptPath = scriptPath;
    const transcriptDir = asString(runHandlesRecord.transcriptDir);
    if (transcriptDir) runHandles.transcriptDir = transcriptDir;
    // Defence in depth: the adapter already sanitises, but payloads are not
    // schema-validated on the read path.
    const sessionUrl = asString(runHandlesRecord.sessionUrl);
    if (sessionUrl && /^https?:\/\//i.test(sessionUrl)) runHandles.sessionUrl = sessionUrl;
    if (Object.keys(runHandles).length > 0) {
      agent.runHandles = { ...agent.runHandles, ...runHandles };
    }
  }
}

function applyStatus(agent: MutableAgent, status: RuntimeSubagentStatus, at: string): void {
  const wasTerminal = isTerminal(agent.status);
  const nextIsTerminal = isTerminal(status);
  if (wasTerminal && nextIsTerminal) {
    // Duplicate terminal events are idempotent: first write wins, timestamps
    // do not slide.
    return;
  }
  if ((wasTerminal || agent.status === "idle") && (status === "running" || status === "pending")) {
    // Reactivation: same identity, new run. Clear the previous run's terminal
    // detail so a live card never shows the prior run's output.
    agent.activationCount += 1;
    agent.result = null;
    agent.error = null;
    agent.completedAt = null;
    if (status === "running") {
      agent.startedAt = at;
    }
  }
  if (status === "running" && agent.startedAt === null) {
    agent.startedAt = at;
  }
  if (nextIsTerminal && agent.completedAt === null) {
    agent.completedAt = at;
  }
  agent.status = status;
}

/**
 * Map, not object literal: payloads are not schema-validated on the read path,
 * so a status like `"toString"` must miss instead of resolving an inherited
 * `Function` through the prototype chain.
 *
 * *T3: `state/subagentRuntime.ts:426-433`.*
 */
const TASK_COMPLETED_STATUS: ReadonlyMap<string, RuntimeSubagentStatus> = new Map([
  ["completed", "completed"],
  ["failed", "failed"],
  ["stopped", "interrupted"]
]);

const KNOWN_STATUSES: ReadonlySet<string> = new Set<RuntimeTaskStatus>([
  "pending",
  "running",
  "waiting",
  "idle",
  "completed",
  "failed",
  "cancelled",
  "interrupted"
]);

function asRuntimeStatus(value: unknown): RuntimeSubagentStatus | undefined {
  return typeof value === "string" && KNOWN_STATUSES.has(value)
    ? (value as RuntimeSubagentStatus)
    : undefined;
}

/**
 * The kinds the roster reads. Every other kind folds to nothing, and so does a
 * row of these kinds whose payload is not a record or names no task
 * ({@link rosterTaskId}).
 */
const ROSTER_ACTIVITY_KINDS: ReadonlySet<string> = new Set([
  "task.started",
  "task.progress",
  "task.updated",
  "task.completed",
  "tool.progress"
]);

/**
 * The task a row belongs to on the roster — its trimmed `taskId` — or
 * `undefined` when the roster ignores the row: exactly the rows every arm of
 * {@link applyTaskRow} would skip. The trim matters: `" t1 "` and `"t1"` are
 * one task, as they always were.
 */
function rosterTaskId(activity: ThreadActivityItem): string | undefined {
  if (!ROSTER_ACTIVITY_KINDS.has(activity.activityKind)) {
    return undefined;
  }
  const payload = asRecord(activity.payload);
  return payload === null ? undefined : asString(payload.taskId);
}

/**
 * One task's fold in progress: what {@link applyTaskRow} reads and writes. The
 * caller owns `agent` — a fresh object, or a COPY of a fold an engine already
 * holds — because the row mutates it in place.
 */
interface TaskCursor {
  /** `null` until the task's first `task.*` row creates the agent. */
  agent: MutableAgent | null;
  /**
   * The launching tool call of the task's LATEST run. A resumed subagent
   * keeps its task id but is launched by a new tool call, and that is the
   * only thing that tells a genuine resume apart from a late start row.
   *
   * Read off `task.started` rows ONLY. Progress rows carry stable ids
   * (`task-progress:…`, `task-usage:…`) and are replaced in place, so in list
   * order a progress row of the relaunched run — already naming the NEW call
   * — sits BEFORE the killed run's terminal row; reading the call off it made
   * the resume's start row look unchanged, and the row stayed `interrupted`
   * for as long as the agent worked (owner incident 2026-09-23: a host
   * restart under three running subagents, all relaunched by the agent).
   */
  lastToolUseId: string | undefined;
}

/**
 * Fold ONE roster row into ONE task's state — the body of the roster fold.
 * `taskId` is {@link rosterTaskId} of `activity` and `payload` its payload,
 * already known to be a record.
 *
 * Every arm reads and writes `cursor` alone, the state of the row's OWN task:
 * no arm looks at another task's agent or launching call, and the output order
 * is decided by which row creates each agent, not by anything an arm reads. So
 * the roster is the per-task fold of each task's rows in list order, followed
 * by the cross-task post-passes of {@link rosterFromEngine} — which is what
 * lets the engine refold one task instead of the list (design
 * `2026-09-23-fold-performance-design.md` §A3).
 */
function applyTaskRow(
  cursor: TaskCursor,
  taskId: string,
  activity: ThreadActivityItem,
  payload: Record<string, unknown>
): void {
  const at = activity.createdAt;

  switch (activity.activityKind) {
    case "task.started": {
      const agent = (cursor.agent ??= createAgent(taskId, payload, at));
      fillMetadata(agent, payload);
      // Order-robustness: a start row arriving after a terminal state is a
      // late/out-of-order delivery and only fills metadata — it must not
      // reopen the run. Guard on the status itself, not activationCount: a
      // task first seen via a terminal `task.updated` has zero activations
      // but is still settled.
      //
      // EXCEPT a resume. Claude resumes a subagent under the SAME task id
      // (owner incident 2026-09-22: two agents cut by a rate limit, resumed,
      // one of them finished — and the roster read "failed" for both until
      // the tab was closed, because the first terminal write had won). The
      // resume's start row names a NEW launching tool call, a late delivery
      // of the old run names the old one, so a changed `toolUseId` reopens
      // the row as a new activation and an unchanged one does not.
      const toolUseId = asString(payload.toolUseId);
      const previousToolUseId = cursor.lastToolUseId;
      const resumed =
        isTerminal(agent.status) &&
        toolUseId !== undefined &&
        previousToolUseId !== undefined &&
        toolUseId !== previousToolUseId;
      if (agent.activationCount === 0 && !isTerminal(agent.status)) {
        agent.activationCount = 1;
        agent.startedAt = agent.startedAt ?? at;
        agent.status = "running";
      } else if (agent.status === "idle" || resumed) {
        applyStatus(agent, "running", at);
      }
      const description = taskDescription(payload);
      if (description && agent.title === agent.id) agent.title = description;
      agent.updatedAt = at;
      break;
    }
    case "task.progress": {
      const existed = cursor.agent !== null;
      const agent = (cursor.agent ??= createAgent(taskId, payload, at));
      fillMetadata(agent, payload);
      if (agent.activationCount === 0) agent.activationCount = 1;
      const explicitStatus = asRuntimeStatus(payload.status);
      if (explicitStatus) {
        applyStatus(agent, explicitStatus, at);
      } else if (
        (payload.usageSnapshot !== true || !existed) &&
        !isTerminal(agent.status) &&
        agent.status !== "idle"
      ) {
        applyStatus(agent, "running", at);
      }
      const summary = asString(payload.summary);
      if (summary) {
        agent.progress = bounded(summary);
        agent.recentActivity = appendActivity(agent.recentActivity, at, summary);
      }
      const lastToolName = asString(payload.lastToolName);
      if (lastToolName) {
        agent.lastToolName = lastToolName;
        if (!summary) {
          agent.recentActivity = appendActivity(agent.recentActivity, at, `▸ ${lastToolName}`);
        }
      }
      const error = asString(payload.error);
      if (error) agent.error = bounded(error);
      agent.usage = mergeUsageMax(
        agent.usage,
        asUsage(payload.usage) ?? asUsage(payload.typedUsage)
      );
      agent.updatedAt = at;
      break;
    }
    case "task.updated": {
      const agent = (cursor.agent ??= createAgent(taskId, payload, at));
      fillMetadata(agent, payload);
      const description = taskDescription(payload);
      if (description) agent.progress = bounded(description);
      // A task first seen via `task.updated` (its start row aged out) has run
      // at least once — zero activations would misreport "run 0" and let a
      // later start row treat it as never-started.
      if (agent.activationCount === 0) agent.activationCount = 1;
      const wasTerminal = isTerminal(agent.status);
      const status = asRuntimeStatus(payload.status);
      if (status) applyStatus(agent, status, at);
      const error = asString(payload.error);
      if (error) agent.error = bounded(error);
      // Provider end time beats ingestion time for the transition that
      // actually settled the run.
      const endedAt = asString(payload.endedAt);
      if (endedAt && !wasTerminal && isTerminal(agent.status)) {
        agent.completedAt = endedAt;
      }
      agent.updatedAt = at;
      break;
    }
    case "task.completed": {
      const agent = (cursor.agent ??= createAgent(taskId, payload, at));
      fillMetadata(agent, payload);
      if (agent.activationCount === 0) agent.activationCount = 1;
      // Already-terminal: status and timestamps are frozen (first write
      // wins) but the completion still ENRICHES — Claude commonly emits a
      // terminal `task.updated` before `task.completed`, and the completion
      // carries the result summary and final usage the update lacked.
      const summary = asString(payload.summary) ?? taskDescription(payload);
      const incomingUsage = asUsage(payload.usage) ?? asUsage(payload.typedUsage);
      if (isTerminal(agent.status)) {
        if (summary) {
          if (agent.status === "failed") {
            agent.error = agent.error ?? bounded(summary);
          } else {
            agent.result = agent.result ?? bounded(summary);
          }
        }
        agent.usage = mergeUsageMax(agent.usage, incomingUsage);
        break;
      }
      const status = TASK_COMPLETED_STATUS.get(asString(payload.status) ?? "") ?? "completed";
      applyStatus(agent, status, at);
      if (summary) {
        if (status === "failed") {
          agent.error = agent.error ?? bounded(summary);
        } else {
          agent.result = bounded(summary);
        }
      }
      agent.usage = mergeUsageMax(agent.usage, incomingUsage);
      agent.updatedAt = at;
      break;
    }
    case "tool.progress": {
      // Agent-owned heartbeat: "what it's doing right now". It never creates
      // the agent — a heartbeat before the task's first `task.*` row is inert.
      const agent = cursor.agent;
      if (!agent) break;
      const toolName = asString(payload.toolName);
      if (toolName) {
        agent.lastToolName = toolName;
        agent.recentActivity = appendActivity(agent.recentActivity, at, `▸ ${toolName}`);
      }
      agent.updatedAt = at;
      break;
    }
    default:
      break;
  }

  if (activity.activityKind === "task.started") {
    const toolUseId = asString(payload.toolUseId);
    if (toolUseId) cursor.lastToolUseId = toolUseId;
  }
}

/**
 * Fold the thread's `task.*` activities into roster rows. Tolerant by
 * construction: malformed rows are skipped individually, unknown kinds are
 * ignored. Pure — memoise by activity-list identity at the store layer.
 *
 * `sessionLive: false` derives interruption: background tasks die with their
 * provider session, so agents whose terminal rows were lost (host restart,
 * crash) must not read as running forever. `idle` is preserved — a resumable
 * child stays resumable.
 *
 * It is a fresh {@link RosterEngine} read once, so the engine's invariant —
 * an engine's roster is this fold of the list it stands for — holds by
 * construction for a fresh engine, and the incremental paths are
 * property-tested against it (design `2026-09-23-fold-performance-design.md`
 * §A3).
 */
export function foldSubagentActivities(
  activities: readonly ThreadActivityItem[],
  options?: { readonly sessionLive?: boolean }
): RuntimeSubagent[] {
  return rosterFromEngine(createRosterEngine(activities), options);
}

// ---------------------------------------------------------------------------
// The incremental roster (design `2026-09-23-fold-performance-design.md` §A3)
// ---------------------------------------------------------------------------

/**
 * The incremental form of {@link foldSubagentActivities}: what the thread fold
 * keeps between events so a task row costs that task's rows, not the whole
 * activity list. **Opaque** — callers never read it — and **immutable**: no
 * operation mutates its input engine or any row. Each returns a new engine, or
 * the same one when the change is nothing the roster reads.
 *
 * The invariant every operation keeps: for the activity list L an engine
 * stands for — the list it was created from, with every append applied at the
 * end and every replacement applied in place —
 * `rosterFromEngine(engine, options)` deep-equals
 * `foldSubagentActivities(L, options)`.
 */
export interface RosterEngine {
  readonly kind: "roster-engine";
}

/**
 * One task's share of the list an engine stands for: its roster rows and
 * their fold. **Never mutated once an engine holds it** — a later row folds
 * onto a copy — because it is shared by every engine derived from the one
 * that made it, and its `agent` may already be on screen as a roster row.
 */
interface TaskFold {
  readonly taskId: string;
  /** Every row of this task {@link rosterTaskId} accepts, in list order, by identity. */
  readonly rows: readonly ThreadActivityItem[];
  /** The fold of `rows`; `null` while only `tool.progress` rows are known — no agent yet. */
  readonly agent: RuntimeSubagent | null;
  /** {@link TaskCursor.lastToolUseId} after `rows`. */
  readonly lastToolUseId: string | undefined;
  /**
   * The creation ordinal: the agent's index in {@link TaskRosterEngine.created},
   * i.e. the list order of the row that created it among every creating row.
   * `-1` while `agent` is `null`.
   */
  readonly ordinal: number;
}

/** What an engine is behind the opaque {@link RosterEngine}. */
interface TaskRosterEngine extends RosterEngine {
  /**
   * Every task that has an agent, by creation ordinal: the order in which the
   * list's rows create agents, which is the roster's order before the cap. It
   * never needs re-sorting: an append lands at the END of the list, so an
   * agent it creates comes after every existing one; and a replacement keeps
   * the row's kind and task, so the same row still creates the agent (see
   * {@link rosterEngineReplace}).
   */
  readonly created: readonly TaskFold[];
  /**
   * Task id → ordinal for every created task. Copied only when an agent is
   * created: an update of a known task copies `created` — a flat array, ~50 ns
   * for a 56-task fleet — never a map, which costs ~100 times that.
   */
  readonly ordinals: ReadonlyMap<string, number>;
  /** Tasks with rows but no agent yet: only `tool.progress` rows so far. */
  readonly uncreated: ReadonlyMap<string, TaskFold>;
  /**
   * Shared by every engine grown from one {@link createRosterEngine} call, and
   * only the key of that lineage's last cap ranking ({@link capRankings}).
   */
  readonly lineage: object;
}

/** A {@link TaskFold} while {@link createRosterEngine} builds it; sealed on return. */
interface TaskFoldBuild extends TaskCursor {
  readonly taskId: string;
  readonly rows: ThreadActivityItem[];
  ordinal: number;
}

function engineState(engine: RosterEngine): TaskRosterEngine {
  return engine as TaskRosterEngine;
}

function taskFoldOf(engine: TaskRosterEngine, taskId: string): TaskFold | undefined {
  const ordinal = engine.ordinals.get(taskId);
  return ordinal !== undefined ? engine.created[ordinal] : engine.uncreated.get(taskId);
}

/**
 * The engine with `previous` — the task's current fold, if any — replaced by
 * the fold of `rows`. Shares everything else with `engine`.
 */
function withTaskFold(
  engine: TaskRosterEngine,
  previous: TaskFold | undefined,
  taskId: string,
  rows: readonly ThreadActivityItem[],
  cursor: TaskCursor
): TaskRosterEngine {
  const { agent, lastToolUseId } = cursor;
  if (previous !== undefined && previous.ordinal !== -1) {
    const created = engine.created.slice();
    created[previous.ordinal] = { taskId, rows, agent, lastToolUseId, ordinal: previous.ordinal };
    return { ...engine, created };
  }
  if (agent === null) {
    const uncreated = new Map(engine.uncreated);
    uncreated.set(taskId, { taskId, rows, agent, lastToolUseId, ordinal: -1 });
    return { ...engine, uncreated };
  }
  // A new agent. Only an append gets here, so its creating row is the newest
  // row of the list and the agent goes last.
  const ordinal = engine.created.length;
  const created = [...engine.created, { taskId, rows, agent, lastToolUseId, ordinal }];
  const ordinals = new Map(engine.ordinals);
  ordinals.set(taskId, ordinal);
  let uncreated = engine.uncreated;
  if (uncreated.has(taskId)) {
    const remaining = new Map(uncreated);
    remaining.delete(taskId);
    uncreated = remaining;
  }
  return { ...engine, created, ordinals, uncreated };
}

/** An engine standing for `activities` (the list is not retained by reference). */
export function createRosterEngine(activities: readonly ThreadActivityItem[]): RosterEngine {
  const created: TaskFoldBuild[] = [];
  const ordinals = new Map<string, number>();
  const uncreated = new Map<string, TaskFoldBuild>();
  for (const activity of activities) {
    const taskId = rosterTaskId(activity);
    if (taskId === undefined) continue;
    const ordinal = ordinals.get(taskId);
    const known = ordinal !== undefined ? created[ordinal] : uncreated.get(taskId);
    // While building, a task's fold is mutated in place: nothing can have
    // seen it yet. It is sealed — never written again — once returned.
    const task: TaskFoldBuild = known ?? {
      taskId,
      rows: [],
      agent: null,
      lastToolUseId: undefined,
      ordinal: -1
    };
    task.rows.push(activity);
    applyTaskRow(task, taskId, activity, activity.payload as Record<string, unknown>);
    if (task.ordinal !== -1) continue;
    if (task.agent !== null) {
      task.ordinal = created.length;
      created.push(task);
      ordinals.set(taskId, task.ordinal);
      if (known !== undefined) uncreated.delete(taskId);
    } else if (known === undefined) {
      uncreated.set(taskId, task);
    }
  }
  const engine: TaskRosterEngine = {
    kind: "roster-engine",
    created,
    ordinals,
    uncreated,
    lineage: {}
  };
  return engine;
}

/** `activity` was appended at the END of the list the engine stands for. */
export function rosterEngineAppend(engine: RosterEngine, activity: ThreadActivityItem): RosterEngine {
  const taskId = rosterTaskId(activity);
  if (taskId === undefined) {
    // The roster never reads this row: the engine stands for the new list as
    // it is, and returning it lets the caller keep everything by identity.
    return engine;
  }
  const state = engineState(engine);
  const task = taskFoldOf(state, taskId);
  // Copy-on-write: the stored agent is shared with `engine` and possibly on
  // screen. Every nested value the arms replace (activity ring, usage,
  // phases, run handles) is replaced whole, never written into, so a shallow
  // copy is a private one.
  const agent = task === undefined ? null : task.agent;
  const cursor: TaskCursor = {
    agent: agent === null ? null : { ...agent },
    lastToolUseId: task?.lastToolUseId
  };
  applyTaskRow(cursor, taskId, activity, activity.payload as Record<string, unknown>);
  const rows = task === undefined ? [activity] : [...task.rows, activity];
  return withTaskFold(state, task, taskId, rows, cursor);
}

/**
 * `previous` — a row of the engine's list, by identity — was replaced IN PLACE
 * by `next`: same list position. `null` when the engine cannot apply that
 * change incrementally; the caller then rebuilds with
 * {@link createRosterEngine} over its current list. Never throws.
 *
 * Applied incrementally — the swapped row's task refolded alone — only when
 * both rows are roster rows of the SAME kind and the SAME task, which keeps
 * the rest of the engine valid: a `task.*` row creates its agent whatever its
 * payload says and a `tool.progress` row never does, so the same row still
 * creates the agent and the creation order stands. `null` for a change of
 * roster relevance, of task or of kind (a row the engine does not hold cannot
 * be placed among its task's rows), and for a `previous` the engine does not
 * hold — or holds twice, when which copy was replaced is unknowable. A change
 * between two rows the roster ignores is no change at all: the same engine.
 */
export function rosterEngineReplace(
  engine: RosterEngine,
  previous: ThreadActivityItem,
  next: ThreadActivityItem
): RosterEngine | null {
  if (!isObject(previous) || !isObject(next)) return null;
  const taskId = rosterTaskId(previous);
  const nextTaskId = rosterTaskId(next);
  if (taskId === undefined && nextTaskId === undefined) return engine;
  if (
    taskId === undefined ||
    nextTaskId !== taskId ||
    next.activityKind !== previous.activityKind
  ) {
    return null;
  }
  const state = engineState(engine);
  const task = taskFoldOf(state, taskId);
  if (task === undefined) return null;
  const at = task.rows.indexOf(previous);
  if (at === -1 || task.rows.indexOf(previous, at + 1) !== -1) return null;
  if (next === previous) return engine;
  const rows = task.rows.slice();
  rows[at] = next;
  const cursor = foldTaskRows(taskId, rows);
  // Guaranteed by the same-kind rule above; checked rather than assumed,
  // because a wrong ordinal would reorder the roster silently.
  if ((cursor.agent === null) !== (task.agent === null)) return null;
  return withTaskFold(state, task, taskId, rows, cursor);
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

/** A task's fold from scratch: its rows, in list order, through {@link applyTaskRow}. */
function foldTaskRows(taskId: string, rows: readonly ThreadActivityItem[]): TaskCursor {
  const cursor: TaskCursor = { agent: null, lastToolUseId: undefined };
  for (const row of rows) {
    const payload = asRecord(row.payload);
    if (payload !== null) applyTaskRow(cursor, taskId, row, payload);
  }
  return cursor;
}

/**
 * The roster the engine's list folds to: `foldSubagentActivities(list, options)`.
 *
 * O(tasks): each task's fold is already done, so only the cross-task
 * post-passes run here — the workflow cascade, session-death interruption,
 * the {@link ROSTER_LIMIT} cap. They may move three fields of a row (`status`,
 * `completedAt`, `updatedAt`) and work on copies of those, never on the folds:
 * a fold is shared with every engine derived from this one. A row the
 * post-passes leave alone IS its task's fold, so an agent whose task did not
 * change comes back as the same object on every read (the UI memoises rows by
 * identity); a row they move is reused while the same fold gets the same
 * result ({@link rosterRow}). Rows are therefore SHARED — between reads, and
 * with the engines — and a caller must never write one.
 */
export function rosterFromEngine(
  engine: RosterEngine,
  options?: { readonly sessionLive?: boolean }
): RuntimeSubagent[] {
  const { created, lineage } = engineState(engine);
  const count = created.length;
  const agents: RuntimeSubagent[] = new Array(count);
  const status: RuntimeSubagentStatus[] = new Array(count);
  const completedAt: Array<string | null> = new Array(count);
  const updatedAt: string[] = new Array(count);
  let hasWorkflow = false;
  for (let i = 0; i < count; i += 1) {
    const agent = created[i].agent!;
    agents[i] = agent;
    status[i] = agent.status;
    completedAt[i] = agent.completedAt;
    updatedAt[i] = agent.updatedAt;
    if (agent.kind === "workflow") hasWorkflow = true;
  }

  // Consistency pass: when a workflow coordinator has settled, members that
  // never received their own terminal row cannot still be in flight — the run
  // is over. Cascade the coordinator's outcome so stalled member rows do not
  // read as working forever.
  //
  // Order-sensitive exactly as it always was: coordinators are visited in
  // roster order and read the values an earlier cascade gave them, so a
  // nested coordinator settled by its parent cascades onward only when it
  // comes after that parent.
  if (hasWorkflow) {
    let membersOf: Map<string, number[]> | null = null;
    for (let w = 0; w < count; w += 1) {
      const workflow = agents[w];
      if (workflow.kind !== "workflow" || !isTerminal(status[w])) {
        continue;
      }
      membersOf ??= membersByParent(agents);
      const members = membersOf.get(workflow.id);
      if (members === undefined) continue;
      for (const m of members) {
        if (isTerminal(status[m]) || status[m] === "idle") continue;
        status[m] = status[w] === "completed" ? "completed" : "interrupted";
        completedAt[m] = completedAt[m] ?? completedAt[w] ?? updatedAt[w];
        updatedAt[m] = updatedAt[w];
      }
    }
  }

  // Session death orphans every live agent: no process remains to finish them.
  // Mirrors the host's liveness registry clearing on `session.exited`, so the
  // roster and the tab strip can never disagree.
  if (options?.sessionLive === false) {
    for (let i = 0; i < count; i += 1) {
      if (isActive(status[i])) {
        status[i] = "interrupted";
        completedAt[i] = completedAt[i] ?? updatedAt[i];
      }
    }
  }

  let keep: Uint8Array | null = null;
  if (count > ROSTER_LIMIT) {
    const ranked = capRanking(lineage, status, updatedAt);
    keep = new Uint8Array(count);
    for (let r = 0; r < ROSTER_LIMIT; r += 1) keep[ranked[r]] = 1;
  }

  // The rank decides WHICH rows survive; the original insertion order decides
  // the order they come back in. Returning the ranked array reordered every
  // surviving row the moment a thread crossed 100 agents — settled rows came
  // back newest-first — which is exactly the "never reshuffle rows that stay
  // visible" rule (§7.6).
  const roster: RuntimeSubagent[] = [];
  for (let i = 0; i < count; i += 1) {
    if (keep !== null && keep[i] === 0) continue;
    roster.push(rosterRow(agents[i], status[i], completedAt[i], updatedAt[i]));
  }
  return roster;
}

/**
 * Each lineage's last cap ranking ({@link capRanking}). Keyed by the lineage
 * token, never by an engine, so no engine is ever written.
 */
const capRankings = new WeakMap<object, readonly number[]>();

/**
 * Every roster index, best first — live, then idle, then settled, each newest
 * `updatedAt` first — of which the cap keeps the first {@link ROSTER_LIMIT}.
 * A live background row is never evicted ahead of a settled agent row (§7.6).
 *
 * The comparator is a STRICT total order: rank, then `updatedAt` by
 * `localeCompare`, newest first, then roster index. So the ranking is the one
 * sequence the sort reaches from any starting order, and it is exactly what
 * the stable sort of the roster-ordered indices by rank and `updatedAt` gave
 * (a stable sort leaves ties in roster order). That is what lets the sort
 * start from the lineage's previous ranking: a step moves one agent, the
 * previous ranking is in order but for it, and the sort — adaptive to runs —
 * costs ~n comparisons instead of ~n log n `localeCompare`s (measured with 150
 * agents: a whole fold step 88 → 45 µs). The previous ranking only ever speeds
 * the sort up; which ranking it holds, from which branch, cannot change the
 * result.
 */
function capRanking(
  lineage: object,
  status: readonly RuntimeSubagentStatus[],
  updatedAt: readonly string[]
): number[] {
  const count = status.length;
  const rank: number[] = new Array(count);
  for (let i = 0; i < count; i += 1) {
    rank[i] = isActive(status[i]) ? 0 : status[i] === "idle" ? 1 : 2;
  }
  const ranked: number[] = [];
  const placed = new Uint8Array(count);
  for (const i of capRankings.get(lineage) ?? []) {
    if (i < count && placed[i] === 0) {
      placed[i] = 1;
      ranked.push(i);
    }
  }
  for (let i = 0; i < count; i += 1) {
    if (placed[i] === 0) ranked.push(i);
  }
  ranked.sort((a, b) => rank[a] - rank[b] || updatedAt[b].localeCompare(updatedAt[a]) || a - b);
  capRankings.set(lineage, ranked);
  return ranked;
}

/** Each agent's roster index, grouped by the `parentAgentId` it names, in roster order. */
function membersByParent(agents: readonly RuntimeSubagent[]): Map<string, number[]> {
  const members = new Map<string, number[]>();
  for (let i = 0; i < agents.length; i += 1) {
    const parent = agents[i].parentAgentId;
    if (parent === null) continue;
    const list = members.get(parent);
    if (list === undefined) members.set(parent, [i]);
    else list.push(i);
  }
  return members;
}

/**
 * The last roster row the post-passes produced for a fold they moved. Keyed by
 * the fold, which never changes, so an entry is never stale — only replaced
 * when the same fold is moved differently (a session that died and came back).
 */
const movedRows = new WeakMap<RuntimeSubagent, RuntimeSubagent>();

/** The roster row for `agent` with the post-passes' values of the three fields they move. */
function rosterRow(
  agent: RuntimeSubagent,
  status: RuntimeSubagentStatus,
  completedAt: string | null,
  updatedAt: string
): RuntimeSubagent {
  if (
    status === agent.status &&
    completedAt === agent.completedAt &&
    updatedAt === agent.updatedAt
  ) {
    return agent;
  }
  const previous = movedRows.get(agent);
  if (
    previous !== undefined &&
    previous.status === status &&
    previous.completedAt === completedAt &&
    previous.updatedAt === updatedAt
  ) {
    return previous;
  }
  const row: RuntimeSubagent = { ...agent, status, completedAt, updatedAt };
  movedRows.set(agent, row);
  return row;
}

const EMPTY_PANEL_MODEL: AgentPanelModel = {
  workflows: [],
  directAgents: [],
  runningCount: 0,
  waitingCount: 0,
  idleCount: 0,
  settledCount: 0,
  totalTokens: 0,
  hasAgents: false,
  liveCount: 0
};

/** The empty panel model, returned when a thread has no agents. */
export function emptyAgentPanelModel(): AgentPanelModel {
  return EMPTY_PANEL_MODEL;
}

/** Group roster rows into the view model the panel and the spawn row read. */
export function deriveAgentPanelModel(input: {
  readonly agents: readonly RuntimeSubagent[];
}): AgentPanelModel {
  const source = input.agents;
  if (source.length === 0) {
    return EMPTY_PANEL_MODEL;
  }

  const workflows = source
    .filter((agent) => agent.kind === "workflow")
    .slice()
    .sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt) || a.id.localeCompare(b.id));
  const workflowIds = new Set(workflows.map((workflow) => workflow.id));
  const members = new Map<string, RuntimeSubagent[]>();
  const direct: RuntimeSubagent[] = [];

  for (const agent of source) {
    if (agent.kind === "workflow") continue;
    if (agent.parentAgentId !== null && workflowIds.has(agent.parentAgentId)) {
      const list = members.get(agent.parentAgentId) ?? [];
      list.push(agent);
      members.set(agent.parentAgentId, list);
    } else {
      // Orphaned members (their coordinator aged out) fall back to the direct list.
      direct.push(agent);
    }
  }

  const workflowGroups: AgentPanelWorkflowGroup[] = workflows.map((workflow) => {
    const workflowMembers = members.get(workflow.id) ?? [];
    const knownPhases =
      workflow.phases.length > 0
        ? workflow.phases
        : (() => {
            const derived = new Map<number, string>();
            for (const member of workflowMembers) {
              if (member.phaseIndex !== null && !derived.has(member.phaseIndex)) {
                derived.set(
                  member.phaseIndex,
                  member.phaseTitle ?? `Phase ${member.phaseIndex + 1}`
                );
              }
            }
            return Array.from(derived.entries())
              .map(([index, title]) => ({ index, title }))
              .sort((a, b) => a.index - b.index);
          })();

    const knownPhaseIndices = new Set(knownPhases.map((phase) => phase.index));
    const phases = knownPhases.map((phase) => {
      const phaseMembers = workflowMembers
        .filter((member) => member.phaseIndex === phase.index)
        .slice()
        .sort((a, b) => (a.agentIndex ?? 0) - (b.agentIndex ?? 0));
      // Idle members count as active for phase liveness: a resumable child has
      // not finished the phase.
      const activeCount = phaseMembers.filter(
        (member) => isActive(member.status) || member.status === "idle"
      ).length;
      const settledCount = phaseMembers.filter((member) => isTerminal(member.status)).length;
      const state: "pending" | "running" | "done" =
        phaseMembers.length === 0
          ? "pending"
          : activeCount > 0
            ? "running"
            : settledCount === phaseMembers.length
              ? "done"
              : "pending";
      return { index: phase.index, title: phase.title, members: phaseMembers, state, activeCount, settledCount };
    });

    // Unknown phase indices land here too — a member must never vanish just
    // because its phase row was lost.
    const unphasedMembers = workflowMembers
      .filter((member) => member.phaseIndex === null || !knownPhaseIndices.has(member.phaseIndex))
      .slice()
      .sort((a, b) => (a.agentIndex ?? 0) - (b.agentIndex ?? 0));

    return { workflow, phases, unphasedMembers };
  });

  let runningCount = 0;
  let waitingCount = 0;
  let idleCount = 0;
  let settledCount = 0;
  let totalTokens = 0;
  for (const agent of source) {
    // A workflow coordinator with members is a container for those members,
    // not work of its own: it reports running for the whole run and aggregates
    // their usage upstream in some providers. Counting it would report one
    // more agent working than there are, and double-count tokens.
    if (agent.kind === "workflow" && (members.get(agent.id) ?? []).length > 0) continue;
    if (agent.status === "running" || agent.status === "pending") runningCount += 1;
    else if (agent.status === "waiting") waitingCount += 1;
    else if (agent.status === "idle") idleCount += 1;
    else settledCount += 1;
    totalTokens += agent.usage?.totalTokens ?? 0;
  }

  return {
    workflows: workflowGroups,
    // Updates and the >100-agent retention ranking must never reshuffle rows
    // that remain visible, so the display order is first-seen, never status.
    directAgents: direct
      .slice()
      .sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt) || a.id.localeCompare(b.id)),
    runningCount,
    waitingCount,
    idleCount,
    settledCount,
    totalTokens,
    hasAgents: true,
    liveCount: runningCount + waitingCount
  };
}
