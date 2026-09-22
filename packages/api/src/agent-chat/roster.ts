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

/** Completion can create an agent (its start may have aged out of retention). */
function getOrCreate(
  agents: Map<string, MutableAgent>,
  id: string,
  payload: Record<string, unknown>,
  at: string
): MutableAgent {
  const existing = agents.get(id);
  if (existing) {
    return existing;
  }
  const created: MutableAgent = {
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
  agents.set(id, created);
  return created;
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
 * Fold the thread's `task.*` activities into roster rows. Tolerant by
 * construction: malformed rows are skipped individually, unknown kinds are
 * ignored. Pure — memoise by activity-list identity at the store layer.
 *
 * `sessionLive: false` derives interruption: background tasks die with their
 * provider session, so agents whose terminal rows were lost (host restart,
 * crash) must not read as running forever. `idle` is preserved — a resumable
 * child stays resumable.
 */
export function foldSubagentActivities(
  activities: readonly ThreadActivityItem[],
  options?: { readonly sessionLive?: boolean }
): RuntimeSubagent[] {
  const agents = new Map<string, MutableAgent>();
  // The launching tool call of each task's LATEST run. A resumed subagent
  // keeps its task id but is launched by a new tool call, and that is the
  // only thing that tells a genuine resume apart from a late start row.
  //
  // Read off `task.started` rows ONLY. Progress rows carry stable ids
  // (`task-progress:…`, `task-usage:…`) and are replaced in place, so in list
  // order a progress row of the relaunched run — already naming the NEW call
  // — sits BEFORE the killed run's terminal row; reading the call off it made
  // the resume's start row look unchanged, and the row stayed `interrupted`
  // for as long as the agent worked (owner incident 2026-09-23: a host
  // restart under three running subagents, all relaunched by the agent).
  const lastToolUseIdByTask = new Map<string, string>();

  for (const activity of activities) {
    const payload = asRecord(activity.payload);
    if (!payload) {
      continue;
    }
    const at = activity.createdAt;

    switch (activity.activityKind) {
      case "task.started": {
        const taskId = asString(payload.taskId);
        if (!taskId) break;
        const agent = getOrCreate(agents, taskId, payload, at);
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
        const previousToolUseId = lastToolUseIdByTask.get(taskId);
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
        const taskId = asString(payload.taskId);
        if (!taskId) break;
        const existed = agents.has(taskId);
        const agent = getOrCreate(agents, taskId, payload, at);
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
        const taskId = asString(payload.taskId);
        if (!taskId) break;
        const agent = getOrCreate(agents, taskId, payload, at);
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
        const taskId = asString(payload.taskId);
        if (!taskId) break;
        const agent = getOrCreate(agents, taskId, payload, at);
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
        // Agent-owned heartbeat: "what it's doing right now".
        const taskId = asString(payload.taskId);
        if (!taskId) break;
        const agent = agents.get(taskId);
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
      const taskId = asString(payload.taskId);
      const toolUseId = asString(payload.toolUseId);
      if (taskId && toolUseId) lastToolUseIdByTask.set(taskId, toolUseId);
    }
  }

  // Consistency pass: when a workflow coordinator has settled, members that
  // never received their own terminal row cannot still be in flight — the run
  // is over. Cascade the coordinator's outcome so stalled member rows do not
  // read as working forever.
  for (const agent of agents.values()) {
    if (agent.kind !== "workflow" || !isTerminal(agent.status)) {
      continue;
    }
    for (const member of agents.values()) {
      if (member.parentAgentId !== agent.id) continue;
      if (isTerminal(member.status) || member.status === "idle") continue;
      member.status = agent.status === "completed" ? "completed" : "interrupted";
      member.completedAt = member.completedAt ?? agent.completedAt ?? agent.updatedAt;
      member.updatedAt = agent.updatedAt;
    }
  }

  // Session death orphans every live agent: no process remains to finish them.
  // Mirrors the host's liveness registry clearing on `session.exited`, so the
  // roster and the tab strip can never disagree.
  if (options?.sessionLive === false) {
    for (const agent of agents.values()) {
      if (isActive(agent.status)) {
        agent.status = "interrupted";
        agent.completedAt = agent.completedAt ?? agent.updatedAt;
      }
    }
  }

  let roster = Array.from(agents.values());
  if (roster.length > ROSTER_LIMIT) {
    // Prefer live, then waiting/idle, then newest settled. A live background
    // row is never evicted ahead of a settled agent row (§7.6).
    const rank = (agent: MutableAgent): number =>
      isActive(agent.status) ? 0 : agent.status === "idle" ? 1 : 2;
    const keep = new Set(
      roster
        .slice()
        .sort((a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, ROSTER_LIMIT)
    );
    // The rank decides WHICH rows survive; the original insertion order decides
    // the order they come back in. Returning the ranked array reordered every
    // surviving row the moment a thread crossed 100 agents — settled rows came
    // back newest-first — which is exactly the "never reshuffle rows that stay
    // visible" rule (§7.6).
    roster = roster.filter((agent) => keep.has(agent));
  }

  return roster.map((agent) => ({ ...agent }));
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
