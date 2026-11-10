/**
 * Automated workflows — gates as the client sees them (spec 2026-11-10 §6.4):
 * the wire's `WorkflowGateState` repaired field by field, the rule that a
 * gate's state never goes backwards, and the words the decision card, the
 * attention rows and the run views say about one — where each choice leads,
 * who is deciding, the record line once decided, the toast after deciding.
 *
 * Pure: no store, no React. The workflows store holds the gates
 * (`store.ts`), the components draw them (`components/workflows/gates`).
 */

import {
  isGateWaiting,
  isGateWaitingForPerson,
  isLoopEdge,
  type DecideWorkflowGateResponse,
  type Workflow,
  type WorkflowGateChoiceColor,
  type WorkflowGateChoiceView,
  type WorkflowGateCommentMode,
  type WorkflowGateDecidedByKind,
  type WorkflowGateDecision,
  type WorkflowGateDeciderKind,
  type WorkflowGateState
} from "@orquester/api";

// Local, not `sanitize.ts`'s: that module reads gates through this one.
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const nonEmpty = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const CHOICE_COLORS: ReadonlySet<string> = new Set<WorkflowGateChoiceColor>([
  "default",
  "primary",
  "success",
  "warning",
  "danger"
]);
const COMMENT_MODES: ReadonlySet<string> = new Set<WorkflowGateCommentMode>(["none", "optional", "required"]);
const DECIDER_KINDS: ReadonlySet<string> = new Set<WorkflowGateDeciderKind>(["human", "agent", "launcher"]);
const DECIDED_BY_KINDS: ReadonlySet<string> = new Set<WorkflowGateDecidedByKind>([
  "human",
  "external",
  "agent",
  "launcher",
  "timeout"
]);

// ---------------------------------------------------------------------------
// Off the wire
// ---------------------------------------------------------------------------

function sanitizeChoice(value: unknown): WorkflowGateChoiceView | null {
  if (!isRecord(value)) return null;
  const id = nonEmpty(value.id);
  if (id === undefined) return null;
  const label = str(value.label)?.trim();
  const choice: WorkflowGateChoiceView = {
    id,
    label: label ? label : id,
    comment: typeof value.comment === "string" && COMMENT_MODES.has(value.comment) ? (value.comment as WorkflowGateCommentMode) : "none"
  };
  if (typeof value.color === "string" && CHOICE_COLORS.has(value.color)) choice.color = value.color as WorkflowGateChoiceColor;
  return choice;
}

/** A decision; `null` without a choice. */
export function sanitizeGateDecision(value: unknown): WorkflowGateDecision | null {
  if (!isRecord(value)) return null;
  const choice = nonEmpty(value.choice);
  if (choice === undefined) return null;
  const by = isRecord(value.decidedBy) ? value.decidedBy : {};
  const kind = typeof by.kind === "string" && DECIDED_BY_KINDS.has(by.kind) ? (by.kind as WorkflowGateDecidedByKind) : "human";
  const decision: WorkflowGateDecision = {
    choice,
    decidedBy: { kind, label: str(by.label)?.trim() || (kind === "timeout" ? "timeout" : "someone") },
    decidedAt: str(value.decidedAt) ?? ""
  };
  const sessionId = nonEmpty(by.sessionId);
  if (sessionId !== undefined) decision.decidedBy.sessionId = sessionId;
  const comment = str(value.comment);
  if (comment !== undefined && comment.trim().length > 0) decision.comment = comment;
  return decision;
}

