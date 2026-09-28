// Automated workflows — the agent block (spec §5.1–§5.5, §5.8).
//
// One block = one resumable state machine. Every phase that has a side effect persists its
// `WaitingOn {kind:"agent", …}` FIRST — the command id minted and written before its POST — so a
// daemon restart at any point re-enters the right phase with the same ids (the host's receipts
// dedupe a re-posted command) and the same baseline.
//
// Phases (`WaitingOn.phase`, `AgentPhase`):
//   selecting     choose the first candidate (§5.2) and render the prompt; no side effect yet
//   creating      POST /api/sessions for `next` (idempotent through the session's `owner`)
//   sending       POST …/turn {commandId, input, interactionMode:"default"} (baseline persisted with it)
//   watching      the unattended watcher (§5.5) from the persisted baseline
//   answering     POST …/answer | …/approval for an open request, then back to watching
//   interrupting  POST …/interrupt {commandId} (no turnId), for a failover or a timeout
//   waiting-idle  until the session is idle (no turn, request, queued turn or background work)
//   failing-over  pick the next candidate (§5.4): same entry → switching; else handing-off
//   switching     POST …/account {commandId, accountId}, then the continue message
//   handing-off   build the handoff prompt (last messages + git status), then creating
//   waiting-reset every candidate is burnt and `whenAllBurnt` waits: until the earliest reset
//   output        read the final answer (before anything could close the tab) and finish
//
// The invariant (§5.4): a usage limit or an auth failure never fails the block while an eligible
// candidate remains in its chain.

import {
  WORKFLOW_LIMITS,
  type SessionSummary,
  type AccountSelectionDecision,
  type AgentChainEntry,
  type AgentHop,
  type WorkflowBlockError,
  type WorkflowBlockErrorKind,
  type WorkflowSessionOwner
} from "@orquester/api";
import {
  buildPlanImplementationPrompt,
  reEmittedAssistantCopies,
  repairsReEmittedAssistantCopies,
  SETTLED_TURN_STATES,
  type ActivityFailureReason,
  type ThreadSnapshotPayload
} from "@orquester/api/agent-chat";
import type { AccountPolicy } from "@orquester/config";
import {
  assistantTextForTurn,
  listSessions,
  readThread,
  sendCommand,
  ToolError,
  type DaemonApi
} from "../../chat-client/index.ts";
import type {
  AccountsReader,
  Clock,
  CooldownStore,
  MintId,
  NodeExecutionContext,
  NodeExecutor,
  NodeResult,
  PromptRenderer,
  UsageReader,
  WaitingOn,
  WorkflowLogger
} from "../contracts.ts";
import { parseBaseline, takeBaseline, type AgentBaseline } from "./classify.ts";
import { AgentCatalog, buildCreateBody, createSession, findOwnedSession, sessionTitle } from "./create.ts";
import {
  candidateKey,
  coolDown,
  describeHops,
  emptyMemory,
  hopCapReached,
  isAccountful,
  pickCandidate,
  resetWaitUntil,
  type AgentCandidate,
  type FailoverDeps,
  type FailoverMemory
} from "./failover.ts";
import { cooldownFamilyOf, defaultUsesAccount, type UsesAccount } from "./families.ts";
import {
  buildHandoffPrompt,
  clipUtf8,
  continueMessage,
  promptSource,
  renderExpressions,
  renderVariables,
  withAutonomyNote
} from "./prompt.ts";
import { describeSkips } from "./select.ts";
import { autonomousAnswers, autonomousDecision, DEFAULT_WATCH_TIMINGS, observe, waitForIdle, watchAgent, type WatchTimings } from "./watch.ts";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** The agent block's output (spec §3.2). */
export interface AgentBlockOutput {
  /** The parent's final assistant text of the latest settled turn, ≤ `WORKFLOW_LIMITS.maxAgentTextBytes`. */
  text: string;
  sessionId: string;
  agent: string;
  model: string;
  accountId: string;
  durationMs: number;
  hops: AgentHop[];
  /** Set only when `text` was cut at the cap. */
  textTruncated?: true;
}

export type AgentPhase =
  | "selecting"
  | "creating"
  | "sending"
  | "watching"
  | "answering"
  | "interrupting"
  | "waiting-idle"
  | "failing-over"
  | "switching"
  | "handing-off"
  | "waiting-reset"
  | "output";

export const AGENT_PHASES: readonly AgentPhase[] = [
  "selecting",
  "creating",
  "sending",
  "watching",
  "answering",
  "interrupting",
  "waiting-idle",
  "failing-over",
  "switching",
  "handing-off",
  "waiting-reset",
  "output"
];

export interface AgentTimings extends WatchTimings {
  /** How long to wait for a session to go idle after an interrupt (then once more, then hand off). */
  idleWaitMs: number;
  /** The pause before retrying a daemon call that answered HOST_UNAVAILABLE. */
  retryMs: number;
}

export const DEFAULT_AGENT_TIMINGS: AgentTimings = { ...DEFAULT_WATCH_TIMINGS, idleWaitMs: 120_000, retryMs: 5_000 };

/** A plan card is implemented at most this many times per block; after that the plan is the answer. */
export const MAX_PLAN_IMPLEMENTATIONS = 5;

