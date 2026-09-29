/**
 * Claude adapter — the `Workflow` tool's run, read off the wire (spec §4.2
 * task linkage, §7.6 roster).
 *
 * A workflow is ONE background task on the SDK channel (`task_type:
 * "local_workflow"`): the CLI runs the script's agents itself and never
 * forwards their conversation on stdout. What it does send is a snapshot of
 * every agent slot on the coordinator's `task_progress` — the
 * `workflow_progress` array, emitted by CLI 2.1.285 but absent from
 * `sdk.d.ts` 0.3.278 (fixtures 17–19). This module reads that array, the
 * `Workflow` tool's own result (which names the run's transcript directory),
 * and the agents' transcript records, into plain values; the normaliser turns
 * them into `task.*` rows and owned items.
 *
 * Member identity is `<coordinatorTaskId>:wf:<index>`: the slot index is
 * stable across retries, where the CLI's `agentId` is per attempt (it names
 * the attempt's transcript file instead). The client's roster fold and spawn
 * grouping key on exactly this shape.
 *
 * *T3: `ClaudeAdapter.ts:1378-1484` parses the same array.*
 */

import type { RuntimeTaskStatus, TaskRunHandles, TaskWorkflowPhase } from "@orquester/api/agent-chat";

/** The coordinator's SDK task type. */
export const WORKFLOW_TASK_TYPE = "local_workflow";
/** The task type this adapter stamps on a workflow's member rows. */
export const WORKFLOW_MEMBER_TASK_TYPE = "workflow_agent";
/** Bounds on one snapshot, so a malformed frame cannot grow the roster without limit. */
const MAX_WORKFLOW_PHASES = 64;
const MAX_WORKFLOW_AGENTS = 1000;

/** One agent slot of a `workflow_progress` snapshot. */
export interface WorkflowAgentEntry {
  index: number;
  label: string;
  state: string;
  phaseIndex?: number;
  phaseTitle?: string;
  /** The attempt's own id: it names `agent-<agentId>.jsonl` in the run's transcript directory. */
  agentId?: string;
  model?: string;
  attempt?: number;
  startedAt?: number;
  lastToolName?: string;
  lastToolSummary?: string;
  promptPreview?: string;
  tokens?: number;
  toolCalls?: number;
  durationMs?: number;
  resultPreview?: string;
  error?: string;
  skipped?: boolean;
  blocked?: boolean;
}