/** One gate; `null` without its identity (gate, run, workflow, block). */
export function sanitizeGateState(value: unknown): WorkflowGateState | null {
  if (!isRecord(value)) return null;
  const gateId = nonEmpty(value.gateId);
  const runId = nonEmpty(value.runId);
  const workflowId = nonEmpty(value.workflowId);
  const nodeId = nonEmpty(value.nodeId);
  if (gateId === undefined || runId === undefined || workflowId === undefined || nodeId === undefined) return null;
  const decider = isRecord(value.decider) ? value.decider : {};
  const deciderKind =
    typeof decider.kind === "string" && DECIDER_KINDS.has(decider.kind) ? (decider.kind as WorkflowGateDeciderKind) : "human";
  const gate: WorkflowGateState = {
    gateId,
    runId,
    workflowId,
    nodeId,
    nodeName: nonEmpty(value.nodeName) ?? nodeId,
    source: value.source === "loop_limit" ? "loop_limit" : "gate",
    question: str(value.question) ?? "",
    choices: Array.isArray(value.choices)
      ? value.choices.map(sanitizeChoice).filter((choice): choice is WorkflowGateChoiceView => choice !== null)
      : [],
    decider: { kind: deciderKind, label: str(decider.label)?.trim() || (deciderKind === "human" ? "you" : "an agent") },
    phase: value.phase === "agent" ? "agent" : "person",
    openedAt: str(value.openedAt) ?? "",
    escalated: value.escalated === true
  };
  const deciderSession = nonEmpty(decider.sessionId);
  if (deciderSession !== undefined) gate.decider.sessionId = deciderSession;
  for (const key of ["workflowName", "projectPath", "details", "phaseStartedAt", "phaseDeadlineAt", "escalatedAt", "escalationReason"] as const) {
    const field = str(value[key]);
    if (field !== undefined) gate[key] = field;
  }
  for (const key of ["rootRunId", "edgeId"] as const) {
    const field = nonEmpty(value[key]);
    if (field !== undefined) gate[key] = field;
  }
  if (typeof value.pass === "number" && Number.isFinite(value.pass) && value.pass >= 1) gate.pass = Math.floor(value.pass);
  const decision = sanitizeGateDecision(value.decision);
  if (decision !== null) gate.decision = decision;
  if (value.cancelled === true) gate.cancelled = true;
  // The person phase ran out (the block failed `gate_expired`, or a loop-limit gate's `loop_limit`):
  // it no longer waits — dropping this would show it waiting forever.
  if (value.expired === true) gate.expired = true;
  if (value.test === true) gate.test = true;
  return gate;
}

/** A run's `gates` (a map by id) or an update's / a list's array; unusable entries dropped. */
export function sanitizeGateList(value: unknown): WorkflowGateState[] {
  const entries = Array.isArray(value) ? value : isRecord(value) ? Object.values(value) : [];
  const out: WorkflowGateState[] = [];
  for (const entry of entries) {
    const gate = sanitizeGateState(entry);
    if (gate !== null) out.push(gate);
  }
  return out;
}

/** A decide answer; `null` when its gate cannot be trusted. */
export function sanitizeDecideAnswer(value: unknown): DecideWorkflowGateResponse | null {
  if (!isRecord(value)) return null;
  const gate = sanitizeGateState(value.gate);
  if (gate === null) return null;
  const answer: DecideWorkflowGateResponse = { alreadyDecided: value.alreadyDecided === true, gate };
  const decision = sanitizeGateDecision(value.decision) ?? gate.decision ?? null;
  if (decision !== null) answer.decision = decision;
  return answer;
}

// ---------------------------------------------------------------------------
// Nothing goes backwards
// ---------------------------------------------------------------------------

/** Agent phase < person phase < settled (decided or cancelled). */
function gateRank(gate: WorkflowGateState): number {
  if (!isGateWaiting(gate)) return 2;
  return gate.phase === "person" ? 1 : 0;
}

/**
 * `incoming` replaces `current` unless it is behind it: a settled gate never
 * waits again, a gate handed to the person never goes back to its agent, and
 * a decision is never undone by a cancel that raced it (the first decision wins).
 */
export function mergeGate(current: WorkflowGateState | undefined, incoming: WorkflowGateState): WorkflowGateState {
  if (current === undefined) return incoming;
  const rank = gateRank(incoming);
  const held = gateRank(current);
  if (rank < held) return current;
  if (current.decision !== undefined && incoming.decision === undefined) return current;
  // List rows carry the workflow's name and project; a run's own copy may not.
  const keep: Partial<WorkflowGateState> = {};
  if (incoming.workflowName === undefined && current.workflowName !== undefined) keep.workflowName = current.workflowName;
  if (incoming.projectPath === undefined && current.projectPath !== undefined) keep.projectPath = current.projectPath;
  return Object.keys(keep).length > 0 ? { ...incoming, ...keep } : incoming;
}