export interface AgentExecutorDeps {
  usage: UsageReader;
  accounts: AccountsReader;
  cooldowns: CooldownStore;
  /** claudex router / xAI models run without an account (`createUsesAccount`). */
  usesAccount?: UsesAccount;
  prompts: PromptRenderer;
  clock: Clock;
  mintId: MintId;
  logger: WorkflowLogger;
  timings?: Partial<AgentTimings>;
}

/** Everything the block persists in `WaitingOn.state` (§5.8). */
export interface AgentBlockState {
  v: 1;
  phase: AgentPhase;
  startedAt: string;
  /** Wall clock: `maxMinutes` from the start, pushed out by every wait for a reset. */
  deadlineAt: string;
  /** The prompt after `{{…}}` (before `{variables}`). */
  template?: string;
  /** The original rendered prompt, without the autonomy note. */
  prompt?: string;
  warnings: string[];
  /** The chain failover walks: the block's own, or — continuing a session — the creating block's. */
  chain: AgentChainEntry[];
  current?: AgentCandidate;
  next?: AgentCandidate;
  hopVia?: AgentHop["via"];
  sessionId?: string;
  /** The latest turn of the session when this block first sent into it (the output never reads before it). */
  sessionStartTurnId?: string | null;
  knownSessionIds: string[];
  creatingSince?: string;
  pendingInput?: string;
  command?: Extract<WaitingOn, { kind: "agent" }>["command"];
  commandId?: string;
  commandBody?: Record<string, unknown>;
  baseline?: AgentBaseline;
  answered: string[];
  plansImplemented: number;
  memory: FailoverMemory;
  hops: AgentHop[];
  selection?: AccountSelectionDecision;
  interruptFor?: "failover" | "timeout";
  idleSince?: string;
  idleAttempts: number;
  switchRetries: number;
  switchRefused: boolean;
  afterReset: boolean;
  firstWaitAt?: string;
  waitStartedAt?: string;
  waitUntil?: string;
}

