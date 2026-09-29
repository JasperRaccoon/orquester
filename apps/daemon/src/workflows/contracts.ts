// Automated workflows — the daemon-internal seams (docs/superpowers/specs/2026-09-28-automated-workflows-design.md).
//
// Every module under apps/daemon/src/workflows/ talks to its neighbours ONLY through the interfaces
// below, so the storage, the engine, the node executors, the agent block, the sandbox and the
// triggers can be built and tested independently (each with fakes of the others).
//
//   routes.ts ──► WorkflowStore, SecretStore, WorkflowEngine
//   triggers/ ──► TriggerHost (implemented by the engine)
//   engine.ts ──► WorkflowStore, RunStore, SecretStore, NodeExecutors, EngineServices
//   nodes/*   ──► NodeExecutionContext (+ EngineServices it carries)
//   agent/*   ──► ChatClient (the daemon's own REST, in-process), UsageReader, AccountsReader, CooldownStore
//   sandbox/  ──► SandboxRunner
//
// Rules that hold across all of them:
//   - No module reaches a daemon service directly for agent sessions: agents are driven through
//     `DaemonApi` (the MCP's seam) so every route gate applies.
//   - Every wait is event- or timer-driven and resumable: a node persists its `WaitingOn` BEFORE the
//     side effect it waits on (a command id minted and written before the POST).
//   - Secret VALUES never reach a persisted artifact or a broadcast: `Redactor` is applied by the
//     engine to outputs, errors, warnings and logs.

import type { AgentAccountsResponse, UsageResponse } from "@orquester/api";
import type {
  AccountSelectionDecision,
  AgentChainEntry,
  AgentHop,
  ListWorkflowRunsResponse,
  RunWorkflowRequest,
  RunWorkflowResponse,
  Workflow,
  WorkflowBlockError,
  WorkflowBlockRun,
  WorkflowNode,
  WorkflowNodeType,
  WorkflowRun,
  WorkflowRunSummary,
  WorkflowSecretName,
  WorkflowSummary,
  WorkflowTriggerPayload
} from "@orquester/api";
import type { AccountCooldown } from "@orquester/config";
import type { DaemonApi } from "../mcp/daemon-api.ts";

// ---------------------------------------------------------------------------
// Clock / ids (injectable for tests — no sleeps anywhere)
// ---------------------------------------------------------------------------

export interface Clock {
  now(): Date;
  setTimeout(fn: () => void, ms: number): { cancel(): void };
}

export type MintId = () => string;

export interface WorkflowLogger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Definitions (service.ts)
// ---------------------------------------------------------------------------

export interface WorkflowStore {
  list(): Workflow[];
  get(id: string): Workflow | null;
  /** Fires after a definition is persisted (create, replace, patch, duplicate, enable). */
  onChanged(listener: (workflow: Workflow) => void): () => void;
  onDeleted(listener: (id: string) => void): () => void;
}

// ---------------------------------------------------------------------------
// Secrets (secrets.ts, §5.7)
// ---------------------------------------------------------------------------

export interface SecretStore {
  /** Names only — values never leave the daemon. */
  list(workflowId?: string): WorkflowSecretName[];
  /** name -> value, a workflow's own secrets shadowing global ones. Engine-internal only. */
  resolve(workflowId: string): Record<string, string>;
  set(name: string, value: string, workflowId?: string): Promise<void>;
  delete(name: string, workflowId?: string): Promise<boolean>;
  deleteForWorkflow(workflowId: string): Promise<void>;
}

/** Replaces every secret value (≥ 4 chars) with `«secret:NAME»`, deep through JSON values. */
export interface Redactor {
  text(value: string): string;
  value<T>(value: T): T;
}

// ---------------------------------------------------------------------------
// Runs on disk (run-store.ts, §5.8)
// ---------------------------------------------------------------------------

