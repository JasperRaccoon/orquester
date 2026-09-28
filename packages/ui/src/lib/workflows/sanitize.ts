/**
 * Automated workflows — the wire payloads, repaired field by field.
 *
 * A daemon of another version may send another shape, and raw JSON must never
 * reach typed code (AGENTS.md, "Adapter/localStorage loads must go through a
 * schema…"). Each reader keeps what it can trust and drops the rest: a record
 * with no usable identity is `null` (skipped), an optional field of the wrong
 * type is left out, a required one with a safe neutral value is defaulted.
 *
 * The definition shapes (a run's frozen `definition`, a project) are zod
 * schemas in @orquester/config, so those go through `safeParse`.
 */

import { WORKFLOW_NODE_TYPES, workflowProjectSchema, workflowRecordSchema } from "@orquester/config";
import type {
  AccountSelectionDecision,
  AgentHop,
  Workflow,
  WorkflowBlockError,
  WorkflowBlockRun,
  WorkflowBlockStatus,
  WorkflowNodeType,
  WorkflowProject,
  WorkflowRun,
  WorkflowRunProgress,
  WorkflowRunStatus,
  WorkflowRunSummary,
  WorkflowSecretName,
  WorkflowSummary,
  WorkflowTriggerKind,
  WorkflowTriggerSummary
} from "@orquester/api";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const nonEmpty = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;
const finite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const RUN_STATUSES: ReadonlySet<string> = new Set<WorkflowRunStatus>([
  "queued",
  "running",
  "succeeded",
  "stopped",
  "failed",
  "cancelled",
  "skipped",
  "interrupted"
]);
const BLOCK_STATUSES: ReadonlySet<string> = new Set<WorkflowBlockStatus>([
  "pending",
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "skipped",
  "cancelled"
]);
const TRIGGER_KINDS: ReadonlySet<string> = new Set<WorkflowTriggerKind>([
  "manual",
  "schedule",
  "git",
  "retry",
  "test",
  "subworkflow"
]);
const NODE_TYPES: ReadonlySet<string> = new Set<string>(WORKFLOW_NODE_TYPES);

export function isNodeType(value: unknown): value is WorkflowNodeType {
  return typeof value === "string" && NODE_TYPES.has(value);
}

/**
 * A workflow's project. One that does not parse reads as an existing project
 * with an EMPTY path: it never matches an open project, so the workflow is
 * listed under "All" but never mis-scoped under "This project".
 */
export function sanitizeWorkflowProject(value: unknown): WorkflowProject {
  const parsed = workflowProjectSchema.safeParse(value);
  return parsed.success ? parsed.data : { kind: "existing", projectPath: "" };
}

function sanitizeProgress(value: unknown): WorkflowRunProgress | undefined {
  if (!isRecord(value)) return undefined;
  const nodeId = nonEmpty(value.nodeId);
  const index = finite(value.index);
  const total = finite(value.total);
  if (nodeId === undefined || index === undefined || total === undefined) return undefined;
  return { nodeId, name: str(value.name) ?? nodeId, index, total };
}

