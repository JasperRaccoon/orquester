// Automated workflows — the run engine (docs/superpowers/specs/2026-09-28-automated-workflows-design.md
// §3.4, §5.8–§5.11, §7.6).
//
// One engine per daemon. It owns the run queue (overlap policy per workflow, a global cap on
// concurrent runs, FIFO), the graph walk (dead-path readiness from @orquester/api, independent
// branches concurrently, agent blocks and sandbox processes behind their own global caps), block
// attempts and retries, persistence (`run.json` on every state change, coalesced so the last state
// is never lost), resume after a restart, redaction of everything persisted or broadcast, the
// throttled run events, and sub-workflows.
//
// Rules that hold throughout:
//   - Everything a block produces is redacted with the run's secrets BEFORE it is kept, persisted
//     or published — downstream blocks read the redacted value too, so what they see is what a
//     resumed run would read back from disk.
//   - A block persists what it waits on (`setWaitingOn`) before its side effect and the promise
//     resolves only once that state is on disk.
//   - `stop()` is fast and kills nothing: detached sandbox children, agent sessions and child runs
//     carry on; the next engine resumes them from `run.json`. After `stop()` nothing more is
//     written or published by this instance, whatever its executors still report.

import {
  WORKFLOW_LIMITS,
  checkStepReport,
  computeReadiness,
  downstreamOf,
  executableNodes,
  hasWorkflowErrors,
  isLoopEdge,
  isRunActive,
  isTriggerType,
  passThroughHandle,
  pinnedHandle,
  renderTemplate,
  reportRequired,
  stepReportDecl,
  renderTemplateValue,
  topologicalOrder,
  upstreamOf,
  validateWorkflow,
  validateWorkflowInput,
  workflowInputErrorsText,
  workflowRunInputs,
  type AccountSelectionDecision,
  type AgentChainEntry,
  type ExpressionContext,
  type ListWorkflowRunsResponse,
  type ReportWorkflowStepRequest,
  type ReportWorkflowStepResponse,
  type RunWorkflowRequest,
  type RunWorkflowResponse,
  type WorkflowRunStartedBy,
  type Workflow,
  type WorkflowBlockError,
  type WorkflowBlockRun,
  type WorkflowInputError,
  type WorkflowGateState,
  type WorkflowNode,
  type WorkflowNodeType,
  type WorkflowRun,
  type WorkflowRunErrorKind,
  type WorkflowRunStatus,
  type WorkflowRunSummary,
  type WorkflowStepReport,
  type WorkflowRunUpdatedPayload,
  type WorkflowSummary,
  type WorkflowTriggerKind,
  type WorkflowTriggerPayload,
  type WorkflowsEventType
} from "@orquester/api";
import type { CallerPrincipal } from "@orquester/api/agent-chat";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { WORKFLOW_GRAPH_ID_PATTERN } from "@orquester/config";

import type {
  Clock,
  EngineServices,
  FireRequest,
  MintId,
  NodeExecutionContext,
  NodeExecutorRegistry,
  NodeResult,
  PersistedBlockState,
  PersistedRun,
  ProjectContext,
  RunCaller,
  RunStore,
  SecretStore,
  TriggerHost,
  WaitingOn,
  WorkflowEngine,
  WorkflowLogger,
  WorkflowNotifier,
  WorkflowStore
} from "./contracts.ts";
import {
  blockTimeoutMs,
  DEFAULT_ENGINE_LIMITS,
  isFinishedBlockStatus,
  jsonText,
  maxTriesOf,
  outputPreview,
  publicBlock,
  publicRun,
  retryDelayMs,
  sleepUntil,
  toRunSummary,
  ChildRunUnknownError,
  EngineStoppedError,
  WorkflowEngineError
} from "./run-context.ts";
import { LOOP_LIMIT_ALLOW, LOOP_LIMIT_CHOICES, loopLimitDetails, loopLimitError, loopLimitQuestion } from "./loops/limit.ts";
import {
  applyLoopReset,
  latestPass,
  loopCount,
  loopEdgeTaken,
  loopFeedbackOf,
  loopLimit,
  loopNamespace,
  nodeLoopContext,
  pendingInterruptions,
  settleInterruptedPass,
  storageAttempt
} from "./loops/state.ts";
import { createSlotPool, type SlotPool } from "./scheduler-queue.ts";
// Gates, parked runs (spec 2026-11-10 §6): their logic lives in gates/*; the hooks here are marked "gates:".
import { overlapSkipDetail } from "./gates/engine-hooks.ts";
import { createGateHost, type GateHost, type GateRunAccess } from "./gates/host.ts";
import { createParking } from "./gates/parking.ts";
import { clipChars, isLoopLimitWait, isWaiting, PERSON_LABEL, personDeadline } from "./gates/state.ts";
import { createRedactor, type SecretRedactor } from "./sandbox/redact.ts";

/** The services an executor gets, minus what the engine provides itself. */
export type EngineServiceDeps = Omit<EngineServices, "runChild" | "awaitRun" | "clock" | "mintId" | "logger" | "store">;

export interface WorkflowEngineOptions {
  store: WorkflowStore;
  runStore: RunStore;
  secrets: Pick<SecretStore, "resolve">;
  executors: NodeExecutorRegistry;
  services: EngineServiceDeps;
  /** The WORKFLOWS_CHANNEL broadcaster. */
  publish(type: WorkflowsEventType, payload: unknown): void;
  notifier?: WorkflowNotifier;
  /** The rail's summary row of a workflow (storage builds it from the run store's index). */
  summarize(workflow: Workflow): WorkflowSummary;
  accountPreview?(chain: AgentChainEntry[], projectPath?: string): Promise<AccountSelectionDecision>;
  clock: Clock;
  mintId: MintId;
  logger: WorkflowLogger;
}

export type RunResult = WorkflowRunSummary & { finalOutput?: unknown };