/** What a running block waits on — persisted so a restarted daemon can resume it. */
export type WaitingOn =
  | {
      kind: "agent";
      sessionId: string;
      /** The command id minted and persisted BEFORE its POST (host receipts dedupe a re-post). */
      commandId: string;
      /** The command that id belongs to. */
      command: "turn" | "interrupt" | "account" | "answer" | "approval";
      /** `turnBaseline(summary)` taken before the turn was sent (chat-client). */
      baseline: unknown;
      deadlineAt: string;
      /** The failover loop's step (agent/failover.ts owns the vocabulary). */
      phase: string;
      /** Everything else the agent block needs to resume (chain position, tried accounts, …). */
      state: Record<string, unknown>;
    }
  /**
   * A sandbox attempt. `spawning` is the marker persisted BEFORE the spawn (pid/starttime 0): a
   * restart that finds it adopts the runner from the attempt's `handle.json`, or reads its exit.
   */
  | { kind: "process"; pid: number; starttime: number; attemptDir: string; deadlineAt: string; spawning?: true }
  | { kind: "timer"; until: string; purpose: "wait" | "retry-delay" | "wait-for-reset" }
  | { kind: "child-run"; runId: string }
  | { kind: "http"; method: string; startedAt: string };

export interface PersistedBlockState extends WorkflowBlockRun {
  waitingOn?: WaitingOn;
  /** The whole output, when it is bigger than the inline preview (the file under the attempt dir). */
  outputFile?: string;
}

/** `run.json`. */
export interface PersistedRun extends Omit<WorkflowRun, "blocks"> {
  version: 1;
  blocks: Record<string, PersistedBlockState>;
  /** Sub-workflow depth (0 = top level). */
  depth: number;
  /** Outputs reused by a retry (`retryOf`) or taken from pins (test runs), by node id. */
  seededOutputs?: Record<string, unknown>;
  /** The node a partial test run starts from. */
  fromNodeId?: string;
  /** Test one block: only `fromNodeId` executes; its downstream is left skipped (engine). */
  testNodeOnly?: boolean;
  /**
   * Why a `queued` run has not started: "overlap" = the one pending fire of an overlap:"queue"
   * workflow, waiting for its active run to end; "capacity" = the global run cap (engine).
   */
  queuedFor?: "overlap" | "capacity";
  /** The block whose output is `finalOutput` (its whole value may be in that block's output file). */
  finalOutputNodeId?: string;
  /** Test runs: a block with a pinned output (the frozen definition's `pinned`) uses it instead of running. */
  usePinned?: boolean;
}

export interface RunStore {
  create(run: PersistedRun): Promise<void>;
  /** Atomic rewrite of run.json; serialized per run. */
  save(run: PersistedRun): Promise<void>;
  load(runId: string): Promise<PersistedRun | null>;
  /** Runs whose status is queued/running (for resume at boot). */
  listUnfinished(): Promise<PersistedRun[]>;
  listForWorkflow(workflowId: string, opts: { before?: string; limit: number }): Promise<ListWorkflowRunsResponse>;
  latestForWorkflow(workflowId: string): WorkflowRunSummary | undefined;
  activeForWorkflow(workflowId: string): WorkflowRunSummary[];
  /** Appends to events.ndjson. */
  appendEvent(runId: string, event: Record<string, unknown>): Promise<void>;
  /** `<runsDir>/<runId>/nodes/<nodeId>/<attempt>/` (created). */
  attemptDir(runId: string, nodeId: string, attempt: number): Promise<string>;
  /** Writes a big output beside the attempt and returns its path. */
  writeOutputFile(runId: string, nodeId: string, attempt: number, output: unknown): Promise<string>;
  readOutputFile(path: string): Promise<unknown>;
  /** `keep`: runs to leave on record (a temporary project they name could not be deleted). */
  deleteForWorkflow(workflowId: string, options?: { keep?: ReadonlySet<string> }): Promise<void>;
  /** Every workflow id with a run on record — a deleted workflow's kept runs included (sweepers). */
  workflowIds?(): string[];
  /** Retention: keep runsPerWorkflow newest and nothing older than runRetentionDays; never an active run. */
  sweep(): Promise<void>;
}