export function createAgentExecutor(deps: AgentExecutorDeps): NodeExecutor<"agent"> {
  return {
    type: "agent",
    async execute(ctx) {
      const timings = { ...DEFAULT_AGENT_TIMINGS, ...deps.timings };
      let state: AgentBlockState;
      if (ctx.resumeFrom) {
        const parsed = parseState(ctx.resumeFrom);
        if (!parsed) {
          await ctx.setWaitingOn(undefined);
          return { status: "failed", error: { kind: "interrupted", message: "The agent block's saved state could not be read after a restart." } };
        }
        state = parsed;
      } else {
        state = initialState(ctx, deps.clock.now());
      }
      return new AgentBlockRun(deps, timings, ctx, state).run();
    }
  };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

function initialState(ctx: NodeExecutionContext<"agent">, now: Date): AgentBlockState {
  const maxMinutes = Math.min(ctx.node.config.maxMinutes, WORKFLOW_LIMITS.agentMaxMinutes.max);
  return {
    v: 1,
    phase: "selecting",
    startedAt: now.toISOString(),
    deadlineAt: new Date(now.getTime() + maxMinutes * 60_000).toISOString(),
    warnings: [],
    chain: ctx.node.config.chain,
    knownSessionIds: [],
    answered: [],
    plansImplemented: 0,
    memory: emptyMemory(),
    hops: [],
    idleAttempts: 0,
    switchRetries: 0,
    switchRefused: false,
    afterReset: false
  };
}

/** The persisted state of a `WaitingOn`, or null when it is not one this version wrote. */
export function parseState(waitingOn: WaitingOn): AgentBlockState | null {
  if (waitingOn.kind !== "agent") return null;
  const raw = waitingOn.state as Partial<AgentBlockState> | undefined;
  if (!raw || raw.v !== 1 || !AGENT_PHASES.includes(raw.phase as AgentPhase)) return null;
  if (typeof raw.startedAt !== "string" || typeof raw.deadlineAt !== "string" || !Array.isArray(raw.chain)) return null;
  const state = structuredClone(raw) as AgentBlockState;
  state.warnings ??= [];
  state.knownSessionIds ??= [];
  state.answered ??= [];
  state.plansImplemented ??= 0;
  state.memory ??= emptyMemory();
  state.hops ??= [];
  state.idleAttempts ??= 0;
  state.switchRetries ??= 0;
  state.switchRefused ??= false;
  state.afterReset ??= false;
  if (raw.baseline !== undefined) {
    const baseline = parseBaseline(raw.baseline);
    if (!baseline) return null;
    state.baseline = baseline;
  }
  return state;
}

class Cancelled extends Error {}
class DeadlinePassed extends Error {}

const DEFAULT_POLICY: AccountPolicy = {
  strategy: "least-used",
  includeSystem: false,
  soonestResetWindow: "weekly",
  leastUsedMetric: "max",
  unknownUsage: "last"
};

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

class AgentBlockRun {
  private readonly api: DaemonApi;
  private readonly catalog: AgentCatalog;
  private readonly usesAccount: UsesAccount;
  private readonly failoverDeps: FailoverDeps;

  constructor(
    private readonly deps: AgentExecutorDeps,
    private readonly timings: AgentTimings,
    private readonly ctx: NodeExecutionContext<"agent">,
    private readonly st: AgentBlockState
  ) {
    this.api = ctx.services.chat.api;
    this.catalog = new AgentCatalog(this.api);
    this.usesAccount = deps.usesAccount ?? defaultUsesAccount;
    this.failoverDeps = { usage: deps.usage, accounts: deps.accounts, cooldowns: deps.cooldowns, usesAccount: this.usesAccount, clock: deps.clock };
  }

  private get config() {
    return this.ctx.node.config;
  }

  private now(): Date {
    return this.deps.clock.now();
  }

  async run(): Promise<NodeResult> {
    if (!this.ctx.resumeFrom) await this.persist();
    else this.publishLive();
    for (;;) {
      try {
        for (;;) {
          if (this.ctx.signal.aborted) return await this.cancelled();
          if (this.deadlineApplies() && this.now().getTime() >= Date.parse(this.st.deadlineAt)) {
            const timedOut = await this.onDeadline();
            if (timedOut) return timedOut;
            continue;
          }
          const result = await this.step();
          if (result) return result;
        }
      } catch (error) {
        if (error instanceof Cancelled) return this.cancelled();
        if (!(error instanceof DeadlinePassed)) throw error;
        const timedOut = await this.onDeadline();
        if (timedOut) return timedOut;
      }
    }
  }

  private deadlineApplies(): boolean {
    const phase = this.st.phase;
    if (phase === "waiting-reset" || phase === "output") return false;
    return !(phase === "interrupting" && this.st.interruptFor === "timeout");
  }

  /** `maxMinutes` ran out: interrupt the work (persisted first), else fail at once. */
  private async onDeadline(): Promise<NodeResult | null> {
    if (!this.st.sessionId) return this.timeoutResult();
    this.enterInterrupting("timeout");
    await this.persist();
    return null;
  }

  private async step(): Promise<NodeResult | null> {
    switch (this.st.phase) {
      case "selecting":
        return this.selecting();
      case "creating":
        return this.creating();
      case "sending":
        return this.sending();
      case "watching":
        return this.watching();
      case "answering":
        return this.answering();
      case "interrupting":
        return this.interrupting();
      case "waiting-idle":
        return this.waitingIdle();
      case "failing-over":
        return this.failingOver();
      case "switching":
        return this.switching();
      case "handing-off":
        return this.handingOff();
      case "waiting-reset":
        return this.waitingReset();
      case "output":
        return this.output();
    }
  }

  // --- phases -------------------------------------------------------------------

  private async selecting(): Promise<NodeResult | null> {
    if (this.config.session.kind === "continue") return this.startContinue(this.config.session.fromNode);
    const refused = this.renderTemplate();
    if (refused) return this.fail("validation", refused);
    this.catalog.invalidate();
    const pick = await this.transient(() => pickCandidate(this.failoverDeps, this.st.chain, this.st.memory, 0, (c) => this.catalog.check(c)));
    this.recordSelection(pick.decision);
    if (pick.kind === "none") return this.exhausted(pick.decision);
    const c = pick.candidate;
    if (this.st.prompt === undefined) {
      const labels = await this.catalog.labels(c.agent, c.model);
      const vars = await renderVariables(this.st.template!, {
        prompts: this.deps.prompts,
        projectPath: this.ctx.project.path,
        timeZone: this.ctx.workflow.settings.timezone,
        ...labels
      });
      if (!vars.ok) return this.fail("expression", `The prompt's variables could not be rendered: ${vars.message}`);
      this.st.prompt = vars.text;
    }
    this.st.next = c;
    this.st.pendingInput = withAutonomyNote(this.st.prompt, this.config.autonomyNote);
    this.st.hopVia = "initial";
    this.st.creatingSince = this.now().toISOString();
    this.st.phase = "creating";
    await this.persist();
    return null;
  }

  /** `session.kind: "continue"`: a follow-up turn into the session an upstream block created. */
  private async startContinue(fromNode: string): Promise<NodeResult | null> {
    const upstream = this.ctx.expressionContext().nodes[fromNode];
    const out = upstream?.output as Partial<AgentBlockOutput> | undefined;
    if (!out || typeof out.sessionId !== "string" || !out.sessionId) {
      return this.fail("validation", `"${fromNode}" has no agent session to continue (it did not succeed in this run).`);
    }
    const sessionId = out.sessionId;
    const creating = this.ctx.workflow.nodes.find((n) => n.type === "agent" && n.name === fromNode);
    let chain: AgentChainEntry[] = creating?.type === "agent" ? creating.config.chain : this.config.chain;
    const summary = (await this.transient(() => listSessions(this.api))).find((s) => s.id === sessionId);
    if (!summary) return this.fail("agent_error", `The session "${fromNode}" created was closed.`);
    const snap = await this.transient(() => readThread(this.api, sessionId));
    const agent = summary.refId;
    const model = snap.head.modelSelection.model;
    const options = snap.head.modelSelection.options ?? [];
    const accountId = summary.accountId || snap.head.accountId || "system";
    let chainIndex = chain.findIndex((e) => e.agent === agent && e.model === model);
    if (chainIndex === -1) chainIndex = chain.findIndex((e) => e.agent === agent);
    if (chainIndex === -1) {
      chain = [{ agent, model, options, accounts: DEFAULT_POLICY }, ...chain];
      chainIndex = 0;
    }
    const label = this.deps.accounts.list().accounts.find((a) => a.id === accountId)?.label;
    const current: AgentCandidate = {
      chainIndex,
      agent,
      model,
      options,
      accountId,
      ...(label ? { accountLabel: label } : accountId === "system" ? { accountLabel: "System" } : {}),
      family: cooldownFamilyOf(agent, model, this.usesAccount)
    };
    this.st.chain = chain;
    const refused = this.renderTemplate();
    if (refused) return this.fail("validation", refused);
    if (this.st.prompt === undefined) {
      const labels = await this.catalog.labels(agent, model);
      const vars = await renderVariables(this.st.template!, { prompts: this.deps.prompts, projectPath: this.ctx.project.path, timeZone: this.ctx.workflow.settings.timezone, ...labels });
      if (!vars.ok) return this.fail("expression", `The prompt's variables could not be rendered: ${vars.message}`);
      this.st.prompt = vars.text;
    }
    this.st.current = current;
    this.st.sessionId = sessionId;
    if (!this.st.knownSessionIds.includes(sessionId)) this.st.knownSessionIds.push(sessionId);
    this.st.sessionStartTurnId = snap.turns.at(-1)?.turnId ?? null;
    this.recordSelection({
      chosen: { agent, model, ...(options.length ? { options } : {}), accountId, ...(current.accountLabel ? { accountLabel: current.accountLabel } : {}), chainIndex },
      reason: `Continues the session "${fromNode}" created (${agent}/${current.accountLabel ?? accountId}).`,
      skipped: []
    });
    this.pushHop(current, sessionId, "initial");
    this.ctx.update({ sessionId, hops: this.hopsCopy() });
    return this.enterSending(withAutonomyNote(this.st.prompt, this.config.autonomyNote));
  }

  private async creating(): Promise<NodeResult | null> {
    const c = this.st.next;
    if (!c || this.st.pendingInput === undefined) return this.fail("internal", "The agent block lost its next candidate.");
    const owner: WorkflowSessionOwner = { kind: "workflow", workflowId: this.ctx.workflow.id, runId: this.ctx.runId, nodeId: this.ctx.node.id };
    const since = this.st.creatingSince ?? this.st.startedAt;
    const title = sessionTitle(this.ctx.workflow.name, this.ctx.node.name, this.config.session.kind === "new" ? this.config.session.title : undefined);
    const body = buildCreateBody({ candidate: c, projectPath: this.ctx.project.path, title, owner });
    let summary: SessionSummary | null = null;
    while (!summary) {
      // A create whose answer was lost (a restart, a dropped response) left its session behind: adopt it.
      summary = await this.transient(() => findOwnedSession(this.api, owner, since, this.st.knownSessionIds));
      if (summary) break;
      try {
        summary = await createSession(this.api, body);
      } catch (error) {
        if (!(error instanceof ToolError)) throw error;
        if (error.code === "HOST_UNAVAILABLE") {
          await this.pause();
          continue;
        }
        // The daemon refused this launch (a gate, a missing account): the candidate is unusable.
        this.st.memory.unusable.push(candidateKey(c));
        this.st.memory.extraSkips.push({ agent: c.agent, accountId: c.accountId, ...(c.accountLabel ? { label: c.accountLabel } : {}), why: "unavailable", detail: `the session could not be created: ${error.message}` });
        this.st.next = undefined;
        this.st.phase = this.st.current ? "failing-over" : "selecting";
        await this.persist();
        return null;
      }
    }
    const sessionId = summary.id;
    this.st.sessionId = sessionId;
    if (!this.st.knownSessionIds.includes(sessionId)) this.st.knownSessionIds.push(sessionId);
    this.st.current = c;
    this.st.next = undefined;
    this.st.switchRefused = false;
    this.st.switchRetries = 0;
    this.st.idleAttempts = 0;
    this.st.afterReset = false;
    this.st.sessionStartTurnId = null;
    this.pushHop(c, sessionId, this.st.hopVia ?? "initial");
    this.ctx.update({ sessionId, hops: this.hopsCopy() });
    return this.enterSending(this.st.pendingInput);
  }

  /** Take the baseline, mint the turn's command id, persist — then `sending` posts it. */
  private async enterSending(input: string): Promise<NodeResult | null> {
    const sessionId = this.st.sessionId!;
    const obs = await this.readSession(sessionId);
    if (!obs) return this.fail("agent_error", "The agent's session was closed.");
    this.st.baseline = takeBaseline(obs.summary, obs.snapshot, this.now());
    this.st.pendingInput = input;
    this.st.command = "turn";
    this.st.commandId = this.deps.mintId();
    this.st.commandBody = { input, interactionMode: "default" };
    this.st.phase = "sending";
    await this.persist();
    return null;
  }

  private async sending(): Promise<NodeResult | null> {
    try {
      await this.post("turn");
    } catch (error) {
      if (!(error instanceof ToolError)) throw error;
      return this.fail("agent_error", `The message could not be sent: ${error.message}`);
    }
    this.st.phase = "watching";
    await this.persist();
    return null;
  }

  private async watching(): Promise<NodeResult | null> {
    const sessionId = this.st.sessionId!;
    const outcome = await watchAgent({
      api: this.api,
      sessionId,
      baseline: this.st.baseline!,
      clock: this.deps.clock,
      signal: this.ctx.signal,
      deadlineAt: new Date(this.st.deadlineAt),
      whenOnlyWatchLoopsRemain: this.config.whenOnlyWatchLoopsRemain,
      handled: new Set(this.st.answered),
      timings: this.timings,
      onActivity: (activity) => this.ctx.update({ activity }),
      logger: this.ctx.log
    });
    switch (outcome.kind) {
      case "done":
        this.st.phase = "output";
        await this.persist();
        return null;
      case "failure":
        return this.onAccountFailure(outcome.failure);
      case "question":
        this.st.command = "answer";
        this.st.commandId = this.deps.mintId();
        this.st.commandBody = { requestId: outcome.request.requestId, answers: autonomousAnswers(outcome.request) };
        this.st.phase = "answering";
        await this.persist();
        return null;
      case "approval":
        this.st.command = "approval";
        this.st.commandId = this.deps.mintId();
        this.st.commandBody = { requestId: outcome.request.requestId, decision: autonomousDecision(outcome.request) };
        this.st.phase = "answering";
        await this.persist();
        return null;
      case "plan":
        if (this.st.plansImplemented >= MAX_PLAN_IMPLEMENTATIONS) {
          this.st.phase = "output";
          await this.persist();
          return null;
        }
        this.st.plansImplemented += 1;
        return this.enterSending(withAutonomyNote(buildPlanImplementationPrompt(outcome.markdown), this.config.autonomyNote));
      case "failed":
        return this.fail("agent_error", outcome.message);
      case "closed":
        return this.fail("agent_error", "The agent's session was closed before it finished.");
      case "timeout":
        this.enterInterrupting("timeout");
        await this.persist();
        return null;
      case "cancelled":
        throw new Cancelled();
    }
  }

  private async answering(): Promise<NodeResult | null> {
    const requestId = String(this.st.commandBody?.requestId ?? "");
    try {
      await this.post(this.st.command === "approval" ? "approval" : "answer");
    } catch (error) {
      if (!(error instanceof ToolError)) throw error;
      // The request settled meanwhile (the turn ended, the host closed it): nothing left to answer.
      this.ctx.log.debug("agent block: answer refused", { requestId, code: error.code, message: error.message });
    }
    if (requestId && !this.st.answered.includes(requestId)) this.st.answered.push(requestId);
    this.st.phase = "watching";
    await this.persist();
    return null;
  }

  /** §5.4 step 1: cool the account down, close its hop, and stop its work (persisted first). */
  private async onAccountFailure(failure: ActivityFailureReason): Promise<NodeResult | null> {
    const current = this.st.current!;
    await coolDown(this.failoverDeps, this.st.memory, current, {
      reason: failure.reason,
      ...(failure.resetsAt ? { resetsAt: failure.resetsAt } : {}),
      message: failure.message
    });
    const hop = this.st.hops.at(-1);
    if (hop && !hop.endedAt) {
      hop.endedAt = this.now().toISOString();
      hop.reason = failure.reason;
      if (failure.resetsAt) hop.resetsAt = failure.resetsAt;
    }
    this.ctx.update({ hops: this.hopsCopy(), activity: failure.reason === "auth" ? "Sign-in refused — switching account" : "Usage limit — switching account" });
    this.enterInterrupting("failover");
    await this.persist();
    return null;
  }

  private enterInterrupting(reason: "failover" | "timeout"): void {
    this.st.interruptFor = reason;
    this.st.command = "interrupt";
    this.st.commandId = this.deps.mintId();
    this.st.commandBody = {};
    this.st.phase = "interrupting";
  }

  private async interrupting(): Promise<NodeResult | null> {
    if (this.st.interruptFor === "timeout") {
      try {
        await sendCommand(this.api, this.st.sessionId!, "interrupt", {}, { commandId: this.st.commandId!, retryDelayMs: () => 0 });
      } catch (error) {
        this.ctx.log.warn("agent block: the timeout's interrupt failed", { error: String(error) });
      }
      return this.timeoutResult();
    }
    try {
      await this.post("interrupt");
    } catch (error) {
      if (!(error instanceof ToolError)) throw error;
      // A closed session or a thread with nothing to interrupt: the idle wait decides.
      this.ctx.log.debug("agent block: interrupt refused", { code: error.code, message: error.message });
    }
    this.st.idleSince = this.now().toISOString();
    this.st.phase = "waiting-idle";
    await this.persist();
    return null;
  }

  private async waitingIdle(): Promise<NodeResult | null> {
    const idleUntil = Date.parse(this.st.idleSince ?? this.now().toISOString()) + this.timings.idleWaitMs;
    const until = new Date(Math.min(idleUntil, Date.parse(this.st.deadlineAt)));
    const result = await waitForIdle({ api: this.api, sessionId: this.st.sessionId!, clock: this.deps.clock, signal: this.ctx.signal, until, rereadMs: this.timings.rereadMs, logger: this.ctx.log });
    if (result === "cancelled") throw new Cancelled();
    if (result === "timeout" && this.now().getTime() >= Date.parse(this.st.deadlineAt)) return null; // the deadline takes over
    if (result === "idle") {
      this.st.phase = "failing-over";
    } else if (result === "closed") {
      this.st.switchRefused = true;
      this.st.phase = "failing-over";
    } else if (this.st.idleAttempts < 1) {
      // Still busy: interrupt once more, then wait again.
      this.st.idleAttempts += 1;
      this.enterInterrupting("failover");
    } else {
      // The session will not settle: leave it and hand off to a new one.
      this.st.switchRefused = true;
      this.st.phase = "failing-over";
    }
    await this.persist();
    return null;
  }

  private async failingOver(): Promise<NodeResult | null> {
    const current = this.st.current!;
    if (hopCapReached(this.st.hops)) {
      return this.fail("limit_exceeded", `Gave up after ${WORKFLOW_LIMITS.maxAgentHops} account hops: ${describeHops(this.st.hops)}.`, { hops: this.hopsCopy() });
    }
    const from = this.st.afterReset ? 0 : current.chainIndex;
    this.catalog.invalidate();
    let pick = await this.transient(() => pickCandidate(this.failoverDeps, this.st.chain, this.st.memory, from, (c) => this.catalog.check(c)));
    if (pick.kind === "none" && from > 0) {
      // Nothing from here on: an earlier entry whose cooldown ran out meanwhile still counts, and an
      // exhausted chain reports every entry's skips and its earliest reset.
      pick = await this.transient(() => pickCandidate(this.failoverDeps, this.st.chain, this.st.memory, 0, (c) => this.catalog.check(c)));
    }
    this.recordSelection(pick.decision);
    if (pick.kind === "none") return this.exhausted(pick.decision);
    const c = pick.candidate;
    const sameEntry = this.st.sessionId !== undefined && c.chainIndex === current.chainIndex && c.agent === current.agent && c.model === current.model;
    if (sameEntry && !this.st.switchRefused && c.accountId === current.accountId) {
      // Resumed after a reset on the very account that hit it: the same session goes on.
      this.st.current = c;
      this.st.afterReset = false;
      this.pushHop(c, this.st.sessionId!, "resumed");
      this.ctx.update({ hops: this.hopsCopy() });
      return this.enterSending(continueMessage(this.config.autonomyNote));
    }
    if (sameEntry && !this.st.switchRefused && isAccountful(c, this.usesAccount)) {
      this.st.next = c;
      this.st.command = "account";
      this.st.commandId = this.deps.mintId();
      this.st.commandBody = { accountId: c.accountId };
      this.st.phase = "switching";
      await this.persist();
      return null;
    }
    this.st.next = c;
    this.st.hopVia = this.st.afterReset ? "resumed" : "handoff";
    this.st.phase = "handing-off";
    await this.persist();
    return null;
  }

  private async switching(): Promise<NodeResult | null> {
    const next = this.st.next;
    if (!next) {
      this.st.phase = "failing-over";
      await this.persist();
      return null;
    }
    try {
      await this.post("account");
    } catch (error) {
      if (!(error instanceof ToolError)) throw error;
      if (error.code === "COMMAND_REJECTED" || error.code === "SESSION_BUSY") {
        this.st.next = undefined;
        if (this.st.switchRetries < 1) {
          // Something is still in flight: wait for idle once more, then try again.
          this.st.switchRetries += 1;
          this.st.idleAttempts = 0;
          this.st.idleSince = this.now().toISOString();
          this.st.phase = "waiting-idle";
        } else {
          this.st.switchRefused = true;
          this.st.phase = "failing-over";
        }
        await this.persist();
        return null;
      }
      // The account itself is refused (the family / seed gate): pass over it.
      this.st.memory.unusable.push(candidateKey(next));
      this.st.memory.extraSkips.push({ agent: next.agent, accountId: next.accountId, ...(next.accountLabel ? { label: next.accountLabel } : {}), why: "unavailable", detail: `the account switch was refused: ${error.message}` });
      this.st.next = undefined;
      this.st.phase = "failing-over";
      await this.persist();
      return null;
    }
    this.st.current = next;
    this.st.next = undefined;
    this.pushHop(next, this.st.sessionId!, this.st.afterReset ? "resumed" : "switched");
    this.st.switchRetries = 0;
    this.st.afterReset = false;
    this.ctx.update({ hops: this.hopsCopy() });
    return this.enterSending(continueMessage(this.config.autonomyNote));
  }

  private async handingOff(): Promise<NodeResult | null> {
    const previous = this.st.current!;
    let previousMessages = "";
    if (this.st.sessionId) {
      try {
        const snap = await readThread(this.api, this.st.sessionId);
        previousMessages = parentAssistantText(snap, this.st.sessionStartTurnId ?? null);
      } catch (error) {
        this.ctx.log.debug("agent block: the previous session could not be read for the handoff", { error: String(error) });
      }
    }
    let gitStatus: string | null = null;
    try {
      gitStatus = await this.ctx.services.projects.gitStatusShort(this.ctx.project.path, WORKFLOW_LIMITS.handoffGitStatusBytes);
    } catch (error) {
      this.ctx.log.debug("agent block: git status for the handoff failed", { error: String(error) });
    }
    this.st.pendingInput = buildHandoffPrompt({
      originalPrompt: this.st.prompt ?? "",
      previousAgent: previous.agent,
      previousMessages,
      gitStatus,
      autonomyNote: this.config.autonomyNote
    });
    this.st.creatingSince = this.now().toISOString();
    this.st.phase = "creating";
    await this.persist();
    return null;
  }

  private async waitingReset(): Promise<NodeResult | null> {
    const until = Date.parse(this.st.waitUntil ?? this.now().toISOString());
    this.ctx.update({ waitingUntil: new Date(until).toISOString(), activity: "Every account is burnt — waiting for a reset" });
    await this.sleepUntil(until);
    const started = Date.parse(this.st.waitStartedAt ?? this.now().toISOString());
    const waited = Math.max(0, this.now().getTime() - started);
    // A wait for a reset does not count toward `maxMinutes`.
    this.st.deadlineAt = new Date(Date.parse(this.st.deadlineAt) + waited).toISOString();
    this.st.waitUntil = undefined;
    this.st.waitStartedAt = undefined;
    this.st.afterReset = true;
    this.st.phase = this.st.current ? "failing-over" : "selecting";
    this.ctx.update({ waitingUntil: undefined });
    await this.persist();
    return null;
  }

  private async output(): Promise<NodeResult> {
    const sessionId = this.st.sessionId!;
    const snap = await this.transient(() => readThread(this.api, sessionId), { ignoreDeadline: true });
    const { text, truncated } = finalText(snap, this.st.sessionStartTurnId ?? null);
    const current = this.st.current!;
    this.closeHop();
    const output: AgentBlockOutput = {
      text,
      sessionId,
      agent: current.agent,
      model: current.model,
      accountId: current.accountId,
      durationMs: Math.max(0, this.now().getTime() - Date.parse(this.st.startedAt)),
      hops: this.hopsCopy(),
      ...(truncated ? { textTruncated: true as const } : {})
    };
    this.ctx.update({ hops: output.hops });
    await this.ctx.setWaitingOn(undefined);
    return { status: "succeeded", output, ...(this.st.warnings.length ? { warnings: [...this.st.warnings] } : {}) };
  }

  // --- helpers ------------------------------------------------------------------

  /** `{{…}}` once per block; a missing saved prompt fails it (its message returned). */
  private renderTemplate(): string | null {
    if (this.st.template !== undefined) return null;
    const source = promptSource(this.config, this.deps.prompts);
    if (!source.ok) return source.message;
    const rendered = renderExpressions(source.template, this.ctx);
    this.st.template = rendered.text;
    this.st.warnings.push(...rendered.warnings);
    if (rendered.warnings.length) this.ctx.update({ warnings: [...this.st.warnings] });
    return null;
  }

  /** Every candidate is burnt (§5.4 step 5). */
  private async exhausted(decision: AccountSelectionDecision): Promise<NodeResult | null> {
    const detail = { hops: this.hopsCopy(), skipped: decision.skipped, reason: decision.reason };
    const skips = describeSkips(decision.skipped);
    const message = `Every account of every agent in the chain is burnt.${this.st.hops.length ? ` Hops: ${describeHops(this.st.hops)}.` : ""}${skips ? `\n${skips}` : ""}`;
    const policy = this.config.whenAllBurnt;
    if (policy.kind === "fail") return this.fail("all_burnt", message, detail);
    const now = this.now();
    const firstWaitAt = this.st.firstWaitAt ? new Date(this.st.firstWaitAt) : now;
    const until = resetWaitUntil(decision, { now, firstWaitAt, maxWaitHours: policy.maxWaitHours });
    if (!until) return this.fail("all_burnt", `${message}\nNo account frees up within ${policy.maxWaitHours} h.`, detail);
    this.st.firstWaitAt ??= now.toISOString();
    this.st.waitStartedAt = now.toISOString();
    this.st.waitUntil = until.toISOString();
    this.st.phase = "waiting-reset";
    await this.persist();
    return null;
  }

  private pushHop(c: AgentCandidate, sessionId: string, via: AgentHop["via"]): void {
    this.closeHop();
    this.st.hops.push({
      agent: c.agent,
      model: c.model,
      accountId: c.accountId,
      ...(c.accountLabel ? { accountLabel: c.accountLabel } : {}),
      sessionId,
      startedAt: this.now().toISOString(),
      via
    });
  }

  private closeHop(): void {
    const hop = this.st.hops.at(-1);
    if (hop && !hop.endedAt) hop.endedAt = this.now().toISOString();
  }

  private hopsCopy(): AgentHop[] {
    return this.st.hops.map((h) => ({ ...h }));
  }

  private recordSelection(decision: AccountSelectionDecision): void {
    this.st.selection = decision;
    this.ctx.update({ selection: structuredClone(decision) });
  }

  /** On a resume: the live fields the run view shows, as the state has them. */
  private publishLive(): void {
    this.ctx.update({
      ...(this.st.selection ? { selection: structuredClone(this.st.selection) } : {}),
      ...(this.st.sessionId ? { sessionId: this.st.sessionId } : {}),
      hops: this.hopsCopy(),
      ...(this.st.phase === "waiting-reset" && this.st.waitUntil ? { waitingUntil: this.st.waitUntil } : {})
    });
  }

  private async post(name: "turn" | "interrupt" | "answer" | "approval" | "account"): Promise<void> {
    const sessionId = this.st.sessionId!;
    const commandId = this.st.commandId!;
    const body = this.st.commandBody ?? {};
    await this.transient(() => sendCommand(this.api, sessionId, name, body, { commandId, retryDelayMs: () => 0 }).then(() => undefined));
  }

  /** The session's summary and thread, retried while the host is unavailable; null once it is closed. */
  private async readSession(sessionId: string): Promise<{ summary: SessionSummary; snapshot: ThreadSnapshotPayload } | null> {
    for (;;) {
      const obs = await observe(this.api, sessionId, this.ctx.log);
      if (obs?.gone) return null;
      if (obs?.summary && obs.snapshot) return { summary: obs.summary, snapshot: obs.snapshot };
      await this.pause();
    }
  }

  /**
   * Run `fn` (a read, or a command re-posted under its persisted id), retrying a HOST_UNAVAILABLE —
   * a host restart, a deploy — and an INTERNAL read failure every `retryMs` until the deadline.
   */
  private async transient<T>(fn: () => Promise<T>, opts: { ignoreDeadline?: boolean } = {}): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await fn();
      } catch (error) {
        const transient = error instanceof ToolError ? error.code === "HOST_UNAVAILABLE" || error.code === "INTERNAL" : false;
        if (!transient) throw error;
        if (opts.ignoreDeadline && attempt >= 60) throw error;
        this.ctx.log.debug("agent block: daemon unavailable, retrying", { error: error instanceof Error ? error.message : String(error) });
      }
      await this.pause(opts);
    }
  }

  private async pause(opts: { ignoreDeadline?: boolean } = {}): Promise<void> {
    if (this.ctx.signal.aborted) throw new Cancelled();
    if (!opts.ignoreDeadline && this.deadlineApplies() && this.now().getTime() >= Date.parse(this.st.deadlineAt)) throw new DeadlinePassed();
    await this.sleepUntil(this.now().getTime() + this.timings.retryMs);
  }

  private sleepUntil(at: number): Promise<void> {
    const signal = this.ctx.signal;
    if (signal.aborted) return Promise.reject(new Cancelled());
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        timer.cancel();
        reject(new Cancelled());
      };
      const timer = this.deps.clock.setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, Math.max(0, at - this.now().getTime()));
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async persist(): Promise<void> {
    const st = this.st;
    await this.ctx.setWaitingOn({
      kind: "agent",
      sessionId: st.sessionId ?? "",
      commandId: st.commandId ?? "",
      command: st.command ?? "turn",
      baseline: st.baseline ?? null,
      deadlineAt: st.deadlineAt,
      phase: st.phase,
      state: structuredClone(st) as unknown as Record<string, unknown>
    });
  }

  private timeoutResult(): Promise<NodeResult> {
    return this.fail("timeout", `The agent did not finish within ${this.config.maxMinutes} min.`, { hops: this.hopsCopy() });
  }

  private async fail(kind: WorkflowBlockErrorKind, message: string, detail?: unknown): Promise<NodeResult> {
    this.closeHop();
    if (this.st.hops.length) this.ctx.update({ hops: this.hopsCopy() });
    await this.ctx.setWaitingOn(undefined);
    const error: WorkflowBlockError = { kind, message, ...(detail !== undefined ? { detail } : {}) };
    const output = this.st.sessionId ? { sessionId: this.st.sessionId, hops: this.hopsCopy() } : undefined;
    return { status: "failed", error, ...(output ? { output } : {}) };
  }

  private async cancelled(): Promise<NodeResult> {
    const busy: AgentPhase[] = ["sending", "watching", "answering", "waiting-idle", "switching", "interrupting"];
    if (this.st.sessionId && busy.includes(this.st.phase)) {
      try {
        await sendCommand(this.api, this.st.sessionId, "interrupt", {}, { commandId: this.deps.mintId(), retryDelayMs: () => 0 });
      } catch (error) {
        this.ctx.log.debug("agent block: the cancel's interrupt failed", { error: String(error) });
      }
    }
    this.closeHop();
    try {
      await this.ctx.setWaitingOn(undefined);
    } catch (error) {
      this.ctx.log.debug("agent block: clearing waitingOn on cancel failed", { error: String(error) });
    }
    return { status: "cancelled" };
  }
}