export interface WorkflowRuntimeEngine extends WorkflowEngine, TriggerHost {
  /** Resolves when the run has finished (queued or running now, or already finished on disk). */
  waitForRun(runId: string): Promise<RunResult>;
  /** Ids of the runs this engine holds (queued or running). */
  activeRunIds(): string[];
  /**
   * gates: the engine's gate records (spec 2026-11-10 §6). Engine-internal callers (a loop edge at its
   * limit, §7.2) open a person-decided gate with `gates.openPersonGate(runId, spec)` and wait for its
   * decision with `gates.awaitGate(runId, gateId, signal)` (also after a restart: the deadline is
   * re-armed from the record).
   */
  readonly gates: GateHost;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface Ending {
  status: Extract<WorkflowRunStatus, "failed" | "cancelled" | "stopped" | "interrupted">;
  error?: string;
  /** A structured reason for the run's error (additive; blocks carry their own). */
  errorKind?: WorkflowRunErrorKind;
  finalOutputNodeId?: string;
}

interface ActiveRun {
  run: PersistedRun;
  def: Workflow;
  nodes: Map<string, WorkflowNode>;
  /** Executable node ids in topological order. */
  order: string[];
  /** Whole (redacted) outputs by node id; `run.blocks[id].output` may be only a preview. */
  outputs: Map<string, unknown>;
  /** The secrets this run's expressions read (its own workflow's). */
  secrets: Record<string, string>;
  /** What it redacts: its own secrets plus every ancestor run's (a parent may hand one down). */
  redactSecrets: Record<string, string>;
  redactor: SecretRedactor;
  /** Aborted when the run ends early (failure, cancel, stop, timeout): every block's signal follows. */
  abort: AbortController;
  /** Aborted when the run finalizes or the engine stops: the run's own timers. */
  lifetime: AbortController;
  slots: Map<string, () => void>;
  inFlight: Set<string>;
  /** Loops: each executing block's own abort, so a loop reset can stop just that block. */
  blockAborts: Map<string, AbortController>;
  /** Blocks started regardless of readiness (the fired triggers, a test's first block, trigger-less roots). */
  forced: Set<string>;
  /** Trigger-less manual runs: what their root blocks read as `input`. */
  rootInput?: unknown;
  project: ProjectContext | null;
  phase: "queued" | "preparing" | "walking";
  ending: Ending | null;
  /** finalize() has begun: nothing else changes the run. */
  finished: boolean;
  waiters: ((result: RunResult) => void)[];
  dirty: Set<string>;
  summaryDirty: boolean;
  edgesDirty: boolean;
  /** Loops: the loop counters changed since the last event. */
  loopsDirty: boolean;
  lastPublishAt: number;
  publishTimer: { cancel(): void } | null;
  publishQueued: boolean;
  saving: Promise<void> | null;
  saveRequested: boolean;
  /** The workflow was deleted: its run directory is going away, never write it again. */
  noPersist: boolean;
  children: Set<string>;
  /** Ending grace backstop armed. */
  graceArmed: boolean;
  /** gates: gate ids changed since the last `workflowRun.updated` (whole states ride it). */
  gatesDirty: Set<string>;
  /** gates: parked, its next work waiting for the run cap (gates/parking.ts). */
  held: boolean;
}

interface RunSpec {
  trigger: { kind: WorkflowTriggerKind; nodeId?: string; text?: string };
  payload: WorkflowTriggerPayload;
  test: boolean;
  force: boolean;
  depth: number;
  parentRunId?: string;
  retryOf?: string;
  /** Retry from the trigger: the source run's payload, everything re-run (no reused outputs). */
  freshRetry?: boolean;
  fromNodeId?: string;
  testNodeOnly?: boolean;
  usePinned?: boolean;
  /** A child run: its top-level run's frozen sub-workflow definitions (`PersistedRun.subWorkflows`). */
  subWorkflows?: Record<string, Workflow>;
  /** A child run: its id, derived from its parent run, block and attempt (`childRunIdFor`). */
  runId?: string;
  /** A child run: the attempt of the parent's block that started it. */
  parentAttempt?: number;
  /** gates: who started the run (a child run carries its top-level run's). */
  startedBy?: WorkflowRunStartedBy;
}

interface PreparedOutput {
  output: unknown;
  outputTruncated?: boolean;
  outputFile?: string;
  whole: unknown;
}

/** Blocks whose re-execution after a restart has no side effect to repeat (or none before their `waitingOn`). */
const SAFE_TO_RERUN: ReadonlySet<WorkflowNodeType> = new Set<WorkflowNodeType>([
  "trigger.manual",
  "trigger.schedule",
  "trigger.git",
  "if",
  "switch",
  "merge",
  "stop",
  "wait",
  "http",
  // gates: nothing happens before its WaitingOn (the record is saved with it).
  "gate"
]);

/**
 * The id of the child run one attempt of a Run workflow block starts: derived from (parent run,
 * block, attempt), so the binding is exact and durable — asking again finds that run, never another.
 */
function childRunIdFor(parentRunId: string, nodeId: string, attempt: number): string {
  // UUID-shaped, hash first (as minted ids are): the 8-character prefixes temp-project names and
  // the UI's short labels take keep their full entropy.
  const h = createHash("sha256").update(`${parentRunId}\u0000${nodeId}\u0000${attempt}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** `report_step_result` from any chat that is not a reporting step's (spec 2026-11-10 §5.2), in the spec's words. */
const NOT_A_REPORTING_STEP = "This chat is not a workflow step that reports a result.";

/**
 * Failures a retry cannot fix: every account of the chain is burnt, a hard limit was hit, a loop
 * edge reached its limit (a retry would only take it again), or a gate expired.
 */
const NOT_RETRIED: ReadonlySet<WorkflowBlockError["kind"]> = new Set<WorkflowBlockError["kind"]>(["all_burnt", "limit_exceeded", "loop_limit", "gate_expired"]);

function isRetryable(error: WorkflowBlockError): boolean {
  if (isRecordLike(error.detail) && error.detail.childRunUnknown === true) return false;
  return !NOT_RETRIED.has(error.kind);
}

const isRecordLike = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * A WaitingOn that means the block is WAITING (not working): a timer (Wait, retry delay), or an
 * agent block waiting for a usage reset (`phase: "waiting-reset"`, persisted as kind "agent").
 * A waiting block holds no global slot.
 */
function isWaitState(waitingOn: WaitingOn): boolean {
  // gates: a gate's wait (either phase, its reviewer agent included) holds no slot (spec 2026-11-10 §6.2).
  return waitingOn.kind === "timer" || waitingOn.kind === "gate" || (waitingOn.kind === "agent" && waitingOn.phase === "waiting-reset");
}

const MAX_BLOCK_WARNINGS = 50;
const DAY_MS = 24 * 60 * 60_000;

/** INVALID_INPUT: every problem with a run's input against the declared inputs (spec 2026-11-10 §4.2). */
function invalidInput(lead: string, errors: WorkflowInputError[]): WorkflowEngineError {
  return new WorkflowEngineError(400, "INVALID_INPUT", `${lead}: ${workflowInputErrorsText(errors)}.`, undefined, errors);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "Unknown error";
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "run";
}

function isValidResult(value: unknown): value is NodeResult {
  if (value === null || typeof value !== "object") return false;
  const status = (value as { status?: unknown }).status;
  if (status === "succeeded" || status === "cancelled") return true;
  if (status === "failed") {
    const error = (value as { error?: unknown }).error;
    return error !== null && typeof error === "object" && typeof (error as { message?: unknown }).message === "string";
  }
  if (status === "stopped") {
    const as = (value as { as?: unknown }).as;
    return as === "success" || as === "failure";
  }
  return false;
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export function createWorkflowEngine(opts: WorkflowEngineOptions): WorkflowRuntimeEngine {
  const limits = DEFAULT_ENGINE_LIMITS;
  const { clock, logger, runStore, store } = opts;
  const agentSlots: SlotPool = createSlotPool(limits.maxConcurrentAgentBlocks);
  const processSlots: SlotPool = createSlotPool(limits.maxConcurrentProcesses);
  const active = new Map<string, ActiveRun>();
  /** Runs past the overlap decision whose record is being created: counted, never started. */
  const reserving = new Map<string, ActiveRun>();
  let stopped = false;
  let stopping = false;
  let summarizing = false;

  const nowIso = (): string => clock.now().toISOString();
  const alive = (a: ActiveRun): boolean => !stopped && !a.finished;

  const emit = (type: WorkflowsEventType, payload: unknown): void => {
    if (stopped) return;
    try {
      opts.publish(type, payload);
    } catch (error) {
      logger.warn("workflow event publish failed", { type, error: errorMessage(error) });
    }
  };

  const emitUpserted = (workflowId: string): void => {
    if (stopped) return;
    const workflow = store.get(workflowId);
    if (!workflow) return;
    try {
      emit("workflow.upserted", { workflow: opts.summarize(workflow) });
    } catch (error) {
      logger.warn("workflow summary failed", { workflowId, error: errorMessage(error) });
    }
  };

  const poolFor = (type: WorkflowNodeType): SlotPool | null => {
    if (type === "agent") return agentSlots;
    if (type === "code" || type === "shell") return processSlots;
    return null;
  };

  // -------------------------------------------------------------------------
  // Persistence (coalesced: one save in flight, the next one carries every change made meanwhile)
  // -------------------------------------------------------------------------

  const save = (a: ActiveRun, force = false): Promise<void> => {
    if ((stopped && !force) || a.noPersist) return Promise.resolve();
    a.saveRequested = true;
    if (a.saving === null) {
      a.saving = (async () => {
        while (a.saveRequested && !a.noPersist) {
          a.saveRequested = false;
          const snapshot = structuredClone(a.run);
          try {
            await runStore.save(snapshot);
          } catch (error) {
            logger.error("workflow run save failed", { runId: a.run.id, error: errorMessage(error) });
          }
        }
        a.saving = null;
      })();
    }
    return a.saving;
  };

  const appendEvent = (a: ActiveRun, event: Record<string, unknown>): void => {
    if (stopped || a.noPersist) return;
    runStore
      .appendEvent(a.run.id, a.redactor.value({ at: nowIso(), ...event }))
      .catch((error: unknown) => logger.warn("workflow run event append failed", { runId: a.run.id, error: errorMessage(error) }));
  };

  // -------------------------------------------------------------------------
  // Events (≤ one `workflowRun.updated` per run per interval; the final state is always flushed)
  // -------------------------------------------------------------------------

  const publishUpdate = (a: ActiveRun): void => {
    if (a.publishTimer) {
      a.publishTimer.cancel();
      a.publishTimer = null;
    }
    if (a.dirty.size === 0 && !a.summaryDirty && !a.edgesDirty && !a.loopsDirty && a.gatesDirty.size === 0) return;
    const blocks: WorkflowBlockRun[] = [];
    for (const id of a.dirty) {
      const block = a.run.blocks[id];
      if (block) blocks.push(publicBlock(block));
    }
    const payload: WorkflowRunUpdatedPayload = {
      run: toRunSummary(a.run),
      blocks
    };
    if (a.edgesDirty) {
      payload.takenEdges = [...a.run.takenEdges];
      payload.deadEdges = [...a.run.deadEdges];
    }
    // gates: whole states of the gates opened, decided, escalated or cancelled since the last event.
    if (a.gatesDirty.size > 0) {
      payload.gates = [...a.gatesDirty].flatMap((id) => (a.run.gates && Object.hasOwn(a.run.gates, id) ? [structuredClone(a.run.gates[id]!)] : []));
      a.gatesDirty.clear();
    }
    if (a.loopsDirty) {
      payload.loopCounters = { ...(a.run.loopCounters ?? {}) };
      if (a.run.loopLimits !== undefined) payload.loopLimits = { ...a.run.loopLimits };
    }
    a.dirty.clear();
    a.summaryDirty = false;
    a.edgesDirty = false;
    a.loopsDirty = false;
    a.lastPublishAt = clock.now().getTime();
    emit("workflowRun.updated", payload);
  };

  const tryPublish = (a: ActiveRun): void => {
    a.publishQueued = false;
    if (stopped || a.finished || a.publishTimer) return;
    const elapsed = clock.now().getTime() - a.lastPublishAt;
    if (elapsed >= limits.eventIntervalMs) {
      publishUpdate(a);
      return;
    }
    a.publishTimer = clock.setTimeout(() => {
      a.publishTimer = null;
      if (!stopped && !a.finished) publishUpdate(a);
    }, limits.eventIntervalMs - elapsed);
  };

  const markDirty = (a: ActiveRun, nodeId?: string): void => {
    if (nodeId !== undefined) a.dirty.add(nodeId);
    else a.summaryDirty = true;
    if (a.publishQueued) return;
    a.publishQueued = true;
    queueMicrotask(() => tryPublish(a));
  };

  const refreshCurrent = (a: ActiveRun): void => {
    let best: { id: string; at: string } | null = null;
    for (const id of a.inFlight) {
      const block = a.run.blocks[id];
      if (!block) continue;
      const at = block.startedAt ?? block.queuedAt ?? "";
      if (best === null || at >= best.at) best = { id, at };
    }
    if (best === null) {
      if (a.run.current !== undefined) {
        delete a.run.current;
        a.summaryDirty = true;
      }
      return;
    }
    const node = a.nodes.get(best.id);
    const next = {
      nodeId: best.id,
      name: node?.name ?? best.id,
      index: a.order.indexOf(best.id) + 1,
      total: a.order.length
    };
    const current = a.run.current;
    if (!current || current.nodeId !== next.nodeId || current.index !== next.index) {
      a.run.current = next;
      a.summaryDirty = true;
    }
  };

  // -------------------------------------------------------------------------
  // Outputs
  // -------------------------------------------------------------------------

  /** Redact, cap and (when big) spill an output to its file. */
  const prepareOutput = async (
    runId: string,
    nodeId: string,
    attempt: number,
    value: unknown,
    redactor: SecretRedactor
  ): Promise<PreparedOutput | { error: WorkflowBlockError }> => {
    const redacted = redactor.value(value);
    const text = jsonText(redacted);
    if (text === undefined) return { output: undefined, whole: undefined };
    if (text === null) {
      return { error: { kind: "internal", message: "The block's output cannot be written as JSON." } };
    }
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > limits.maxOutputBytes) {
      return {
        error: {
          kind: "limit_exceeded",
          message: `The block's output is ${Math.ceil(bytes / 1024 / 1024)} MiB; the limit is ${Math.floor(limits.maxOutputBytes / 1024 / 1024)} MiB.`
        }
      };
    }
    // One JSON round trip: what downstream blocks read is exactly what a resume reads back.
    const whole = JSON.parse(text) as unknown;
    if (bytes <= limits.inlineOutputPreviewBytes) return { output: whole, whole };
    const outputFile = await runStore.writeOutputFile(runId, nodeId, attempt, whole);
    return { output: outputPreview(whole, limits.inlineOutputPreviewBytes), outputTruncated: true, outputFile, whole };
  };

  const applyOutput = (a: ActiveRun, block: PersistedBlockState, prepared: PreparedOutput): void => {
    delete block.output;
    delete block.outputTruncated;
    delete block.outputFile;
    if (prepared.whole === undefined) {
      a.outputs.delete(block.nodeId);
      return;
    }
    a.outputs.set(block.nodeId, prepared.whole);
    block.output = prepared.output;
    if (prepared.outputTruncated) block.outputTruncated = true;
    if (prepared.outputFile !== undefined) block.outputFile = prepared.outputFile;
  };

  const readWholeOutput = async (block: Pick<PersistedBlockState, "output" | "outputFile">): Promise<unknown> => {
    if (block.outputFile !== undefined) {
      try {
        return await runStore.readOutputFile(block.outputFile);
      } catch (error) {
        logger.warn("workflow output file unreadable", { file: block.outputFile, error: errorMessage(error) });
      }
    }
    return block.output;
  };

  const addWarnings = (a: ActiveRun, block: PersistedBlockState, warnings: readonly string[] | undefined): void => {
    if (!warnings || warnings.length === 0) return;
    const merged = new Set(block.warnings ?? []);
    for (const warning of warnings) {
      if (merged.size >= MAX_BLOCK_WARNINGS) break;
      if (typeof warning === "string" && warning.length > 0) merged.add(a.redactor.text(warning));
    }
    if (merged.size !== (block.warnings?.length ?? 0)) block.warnings = [...merged];
  };

  // -------------------------------------------------------------------------
  // The run context an expression reads (§3.2)
  // -------------------------------------------------------------------------

  const handleOf = (block: PersistedBlockState): string | undefined =>
    block.handle ?? (block.status === "succeeded" ? "success" : block.status === "failed" ? "error" : undefined);

  const liveInputsOf = (a: ActiveRun, nodeId: string): { nodeId: string; name: string; output: unknown }[] => {
    const out: { nodeId: string; name: string; output: unknown }[] = [];
    const seen = new Set<string>();
    for (const edge of a.def.edges) {
      // Loops: a loop edge is never an input (its target reads its forward inputs on every pass).
      if (edge.target !== nodeId || seen.has(edge.source) || isLoopEdge(edge)) continue;
      const block = a.run.blocks[edge.source];
      if (!block || (block.status !== "succeeded" && block.status !== "failed")) continue;
      if (handleOf(block) !== edge.sourceHandle) continue;
      seen.add(edge.source);
      out.push({ nodeId: edge.source, name: block.name, output: a.outputs.has(edge.source) ? a.outputs.get(edge.source) : block.output });
    }
    return out;
  };

  const inputOf = (a: ActiveRun, nodeId: string): unknown => {
    const live = liveInputsOf(a, nodeId);
    if (live.length === 1) return live[0]!.output;
    if (live.length > 1) return Object.fromEntries(live.map((entry) => [entry.name, entry.output]));
    if (a.rootInput !== undefined && a.forced.has(nodeId)) return a.rootInput;
    return undefined;
  };

  const baseContext = (a: ActiveRun, nodeId: string, attempt: number, branch: string | undefined): ReturnType<NodeExecutionContext["expressionContext"]> => {
    const nodes: ReturnType<NodeExecutionContext["expressionContext"]>["nodes"] = {};
    for (const [id, block] of Object.entries(a.run.blocks)) {
      // Loops: a block a loop reset reads as its latest finished pass until its new one finishes.
      const state = isFinishedBlockStatus(block.status) ? block : latestPass(block);
      if (!state || !isFinishedBlockStatus(state.status)) continue;
      const entry: { output: unknown; status: string; error?: WorkflowBlockError } = {
        output: a.outputs.has(id) ? a.outputs.get(id) : state.output,
        status: state.status
      };
      if (state.error) entry.error = state.error;
      nodes[block.name] = entry;
    }
    const project = a.project;
    const projectView: { path: string; name: string; workspace: string; branch?: string } = {
      path: project?.path ?? a.run.projectPath ?? "",
      name: project?.name ?? "",
      workspace: project?.workspace ?? ""
    };
    if (branch !== undefined) projectView.branch = branch;
    return {
      input: inputOf(a, nodeId),
      nodes,
      trigger: a.run.triggerPayload,
      run: {
        id: a.run.id,
        startedAt: a.run.startedAt ?? a.run.queuedAt,
        workflowId: a.run.workflowId,
        workflowName: a.run.workflowName,
        attempt
      },
      project: projectView,
      workflow: { id: a.def.id, name: a.def.name },
      // Loops: `{{ loop.pass }}` / `{{ loop.feedback }}` of this block (§7.2).
      loop: loopNamespace(a.run.blocks[nodeId])
    };
  };

  // -------------------------------------------------------------------------
  // Block execution
  // -------------------------------------------------------------------------

  const releaseSlot = (a: ActiveRun, nodeId: string): void => {
    const release = a.slots.get(nodeId);
    if (release) {
      a.slots.delete(nodeId);
      release();
    }
  };

  /** A test run's pinned output for `node`, and the handle it takes (an agent with outcomes: the pin's `outcome`, §7.5). */
  /**
   * `report_step_result`'s step (spec 2026-11-10 §5.2): the running pass of an agent block that
   * declares outcomes/outputs and whose recorded sessions — the agent block's persisted
   * `knownSessionIds`, failover sessions included — hold `sessionId`. Matched on the run's own
   * records, never on the session's `owner.nodeId` (a `continue` block reuses another block's chat).
   * When several could match, the most recently started pass owns the report.
   */
  const reportingPassOf = (sessionId: string): { a: ActiveRun; node: WorkflowNode; block: PersistedBlockState } | null => {
    let best: { a: ActiveRun; node: WorkflowNode; block: PersistedBlockState } | null = null;
    for (const a of active.values()) {
      if (!alive(a)) continue;
      for (const [id, block] of Object.entries(a.run.blocks)) {
        if (block.type !== "agent" || (block.status !== "running" && block.status !== "waiting") || !a.inFlight.has(id)) continue;
        const waiting = block.waitingOn;
        if (waiting?.kind !== "agent") continue;
        const node = a.nodes.get(id);
        if (!node || !reportRequired(stepReportDecl(node))) continue;
        const known = (waiting.state as { knownSessionIds?: unknown } | undefined)?.knownSessionIds;
        const sessions = new Set<string>(Array.isArray(known) ? known.filter((v): v is string => typeof v === "string") : []);
        if (waiting.sessionId) sessions.add(waiting.sessionId);
        if (!sessions.has(sessionId)) continue;
        if (best === null || (block.startedAt ?? "") > (best.block.startedAt ?? "")) best = { a, node, block };
      }
    }
    return best;
  };

  const pinFor = (a: ActiveRun, node: WorkflowNode): { value: unknown; handle: string } | null => {
    if (!a.run.usePinned || node.id === a.run.fromNodeId) return null;
    const pinned = a.def.pinned;
    if (!pinned || !Object.prototype.hasOwnProperty.call(pinned, node.id)) return null;
    const handle = pinnedHandle(node, pinned[node.id]);
    if (handle === null) return null;
    return { value: pinned[node.id], handle };
  };

  const currentBranch = async (path: string): Promise<string | undefined> => {
    try {
      return (await opts.services.projects.currentBranch(path)) ?? undefined;
    } catch {
      return undefined;
    }
  };

  // -------------------------------------------------------------------------
  // gates: the gate records and parked runs (spec 2026-11-10 §6; gates/host.ts, gates/parking.ts)
  // -------------------------------------------------------------------------

  const gateAccess = (a: ActiveRun): GateRunAccess => ({
    get run() {
      return a.run;
    },
    get workflow() {
      return a.def;
    },
    alive: () => alive(a),
    redact: (value) => a.redactor.value(value),
    save: () => save(a),
    touched: (gateId, persist = true) => {
      if (gateId !== undefined) a.gatesDirty.add(gateId);
      markDirty(a);
      if (persist) void save(a);
    },
    parent: () => {
      const parent = a.run.parentRunId !== undefined ? active.get(a.run.parentRunId) : undefined;
      return parent ? gateAccess(parent) : null;
    },
    children: () => [...a.children].flatMap((id) => {
      const child = active.get(id);
      return child && !child.finished ? [gateAccess(child)] : [];
    })
  });

  /** Retained runs a gate list with `includeDecided` reads: the newest, across workflows, bounded. */
  const retainedRuns = async (): Promise<PersistedRun[]> => {
    const ids = new Set<string>([...store.list().map((workflow) => workflow.id), ...(runStore.workflowIds?.() ?? [])]);
    const summaries: WorkflowRunSummary[] = [];
    for (const id of ids) {
      const page = await runStore.listForWorkflow(id, { limit: 20 }).catch(() => null);
      for (const summary of page?.runs ?? []) if (!isRunActive(summary.status) && summary.status !== "skipped") summaries.push(summary);
    }
    summaries.sort((x, y) => (x.queuedAt < y.queuedAt ? 1 : x.queuedAt > y.queuedAt ? -1 : 0));
    const runs: PersistedRun[] = [];
    for (const summary of summaries.slice(0, 200)) {
      const run = await runStore.load(summary.id).catch(() => null);
      if (run?.gates && Object.keys(run.gates).length > 0) runs.push(run);
    }
    return runs;
  };

  const gateHost: GateHost = createGateHost({
    clock,
    mintId: opts.mintId,
    logger,
    access: (runId) => {
      const a = active.get(runId);
      return a ? gateAccess(a) : null;
    },
    activeRuns: () => [...active.values()].map(gateAccess),
    loadRun: (runId) => runStore.load(runId),
    retainedRuns,
    notifier: () => opts.notifier,
    stopped: () => stopped || stopping
  });

  let pumpQueued = false;
  const parking = createParking({
    clock,
    logger,
    maxConcurrentRuns: () => limits.maxConcurrentRuns,
    get: (runId) => active.get(runId),
    all: () => [...active.values()],
    nodeType: (r, nodeId) => (r as ActiveRun).nodes.get(nodeId)?.type,
    walking: (r) => {
      const a = r as ActiveRun;
      return !stopped && !a.finished && a.phase === "walking" && a.ending === null;
    },
    counts: (r) => countsTowardCap(r as ActiveRun),
    timeoutMinutes: (r) => (r as ActiveRun).def.settings.runTimeoutMinutes,
    lifetime: (r) => (r as ActiveRun).lifetime.signal,
    changed: (r) => {
      const a = r as ActiveRun;
      markDirty(a);
      void save(a);
    },
    onTimeout: (r, minutes) => {
      const a = r as ActiveRun;
      if (!alive(a) || a.ending !== null) return;
      const parked = a.run.parkedMs !== undefined && a.run.parkedMs > 0 ? " (time waiting on gates and timers not counted)" : "";
      failRun(a, { status: "failed", error: `The run timed out after ${minutes} minute${minutes === 1 ? "" : "s"}${parked}.` });
      step(a);
    },
    resume: (r) => step(r as ActiveRun),
    wake: () => {
      if (pumpQueued) return;
      pumpQueued = true;
      queueMicrotask(() => {
        pumpQueued = false;
        pump();
      });
    }
  });

  const services: EngineServices = {
    ...opts.services,
    clock,
    mintId: opts.mintId,
    logger,
    store,
    runChild: (input) => runChild(input),
    awaitRun: (runId, signal) => awaitRun(runId, signal),
    gates: gateHost
  };

  const runExecutor = async (
    a: ActiveRun,
    node: WorkflowNode,
    attempt: number,
    signal: AbortSignal,
    resumeFrom: WaitingOn | undefined,
    project: ProjectContext,
    /** The block state this execution owns (loops: a pass a reset archived is no longer `a.run.blocks[id]`). */
    block: PersistedBlockState = a.run.blocks[node.id]!
  ): Promise<NodeResult | null> => {
    const executor = opts.executors[node.type] as { execute(ctx: NodeExecutionContext): Promise<NodeResult> } | undefined;
    if (!executor) {
      return { status: "failed", error: { kind: "internal", message: `No executor is installed for "${node.type}" blocks.` } };
    }
    // Loops: storage is keyed by the attempt counted across passes (`storageAttempt`).
    const stored = storageAttempt(block, attempt);
    const branch = await currentBranch(project.path);
    const exprContext = (): ExpressionContext & ReturnType<NodeExecutionContext["expressionContext"]> => ({
      ...baseContext(a, node.id, attempt, branch),
      secrets: a.secrets
    });
    const nodeLog: WorkflowLogger = {
      debug: (msg, meta) => logger.debug(msg, { runId: a.run.id, nodeId: node.id, ...meta }),
      info: (msg, meta) => logger.info(msg, { runId: a.run.id, nodeId: node.id, ...meta }),
      warn: (msg, meta) => logger.warn(msg, { runId: a.run.id, nodeId: node.id, ...meta }),
      error: (msg, meta) => logger.error(msg, { runId: a.run.id, nodeId: node.id, ...meta })
    };
    const ctx: NodeExecutionContext = {
      runId: a.run.id,
      workflow: a.def,
      node,
      attempt: stored,
      signal,
      project,
      render(template) {
        const rendered = renderTemplate(template, exprContext());
        addWarnings(a, block, rendered.warnings);
        return rendered;
      },
      renderValue(template) {
        const rendered = renderTemplateValue(template, exprContext());
        addWarnings(a, block, rendered.warnings);
        return rendered;
      },
      expressionContext: () => baseContext(a, node.id, attempt, branch),
      secrets: a.secrets,
      setWaitingOn: async (waitingOn) => {
        // Stopped (or finalized): nothing more reaches disk, so the executor must not go on to a
        // side effect nobody recorded — the next engine resumes from what run.json last held.
        if (!alive(a) || stopping) throw new EngineStoppedError();
        if (waitingOn === undefined) delete block.waitingOn;
        else block.waitingOn = structuredClone(waitingOn);
        if (waitingOn !== undefined && isWaitState(waitingOn)) {
          block.status = "waiting";
          if (waitingOn.kind === "timer") block.waitingUntil = waitingOn.until;
          // A wait never holds a global slot.
          releaseSlot(a, node.id);
        } else {
          if (block.status === "waiting") {
            block.status = "running";
            delete block.waitingUntil;
          }
          const pool = poolFor(node.type);
          if (pool && !a.slots.has(node.id) && !signal.aborted) {
            try {
              const release = await pool.acquire(signal);
              if (alive(a)) a.slots.set(node.id, release);
              else release();
            } catch {
              // aborted while waiting: the executor sees its signal
            }
          }
        }
        markDirty(a, node.id);
        parking.refresh(a);
        await save(a);
        // The engine stopped while this state was being written: it may not have landed.
        if (!alive(a)) throw new EngineStoppedError();
      },
      update(patch) {
        if (!alive(a) || isFinishedBlockStatus(block.status)) return;
        const redacted = a.redactor.value(structuredClone(patch));
        const { warnings, ...rest } = redacted;
        Object.assign(block, rest);
        addWarnings(a, block, warnings);
        markDirty(a, node.id);
        void save(a);
      },
      attemptDir: () => runStore.attemptDir(a.run.id, node.id, stored),
      timeoutMs: blockTimeoutMs(node),
      depth: a.run.depth,
      startedAt: block.startedAt ?? nowIso(),
      liveInputs: () => liveInputsOf(a, node.id),
      stepReport: () => (block.report ? structuredClone(block.report) : undefined),
      services,
      log: nodeLog
    };
    if (resumeFrom !== undefined) ctx.resumeFrom = structuredClone(resumeFrom);
    const loop = nodeLoopContext(a.run, a.def, block);
    if (loop !== undefined) ctx.loop = loop;
    try {
      const result = await executor.execute(ctx);
      if (!isValidResult(result)) {
        return { status: "failed", error: { kind: "internal", message: `The ${node.type} block returned an invalid result.` } };
      }
      return result;
    } catch (error) {
      // The engine stopped while the block persisted its wait state: no result — the block keeps
      // what run.json last held and resumes after the restart (never recorded as failed).
      if (error instanceof EngineStoppedError) return null;
      if (signal.aborted) return { status: "cancelled" };
      return { status: "failed", error: { kind: "internal", message: errorMessage(error) } };
    }
  };

  /** The attempts of one block; null when the engine stopped or the run was finalized meanwhile. */
  const attemptLoop = async (
    a: ActiveRun,
    node: WorkflowNode,
    signal: AbortSignal,
    resume: WaitingOn | undefined,
    block: PersistedBlockState = a.run.blocks[node.id]!
  ): Promise<NodeResult | null> => {
    let resumeFrom = resume;
    let attempt = block.attempt;

    if (resumeFrom?.kind === "timer" && resumeFrom.purpose === "retry-delay") {
      const reached = (await sleepUntil(clock, new Date(resumeFrom.until), signal)) && (await parking.admission(a, signal));
      if (!alive(a)) return null;
      delete block.waitingOn;
      delete block.waitingUntil;
      if (!reached) return { status: "cancelled" };
      resumeFrom = undefined;
    }

    if (resumeFrom === undefined) {
      if (node.disabled || pinFor(a, node)) {
        block.startedAt = nowIso();
        block.attempt = Math.max(1, block.attempt);
      }
      if (node.disabled) {
        // An agent block with outcomes passes through on its first outcome (spec 2026-11-10 §7.5).
        return { status: "succeeded", output: isTriggerType(node.type) ? a.run.triggerPayload : inputOf(a, node.id), handle: passThroughHandle(node) };
      }
      const pin = pinFor(a, node);
      if (pin) {
        block.pinned = true;
        return { status: "succeeded", output: pin.value, handle: pin.handle };
      }
    }

    let project = a.project!;
    if (node.projectOverride) {
      const resolved = await opts.services.projects.resolveExisting(node.projectOverride).catch(() => null);
      if (!alive(a)) return null;
      if (!resolved) {
        return { status: "failed", error: { kind: "project_missing", message: `The project "${node.projectOverride}" does not exist.` } };
      }
      project = resolved;
    }

    for (;;) {
      const resuming = resumeFrom !== undefined;
      if (!resuming) attempt += 1;
      const pool = poolFor(node.type);
      const resumingAWait = resumeFrom !== undefined && isWaitState(resumeFrom);
      if (pool && !a.slots.has(node.id) && !resumingAWait) {
        if (!resuming && block.status !== "queued") {
          block.status = "queued";
          block.queuedAt = nowIso();
          markDirty(a, node.id);
        }
        try {
          const release = await pool.acquire(signal, { force: resuming });
          if (!alive(a)) {
            release();
            return null;
          }
          a.slots.set(node.id, release);
        } catch {
          if (!alive(a)) return null;
          return { status: "cancelled" };
        }
      }
      // The engine is stopping: an attempt not marked running yet never starts — the block stays
      // pending/queued (or keeps its WaitingOn) as run.json holds it, and runs after the restart
      // (a fresh side-effecting attempt started now would be found "interrupted").
      if (stopping) {
        releaseSlot(a, node.id);
        return null;
      }
      block.attempt = attempt;
      if (!resuming) {
        block.status = "running";
        block.startedAt = nowIso();
        delete block.endedAt;
        delete block.error;
        delete block.waitingOn;
        delete block.waitingUntil;
        delete block.handle;
        // A new attempt reports afresh: an earlier attempt's report never finishes this one (§5.2).
        delete block.report;
        appendEvent(a, { type: "block.started", nodeId: node.id, attempt });
      } else if (resumingAWait) {
        block.status = "waiting";
      } else {
        block.status = "running";
      }
      refreshCurrent(a);
      markDirty(a, node.id);
      void save(a);
      if (signal.aborted) return { status: "cancelled" };

      const result = await runExecutor(a, node, attempt, signal, resumeFrom, project, block);
      resumeFrom = undefined;
      if (result === null || !alive(a)) return null;
      releaseSlot(a, node.id);

      if (result.status === "failed" && isRetryable(result.error) && attempt < maxTriesOf(node) && !signal.aborted && a.ending === null) {
        const until = new Date(clock.now().getTime() + retryDelayMs(node));
        block.error = a.redactor.value(result.error);
        block.status = "waiting";
        block.waitingOn = { kind: "timer", until: until.toISOString(), purpose: "retry-delay" };
        block.waitingUntil = until.toISOString();
        markDirty(a, node.id);
        appendEvent(a, { type: "block.retry", nodeId: node.id, attempt, error: block.error });
        parking.refresh(a);
        await save(a);
        // gates: a parked run whose retry would un-park it while the run cap is full waits its turn.
        const reached = (await sleepUntil(clock, until, signal)) && (await parking.admission(a, signal));
        if (!alive(a)) return null;
        delete block.waitingOn;
        delete block.waitingUntil;
        if (!reached) return { status: "cancelled" };
        continue;
      }
      return result;
    }
  };

  const hasErrorEdge = (a: ActiveRun, nodeId: string): boolean =>
    a.def.edges.some((edge) => edge.source === nodeId && edge.sourceHandle === "error" && a.nodes.has(edge.target));

  const failRun = (a: ActiveRun, ending: Ending): void => {
    if (a.ending !== null) return;
    a.ending = ending;
    abortRun(a);
  };

  /**
   * Loops (spec 2026-11-10 §7.2): the loop edge a just-finished block's handle carries. Under its
   * limit: counted, its reset set gets a new pass (`applyLoopReset`) and the blocks of the set still
   * running are stopped (after this state is saved: the caller saves synchronously). At its limit:
   * the block waits on a loop-limit gate (`WaitingOn {kind: "gate", loopLimit}` with a gate id minted
   * now, saved with this finish; `waitAtLoopLimit` then opens and awaits it). Returns the run event
   * to record, or null when no loop edge applies. Never in a single-block test, nor once the run ends.
   */
  const takeLoopEdge = (a: ActiveRun, node: WorkflowNode, block: PersistedBlockState): Record<string, unknown> | null => {
    if (block.status !== "succeeded" || a.ending !== null || a.run.testNodeOnly) return null;
    const edge = loopEdgeTaken(a.def, node.id, block.handle);
    if (!edge || !a.nodes.has(edge.target)) return null;
    // A disabled block passed through on its first outcome / choice: looping would only repeat that
    // (the validator warns, `loop_from_disabled`). The path ends at its loop handle.
    if (node.disabled === true) {
      addWarnings(a, block, [`${node.name} is disabled: its loop back to ${a.nodes.get(edge.target)!.name} is not taken.`]);
      return null;
    }
    const count = loopCount(a.run, edge.id);
    const limit = loopLimit(a.run, edge);
    const targetName = a.nodes.get(edge.target)!.name;
    if (count >= limit) {
      // Loops: at its limit — the person decides (loops/limit.ts). The output stays; the block is
      // in flight again, waiting, until the gate is decided.
      const gateId = opts.mintId();
      const now = clock.now();
      block.status = "waiting";
      block.waitingOn = {
        kind: "gate",
        gateId,
        openedAt: now.toISOString(),
        phase: "person",
        phaseStartedAt: now.toISOString(),
        phaseDeadlineAt: personDeadline(now, undefined).toISOString(),
        decider: { kind: "human", label: PERSON_LABEL },
        loopLimit: { edgeId: edge.id, handle: block.handle! }
      };
      // A Gate block keeps naming its own gate; any other block names the one it waits on.
      if (node.type !== "gate") block.gateId = gateId;
      delete block.handle;
      delete block.endedAt;
      return { type: "loop.limit", edgeId: edge.id, nodeId: node.id, count, limit, gateId };
    }
    const feedback = loopFeedbackOf(node, block, a.outputs.has(node.id) ? a.outputs.get(node.id) : block.output);
    const reset = applyLoopReset({
      run: a.run,
      def: a.def,
      edge,
      sourceId: node.id,
      inFlight: a.inFlight,
      ...(feedback !== undefined ? { feedback: a.redactor.text(feedback) } : {}),
      now: nowIso()
    });
    for (const id of reset.unfinished) a.outputs.delete(id);
    for (const id of reset.reset) a.dirty.add(id);
    a.loopsDirty = true;
    a.summaryDirty = true;
    // Stopped only once the reset is on disk: a restart before then finds the blocks as they were
    // (the source re-finishes and takes its loop again); one after it finds each stopped pass's
    // `interruptedFrom` and stops its wait then (`resumeInterruptions`). A stopping engine stops
    // nothing — the next one does.
    if (reset.interrupt.length > 0) {
      void save(a).then(() => {
        if (!alive(a) || stopping) return;
        for (const id of reset.interrupt) a.blockAborts.get(id)?.abort();
      });
    }
    return { type: "loop.taken", edgeId: edge.id, nodeId: node.id, target: edge.target, count: count + 1, limit, reset: reset.reset, interrupted: reset.interrupt };
  };

  const finishBlock = async (
    a: ActiveRun,
    node: WorkflowNode,
    result: NodeResult,
    block: PersistedBlockState = a.run.blocks[node.id]!
  ): Promise<void> => {
    // Loops: a reset (before, or during an await below) replaced this block with its next pass —
    // this result belongs to the pass it archived, and changes nothing.
    const superseded = (): boolean => a.run.blocks[node.id] !== block;
    if (!alive(a) || superseded()) return;
    delete block.waitingOn;
    delete block.waitingUntil;
    if ("warnings" in result) addWarnings(a, block, result.warnings);
    switch (result.status) {
      case "succeeded": {
        const prepared = await prepareOutput(a.run.id, node.id, storageAttempt(block), result.output, a.redactor);
        if (!alive(a) || superseded()) return;
        if ("error" in prepared) {
          block.status = "failed";
          block.error = prepared.error;
          block.handle = "error";
        } else {
          applyOutput(a, block, prepared);
          block.status = "succeeded";
          block.handle = typeof result.handle === "string" && result.handle.length > 0 ? result.handle : "success";
          delete block.error;
        }
        break;
      }
      case "failed": {
        block.status = "failed";
        block.handle = "error";
        block.error = a.redactor.value(result.error);
        if (result.output !== undefined) {
          const prepared = await prepareOutput(a.run.id, node.id, storageAttempt(block), result.output, a.redactor);
          if (!alive(a) || superseded()) return;
          if ("error" in prepared) addWarnings(a, block, [`The output was dropped: ${prepared.error.message}`]);
          else applyOutput(a, block, prepared);
        }
        break;
      }
      case "stopped": {
        const prepared = await prepareOutput(a.run.id, node.id, storageAttempt(block), result.output, a.redactor);
        if (!alive(a) || superseded()) return;
        if ("error" in prepared) addWarnings(a, block, [`The Stop value was dropped: ${prepared.error.message}`]);
        else applyOutput(a, block, prepared);
        const message = result.message !== undefined ? a.redactor.text(result.message) : undefined;
        if (result.as === "success") {
          block.status = "succeeded";
          block.handle = "success";
        } else {
          block.status = "failed";
          block.handle = "error";
          block.error = { kind: "stopped", message: message ?? `Stopped by ${node.name}.` };
        }
        const ending: Ending = {
          status: result.as === "success" ? "stopped" : "failed",
          finalOutputNodeId: node.id
        };
        if (message !== undefined) ending.error = message;
        else if (result.as === "failure") ending.error = `Stopped by ${node.name}.`;
        failRun(a, ending);
        break;
      }
      case "cancelled":
        if (a.ending === null) {
          // Nothing cancelled the run: a block that reports "cancelled" by itself did not do its
          // work, and must not let the run end succeeded with its downstream skipped.
          block.status = "failed";
          block.handle = "error";
          block.error = { kind: "interrupted", message: "The block stopped without finishing, though the run was not cancelled." };
          break;
        }
        block.status = "cancelled";
        delete block.handle;
        break;
    }
    block.endedAt = nowIso();
    // Loops: the handle it finished on may carry a loop edge — taken (a new pass of the reset set)
    // or at its limit (this pass fails). Synchronous with the save below: `run.json` never holds a
    // source finished on a loop handle whose loop was not taken.
    const loop = takeLoopEdge(a, node, block);
    markDirty(a, node.id);
    // Loops: at its limit the block has not finished — it waits on the person (`waitAtLoopLimit`).
    const atLimit = loop?.type === "loop.limit";
    if (!atLimit) appendEvent(a, { type: "block.finished", nodeId: node.id, status: block.status, attempt: block.attempt, error: block.error });
    if (loop !== null) appendEvent(a, loop);
    if (atLimit) parking.refresh(a);
    void save(a);
    if (block.status === "failed" && result.status !== "stopped" && !hasErrorEdge(a, node.id)) {
      failRun(a, { status: "failed", error: `${node.name}: ${block.error?.message ?? "failed"}` });
    }
  };

  /**
   * Loops (spec 2026-11-10 §7.2): a block whose loop edge was at its limit waits on a person-decided
   * loop-limit gate (`takeLoopEdge` persisted the wait, gate id included, with the block's finish).
   * Opens the gate unless it exists (a restart in between), awaits it, then: `allow` raises the edge's
   * limit for this run by one and takes the loop; `stop` or expiry fails the pass with `loop_limit`.
   * Returns false when the engine stopped meanwhile (the wait resumes from run.json after a restart).
   */
  const waitAtLoopLimit = async (a: ActiveRun, node: WorkflowNode, block: PersistedBlockState, signal: AbortSignal): Promise<boolean> => {
    const waitingOn = block.waitingOn;
    if (!isLoopLimitWait(waitingOn)) return true;
    const { gateId } = waitingOn;
    const { edgeId, handle } = waitingOn.loopLimit;
    const runId = a.run.id;
    const superseded = (): boolean => a.run.blocks[node.id] !== block;
    const edge = a.def.edges.find((candidate) => candidate.id === edgeId && isLoopEdge(candidate)) as Parameters<typeof loopLimit>[1] | undefined;
    const targetName = edge ? (a.nodes.get(edge.target)?.name ?? edge.target) : "?";
    const limit = edge ? loopLimit(a.run, edge) : 0;
    const facts = { sourceName: node.name, targetName, limit };
    const fail = async (error: WorkflowBlockError): Promise<void> => finishBlock(a, node, { status: "failed", error }, block);
    if (!edge) {
      await fail({ kind: "loop_limit", message: `${node.name}'s loop edge is gone from the run's definition.`, detail: { edgeId } });
      return true;
    }
    try {
      if (!gateHost.get(runId, gateId)) {
        await gateHost.openPersonGate(runId, {
          gateId,
          nodeId: node.id,
          pass: block.pass ?? 1,
          source: "loop_limit",
          edgeId,
          question: clipChars(loopLimitQuestion(facts), WORKFLOW_LIMITS.gateQuestionChars).text,
          details: loopLimitDetails(facts, hasErrorEdge(a, node.id)),
          choices: structuredClone([...LOOP_LIMIT_CHOICES])
        });
      }
      if (!alive(a)) return false;
      const outcome = await gateHost.awaitGate(runId, gateId, signal);
      if (!alive(a)) return false;
      if (superseded()) {
        // A loop reset ran this block again (an outer loop): its question is moot.
        gateHost.cancel(runId, gateId);
        return true;
      }
      if (outcome.kind === "cancelled") {
        gateHost.cancel(runId, gateId);
        await finishBlock(a, node, { status: "cancelled" }, block);
        return true;
      }
      if (outcome.kind === "expired" || outcome.decision.choice !== LOOP_LIMIT_ALLOW) {
        await fail(a.redactor.value(loopLimitError({ edge, ...facts }, outcome.kind === "expired" ? "expired" : "stopped")));
        return true;
      }
      // Allowed: one more loop for this run, taken now (synchronously with its save).
      a.run.loopLimits = { ...(a.run.loopLimits ?? {}), [edgeId]: Math.max(limit, loopCount(a.run, edgeId)) + 1 };
      a.loopsDirty = true;
      delete block.waitingOn;
      delete block.waitingUntil;
      block.status = "succeeded";
      block.handle = handle;
      block.endedAt = nowIso();
      const loop = takeLoopEdge(a, node, block);
      markDirty(a, node.id);
      appendEvent(a, { type: "block.finished", nodeId: node.id, status: block.status, attempt: block.attempt });
      if (loop !== null) appendEvent(a, loop);
      parking.refresh(a);
      void save(a);
      return true;
    } catch (error) {
      if (error instanceof EngineStoppedError || !alive(a)) return false;
      gateHost.cancel(runId, gateId);
      throw error;
    }
  };

  const executeBlock = async (a: ActiveRun, nodeId: string, resume?: WaitingOn): Promise<void> => {
    const node = a.nodes.get(nodeId)!;
    // Loops: the pass this execution runs. A loop reset replaces the block object (and stops this
    // execution): whatever it then reports belongs to the archived pass.
    const owned = a.run.blocks[nodeId]!;
    const blockAbort = new AbortController();
    a.blockAborts.set(nodeId, blockAbort);
    const onRunAbort = (): void => blockAbort.abort();
    if (a.abort.signal.aborted) blockAbort.abort();
    else a.abort.signal.addEventListener("abort", onRunAbort, { once: true });
    // No result (the engine stopped, or the run ended, meanwhile): the walk must not go on past this
    // block — it is unfinished, and resumes from run.json after the restart.
    let unfinished = false;
    try {
      if (isLoopLimitWait(resume)) {
        // Loops: resumed at a loop's limit (after a restart) — the gate, never the block's executor.
        owned.status = "waiting";
        if (!(await waitAtLoopLimit(a, node, owned, blockAbort.signal))) unfinished = true;
      } else {
        const result = await attemptLoop(a, node, blockAbort.signal, resume, owned);
        if (result !== null) await finishBlock(a, node, result, owned);
        else unfinished = true;
        if (!unfinished && alive(a) && a.run.blocks[nodeId] === owned && isLoopLimitWait(owned.waitingOn)) {
          if (!(await waitAtLoopLimit(a, node, owned, blockAbort.signal))) unfinished = true;
        }
      }
    } catch (error) {
      logger.error("workflow block crashed", { runId: a.run.id, nodeId, error: errorMessage(error) });
      if (alive(a)) await finishBlock(a, node, { status: "failed", error: { kind: "internal", message: errorMessage(error) } }, owned);
    } finally {
      a.abort.signal.removeEventListener("abort", onRunAbort);
      if (a.blockAborts.get(nodeId) === blockAbort) a.blockAborts.delete(nodeId);
      releaseSlot(a, nodeId);
      a.inFlight.delete(nodeId);
      // Loops: the pass a reset stopped has stopped — nothing left for a restart to stop.
      if (!unfinished && alive(a) && a.run.blocks[nodeId] !== owned && settleInterruptedPass(a.run.blocks[nodeId])) {
        markDirty(a, nodeId);
        void save(a);
      }
      if (alive(a) && !unfinished) {
        refreshCurrent(a);
        markDirty(a);
        step(a);
      }
    }
  };

  const startBlock = (a: ActiveRun, nodeId: string, resume?: WaitingOn): void => {
    const block = a.run.blocks[nodeId];
    if (!block || a.inFlight.has(nodeId)) return;
    if (resume === undefined && block.status === "pending") {
      block.status = "queued";
      block.queuedAt = nowIso();
      markDirty(a, nodeId);
    }
    a.inFlight.add(nodeId);
    void executeBlock(a, nodeId, resume);
  };

  // -------------------------------------------------------------------------
  // The walk
  // -------------------------------------------------------------------------

  /**
   * Loops: a forced block (a fired trigger, a run's first block, a trigger-less root) starts
   * regardless of readiness on its first pass, and again only as a loop's target — a later pass
   * of a block downstream of the target waits for its inputs like any other.
   */
  const forcedThisPass = (a: ActiveRun, nodeId: string): boolean => {
    const block = a.run.blocks[nodeId];
    if (!block || (block.pass ?? 1) === 1 || block.loopEdgeId === undefined) return true;
    return a.def.edges.some((edge) => edge.id === block.loopEdgeId && edge.target === nodeId);
  };

  const isPending = (a: ActiveRun, nodeId: string): boolean => {
    const status = a.run.blocks[nodeId]?.status;
    return status === "pending" && !a.inFlight.has(nodeId);
  };

  const readinessState = (a: ActiveRun): Parameters<typeof computeReadiness>[1] => {
    const status: Record<string, WorkflowBlockRun["status"] | undefined> = {};
    const handle: Record<string, string | undefined> = {};
    for (const [id, block] of Object.entries(a.run.blocks)) {
      status[id] = a.inFlight.has(id) && block.status === "pending" ? "queued" : block.status;
      if (block.handle !== undefined) handle[id] = block.handle;
    }
    return { status, handle };
  };

  const applyEdges = (a: ActiveRun, edgeStates: Record<string, "live" | "dead" | "pending">): void => {
    const taken: string[] = [];
    const dead: string[] = [];
    for (const edge of a.def.edges) {
      const state = edgeStates[edge.id];
      if (state === "live") taken.push(edge.id);
      else if (state === "dead") dead.push(edge.id);
    }
    const same = (x: string[], y: string[]): boolean => x.length === y.length && x.every((value, index) => value === y[index]);
    if (!same(taken, a.run.takenEdges) || !same(dead, a.run.deadEdges)) {
      a.run.takenEdges = taken;
      a.run.deadEdges = dead;
      a.edgesDirty = true;
      markDirty(a);
    }
  };

  /**
   * A single-block test's edges: only what ran. An edge is taken when its source finished on its
   * handle AND its target ran (a seeded upstream block or the tested block itself) — the tested
   * block's outgoing edges lead to blocks that did not run, so none of them is taken.
   */
  const testNodeEdgeStates = (a: ActiveRun): Record<string, "live" | "dead" | "pending"> => {
    const states: Record<string, "live" | "dead" | "pending"> = { ...computeReadiness(a.def, readinessState(a)).edgeStates };
    for (const edge of a.def.edges) {
      if (states[edge.id] !== "live") continue;
      const target = a.run.blocks[edge.target];
      if (!target || (target.status !== "succeeded" && target.status !== "failed")) states[edge.id] = "dead";
    }
    return states;
  };

  const step = (a: ActiveRun): void => {
    if (!alive(a)) return;
    if (a.ending !== null) {
      if (a.inFlight.size === 0 && a.phase !== "preparing") void finalize(a);
      return;
    }
    if (a.phase !== "walking") return;
    for (const id of a.forced) if (isPending(a, id) && forcedThisPass(a, id)) startBlock(a, id);
    if (a.run.testNodeOnly) {
      if (a.inFlight.size === 0) {
        applyEdges(a, testNodeEdgeStates(a));
        void finalize(a);
      }
      return;
    }
    const readiness = computeReadiness(a.def, readinessState(a));
    const now = nowIso();
    let changed = false;
    for (const id of readiness.skip) {
      const block = a.run.blocks[id];
      if (!block || !isPending(a, id)) continue;
      block.status = "skipped";
      block.endedAt = now;
      markDirty(a, id);
      changed = true;
    }
    applyEdges(a, readiness.edgeStates);
    const toStart = readiness.ready.filter((id) => isPending(a, id));
    // gates: a parked run about to work again while the run cap is full is held (still parked)
    // until the queue admits it — `pump` releases it and walks it again.
    if (toStart.length > 0 && (a.held || parking.mustHold(a, toStart.map((id) => a.nodes.get(id)?.type)))) {
      if (!a.held) parking.hold(a);
      if (changed) void save(a);
      return;
    }
    for (const id of toStart) startBlock(a, id);
    if (a.inFlight.size === 0) {
      void finalize(a);
      return;
    }
    parking.refresh(a);
    if (changed) void save(a);
  };

  /** Mark the triggers that did not fire as skipped and force the entry blocks (idempotent). */
  const applyInitialForcing = (a: ActiveRun): void => {
    const now = nowIso();
    for (const id of a.order) {
      const node = a.nodes.get(id)!;
      if (!isTriggerType(node.type) || a.forced.has(id)) continue;
      const block = a.run.blocks[id];
      if (block && block.status === "pending") {
        block.status = "skipped";
        block.endedAt = now;
        markDirty(a, id);
      }
    }
  };

  const computeForced = (a: ActiveRun): void => {
    a.forced.clear();
    delete a.rootInput;
    if (a.run.fromNodeId !== undefined) {
      if (a.nodes.has(a.run.fromNodeId)) a.forced.add(a.run.fromNodeId);
      return;
    }
    const triggers = a.order.filter((id) => isTriggerType(a.nodes.get(id)!.type));
    if (triggers.length === 0) {
      // A trigger-less workflow (manual only): its roots start, reading the manual input.
      // (Loops: a loop edge never makes its target a non-root.)
      const targets = new Set(a.def.edges.filter((edge) => a.nodes.has(edge.source) && !isLoopEdge(edge)).map((edge) => edge.target));
      for (const id of a.order) if (!targets.has(id)) a.forced.add(id);
      const payload = a.run.triggerPayload;
      if (payload && (payload.kind === "manual" || payload.kind === "subworkflow")) a.rootInput = payload.input;
      return;
    }
    const named = a.run.trigger.nodeId;
    if (named !== undefined && triggers.includes(named)) {
      a.forced.add(named);
      return;
    }
    const kind = a.run.triggerPayload?.kind;
    if (kind === "manual" || kind === "subworkflow" || kind === undefined) {
      const manual = triggers.find((id) => a.nodes.get(id)!.type === "trigger.manual");
      if (manual !== undefined) {
        a.forced.add(manual);
        return;
      }
    }
    for (const id of triggers) a.forced.add(id);
  };

  const gitRefFor = (a: ActiveRun): string | undefined => {
    const payload = a.run.triggerPayload;
    if (payload?.kind !== "git") return undefined;
    const node = a.run.trigger.nodeId !== undefined ? a.nodes.get(a.run.trigger.nodeId) : undefined;
    if (node?.type !== "trigger.git" || node.config.repo.kind !== "project") return undefined;
    // A pull request: its head commit (the full `headSha` when the provider gave one).
    if (payload.event === "pull_request") {
      const head = payload.pr?.headSha || payload.sha;
      if (head) return head;
      return payload.pr?.head || undefined;
    }
    // A release or tag event may carry no sha (a release names its tag): clone at the tag then.
    if (payload.sha) return payload.sha;
    const tag = payload.tag ?? payload.release?.tag;
    if ((payload.event === "release" || payload.event === "tag") && tag) return tag;
    return undefined;
  };

  /** A PR-triggered clone at a sha that failed: the PR's source branch to retry at, once. */
  const prBranchFallback = (a: ActiveRun, source: { kind: "empty" } | { kind: "clone"; url: string; ref?: string }): string | undefined => {
    const payload = a.run.triggerPayload;
    if (source.kind !== "clone" || payload?.kind !== "git" || payload.event !== "pull_request") return undefined;
    const head = payload.pr?.head;
    if (typeof head !== "string" || head.length === 0 || source.ref === head) return undefined;
    return source.ref === gitRefFor(a) ? head : undefined;
  };

  const prepareProject = async (a: ActiveRun): Promise<void> => {
    const projects = opts.services.projects;
    if (a.run.projectPath !== undefined) {
      const resolved = await projects.resolveExisting(a.run.projectPath).catch(() => null);
      if (!resolved) {
        failRun(a, { status: "failed", error: `The project ${a.run.projectPath} no longer exists.`, errorKind: "project_missing" });
        return;
      }
      a.project = { ...resolved, temp: a.run.tempProject !== undefined };
      return;
    }
    const target = a.def.project;
    if (target.kind === "existing") {
      const resolved = await projects.resolveExisting(target.projectPath).catch(() => null);
      if (!resolved) {
        failRun(a, { status: "failed", error: `The project ${target.projectPath} does not exist.`, errorKind: "project_missing" });
        return;
      }
      a.project = resolved;
      a.run.projectPath = resolved.path;
      markDirty(a);
      return;
    }
    const name = `wf-${slugify(a.def.name)}-${a.run.id.replace(/[^A-Za-z0-9]/g, "").slice(0, 8)}`;
    let source: { kind: "empty" } | { kind: "clone"; url: string; ref?: string } = { kind: "empty" };
    if (target.source.kind === "clone") {
      const ref = gitRefFor(a) ?? target.source.ref;
      source = ref !== undefined ? { kind: "clone", url: target.source.url, ref } : { kind: "clone", url: target.source.url };
    }
    // A creation a restart cut short left its directory (maybe half cloned): remove it first.
    const leftover = a.run.tempProject;
    if (leftover?.pending && !leftover.deleted) {
      try {
        await projects.deleteProject(leftover.path);
      } catch (error) {
        logger.warn("workflow temp project leftover could not be removed", { runId: a.run.id, path: leftover.path, error: errorMessage(error) });
      }
      if (!alive(a)) return;
    }
    // On disk BEFORE the creation: a restart in between finds the directory and cleans it up.
    const path = projects.tempPathFor(target.workspace, name);
    a.run.tempProject = { path, deleted: false, pending: true };
    markDirty(a);
    await save(a);
    if (!alive(a)) return;
    const discard = async (createdPath: string): Promise<void> => {
      try {
        await projects.deleteProject(createdPath);
        a.run.tempProject = { path: createdPath, deleted: true };
      } catch (error) {
        logger.warn("workflow temp project delete failed", { runId: a.run.id, path: createdPath, error: errorMessage(error) });
        a.run.tempProject = { path: createdPath, deleted: false, deleteAfter: nowIso() };
      }
      markDirty(a);
    };
    let created: ProjectContext;
    try {
      try {
        created = await projects.createTemp({ workspace: target.workspace, name, source });
      } catch (error) {
        // A pull request's head may be a commit the clone cannot resolve by its id (Bitbucket Cloud
        // reports 12-character heads): try once more at the PR's source branch.
        const branch = prBranchFallback(a, source);
        if (branch === undefined || !alive(a) || a.ending !== null) throw error;
        logger.info("workflow temp clone at the PR head failed; retrying at its branch", { runId: a.run.id, error: errorMessage(error) });
        await projects.deleteProject(path).catch(() => undefined);
        if (!alive(a)) throw error;
        created = await projects.createTemp({ workspace: target.workspace, name, source: { ...(source as { kind: "clone"; url: string }), ref: branch } });
      }
    } catch (error) {
      if (!alive(a)) return;
      // A failed clone can leave a partial directory behind.
      await discard(path);
      failRun(a, { status: "failed", error: `Could not create the temporary project: ${a.redactor.text(errorMessage(error))}` });
      return;
    }
    if (stopped) return; // the pending marker on disk: the next engine removes the directory.
    if (!alive(a) || a.ending !== null) {
      // The run ended while the project was being made: nothing will use it.
      await discard(created.path);
      return;
    }
    a.project = { ...created, temp: true };
    a.run.projectPath = created.path;
    a.run.tempProject = { path: created.path, deleted: false };
    markDirty(a);
    await save(a);
  };

  /** gates: the run timeout, parked time excluded (gates/parking.ts arms and re-arms it). */
  const armRunTimeout = (a: ActiveRun): void => parking.start(a);

  /**
   * Loops: a pass a reset stopped whose stopping the restart cut short (its `interruptedFrom` still
   * set) — its agent turn, process or child run may still be going. Its executor resumes it once
   * more under an aborted signal, against the archived pass (never the block's new pass), which
   * stops it the way a cancel does; the block's next pass waits until then (it is in flight).
   */
  const resumeInterruptions = (a: ActiveRun): void => {
    for (const { nodeId, pass } of pendingInterruptions(a.run)) {
      // Storage-keyed paths (an attempt dir, a child-run id) ride the wait itself, so the archived
      // pass's attempt base is not needed to stop it.
      const node = a.nodes.get(nodeId);
      const waitingOn = pass.interruptedFrom!;
      if (isLoopLimitWait(waitingOn)) {
        // A loop-limit gate's question a reset made moot: nothing runs; its gate is cancelled.
        gateHost.cancel(a.run.id, waitingOn.gateId);
        settleInterruptedPass(a.run.blocks[nodeId]);
        markDirty(a, nodeId);
        void save(a);
        continue;
      }
      if (!node || a.inFlight.has(nodeId)) continue;
      a.inFlight.add(nodeId);
      const { interruptedFrom: _marker, outputFile: _file, ...archived } = structuredClone(pass);
      const detached: PersistedBlockState = {
        ...archived,
        nodeId,
        name: node.name,
        type: node.type,
        status: "running",
        waitingOn: structuredClone(waitingOn),
        passAttemptBase: 0
      };
      const stop = new AbortController();
      stop.abort();
      void (async () => {
        try {
          const project = a.project!;
          await runExecutor(a, node, detached.attempt, stop.signal, waitingOn, project, detached);
        } catch (error) {
          logger.warn("a loop's stopped pass could not be stopped after the restart", { runId: a.run.id, nodeId, error: errorMessage(error) });
        } finally {
          a.inFlight.delete(nodeId);
          releaseSlot(a, nodeId);
          if (alive(a) && !stopping) {
            // The block's current state (a later reset may have replaced it, passes and all).
            settleInterruptedPass(a.run.blocks[nodeId]);
            markDirty(a, nodeId);
            void save(a);
            step(a);
          }
        }
      })();
    }
  };

  /**
   * gates: a Gate block's waiting record that neither a block's WaitingOn nor a loop's interrupted
   * pass names — written ahead of its wait by an older daemon that then crashed or stopped. Nobody
   * waits on it (its block re-runs and opens its own), so it is cancelled: never counted, listed or
   * decided. Engine-internal gates (a loop limit's) are named by their WaitingOn before they exist.
   */
  const cancelOrphanGates = (a: ActiveRun): void => {
    const gates = a.run.gates;
    if (gates === undefined) return;
    const named = new Set<string>();
    for (const block of Object.values(a.run.blocks)) {
      if (block.waitingOn?.kind === "gate") named.add(block.waitingOn.gateId);
      for (const pass of block.passes ?? []) if (pass.interruptedFrom?.kind === "gate") named.add(pass.interruptedFrom.gateId);
    }
    for (const gate of Object.values(gates)) {
      if (gate.source === "gate" && isWaiting(gate) && !named.has(gate.gateId)) gateHost.cancel(a.run.id, gate.gateId);
    }
  };

  const resumeBlocks = (a: ActiveRun): void => {
    const now = nowIso();
    for (const id of a.order) {
      const block = a.run.blocks[id];
      const node = a.nodes.get(id)!;
      if (!block) continue;
      if (block.status === "queued" && block.waitingOn === undefined) {
        block.status = "pending";
        continue;
      }
      if (block.status !== "running" && block.status !== "waiting" && block.status !== "queued") continue;
      if (block.waitingOn !== undefined) {
        startBlock(a, id, block.waitingOn);
        continue;
      }
      if (SAFE_TO_RERUN.has(node.type) || block.attempt < maxTriesOf(node)) {
        if (SAFE_TO_RERUN.has(node.type)) block.attempt = Math.max(0, block.attempt - 1);
        block.status = "pending";
        a.inFlight.add(id);
        void executeBlock(a, id);
        continue;
      }
      block.status = "failed";
      block.handle = "error";
      block.error = { kind: "interrupted", message: "The daemon restarted while this block was running." };
      block.endedAt = now;
      markDirty(a, id);
      if (!hasErrorEdge(a, id)) failRun(a, { status: "failed", error: `${node.name}: ${block.error.message}` });
    }
  };

  const startWalk = async (a: ActiveRun, resuming: boolean): Promise<void> => {
    a.phase = "preparing";
    try {
      await prepareProject(a);
    } catch (error) {
      failRun(a, { status: "failed", error: `Could not prepare the project: ${errorMessage(error)}` });
    }
    if (!alive(a)) return;
    a.phase = "walking";
    if (a.ending !== null || a.project === null) {
      if (a.ending === null) failRun(a, { status: "failed", error: "The project could not be prepared." });
      step(a);
      return;
    }
    armRunTimeout(a);
    computeForced(a);
    applyInitialForcing(a);
    if (resuming) cancelOrphanGates(a);
    if (resuming) resumeInterruptions(a);
    if (resuming) resumeBlocks(a);
    markDirty(a);
    void save(a);
    step(a);
  };

  const abortRun = (a: ActiveRun): void => {
    if (!a.abort.signal.aborted) a.abort.abort();
    for (const childId of a.children) void cancel(childId);
    if (!a.graceArmed) {
      a.graceArmed = true;
      const until = new Date(clock.now().getTime() + limits.endingGraceMs);
      void sleepUntil(clock, until, a.lifetime.signal).then((reached) => {
        if (reached && alive(a) && a.phase !== "preparing") {
          logger.warn("workflow run blocks ignored their abort; finalizing", { runId: a.run.id, blocks: [...a.inFlight] });
          void finalize(a);
        }
      });
    }
  };

  // -------------------------------------------------------------------------
  // Finalizing
  // -------------------------------------------------------------------------

  const resultOf = (a: ActiveRun): RunResult => {
    const result: RunResult = toRunSummary(a.run);
    const nodeId = a.run.finalOutputNodeId;
    if (nodeId !== undefined && a.outputs.has(nodeId)) result.finalOutput = a.outputs.get(nodeId);
    else if (a.run.finalOutput !== undefined) result.finalOutput = a.run.finalOutput;
    return result;
  };

  const finalize = async (a: ActiveRun): Promise<void> => {
    if (a.finished || stopped) return;
    a.finished = true;
    a.lifetime.abort();
    if (!a.abort.signal.aborted && a.ending !== null) a.abort.abort();
    const now = nowIso();
    const status: WorkflowRunStatus = a.ending?.status ?? "succeeded";
    for (const [id, block] of Object.entries(a.run.blocks)) {
      if (isFinishedBlockStatus(block.status)) continue;
      block.status = a.ending !== null ? "cancelled" : "skipped";
      block.endedAt = now;
      delete block.waitingOn;
      delete block.waitingUntil;
      a.dirty.add(id);
    }
    for (const release of a.slots.values()) release();
    a.slots.clear();
    // gates: its waiting gates end with it (cancelled), its parked stretch closes.
    gateHost.cancelAll(a.run.id);
    parking.finish(a);

    // The final output: the Stop's value, else the last succeeded block's in topological order.
    let finalNodeId = a.ending?.finalOutputNodeId;
    // A single-block test's result is the tested block's, never a seeded upstream block's.
    if (finalNodeId === undefined && status === "succeeded" && a.run.testNodeOnly && a.run.fromNodeId !== undefined) {
      if (a.run.blocks[a.run.fromNodeId]?.status === "succeeded") finalNodeId = a.run.fromNodeId;
    }
    if (finalNodeId === undefined && status === "succeeded" && !a.run.testNodeOnly) {
      for (let index = a.order.length - 1; index >= 0; index -= 1) {
        const id = a.order[index]!;
        if (a.run.blocks[id]?.status === "succeeded" && a.run.blocks[id]?.output !== undefined) {
          finalNodeId = id;
          break;
        }
      }
    }
    if (finalNodeId !== undefined && a.run.blocks[finalNodeId]) {
      a.run.finalOutputNodeId = finalNodeId;
      a.run.finalOutput = structuredClone(a.run.blocks[finalNodeId]!.output);
    }

    a.run.status = status;
    a.run.endedAt = now;
    a.run.durationMs = Math.max(0, Date.parse(now) - Date.parse(a.run.startedAt ?? a.run.queuedAt));
    if (a.ending?.error !== undefined) a.run.error = a.redactor.text(a.ending.error);
    else if (status === "cancelled") a.run.error = "Cancelled.";
    if (a.ending?.errorKind !== undefined) a.run.errorKind = a.ending.errorKind;
    delete a.run.current;
    delete a.run.queuedFor;
    a.summaryDirty = true;

    // Temporary project: gone on success; kept `keepFailedTempDays` otherwise (§5.10). A run of a
    // workflow that was deleted keeps nothing: its run record goes with it, and with the record
    // the only thing that would ever sweep the project.
    const temp = a.run.tempProject;
    if (temp && !temp.deleted) {
      const keepDays = a.def.settings.keepFailedTempDays ?? 3;
      delete temp.pending;
      if (status === "succeeded" || status === "stopped" || keepDays <= 0 || a.noPersist) {
        // Due now BEFORE the await: an engine stopped meanwhile persists this state, and the
        // sweeper then deletes what this delete did not get to.
        temp.deleteAfter = nowIso();
        try {
          await opts.services.projects.deleteProject(temp.path);
          temp.deleted = true;
          delete temp.deleteAfter;
        } catch (error) {
          logger.warn("workflow temp project delete failed", { runId: a.run.id, path: temp.path, error: errorMessage(error) });
        }
      } else {
        temp.deleteAfter = new Date(Date.parse(now) + keepDays * DAY_MS).toISOString();
      }
    }

    if (stopped) return;
    appendEvent(a, { type: "run.finished", status, error: a.run.error });
    await save(a, true);
    if (a.publishTimer) {
      a.publishTimer.cancel();
      a.publishTimer = null;
    }
    publishUpdate(a);
    const summary = toRunSummary(a.run);
    emit("workflowRun.finished", { run: summary });
    active.delete(a.run.id);
    emitUpserted(a.run.workflowId);
    if (opts.notifier && !a.noPersist) {
      try {
        const workflow = store.get(a.run.workflowId) ?? a.def;
        opts.notifier.runFinished(summary, workflow);
      } catch (error) {
        logger.warn("workflow notifier failed", { runId: a.run.id, error: errorMessage(error) });
      }
    }
    const result = resultOf(a);
    for (const waiter of a.waiters.splice(0)) waiter(result);
    pump();
  };

  // -------------------------------------------------------------------------
  // Queue and admission
  // -------------------------------------------------------------------------

  const begin = (a: ActiveRun, resuming: boolean): void => {
    a.phase = "preparing";
    if (!resuming) {
      a.run.status = "running";
      a.run.startedAt = nowIso();
      delete a.run.queuedFor;
      delete a.run.skipDetail;
      appendEvent(a, { type: "run.started" });
      markDirty(a);
      void save(a);
      emitUpserted(a.run.workflowId);
    }
    void startWalk(a, resuming);
  };

  /** gates: a top-level run the global cap counts: started, not finished, not parked (spec 2026-11-10 §6.2). */
  const countsTowardCap = (a: ActiveRun): boolean => a.run.depth === 0 && a.phase !== "queued" && !a.finished && a.run.parked !== true;

  const pump = (): void => {
    if (stopped) return;
    // gates: held (parked) runs were admitted before: they go first.
    parking.releaseHeld();
    const queued = [...active.values()]
      .filter((a) => a.phase === "queued" && !a.finished)
      .sort((x, y) => (x.run.queuedAt < y.run.queuedAt ? -1 : x.run.queuedAt > y.run.queuedAt ? 1 : x.run.id < y.run.id ? -1 : 1));
    let running = [...active.values()].filter(countsTowardCap).length;
    for (const a of queued) {
      if (a.run.depth > 0) {
        begin(a, false);
        continue;
      }
      if (a.run.queuedFor === "overlap") {
        const blocked = [...active.values()].some((o) => o !== a && !o.finished && o.run.workflowId === a.run.workflowId);
        if (blocked) continue;
      }
      if (running >= limits.maxConcurrentRuns) {
        if (a.run.queuedFor !== "capacity") {
          a.run.queuedFor = "capacity";
          markDirty(a);
          void save(a);
        }
        continue;
      }
      running += 1;
      begin(a, false);
    }
  };

  const newActive = (run: PersistedRun, secrets: Record<string, string>, redactSecrets: Record<string, string> = secrets): ActiveRun => {
    const def = run.definition;
    const order = topologicalOrder(def) ?? executableNodes(def).map((node) => node.id);
    return {
      run,
      def,
      nodes: new Map(executableNodes(def).map((node) => [node.id, node])),
      order,
      outputs: new Map(),
      secrets,
      redactSecrets,
      redactor: createRedactor(redactSecrets),
      abort: new AbortController(),
      lifetime: new AbortController(),
      slots: new Map(),
      inFlight: new Set(),
      blockAborts: new Map(),
      forced: new Set(),
      project: null,
      phase: "queued",
      ending: null,
      finished: false,
      waiters: [],
      dirty: new Set(),
      summaryDirty: false,
      edgesDirty: false,
      loopsDirty: false,
      lastPublishAt: Number.NEGATIVE_INFINITY,
      publishTimer: null,
      publishQueued: false,
      saving: null,
      saveRequested: false,
      noPersist: false,
      children: new Set(),
      graceArmed: false,
      gatesDirty: new Set(),
      held: false
    };
  };

  /**
   * The secrets a run redacts: its own, plus every run's above it — a parent can render
   * `{{secrets.X}}` into a child's input, and the child must redact that value too. A name two
   * workflows share with different values keeps both (the ancestor's under a suffixed name).
   */
  const chainSecrets = (own: Record<string, string>, parentRunId: string | undefined): Record<string, string> => {
    const union: Record<string, string> = Object.assign(Object.create(null) as Record<string, string>, own);
    const seen = new Set<string>();
    let cursor = parentRunId !== undefined ? active.get(parentRunId) : undefined;
    while (cursor && !seen.has(cursor.run.id)) {
      seen.add(cursor.run.id);
      for (const [name, value] of Object.entries(cursor.redactSecrets)) {
        if (!Object.hasOwn(union, name)) union[name] = value;
        else if (union[name] !== value) {
          let key = `${name} (parent)`;
          for (let n = 2; Object.hasOwn(union, key) && union[key] !== value; n += 1) key = `${name} (parent ${n})`;
          union[key] = value;
        }
      }
      cursor = cursor.run.parentRunId !== undefined ? active.get(cursor.run.parentRunId) : undefined;
    }
    return union;
  };

  const baseRun = (workflow: Workflow, runId: string, spec: RunSpec, now: string, redactor: SecretRedactor): PersistedRun => {
    const run: PersistedRun = {
      version: 1,
      id: runId,
      workflowId: workflow.id,
      workflowName: workflow.name,
      status: "queued",
      trigger: { ...spec.trigger },
      test: spec.test,
      queuedAt: now,
      definition: structuredClone(workflow),
      triggerPayload: redactor.value(structuredClone(spec.payload)),
      // Keyed by block id: no prototype, so no id can reach Object.prototype.
      blocks: Object.create(null) as PersistedRun["blocks"],
      takenEdges: [],
      deadEdges: [],
      depth: spec.depth
    };
    if (spec.parentRunId !== undefined) run.parentRunId = spec.parentRunId;
    if (spec.retryOf !== undefined) run.retryOf = spec.retryOf;
    if (spec.fromNodeId !== undefined) run.fromNodeId = spec.fromNodeId;
    if (spec.testNodeOnly) run.testNodeOnly = true;
    if (spec.usePinned) run.usePinned = true;
    if (spec.startedBy !== undefined) run.startedBy = structuredClone(spec.startedBy);
    return run;
  };

  const recordStub = async (
    workflow: Workflow,
    spec: RunSpec,
    status: "skipped" | "failed",
    detail: { skipReason?: "overlap" | "missed"; error?: string; skipDetail?: string },
    runId = opts.mintId()
  ): Promise<string> => {
    const now = nowIso();
    const secrets = opts.secrets.resolve(workflow.id);
    const redactor = createRedactor(secrets);
    const run = baseRun(workflow, runId, spec, now, redactor);
    run.status = status;
    run.endedAt = now;
    run.durationMs = 0;
    if (detail.skipReason !== undefined) run.skipReason = detail.skipReason;
    if (detail.skipDetail !== undefined) run.skipDetail = redactor.text(detail.skipDetail);
    if (detail.error !== undefined) run.error = redactor.text(detail.error);
    if (!stopped) {
      try {
        await runStore.create(run);
      } catch (error) {
        logger.error("workflow run stub create failed", { runId, error: errorMessage(error) });
      }
    }
    const summary = toRunSummary(run);
    emit("workflowRun.finished", { run: summary });
    emitUpserted(workflow.id);
    if (status === "failed" && opts.notifier) {
      try {
        opts.notifier.runFinished(summary, workflow);
      } catch (error) {
        logger.warn("workflow notifier failed", { runId, error: errorMessage(error) });
      }
    }
    return runId;
  };

  type Seed = PreparedOutput & Partial<PersistedBlockState>;

  /** Outputs a partial (fromNodeId) or retry run starts from, keyed by node id. */
  const buildSeeds = async (workflow: Workflow, spec: RunSpec, runId: string, redactor: SecretRedactor): Promise<Map<string, Seed>> => {
    const seeds = new Map<string, Seed>();
    const nodes = executableNodes(workflow);
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const order = topologicalOrder(workflow) ?? nodes.map((node) => node.id);

    const fromBlock = async (block: PersistedBlockState, nodeId: string): Promise<Seed | null> => {
      const whole = await readWholeOutput(block);
      const prepared = await prepareOutput(runId, nodeId, Math.max(1, block.attempt), whole, redactor);
      if ("error" in prepared) return null;
      const seed: Seed = { ...prepared, status: block.status, attempt: block.attempt };
      if (block.handle !== undefined) seed.handle = block.handle;
      if (block.error !== undefined) seed.error = block.error;
      if (block.startedAt !== undefined) seed.startedAt = block.startedAt;
      if (block.endedAt !== undefined) seed.endedAt = block.endedAt;
      return seed;
    };

    if (spec.freshRetry) return seeds;

    if (spec.retryOf !== undefined && spec.fromNodeId === undefined) {
      const source = await runStore.load(spec.retryOf);
      if (!source) return seeds;
      const seedable = new Set<string>();
      for (const id of order) {
        const block = source.blocks[id];
        const node = byId.get(id);
        if (!node || !block || block.status !== "succeeded" || block.type !== node.type) continue;
        // gates: a retry asks every gate again (its decision is never reused, spec 2026-11-10 §7.5).
        if (node.type === "gate") continue;
        // Loops (§7.5): seeded from the latest pass, along forward edges only (the loop counters
        // start at 0) — and never a block that ended on a loop handle: its loop decides again.
        if (loopEdgeTaken(workflow, id, block.handle) !== undefined) continue;
        const preds = workflow.edges.filter((edge) => edge.target === id && byId.has(edge.source) && !isLoopEdge(edge)).map((edge) => edge.source);
        if (preds.every((pred) => seedable.has(pred))) seedable.add(id);
      }
      for (const id of seedable) {
        const seed = await fromBlock(source.blocks[id]!, id);
        if (seed) seeds.set(id, seed);
      }
      return seeds;
    }

    if (spec.fromNodeId !== undefined) {
      const executed = new Set<string>([spec.fromNodeId]);
      if (!spec.testNodeOnly) for (const id of downstreamOf(workflow, spec.fromNodeId)) executed.add(id);
      // A single-block test seeds only what the tested block reads: its upstream. Its downstream
      // (and every unrelated branch) stays skipped — a stale earlier result there would read as
      // this test's.
      const upstream = spec.testNodeOnly ? upstreamOf(workflow, spec.fromNodeId) : null;
      const wanted = order.filter((id) => !executed.has(id) && (upstream === null || upstream.has(id)));
      // "Run from here" of a given run: the upstream outputs are that run's, as they were.
      const pinned = spec.retryOf !== undefined ? {} : (workflow.pinned ?? {});
      const fromRuns: string[] = [];
      for (const id of wanted) {
        const node = byId.get(id)!;
        const pinHandle = Object.prototype.hasOwnProperty.call(pinned, id) ? pinnedHandle(node, pinned[id]) : null;
        if (pinHandle !== null) {
          const prepared = await prepareOutput(runId, id, 1, pinned[id], redactor);
          if (!("error" in prepared)) {
            seeds.set(id, { ...prepared, status: "succeeded", handle: pinHandle, attempt: 0, pinned: true });
            continue;
          }
        }
        fromRuns.push(id);
      }
      if (fromRuns.length > 0) {
        const loaded: PersistedRun[] = [];
        if (spec.retryOf !== undefined) {
          const source = await runStore.load(spec.retryOf).catch(() => null);
          if (source) loaded.push(source);
        } else {
          const recent = await runStore.listForWorkflow(workflow.id, { limit: limits.seedSearchRuns }).catch(() => null);
          for (const summary of recent?.runs ?? []) {
            if (isRunActive(summary.status)) continue;
            const run = await runStore.load(summary.id).catch(() => null);
            if (run) loaded.push(run);
          }
        }
        for (const id of fromRuns) {
          const node = byId.get(id)!;
          for (const run of loaded) {
            const block = run.blocks[id];
            if (!block || block.type !== node.type || (block.status !== "succeeded" && block.status !== "failed")) continue;
            const seed = await fromBlock(block, id);
            if (seed) {
              seeds.set(id, seed);
              break;
            }
          }
        }
      }
    }
    return seeds;
  };

  const overlapDecision = (workflow: Workflow): "start" | "queue" | "skip" => {
    const mine = [...active.values(), ...reserving.values()].filter((a) => !a.finished && a.run.workflowId === workflow.id);
    if (mine.length === 0) return "start";
    switch (workflow.settings.overlap) {
      case "queue":
        return mine.some((a) => a.run.queuedFor === "overlap") ? "skip" : "queue";
      case "parallel":
        return mine.length >= Math.max(1, workflow.settings.maxConcurrent ?? 2) ? "skip" : "start";
      default:
        return "skip";
    }
  };

  /** The workflow ids a definition's Run workflow blocks name. */
  const childIds = (definition: Workflow): string[] =>
    definition.nodes.flatMap((node) => (node.type === "workflow" && typeof node.config.workflowId === "string" ? [node.config.workflowId] : []));

  /**
   * The part of a frozen map a child run of `rootId` needs: the workflows ITS blocks reach,
   * recursively — never its parent's whole map (each run.json holds only its own subtree).
   */
  const subtreeOf = (rootId: string, frozen: Readonly<Record<string, Workflow>>): Record<string, Workflow> => {
    const out: Record<string, Workflow> = {};
    const root = Object.hasOwn(frozen, rootId) ? frozen[rootId]! : null;
    let frontier = root ? childIds(root) : [];
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const id of frontier) {
        if (id === rootId || Object.hasOwn(out, id) || !Object.hasOwn(frozen, id)) continue;
        out[id] = frozen[id]!;
        next.push(...childIds(frozen[id]!));
      }
      frontier = next;
    }
    return out;
  };

  /**
   * Every sub-workflow `workflow` reaches through its Run workflow blocks (recursively, each once, to
   * the depth cap), as stored NOW: what its runs will run. Undefined when it has none.
   */
  const freezeSubWorkflows = (workflow: Workflow): Record<string, Workflow> | undefined => {
    const frozen: Record<string, Workflow> = {};
    let frontier = childIds(workflow);
    if (frontier.length === 0) return undefined;
    for (let depth = 0; depth < limits.maxSubWorkflowDepth && frontier.length > 0; depth += 1) {
      const next: string[] = [];
      for (const id of frontier) {
        if (id === workflow.id || Object.hasOwn(frozen, id)) continue;
        const child = store.get(id);
        if (!child) continue; // a missing child fails its block when it is reached, as before
        // Pinned test data is only ever used by a top-level test run: a child never reads it.
        const { pinned: _pinned, ...definition } = structuredClone(child);
        frozen[id] = definition;
        next.push(...childIds(child));
      }
      frontier = next;
    }
    return frozen;
  };

  const launch = async (workflow: Workflow, spec: RunSpec): Promise<{ response: RunWorkflowResponse; run?: ActiveRun }> => {
    if (stopped || stopping) throw new WorkflowEngineError(503, "ENGINE_UNAVAILABLE", "The workflow engine is stopping.");
    const runId = spec.runId ?? opts.mintId();
    // A given id (a child's, bound to its attempt) is never started twice.
    if (spec.runId !== undefined && (active.has(runId) || reserving.has(runId))) {
      throw new ChildRunUnknownError(`A run with id "${runId}" is already being started.`);
    }
    const secrets = opts.secrets.resolve(workflow.id);
    const redactSecrets = chainSecrets(secrets, spec.parentRunId);
    const redactor = createRedactor(redactSecrets);
    const seeds =
      (spec.retryOf !== undefined || spec.fromNodeId !== undefined) && !spec.freshRetry
        ? await buildSeeds(workflow, spec, runId, redactor)
        : new Map<string, Seed>();

    // From here to `active.set` nothing awaits: the overlap decision and the registration are atomic.
    let queuedFor: "overlap" | undefined;
    let skipDetail: string | undefined;
    if (!spec.force && spec.depth === 0) {
      const decision = overlapDecision(workflow);
      if (decision !== "start") {
        // gates: a run held back by one that waits on a gate says so (never a silent skip).
        const waiting = [...active.values()].filter((o) => !o.finished && o.run.workflowId === workflow.id).map((o) => gateHost.waitingGateOf(o.run.id)).find((gate) => gate !== undefined);
        skipDetail = overlapSkipDetail(waiting);
      }
      if (decision === "skip") {
        await recordStub(workflow, spec, "skipped", { skipReason: "overlap", ...(skipDetail !== undefined ? { skipDetail } : {}) }, runId);
        return { response: { runId: null, skipped: "overlap", ...(skipDetail !== undefined ? { skipDetail } : {}) } };
      }
      if (decision === "queue") queuedFor = "overlap";
    }
    const now = nowIso();
    const run = baseRun(workflow, runId, spec, now, redactor);
    if (queuedFor !== undefined) run.queuedFor = queuedFor;
    if (queuedFor !== undefined && skipDetail !== undefined) run.skipDetail = redactor.text(skipDetail);
    // Sub-workflows are frozen when the top-level run starts; a child run carries that map on.
    const subWorkflows = spec.subWorkflows ?? (spec.parentRunId === undefined ? freezeSubWorkflows(workflow) : undefined);
    if (subWorkflows !== undefined) run.subWorkflows = subWorkflows;
    if (spec.parentAttempt !== undefined) run.parentAttempt = spec.parentAttempt;
    const a = newActive(run, secrets, redactSecrets);
    let executed: Set<string> | null = null;
    if (spec.fromNodeId !== undefined) {
      executed = new Set([spec.fromNodeId]);
      if (!spec.testNodeOnly) for (const id of downstreamOf(run.definition, spec.fromNodeId)) executed.add(id);
    }
    for (const node of executableNodes(run.definition)) {
      const block: PersistedBlockState = { nodeId: node.id, name: node.name, type: node.type, status: "pending", attempt: 0 };
      const seed = seeds.get(node.id);
      if (seed) {
        const { output: _output, outputTruncated: _truncated, outputFile: _file, whole, ...rest } = seed;
        void _output;
        void _truncated;
        void _file;
        Object.assign(block, rest);
        applyOutput(a, block, seed);
        if (whole === undefined) a.outputs.delete(node.id);
      } else if (executed !== null && !executed.has(node.id)) {
        block.status = "skipped";
        block.endedAt = now;
      }
      run.blocks[node.id] = block;
    }
    // Reserved (the overlap decision counts it) but not active until its record exists: nothing
    // may start, save or list a run whose run.json was never created.
    reserving.set(runId, a);
    try {
      await runStore.create(structuredClone(run));
    } catch (error) {
      throw new WorkflowEngineError(503, "WORKFLOWS_UNAVAILABLE", `Could not record the run: ${errorMessage(error)}`);
    } finally {
      reserving.delete(runId);
    }
    active.set(runId, a);
    emit("workflowRun.started", { run: toRunSummary(run) });
    emitUpserted(workflow.id);
    pump();
    return { response: { runId, ...(run.skipDetail !== undefined ? { skipDetail: run.skipDetail } : {}) }, run: a };
  };

  const validationErrors = (workflow: Workflow): ReturnType<typeof validateWorkflow>["problems"] | null => {
    const result = validateWorkflow(workflow);
    const errors = result.problems.filter((problem) => problem.severity === "error");
    return hasWorkflowErrors(result.problems) ? errors : null;
  };

  // -------------------------------------------------------------------------
  // Sub-workflows
  // -------------------------------------------------------------------------

  const waitForRun = async (runId: string): Promise<RunResult> => {
    const a = active.get(runId);
    if (a) return new Promise<RunResult>((resolve) => a.waiters.push(resolve));
    const run = await runStore.load(runId);
    if (!run) throw new WorkflowEngineError(404, "RUN_NOT_FOUND", `No run with id "${runId}".`);
    if (isRunActive(run.status)) throw new WorkflowEngineError(409, "RUN_NOT_ACTIVE", `Run "${runId}" is not held by this engine.`);
    const result: RunResult = toRunSummary(run);
    const nodeId = run.finalOutputNodeId;
    const block = nodeId !== undefined ? run.blocks[nodeId] : undefined;
    if (block) result.finalOutput = await readWholeOutput(block);
    else if (run.finalOutput !== undefined) result.finalOutput = run.finalOutput;
    return result;
  };

  const awaitRun = (runId: string, signal: AbortSignal): Promise<RunResult> => {
    const onAbort = (): void => {
      void cancel(runId);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    return waitForRun(runId).finally(() => signal.removeEventListener("abort", onAbort));
  };

  const runChild = async (input: {
    workflowId: string;
    input: unknown;
    parentRunId: string;
    parentNodeId: string;
    depth: number;
    signal: AbortSignal;
    attempt?: number;
    /** The input carries data someone else wrote: the child frames it in its prompts. */
    untrusted?: boolean;
  }): Promise<{ runId: string; wait: Promise<RunResult> }> => {
    const depth = input.depth + 1;
    if (depth > limits.maxSubWorkflowDepth) {
      throw new WorkflowEngineError(400, "LIMIT_EXCEEDED", `Sub-workflows nest at most ${limits.maxSubWorkflowDepth} deep.`);
    }
    const parent = active.get(input.parentRunId);
    // Cycle: the child's workflow must not be running above it.
    let cursor: ActiveRun | undefined = parent;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor.run.id)) {
      seen.add(cursor.run.id);
      if (cursor.run.workflowId === input.workflowId) {
        throw new WorkflowEngineError(400, "INVALID_REQUEST", "A sub-workflow cannot run a workflow that is already running above it (a cycle).");
      }
      cursor = cursor.run.parentRunId !== undefined ? active.get(cursor.run.parentRunId) : undefined;
    }
    // One child per attempt: its id is bound to (parent run, block, attempt). One that exists — a
    // resumed attempt asking again — is that attempt's child: returned, never started twice.
    const boundId = input.attempt !== undefined ? childRunIdFor(input.parentRunId, input.parentNodeId, input.attempt) : undefined;
    if (boundId !== undefined) {
      let held = active.has(boundId) || reserving.has(boundId);
      if (!held) {
        try {
          held = await runStore.exists(boundId);
        } catch (error) {
          // Whether this attempt already started its child cannot be told: never a second one, and
          // never a retryable validation failure.
          throw new ChildRunUnknownError(`Whether this attempt already started its sub-workflow could not be read: ${errorMessage(error)}`);
        }
      }
      if (held) {
        // Still being recorded by a launch in flight: wait for it (awaitRun needs it active).
        if (!active.has(boundId) && reserving.has(boundId)) {
          throw new ChildRunUnknownError("This attempt's sub-workflow is still being started.");
        }
        parent?.children.add(boundId);
        return { runId: boundId, wait: awaitRun(boundId, input.signal) };
      }
    }
    // The definition frozen when the top-level run started (what its approval showed), never a later
    // edit; a run recorded before freezing existed (no map) reads the current one.
    const frozen = parent?.run.subWorkflows;
    const workflow = frozen !== undefined ? (Object.hasOwn(frozen, input.workflowId) ? frozen[input.workflowId]! : null) : store.get(input.workflowId);
    if (!workflow) {
      throw new WorkflowEngineError(
        404,
        "WORKFLOW_NOT_FOUND",
        frozen !== undefined ? `No workflow with id "${input.workflowId}" existed when this run started.` : `No workflow with id "${input.workflowId}".`
      );
    }
    // Deleted since: its runs (and their history) went with it — never start one under a gone id.
    if (frozen !== undefined && !store.get(input.workflowId)) {
      throw new WorkflowEngineError(404, "WORKFLOW_NOT_FOUND", `The sub-workflow "${workflow.name}" was deleted after this run started.`);
    }
    const problems = validationErrors(workflow);
    if (problems) {
      throw new WorkflowEngineError(400, "INVALID_WORKFLOW", `The sub-workflow "${workflow.name}" has errors: ${problems[0]!.message}`, problems);
    }
    // The child's declared inputs (spec 2026-11-10 §11): the value must fit them, defaults applied —
    // a test run's child, like a test run, does not need every required input.
    let childInput = input.input;
    const declared = workflowRunInputs(workflow);
    if (declared !== undefined) {
      const check = validateWorkflowInput(declared, input.input, { requireAll: !(parent?.run.test ?? false) });
      if (check.errors.length > 0) throw invalidInput(`The input does not fit the inputs of the sub-workflow "${workflow.name}"`, check.errors);
      childInput = check.value;
    }
    const launched = await launch(structuredClone(workflow), {
      trigger: { kind: "subworkflow", text: parent ? `From ${parent.run.workflowName}` : undefined },
      payload: {
        kind: "subworkflow",
        input: childInput,
        parentRunId: input.parentRunId,
        parentNodeId: input.parentNodeId,
        ...(input.untrusted ? { untrusted: true as const } : {})
      },
      test: parent?.run.test ?? false,
      force: true,
      depth,
      parentRunId: input.parentRunId,
      // gates: a child asks its top-level run's launcher (spec 2026-11-10 §6.3).
      ...(parent?.run.startedBy !== undefined ? { startedBy: parent.run.startedBy } : {}),
      ...(boundId !== undefined ? { runId: boundId, parentAttempt: input.attempt } : {}),
      // The child carries only its own subtree of the frozen map.
      ...(frozen !== undefined ? { subWorkflows: subtreeOf(input.workflowId, frozen) } : {})
    });
    const runId = launched.response.runId!;
    parent?.children.add(runId);
    return { runId, wait: awaitRun(runId, input.signal) };
  };

  // -------------------------------------------------------------------------
  // Cancel
  // -------------------------------------------------------------------------

  const cancel = async (runId: string): Promise<boolean> => {
    const a = active.get(runId);
    if (!a || a.finished) return false;
    if (a.ending === null) a.ending = { status: "cancelled", error: "Cancelled." };
    if (a.phase === "queued") {
      await finalize(a);
      return true;
    }
    abortRun(a);
    step(a);
    return true;
  };

  // -------------------------------------------------------------------------
  // Store subscriptions
  // -------------------------------------------------------------------------

  const unsubscribers: (() => void)[] = [];
  unsubscribers.push(
    store.onDeleted((workflowId) => {
      for (const a of [...active.values()]) {
        if (a.run.workflowId !== workflowId) continue;
        a.noPersist = true;
        void cancel(a.run.id);
      }
    })
  );

  // -------------------------------------------------------------------------
  // Resume
  // -------------------------------------------------------------------------

  /**
   * The child run an attempt of a Run workflow block started: exactly its bound id
   * (`childRunIdFor`); else, for a child an older build recorded (no binding), the newest unbound
   * child of that block queued since the attempt started. Null: it started none. Throws when that
   * cannot be told (the caller marks the block interrupted — never a second child).
   */
  const childRunOf = async (parentRunId: string, node: WorkflowNode, block: PersistedBlockState): Promise<string | null> => {
    const bound = childRunIdFor(parentRunId, node.id, storageAttempt(block));
    if (active.has(bound) || (await runStore.exists(bound))) return bound;
    const since = block.startedAt;
    const legacy = (run: Pick<PersistedRun, "parentRunId" | "triggerPayload" | "parentAttempt" | "queuedAt">): boolean =>
      run.parentRunId === parentRunId &&
      run.parentAttempt === undefined &&
      run.triggerPayload?.kind === "subworkflow" &&
      run.triggerPayload.parentNodeId === node.id &&
      (since === undefined || run.queuedAt >= since);
    for (const a of active.values()) if (legacy(a.run)) return a.run.id;
    const childWorkflowId = node.type === "workflow" ? node.config.workflowId : undefined;
    if (typeof childWorkflowId !== "string") return null;
    // Newest first, every page, until the runs are older than the attempt (no fixed window).
    let before: string | undefined;
    for (;;) {
      const page = await runStore.listForWorkflow(childWorkflowId, { limit: 200, ...(before !== undefined ? { before } : {}) });
      for (const summary of page.runs) {
        if (since !== undefined && summary.queuedAt < since) return null;
        if (summary.parentRunId !== parentRunId) continue;
        const run = await runStore.load(summary.id);
        // Listed but unreadable (I/O, parse): not a definite absence — the lookup failed.
        if (run === null) throw new Error(`the run ${summary.id} is listed but cannot be read`);
        if (legacy(run)) return run.id;
      }
      if (page.before === null || page.runs.length === 0) return null;
      before = page.before;
    }
  };

  /** A block the restart cannot safely resume nor re-run: failed as interrupted (resumeBlocks' own rule). */
  const interruptBlock = (a: ActiveRun, node: WorkflowNode, message: string): void => {
    const block = a.run.blocks[node.id]!;
    block.status = "failed";
    block.handle = "error";
    block.error = { kind: "interrupted", message };
    block.endedAt = nowIso();
    markDirty(a, node.id);
    if (!hasErrorEdge(a, node.id)) failRun(a, { status: "failed", error: `${node.name}: ${message}` });
  };

  const resume = async (): Promise<void> => {
    let runs: PersistedRun[];
    try {
      runs = await runStore.listUnfinished();
    } catch (error) {
      logger.error("workflow runs could not be listed for resume", { error: errorMessage(error) });
      return;
    }
    const toWalk: ActiveRun[] = [];
    for (const run of runs) {
      if (active.has(run.id)) continue;
      let a: ActiveRun;
      try {
        if (!run.definition || !Array.isArray(run.definition.nodes) || run.blocks === null || typeof run.blocks !== "object") {
          throw new Error("malformed run");
        }
        // Block ids key the run's state: an id this build refuses (`__proto__` from an older one)
        // is never used as a key.
        const ids = [...run.definition.nodes.map((node) => node?.id), ...Object.keys(run.blocks)];
        if (ids.some((id) => typeof id !== "string" || !WORKFLOW_GRAPH_ID_PATTERN.test(id))) throw new Error("malformed block id");
        run.blocks = Object.assign(Object.create(null) as PersistedRun["blocks"], run.blocks);
        a = newActive(run, opts.secrets.resolve(run.workflowId));
      } catch (error) {
        logger.warn("workflow run cannot be resumed", { runId: run.id, error: errorMessage(error) });
        run.status = "interrupted";
        run.endedAt = nowIso();
        run.error = "The run's saved state could not be read.";
        // Its temporary project is nobody's any more: due for the sweeper now (it skips a
        // project with no `deleteAfter`).
        if (run.tempProject && typeof run.tempProject === "object" && !run.tempProject.deleted) {
          run.tempProject = { path: run.tempProject.path, deleted: false, deleteAfter: nowIso() };
        }
        await runStore.save(run).catch(() => undefined);
        continue;
      }
      // Blocks a newer definition shape may lack: make sure every executable node has a state.
      for (const node of executableNodes(a.def)) {
        a.run.blocks[node.id] ??= { nodeId: node.id, name: node.name, type: node.type, status: "pending", attempt: 0 };
      }
      for (const [id, block] of Object.entries(a.run.blocks)) {
        // Loops: a block waiting for its next pass reads as its latest finished one; one waiting at a
        // loop's limit has finished its work (its output is its own).
        const state = block.status === "succeeded" || block.status === "failed" ? block : isLoopLimitWait(block.waitingOn) ? { ...block, status: "succeeded" as const } : latestPass(block);
        if (state && (state.status === "succeeded" || state.status === "failed")) {
          const whole = await readWholeOutput(state);
          if (whole !== undefined) a.outputs.set(id, whole);
        }
      }
      active.set(run.id, a);
      if (run.status === "running") toWalk.push(a);
    }
    // Parents know their children (a child names its parent), and a child redacts its ancestors'
    // secrets too — parents first, so a grandchild reads its parent's union.
    const depthOf = (a: ActiveRun): number => (typeof a.run.depth === "number" ? a.run.depth : 0);
    for (const a of [...active.values()].sort((x, y) => depthOf(x) - depthOf(y))) {
      if (a.run.parentRunId === undefined) continue;
      active.get(a.run.parentRunId)?.children.add(a.run.id);
      a.redactSecrets = chainSecrets(a.secrets, a.run.parentRunId);
      a.redactor = createRedactor(a.redactSecrets);
    }
    // (After the links: interrupting a block fails its run, which cancels the run's children.)
    // A Run workflow block found running without a WaitingOn (the engine stopped between marking it
    // running and recording its child — e.g. `launch` refused the child while stopping): adopt the
    // child it did start, if any, else run the block again — it started nothing.
    for (const a of toWalk) {
      for (const node of a.def.nodes) {
        const block = a.run.blocks[node.id];
        if (node.type !== "workflow" || !block || block.status !== "running" || block.waitingOn !== undefined) continue;
        let child: string | null;
        try {
          child = await childRunOf(a.run.id, node, block);
        } catch (error) {
          // Cannot tell whether this attempt started a child: interrupted, never re-run (retries
          // or not) — a child is never started twice.
          logger.warn("a sub-workflow's child run could not be looked up", { runId: a.run.id, nodeId: node.id, error: errorMessage(error) });
          interruptBlock(a, node, "The daemon restarted while this block was starting its sub-workflow, and whether it did could not be read.");
          continue;
        }
        if (child !== null) {
          block.waitingOn = { kind: "child-run", runId: child };
        } else {
          block.status = "pending";
          block.attempt = Math.max(0, block.attempt - 1);
          delete block.startedAt;
        }
        markDirty(a, node.id);
      }
    }
    for (const a of toWalk) begin(a, true);
    pump();
  };

  // -------------------------------------------------------------------------
  // The public surface
  // -------------------------------------------------------------------------

  const engine: WorkflowRuntimeEngine = {
    async run(workflowId: string, request: RunWorkflowRequest, caller?: RunCaller): Promise<RunWorkflowResponse> {
      const workflow = store.get(workflowId);
      if (!workflow) throw new WorkflowEngineError(404, "WORKFLOW_NOT_FOUND", `No workflow with id "${workflowId}".`);
      // The definition read here is the one the run freezes (`launch(workflow, …)`): checking its
      // revision now is atomic with what runs.
      if (request.expectedRevision !== undefined) {
        if (typeof request.expectedRevision !== "number" || !Number.isInteger(request.expectedRevision) || request.expectedRevision < 0) {
          throw new WorkflowEngineError(400, "INVALID_REQUEST", "expectedRevision must be a non-negative integer.");
        }
        if (workflow.revision !== request.expectedRevision) {
          throw new WorkflowEngineError(409, "REVISION_CONFLICT", `The workflow is at revision ${workflow.revision}, not ${request.expectedRevision}.`);
        }
      }
      const problems = validationErrors(workflow);
      if (problems) throw new WorkflowEngineError(400, "INVALID_WORKFLOW", `The workflow has errors: ${problems[0]!.message}`, problems);
      let payload: WorkflowTriggerPayload = { kind: "manual", input: request.input ?? null };
      let triggerNodeId: string | undefined;
      if (request.retryOf !== undefined) {
        if (active.has(request.retryOf)) {
          throw new WorkflowEngineError(409, "INVALID_REQUEST", "That run is still running; retry it once it has ended.");
        }
        const source = await runStore.load(request.retryOf);
        if (!source) throw new WorkflowEngineError(404, "RUN_NOT_FOUND", `No run with id "${request.retryOf}".`);
        if (source.workflowId !== workflowId) throw new WorkflowEngineError(400, "INVALID_REQUEST", "That run belongs to another workflow.");
        if (isRunActive(source.status)) throw new WorkflowEngineError(409, "INVALID_REQUEST", "That run has not ended.");
        if (source.triggerPayload) payload = source.triggerPayload;
        triggerNodeId = source.trigger.nodeId;
      }
      let fromNodeId = request.fromNodeId;
      let freshRetry = false;
      if (fromNodeId !== undefined) {
        const node = workflow.nodes.find((candidate) => candidate.id === fromNodeId);
        if (!node || node.type === "note") throw new WorkflowEngineError(404, "NODE_NOT_FOUND", `No block with id "${fromNodeId}".`);
        if (request.retryOf !== undefined && isTriggerType(node.type)) {
          // "Retry run": the whole run again from the trigger that fired, with the same event.
          triggerNodeId = node.id;
          fromNodeId = undefined;
          freshRetry = true;
        }
      }
      if (triggerNodeId === undefined && payload.kind === "manual") {
        triggerNodeId = workflow.nodes.find((node) => node.type === "trigger.manual" && !node.disabled)?.id;
      }
      const test = request.test === true || (fromNodeId !== undefined && request.retryOf === undefined);
      const kind: WorkflowTriggerKind = request.retryOf !== undefined ? "retry" : test ? "test" : "manual";
      // Typed inputs (spec 2026-11-10 §4.2): the run stores the validated, defaulted input. A retry
      // reuses its source run's payload as it was, never re-checked against a later inputs change;
      // a test run applies defaults but does not need every required input (§7.5).
      if (request.retryOf === undefined) {
        const declared = workflowRunInputs(workflow, triggerNodeId);
        if (declared !== undefined) {
          const check = validateWorkflowInput(declared, request.input, { requireAll: !test });
          if (check.errors.length > 0) throw invalidInput("The input does not fit the workflow's inputs", check.errors);
          payload = { kind: "manual", input: check.value };
        }
      }
      const spec: RunSpec = {
        trigger: triggerNodeId !== undefined ? { kind, nodeId: triggerNodeId } : { kind },
        payload,
        test,
        force: request.force === true,
        depth: 0,
        // gates: the daemon's word for who asked (the route's principal), never the request body's.
        startedBy: caller?.startedBy !== undefined ? structuredClone(caller.startedBy) : { kind: "human" }
      };
      if (request.retryOf !== undefined) spec.retryOf = request.retryOf;
      if (freshRetry) spec.freshRetry = true;
      if (fromNodeId !== undefined) spec.fromNodeId = fromNodeId;
      if (request.usePinned === true) spec.usePinned = true;
      return (await launch(workflow, spec)).response;
    },

    async testNode(workflowId: string, nodeId: string): Promise<RunWorkflowResponse> {
      const workflow = store.get(workflowId);
      if (!workflow) throw new WorkflowEngineError(404, "WORKFLOW_NOT_FOUND", `No workflow with id "${workflowId}".`);
      const node = workflow.nodes.find((candidate) => candidate.id === nodeId);
      if (!node || node.type === "note") throw new WorkflowEngineError(404, "NODE_NOT_FOUND", `No block with id "${nodeId}".`);
      const problems = validationErrors(workflow);
      if (problems) throw new WorkflowEngineError(400, "INVALID_WORKFLOW", `The workflow has errors: ${problems[0]!.message}`, problems);
      const manual = workflow.nodes.find((candidate) => candidate.type === "trigger.manual" && !candidate.disabled)?.id;
      // No input is given: the declared inputs' defaults, without requiring the rest (§7.5).
      const defaults = validateWorkflowInput(workflowRunInputs(workflow, manual), null, { requireAll: false });
      return (
        await launch(workflow, {
          trigger: manual !== undefined ? { kind: "test", nodeId: manual } : { kind: "test" },
          payload: { kind: "manual", input: defaults.errors.length === 0 ? (defaults.value ?? null) : null },
          test: true,
          force: true,
          depth: 0,
          fromNodeId: nodeId,
          testNodeOnly: true,
          usePinned: true,
          startedBy: { kind: "human" }
        })
      ).response;
    },

    cancel,

    async getRun(runId: string): Promise<WorkflowRun | null> {
      const a = active.get(runId);
      if (a) return publicRun(a.run);
      const run = await runStore.load(runId);
      return run ? publicRun(run) : null;
    },

    listRuns(workflowId: string, options: { before?: string; limit: number }): Promise<ListWorkflowRunsResponse> {
      return runStore.listForWorkflow(workflowId, options);
    },

    async nodeOutput(runId: string, nodeId: string): Promise<{ found: boolean; output?: unknown }> {
      const a = active.get(runId);
      const run = a?.run ?? (await runStore.load(runId));
      const block = run?.blocks[nodeId];
      if (!block) return { found: false };
      if (a && a.outputs.has(nodeId)) return { found: true, output: a.outputs.get(nodeId) };
      if (block.output === undefined && block.outputFile === undefined) return { found: true };
      return { found: true, output: await readWholeOutput(block) };
    },

    async nodeLogPath(runId: string, nodeId: string, stream: "stdout" | "stderr"): Promise<string | null> {
      const a = active.get(runId);
      const run = a?.run ?? (await runStore.load(runId));
      const block = run?.blocks[nodeId];
      if (!block || (block.type !== "code" && block.type !== "shell") || block.attempt < 1) return null;
      const dir = await runStore.attemptDir(runId, nodeId, storageAttempt(block));
      return join(dir, `${stream}.log`);
    },

    isNodeLogLive(runId: string, nodeId: string): boolean {
      const a = active.get(runId);
      if (!a || a.finished) return false;
      const block = a.run.blocks[nodeId];
      if (!block || (block.type !== "code" && block.type !== "shell")) return false;
      return block.status === "running" || block.status === "queued" || block.status === "waiting";
    },

    async deleteTempProject(runId: string): Promise<boolean> {
      if (active.has(runId)) return false;
      const run = await runStore.load(runId);
      if (!run || !run.tempProject || run.tempProject.deleted || isRunActive(run.status)) return false;
      await opts.services.projects.deleteProject(run.tempProject.path);
      run.tempProject = { path: run.tempProject.path, deleted: true };
      await runStore.save(run);
      emit("workflowRun.updated", { run: toRunSummary(run), blocks: [] });
      emitUpserted(run.workflowId);
      return true;
    },

    async reportStepResult(sessionId: string, request: ReportWorkflowStepRequest): Promise<ReportWorkflowStepResponse> {
      const found = reportingPassOf(sessionId);
      if (!found) throw new WorkflowEngineError(403, "NOT_A_WORKFLOW_STEP", NOT_A_REPORTING_STEP);
      const { a, node, block } = found;
      const check = checkStepReport(stepReportDecl(node), request ?? {});
      if (!check.ok) {
        throw new WorkflowEngineError(400, "INVALID_REPORT", `The report was not recorded:\n${check.problems.map((problem) => `- ${problem}`).join("\n")}`);
      }
      const report: WorkflowStepReport = a.redactor.value({ ...check.report, sessionId, reportedAt: nowIso() });
      const replaced = block.report !== undefined;
      block.report = report;
      markDirty(a, node.id);
      appendEvent(a, { type: "block.report", nodeId: node.id, attempt: block.attempt, ...(report.outcome !== undefined ? { outcome: report.outcome } : {}), replaced });
      // Persisted before the tool answers (§5.2): the executor reads it from the run after a restart.
      await save(a);
      return { recorded: true, runId: a.run.id, workflowId: a.run.workflowId, nodeId: node.id, nodeName: node.name, replaced, report: structuredClone(report) };
    },

    async accountPreview(chain: AgentChainEntry[], projectPath?: string): Promise<AccountSelectionDecision> {
      if (opts.accountPreview) return opts.accountPreview(chain, projectPath);
      return { chosen: null, reason: "Account selection is not available on this daemon.", skipped: [] };
    },

    summarize(workflow: Workflow): WorkflowSummary {
      if (summarizing) {
        // `opts.summarize` must build the row itself (buildWorkflowSummary), never call back here.
        throw new Error("WorkflowEngineOptions.summarize called engine.summarize: pass a builder, not a delegate.");
      }
      summarizing = true;
      try {
        return opts.summarize(workflow);
      } finally {
        summarizing = false;
      }
    },

    resume,

    start(): void {
      pump();
    },

    async stop(): Promise<void> {
      if (stopped) return;
      stopping = true;
      for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
      // The last state of every run reaches disk; then nothing more is written.
      await Promise.all([...active.values()].map((a) => (a.noPersist ? Promise.resolve() : save(a, true))));
      stopped = true;
      for (const a of active.values()) {
        a.lifetime.abort();
        if (a.publishTimer) {
          a.publishTimer.cancel();
          a.publishTimer = null;
        }
        for (const release of a.slots.values()) release();
        a.slots.clear();
      }
    },

    // TriggerHost
    enabledTriggers<T extends "trigger.schedule" | "trigger.git">(type: T) {
      const out: { workflow: Workflow; node: Extract<WorkflowNode, { type: T }> }[] = [];
      for (const workflow of store.list()) {
        if (!workflow.enabled) continue;
        for (const node of workflow.nodes) {
          if (node.type === type && !node.disabled) out.push({ workflow, node: node as Extract<WorkflowNode, { type: T }> });
        }
      }
      return out;
    },

    async fire(request: FireRequest): Promise<RunWorkflowResponse> {
      const workflow = store.get(request.workflowId);
      if (!workflow) throw new WorkflowEngineError(404, "WORKFLOW_NOT_FOUND", `No workflow with id "${request.workflowId}".`);
      const spec: RunSpec = {
        trigger: { kind: request.kind },
        payload: request.payload,
        test: false,
        force: false,
        depth: 0,
        startedBy: { kind: "trigger" }
      };
      if (request.triggerNodeId !== undefined) spec.trigger.nodeId = request.triggerNodeId;
      if (request.text !== undefined) spec.trigger.text = request.text;
      const problems = validationErrors(workflow);
      if (problems) {
        const runId = await recordStub(workflow, spec, "failed", { error: `The workflow has errors: ${problems[0]!.message}` });
        return { runId };
      }
      return (await launch(workflow, spec)).response;
    },

    async recordSkipped(request: FireRequest, reason: "missed" | "overlap"): Promise<void> {
      const workflow = store.get(request.workflowId);
      if (!workflow) return;
      const spec: RunSpec = { trigger: { kind: request.kind }, payload: request.payload, test: false, force: false, depth: 0, startedBy: { kind: "trigger" } };
      if (request.triggerNodeId !== undefined) spec.trigger.nodeId = request.triggerNodeId;
      if (request.text !== undefined) spec.trigger.text = request.text;
      await recordStub(workflow, spec, "skipped", { skipReason: reason });
    },

    onDefinitionsChanged(listener: () => void): () => void {
      const off = [store.onChanged(() => listener()), store.onDeleted(() => listener())];
      return () => {
        for (const unsubscribe of off) unsubscribe();
      };
    },

    waitForRun,

    activeRunIds: () => [...active.keys()],

    // gates (spec 2026-11-10 §6.2, §8)
    decideGate: (runId: string, gateId: string, request, principal: CallerPrincipal) => gateHost.decideRequest(runId, gateId, request, principal),
    listGates: (query) => gateHost.list(query),
    gates: gateHost
  };
  return engine;
}
