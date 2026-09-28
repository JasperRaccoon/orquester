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
  computeReadiness,
  downstreamOf,
  executableNodes,
  hasWorkflowErrors,
  isRunActive,
  isTriggerType,
  outputHandles,
  renderTemplate,
  renderTemplateValue,
  topologicalOrder,
  validateWorkflow,
  type AccountSelectionDecision,
  type AgentChainEntry,
  type ExpressionContext,
  type ListWorkflowRunsResponse,
  type RunWorkflowRequest,
  type RunWorkflowResponse,
  type Workflow,
  type WorkflowBlockError,
  type WorkflowBlockRun,
  type WorkflowNode,
  type WorkflowNodeType,
  type WorkflowRun,
  type WorkflowRunStatus,
  type WorkflowRunSummary,
  type WorkflowSummary,
  type WorkflowTriggerKind,
  type WorkflowTriggerPayload,
  type WorkflowsEventType
} from "@orquester/api";
import { join } from "node:path";

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
  WorkflowEngineError,
  type EngineLimits
} from "./run-context.ts";
import { createSlotPool, type SlotPool } from "./scheduler-queue.ts";
import { createRedactor, type SecretRedactor } from "./sandbox/redact.ts";

export { WorkflowEngineError } from "./run-context.ts";

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
  limits?: Partial<EngineLimits>;
}

export type RunResult = WorkflowRunSummary & { finalOutput?: unknown };

export interface WorkflowRuntimeEngine extends WorkflowEngine, TriggerHost {
  /** Resolves when the run has finished (queued or running now, or already finished on disk). */
  waitForRun(runId: string): Promise<RunResult>;
  /** Ids of the runs this engine holds (queued or running). */
  activeRunIds(): string[];
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface Ending {
  status: Extract<WorkflowRunStatus, "failed" | "cancelled" | "stopped" | "interrupted">;
  error?: string;
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
  secrets: Record<string, string>;
  redactor: SecretRedactor;
  /** Aborted when the run ends early (failure, cancel, stop, timeout): every block's signal follows. */
  abort: AbortController;
  /** Aborted when the run finalizes or the engine stops: the run's own timers. */
  lifetime: AbortController;
  slots: Map<string, () => void>;
  inFlight: Set<string>;
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
  "http"
]);

/** Failures a retry cannot fix: every account of the chain is burnt, or a hard limit was hit. */
const NOT_RETRIED: ReadonlySet<WorkflowBlockError["kind"]> = new Set<WorkflowBlockError["kind"]>(["all_burnt", "limit_exceeded"]);

function isRetryable(error: WorkflowBlockError): boolean {
  return !NOT_RETRIED.has(error.kind);
}

/**
 * A WaitingOn that means the block is WAITING (not working): a timer (Wait, retry delay), or an
 * agent block waiting for a usage reset (`phase: "waiting-reset"`, persisted as kind "agent").
 * A waiting block holds no global slot.
 */
function isWaitState(waitingOn: WaitingOn): boolean {
  return waitingOn.kind === "timer" || (waitingOn.kind === "agent" && waitingOn.phase === "waiting-reset");
}

