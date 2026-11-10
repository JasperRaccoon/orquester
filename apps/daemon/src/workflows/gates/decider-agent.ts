// Automated workflows — gates (spec 2026-11-10 §6.3): the reviewer agent. It runs on the agent
// block's own machinery — the agent executor, handed a synthetic agent node built from the gate's
// decider (its chain, accounts, Agent Profile, unattended, `maxMinutes` = what is left of the agent
// phase) under the gate's own node id, so its chat's owner names the gate's node. The executor's
// `WaitingOn {kind: "agent"}` is kept inside the gate's (`WaitingOn.agent`), so a restart resumes the
// reviewer exactly like an agent block. The one reminder is a follow-up turn into the same chat
// (`session: continue`, the chat found through the gate's own name in the expression context).

import { agentConfigSchema, type AgentBlockConfig } from "@orquester/config";
import { WORKFLOW_LIMITS, type GateBlockConfig, type WorkflowGateState, type WorkflowNode } from "@orquester/api";

import type { NodeExecutionContext, NodeExecutor, NodeResult, WaitingOn } from "../contracts.ts";
import { reviewerPrompt, reviewerReminder } from "./prompts.ts";

export type AgentResume = Omit<Extract<WaitingOn, { kind: "agent" }>, "kind">;
export type ReviewerDecider = Extract<GateBlockConfig["decider"], { kind: "agent" }>;

/** Thrown into the agent executor once the gate no longer needs it: nothing more is recorded. */
export class GateSettledError extends Error {
  constructor() {
    super("The gate was decided; the reviewer agent's state is no longer recorded.");
    this.name = "GateSettledError";
  }
}

export interface ReviewerRunInput {
  ctx: NodeExecutionContext<"gate">;
  agent: NodeExecutor<"agent">;
  decider: ReviewerDecider;
  gate: WorkflowGateState;
  /** "reminder": the follow-up turn into `sessionId`. */
  mode: "new" | "reminder";
  sessionId?: string;
  /** The agent phase's deadline. */
  deadlineAt: Date;
  resume?: AgentResume;
  /** Aborting interrupts the reviewer's turn (the agent executor's cancel). */
  signal: AbortSignal;
  /** Persist the agent's resume state inside the gate's WaitingOn (undefined clears it). */
  persist(agent: AgentResume | undefined): Promise<void>;
  /** The reviewer's chat changed (created, or a failover's new one): it is the assigned decider now. */
  onSession(sessionId: string): void;
  /** True once the gate no longer waits for the reviewer. */
  settled(): boolean;
}

/** Minutes of the agent phase left, as the reviewer's `maxMinutes` (at least 1). */
function minutesLeft(deadlineAt: Date, now: Date): number {
  const left = Math.ceil((deadlineAt.getTime() - now.getTime()) / 60_000);
  return Math.max(1, Math.min(WORKFLOW_LIMITS.agentMaxMinutes.max, left));
}

/** The synthetic agent node (exported for tests). */
export function reviewerNode(input: Pick<ReviewerRunInput, "ctx" | "decider" | "gate" | "mode" | "deadlineAt">, now: Date): Extract<WorkflowNode, { type: "agent" }> {
  const { ctx, decider, gate, mode } = input;
  const maxMinutes = minutesLeft(input.deadlineAt, now);
  const config: AgentBlockConfig = agentConfigSchema.parse({
    prompt: mode === "new" ? reviewerPrompt(decider, ctx.node.config, gate, ctx.workflow.name, maxMinutes) : reviewerReminder(gate),
    session: mode === "new" ? { kind: "new" } : { kind: "continue", fromNode: ctx.node.name },
    chain: decider.chain,
    ...(decider.profileId !== undefined ? { profileId: decider.profileId } : {}),
    autonomyNote: true,
    whenOnlyWatchLoopsRemain: "finish",
    whenAllBurnt: { kind: "fail" },
    maxMinutes
  });
  return { id: ctx.node.id, name: ctx.node.name, type: "agent", position: ctx.node.position, config } as Extract<WorkflowNode, { type: "agent" }>;
}

/** Run (or resume) the reviewer agent's turn; resolves with the agent executor's result. */
export async function runReviewer(input: ReviewerRunInput): Promise<NodeResult> {
  const { ctx } = input;
  const node = reviewerNode(input, ctx.services.clock.now());
  const sessionId = input.sessionId;
  const expressionContext: NodeExecutionContext["expressionContext"] =
    input.mode === "reminder" && sessionId !== undefined
      ? () => {
          const base = ctx.expressionContext();
          // `session: continue` reads the chat to continue from `nodes.<fromNode>.output.sessionId`.
          return { ...base, nodes: { ...base.nodes, [ctx.node.name]: { output: { sessionId }, status: "succeeded" } } };
        }
      : () => ctx.expressionContext();
  const sub: NodeExecutionContext<"agent"> = {
    runId: ctx.runId,
    workflow: ctx.workflow,
    node,
    attempt: ctx.attempt,
    signal: input.signal,
    project: ctx.project,
    render: (template) => ctx.render(template),
    renderValue: (template) => ctx.renderValue(template),
    expressionContext,
    secrets: ctx.secrets,
    setWaitingOn: async (waitingOn) => {
      if (input.settled()) throw new GateSettledError();
      if (waitingOn === undefined) return input.persist(undefined);
      if (waitingOn.kind !== "agent") throw new Error(`The reviewer agent recorded a "${waitingOn.kind}" wait.`);
      const { kind: _kind, ...rest } = waitingOn;
      return input.persist(rest);
    },
    update: (patch) => {
      if (input.settled()) return;
      if (typeof patch.sessionId === "string" && patch.sessionId.length > 0) input.onSession(patch.sessionId);
      // The gate block shows its reviewer's chat, account selection, hops and activity.
      const { waitingUntil: _until, ...rest } = patch;
      ctx.update(rest);
    },
    attemptDir: () => ctx.attemptDir(),
    timeoutMs: node.config.maxMinutes * 60_000,
    depth: ctx.depth,
    ...(ctx.startedAt !== undefined ? { startedAt: ctx.startedAt } : {}),
    ...(ctx.liveInputs !== undefined ? { liveInputs: () => ctx.liveInputs!() } : {}),
    services: ctx.services,
    log: ctx.log
  };
  if (input.resume !== undefined) sub.resumeFrom = { kind: "agent", ...structuredClone(input.resume) };
  return input.agent.execute(sub);
}