/** Waiting gates of a run that ended read as cancelled with it (the daemon cancels them; this is its echo). */
export function cancelledWithRun(gate: WorkflowGateState): WorkflowGateState {
  return isGateWaiting(gate) ? { ...gate, cancelled: true } : gate;
}

// ---------------------------------------------------------------------------
// Where each choice leads (§6.4: "→ Deploy", "↺ Fix", "→ End")
// ---------------------------------------------------------------------------

export interface ChoiceDestination {
  kind: "next" | "loop" | "end";
  /** "→ Deploy", "↺ Fix", "→ End". */
  text: string;
  /** For a screen reader: "goes on to Deploy", "loops back to Fix", "ends this path". */
  spoken: string;
}

const END: ChoiceDestination = { kind: "end", text: "→ End", spoken: "ends this path" };

type DefinitionLike = Pick<Workflow, "nodes" | "edges">;

function nameOf(definition: DefinitionLike, nodeId: string): string {
  return definition.nodes.find((node) => node.id === nodeId)?.name ?? nodeId;
}

/** Where the edges leaving `handle` of `nodeId` go. */
function handleDestination(definition: DefinitionLike, nodeId: string, handle: string): ChoiceDestination {
  const edges = definition.edges.filter((edge) => edge.source === nodeId && edge.sourceHandle === handle);
  if (edges.length === 0) return END;
  const loop = edges.find((edge) => isLoopEdge(edge));
  if (loop) {
    const name = nameOf(definition, loop.target);
    return { kind: "loop", text: `↺ ${name}`, spoken: `loops back to ${name}` };
  }
  const names = [...new Set(edges.map((edge) => nameOf(definition, edge.target)))];
  const list = names.join(", ");
  return { kind: "next", text: `→ ${list}`, spoken: `goes on to ${list}` };
}

/** A loop-limit gate's "Stop" choice (§7.2): its id, else its label, says so. */
export function isStopChoice(choice: Pick<WorkflowGateChoiceView, "id" | "label">): boolean {
  return choice.id === "stop" || /^stop\b/i.test(choice.label.trim());
}

/**
 * Where each of a gate's choices leads, by choice id, from the run's frozen
 * definition: a gate block's choice follows its `choice:<id>` handle; a
 * loop-limit gate's "Stop" fails the source block (its `error` handle) and its
 * other choice takes the loop edge once more. Empty without a definition.
 */
