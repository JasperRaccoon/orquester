// Internal workflow contracts. Agent sessions use DaemonApi so route gates apply.
// Executors persist WaitingOn before side effects; the engine redacts outputs, errors,
// warnings and logs before persistence or broadcast.

import type { AgentAccountsResponse, UsageResponse } from "@orquester/api";
import type {
  AccountSelectionDecision,
  AgentChainEntry,
  ListWorkflowRunsResponse,
  ReportWorkflowStepRequest,
  ReportWorkflowStepResponse,
  RunWorkflowRequest,
  RunWorkflowResponse,
  Workflow,
  WorkflowBlockError,
  WorkflowBlockPass,
  WorkflowBlockRun,
  DecideWorkflowGateRequest,
  DecideWorkflowGateResponse,
  ListWorkflowGatesResponse,
  WorkflowGateDecision,
  WorkflowGateDeciderKind,
  WorkflowGatePhase,
  WorkflowGateState,
  WorkflowRunStartedBy,
  WorkflowLoopSessionMode,
  WorkflowNode,
  WorkflowNodeType,
  WorkflowRun,
  WorkflowStepReport,
  WorkflowRunSummary,
  WorkflowSecretName,
  WorkflowSummary,
  WorkflowTriggerPayload
} from "@orquester/api";
import type { CallerPrincipal } from "@orquester/api/agent-chat";
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
  | { kind: "http"; method: string; startedAt: string }
  /**
   * A gate (spec 2026-11-10 §6.2) — a gate block's, or a loop-limit gate on a loop edge's source
   * block (§7.2). Persisted BEFORE any notification or decider launch; a wait state (no agent or
   * process slot). The gate's full record is `PersistedRun.gates[gateId]`.
   */
  | {
      kind: "gate";
      gateId: string;
      openedAt: string;
      phase: WorkflowGatePhase;
      /** When the current phase started (the person phase's `timeout.minutes` count from it). */
      phaseStartedAt: string;
      /** The current phase's persisted deadline, re-armed after a restart. */
      phaseDeadlineAt: string;
      decider: { kind: WorkflowGateDeciderKind; label: string };
      /** The reviewer agent's chat, or the launcher's thread, once known. */
      deciderSessionId?: string;
      escalatedAt?: string;
      /** The decider agent's resume state (agent decider; same vocabulary as the agent block's). */
      agent?: Omit<Extract<WaitingOn, { kind: "agent" }>, "kind">;
      /** Reminders the reviewer agent got after a turn that settled without a decision (at most one). */
      reminders?: number;
      /**
       * The launcher's queued message: its command id is minted and persisted BEFORE the first post
       * (the host's receipt dedupes a re-post after a restart); `delivered` once the chat took it.
       */
      launcher?: { commandId: string; delivered?: true };
      /**
       * A loop-limit gate (§7.2), engine-owned: the block finished (its output kept) on `handle`,
       * whose loop edge `edgeId` was at its limit. Its gate id is minted and persisted here with the
       * block's finish, BEFORE the record is stored and the person pushed; a restart re-opens or
       * re-awaits exactly that gate. The block's executor never resumes this wait.
       */
      loopLimit?: { edgeId: string; handle: string };
    };

export interface PersistedBlockState extends WorkflowBlockRun {
  waitingOn?: WaitingOn;
  /** The whole output, when it is bigger than the inline preview (the file under the attempt dir). */
  outputFile?: string;
  // Loops (spec 2026-11-10 §7.2; engine-internal, never on the wire)
  /** Earlier passes, as persisted (their output files; an interruption still to settle). */
  passes?: PersistedBlockPass[];
  /**
   * Attempts the block's earlier passes used. `attempt` counts within the pass (the retry policy
   * and `{{ run.attempt }}` read it); storage — attempt directories, output files, a Run workflow
   * block's child-run id — is keyed by `passAttemptBase + attempt`, unique across passes.
   */
  passAttemptBase?: number;
  /** The loop edge whose reset started this pass. */
  loopEdgeId?: string;
}

/** One earlier pass of a block, as `run.json` keeps it. */
export type PersistedBlockPass = WorkflowBlockPass & {
  outputFile?: string;
  /**
   * The pass was running when a loop reset it: what it waited on (an agent turn, a process, a child
   * run…). Cleared once its executor has been stopped; a restart before that stops it then.
   */
  interruptedFrom?: WaitingOn;
};

