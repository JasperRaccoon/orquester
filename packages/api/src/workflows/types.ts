// Automated workflows — wire contracts (docs/superpowers/specs/2026-09-28-automated-workflows-design.md).
//
// The on-disk definition shapes are zod schemas in @orquester/config (the one package that owns zod);
// this module re-exports their inferred types and adds everything that crosses the wire: the run
// model, events, REST bodies, limits and error codes. Pure types + constants only.

import type {
  AccountPolicy,
  AgentBlockConfig,
  AgentChainEntry,
  AgentPrompt,
  CodeBlockConfig,
  GitPullRequestAction,
  GitRepoRef,
  GitTriggerEvent,
  HttpBlockConfig,
  RuleOperator,
  SchedulePreset,
  ShellBlockConfig,
  WorkflowEdge,
  WorkflowKeyValue,
  WorkflowNode,
  WorkflowNodeConfig,
  WorkflowNodeOf,
  WorkflowNodeType,
  WorkflowProject,
  WorkflowRecord,
  WorkflowRule,
  WorkflowSettings
} from "@orquester/config";

export type {
  AccountPolicy,
  AgentBlockConfig,
  AgentChainEntry,
  AgentPrompt,
  CodeBlockConfig,
  GitPullRequestAction,
  GitRepoRef,
  GitTriggerEvent,
  HttpBlockConfig,
  RuleOperator,
  SchedulePreset,
  ShellBlockConfig,
  WorkflowEdge,
  WorkflowKeyValue,
  WorkflowNode,
  WorkflowNodeConfig,
  WorkflowNodeOf,
  WorkflowNodeType,
  WorkflowProject,
  WorkflowRule,
  WorkflowSettings
};

/** A workflow as stored and served (`WorkflowRecord` in @orquester/config). */
export type Workflow = WorkflowRecord;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const WORKFLOWS_CHANNEL = "workflows";

export const WORKFLOW_LIMITS = {
  maxWorkflows: 500,
  maxNodes: 200,
  maxEdges: 400,
  maxDefinitionBytes: 2 * 1024 * 1024,
  maxNameLength: 120,
  maxPinnedBytes: 1024 * 1024,
  maxCodeSourceBytes: 512 * 1024,
  maxAgentChain: 8,
  /** Agent `text` output. */
  maxAgentTextBytes: 2 * 1024 * 1024,
  /** Any block output passed downstream / a code result. */
  maxOutputBytes: 16 * 1024 * 1024,
  /** stdout / stderr per code or shell attempt, each. */
  maxLogBytes: 50 * 1024 * 1024,
  maxHttpBodyBytes: 32 * 1024 * 1024,
  codeMemoryMb: { default: 4096, min: 256, max: 16384 },
  processTimeoutMinutes: { default: 30, max: 24 * 60 },
  agentMaxMinutes: { default: 240, max: 1440 },
  httpTimeoutSeconds: { default: 300, max: 3600 },
  waitMaxMinutes: 7 * 24 * 60,
  maxConcurrentRuns: 4,
  maxConcurrentAgentBlocks: 4,
  maxConcurrentProcesses: 8,
  maxSubWorkflowDepth: 5,
  maxAgentHops: 12,
  runsPerWorkflow: 100,
  runRetentionDays: 30,
  missedRunGraceMinutes: 15,
  /** A run summary's inline output preview; the whole output is `…/nodes/:nodeId/output`. */
  inlineOutputPreviewBytes: 64 * 1024,
  /** Agent handoff: previous agent's last messages / git status. */
  handoffMessagesBytes: 32 * 1024,
  handoffGitStatusBytes: 8 * 1024,
  workflowTabRetentionDays: 7
} as const;

/** Node name pattern — used in `{{nodes.<Name>…}}`. */
export const WORKFLOW_NODE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

export type WorkflowNodeCategory = "trigger" | "agent" | "code" | "integration" | "flow" | "note";

export const WORKFLOW_NODE_CATEGORY: Record<WorkflowNodeType, WorkflowNodeCategory> = {
  "trigger.manual": "trigger",
  "trigger.schedule": "trigger",
  "trigger.git": "trigger",
  agent: "agent",
  code: "code",
  shell: "code",
  http: "integration",
  if: "flow",
  switch: "flow",
  merge: "flow",
  stop: "flow",
  wait: "flow",
  workflow: "flow",
  note: "note"
};