export function sanitizeRunSummary(value: unknown): WorkflowRunSummary | null {
  if (!isRecord(value)) return null;
  const id = nonEmpty(value.id);
  const workflowId = nonEmpty(value.workflowId);
  const status = value.status;
  if (id === undefined || workflowId === undefined) return null;
  if (typeof status !== "string" || !RUN_STATUSES.has(status)) return null;
  const trigger = isRecord(value.trigger) ? value.trigger : {};
  const run: WorkflowRunSummary = {
    id,
    workflowId,
    workflowName: str(value.workflowName) ?? "",
    status: status as WorkflowRunStatus,
    trigger: {
      kind:
        typeof trigger.kind === "string" && TRIGGER_KINDS.has(trigger.kind)
          ? (trigger.kind as WorkflowTriggerKind)
          : "manual"
    },
    test: value.test === true,
    queuedAt: str(value.queuedAt) ?? ""
  };
  const triggerNode = nonEmpty(trigger.nodeId);
  if (triggerNode !== undefined) run.trigger.nodeId = triggerNode;
  const triggerText = str(trigger.text);
  if (triggerText !== undefined) run.trigger.text = triggerText;
  if (value.skipReason === "overlap" || value.skipReason === "missed") run.skipReason = value.skipReason;
  const startedAt = str(value.startedAt);
  if (startedAt !== undefined) run.startedAt = startedAt;
  const endedAt = str(value.endedAt);
  if (endedAt !== undefined) run.endedAt = endedAt;
  const durationMs = finite(value.durationMs);
  if (durationMs !== undefined && durationMs >= 0) run.durationMs = durationMs;
  const current = sanitizeProgress(value.current);
  if (current !== undefined) run.current = current;
  const error = str(value.error);
  if (error !== undefined) run.error = error;
  const projectPath = str(value.projectPath);
  if (projectPath !== undefined) run.projectPath = projectPath;
  if (isRecord(value.tempProject) && typeof value.tempProject.path === "string") {
    run.tempProject = { path: value.tempProject.path, deleted: value.tempProject.deleted === true };
    const deleteAfter = str(value.tempProject.deleteAfter);
    if (deleteAfter !== undefined) run.tempProject.deleteAfter = deleteAfter;
  }
  const parentRunId = nonEmpty(value.parentRunId);
  if (parentRunId !== undefined) run.parentRunId = parentRunId;
  const retryOf = nonEmpty(value.retryOf);
  if (retryOf !== undefined) run.retryOf = retryOf;
  return run;
}

function sanitizeTrigger(value: unknown): WorkflowTriggerSummary | null {
  if (!isRecord(value)) return null;
  const nodeId = nonEmpty(value.nodeId);
  if (nodeId === undefined || !isNodeType(value.type)) return null;
  const trigger: WorkflowTriggerSummary = { nodeId, type: value.type, text: str(value.text) ?? "" };
  for (const key of ["nextRunAt", "lastPollAt", "lastError"] as const) {
    const field = value[key];
    if (typeof field === "string" || field === null) trigger[key] = field;
  }
  return trigger;
}

function list<T>(value: unknown, read: (entry: unknown) => T | null): T[] {
  if (!Array.isArray(value)) return [];
  const out: T[] = [];
  for (const entry of value) {
    const item = read(entry);
    if (item !== null) out.push(item);
  }
  return out;
}

/** One rail row; `null` without an id or a name. */
export function sanitizeWorkflowSummary(value: unknown): WorkflowSummary | null {
  if (!isRecord(value)) return null;
  const id = nonEmpty(value.id);
  const name = nonEmpty(value.name);
  if (id === undefined || name === undefined) return null;
  const summary: WorkflowSummary = {
    id,
    name,
    enabled: value.enabled === true,
    revision: Math.max(0, Math.floor(finite(value.revision) ?? 0)),
    project: sanitizeWorkflowProject(value.project),
    triggers: list(value.triggers, sanitizeTrigger),
    nodeCount: Math.max(0, Math.floor(finite(value.nodeCount) ?? 0)),
    errorCount: Math.max(0, Math.floor(finite(value.errorCount) ?? 0)),
    // A run of another workflow never rides this one's row.
    activeRuns: list(value.activeRuns, sanitizeRunSummary).filter((run) => run.workflowId === id),
    createdAt: str(value.createdAt) ?? "",
    updatedAt: str(value.updatedAt) ?? ""
  };
  const description = str(value.description);
  if (description !== undefined) summary.description = description;
  const lastRun = sanitizeRunSummary(value.lastRun);
  if (lastRun !== null && lastRun.workflowId === id) summary.lastRun = lastRun;
  if (isRecord(value.notify)) {
    summary.notify = {
      onFailure: value.notify.onFailure !== false,
      onSuccess: value.notify.onSuccess === true
    };
  }
  return summary;
}

