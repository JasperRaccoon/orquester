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
  GateBlockConfig,
  GitPullRequestAction,
  GitRepoRef,
  GitTriggerEvent,
  HttpBlockConfig,
  RuleOperator,
  SchedulePreset,
  ShellBlockConfig,
  WorkflowEdge,
  WorkflowEdgeLoop,
  WorkflowGateChoice,
  WorkflowGateChoiceColor,
  WorkflowGateCommentMode,
  WorkflowGateDecider,
  WorkflowGateTimeout,
  WorkflowInputDecl,
  WorkflowInputType,
  WorkflowKeyValue,
  WorkflowLoopSessionMode,
  WorkflowNode,
  WorkflowNodeConfig,
  WorkflowNodeOf,
  WorkflowNodeType,
  WorkflowOutcomeDecl,
  WorkflowOutputDecl,
  WorkflowOutputType,
  WorkflowProject,
  WorkflowRecord,
  WorkflowRule,
  WorkflowSettings
} from "@orquester/config";

import type { WorkflowGuideSection } from "./guide.ts";

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
  GateBlockConfig,
  WorkflowEdge,
  WorkflowEdgeLoop,
  WorkflowGateChoice,
  WorkflowGateChoiceColor,
  WorkflowGateCommentMode,
  WorkflowGateDecider,
  WorkflowGateTimeout,
  WorkflowInputDecl,
  WorkflowInputType,
  WorkflowKeyValue,
  WorkflowLoopSessionMode,
  WorkflowNode,
  WorkflowNodeConfig,
  WorkflowNodeOf,
  WorkflowNodeType,
  WorkflowOutcomeDecl,
  WorkflowOutputDecl,
  WorkflowOutputType,
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
  workflowTabRetentionDays: 7,
  // Typed inputs, outcomes, gates and loops (spec 2026-11-10). Enforced by `validateWorkflow` / the daemon.
  /** Manual-trigger `inputs` (§4.1). */
  maxInputs: 30,
  /** An enum input's or output's `values`. */
  enumValues: { min: 1, max: 50 },
  /** An input's `description`, in characters. */
  inputDescriptionChars: 300,
  /** An agent block's `outcomes` (§5.1). */
  outcomes: { min: 2, max: 12 },
  /** An agent block's `outputs` (§5.1). */
  maxOutputs: 20,
  /** `report_step_result`'s `summary`, in characters (§5.2). */
  reportSummaryChars: 2000,
  /** A gate's `choices` (§6.1). */
  gateChoices: { min: 2, max: 8 },
  /** A gate's rendered `question`, in characters. */
  gateQuestionChars: 300,
  /** A gate's rendered `details`, in UTF-8 bytes. */
  gateDetailsBytes: 8 * 1024,
  /** The agent phase's default length (`decider.maxMinutes`). */
  gateAgentPhaseDefaultMinutes: 60,
  /** The person phase's longest length (also `timeout.minutes`' maximum): the existing maximum wait. */
  gatePersonPhaseMaxMinutes: 7 * 24 * 60,
  /** A loop edge's `maxLoops` (§7.1). */
  loops: { min: 1, max: 20 },
  /** What a new loop edge drawn in the editor gets (§7.4). */
  defaultLoop: { maxLoops: 2, session: "continue" }
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
  gate: "flow",
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
  /** Set when the parent passed data someone else wrote (prompt-safety.ts): the child frames it. */
  untrusted?: true;
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
  /** A manual trigger's declared inputs (§4.1, §8: `get_workflow` / `list_workflows`). */
  inputs?: WorkflowInputDecl[];
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
  | "internal"
  /** An agent block with declared outcomes/outputs settled twice (turn + one reminder) with no report (§5.3). Retryable. */
  | "no_report"
  /** A loop edge reached its limit and the person chose "Stop" (§7.2). Never retried. */
  | "loop_limit"
  /** A gate's person phase passed with `timeout.then: fail`, or the 7-day maximum (§6.1). Never retried. */
  | "gate_expired";

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

