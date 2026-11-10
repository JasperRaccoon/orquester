// Automated workflows — gates (spec 2026-11-10 §6): the engine's gate records. One host per engine;
// the engine hands it a narrow view of each active run (`GateRunAccess`). Every change to a gate goes
// through here: it is made on the run's record, PERSISTED (the run's save), published, and only then
// are the waiters (the gate executor, a loop-limit wait) woken and the person pushed — so a decision is
// on disk before the engine moves on, and a restart re-arms exactly what was recorded.
//
// The first decision wins: JavaScript runs each check-and-set to completion, so of two decisions the
// second always finds the first and answers `alreadyDecided`.

import {
  type DecideWorkflowGateRequest,
  type DecideWorkflowGateResponse,
  type ListWorkflowGatesResponse,
  type Workflow,
  type WorkflowGateChoiceView,
  type WorkflowGateDecision,
  type WorkflowGateState,
  type WorkflowRunStartedBy
} from "@orquester/api";
import type { CallerPrincipal } from "@orquester/api/agent-chat";
import { resolve } from "node:path";

import type { Clock, GateChange, GateServices, MintId, PersistedRun, WorkflowLogger, WorkflowNotifier } from "../contracts.ts";
import { EngineStoppedError, sleepUntil } from "../run-context.ts";
import {
  actorFor,
  clipChars,
  decisionFrom,
  extrasOf,
  GateRefusal,
  isWaiting,
  normalizeComment,
  ownGateCounts,
  PERSON_LABEL,
  personDeadline,
  waitingOnFor
} from "./state.ts";

/** One active run, as the gate host sees it (the engine builds it). */
export interface GateRunAccess {
  /** The live record: changes made here are what the next save writes. */
  readonly run: PersistedRun;
  /** The definition the run executes. */
  readonly workflow: Workflow;
  alive(): boolean;
  redact<T>(value: T): T;
  /** Persist the run (coalesced); resolves once the state asked for is written. */
  save(): Promise<void>;
  /** A gate (or, without an id, only the run's summary) changed: publish it. */
  touched(gateId?: string): void;
  parent(): GateRunAccess | null;
  children(): GateRunAccess[];
}

export interface GateHostDeps {
  clock: Clock;
  mintId: MintId;
  logger: WorkflowLogger;
  access(runId: string): GateRunAccess | null;
  activeRuns(): GateRunAccess[];
  /** A run's record from disk (one this engine does not hold). */
  loadRun(runId: string): Promise<PersistedRun | null>;
  /** Retained runs for `listGates({includeDecided})` (newest first, bounded by the caller). */
  retainedRuns(): Promise<PersistedRun[]>;
  notifier(): WorkflowNotifier | undefined;
  /** The engine no longer writes: a decision could not be persisted. */
  stopped(): boolean;
}

/** A person-only gate opened by the engine itself (a loop edge at its limit, §7.2). */
export interface OpenPersonGateSpec {
  /** The block the gate belongs to (the loop edge's source). */
  nodeId: string;
  /** Its pass. */
  pass?: number;
  source: "gate" | "loop_limit";
  /** The loop edge that reached its limit. */
  edgeId?: string;
  question: string;
  details?: string;
  choices: WorkflowGateChoiceView[];
}

/** How a programmatic gate ended. */
export type PersonGateResult =
  | { kind: "decided"; decision: WorkflowGateDecision; gate: WorkflowGateState }
  | { kind: "expired"; gate: WorkflowGateState }
  | { kind: "cancelled" };

export interface GateHost extends GateServices {
  /** The route's decide: authorization from the daemon's records (`actorFor`), first wins. */
  decideRequest(runId: string, gateId: string, request: DecideWorkflowGateRequest, principal: CallerPrincipal): Promise<DecideWorkflowGateResponse>;
  list(query: { projectPath?: string; includeDecided?: boolean }): Promise<ListWorkflowGatesResponse>;
  /** Every waiting gate of a run that is ending: cancelled (before its final save). */
  cancelAll(runId: string): void;
  /** Recompute a run's pending counts (own gates plus its children's) and its ancestors'. */
  refreshCounts(runId: string): void;
  /** The first waiting gate of a run or its children (the overlap skip's reason). */
  waitingGateOf(runId: string): WorkflowGateState | undefined;
  /**
   * Engine-internal (loop limits, §7.2): open a person-decided gate on a block — persisted, then the
   * person is pushed. Its deadline is the 7-day maximum (then it expires).
   */
  openPersonGate(runId: string, spec: OpenPersonGateSpec): Promise<WorkflowGateState>;
  /**
   * Engine-internal: wait for a gate's decision — also after a restart (its deadline re-armed from
   * the record). Resolves `cancelled` when `signal` aborts or the run ends.
   */
  awaitGate(runId: string, gateId: string, signal: AbortSignal): Promise<PersonGateResult>;
}