function sanitizeBlockError(value: unknown): WorkflowBlockError | undefined {
  if (!isRecord(value) || typeof value.message !== "string") return undefined;
  const error: WorkflowBlockError = {
    kind: (typeof value.kind === "string" ? value.kind : "internal") as WorkflowBlockError["kind"],
    message: value.message
  };
  if ("detail" in value) error.detail = value.detail;
  return error;
}

function sanitizeHop(value: unknown): AgentHop | null {
  if (!isRecord(value)) return null;
  const agent = str(value.agent);
  const model = str(value.model);
  const accountId = str(value.accountId);
  const sessionId = str(value.sessionId);
  const startedAt = str(value.startedAt);
  if (agent === undefined || model === undefined || accountId === undefined) return null;
  if (sessionId === undefined || startedAt === undefined) return null;
  const via = value.via;
  const hop: AgentHop = {
    agent,
    model,
    accountId,
    sessionId,
    startedAt,
    via: via === "switched" || via === "handoff" || via === "resumed" ? via : "initial"
  };
  const accountLabel = str(value.accountLabel);
  if (accountLabel !== undefined) hop.accountLabel = accountLabel;
  const endedAt = str(value.endedAt);
  if (endedAt !== undefined) hop.endedAt = endedAt;
  if (value.reason === "usage_limit" || value.reason === "auth") hop.reason = value.reason;
  const resetsAt = str(value.resetsAt);
  if (resetsAt !== undefined) hop.resetsAt = resetsAt;
  return hop;
}

function sanitizeSelection(value: unknown): AccountSelectionDecision | undefined {
  if (!isRecord(value) || typeof value.reason !== "string") return undefined;
  const chosen = isRecord(value.chosen) &&
    typeof value.chosen.agent === "string" &&
    typeof value.chosen.model === "string" &&
    typeof value.chosen.accountId === "string"
    ? {
        agent: value.chosen.agent,
        model: value.chosen.model,
        accountId: value.chosen.accountId,
        chainIndex: Math.max(0, Math.floor(finite(value.chosen.chainIndex) ?? 0)),
        ...(typeof value.chosen.accountLabel === "string" ? { accountLabel: value.chosen.accountLabel } : {})
      }
    : null;
  const decision: AccountSelectionDecision = {
    chosen,
    reason: value.reason,
    skipped: list(value.skipped, (entry) =>
      isRecord(entry) &&
      typeof entry.agent === "string" &&
      typeof entry.accountId === "string" &&
      typeof entry.why === "string"
        ? {
            agent: entry.agent,
            accountId: entry.accountId,
            why: entry.why as AccountSelectionDecision["skipped"][number]["why"],
            detail: str(entry.detail) ?? "",
            ...(typeof entry.label === "string" ? { label: entry.label } : {})
          }
        : null
    )
  };
  const usageAsOf = str(value.usageAsOf);
  if (usageAsOf !== undefined) decision.usageAsOf = usageAsOf;
  const earliestResetAt = str(value.earliestResetAt);
  if (earliestResetAt !== undefined) decision.earliestResetAt = earliestResetAt;
  return decision;
}