// ---------------------------------------------------------------------------
// Reading what the agent said
// ---------------------------------------------------------------------------

/**
 * §5.1 step 5: the parent's final assistant text of the latest settled turn — re-emitted Claude
 * copies dropped (the MCP's rule), commentary only when it is all there is — uncapped by the MCP's
 * view cap and cut at `maxAgentTextBytes`. A settled turn with no text (a woken turn that only ran
 * tools) falls back to the newest earlier one this block owns; never to a turn from before the block.
 */
export function finalText(snap: ThreadSnapshotPayload, sessionStartTurnId: string | null): { text: string; truncated: boolean } {
  const copies = repairsReEmittedAssistantCopies(snap.head.adapter) ? reEmittedAssistantCopies(snap.items) : undefined;
  for (let i = snap.turns.length - 1; i >= 0; i -= 1) {
    const turn = snap.turns[i]!;
    if (sessionStartTurnId !== null && turn.turnId === sessionStartTurnId) break;
    if (!turn.turnId || !SETTLED_TURN_STATES.has(turn.state)) continue;
    const text = assistantTextForTurn(snap.items, turn.turnId, copies);
    if (text) return clipUtf8(text, WORKFLOW_LIMITS.maxAgentTextBytes);
  }
  return { text: "", truncated: false };
}

/** The parent's assistant messages since the block began in this session, oldest first — for a handoff. */
export function parentAssistantText(snap: ThreadSnapshotPayload, sessionStartTurnId: string | null): string {
  let startAt = 0;
  if (sessionStartTurnId !== null) {
    const idx = snap.items.findIndex((item) => item.turnId === sessionStartTurnId);
    if (idx !== -1) {
      let last = idx;
      for (let i = idx; i < snap.items.length; i += 1) if (snap.items[i]!.turnId === sessionStartTurnId) last = i;
      startAt = last + 1;
    }
  }
  const texts: string[] = [];
  for (let i = startAt; i < snap.items.length; i += 1) {
    const item = snap.items[i]!;
    if (item.kind === "message" && item.role === "assistant" && !item.agentId && item.text.trim()) texts.push(item.text.trim());
  }
  return texts.join("\n\n");
}

export type { AgentCandidate } from "./failover.ts";
export type { AgentBaseline } from "./classify.ts";