/**
 * Why selection passed an account over. Run records are stored verbatim and read back without a
 * schema on this field, so a record written by an older build may carry a reason this union no
 * longer names (a removed build's `notSeeded`): readers render such a value as `unavailable`.
 */
export type AccountSkipReason = "needsReauth" | "threshold" | "cooldown" | "unknownUsage" | "catalog" | "unavailable";

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
  // agent blocks with declared outcomes/outputs (spec 2026-11-10 §5)
  /** The pass's latest valid `report_step_result` (replaced by a later valid call until the block settles). */
  report?: WorkflowStepReport;
  // gates (§6) — also a loop-limit gate opened on a loop edge's source block (§7.2)
  /** The gate this block waits on (a key of `WorkflowRun.gates`). */
  gateId?: string;
  // loops (§7)
  /** 1-based pass number of this block in the run; absent = 1 (no loop has run it again). */
  pass?: number;
  /** Earlier passes of this block, oldest first; the fields above are always the latest pass. */
  passes?: WorkflowBlockPass[];
  /** The feedback the loop edge carried into this pass (`{{ loop.feedback }}`, §7.2). */
  loopFeedback?: string;
  /**
   * Set when a loop's `session: "continue"` could not continue this block's previous session and it
   * started a new chat, e.g. "new chat: previous session unavailable (archived)" (§7.3).
   */
  sessionNote?: string;
}

/** One earlier pass of a block (§7.2): what it ended with, kept when a loop ran the block again. */
export type WorkflowBlockPass = Omit<WorkflowBlockRun, "nodeId" | "name" | "type" | "passes"> & {
  /** 1-based. */
  pass: number;
};

/** A valid `report_step_result` call, as stored on the pass (§5.2). */
export interface WorkflowStepReport {
  /** One of the block's declared outcome ids; absent when only `outputs` are declared. */
  outcome?: string;
  summary: string;
  /** Validated and coerced against the block's declared `outputs`. */
  outputs?: Record<string, unknown>;
  /** The chat that made the call. */
  sessionId: string;
  reportedAt: string;
}

/**
 * An agent block's output (`nodes.<Name>.output`). `outcome` / `summary` / `outputs` are set when
 * the block declared outcomes or outputs and the agent reported (§5.4).
 */
