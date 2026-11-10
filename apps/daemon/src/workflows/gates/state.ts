// Automated workflows — gates (spec 2026-11-10 §6): the pure rules. A gate's record
// (`WorkflowGateState`, kept in `PersistedRun.gates`) is the authority for its phase, deadlines,
// escalation and decision; the gate block's `WaitingOn {kind: "gate"}` mirrors the phase fields and
// carries the executor's own resume state (the reviewer agent's, the launcher message's).
//
// Phases (§6.1): an agent or launcher decider has an AGENT phase bounded by `decider.maxMinutes`;
// the PERSON phase (decider human, or after escalation) is bounded by `timeout.minutes` counted
// from its start, else by the 7-day maximum. `timeout` never applies to the agent phase.

import {
  WORKFLOW_LIMITS,
  type DecideWorkflowGateRequest,
  type GateBlockConfig,
  type WorkflowGateChoiceView,
  type WorkflowGateDecidedBy,
  type WorkflowGateDecision,
  type WorkflowGateOutput,
  type WorkflowGateState,
  type WorkflowGateTimeout
} from "@orquester/api";
import type { CallerPrincipal } from "@orquester/api/agent-chat";

import type { WaitingOn } from "../contracts.ts";

const MINUTE = 60_000;

/** The longest comment a decision keeps (characters). */
export const GATE_COMMENT_MAX_CHARS = 4_000;

export type GateWaitingOn = Extract<WaitingOn, { kind: "gate" }>;
/** The executor's own part of the WaitingOn: what only it resumes. */
export type GateExtras = Pick<GateWaitingOn, "agent" | "reminders" | "turnEnded" | "launcher" | "loopLimit">;

/** The label of the person, as decisions and deciders name them. */
export const PERSON_LABEL = "you";

/** The choices as served: config defaults applied. */
export function choiceViews(config: Pick<GateBlockConfig, "choices">): WorkflowGateChoiceView[] {
  return config.choices.map((choice) => ({
    id: choice.id,
    label: choice.label,
    ...(choice.color !== undefined ? { color: choice.color } : {}),
    comment: choice.comment ?? "none"
  }));
}

/** The person phase's deadline: `timeout.minutes` from its start, else the 7-day maximum. */
export function personDeadline(phaseStartedAt: Date, timeout: WorkflowGateTimeout | undefined): Date {
  const max = WORKFLOW_LIMITS.gatePersonPhaseMaxMinutes;
  const minutes = timeout !== undefined && timeout.minutes > 0 ? Math.min(timeout.minutes, max) : max;
  return new Date(phaseStartedAt.getTime() + minutes * MINUTE);
}

/** The agent phase's deadline: `maxMinutes` from its start (default 60, at most the agent block's maximum). */
export function agentDeadline(phaseStartedAt: Date, maxMinutes: number | undefined): Date {
  const minutes = typeof maxMinutes === "number" && maxMinutes > 0 ? maxMinutes : WORKFLOW_LIMITS.gateAgentPhaseDefaultMinutes;
  return new Date(phaseStartedAt.getTime() + Math.min(minutes, WORKFLOW_LIMITS.agentMaxMinutes.max) * MINUTE);
}

/** The block's WaitingOn for a gate record, with the executor's extras. */
export function waitingOnFor(gate: WorkflowGateState, extras: GateExtras = {}): GateWaitingOn {
  const waitingOn: GateWaitingOn = {
    kind: "gate",
    gateId: gate.gateId,
    openedAt: gate.openedAt,
    phase: gate.phase,
    phaseStartedAt: gate.phaseStartedAt ?? gate.openedAt,
    phaseDeadlineAt: gate.phaseDeadlineAt ?? personDeadline(new Date(gate.phaseStartedAt ?? gate.openedAt), undefined).toISOString(),
    decider: { kind: gate.decider.kind, label: gate.decider.label }
  };
  if (gate.decider.sessionId !== undefined) waitingOn.deciderSessionId = gate.decider.sessionId;
  if (gate.escalatedAt !== undefined) waitingOn.escalatedAt = gate.escalatedAt;
  if (extras.agent !== undefined) waitingOn.agent = structuredClone(extras.agent);
  if (extras.reminders !== undefined) waitingOn.reminders = extras.reminders;
  if (extras.turnEnded === true) waitingOn.turnEnded = true;
  if (extras.launcher !== undefined) waitingOn.launcher = { ...extras.launcher };
  if (extras.loopLimit !== undefined) waitingOn.loopLimit = { ...extras.loopLimit };
  return waitingOn;
}