export function isTriggerType(type: WorkflowNodeType): boolean {
  return type === "trigger.manual" || type === "trigger.schedule" || type === "trigger.git";
}

// ---------------------------------------------------------------------------
// Sessions a workflow starts (§5.10)
// ---------------------------------------------------------------------------

/** Rides `CreateSessionRequest.owner` / `SessionSummary.owner`. */
export interface WorkflowSessionOwner {
  kind: "workflow";
  workflowId: string;
  runId: string;
  nodeId: string;
}

// ---------------------------------------------------------------------------
// Validation (§7.2)
// ---------------------------------------------------------------------------

export type WorkflowProblemSeverity = "error" | "warning" | "info";

export interface WorkflowProblem {
  severity: WorkflowProblemSeverity;
  /** Stable machine code, e.g. "cycle", "unknown_reference", "shell_template", "secret_in_prompt". */
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
  /** A dotted path inside the node, e.g. "config.chain.0.model". */
  field?: string;
}

// ---------------------------------------------------------------------------
// Triggers (§6)
// ---------------------------------------------------------------------------

export type WorkflowTriggerKind = "manual" | "schedule" | "git" | "retry" | "test" | "subworkflow";

export interface ManualTriggerPayload {
  kind: "manual";
  input: unknown;
}

export interface ScheduleTriggerPayload {
  kind: "schedule";
  firedAt: string;
  scheduledFor: string;
}

export interface GitTriggerPayload {
  kind: "git";
  event: GitTriggerEvent["kind"];
  repo: { url: string; name: string };
  ref: string;
  sha: string;
  previousSha?: string;
  branch?: string;
  tag?: string;
  release?: { id: string; name: string; tag: string; body: string; url: string; prerelease: boolean };
  pr?: {
    number: number;
    title: string;
    body: string;
    url: string;
    author: string;
    head: string;
    base: string;
    action: GitPullRequestAction;
    headSha: string;
  };
}

export interface SubWorkflowTriggerPayload {
  kind: "subworkflow";
  input: unknown;
  parentRunId: string;
  parentNodeId: string;
}

export type WorkflowTriggerPayload =
  | ManualTriggerPayload
  | ScheduleTriggerPayload
  | GitTriggerPayload
  | SubWorkflowTriggerPayload;

/** A trigger's one-line description + its live state, for the rail card. */
export interface WorkflowTriggerSummary {
  nodeId: string;
  type: WorkflowNodeType;
  /** e.g. "Every 15 min", "New tag v* · AppsStats/Apps-Stats". */
  text: string;
  nextRunAt?: string | null;
  lastPollAt?: string | null;
  lastError?: string | null;
}

// ---------------------------------------------------------------------------
// Runs (§3.4, §5)
// ---------------------------------------------------------------------------

export type WorkflowRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "stopped"
  | "failed"
  | "cancelled"
  | "skipped"
  | "interrupted";

export type WorkflowRunSkipReason = "overlap" | "missed";

export type WorkflowBlockStatus =
  | "pending"
  | "queued"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled";

export type WorkflowBlockErrorKind =
  | "all_burnt"
  | "agent_error"
  | "timeout"
  | "cancelled"
  | "interrupted"
  | "exit_code"
  | "exception"
  | "http_status"
  | "network"
  | "expression"
  | "validation"
  | "project_missing"
  | "child_run_failed"
  | "stopped"
  | "limit_exceeded"
  | "internal";

export interface WorkflowBlockError {
  kind: WorkflowBlockErrorKind;
  message: string;
  detail?: unknown;
}

export type AgentFailureReason = "usage_limit" | "auth";

export interface AgentHop {
  agent: string;
  model: string;
  accountId: string;
  accountLabel?: string;
  sessionId: string;
  startedAt: string;
  endedAt?: string;
  /** Why this hop ended, when it was cut short. */
  reason?: AgentFailureReason;
  resetsAt?: string;
  /** "switched" = the same session moved accounts; "handoff" = a new session. */
  via: "initial" | "switched" | "handoff" | "resumed";
}

export type AccountSkipReason = "needsReauth" | "notSeeded" | "threshold" | "cooldown" | "unknownUsage" | "catalog" | "unavailable";

export interface AccountSkip {
  agent: string;
  accountId: string;
  label?: string;
  why: AccountSkipReason;
  /** e.g. "weekly 90% ≥ 85%". */
  detail: string;
}