export interface WorkflowAgentBlockOutput {
  text: string;
  sessionId: string;
  agent: string;
  model: string;
  accountId: string;
  durationMs: number;
  hops: AgentHop[];
  outcome?: string;
  summary?: string;
  outputs?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Gates (spec 2026-11-10 §6)
// ---------------------------------------------------------------------------

export type WorkflowGateDeciderKind = WorkflowGateDecider["kind"];

/** Who decided: the person in the GUI, an external MCP client (the person's own tooling), an agent decider, or the timeout. */
export type WorkflowGateDecidedByKind = "human" | "external" | "agent" | "launcher" | "timeout";

export interface WorkflowGateDecidedBy {
  kind: WorkflowGateDecidedByKind;
  /** e.g. "you", "Reviewer (claude)", "the launching chat", "timeout". */
  label: string;
  /** The deciding chat (agent / launcher). */
  sessionId?: string;
}

/** A gate's decision, persisted in the run before the engine moves on. The first decision wins. */
export interface WorkflowGateDecision {
  choice: string;
  comment?: string;
  decidedBy: WorkflowGateDecidedBy;
  decidedAt: string;
}

/** A gate block's output (`nodes.<Name>.output`, §6.2). */
export interface WorkflowGateOutput extends WorkflowGateDecision {
  escalated: boolean;
}

/** "agent": an agent decider (reviewer or launcher) is asked; "person": the person is (decider human, or after escalation). */
export type WorkflowGatePhase = "agent" | "person";

/** A gate's choice as served (config `comment` default applied). */
export interface WorkflowGateChoiceView {
  id: string;
  label: string;
  color?: WorkflowGateChoiceColor;
  comment: WorkflowGateCommentMode;
}

/**
 * One gate of a run, as the run detail, the gate list and the decision card read it. `source:
 * "loop_limit"` is the person-only gate a loop edge opens on its source block at its limit (§7.2;
 * choices "Allow one more loop" / "Stop").
 */
export interface WorkflowGateState {
  /** Unique within the run (a key of `WorkflowRun.gates`). */
  gateId: string;
  runId: string;
  workflowId: string;
  /** Rides list rows (`ListWorkflowGatesResponse`); the run detail already names it. */
  workflowName?: string;
  /** The run's project, on list rows. */
  projectPath?: string;
  /** The top-level run, when this gate is inside a sub-workflow's child run. */
  rootRunId?: string;
  nodeId: string;
  nodeName: string;
  /** The block's pass the gate belongs to. */
  pass?: number;
  source: "gate" | "loop_limit";
  /** Loop-limit gates: the loop edge that reached its limit. */
  edgeId?: string;
  /** Rendered. */
  question: string;
  /** Rendered Markdown. */
  details?: string;
  choices: WorkflowGateChoiceView[];
  decider: {
    kind: WorkflowGateDeciderKind;
    /** e.g. "you", "Reviewer (claude)", "the launching chat". */
    label: string;
    /** The agent decider's chat (reviewer agent, or the launcher's thread). */
    sessionId?: string;
  };
  phase: WorkflowGatePhase;
  openedAt: string;
  /** When the current phase started (the person phase's `timeout` counts from it). */
  phaseStartedAt?: string;
  /** When the current phase ends (agent: `maxMinutes`; person: `timeout` or the 7-day maximum). */
  phaseDeadlineAt?: string;
  /** The person was asked after an agent decider escalated, failed or ran out of time. */
  escalated: boolean;
  escalatedAt?: string;
  /** Set once decided (then the gate no longer waits). */
  decision?: WorkflowGateDecision;
  /** Cancelled with its run before a decision. */
  cancelled?: boolean;
  /** A test run's gate: answered in the editor's run view only — no push, attention row or agent decider (§7.5). */
  test?: boolean;
}

/** Waiting = neither decided nor cancelled. */
export function isGateWaiting(gate: Pick<WorkflowGateState, "decision" | "cancelled">): boolean {
  return gate.decision === undefined && gate.cancelled !== true;
}

/** Waiting for the PERSON (attention rows, push, badges): waiting and in the person phase. */
export function isGateWaitingForPerson(gate: Pick<WorkflowGateState, "decision" | "cancelled" | "phase">): boolean {
  return isGateWaiting(gate) && gate.phase === "person";
}

// ---------------------------------------------------------------------------
// Typed inputs (spec 2026-11-10 §4.2)
// ---------------------------------------------------------------------------

/** One problem with a run's input against the manual trigger's declared `inputs`. */
export interface WorkflowInputError {
  /** The input's name; absent for the input as a whole ("the input must be an object"). */
  input?: string;
  /** Names the input and the fix, e.g. "input `env` must be one of: stg, prd". */
  message: string;
}

/** Who started a run (§6.3). A child run carries its top-level run's. */
export type WorkflowRunStartedBy =
  /** An agent chat through `run_workflow`; set by the daemon from the in-chat caller, never from a remote client. */
  | { kind: "thread"; sessionId: string }
  /** The GUI or the REST API. */
  | { kind: "human" }
  /** A schedule or git trigger. */
  | { kind: "trigger" };

export interface WorkflowRunProgress {
  nodeId: string;
  name: string;
  /** 1-based index among executable blocks in topological order. */
  index: number;
  total: number;
}

/** The structured reasons a run (not one of its blocks) failed. */
export type WorkflowRunErrorKind = "project_missing";

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
  /** What kind of failure `error` is, when the engine knows (additive; e.g. `project_missing`). */
  errorKind?: WorkflowRunErrorKind;
  projectPath?: string;
  /**
   * `pending`: recorded BEFORE the creation (a restart finds and removes the directory);
   * `deleteAfter`: when the sweeper may delete a project the run kept.
   */
  tempProject?: { path: string; deleted: boolean; deleteAfter?: string; pending?: boolean };
  parentRunId?: string;
  retryOf?: string;
  /** Gates of this run (and of its child runs) waiting on a decision (§6.4 badges). Absent = 0. */
  pendingGates?: number;
  /** Of those, the ones waiting for the person (attention rows, warn dot). Absent = 0. */
  pendingPersonGates?: number;
  /** Every active block waits on a gate, a timer or a parked child run (§6.2). */
  parked?: boolean;
  /**
   * Why a skipped or queued run did not start, in words, e.g. "previous run is waiting on gate
   * “Deploy?”" (§6.2: never a silent skip).
   */
  skipDetail?: string;
}