/** The extras a persisted gate WaitingOn carries. */
export function extrasOf(waitingOn: WaitingOn | undefined): GateExtras {
  if (waitingOn?.kind !== "gate") return {};
  const extras: GateExtras = {};
  if (waitingOn.agent !== undefined) extras.agent = structuredClone(waitingOn.agent);
  if (typeof waitingOn.reminders === "number") extras.reminders = waitingOn.reminders;
  if (waitingOn.turnEnded === true) extras.turnEnded = true;
  if (waitingOn.launcher !== undefined && typeof waitingOn.launcher.commandId === "string") extras.launcher = { ...waitingOn.launcher };
  if (isLoopLimitWait(waitingOn)) extras.loopLimit = { ...waitingOn.loopLimit };
  return extras;
}

/** A loop-limit gate's wait (§7.2): the engine's own, never a block executor's. */
export function isLoopLimitWait(waitingOn: WaitingOn | undefined): waitingOn is GateWaitingOn & { loopLimit: { edgeId: string; handle: string } } {
  return (
    waitingOn?.kind === "gate" &&
    waitingOn.loopLimit !== undefined &&
    typeof waitingOn.loopLimit.edgeId === "string" &&
    typeof waitingOn.loopLimit.handle === "string"
  );
}

/** The gate's output (§6.2). */
export function gateOutput(gate: WorkflowGateState): WorkflowGateOutput {
  const decision = gate.decision!;
  return { ...structuredClone(decision), escalated: gate.escalated };
}

/** The pending counts of a run's own gates (test gates never count as waiting for the person: no attention row). */
export function ownGateCounts(gates: Record<string, WorkflowGateState> | undefined): { pending: number; person: number } {
  let pending = 0;
  let person = 0;
  for (const gate of Object.values(gates ?? {})) {
    if (!isWaiting(gate)) continue;
    pending += 1;
    if (gate.phase === "person" && gate.test !== true) person += 1;
  }
  return { pending, person };
}

export function isWaiting(gate: Pick<WorkflowGateState, "decision" | "cancelled" | "expired">): boolean {
  return gate.decision === undefined && gate.cancelled !== true && gate.expired !== true;
}

// ---------------------------------------------------------------------------
// Deciding (the route and the MCP)
// ---------------------------------------------------------------------------

/** A refusal of a decide call: the route maps it onto its wire code. */
export class GateRefusal extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: "GATE_NOT_FOUND" | "GATE_NOT_DECIDER" | "INVALID_REQUEST" | "RUN_NOT_ACTIVE" | "ENGINE_UNAVAILABLE",
    message: string
  ) {
    super(message);
    this.name = "GateRefusal";
  }
}

/** Who a decide call's principal is, for this gate — from the daemon's records, never the request. */
export type GateActor =
  | { kind: "person"; decidedBy: WorkflowGateDecidedBy }
  | { kind: "decider"; decidedBy: WorkflowGateDecidedBy };

/** The decider as a refusal names it. */
function deciderPhrase(gate: WorkflowGateState): string {
  if (gate.decider.kind === "human") return "the person";
  return gate.decider.label;
}