// ---------------------------------------------------------------------------
// The engine as the routes and the triggers see it (engine.ts)
// ---------------------------------------------------------------------------

export interface FireRequest {
  workflowId: string;
  /** The trigger node that fired (absent for a manual run without a manual trigger). */
  triggerNodeId?: string;
  payload: WorkflowTriggerPayload;
  kind: WorkflowRunSummary["trigger"]["kind"];
  /** Text for history, e.g. "Push to main (a1b2c3d)". */
  text?: string;
}

export interface WorkflowEngine {
  /** Manual / test / retry runs (routes, MCP). Applies the overlap policy unless `force`. */
  run(workflowId: string, request: RunWorkflowRequest): Promise<RunWorkflowResponse>;
  /** Test one block (upstream from pins, else the last run). */
  testNode(workflowId: string, nodeId: string): Promise<RunWorkflowResponse>;
  cancel(runId: string): Promise<boolean>;
  /** Resolves when the run has ended (optional: the delete cascade waits, bounded, for cancelled runs). */
  waitForRun?(runId: string): Promise<unknown>;
  getRun(runId: string): Promise<WorkflowRun | null>;
  listRuns(workflowId: string, opts: { before?: string; limit: number }): Promise<ListWorkflowRunsResponse>;
  nodeOutput(runId: string, nodeId: string): Promise<{ found: boolean; output?: unknown }>;
  /** The attempt's log file path (latest attempt), for the chunked log route. */
  nodeLogPath(runId: string, nodeId: string, stream: "stdout" | "stderr"): Promise<string | null>;
  /** Whether the block's log may still grow (follow mode ends when false). */
  isNodeLogLive(runId: string, nodeId: string): boolean;
  deleteTempProject(runId: string): Promise<boolean>;
  accountPreview(chain: AgentChainEntry[], projectPath?: string): Promise<AccountSelectionDecision>;
  /** Summary rows for the rail (trigger texts, last run, active runs). */
  summarize(workflow: Workflow): WorkflowSummary;
  /** Boot: resume unfinished runs (after agentChat.init()). */
  resume(): Promise<void>;
  start(): void;
  /** Fast (3 s backstop): stops timers and sweepers, flushes writes; never kills sandbox children. */
  stop(): Promise<void>;
}

/** What the schedule and git triggers need from the engine. */
export interface TriggerHost {
  /** Enabled workflows' trigger nodes of a type. */
  enabledTriggers<T extends "trigger.schedule" | "trigger.git">(
    type: T
  ): { workflow: Workflow; node: Extract<WorkflowNode, { type: T }> }[];
  /** Fire a run (overlap policy applies). */
  fire(request: FireRequest): Promise<RunWorkflowResponse>;
  /** Record a run stub that did not execute (e.g. `skipped_missed`). */
  recordSkipped(request: FireRequest, reason: "missed" | "overlap"): Promise<void>;
  /** Called when definitions change so triggers can re-arm. */
  onDefinitionsChanged(listener: () => void): () => void;
}

// ---------------------------------------------------------------------------
// Node executors (nodes/*, agent/*)
// ---------------------------------------------------------------------------

export interface ProjectContext {
  /** Realpath'd, inside fsRoot. */
  path: string;
  name: string;
  workspace: string;
  temp: boolean;
}

export type NodeResult =
  | { status: "succeeded"; output: unknown; handle?: string; warnings?: string[] }
  | { status: "failed"; error: WorkflowBlockError; output?: unknown }
  /** A Stop block / `stop()` in code: ends the run. */
  | { status: "stopped"; as: "success" | "failure"; message?: string; output?: unknown }
  | { status: "cancelled" };