export interface WorkflowRun extends WorkflowRunSummary {
  /** The frozen definition the run started with. */
  definition: Workflow;
  /**
   * The revision of every sub-workflow the run froze when its top-level run started (by workflow
   * id; recursively): its Run workflow blocks run these definitions, not later edits. Optional: an
   * older daemon omits it, and a run with no sub-workflow has none.
   */
  subWorkflowRevisions?: Record<string, number>;
  triggerPayload: WorkflowTriggerPayload | null;
  blocks: Record<string, WorkflowBlockRun>;
  /** Taken edges (ids), for the canvas overlay. */
  takenEdges: string[];
  /** Dead edges (ids). */
  deadEdges: string[];
  finalOutput?: unknown;
  /** Who started the run (§6.3); absent on runs recorded by an older build. */
  startedBy?: WorkflowRunStartedBy;
  /** This run's gates, by gate id, opened order (§6). Decided ones stay as the record. */
  gates?: Record<string, WorkflowGateState>;
  /** How many times each loop edge was taken in this run, by edge id (§7.2); absent = 0. */
  loopCounters?: Record<string, number>;
  /** A loop edge's limit raised for this run by "Allow one more loop", by edge id (replaces `loop.maxLoops`). */
  loopLimits?: Record<string, number>;
  /** Parked time so far, excluded from `runTimeoutMinutes` (§6.2). */
  parkedMs?: number;
  /** When the current parked stretch began; absent while not parked. */
  parkedSince?: string;
}

export function isRunActive(status: WorkflowRunStatus): boolean {
  return status === "queued" || status === "running";
}

// ---------------------------------------------------------------------------
// List rows (the rail)
// ---------------------------------------------------------------------------

/** At most this many errors ride a `WorkflowSummary` (the rest are counted in `errorsOmitted`). */
export const WORKFLOW_SUMMARY_MAX_ERRORS = 5;

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
  /**
   * The first errors (at most `WORKFLOW_SUMMARY_MAX_ERRORS`), so the rail can say what they are.
   * Optional: an older daemon omits it (the rail then shows the count alone). Absent with no errors.
   */
  errors?: WorkflowProblem[];
  /** How many errors `errors` leaves out; absent when none are. */
  errorsOmitted?: number;
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
  /** Gates opened, decided, escalated or cancelled since the previous event (whole states). */
  gates?: WorkflowGateState[];
  /** Loop counters when they changed (the whole map). */
  loopCounters?: Record<string, number>;
  loopLimits?: Record<string, number>;
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