/**
 * What an executor knows of the loop that ran its block again (spec 2026-11-10 §7.3): set on
 * `NodeExecutionContext.loop` from a block's second pass on.
 */
export interface NodeLoopContext {
  /** This block's pass (≥ 2). */
  pass: number;
  /** The loop edge whose reset started this pass. */
  edgeId: string;
  /** "Workflow loop: pass `loopPass` of up to `maxPasses`" — the edge's count + 1, its limit + 1. */
  loopPass: number;
  maxPasses: number;
  /** The edge's session option: it applies to every agent block of the reset set. */
  session: WorkflowLoopSessionMode;
  /** This block is the loop edge's target (only the target receives the feedback). */
  target: boolean;
  sourceName: string;
  targetName: string;
  feedback?: string;
  /** This block's previous pass (its session, report and output preview), when it ran one. */
  previous?: WorkflowBlockPass;
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
  /**
   * The sub-workflow definitions frozen when the top-level run started (by workflow id; every
   * workflow its Run workflow blocks reach, recursively, up to the depth cap): a child run runs the
   * frozen definition, never a later edit — what a run's approval showed is what runs. A child run
   * carries only its own subtree of its top-level run's map (what its blocks reach). Pinned test data
   * is left out (a child never uses it). Absent: none to freeze, or a run recorded by an older build
   * (its children then read the current definitions).
   */
  subWorkflows?: Record<string, Workflow>;
  /**
   * A child run: the attempt of its parent's Run workflow block that started it (its id is derived
   * from parent run, block and attempt). Absent on a child recorded by an older build.
   */
  parentAttempt?: number;
  /**
   * Gates whose person-phase push went out, by gate id → that phase's start (spec 2026-11-10 §6.4):
   * a restart never pushes the same phase twice. Engine bookkeeping, never on the wire.
   */
  gateNotices?: Record<string, string>;
}

export interface RunStore {
  create(run: PersistedRun): Promise<void>;
  /** Atomic rewrite of run.json; serialized per run. */
  save(run: PersistedRun): Promise<void>;
  load(runId: string): Promise<PersistedRun | null>;
  /** Whether a run with this id is recorded (readable or not); throws when that cannot be told. */
  exists(runId: string): Promise<boolean>;
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

/** Who asks for a run, as the DAEMON knows it (the route's principal) — never a request field. */
export interface RunCaller {
  /** Absent: `{kind: "human"}`. */
  startedBy?: WorkflowRunStartedBy;
}

export interface WorkflowEngine {
  /** Manual / test / retry runs (routes, MCP). Applies the overlap policy unless `force`. */
  run(workflowId: string, request: RunWorkflowRequest, caller?: RunCaller): Promise<RunWorkflowResponse>;
  /**
   * Decide (or, for an agent decider, escalate) a waiting gate (spec 2026-11-10 §6.2, §6.3): the
   * first decision wins and is persisted before the run moves on. `principal` is the route's —
   * who decides is the daemon's record, never an argument.
   */
  decideGate?(runId: string, gateId: string, request: DecideWorkflowGateRequest, principal: CallerPrincipal): Promise<DecideWorkflowGateResponse>;
  /** Gates across runs: waiting ones (active runs), and with `includeDecided` the retained runs' too. */
  listGates?(query: { projectPath?: string; includeDecided?: boolean }): Promise<ListWorkflowGatesResponse>;
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
  /**
   * `report_step_result` (spec 2026-11-10 §5.2): record `report` on the running pass of the agent
   * block whose recorded sessions include `sessionId` (the calling chat), persisted before it
   * resolves. Throws `WorkflowEngineError` NOT_A_WORKFLOW_STEP / INVALID_REPORT.
   */
  reportStepResult(sessionId: string, report: ReportWorkflowStepRequest): Promise<ReportWorkflowStepResponse>;
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
    /** The `loop` namespace (spec 2026-11-10 §7.2); absent until loops set it. */
    loop?: { pass: number; feedback?: string };
  };
  /** Resolved secret values (name -> value); never persist these. */
  secrets: Record<string, string>;
  /** Present when resuming after a restart. */
  resumeFrom?: WaitingOn;
  /** Set from a block's second pass on: the loop that ran it again (spec 2026-11-10 §7.3). */
  loop?: NodeLoopContext;
  /** Persist what the block waits on BEFORE the side effect. `undefined` clears. */
  setWaitingOn(waitingOn: WaitingOn | undefined): Promise<void>;
  /** Live fields for the run view (throttled broadcast; persisted). */
  update(
    patch: Partial<
      Pick<
        WorkflowBlockRun,
        "activity" | "selection" | "hops" | "sessionId" | "logs" | "waitingUntil" | "childRunId" | "warnings" | "report" | "gateId" | "sessionNote"
      >
    >
  ): void;
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
  /**
   * The current pass's latest valid `report_step_result` (spec 2026-11-10 §5.2), as the run holds it
   * (persisted before the tool acknowledged it); undefined until the agent reports. Always set by the
   * engine (optional only so hand-built test contexts need not).
   */
  stepReport?(): WorkflowStepReport | undefined;
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
  /** A gate now waits for the person (decider human, or escalated; never a test run's): its push. */
  gateWaiting?(gate: WorkflowGateState, workflow: Workflow): void;
}