export interface NodeExecutionContext<T extends WorkflowNodeType = WorkflowNodeType> {
  runId: string;
  workflow: Workflow;
  node: Extract<WorkflowNode, { type: T }>;
  attempt: number;
  /** Aborted on run cancel, run timeout, or a failing sibling ending the run. */
  signal: AbortSignal;
  project: ProjectContext;
  /** Render a template to text against the run context (`{{…}}` only). */
  render(template: string): { text: string; warnings: string[] };
  /** Render a template whose whole body is one `{{ … }}` to its raw VALUE; else to text. */
  renderValue(template: string): { value: unknown; warnings: string[] };
  /**
   * The run context an expression reads, every root but `secrets` (those are {@link secrets}); a
   * Code block's arguments read input, nodes, trigger, run and project from it.
   */
  expressionContext(): {
    input: unknown;
    nodes: Record<string, { output: unknown; status: string; error?: WorkflowBlockError }>;
    trigger: unknown;
    run: { id: string; startedAt: string; workflowId: string; workflowName: string; attempt: number };
    project: { path: string; name: string; workspace: string; branch?: string };
    workflow: { id: string; name: string };
  };
  /** Resolved secret values (name -> value); never persist these. */
  secrets: Record<string, string>;
  /** Present when resuming after a restart. */
  resumeFrom?: WaitingOn;
  /** Persist what the block waits on BEFORE the side effect. `undefined` clears. */
  setWaitingOn(waitingOn: WaitingOn | undefined): Promise<void>;
  /** Live fields for the run view (throttled broadcast; persisted). */
  update(patch: Partial<Pick<WorkflowBlockRun, "activity" | "selection" | "hops" | "sessionId" | "logs" | "waitingUntil" | "childRunId" | "warnings">>): void;
  /** `<runsDir>/<runId>/nodes/<nodeId>/<attempt>/` */
  attemptDir(): Promise<string>;
  /** The node's timeout in ms (per-type default and max applied). */
  timeoutMs: number;
  /** Sub-workflow depth of this run. */
  depth: number;
  /**
   * When this attempt started (wall clock): deadlines derive from it, so a restart never extends
   * them. Always set by the engine (optional only so hand-built test contexts need not).
   */
  startedAt?: string;
  /**
   * The live inputs this block runs on (sources that finished on the handle an edge takes), in edge
   * order. Always set by the engine (optional only so hand-built test contexts need not).
   */
  liveInputs?(): { nodeId: string; name: string; output: unknown }[];
  services: EngineServices;
  log: WorkflowLogger;
}

export interface NodeExecutor<T extends WorkflowNodeType = WorkflowNodeType> {
  type: T;
  execute(ctx: NodeExecutionContext<T>): Promise<NodeResult>;
}

export type NodeExecutorRegistry = { [K in WorkflowNodeType]?: NodeExecutor<K> };

// ---------------------------------------------------------------------------
// Services the executors use
// ---------------------------------------------------------------------------

export interface UsageReader {
  /** The in-memory usage cache (no I/O). */
  snapshot(): UsageResponse;
}

export interface AccountsReader {
  list(): AgentAccountsResponse;
}

export interface CooldownStore {
  /** Keyed `<family>:<accountId>`. */
  get(family: string, accountId: string): AccountCooldown | null;
  set(family: string, accountId: string, cooldown: AccountCooldown): Promise<void>;
  /** Active (until > now) cooldowns. */
  list(): Record<string, AccountCooldown>;
}

export interface SandboxSpawnRequest {
  kind: "code" | "shell";
  /** Code: the module source. Shell: the script. */
  source: string;
  shell?: "bash" | "sh";
  cwd: string;
  /** Extra env for the child (already rendered); merged over the scrubbed base env. */
  env: Record<string, string>;
  /** Code only: written to input.json (0600), deleted when the attempt ends. */
  input?: Record<string, unknown>;
  memoryMb?: number;
  timeoutMs: number;
  attemptDir: string;
  /** For ORQUESTER_WORKFLOW_RUN_ID / _ID. */
  runId: string;
  workflowId: string;
  /** Project dir for `require` resolution (code). */
  projectPath: string;
}

