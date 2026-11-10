// Automated workflows — the Gate block (spec 2026-11-10 §6). It pauses the run for a decision
// between named choices; each choice is an output handle `choice:<id>`.
//
// Opening renders the question and details, stores the gate's record (`PersistedRun.gates`, through
// the engine's gate host) and persists `WaitingOn {kind: "gate"}` in the SAME save — before any push,
// launcher message or reviewer agent. The gate then waits in phases (gates/state.ts): the agent phase
// (a reviewer agent, or the chat that launched the run) bounded by `decider.maxMinutes`; then the
// person phase bounded by `timeout` from its start (else 7 days). Both deadlines are the record's,
// re-armed after a restart. The person may decide in either phase; the first decision wins (the gate
// host persists it before this block finishes). Cancelling the run cancels the gate and interrupts
// its reviewer agent. A gate wait holds no slot and is exempt from the 5-minute default timeout.

import { choiceHandle, WORKFLOW_LIMITS, type GateBlockConfig, type WorkflowGateState } from "@orquester/api";

import { listSessions } from "../../chat-client/index.ts";
import type { NodeExecutionContext, NodeExecutor, NodeResult } from "../contracts.ts";
import { runReviewer, GateSettledError, type ReviewerDecider } from "../gates/decider-agent.ts";
import { deliverToLauncher, type LauncherDelivery } from "../gates/launcher.ts";
import { launcherMessage } from "../gates/prompts.ts";
import {
  agentDeadline,
  choiceViews,
  clipBytes,
  clipChars,
  extrasOf,
  gateOutput,
  isWaiting,
  PERSON_LABEL,
  personDeadline,
  waitingOnFor,
  type GateExtras
} from "../gates/state.ts";
import { EngineStoppedError, sleepUntil } from "../run-context.ts";

export interface GateExecutorOptions {
  /** The agent block's executor: the reviewer agent decider runs on it. Without it, a reviewer gate asks the person. */
  agent?: NodeExecutor<"agent">;
}

export function createGateExecutor(options: GateExecutorOptions = {}): NodeExecutor<"gate"> {
  return {
    type: "gate",
    execute: (ctx) => new GateRun(ctx, options.agent ?? null).run()
  };
}

type TaskOutcome =
  | { kind: "launcher"; delivery: LauncherDelivery }
  | { kind: "reviewer"; result: NodeResult }
  | { kind: "error"; error: unknown };

type RoundOutcome = { kind: "change"; byDecider: boolean } | { kind: "deadline" } | { kind: "aborted" } | { kind: "task"; outcome: TaskOutcome };