// ---------------------------------------------------------------------------
// Gates (spec 2026-11-10 §6; gates/host.ts implements this for the gate executor)
// ---------------------------------------------------------------------------

/** What changed a waiting gate. `byDecider`: the assigned agent decider did it itself. */
export interface GateChange {
  kind: "decided" | "escalated" | "expired" | "cancelled";
  byDecider: boolean;
}

/** The engine's gate records as the gate executor (nodes/gate.ts) reads and changes them. */
export interface GateServices {
  /** The gate's live record (a copy), or undefined. */
  get(runId: string, gateId: string): WorkflowGateState | undefined;
  /**
   * Store (or replace) a record, redacted — in memory only: persisted with the caller's next save
   * (a Gate block's `setWaitingOn`), published. Ignored once the engine is stopping or the run ended.
   */
  put(runId: string, gate: WorkflowGateState): void;
  /** Resolves on the gate's next change, or null once `signal` aborts. */
  nextChange(runId: string, gateId: string, signal: AbortSignal): Promise<GateChange | null>;
  /** Hand the gate to the person (persisted; the block's WaitingOn follows); null when it no longer waits. */
  escalate(runId: string, gateId: string, reason: string, opts: { byDecider: boolean }): Promise<WorkflowGateState | null>;
  /** Persist a decision (first wins). */
  decide(runId: string, gateId: string, decision: WorkflowGateDecision, opts: { byDecider: boolean }): Promise<{ decision: WorkflowGateDecision; alreadyDecided: boolean }>;
  /** The person phase passed: `timeout.then` (a choice, decided by "timeout") or expired. Persisted. */
  expire(runId: string, gateId: string, then: { kind: "choice"; choice: string } | { kind: "fail" }): Promise<WorkflowGateState | null>;
  /** Mark it cancelled (its run is ending). */
  cancel(runId: string, gateId: string): void;
  /** Push to the person once per person phase (none for a test run's gate); after the gate is on disk. */
  notifyPerson(runId: string, gateId: string): Promise<void>;
  /** The top-level run's `startedBy` (a child run asks its top-level run's launcher). */
  startedBy(runId: string): WorkflowRunStartedBy | undefined;
  /** The top-level run's id (the run itself at depth 0). */
  rootRunId(runId: string): string;
  /** A test run (its gates are answered by the person in the editor only, §7.5). */
  isTest(runId: string): boolean;
  /** The top-level run's workflow name (a sub-workflow's gate names it to the launcher). */
  rootWorkflowName(runId: string): string | undefined;
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

/** The daemon API attached after the runtime's services have been created. */
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
  /**
   * Start the child run of one attempt of a Run workflow block — idempotent per (parent run, block,
   * `attempt`): the child's id is derived from them, and asking again returns the run that exists.
   */
  runChild(input: { workflowId: string; input: unknown; parentRunId: string; parentNodeId: string; depth: number; signal: AbortSignal; attempt?: number; untrusted?: boolean }): Promise<{ runId: string; wait: Promise<WorkflowRunSummary & { finalOutput?: unknown }> }>;
  /** Re-attach to a child run after a restart. */
  awaitRun(runId: string, signal: AbortSignal): Promise<WorkflowRunSummary & { finalOutput?: unknown }>;
  /** The run's gates (the engine's; absent in hand-built test contexts). */
  gates?: GateServices;
  logger: WorkflowLogger;
}