const MAX_BLOCK_WARNINGS = 50;
const DAY_MS = 24 * 60 * 60_000;

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
  const limits: EngineLimits = { ...DEFAULT_ENGINE_LIMITS, ...opts.limits };
  const { clock, logger, runStore, store } = opts;
  const agentSlots: SlotPool = createSlotPool(limits.maxConcurrentAgentBlocks);
  const processSlots: SlotPool = createSlotPool(limits.maxConcurrentProcesses);
  const active = new Map<string, ActiveRun>();
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
    if (a.dirty.size === 0 && !a.summaryDirty && !a.edgesDirty) return;
    const blocks: WorkflowBlockRun[] = [];
    for (const id of a.dirty) {
      const block = a.run.blocks[id];
      if (block) blocks.push(publicBlock(block));
    }
    const payload: { run: WorkflowRunSummary; blocks: WorkflowBlockRun[]; takenEdges?: string[]; deadEdges?: string[] } = {
      run: toRunSummary(a.run),
      blocks
    };
    if (a.edgesDirty) {
      payload.takenEdges = [...a.run.takenEdges];
      payload.deadEdges = [...a.run.deadEdges];
    }
    a.dirty.clear();
    a.summaryDirty = false;
    a.edgesDirty = false;
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

  const readWholeOutput = async (block: PersistedBlockState): Promise<unknown> => {
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
      if (edge.target !== nodeId || seen.has(edge.source)) continue;
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
      if (!isFinishedBlockStatus(block.status)) continue;
      const entry: { output: unknown; status: string; error?: WorkflowBlockError } = {
        output: a.outputs.has(id) ? a.outputs.get(id) : block.output,
        status: block.status
      };
      if (block.error) entry.error = block.error;
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
      project: projectView
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

  const pinFor = (a: ActiveRun, node: WorkflowNode): { value: unknown } | null => {
    if (!a.run.usePinned || node.id === a.run.fromNodeId) return null;
    const pinned = a.def.pinned;
    if (!pinned || !Object.prototype.hasOwnProperty.call(pinned, node.id)) return null;
    if (!outputHandles(node).includes("success")) return null;
    return { value: pinned[node.id] };
  };

  const currentBranch = async (path: string): Promise<string | undefined> => {
    try {
      return (await opts.services.projects.currentBranch(path)) ?? undefined;
    } catch {
      return undefined;
    }
  };

  const services: EngineServices = {
    ...opts.services,
    clock,
    mintId: opts.mintId,
    logger,
    store,
    runChild: (input) => runChild(input),
    awaitRun: (runId, signal) => awaitRun(runId, signal)
  };

  const runExecutor = async (
    a: ActiveRun,
    node: WorkflowNode,
    attempt: number,
    signal: AbortSignal,
    resumeFrom: WaitingOn | undefined,
    project: ProjectContext
  ): Promise<NodeResult> => {
    const executor = opts.executors[node.type] as { execute(ctx: NodeExecutionContext): Promise<NodeResult> } | undefined;
    if (!executor) {
      return { status: "failed", error: { kind: "internal", message: `No executor is installed for "${node.type}" blocks.` } };
    }
    const block = a.run.blocks[node.id]!;
    const branch = await currentBranch(project.path);
    const exprContext = (): ExpressionContext & ReturnType<NodeExecutionContext["expressionContext"]> => ({
      ...baseContext(a, node.id, attempt, branch),
      secrets: a.secrets,
      workflow: { id: a.def.id, name: a.def.name }
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
      attempt,
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
        if (!alive(a)) return;
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
        await save(a);
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
      attemptDir: () => runStore.attemptDir(a.run.id, node.id, attempt),
      timeoutMs: blockTimeoutMs(node),
      depth: a.run.depth,
      startedAt: block.startedAt ?? nowIso(),
      liveInputs: () => liveInputsOf(a, node.id),
      services,
      log: nodeLog
    };
    if (resumeFrom !== undefined) ctx.resumeFrom = structuredClone(resumeFrom);
    try {
      const result = await executor.execute(ctx);
      if (!isValidResult(result)) {
        return { status: "failed", error: { kind: "internal", message: `The ${node.type} block returned an invalid result.` } };
      }
      return result;
    } catch (error) {
      if (signal.aborted) return { status: "cancelled" };
      return { status: "failed", error: { kind: "internal", message: errorMessage(error) } };
    }
  };

  /** The attempts of one block; null when the engine stopped or the run was finalized meanwhile. */
  const attemptLoop = async (a: ActiveRun, node: WorkflowNode, signal: AbortSignal, resume: WaitingOn | undefined): Promise<NodeResult | null> => {
    const block = a.run.blocks[node.id]!;
    let resumeFrom = resume;
    let attempt = block.attempt;

    if (resumeFrom?.kind === "timer" && resumeFrom.purpose === "retry-delay") {
      const reached = await sleepUntil(clock, new Date(resumeFrom.until), signal);
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
        return { status: "succeeded", output: isTriggerType(node.type) ? a.run.triggerPayload : inputOf(a, node.id) };
      }
      const pin = pinFor(a, node);
      if (pin) {
        block.pinned = true;
        return { status: "succeeded", output: pin.value };
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
      block.attempt = attempt;
      if (!resuming) {
        block.status = "running";
        block.startedAt = nowIso();
        delete block.endedAt;
        delete block.error;
        delete block.waitingOn;
        delete block.waitingUntil;
        delete block.handle;
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

      const result = await runExecutor(a, node, attempt, signal, resumeFrom, project);
      resumeFrom = undefined;
      if (!alive(a)) return null;
      releaseSlot(a, node.id);

      if (result.status === "failed" && isRetryable(result.error) && attempt < maxTriesOf(node) && !signal.aborted && a.ending === null) {
        const until = new Date(clock.now().getTime() + retryDelayMs(node));
        block.error = a.redactor.value(result.error);
        block.status = "waiting";
        block.waitingOn = { kind: "timer", until: until.toISOString(), purpose: "retry-delay" };
        block.waitingUntil = until.toISOString();
        markDirty(a, node.id);
        appendEvent(a, { type: "block.retry", nodeId: node.id, attempt, error: block.error });
        await save(a);
        const reached = await sleepUntil(clock, until, signal);
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

  const finishBlock = async (a: ActiveRun, node: WorkflowNode, result: NodeResult): Promise<void> => {
    if (!alive(a)) return;
    const block = a.run.blocks[node.id]!;
    delete block.waitingOn;
    delete block.waitingUntil;
    if ("warnings" in result) addWarnings(a, block, result.warnings);
    switch (result.status) {
      case "succeeded": {
        const prepared = await prepareOutput(a.run.id, node.id, block.attempt, result.output, a.redactor);
        if (!alive(a)) return;
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
          const prepared = await prepareOutput(a.run.id, node.id, block.attempt, result.output, a.redactor);
          if (!alive(a)) return;
          if ("error" in prepared) addWarnings(a, block, [`The output was dropped: ${prepared.error.message}`]);
          else applyOutput(a, block, prepared);
        }
        break;
      }
      case "stopped": {
        const prepared = await prepareOutput(a.run.id, node.id, block.attempt, result.output, a.redactor);
        if (!alive(a)) return;
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
        block.status = "cancelled";
        delete block.handle;
        break;
    }
    block.endedAt = nowIso();
    markDirty(a, node.id);
    appendEvent(a, { type: "block.finished", nodeId: node.id, status: block.status, attempt: block.attempt, error: block.error });
    void save(a);
    if (block.status === "failed" && result.status !== "stopped" && !hasErrorEdge(a, node.id)) {
      failRun(a, { status: "failed", error: `${node.name}: ${block.error?.message ?? "failed"}` });
    }
  };

  const executeBlock = async (a: ActiveRun, nodeId: string, resume?: WaitingOn): Promise<void> => {
    const node = a.nodes.get(nodeId)!;
    const blockAbort = new AbortController();
    const onRunAbort = (): void => blockAbort.abort();
    if (a.abort.signal.aborted) blockAbort.abort();
    else a.abort.signal.addEventListener("abort", onRunAbort, { once: true });
    try {
      const result = await attemptLoop(a, node, blockAbort.signal, resume);
      if (result !== null) await finishBlock(a, node, result);
    } catch (error) {
      logger.error("workflow block crashed", { runId: a.run.id, nodeId, error: errorMessage(error) });
      if (alive(a)) await finishBlock(a, node, { status: "failed", error: { kind: "internal", message: errorMessage(error) } });
    } finally {
      a.abort.signal.removeEventListener("abort", onRunAbort);
      releaseSlot(a, nodeId);
      a.inFlight.delete(nodeId);
      if (alive(a)) {
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

  const step = (a: ActiveRun): void => {
    if (!alive(a)) return;
    if (a.ending !== null) {
      if (a.inFlight.size === 0 && a.phase !== "preparing") void finalize(a);
      return;
    }
    if (a.phase !== "walking") return;
    for (const id of a.forced) if (isPending(a, id)) startBlock(a, id);
    if (a.run.testNodeOnly) {
      if (a.inFlight.size === 0) void finalize(a);
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
    for (const id of readiness.ready) if (isPending(a, id)) startBlock(a, id);
    if (a.inFlight.size === 0) {
      void finalize(a);
      return;
    }
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
      const targets = new Set(a.def.edges.filter((edge) => a.nodes.has(edge.source)).map((edge) => edge.target));
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
    if (node?.type === "trigger.git" && node.config.repo.kind === "project" && payload.sha) return payload.sha;
    return undefined;
  };

  const prepareProject = async (a: ActiveRun): Promise<void> => {
    const projects = opts.services.projects;
    if (a.run.projectPath !== undefined) {
      const resolved = await projects.resolveExisting(a.run.projectPath).catch(() => null);
      if (!resolved) {
        failRun(a, { status: "failed", error: `The project ${a.run.projectPath} no longer exists.` });
        return;
      }
      a.project = { ...resolved, temp: a.run.tempProject !== undefined };
      return;
    }
    const target = a.def.project;
    if (target.kind === "existing") {
      const resolved = await projects.resolveExisting(target.projectPath).catch(() => null);
      if (!resolved) {
        failRun(a, { status: "failed", error: `The project ${target.projectPath} does not exist (project_missing).` });
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
    let created: ProjectContext;
    try {
      created = await projects.createTemp({ workspace: target.workspace, name, source });
    } catch (error) {
      failRun(a, { status: "failed", error: `Could not create the temporary project: ${a.redactor.text(errorMessage(error))}` });
      return;
    }
    if (!alive(a) || a.ending !== null) {
      // The run ended while the project was being made: nothing will use it.
      if (!stopped) await projects.deleteProject(created.path).catch(() => undefined);
      return;
    }
    a.project = { ...created, temp: true };
    a.run.projectPath = created.path;
    a.run.tempProject = { path: created.path, deleted: false };
    markDirty(a);
    await save(a);
  };

  const armRunTimeout = (a: ActiveRun): void => {
    const minutes = a.def.settings.runTimeoutMinutes;
    if (typeof minutes !== "number" || !(minutes > 0)) return;
    const startedAt = Date.parse(a.run.startedAt ?? a.run.queuedAt);
    const deadline = new Date(startedAt + minutes * 60_000);
    void sleepUntil(clock, deadline, a.lifetime.signal).then((reached) => {
      if (!reached || !alive(a) || a.ending !== null) return;
      failRun(a, { status: "failed", error: `The run timed out after ${minutes} minute${minutes === 1 ? "" : "s"}.` });
      step(a);
    });
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

    // The final output: the Stop's value, else the last succeeded block's in topological order.
    let finalNodeId = a.ending?.finalOutputNodeId;
    if (finalNodeId === undefined && status === "succeeded") {
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
    delete a.run.current;
    delete a.run.queuedFor;
    a.summaryDirty = true;

    // Temporary project: gone on success; kept `keepFailedTempDays` otherwise (§5.10).
    const temp = a.run.tempProject;
    if (temp && !temp.deleted) {
      const keepDays = a.def.settings.keepFailedTempDays ?? 3;
      if (status === "succeeded" || status === "stopped" || keepDays <= 0) {
        try {
          await opts.services.projects.deleteProject(temp.path);
          temp.deleted = true;
          delete temp.deleteAfter;
        } catch (error) {
          logger.warn("workflow temp project delete failed", { runId: a.run.id, path: temp.path, error: errorMessage(error) });
          temp.deleteAfter = nowIso();
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
      appendEvent(a, { type: "run.started" });
      markDirty(a);
      void save(a);
      emitUpserted(a.run.workflowId);
    }
    void startWalk(a, resuming);
  };

  const pump = (): void => {
    if (stopped) return;
    const queued = [...active.values()]
      .filter((a) => a.phase === "queued" && !a.finished)
      .sort((x, y) => (x.run.queuedAt < y.run.queuedAt ? -1 : x.run.queuedAt > y.run.queuedAt ? 1 : x.run.id < y.run.id ? -1 : 1));
    let running = [...active.values()].filter((a) => a.phase !== "queued" && !a.finished && a.run.depth === 0).length;
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

  const newActive = (run: PersistedRun, secrets: Record<string, string>): ActiveRun => {
    const def = run.definition;
    const order = topologicalOrder(def) ?? executableNodes(def).map((node) => node.id);
    return {
      run,
      def,
      nodes: new Map(executableNodes(def).map((node) => [node.id, node])),
      order,
      outputs: new Map(),
      secrets,
      redactor: createRedactor(secrets),
      abort: new AbortController(),
      lifetime: new AbortController(),
      slots: new Map(),
      inFlight: new Set(),
      forced: new Set(),
      project: null,
      phase: "queued",
      ending: null,
      finished: false,
      waiters: [],
      dirty: new Set(),
      summaryDirty: false,
      edgesDirty: false,
      lastPublishAt: Number.NEGATIVE_INFINITY,
      publishTimer: null,
      publishQueued: false,
      saving: null,
      saveRequested: false,
      noPersist: false,
      children: new Set(),
      graceArmed: false
    };
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
      blocks: {},
      takenEdges: [],
      deadEdges: [],
      depth: spec.depth
    };
    if (spec.parentRunId !== undefined) run.parentRunId = spec.parentRunId;
    if (spec.retryOf !== undefined) run.retryOf = spec.retryOf;
    if (spec.fromNodeId !== undefined) run.fromNodeId = spec.fromNodeId;
    if (spec.testNodeOnly) run.testNodeOnly = true;
    if (spec.usePinned) run.usePinned = true;
    return run;
  };

  const recordStub = async (
    workflow: Workflow,
    spec: RunSpec,
    status: "skipped" | "failed",
    detail: { skipReason?: "overlap" | "missed"; error?: string },
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
        const preds = workflow.edges.filter((edge) => edge.target === id && byId.has(edge.source)).map((edge) => edge.source);
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
      const wanted = order.filter((id) => !executed.has(id));
      // "Run from here" of a given run: the upstream outputs are that run's, as they were.
      const pinned = spec.retryOf !== undefined ? {} : (workflow.pinned ?? {});
      const fromRuns: string[] = [];
      for (const id of wanted) {
        const node = byId.get(id)!;
        if (Object.prototype.hasOwnProperty.call(pinned, id) && outputHandles(node).includes("success")) {
          const prepared = await prepareOutput(runId, id, 1, pinned[id], redactor);
          if (!("error" in prepared)) {
            seeds.set(id, { ...prepared, status: "succeeded", handle: "success", attempt: 0, pinned: true });
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
    const mine = [...active.values()].filter((a) => !a.finished && a.run.workflowId === workflow.id);
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

  const launch = async (workflow: Workflow, spec: RunSpec): Promise<{ response: RunWorkflowResponse; run?: ActiveRun }> => {
    if (stopped || stopping) throw new WorkflowEngineError(503, "ENGINE_UNAVAILABLE", "The workflow engine is stopping.");
    const runId = opts.mintId();
    const secrets = opts.secrets.resolve(workflow.id);
    const redactor = createRedactor(secrets);
    const seeds =
      (spec.retryOf !== undefined || spec.fromNodeId !== undefined) && !spec.freshRetry
        ? await buildSeeds(workflow, spec, runId, redactor)
        : new Map<string, Seed>();

    // From here to `active.set` nothing awaits: the overlap decision and the registration are atomic.
    let queuedFor: "overlap" | undefined;
    if (!spec.force && spec.depth === 0) {
      const decision = overlapDecision(workflow);
      if (decision === "skip") {
        await recordStub(workflow, spec, "skipped", { skipReason: "overlap" }, runId);
        return { response: { runId: null, skipped: "overlap" } };
      }
      if (decision === "queue") queuedFor = "overlap";
    }
    const now = nowIso();
    const run = baseRun(workflow, runId, spec, now, redactor);
    if (queuedFor !== undefined) run.queuedFor = queuedFor;
    const a = newActive(run, secrets);
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
    active.set(runId, a);
    try {
      await runStore.create(structuredClone(run));
    } catch (error) {
      active.delete(runId);
      throw new WorkflowEngineError(503, "WORKFLOWS_UNAVAILABLE", `Could not record the run: ${errorMessage(error)}`);
    }
    emit("workflowRun.started", { run: toRunSummary(run) });
    emitUpserted(workflow.id);
    pump();
    return { response: { runId }, run: a };
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
    const workflow = store.get(input.workflowId);
    if (!workflow) throw new WorkflowEngineError(404, "WORKFLOW_NOT_FOUND", `No workflow with id "${input.workflowId}".`);
    const problems = validationErrors(workflow);
    if (problems) {
      throw new WorkflowEngineError(400, "INVALID_WORKFLOW", `The sub-workflow "${workflow.name}" has errors: ${problems[0]!.message}`, problems);
    }
    const launched = await launch(workflow, {
      trigger: { kind: "subworkflow", text: parent ? `From ${parent.run.workflowName}` : undefined },
      payload: { kind: "subworkflow", input: input.input, parentRunId: input.parentRunId, parentNodeId: input.parentNodeId },
      test: parent?.run.test ?? false,
      force: true,
      depth,
      parentRunId: input.parentRunId
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
        if (!run.definition || !Array.isArray(run.definition.nodes) || typeof run.blocks !== "object") throw new Error("malformed run");
        a = newActive(run, opts.secrets.resolve(run.workflowId));
      } catch (error) {
        logger.warn("workflow run cannot be resumed", { runId: run.id, error: errorMessage(error) });
        run.status = "interrupted";
        run.endedAt = nowIso();
        run.error = "The run's saved state could not be read.";
        await runStore.save(run).catch(() => undefined);
        continue;
      }
      // Blocks a newer definition shape may lack: make sure every executable node has a state.
      for (const node of executableNodes(a.def)) {
        a.run.blocks[node.id] ??= { nodeId: node.id, name: node.name, type: node.type, status: "pending", attempt: 0 };
      }
      for (const [id, block] of Object.entries(a.run.blocks)) {
        if (block.status === "succeeded" || block.status === "failed") {
          const whole = await readWholeOutput(block);
          if (whole !== undefined) a.outputs.set(id, whole);
        }
      }
      active.set(run.id, a);
      if (run.status === "running") toWalk.push(a);
    }
    // Parents know their children (a child names its parent).
    for (const a of active.values()) {
      if (a.run.parentRunId !== undefined) active.get(a.run.parentRunId)?.children.add(a.run.id);
    }
    for (const a of toWalk) begin(a, true);
    pump();
  };

  // -------------------------------------------------------------------------
  // The public surface
  // -------------------------------------------------------------------------

  const engine: WorkflowRuntimeEngine = {
    async run(workflowId: string, request: RunWorkflowRequest): Promise<RunWorkflowResponse> {
      const workflow = store.get(workflowId);
      if (!workflow) throw new WorkflowEngineError(404, "WORKFLOW_NOT_FOUND", `No workflow with id "${workflowId}".`);
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
      const spec: RunSpec = {
        trigger: triggerNodeId !== undefined ? { kind, nodeId: triggerNodeId } : { kind },
        payload,
        test,
        force: request.force === true,
        depth: 0
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
      return (
        await launch(workflow, {
          trigger: manual !== undefined ? { kind: "test", nodeId: manual } : { kind: "test" },
          payload: { kind: "manual", input: null },
          test: true,
          force: true,
          depth: 0,
          fromNodeId: nodeId,
          testNodeOnly: true,
          usePinned: true
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
      const dir = await runStore.attemptDir(runId, nodeId, block.attempt);
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
        depth: 0
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
      const spec: RunSpec = { trigger: { kind: request.kind }, payload: request.payload, test: false, force: false, depth: 0 };
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

    activeRunIds: () => [...active.keys()]
  };
  return engine;
}