/**
 * The principal's standing on this gate (§6.3): an in-chat agent is the assigned decider only when
 * the gate's record names its chat (the reviewer agent's session, or the launcher's thread) and the
 * gate is still in its agent phase; every other agent is refused. The person — the GUI, a direct
 * REST client, an external MCP client — may always decide.
 */
export function actorFor(gate: WorkflowGateState, principal: CallerPrincipal): GateActor {
  if (principal.kind === "agent") {
    const assigned = (gate.decider.kind === "agent" || gate.decider.kind === "launcher") && gate.decider.sessionId !== undefined && gate.decider.sessionId === principal.threadId;
    if (!assigned) throw new GateRefusal(403, "GATE_NOT_DECIDER", `Only ${deciderPhrase(gate)} may decide this gate.`);
    if (gate.phase !== "agent" && isWaiting(gate)) {
      throw new GateRefusal(403, "GATE_NOT_DECIDER", "This gate was handed to the person (escalated): only they may decide it now. End your turn.");
    }
    return {
      kind: "decider",
      decidedBy: { kind: gate.decider.kind === "agent" ? "agent" : "launcher", label: gate.decider.label, sessionId: principal.threadId }
    };
  }
  if (principal.kind === "external") return { kind: "person", decidedBy: { kind: "external", label: `${PERSON_LABEL} (MCP client)` } };
  return { kind: "person", decidedBy: { kind: "human", label: PERSON_LABEL } };
}

/** The comment as kept: trimmed, absent when empty. */
export function normalizeComment(comment: unknown): string | undefined {
  if (comment === undefined || comment === null) return undefined;
  if (typeof comment !== "string") throw new GateRefusal(400, "INVALID_REQUEST", "comment must be a string.");
  const trimmed = comment.trim();
  if (trimmed.length > GATE_COMMENT_MAX_CHARS) throw new GateRefusal(400, "INVALID_REQUEST", `A comment is at most ${GATE_COMMENT_MAX_CHARS} characters.`);
  return trimmed.length > 0 ? trimmed : undefined;
}

/** A decision a request asks for, checked against the gate's choices and comment rules. */
export function decisionFrom(
  gate: WorkflowGateState,
  request: DecideWorkflowGateRequest,
  actor: GateActor,
  now: Date
): WorkflowGateDecision {
  const choice = gate.choices.find((candidate) => candidate.id === request.choice);
  if (typeof request.choice !== "string" || choice === undefined) {
    throw new GateRefusal(400, "INVALID_REQUEST", `choice must be one of: ${gate.choices.map((c) => c.id).join(", ")}.`);
  }
  const comment = normalizeComment(request.comment);
  if (comment === undefined && actor.kind === "decider") {
    throw new GateRefusal(400, "INVALID_REQUEST", "An agent must explain its decision: pass comment (why this choice).");
  }
  if (comment === undefined && choice.comment === "required") {
    throw new GateRefusal(400, "INVALID_REQUEST", `"${choice.label}" needs a comment.`);
  }
  return { choice: choice.id, ...(comment !== undefined ? { comment } : {}), decidedBy: actor.decidedBy, decidedAt: now.toISOString() };
}

/** Text clipped to `max` characters, with an ellipsis. */
export function clipChars(text: string, max: number): { text: string; clipped: boolean } {
  const chars = [...text];
  if (chars.length <= max) return { text, clipped: false };
  return { text: `${chars.slice(0, Math.max(0, max - 1)).join("")}…`, clipped: true };
}

/** Text clipped to `maxBytes` UTF-8 bytes (never splitting a character), with an ellipsis line. */
export function clipBytes(text: string, maxBytes: number): { text: string; clipped: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, clipped: false };
  const note = "\n\n… (cut)";
  const buf = Buffer.from(text, "utf8");
  let end = Math.max(0, maxBytes - Buffer.byteLength(note, "utf8"));
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1;
  return { text: `${buf.subarray(0, end).toString("utf8")}${note}`, clipped: true };
}