/** A loop edge's settings as a client may send them (`session` optional, default "continue"). */
export type WorkflowEdgeLoopInput = { maxLoops: number; session?: WorkflowLoopSessionMode };

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
  /** `loop`: make it a loop edge (§7.1; `session` defaults to "continue"). */
  | { op: "connect"; source: WorkflowNodeRef; sourceHandle?: string; target: WorkflowNodeRef; loop?: WorkflowEdgeLoopInput }
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
  expressionPreview: (id: string): string => `/api/workflows/${encodeURIComponent(id)}/expression-preview`,
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
  secret: (name: string): string => `/api/workflow-secrets/${encodeURIComponent(name)}`,
  /** The reference index: what a workflow runs as sub-workflows, and every workflow that runs it. */
  workflowReferences: (id: string): string => `/api/workflow-references/workflows/${encodeURIComponent(id)}`,
  /** The reference index: every workflow whose agent blocks use a saved prompt. */
  promptReferences: (promptId: string): string => `/api/workflow-references/prompts/${encodeURIComponent(promptId)}`,
  /** The reference index: every workflow whose agent blocks launch with an Agent Profile (`config.profileId`). */
  profileReferences: (profileId: string): string => `/api/workflow-references/profiles/${encodeURIComponent(profileId)}`,
  /** GET: gates across projects (`ListWorkflowGatesQuery`), waiting ones by default (spec 2026-11-10 §8). */
  gates: "/api/workflow-gates",
  /** POST: decide (or escalate) one gate of a run (`DecideWorkflowGateRequest`). */
  gateDecide: (runId: string, gateId: string): string =>
    `/api/workflow-runs/${encodeURIComponent(runId)}/gates/${encodeURIComponent(gateId)}/decide`,
  /**
   * POST: an in-chat agent's `report_step_result` (`ReportWorkflowStepRequest`, spec 2026-11-10
   * §5.2). The step is found from the request's agent principal (the calling chat), never a body field.
   */
  stepReport: "/api/workflow-step-report"
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
  | "ENGINE_UNAVAILABLE"
  | "CALLERS_CHANGED"
  /** The run's input does not fit the manual trigger's declared inputs; `inputErrors` lists every problem (§4.2). */
  | "INVALID_INPUT"
  | "GATE_NOT_FOUND"
  /** An in-chat caller that is not the gate's assigned decider (§6.3). */
  | "GATE_NOT_DECIDER"
  /** `report_step_result` from a chat that is not the current session of a running reporting step (§5.2). */
  | "NOT_A_WORKFLOW_STEP"
  /** A `report_step_result` call that does not fit the step's declared outcomes/outputs; the message lists every problem. */
  | "INVALID_REPORT";

/** Error body: `{ error: { code, message, problems? } }`. */
export interface WorkflowErrorBody {
  /**
   * `opIndex`: the 0-based op a refused patch failed on (`POST …/patch`), or the entry a refused
   * create failed on (its nodes first, then its edges).
   */
  error: {
    code: WorkflowErrorCode;
    message: string;
    problems?: WorkflowProblem[];
    opIndex?: number;
    /** `INVALID_INPUT`: every input problem at once. */
    inputErrors?: WorkflowInputError[];
  };
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
  edges?: { id?: string; source: string; sourceHandle?: string; target: string; loop?: WorkflowEdgeLoopInput }[];
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
  /**
   * Refuse with 409 `CALLERS_CHANGED`, nothing saved, unless the workflows that run this one as a
   * sub-workflow (directly or through others) are exactly these ids — and are known. The MCP sends
   * what its approval card showed. Also `?expectCallers=<id,id…>` on `DELETE /api/workflows/:id`
   * (an empty value: none).
   */
  expectCallers?: string[];
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
  /**
   * Refuse with 409 `REVISION_CONFLICT`, before any block starts, unless the workflow is at this
   * revision — the run then executes exactly that definition (the MCP's `run_workflow {revision}`;
   * unified MCP design 2026-10-15 §4.1, §7.2). Absent: whatever revision is current.
   */
  expectedRevision?: number;
}
export interface RunWorkflowResponse {
  runId: string | null;
  /** Set when the overlap policy skipped the fire. */
  skipped?: WorkflowRunSkipReason;
  /** Why it was skipped or queued, in words (e.g. "previous run is waiting on gate “Deploy?”"). */
  skipDetail?: string;
}

/** POST /api/workflow-runs/:runId/gates/:gateId/decide */
export interface DecideWorkflowGateRequest {
  /** A choice id of the gate; required unless `escalate`. */
  choice?: string;
  /** Required when the choice's `comment` is "required", and whenever an agent decides or escalates. */
  comment?: string;
  /** Agent deciders only: hand the gate to the person instead of deciding. */
  escalate?: boolean;
}
export interface DecideWorkflowGateResponse {
  /** True when an earlier decision stood: nothing changed, `decision` is that one. */
  alreadyDecided: boolean;
  /** The decision that stands (absent after an escalation). */
  decision?: WorkflowGateDecision;
  /** The gate after the call. */
  gate: WorkflowGateState;
}