export interface SandboxHandle {
  pid: number;
  starttime: number;
  attemptDir: string;
}

export interface SandboxExit {
  /** Exit code; null when killed by a signal. */
  code: number | null;
  signal: string | null;
  timedOut: boolean;
  /** Code: the runner's result.json. */
  result?: { ok: true; value: unknown } | { ok: false; error: { message: string; stack?: string } } | { stop: true; reason?: string };
  stdoutBytes: number;
  stderrBytes: number;
}

export interface SandboxRunner {
  spawn(request: SandboxSpawnRequest): Promise<SandboxHandle>;
  /** Wait for exit (also for a process adopted after a restart); honours the deadline and the signal. */
  wait(handle: SandboxHandle, opts: { deadlineAt: Date; signal: AbortSignal; onLogs?: (bytes: { stdout: number; stderr: number }) => void }): Promise<SandboxExit>;
  /** After a restart: is this (pid, starttime) still our process? */
  isAlive(handle: SandboxHandle): boolean;
  /** The runner's handle as `spawn` recorded it (`<attemptDir>/handle.json`), or null. */
  readHandle(attemptDir: string): Promise<SandboxHandle | null>;
  /** Read a finished attempt's exit.json/result.json when the process is gone. */
  readExit(attemptDir: string): Promise<SandboxExit | null>;
  /** SIGTERM the group, SIGKILL after the grace. */
  kill(handle: SandboxHandle): Promise<void>;
}

export interface ProjectOps {
  /** Resolve an existing project path (inside fsRoot, `<ws>/<project>`) or null. */
  resolveExisting(projectPath: string): Promise<ProjectContext | null>;
  /** Create a temp project for a run; clone + checkout `ref` when given. */
  createTemp(input: {
    workspace: string;
    name: string;
    source: { kind: "empty" } | { kind: "clone"; url: string; ref?: string };
  }): Promise<ProjectContext>;
  deleteProject(path: string): Promise<void>;
  /** Where `createTemp` would put `<workspace>/<name>` (persisted BEFORE the creation). */
  tempPathFor(workspace: string, name: string): string;
  gitStatusShort(path: string, maxBytes: number): Promise<string>;
  currentBranch(path: string): Promise<string | undefined>;
}

export interface WorkflowNotifier {
  runFinished(run: WorkflowRunSummary, workflow: Workflow): void;
}

/** Renders saved-prompt `{variables}` daemon-side (packages/api prompt-variables + GitService). */
export interface PromptRenderer {
  render(input: {
    body: string;
    projectPath: string;
    timeZone: string;
    agentLabel?: string;
    modelLabel?: string;
  }): Promise<{ ok: true; text: string } | { ok: false; reason: string }>;
  savedPromptBody(promptId: string): { body: string; title: string } | null;
}

/**
 * The agent block's seam onto chat sessions. Implemented over `DaemonApi` (the daemon's own REST,
 * in-process, unix app) by agent/chat.ts; faked in tests.
 */
export interface ChatClient {
  readonly api: DaemonApi;
}

export interface EngineServices {
  clock: Clock;
  mintId: MintId;
  chat: ChatClient;
  usage: UsageReader;
  accounts: AccountsReader;
  cooldowns: CooldownStore;
  sandbox: SandboxRunner;
  projects: ProjectOps;
  prompts: PromptRenderer;
  store: WorkflowStore;
  /** Starts a child run (sub-workflow block) and resolves when it ends. */
  runChild(input: { workflowId: string; input: unknown; parentRunId: string; parentNodeId: string; depth: number; signal: AbortSignal }): Promise<{ runId: string; wait: Promise<WorkflowRunSummary & { finalOutput?: unknown }> }>;
  /** Re-attach to a child run after a restart. */
  awaitRun(runId: string, signal: AbortSignal): Promise<WorkflowRunSummary & { finalOutput?: unknown }>;
  logger: WorkflowLogger;
}

/** Helpers the agent block reports hops with. */
export type { AgentHop };