/** One block's run state; `null` without a node id or a known status. */
export function sanitizeBlockRun(value: unknown): WorkflowBlockRun | null {
  if (!isRecord(value)) return null;
  const nodeId = nonEmpty(value.nodeId);
  const status = value.status;
  if (nodeId === undefined || typeof status !== "string" || !BLOCK_STATUSES.has(status)) return null;
  const block: WorkflowBlockRun = {
    nodeId,
    name: str(value.name) ?? nodeId,
    // An unknown type (a newer daemon's block) reads as a note: drawn, never run.
    type: isNodeType(value.type) ? value.type : "note",
    status: status as WorkflowBlockStatus,
    attempt: Math.max(0, Math.floor(finite(value.attempt) ?? 0))
  };
  for (const key of ["queuedAt", "startedAt", "endedAt", "handle", "sessionId", "activity", "waitingUntil"] as const) {
    const field = str(value[key]);
    if (field !== undefined) block[key] = field;
  }
  const childRunId = nonEmpty(value.childRunId);
  if (childRunId !== undefined) block.childRunId = childRunId;
  if ("output" in value) block.output = value.output;
  if (value.outputTruncated === true) block.outputTruncated = true;
  if (value.pinned === true) block.pinned = true;
  const error = sanitizeBlockError(value.error);
  if (error !== undefined) block.error = error;
  if (Array.isArray(value.warnings)) {
    block.warnings = value.warnings.filter((warning): warning is string => typeof warning === "string");
  }
  const selection = sanitizeSelection(value.selection);
  if (selection !== undefined) block.selection = selection;
  if (Array.isArray(value.hops)) block.hops = list(value.hops, sanitizeHop);
  if (isRecord(value.logs)) {
    block.logs = {
      stdoutBytes: Math.max(0, finite(value.logs.stdoutBytes) ?? 0),
      stderrBytes: Math.max(0, finite(value.logs.stderrBytes) ?? 0)
    };
  }
  return block;
}

/** A list of block states (a run's `blocks` map, or an update's delta array) keyed by node id. */
export function sanitizeBlocks(value: unknown): Record<string, WorkflowBlockRun> {
  const out: Record<string, WorkflowBlockRun> = {};
  const entries = Array.isArray(value) ? value : isRecord(value) ? Object.values(value) : [];
  for (const entry of entries) {
    const block = sanitizeBlockRun(entry);
    if (block !== null) out[block.nodeId] = block;
  }
  return out;
}

export function sanitizeEdgeIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
}

/** A stored/served definition, through the on-disk schema; `null` when it does not parse. */
export function sanitizeWorkflowRecord(value: unknown): Workflow | null {
  const parsed = workflowRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** A whole run (`GET /api/workflow-runs/:runId`); `null` when its summary or definition cannot be trusted. */
export function sanitizeWorkflowRun(value: unknown): WorkflowRun | null {
  const summary = sanitizeRunSummary(value);
  if (summary === null || !isRecord(value)) return null;
  const definition = sanitizeWorkflowRecord(value.definition);
  if (definition === null) return null;
  const payload = value.triggerPayload;
  const run: WorkflowRun = {
    ...summary,
    definition,
    // The payload's shape varies by trigger kind; the run view reads it through its own guards.
    triggerPayload: isRecord(payload) && typeof payload.kind === "string"
      ? (payload as unknown as WorkflowRun["triggerPayload"])
      : null,
    blocks: sanitizeBlocks(value.blocks),
    takenEdges: sanitizeEdgeIds(value.takenEdges),
    deadEdges: sanitizeEdgeIds(value.deadEdges)
  };
  if ("finalOutput" in value) run.finalOutput = value.finalOutput;
  return run;
}

export function sanitizeSecretName(value: unknown): WorkflowSecretName | null {
  if (!isRecord(value)) return null;
  const name = nonEmpty(value.name);
  if (name === undefined) return null;
  const scope = value.scope === "workflow" ? "workflow" : value.scope === "global" ? "global" : null;
  if (scope === null) return null;
  const secret: WorkflowSecretName = {
    name,
    scope,
    updatedAt: str(value.updatedAt) ?? "",
    short: value.short === true
  };
  const workflowId = nonEmpty(value.workflowId);
  if (workflowId !== undefined) secret.workflowId = workflowId;
  return secret;
}

export function sanitizeSecretList(value: unknown): WorkflowSecretName[] {
  return list(value, sanitizeSecretName);
}

export function sanitizeSummaryList(value: unknown): WorkflowSummary[] {
  return list(value, sanitizeWorkflowSummary);
}

export function sanitizeRunList(value: unknown): WorkflowRunSummary[] {
  return list(value, sanitizeRunSummary);
}