export interface WorkflowProgressSnapshot {
  phases: TaskWorkflowPhase[];
  agents: WorkflowAgentEntry[];
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asText = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

const asCount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;

const asFinite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/**
 * The `workflow_progress` array of a `task_progress` frame, or `undefined`
 * when the frame carries none — the CLI leaves it out of every frame that only
 * moved a counter, sending the whole snapshot at most every 10 s and on every
 * state change. Entries are deduplicated by index (the CLI merges by
 * `type:index`, a retry replacing its slot) and `workflow_log` entries, which
 * never reach the wire, are ignored.
 */
export function parseWorkflowProgress(message: unknown): WorkflowProgressSnapshot | undefined {
  const raw = asRecord(message)?.workflow_progress;
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const phases = new Map<number, TaskWorkflowPhase>();
  const agents = new Map<number, WorkflowAgentEntry>();
  for (const value of raw) {
    const entry = asRecord(value);
    const index = asCount(entry?.index);
    if (entry === undefined || index === undefined) {
      continue;
    }
    if (entry.type === "workflow_phase") {
      const title = asText(entry.title);
      if (title !== undefined && (phases.has(index) || phases.size < MAX_WORKFLOW_PHASES)) {
        phases.set(index, { index, title });
      }
      continue;
    }
    if (entry.type !== "workflow_agent") {
      continue;
    }
    if (!agents.has(index) && agents.size >= MAX_WORKFLOW_AGENTS) {
      continue;
    }
    const parsed: WorkflowAgentEntry = {
      index,
      label: asText(entry.label) ?? `agent ${index}`,
      state: typeof entry.state === "string" ? entry.state : ""
    };
    const phaseIndex = asCount(entry.phaseIndex);
    if (phaseIndex !== undefined) parsed.phaseIndex = phaseIndex;
    const phaseTitle = asText(entry.phaseTitle);
    if (phaseTitle !== undefined) parsed.phaseTitle = phaseTitle;
    const agentId = asText(entry.agentId);
    // It becomes a file name: nothing but the CLI's own id alphabet.
    if (agentId !== undefined && /^[A-Za-z0-9_-]+$/.test(agentId)) parsed.agentId = agentId;
    const model = asText(entry.model);
    if (model !== undefined) parsed.model = model;
    const attempt = asCount(entry.attempt);
    if (attempt !== undefined) parsed.attempt = attempt;
    const startedAt = asFinite(entry.startedAt);
    if (startedAt !== undefined) parsed.startedAt = startedAt;
    const lastToolName = asText(entry.lastToolName);
    if (lastToolName !== undefined) parsed.lastToolName = lastToolName;
    const lastToolSummary = asText(entry.lastToolSummary);
    if (lastToolSummary !== undefined) parsed.lastToolSummary = lastToolSummary;
    const promptPreview = asText(entry.promptPreview);
    if (promptPreview !== undefined) parsed.promptPreview = promptPreview;
    const tokens = asCount(entry.tokens);
    if (tokens !== undefined) parsed.tokens = tokens;
    const toolCalls = asCount(entry.toolCalls);
    if (toolCalls !== undefined) parsed.toolCalls = toolCalls;
    const durationMs = asCount(entry.durationMs);
    if (durationMs !== undefined) parsed.durationMs = durationMs;
    const resultPreview = asText(entry.resultPreview);
    if (resultPreview !== undefined) parsed.resultPreview = resultPreview;
    const error = asText(entry.error);
    if (error !== undefined) parsed.error = error;
    if (entry.skipped === true) parsed.skipped = true;
    if (entry.blocked === true) parsed.blocked = true;
    agents.set(index, parsed);
  }
  return {
    phases: [...phases.values()].sort((a, b) => a.index - b.index),
    agents: [...agents.values()].sort((a, b) => a.index - b.index)
  };
}

/**
 * A slot's state in the shared vocabulary. The CLI's states are
 * `start | progress | done | error`: `start` is queued until the agent has a
 * `startedAt`, a user's skip is an `error` marked `skipped`, and an unknown
 * state reads as running once the agent has started.
 */
export function workflowAgentStatus(entry: WorkflowAgentEntry): RuntimeTaskStatus {
  switch (entry.state) {
    case "done":
      return "completed";
    case "error":
      return entry.skipped === true ? "cancelled" : "failed";
    case "progress":
      return "running";
    default:
      return entry.startedAt !== undefined ? "running" : "pending";
  }
}

export function isTerminalTaskStatus(status: RuntimeTaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/** The member row id of one slot — the shape the client's roster and spawn grouping key on. */
export function workflowMemberTaskId(coordinatorTaskId: string, index: number): string {
  return `${coordinatorTaskId}:wf:${index}`;
}

/**
 * What a member row says changed, as a string: a snapshot repeats EVERY slot
 * on every tick, and re-emitting the unchanged ones would write a roster row
 * per slot per tick into the log (T3 `ClaudeAdapter.ts:439-445`).
 */
export function workflowAgentFingerprint(entry: WorkflowAgentEntry): string {
  return JSON.stringify([
    entry.state,
    entry.attempt ?? null,
    entry.agentId ?? null,
    entry.startedAt ?? null,
    entry.tokens ?? null,
    entry.toolCalls ?? null,
    entry.lastToolName ?? null,
    entry.lastToolSummary ?? null,
    entry.resultPreview ?? null,
    entry.error ?? null,
    entry.phaseIndex ?? null,
    entry.label,
    entry.model ?? null
  ]);
}

/** The `Workflow` tool's immediate result: which task is the run, and where it writes. */
export interface WorkflowLaunch {
  taskId: string;
  runHandles: TaskRunHandles;
}

/**
 * Read the `Workflow` tool's `tool_use_result` (`{status: "async_launched",
 * taskId, runId, transcriptDir, scriptPath, …}`, fixture 17). Only local
 * runs carry a transcript directory this host can read; a `sessionUrl` is
 * kept only when it is an http(s) URL.
 */
export function parseWorkflowLaunch(result: Record<string, unknown> | undefined): WorkflowLaunch | undefined {
  if (result === undefined) {
    return undefined;
  }
  const taskId = asText(result.taskId);
  if (taskId === undefined) {
    return undefined;
  }
  const runHandles: TaskRunHandles = {};
  const runId = asText(result.runId);
  if (runId !== undefined) runHandles.runId = runId;
  const scriptPath = asText(result.scriptPath);
  if (scriptPath !== undefined) runHandles.scriptPath = scriptPath;
  const transcriptDir = asText(result.transcriptDir);
  if (transcriptDir !== undefined) runHandles.transcriptDir = transcriptDir;
  const sessionUrl = asText(result.sessionUrl);
  if (sessionUrl !== undefined && /^https?:\/\//i.test(sessionUrl)) runHandles.sessionUrl = sessionUrl;
  return { taskId, runHandles };
}

/**
 * The line the CLI puts before a workflow agent's computed task, and the one
 * that ends its preamble: the task text follows, every line indented by two
 * spaces (so a forged frame line inside it cannot sit at column zero).
 */
const WORKFLOW_HARNESS_PREFIX = "[Workflow harness";
const WORKFLOW_HARNESS_TASK_MARKER = "The computed task text follows:\n";

/**
 * The task a workflow agent was given, out of its transcript's first `user`
 * record — the whole of it, where `promptPreview` is a preview. `undefined`
 * for any other record.
 */
export function workflowAgentPromptOf(record: unknown): string | undefined {
  const row = asRecord(record);
  if (row?.type !== "user") {
    return undefined;
  }
  const content = asRecord(row.message)?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content) && content.length === 1 && asRecord(content[0])?.type === "text"
        ? asText(asRecord(content[0])?.text)
        : undefined;
  if (text === undefined || !text.startsWith(WORKFLOW_HARNESS_PREFIX)) {
    return undefined;
  }
  const marker = text.indexOf(WORKFLOW_HARNESS_TASK_MARKER);
  if (marker === -1) {
    return undefined;
  }
  return text
    .slice(marker + WORKFLOW_HARNESS_TASK_MARKER.length)
    .split("\n")
    .map((line) => (line.startsWith("  ") ? line.slice(2) : line))
    .join("\n");
}