function reviewerLabel(decider: ReviewerDecider): string {
  return `Reviewer agent (${decider.chain[0]?.agent ?? "agent"})`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function minutesText(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)} day${minutes === 24 * 60 ? "" : "s"}`;
  if (minutes % 60 === 0) return `${minutes / 60} h`;
  return `${minutes} min`;
}

/** Resolves when `signal` aborts. */
function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** A controller aborted with `parent` (unlinked by the returned dispose). */
function linked(parent: AbortSignal): { controller: AbortController; dispose(): void } {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  if (parent.aborted) controller.abort();
  else parent.addEventListener("abort", onAbort, { once: true });
  return { controller, dispose: () => parent.removeEventListener("abort", onAbort) };
}

class GateRun {
  private gateId = "";
  private extras: GateExtras = {};
  /** The block is done with its gate: a reviewer still running records nothing more. */
  private settled = false;

  constructor(
    private readonly ctx: NodeExecutionContext<"gate">,
    private readonly agent: NodeExecutor<"agent"> | null
  ) {}

  private get host() {
    return this.ctx.services.gates!;
  }

  private get config(): GateBlockConfig {
    return this.ctx.node.config;
  }

  private now(): Date {
    return this.ctx.services.clock.now();
  }

  async run(): Promise<NodeResult> {
    if (!this.ctx.services.gates) {
      return { status: "failed", error: { kind: "internal", message: "Gates are not available on this daemon." } };
    }
    const resume = this.ctx.resumeFrom;
    if (resume?.kind === "gate") {
      this.gateId = resume.gateId;
      this.extras = extrasOf(resume);
      if (!this.host.get(this.ctx.runId, this.gateId)) {
        await this.ctx.setWaitingOn(undefined);
        return { status: "failed", error: { kind: "interrupted", message: "The gate's record could not be read after a restart." } };
      }
      this.ctx.update({ gateId: this.gateId });
    } else {
      await this.open();
    }
    try {
      return await this.loop();
    } finally {
      this.settled = true;
    }
  }

  // --- opening ----------------------------------------------------------------------------------

  private async open(): Promise<void> {
    const { ctx, host } = this;
    const config = this.config;
    const warnings: string[] = [];
    const rendered = ctx.render(config.question).text.trim();
    const question = clipChars(rendered.length > 0 ? rendered : ctx.node.name, WORKFLOW_LIMITS.gateQuestionChars);
    if (rendered.length === 0) warnings.push("The question rendered empty: the gate asks with its name.");
    if (question.clipped) warnings.push(`The question was cut to ${WORKFLOW_LIMITS.gateQuestionChars} characters.`);
    let details: string | undefined;
    if (config.details !== undefined && config.details.trim().length > 0) {
      const text = ctx.render(config.details).text.trim();
      if (text.length > 0) {
        const clipped = clipBytes(text, WORKFLOW_LIMITS.gateDetailsBytes);
        if (clipped.clipped) warnings.push(`The details were cut to ${WORKFLOW_LIMITS.gateDetailsBytes / 1024} KB.`);
        details = clipped.text;
      }
    }
    const now = this.now();
    const decider = config.decider;
    const test = host.isTest(ctx.runId);
    let who: WorkflowGateState["decider"];
    let phase: WorkflowGateState["phase"] = "person";
    if (test) {
      // A test run's gate is the editor's to answer (§7.5): no agent, no launcher, no push.
      who = { kind: decider.kind, label: PERSON_LABEL };
      if (decider.kind !== "human") warnings.push("A test run's gate is answered in the editor: its agent decider is not asked.");
    } else if (decider.kind === "agent") {
      who = { kind: "agent", label: reviewerLabel(decider) };
      if (this.agent) phase = "agent";
      else warnings.push("Agent deciders are not available on this daemon: the person decides.");
    } else if (decider.kind === "launcher") {
      const by = host.startedBy(ctx.runId);
      const chat = by?.kind === "thread" ? await this.launcherChat(by.sessionId) : null;
      if (by?.kind === "thread" && chat !== null) {
        who = { kind: "launcher", label: chat, sessionId: by.sessionId };
        phase = "agent";
      } else {
        who = { kind: "launcher", label: PERSON_LABEL };
        warnings.push(by?.kind === "thread" ? "The chat that started this run is gone: the person decides." : "No chat started this run (run_workflow): the person decides.");
      }
    } else {
      who = { kind: "human", label: PERSON_LABEL };
    }
    const gateId = ctx.services.mintId();
    const deadline = phase === "agent" ? agentDeadline(now, decider.kind === "human" ? undefined : decider.maxMinutes) : personDeadline(now, config.timeout);
    const gate: WorkflowGateState = {
      gateId,
      runId: ctx.runId,
      workflowId: ctx.workflow.id,
      nodeId: ctx.node.id,
      nodeName: ctx.node.name,
      // A loop's later pass asks again with a gate of its own (spec 2026-11-10 §7.2).
      ...(ctx.loop !== undefined ? { pass: ctx.loop.pass } : {}),
      source: "gate",
      question: question.text,
      ...(details !== undefined ? { details } : {}),
      choices: choiceViews(config),
      decider: who,
      phase,
      openedAt: now.toISOString(),
      phaseStartedAt: now.toISOString(),
      phaseDeadlineAt: deadline.toISOString(),
      escalated: false,
      ...(test ? { test: true } : {})
    };
    const root = host.rootRunId(ctx.runId);
    if (root !== ctx.runId) gate.rootRunId = root;
    this.gateId = gateId;
    host.put(ctx.runId, gate);
    ctx.update({ gateId, ...(warnings.length > 0 ? { warnings } : {}) });
    // The record and the wait reach disk together, before anybody is told.
    await ctx.setWaitingOn(waitingOnFor(gate, this.extras));
  }

  /** The launcher chat's label, or null when it is gone. Unreadable: asked anyway (a closed chat escalates). */
  private async launcherChat(sessionId: string): Promise<string | null> {
    try {
      const session = (await listSessions(this.ctx.services.chat.api)).find((candidate) => candidate.id === sessionId);
      if (!session) return null;
      return session.title ? `the launching chat “${session.title}”` : "the launching chat";
    } catch (error) {
      this.ctx.log.debug("gate: the launcher chat could not be looked up", { error: errorText(error) });
      return "the launching chat";
    }
  }

  // --- waiting ----------------------------------------------------------------------------------

  private async loop(): Promise<NodeResult> {
    const { ctx, host } = this;
    for (;;) {
      const gate = host.get(ctx.runId, this.gateId);
      if (!gate) return { status: "failed", error: { kind: "internal", message: "The gate's record is gone." } };
      if (gate.decision !== undefined) {
        this.settled = true;
        return { status: "succeeded", output: gateOutput(gate), handle: choiceHandle(gate.decision.choice) };
      }
      if (gate.expired === true) {
        this.settled = true;
        const span = Date.parse(gate.phaseDeadlineAt ?? "") - Date.parse(gate.phaseStartedAt ?? gate.openedAt);
        return {
          status: "failed",
          error: { kind: "gate_expired", message: `Nobody decided “${gate.question}” within ${Number.isFinite(span) ? minutesText(span) : "the time allowed"}.` }
        };
      }
      if (gate.cancelled === true || ctx.signal.aborted) {
        this.settled = true;
        host.cancel(ctx.runId, this.gateId);
        return { status: "cancelled" };
      }
      if (gate.phase === "agent") await this.agentPhase(gate);
      else await this.personPhase(gate);
    }
  }

  private async personPhase(gate: WorkflowGateState): Promise<void> {
    const { ctx, host } = this;
    const round = linked(ctx.signal);
    try {
      // Listen before the push's save: a decision made meanwhile is never missed.
      const change = this.changeOf(round.controller.signal);
      await host.notifyPerson(ctx.runId, this.gateId);
      const now = host.get(ctx.runId, this.gateId);
      if (!now || !isWaiting(now) || now.phase !== "person") return;
      const outcome = await this.race(gate, round.controller.signal, null, change);
      if (outcome.kind === "deadline") await host.expire(ctx.runId, this.gateId, this.config.timeout?.then ?? { kind: "fail" });
    } finally {
      round.controller.abort();
      round.dispose();
    }
  }

  private async agentPhase(gate: WorkflowGateState): Promise<void> {
    const { ctx, host } = this;
    const work = linked(ctx.signal);
    const round = linked(ctx.signal);
    const detach = { done: false };
    const task: Promise<TaskOutcome> = (gate.decider.kind === "launcher" ? this.launcherTask(gate, work.controller.signal) : this.reviewerTask(gate, work.controller.signal, detach)).catch(
      (error: unknown): TaskOutcome => ({ kind: "error", error })
    );
    /** Stop the decider's work: the reviewer's turn is interrupted (its executor's cancel). */
    const stopWork = async (): Promise<void> => {
      work.controller.abort();
      await task;
    };
    try {
      const outcome = await this.race(gate, round.controller.signal, task);
      switch (outcome.kind) {
        case "aborted":
          await stopWork();
          return;
        case "change":
          if (gate.decider.kind === "agent" && outcome.byDecider) {
            // The reviewer decided or escalated itself: its turn ends on its own — never interrupted.
            detach.done = true;
            work.dispose();
            return;
          }
          await stopWork();
          return;
        case "deadline":
          await stopWork();
          await host.escalate(ctx.runId, this.gateId, `${gate.decider.label} did not decide within ${minutesText(Date.parse(gate.phaseDeadlineAt!) - Date.parse(gate.phaseStartedAt ?? gate.openedAt))}.`, {
            byDecider: false
          });
          return;
        case "task":
          await this.afterTask(gate, outcome.outcome);
          return;
      }
    } finally {
      round.controller.abort();
      round.dispose();
      if (!detach.done) work.dispose();
    }
  }

  /** The decider's work ended before a decision. */
  private async afterTask(gate: WorkflowGateState, outcome: TaskOutcome): Promise<void> {
    const { ctx, host } = this;
    const escalate = (reason: string) => host.escalate(ctx.runId, this.gateId, reason, { byDecider: false });
    if (outcome.kind === "error") {
      if (outcome.error instanceof EngineStoppedError) throw outcome.error;
      if (outcome.error instanceof GateSettledError) return;
      await escalate(`${gate.decider.label} could not be asked: ${errorText(outcome.error)}`);
      return;
    }
    // The gate may have been decided while the work was finishing.
    const now = host.get(ctx.runId, this.gateId);
    if (!now || !isWaiting(now) || now.phase !== "agent") return;
    if (outcome.kind === "launcher") {
      switch (outcome.delivery.kind) {
        case "delivered":
          this.extras = { ...this.extras, launcher: { commandId: this.extras.launcher!.commandId, delivered: true } };
          await this.persistExtras();
          return;
        case "closed":
          await escalate("The launching chat was closed.");
          return;
        case "refused":
          await escalate(`The launching chat refused the message: ${outcome.delivery.message}`);
          return;
        case "timeout":
        case "cancelled":
          // The deadline (or the run's end) is the loop's to act on.
          return;
      }
    }
    const result = outcome.result;
    if (result.status === "succeeded") {
      if ((this.extras.reminders ?? 0) < 1) {
        // One reminder in the same chat (§6.3), persisted before it is sent.
        const { agent: _agent, ...rest } = this.extras;
        this.extras = { ...rest, reminders: 1 };
        await this.persistExtras();
        return;
      }
      await escalate(`${gate.decider.label} ended its turn twice without deciding.`);
      return;
    }
    if (result.status === "failed") {
      await escalate(`${gate.decider.label} failed: ${result.error.message}`);
      return;
    }
    if (result.status === "cancelled" && ctx.signal.aborted) return;
    await escalate(`${gate.decider.label} stopped without deciding.`);
  }

  /** The gate's next change, as a round outcome (register it before any await that could miss one). */
  private changeOf(signal: AbortSignal): Promise<RoundOutcome> {
    return this.host.nextChange(this.ctx.runId, this.gateId, signal).then((change): RoundOutcome => (change ? { kind: "change", byDecider: change.byDecider } : { kind: "aborted" }));
  }

  /** Until the gate changes, its phase deadline passes, the run aborts or the decider's work ends. */
  private race(gate: WorkflowGateState, signal: AbortSignal, task: Promise<TaskOutcome> | null, change: Promise<RoundOutcome> = this.changeOf(signal)): Promise<RoundOutcome> {
    const { ctx } = this;
    const deadline = new Date(gate.phaseDeadlineAt ?? personDeadline(new Date(gate.phaseStartedAt ?? gate.openedAt), this.config.timeout).toISOString());
    const branches: Promise<RoundOutcome>[] = [
      change,
      sleepUntil(ctx.services.clock, deadline, signal).then((reached): RoundOutcome => (reached ? { kind: "deadline" } : { kind: "aborted" }))
    ];
    if (task) branches.push(task.then((outcome): RoundOutcome => ({ kind: "task", outcome })));
    return Promise.race(branches);
  }

  private async persistExtras(): Promise<void> {
    const gate = this.host.get(this.ctx.runId, this.gateId);
    if (!gate) return;
    await this.ctx.setWaitingOn(waitingOnFor(gate, this.extras));
  }

  // --- the deciders' work -----------------------------------------------------------------------

  private async launcherTask(gate: WorkflowGateState, signal: AbortSignal): Promise<TaskOutcome> {
    const { ctx, host } = this;
    if (this.extras.launcher?.delivered === true) {
      // Asked already: wait for the decision, the deadline or the person.
      await untilAborted(signal);
      return { kind: "launcher", delivery: { kind: "cancelled" } };
    }
    if (this.extras.launcher === undefined) {
      // The command id is on disk before the first post: a restart re-posts under it (deduped).
      this.extras = { ...this.extras, launcher: { commandId: ctx.services.mintId() } };
      await this.persistExtras();
    }
    const decider = this.config.decider;
    const maxMinutes = Math.max(1, Math.round((Date.parse(gate.phaseDeadlineAt!) - Date.parse(gate.phaseStartedAt ?? gate.openedAt)) / 60_000));
    const rootRunId = host.rootRunId(ctx.runId);
    const text = launcherMessage(gate, {
      workflowName: ctx.workflow.name,
      rootRunId,
      ...(rootRunId !== ctx.runId ? { rootWorkflowName: host.rootWorkflowName(ctx.runId) ?? ctx.workflow.name } : {}),
      maxMinutes: decider.kind === "launcher" ? Math.min(maxMinutes, decider.maxMinutes) : maxMinutes
    });
    const delivery = await deliverToLauncher({
      api: ctx.services.chat.api,
      sessionId: gate.decider.sessionId!,
      commandId: this.extras.launcher!.commandId,
      text,
      clock: ctx.services.clock,
      signal,
      until: new Date(gate.phaseDeadlineAt!),
      log: ctx.log
    });
    return { kind: "launcher", delivery };
  }

  private async reviewerTask(gate: WorkflowGateState, signal: AbortSignal, detach: { done: boolean }): Promise<TaskOutcome> {
    const { ctx, host } = this;
    const decider = this.config.decider;
    if (decider.kind !== "agent" || !this.agent) return { kind: "error", error: new Error("no reviewer agent is configured") };
    const mode = (this.extras.reminders ?? 0) >= 1 ? "reminder" : "new";
    const sessionId = gate.decider.sessionId;
    if (mode === "reminder" && sessionId === undefined) return { kind: "error", error: new Error("its chat is unknown, so it cannot be reminded") };
    const settled = (): boolean => this.settled || detach.done;
    const result = await runReviewer({
      ctx,
      agent: this.agent,
      decider,
      gate,
      mode,
      ...(sessionId !== undefined ? { sessionId } : {}),
      deadlineAt: new Date(gate.phaseDeadlineAt!),
      ...(this.extras.agent !== undefined ? { resume: this.extras.agent } : {}),
      signal,
      persist: async (agentState) => {
        if (settled()) throw new GateSettledError();
        const { agent: _agent, ...rest } = this.extras;
        this.extras = agentState !== undefined ? { ...rest, agent: agentState } : rest;
        await this.persistExtras();
      },
      onSession: (id) => {
        const current = host.get(ctx.runId, this.gateId);
        if (!current || !isWaiting(current) || current.decider.sessionId === id) return;
        // The chat that may decide is the reviewer's current one (a failover moves it).
        current.decider.sessionId = id;
        host.put(ctx.runId, current);
      },
      settled
    });
    return { kind: "reviewer", result };
  }
}