export interface AccountSelectionChoice {
  agent: string;
  model: string;
  options?: { id: string; value: string | boolean }[];
  accountId: string;
  accountLabel?: string;
  /** 0-based index into the block's chain. */
  chainIndex: number;
}

export interface AccountSelectionDecision {
  chosen: AccountSelectionChoice | null;
  /** Human-readable, e.g. "jasperclaude: soonest weekly reset (4d 2h) under 85%". */
  reason: string;
  usageAsOf?: string;
  skipped: AccountSkip[];
  /** When nothing is eligible: the earliest instant any candidate frees up, if known. */
  earliestResetAt?: string;
}

export interface WorkflowBlockRun {
  nodeId: string;
  name: string;
  type: WorkflowNodeType;
  status: WorkflowBlockStatus;
  /** 1-based; 0 before the first attempt. */
  attempt: number;
  queuedAt?: string;
  startedAt?: string;
  endedAt?: string;
  /** The output (a preview ≤ inlineOutputPreviewBytes on summaries; whole on …/output). */
  output?: unknown;
  outputTruncated?: boolean;
  /** The handle the block finished on (success/error/true/false/case:n/default). */
  handle?: string;
  error?: WorkflowBlockError;
  warnings?: string[];
  // agent blocks
  selection?: AccountSelectionDecision;
  hops?: AgentHop[];
  sessionId?: string;
  /** The latest activity line while running, e.g. "Editing src/app.ts". */
  activity?: string;
  // code / shell blocks
  logs?: { stdoutBytes: number; stderrBytes: number };
  // wait / wait-for-reset
  waitingUntil?: string;
  // sub-workflow
  childRunId?: string;
  /** Output came from pinned data in a test run. */
  pinned?: boolean;
}

export interface WorkflowRunProgress {
  nodeId: string;
  name: string;
  /** 1-based index among executable blocks in topological order. */
  index: number;
  total: number;
}

export interface WorkflowRunSummary {
  id: string;
  workflowId: string;
  workflowName: string;
  status: WorkflowRunStatus;
  skipReason?: WorkflowRunSkipReason;
  trigger: { kind: WorkflowTriggerKind; nodeId?: string; text?: string };
  test: boolean;
  queuedAt: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  current?: WorkflowRunProgress;
  error?: string;
  projectPath?: string;
  tempProject?: { path: string; deleted: boolean; deleteAfter?: string };
  parentRunId?: string;
  retryOf?: string;
}

export interface WorkflowRun extends WorkflowRunSummary {
  /** The frozen definition the run started with. */
  definition: Workflow;
  triggerPayload: WorkflowTriggerPayload | null;
  blocks: Record<string, WorkflowBlockRun>;
  /** Taken edges (ids), for the canvas overlay. */
  takenEdges: string[];
  /** Dead edges (ids). */
  deadEdges: string[];
  finalOutput?: unknown;
}

export function isRunActive(status: WorkflowRunStatus): boolean {
  return status === "queued" || status === "running";
}

// ---------------------------------------------------------------------------
// List rows (the rail)
// ---------------------------------------------------------------------------