/** GET /api/workflow-gates?projectPath=&includeDecided=1 (the query string carries `includeDecided` as "1"). */
export interface ListWorkflowGatesQuery {
  /** Only gates of runs in this project. */
  projectPath?: string;
  /** Also decided (and cancelled) gates of retained runs; default only waiting ones. */
  includeDecided?: boolean;
}
export interface ListWorkflowGatesResponse {
  /** Oldest first. */
  gates: WorkflowGateState[];
}

/** POST /api/workflow-step-report (spec 2026-11-10 §5.2). */
export interface ReportWorkflowStepRequest {
  /** One of the step's declared outcome ids; required when it declares outcomes, refused when it declares none. */
  outcome?: string;
  /** ≤ `WORKFLOW_LIMITS.reportSummaryChars`. */
  summary: string;
  /** The step's declared outputs by name. */
  outputs?: Record<string, unknown>;
}
export interface ReportWorkflowStepResponse {
  /** Persisted on the block's run before this answer. */
  recorded: true;
  runId: string;
  workflowId: string;
  nodeId: string;
  nodeName: string;
  /** An earlier valid report of the same pass was replaced. */
  replaced: boolean;
  report: WorkflowStepReport;
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

/** A workflow as the reference index names it. */
export interface WorkflowReference {
  workflowId: string;
  name: string;
  enabled: boolean;
  revision: number;
  project: WorkflowProject;
  /** The workspace of its own project (an existing project's, or a temp project's), when known. */
  workspace?: string;
}

/**
 * GET /api/workflow-references/workflows/:id — from the index the workflow store keeps in step with
 * every save and delete (rebuilt from `workflows.json` at startup). Answers for any id, stored or not.
 */
export interface WorkflowReferencesResponse {
  /** Moves on every change to the index (a definition saved or deleted, a rebuild). */
  version: number;
  workflowId: string;
  /** The sub-workflow ids its `workflow` blocks run, in block order, each once ([] when it is not stored). */
  calls: string[];
  /**
   * Every workflow that runs it as a sub-workflow, directly or through others. `null`: unknown — a
   * definition this build cannot read may run it, or the definitions could not be read — and a
   * caller must fail closed (never read it as "no callers"); `unknownReason` says why.
   */
  callers: WorkflowReference[] | null;
  unknownReason?: string;
}

/** GET /api/workflow-references/prompts/:promptId */
export interface PromptReferencesResponse {
  version: number;
  promptId: string;
  /** Every stored workflow with an agent block whose prompt is `{kind: "saved", promptId}`, with those blocks. */
  workflows: (WorkflowReference & { nodes: { id: string; name: string }[] })[];
  /**
   * Set when the list may be incomplete — a definition this build cannot read may use the prompt, or
   * the definitions could not be read: a caller must treat the prompt as used (fail closed).
   */
  unknownReason?: string;
}

/**
 * GET /api/workflow-references/profiles/:profileId — what the Agent Profile delete guard lists
 * (`DeleteSessionProfileQuery.expectWorkflowUses`). Same shape and fail-closed rule as
 * {@link PromptReferencesResponse}.
 */
export interface ProfileReferencesResponse {
  version: number;
  profileId: string;
  /** Every stored workflow with an agent block whose `config.profileId` is this profile, with those blocks. */
  workflows: (WorkflowReference & { nodes: { id: string; name: string }[] })[];
  /** Set when the list may be incomplete: a caller must treat the profile as used (fail closed). */
  unknownReason?: string;
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

/** POST /api/workflows/:id/expression-preview — render `{{ … }}` templates against recorded data, read-only. */
export interface PreviewWorkflowExpressionRequest {
  /** 1 to `EXPRESSION_PREVIEW_LIMITS.maxTemplates` templates, each at most `MAX_TEMPLATE_LENGTH` characters. */
  templates: string[];
  /** The block (id or name) whose point of view to take: it decides `input`, and hides itself and its downstream. */
  node?: string;
  /** The run whose recorded outputs to read; default the latest run that reached `node`, else the latest run. */
  runId?: string;
  /** Pinned outputs replace recorded ones (as a test run uses them). */
  usePinned?: boolean;
  /** "text" (default): as a text field renders. "value": a lone `{{ … }}` keeps its raw value (rule sides, Stop values, sub-workflow input). */
  mode?: "text" | "value";
}

/** One template's preview; secret values never appear (they read as `«secret:NAME»`). */
export interface WorkflowExpressionPreviewResult {
  /** Text mode: the rendered text. */
  text?: string;
  /** Value mode: the raw value (a template that is not one lone `{{ … }}` renders to text); absent when it read nothing (`missing`) or was cut (`valueJson`). */
  value?: unknown;
  /** Value mode: the value's JSON type ("string", "number", "object", "array", "boolean", "null"). */
  valueType?: string;
  /** Value mode: the lone expression read nothing. */
  missing?: boolean;
  /** Value mode, cut: the head of the value's JSON text. */
  valueJson?: string;
  /** `text` / `valueJson` was cut to fit. `bytes`: the whole size in UTF-8 bytes — a lower bound when the render itself stopped at the cap. */
  truncated?: boolean;
  bytes: number;
  /** What a run would record as the block's warnings (paths that read nothing, filters that failed); at most 50. */
  warnings: string[];
  /** Warnings past the 50 listed. */
  warningsOmitted?: number;
  /** Parse errors (a broken `{{ … }}` renders as written), deduplicated; at most 50. */
  errors: string[];
  /** Parse errors past the 50 listed. */
  errorsOmitted?: number;
}

/** A value's shape: its JSON type, plus an object's keys (each key's type) or a list's length and first item's keys. */
export interface WorkflowExpressionShape {
  type: string;
  /** Object: key → type ("string", "number", "object", "array (3)"…). */
  keys?: Record<string, string>;
  keysOmitted?: number;
  /** Array. */
  length?: number;
  /** Array whose first item is an object: that item's keys. */
  itemKeys?: Record<string, string>;
  /** Why the shape is not given (a large output not read by any template here). */
  note?: string;
}

/** What the context held: the roots a template may read and the shape of each. */
export interface WorkflowExpressionContextOutline {
  /** Absent when the block receives nothing. */
  input?: WorkflowExpressionShape;
  trigger?: WorkflowExpressionShape;
  /** Every block a template here can read, by name. */
  nodes: Record<string, { status: string; output?: WorkflowExpressionShape; error?: string }>;
  run: Record<string, unknown>;
  project: Record<string, unknown>;
  workflow: { id: string; name: string };
  /** Secret names (`{{ secrets.NAME }}`); values are never shown. */
  secrets: string[];
}

export interface PreviewWorkflowExpressionResponse {
  results: WorkflowExpressionPreviewResult[];
  /** The block whose point of view was taken; null when none was named. */
  node: { id: string; name: string; type: WorkflowNodeType } | null;
  /** Where the data came from. */
  source: {
    /** "requested": `runId`; "reached-node": the latest run that reached the block; "latest": the latest run; "none": no run. */
    run: "requested" | "reached-node" | "latest" | "none";
    runId: string | null;
    runStatus?: WorkflowRunStatus;
    runTest?: boolean;
    runQueuedAt?: string;
    /** Names of the blocks whose pinned outputs were used. */
    pinned: string[];
  };
  available: WorkflowExpressionContextOutline;
  /** What the preview does not reproduce (e.g. an agent prompt's `{variables}`, `project.branch`). */
  notes: string[];
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
  /** The type's full contract (arguments, result, limits…); absent from older daemons. */
  guide?: readonly WorkflowGuideSection[];
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