const ESCALATION_REASON_CHARS = 500;

export function createGateHost(deps: GateHostDeps): GateHost {
  const { clock, logger } = deps;
  const waiters = new Map<string, Set<(change: GateChange) => void>>();
  const key = (runId: string, gateId: string): string => `${runId}\u0000${gateId}`;

  const record = (a: GateRunAccess, gateId: string): WorkflowGateState | undefined => {
    const gates = a.run.gates;
    return gates !== undefined && Object.hasOwn(gates, gateId) ? gates[gateId] : undefined;
  };

  const emit = (runId: string, gateId: string, change: GateChange): void => {
    const set = waiters.get(key(runId, gateId));
    if (!set) return;
    waiters.delete(key(runId, gateId));
    for (const wake of set) wake(change);
  };

  const timeoutOf = (a: GateRunAccess, gate: WorkflowGateState) => {
    if (gate.source !== "gate") return undefined;
    const node = a.workflow.nodes.find((candidate) => candidate.id === gate.nodeId);
    return node?.type === "gate" ? node.config.timeout : undefined;
  };

  /** The block's WaitingOn follows the record's phase (a gate block's own gate only). */
  const syncWaitingOn = (a: GateRunAccess, gate: WorkflowGateState): void => {
    const block = a.run.blocks[gate.nodeId];
    if (block?.waitingOn?.kind !== "gate" || block.waitingOn.gateId !== gate.gateId) return;
    block.waitingOn = waitingOnFor(gate, extrasOf(block.waitingOn));
  };

  const refreshCounts = (a: GateRunAccess): void => {
    const own = ownGateCounts(a.run.gates);
    let pending = own.pending;
    let person = own.person;
    for (const child of a.children()) {
      pending += child.run.pendingGates ?? 0;
      person += child.run.pendingPersonGates ?? 0;
    }
    if ((a.run.pendingGates ?? 0) === pending && (a.run.pendingPersonGates ?? 0) === person) return;
    if (pending > 0) a.run.pendingGates = pending;
    else delete a.run.pendingGates;
    if (person > 0) a.run.pendingPersonGates = person;
    else delete a.run.pendingPersonGates;
    a.touched();
    const parent = a.parent();
    if (parent) refreshCounts(parent);
  };

  const changed = (a: GateRunAccess, gate: WorkflowGateState): void => {
    syncWaitingOn(a, gate);
    a.touched(gate.gateId);
    refreshCounts(a);
  };

  const rootOf = (a: GateRunAccess): GateRunAccess => {
    let cursor = a;
    const seen = new Set<string>([a.run.id]);
    for (let parent = cursor.parent(); parent && !seen.has(parent.run.id); parent = cursor.parent()) {
      seen.add(parent.run.id);
      cursor = parent;
    }
    return cursor;
  };

  const notifyPerson = async (runId: string, gateId: string): Promise<void> => {
    const a = deps.access(runId);
    if (!a || !a.alive()) return;
    const gate = record(a, gateId);
    if (!gate || !isWaiting(gate) || gate.phase !== "person" || gate.test === true) return;
    const phaseStart = gate.phaseStartedAt ?? gate.openedAt;
    if (a.run.gateNotices?.[gateId] === phaseStart) return;
    const notifier = deps.notifier();
    try {
      notifier?.gateWaiting?.(structuredClone(gate), a.workflow);
    } catch (error) {
      logger.warn("workflow gate push failed", { runId, gateId, error: error instanceof Error ? error.message : String(error) });
    }
    // At least once: a restart before this lands pushes the phase again, never not at all.
    a.run.gateNotices = { ...(a.run.gateNotices ?? {}), [gateId]: phaseStart };
    await a.save();
  };

  const decide = async (
    runId: string,
    gateId: string,
    decision: WorkflowGateDecision,
    opts: { byDecider: boolean }
  ): Promise<{ decision: WorkflowGateDecision; alreadyDecided: boolean }> => {
    const a = deps.access(runId);
    if (!a || !a.alive()) throw new GateRefusal(409, "RUN_NOT_ACTIVE", "The run is no longer active.");
    const gate = record(a, gateId);
    if (!gate) throw new GateRefusal(404, "GATE_NOT_FOUND", `No gate "${gateId}" in run "${runId}".`);
    if (gate.decision !== undefined) return { decision: structuredClone(gate.decision), alreadyDecided: true };
    if (!isWaiting(gate)) throw new GateRefusal(409, "RUN_NOT_ACTIVE", gate.expired ? "The gate expired before a decision." : "The gate was cancelled with its run.");
    if (deps.stopped()) throw new GateRefusal(503, "ENGINE_UNAVAILABLE", "The workflow engine is stopping; decide again once it is back.");
    gate.decision = a.redact(structuredClone(decision));
    changed(a, gate);
    await a.save();
    emit(runId, gateId, { kind: "decided", byDecider: opts.byDecider });
    return { decision: structuredClone(gate.decision), alreadyDecided: false };
  };

  const escalate = async (runId: string, gateId: string, reason: string, opts: { byDecider: boolean }): Promise<WorkflowGateState | null> => {
    const a = deps.access(runId);
    // Nothing more reaches disk for this run: the waiter must stop, never spin on its deadline.
    if (!a || !a.alive()) throw new EngineStoppedError();
    const gate = record(a, gateId);
    if (!gate || !isWaiting(gate)) return null;
    if (gate.phase === "person") return structuredClone(gate);
    const now = clock.now();
    gate.phase = "person";
    gate.escalated = true;
    gate.escalatedAt = now.toISOString();
    gate.phaseStartedAt = now.toISOString();
    gate.phaseDeadlineAt = personDeadline(now, timeoutOf(a, gate)).toISOString();
    gate.escalationReason = a.redact(clipChars(reason, ESCALATION_REASON_CHARS).text);
    changed(a, gate);
    await a.save();
    emit(runId, gateId, { kind: "escalated", byDecider: opts.byDecider });
    await notifyPerson(runId, gateId);
    return structuredClone(gate);
  };

  const expire = async (runId: string, gateId: string, then: { kind: "choice"; choice: string } | { kind: "fail" }): Promise<WorkflowGateState | null> => {
    const a = deps.access(runId);
    if (!a || !a.alive()) throw new EngineStoppedError();
    const gate = record(a, gateId);
    if (!gate || !isWaiting(gate)) return gate ? structuredClone(gate) : null;
    if (then.kind === "choice" && gate.choices.some((choice) => choice.id === then.choice)) {
      await decide(runId, gateId, { choice: then.choice, decidedBy: { kind: "timeout", label: "timeout" }, decidedAt: clock.now().toISOString() }, { byDecider: false });
    } else {
      gate.expired = true;
      changed(a, gate);
      await a.save();
      emit(runId, gateId, { kind: "expired", byDecider: false });
    }
    return structuredClone(record(a, gateId) ?? gate);
  };

  const cancel = (runId: string, gateId: string): void => {
    const a = deps.access(runId);
    if (!a) return;
    const gate = record(a, gateId);
    if (!gate || !isWaiting(gate)) return;
    gate.cancelled = true;
    changed(a, gate);
    emit(runId, gateId, { kind: "cancelled", byDecider: false });
  };

  const nextChange = (runId: string, gateId: string, signal: AbortSignal): Promise<GateChange | null> =>
    new Promise((resolve) => {
      if (signal.aborted) {
        resolve(null);
        return;
      }
      const k = key(runId, gateId);
      let set = waiters.get(k);
      if (!set) {
        set = new Set();
        waiters.set(k, set);
      }
      const wake = (change: GateChange): void => {
        signal.removeEventListener("abort", onAbort);
        resolve(change);
      };
      const onAbort = (): void => {
        const current = waiters.get(k);
        current?.delete(wake);
        if (current?.size === 0) waiters.delete(k);
        resolve(null);
      };
      set.add(wake);
      signal.addEventListener("abort", onAbort, { once: true });
    });

  /** A gate as a list row: the run's names on it. */
  const listRow = (run: Pick<PersistedRun, "workflowName" | "projectPath">, gate: WorkflowGateState): WorkflowGateState => {
    const row = structuredClone(gate);
    row.workflowName = run.workflowName;
    if (run.projectPath !== undefined) row.projectPath = run.projectPath;
    return row;
  };

  const host: GateHost = {
    get(runId, gateId) {
      const a = deps.access(runId);
      const gate = a ? record(a, gateId) : undefined;
      return gate ? structuredClone(gate) : undefined;
    },

    put(runId, gate) {
      const a = deps.access(runId);
      if (!a || !a.alive()) return;
      a.run.gates ??= Object.create(null) as Record<string, WorkflowGateState>;
      const kept = a.redact(structuredClone(gate));
      a.run.gates[gate.gateId] = kept;
      changed(a, kept);
    },

    nextChange,
    escalate,
    decide,
    expire,
    cancel,
    notifyPerson,

    startedBy(runId): WorkflowRunStartedBy | undefined {
      const a = deps.access(runId);
      if (!a) return undefined;
      const by = rootOf(a).run.startedBy ?? a.run.startedBy;
      return by ? structuredClone(by) : undefined;
    },

    rootRunId(runId) {
      const a = deps.access(runId);
      return a ? rootOf(a).run.id : runId;
    },

    isTest(runId) {
      return deps.access(runId)?.run.test === true;
    },

    rootWorkflowName(runId) {
      const a = deps.access(runId);
      return a ? rootOf(a).run.workflowName : undefined;
    },

    async decideRequest(runId, gateId, request, principal) {
      const a = deps.access(runId);
      if (!a) {
        // Not held by this engine: a finished run — its decision stands, or nothing was decided.
        const run = await deps.loadRun(runId);
        if (!run) throw new GateRefusal(404, "GATE_NOT_FOUND", `No run with id "${runId}".`);
        const gate = run.gates !== undefined && Object.hasOwn(run.gates, gateId) ? run.gates[gateId] : undefined;
        if (!gate) throw new GateRefusal(404, "GATE_NOT_FOUND", `No gate "${gateId}" in run "${runId}".`);
        if (principal.kind === "agent") actorFor(gate, principal);
        if (gate.decision !== undefined) return { alreadyDecided: true, decision: structuredClone(gate.decision), gate: structuredClone(gate) };
        throw new GateRefusal(409, "RUN_NOT_ACTIVE", "The run has ended; this gate was not decided.");
      }
      const gate = record(a, gateId);
      if (!gate) throw new GateRefusal(404, "GATE_NOT_FOUND", `No gate "${gateId}" in run "${runId}".`);
      const actor = actorFor(gate, principal);
      if (!a.alive() && gate.decision === undefined) {
        throw deps.stopped()
          ? new GateRefusal(503, "ENGINE_UNAVAILABLE", "The workflow engine is stopping; decide again once it is back.")
          : new GateRefusal(409, "RUN_NOT_ACTIVE", "The run is ending; this gate can no longer be decided.");
      }
      if (gate.decision !== undefined) return { alreadyDecided: true, decision: structuredClone(gate.decision), gate: structuredClone(gate) };
      if (!isWaiting(gate)) throw new GateRefusal(409, "RUN_NOT_ACTIVE", gate.expired ? "The gate expired before a decision." : "The gate was cancelled with its run.");
      if (request.escalate === true) {
        if (actor.kind !== "decider") throw new GateRefusal(400, "INVALID_REQUEST", "escalate is for an agent decider handing the gate to the person; the person decides with a choice.");
        const comment = normalizeComment(request.comment);
        if (comment === undefined) throw new GateRefusal(400, "INVALID_REQUEST", "Say why you escalate: pass comment.");
        if (deps.stopped()) throw new GateRefusal(503, "ENGINE_UNAVAILABLE", "The workflow engine is stopping; try again once it is back.");
        const after = await escalate(runId, gateId, `${gate.decider.label} escalated: ${comment}`, { byDecider: true });
        return { alreadyDecided: false, gate: after ?? structuredClone(record(a, gateId) ?? gate) };
      }
      const decision = decisionFrom(gate, request, actor, clock.now());
      const result = await decide(runId, gateId, decision, { byDecider: actor.kind === "decider" });
      return { alreadyDecided: result.alreadyDecided, decision: result.decision, gate: structuredClone(record(a, gateId) ?? gate) };
    },

    async list(query) {
      const rows: WorkflowGateState[] = [];
      const seen = new Set<string>();
      const wanted = query.projectPath !== undefined ? resolve(query.projectPath) : undefined;
      const matches = (run: Pick<PersistedRun, "projectPath">): boolean => wanted === undefined || (run.projectPath !== undefined && resolve(run.projectPath) === wanted);
      for (const a of deps.activeRuns()) {
        seen.add(a.run.id);
        if (!matches(a.run)) continue;
        for (const gate of Object.values(a.run.gates ?? {})) {
          if (query.includeDecided === true || isWaiting(gate)) rows.push(listRow(a.run, gate));
        }
      }
      if (query.includeDecided === true) {
        for (const run of await deps.retainedRuns()) {
          if (seen.has(run.id) || !matches(run)) continue;
          seen.add(run.id);
          for (const gate of Object.values(run.gates ?? {})) rows.push(listRow(run, gate));
        }
      }
      rows.sort((x, y) => (x.openedAt < y.openedAt ? -1 : x.openedAt > y.openedAt ? 1 : x.gateId < y.gateId ? -1 : 1));
      return { gates: rows };
    },

    cancelAll(runId) {
      const a = deps.access(runId);
      if (!a) return;
      for (const gate of Object.values(a.run.gates ?? {})) {
        if (!isWaiting(gate)) continue;
        gate.cancelled = true;
        a.touched(gate.gateId);
        emit(runId, gate.gateId, { kind: "cancelled", byDecider: false });
      }
      refreshCounts(a);
    },

    refreshCounts(runId) {
      const a = deps.access(runId);
      if (a) refreshCounts(a);
    },

    waitingGateOf(runId) {
      const a = deps.access(runId);
      if (!a) return undefined;
      const visit = (run: GateRunAccess, seen: Set<string>): WorkflowGateState | undefined => {
        if (seen.has(run.run.id)) return undefined;
        seen.add(run.run.id);
        const own = Object.values(run.run.gates ?? {}).find(isWaiting);
        if (own) return structuredClone(own);
        for (const child of run.children()) {
          const found = visit(child, seen);
          if (found) return found;
        }
        return undefined;
      };
      return visit(a, new Set());
    },

    async openPersonGate(runId, spec) {
      const a = deps.access(runId);
      if (!a || !a.alive()) throw new GateRefusal(409, "RUN_NOT_ACTIVE", "The run is no longer active.");
      const now = clock.now();
      const node = a.workflow.nodes.find((candidate) => candidate.id === spec.nodeId);
      const gate: WorkflowGateState = {
        gateId: deps.mintId(),
        runId,
        workflowId: a.run.workflowId,
        nodeId: spec.nodeId,
        nodeName: node?.name ?? spec.nodeId,
        ...(spec.pass !== undefined ? { pass: spec.pass } : {}),
        source: spec.source,
        ...(spec.edgeId !== undefined ? { edgeId: spec.edgeId } : {}),
        question: spec.question,
        ...(spec.details !== undefined ? { details: spec.details } : {}),
        choices: structuredClone(spec.choices),
        decider: { kind: "human", label: PERSON_LABEL },
        phase: "person",
        openedAt: now.toISOString(),
        phaseStartedAt: now.toISOString(),
        phaseDeadlineAt: personDeadline(now, undefined).toISOString(),
        escalated: false,
        ...(a.run.test ? { test: true } : {})
      };
      const root = rootOf(a);
      if (root.run.id !== runId) gate.rootRunId = root.run.id;
      host.put(runId, gate);
      await a.save();
      await notifyPerson(runId, gate.gateId);
      return host.get(runId, gate.gateId) ?? gate;
    },

    async awaitGate(runId, gateId, signal) {
      for (;;) {
        const a = deps.access(runId);
        const gate = a ? record(a, gateId) : undefined;
        if (!a || !gate || gate.cancelled === true || !a.alive()) return { kind: "cancelled" };
        if (gate.decision !== undefined) return { kind: "decided", decision: structuredClone(gate.decision), gate: structuredClone(gate) };
        if (gate.expired === true) return { kind: "expired", gate: structuredClone(gate) };
        if (signal.aborted) return { kind: "cancelled" };
        if (gate.phase === "person") await notifyPerson(runId, gateId);
        const round = new AbortController();
        const onAbort = (): void => round.abort();
        signal.addEventListener("abort", onAbort, { once: true });
        try {
          const deadline = new Date(gate.phaseDeadlineAt ?? personDeadline(new Date(gate.phaseStartedAt ?? gate.openedAt), undefined).toISOString());
          const outcome = await Promise.race([
            nextChange(runId, gateId, round.signal).then(() => "changed" as const),
            sleepUntil(clock, deadline, round.signal).then((reached) => (reached ? ("deadline" as const) : ("aborted" as const)))
          ]);
          if (outcome === "deadline" && gate.phase === "person") await expire(runId, gateId, { kind: "fail" });
        } finally {
          signal.removeEventListener("abort", onAbort);
          round.abort();
        }
      }
    }
  };
  return host;
}