export interface WorkflowSummary {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  revision: number;
  project: WorkflowProject;
  triggers: WorkflowTriggerSummary[];
  nodeCount: number;
  errorCount: number;
  lastRun?: WorkflowRunSummary;
  activeRuns: WorkflowRunSummary[];
  /** `settings.notify`, so open clients honour it for in-app notices. Optional: an older daemon omits it. */
  notify?: { onFailure: boolean; onSuccess: boolean };
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Events on channel "workflows" (§8.1)
// ---------------------------------------------------------------------------

export type WorkflowsEventType =
  | "workflow.upserted"
  | "workflow.deleted"
  | "workflowRun.started"
  | "workflowRun.updated"
  | "workflowRun.finished"
  | "workflowSecrets.changed";

export interface WorkflowUpsertedPayload {
  workflow: WorkflowSummary;
}
export interface WorkflowDeletedPayload {
  id: string;
}
export interface WorkflowRunStartedPayload {
  run: WorkflowRunSummary;
}
/** A delta: the summary plus only the blocks that changed since the previous event. */
export interface WorkflowRunUpdatedPayload {
  run: WorkflowRunSummary;
  blocks: WorkflowBlockRun[];
  takenEdges?: string[];
  deadEdges?: string[];
}
export interface WorkflowRunFinishedPayload {
  run: WorkflowRunSummary;
}
export interface WorkflowSecretsChangedPayload {
  workflowId: string | null;
}

// ---------------------------------------------------------------------------
// Secrets (§5.7)
// ---------------------------------------------------------------------------

export interface WorkflowSecretName {
  name: string;
  scope: "global" | "workflow";
  workflowId?: string;
  updatedAt: string;
  /** Values under 4 characters are not redacted — the UI warns. */
  short: boolean;
}

// ---------------------------------------------------------------------------
// Patch operations (§8.2)
// ---------------------------------------------------------------------------

/** A node reference: its id, or its (unique) name. */
export type WorkflowNodeRef = string;

export type WorkflowPatchOp =
  | {
      op: "add_node";
      node: {
        id?: string;
        type: WorkflowNodeType;
        name?: string;
        position?: { x: number; y: number };
        config?: unknown;
        disabled?: boolean;
        notes?: string;
        retry?: WorkflowNode["retry"];
        timeoutMinutes?: number;
        projectOverride?: string;
      };
    }
  | {
      op: "update_node";
      node: WorkflowNodeRef;
      /** Top-level node fields; `config` is merged one level deep; `null` clears an optional field. */
      set: Record<string, unknown>;
    }
  | { op: "remove_node"; node: WorkflowNodeRef }
  | { op: "rename_node"; node: WorkflowNodeRef; to: string }
  | { op: "connect"; source: WorkflowNodeRef; sourceHandle?: string; target: WorkflowNodeRef }
  | { op: "disconnect"; edgeId?: string; source?: WorkflowNodeRef; sourceHandle?: string; target?: WorkflowNodeRef }
  | { op: "set_settings"; settings: Partial<WorkflowSettings> }
  | { op: "set_project"; project: WorkflowProject }
  | { op: "set_enabled"; enabled: boolean }
  | { op: "set_name"; name: string; description?: string | null }
  | { op: "set_pinned"; node: WorkflowNodeRef; output: unknown | null };

// ---------------------------------------------------------------------------
// REST (§8.1)
// ---------------------------------------------------------------------------

export const workflowRoutes = {
  list: "/api/workflows",
  create: "/api/workflows",
  validate: "/api/workflows/validate",
  blockTypes: "/api/workflows/block-types",
  schedulePreview: "/api/workflows/schedule-preview",
  accountPreview: "/api/workflows/account-preview",
  workflow: (id: string): string => `/api/workflows/${encodeURIComponent(id)}`,
  patch: (id: string): string => `/api/workflows/${encodeURIComponent(id)}/patch`,
  duplicate: (id: string): string => `/api/workflows/${encodeURIComponent(id)}/duplicate`,
  run: (id: string): string => `/api/workflows/${encodeURIComponent(id)}/run`,
  testNode: (id: string, nodeId: string): string =>
    `/api/workflows/${encodeURIComponent(id)}/nodes/${encodeURIComponent(nodeId)}/test`,
  runs: (id: string): string => `/api/workflows/${encodeURIComponent(id)}/runs`,
  runDetail: (runId: string): string => `/api/workflow-runs/${encodeURIComponent(runId)}`,
  runCancel: (runId: string): string => `/api/workflow-runs/${encodeURIComponent(runId)}/cancel`,
  runDeleteTempProject: (runId: string): string =>
    `/api/workflow-runs/${encodeURIComponent(runId)}/delete-temp-project`,
  nodeOutput: (runId: string, nodeId: string): string =>
    `/api/workflow-runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/output`,
  nodeLog: (runId: string, nodeId: string): string =>
    `/api/workflow-runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/log`,
  secrets: "/api/workflow-secrets",
  secret: (name: string): string => `/api/workflow-secrets/${encodeURIComponent(name)}`
} as const;

export type WorkflowErrorCode =
  | "WORKFLOW_NOT_FOUND"
  | "RUN_NOT_FOUND"
  | "NODE_NOT_FOUND"
  | "REVISION_CONFLICT"
  | "INVALID_WORKFLOW"
  | "INVALID_REQUEST"
  | "WORKFLOWS_UNAVAILABLE"
  | "LIMIT_EXCEEDED"
  | "SECRET_INVALID"
  | "RUN_NOT_ACTIVE"
  | "ENGINE_UNAVAILABLE";

/** Error body: `{ error: { code, message, problems? } }`. */
export interface WorkflowErrorBody {
  /**
   * `opIndex`: the 0-based op a refused patch failed on (`POST …/patch`), or the entry a refused
   * create failed on (its nodes first, then its edges).
   */
  error: { code: WorkflowErrorCode; message: string; problems?: WorkflowProblem[]; opIndex?: number };
}

/** GET /api/workflows?projectPath= */
export interface ListWorkflowsResponse {
  workflows: WorkflowSummary[];
}

/** GET /api/workflows/:id */
export interface GetWorkflowResponse {
  workflow: Workflow;
  problems: WorkflowProblem[];
}

/** POST /api/workflows — id/revision/timestamps are minted by the daemon. */
export interface CreateWorkflowRequest {
  name: string;
  description?: string;
  enabled?: boolean;
  project: WorkflowProject;
  settings?: Partial<WorkflowSettings>;
  nodes?: WorkflowPatchNodeInput[];
  edges?: { id?: string; source: string; sourceHandle?: string; target: string }[];
  /** Mint names/positions for nodes that lack them (MCP). */
  autoLayout?: boolean;
}

/** A node as a client may send it: id/name/position optional (minted/placed). */
export type WorkflowPatchNodeInput = Extract<WorkflowPatchOp, { op: "add_node" }>["node"];

/** PUT /api/workflows/:id */
export interface ReplaceWorkflowRequest {
  revision: number;
  workflow: Omit<Workflow, "id" | "revision" | "createdAt" | "updatedAt">;
}

/** POST /api/workflows/:id/patch */
export interface PatchWorkflowRequest {
  revision: number;
  ops: WorkflowPatchOp[];
}

/** Create / replace / patch / duplicate all answer this. */
export interface WorkflowWriteResponse {
  workflow: Workflow;
  problems: WorkflowProblem[];
}

/** POST /api/workflows/validate */
export interface ValidateWorkflowRequest {
  workflow: unknown;
}
export interface ValidateWorkflowResponse {
  problems: WorkflowProblem[];
}

/** POST /api/workflows/:id/run */
export interface RunWorkflowRequest {
  input?: unknown;
  test?: boolean;
  /** Test/retry: start at this node, taking upstream outputs from pinned data or `sourceRunId`. */
  fromNodeId?: string;
  /** Retry: re-run this run's failed blocks, reusing its succeeded outputs. */
  retryOf?: string;
  /** Use pinned outputs where present (test runs). */
  usePinned?: boolean;
  /** Ignore the overlap policy (the UI's "run anyway"). */
  force?: boolean;
}
export interface RunWorkflowResponse {
  runId: string | null;
  /** Set when the overlap policy skipped the fire. */
  skipped?: WorkflowRunSkipReason;
}

/** GET /api/workflows/:id/runs?before=&limit= */
export interface ListWorkflowRunsResponse {
  runs: WorkflowRunSummary[];
  /** Pass as `before` for the next page; null = no more. */
  before: string | null;
}

/** GET /api/workflow-runs/:runId (block outputs are previews; see `outputTruncated`). */
export interface GetWorkflowRunResponse {
  run: WorkflowRun;
}

/** GET …/nodes/:nodeId/output */
export interface GetWorkflowNodeOutputResponse {
  output: unknown;
}

/** POST /api/workflows/account-preview */
export interface AccountPreviewRequest {
  chain: AgentChainEntry[];
  projectPath?: string;
}
export interface AccountPreviewResponse {
  decision: AccountSelectionDecision;
}

/** GET /api/workflows/schedule-preview?cron=&tz=&count= */
export interface SchedulePreviewResponse {
  valid: boolean;
  error?: string;
  next: string[];
}

/** GET /api/workflows/block-types */
export interface WorkflowBlockTypeInfo {
  type: WorkflowNodeType;
  category: WorkflowNodeCategory;
  title: string;
  description: string;
  /** Output handles this type exposes (switch: computed per config). */
  handles: string[];
  /** JSON schema of `config`. */
  configSchema: unknown;
  example: unknown;
  /** Shape of `output`, in words. */
  output: string;
}
export interface WorkflowBlockTypesResponse {
  types: WorkflowBlockTypeInfo[];
  /** The `{{…}}` / `{variable}` guide, markdown. */
  expressionGuide: string;
}

/** GET /api/workflow-secrets?workflowId= */
export interface ListWorkflowSecretsResponse {
  secrets: WorkflowSecretName[];
}
/** PUT /api/workflow-secrets/:name?workflowId= */
export interface SetWorkflowSecretRequest {
  value: string;
}