export function gateChoiceDestinations(
  definition: DefinitionLike | null | undefined,
  gate: Pick<WorkflowGateState, "nodeId" | "source" | "edgeId" | "choices">
): Record<string, ChoiceDestination> {
  const out: Record<string, ChoiceDestination> = {};
  if (!definition) return out;
  for (const choice of gate.choices) {
    if (gate.source === "loop_limit") {
      if (isStopChoice(choice)) {
        const failure = handleDestination(definition, gate.nodeId, "error");
        out[choice.id] = failure.kind === "end" ? { kind: "end", text: "→ End (fails)", spoken: "fails the step" } : failure;
        continue;
      }
      const edge = gate.edgeId ? definition.edges.find((candidate) => candidate.id === gate.edgeId) : undefined;
      const name = edge ? nameOf(definition, edge.target) : null;
      out[choice.id] = name
        ? { kind: "loop", text: `↺ ${name}`, spoken: `loops back to ${name}` }
        : { kind: "loop", text: "↺ Loop again", spoken: "loops once more" };
      continue;
    }
    out[choice.id] = handleDestination(definition, gate.nodeId, `choice:${choice.id}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/**
 * The card's title: the rendered question. A loop-limit gate's question is
 * the daemon's "Fix → Review reached its limit (3)." — the limit when it
 * asked (a later "Allow one more loop" raises the run's limit); without one,
 * the title is built from the run's definition and limits.
 */
export function gateTitle(
  gate: Pick<WorkflowGateState, "source" | "edgeId" | "question" | "nodeName">,
  definition?: DefinitionLike | null,
  loopLimits?: Readonly<Record<string, number>> | null
): string {
  if (gate.source === "loop_limit" && !gate.question.trim() && definition && gate.edgeId) {
    const edge = definition.edges.find((candidate) => candidate.id === gate.edgeId);
    if (edge) {
      const configured = isRecord(edge.loop) && typeof edge.loop.maxLoops === "number" ? edge.loop.maxLoops : null;
      const limit = loopLimits?.[edge.id] ?? configured;
      return `${nameOf(definition, edge.source)} → ${nameOf(definition, edge.target)} reached its limit${limit !== null ? ` (${limit})` : ""}`;
    }
  }
  const question = gate.question.trim();
  if (question) return question;
  return gate.source === "loop_limit" ? `${gate.nodeName}'s loop reached its limit` : `${gate.nodeName} needs a decision`;
}

/** While an agent decides: "Reviewer (claude) is deciding; you can decide first." — else `null`. */
export function gateDeciderNote(gate: Pick<WorkflowGateState, "phase" | "decider" | "decision" | "cancelled">): string | null {
  if (!isGateWaiting(gate) || gate.phase !== "agent") return null;
  const label = gate.decider.label.trim() || "An agent";
  return `${label.charAt(0).toUpperCase()}${label.slice(1)} is deciding; you can decide first.`;
}

/** The label of choice `id` on `gate`, else the id. */
export function choiceLabel(gate: Pick<WorkflowGateState, "choices">, id: string): string {
  return gate.choices.find((choice) => choice.id === id)?.label ?? id;
}

/** "Approve" → "approved", "Reject" → "rejected", "Deny" → "denied"; several words stay quoted. */
export function choicePastTense(label: string): string {
  const word = label.trim();
  if (!/^[A-Za-z]+$/.test(word)) return `“${word}”`;
  const lower = word.toLowerCase();
  if (lower.endsWith("ed")) return lower;
  if (lower.endsWith("e")) return `${lower}d`;
  // One syllable ending consonant-vowel-consonant doubles it: "Stop" → "stopped", "Ship" → "shipped".
  if (/^[^aeiou]*[aeiou][bdgklmnprt]$/.test(lower)) return `${lower}${lower.at(-1)}ed`;
  if (/[^aeiou]y$/.test(lower)) return `${lower.slice(0, -1)}ied`;
  return `${lower}ed`;
}

/**
 * The record a settled gate leaves (§6.4): "approved by you, 10:42: looks
 * good", "“Allow one more loop” by Reviewer (claude), 10:42", "Cancelled with
 * the run". `null` while it waits.
 */
export function gateRecordLine(
  gate: Pick<WorkflowGateState, "choices" | "decision" | "cancelled" | "expired">,
  clock: (iso: string) => string
): string | null {
  const decision = gate.decision;
  if (decision) {
    const when = decision.decidedAt ? clock(decision.decidedAt) : "";
    const who = decision.decidedBy.kind === "timeout" ? "timeout" : decision.decidedBy.label;
    const head = `${choicePastTense(choiceLabel(gate, decision.choice))} by ${who}${when ? `, ${when}` : ""}`;
    const comment = decision.comment?.trim();
    return comment ? `${head}: ${comment}` : head;
  }
  if (gate.cancelled) return "Cancelled with the run";
  if (gate.expired) return "Expired: nobody decided in time";
  return null;
}

/** The toast after deciding (§6.4): "Approve: sent", or "Already decided: Reject by Ana". */
export function decisionToastText(
  answer: Pick<DecideWorkflowGateResponse, "alreadyDecided" | "decision" | "gate">,
  asked: string
): string {
  if (!answer.alreadyDecided) return `${choiceLabel(answer.gate, asked)}: sent`;
  const decision = answer.decision ?? answer.gate.decision;
  if (!decision) return "Already decided";
  return `Already decided: ${choiceLabel(answer.gate, decision.choice)} by ${decision.decidedBy.label}`;
}

/** What a choice's comment box asks, and whether Send may go. */
export function commentRule(
  choice: Pick<WorkflowGateChoiceView, "comment">,
  comment: string
): { asks: boolean; required: boolean; canSend: boolean } {
  const asks = choice.comment !== "none";
  const required = choice.comment === "required";
  return { asks, required, canSend: !required || comment.trim().length > 0 };
}

// ---------------------------------------------------------------------------
// Attention (§6.4: a "Needs you" row per gate waiting for the person)
// ---------------------------------------------------------------------------

export interface GateAttentionRow {
  key: string;
  gateId: string;
  runId: string;
  workflowId: string;
  workflowName: string;
  question: string;
  /** The run's project, when known. */
  projectPath?: string;
  /** The project's folder name, for the row. */
  projectName?: string;
  openedAt: string;
  source: WorkflowGateState["source"];
}

export type GatesByRun = Readonly<Record<string, Readonly<Record<string, WorkflowGateState>>>>;

/** The store's key for a gate: unique across runs. */
export function gateKey(gate: Pick<WorkflowGateState, "runId" | "gateId">): string {
  return `${gate.runId}/${gate.gateId}`;
}

/** Every gate held, in one list. */
export function allGates(gates: GatesByRun): WorkflowGateState[] {
  const out: WorkflowGateState[] = [];
  for (const byId of Object.values(gates)) for (const gate of Object.values(byId)) out.push(gate);
  return out;
}

/** Whether a gate belongs in the attention rows and badges: waiting for the person, not a test run's (§7.5). */
export function gateNeedsPerson(gate: WorkflowGateState): boolean {
  return isGateWaitingForPerson(gate) && gate.test !== true;
}

function openedTime(gate: Pick<WorkflowGateState, "openedAt">): number {
  const time = Date.parse(gate.openedAt);
  return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time;
}

/**
 * The "Needs you" rows, oldest first (the one waiting longest on top). The
 * names come from the gate when it carries them (a list row), else from what
 * the store knows of its run and workflow.
 */
export function gateAttentionRows(
  gates: GatesByRun,
  context: {
    workflowName?: (workflowId: string) => string | undefined;
    runProjectPath?: (runId: string) => string | undefined;
  } = {}
): GateAttentionRow[] {
  return allGates(gates)
    .filter(gateNeedsPerson)
    .sort((a, b) => openedTime(a) - openedTime(b) || (gateKey(a) < gateKey(b) ? -1 : 1))
    .map((gate) => {
      const projectPath = gate.projectPath || context.runProjectPath?.(gate.runId) || undefined;
      const projectName = projectPath ? projectPath.replace(/\/+$/, "").split("/").pop() || undefined : undefined;
      return {
        key: gateKey(gate),
        gateId: gate.gateId,
        runId: gate.runId,
        workflowId: gate.workflowId,
        workflowName: gate.workflowName?.trim() || context.workflowName?.(gate.workflowId)?.trim() || "Workflow",
        question: gateTitle(gate),
        ...(projectPath ? { projectPath } : {}),
        ...(projectName ? { projectName } : {}),
        openedAt: gate.openedAt,
        source: gate.source
      };
    });
}

/** The gates of `nodeId` in a run, the newest first (a loop may have asked again). */
export function gatesOfNode(byId: Readonly<Record<string, WorkflowGateState>> | undefined, nodeId: string): WorkflowGateState[] {
  if (!byId) return [];
  return Object.values(byId)
    .filter((gate) => gate.nodeId === nodeId)
    .sort((a, b) => openedTime(b) - openedTime(a) || (b.pass ?? 1) - (a.pass ?? 1));
}

/**
 * The gates a workflow's rail card shows: waiting ones of its runs (or of a
 * sub-workflow's child run under one of them), never a test run's, oldest first.
 */
export function waitingGatesOfWorkflow(
  gates: GatesByRun,
  workflowId: string,
  runWorkflowId: (runId: string) => string | undefined
): WorkflowGateState[] {
  return allGates(gates)
    .filter(
      (gate) =>
        isGateWaiting(gate) &&
        gate.test !== true &&
        (gate.workflowId === workflowId || (gate.rootRunId !== undefined && runWorkflowId(gate.rootRunId) === workflowId))
    )
    .sort((a, b) => openedTime(a) - openedTime(b));
}

/** A run row's gate badge: "Needs you" while one waits for the person, "Awaiting a decision" while an agent decides. */
export function runGateBadge(run: { pendingGates?: number; pendingPersonGates?: number }): {
  tone: "warn" | "info";
  text: string;
} | null {
  const person = run.pendingPersonGates ?? 0;
  const any = run.pendingGates ?? 0;
  if (person > 0) return { tone: "warn", text: person === 1 ? "Needs you" : `Needs you · ${person}` };
  if (any > 0) return { tone: "info", text: "Awaiting a decision" };
  return null;
}
