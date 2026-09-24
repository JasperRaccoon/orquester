/**
 * Synthetic thread logs for the fold's batch-retention and cache tests (design
 * `docs/superpowers/specs/2026-09-23-fold-performance-design.md`). Test
 * scaffolding, like `test-helpers.ts`: not exported from the package barrel,
 * typechecked with everything else.
 *
 * A log is a seeded random walk over what a real subagent-fleet thread
 * writes — parent tool rows, agents launched and finished (their anchors, some
 * nested under another agent), agent-owned rows, stable-id rows replaced in
 * place over and over (`task-progress:<taskId>`, an agent's
 * `tool-progress:<taskId>`), streamed messages, message-mode questions
 * answered much later, approvals, compaction markers (and, in the legacy
 * tables only, an older log's `thread.state.changed` rows), turns that settle
 * or stop, and rewinds — so every retention class trims many times; and, in
 * the long-call tables only, tool calls and background shells that stay open
 * over many steps while they stream output chunks. The same seed always
 * writes the same log.
 */

import { isDeepStrictEqual } from "node:util";

import { isCompactionActivity } from "./compaction.ts";
import type { DomainEvent } from "./domain-events.ts";
import {
  AGENT_ACTIVITY_RETENTION_LIMIT,
  __foldCacheConsistency,
  applyDomainEvent,
  createEmptyThreadState,
  foldThread,
  itemPositionOf,
  itemsDroppedByRetention
} from "./fold.ts";
import type { ThreadFoldState } from "./fold.ts";
import { deserializeFoldState, serializeFoldState } from "./fold-snapshot.ts";
import { openWorkOf } from "./open-work.ts";
import type { ThreadActivityItem, ThreadItem } from "./thread.ts";
import {
  activity,
  agentTask,
  created,
  ev,
  resetActivityIds,
  resetSeq,
  session
} from "./test-helpers.ts";

/** mulberry32: a tiny deterministic PRNG, so a log is a function of its seed. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type FleetAction =
  /** A parent tool row with a fresh id. */
  | "parent"
  /** An agent's `task-progress:` / `task-usage:` row: a parent row replaced in place. */
  | "progress"
  /** An agent-owned tool row with a fresh id. */
  | "agentRow"
  /** An agent's own `tool-progress:` row: agent-owned, replaced in place. */
  | "agentStable"
  /** An agent-owned row stamped with the SAME `createdAt` as another agent's last row. */
  | "tie"
  /** A new agent: its `task.started` anchor, sometimes owned by another agent (nested). */
  | "launch"
  /** A live agent's `task.completed` anchor. */
  | "finish"
  /** A finished agent relaunched under the same task id by a new tool call. */
  | "resume"
  /** A background shell: a task row that is NOT an anchor. */
  | "shell"
  /** A new message, streaming or not, sometimes an agent's. */
  | "message"
  /** A streamed delta onto the current message (or a new one). */
  | "delta"
  /** A message-mode question: exempt from the parent window while open. */
  | "question"
  /** The resolution of an open question, however old. */
  | "answer"
  | "approval"
  | "resolve"
  /** A compaction marker, sometimes agent-owned (only the parent window exempts it). */
  | "marker"
  /**
   * A thread-state row as an older log wrote it, `thread.state.changed`: with
   * `{state: "compacted"}` the settled compaction marker's legacy spelling
   * (the parent window exempts it, as it does `context-compaction`), with any
   * other state an ordinary row. Sometimes the previous one again, in another
   * state: replaced in place, it moves in or out of the exemption where it
   * stands. In no weight table but the legacy ones, so every other log stays
   * exactly what it was.
   */
  | "legacyState"
  /** The turn settles (or stops: a session-liveness change) and the next one starts. */
  | "turn"
  /** A rewind to an earlier turn. */
  | "revert"
  /** A message and an activity sharing an id (the index keeps the LAST position). */
  | "collide"
  /**
   * A tool call opens and stays open over many steps — the parent's, an
   * agent's, or a background shell's own `bgshell:` call, which opens with the
   * shell's `task.started` (a parent row, no anchor) and is owned by the shell.
   * Many are never closed, as a crash leaves them. In no weight table but the
   * long-call ones, so every other log stays exactly what it was.
   */
  | "openCall"
  /** A streamed output chunk (`tool.output`) of an open call, usually one opened last. */
  | "chunk"
  /** An open call completes or is denied; a shell's call ends with its task. */
  | "closeCall";

export interface FleetLogOptions {
  readonly seed: number;
  /** Generator steps; each writes one event, a few write two or three. */
  readonly steps: number;
  /** Relative weight of each action; a missing action does not happen. */
  readonly weights: Partial<Record<FleetAction, number>>;
  /** Agents launched at most (default 24). */
  readonly maxAgents?: number;
}

interface Agent {
  readonly taskId: string;
  toolUseId: string;
  /** The agent whose rows this one's anchors ride in (a nested agent), if any. */
  readonly owner: string | undefined;
  done: boolean;
  lastRowAt: string | null;
}

/** A call the log opened and has not closed (`openCall`). */
interface LoggedCall {
  readonly toolUseId: string;
  /** The window its rows ride in: an agent's, a shell's own, or the parent's. */
  readonly agentId: string | undefined;
  /** The background task a shell's call belongs to. */
  readonly shell: string | undefined;
}

/** A log shaped by `options.weights`, starting with `thread.created` and a first turn. */
export function fleetLog(options: FleetLogOptions): DomainEvent[] {
  resetSeq();
  resetActivityIds();
  const random = seededRandom(options.seed);
  const actions = (Object.entries(options.weights) as Array<[FleetAction, number]>).filter(
    ([, weight]) => weight > 0
  );
  const totalWeight = actions.reduce((sum, [, weight]) => sum + weight, 0);
  const pickAction = (): FleetAction => {
    let roll = random() * totalWeight;
    for (const [action, weight] of actions) {
      roll -= weight;
      if (roll < 0) return action;
    }
    return actions[actions.length - 1]![0];
  };
  const pick = <T>(list: readonly T[]): T | undefined =>
    list.length === 0 ? undefined : list[Math.floor(random() * list.length)];

  const maxAgents = options.maxAgents ?? 24;
  const events: DomainEvent[] = [created()];
  const agents: Agent[] = [];
  const openQuestions: string[] = [];
  const openApprovals: string[] = [];
  const openCalls: LoggedCall[] = [];
  const recentActivityIds: string[] = [];
  let lastMessageId: string | null = null;
  let lastStateRowId: string | null = null;
  let streaming: { id: string; agentId?: string } | null = null;
  let counter = 0;
  let turn = 0;
  let turnId = "";

  const appendRow = (row: ThreadActivityItem): void => {
    events.push(ev("thread.activity-appended", { activity: row }));
    recentActivityIds.push(row.id);
    if (recentActivityIds.length > 64) recentActivityIds.shift();
  };
  const liveAgents = (): Agent[] => agents.filter((agent) => !agent.done);
  const ownerRows = (agent: Agent): { agentId?: string } =>
    agent.owner !== undefined ? { agentId: agent.owner } : {};
  const startTurn = (): void => {
    turn += 1;
    turnId = `T-${turn}`;
    events.push(
      ev("thread.message-sent", {
        messageId: `user:${turn}`,
        role: "user",
        text: `ask ${turn}`,
        streaming: false,
        turnId: null
      }),
      ev("thread.turn-start-requested", {
        turnId: null,
        messageId: `user:${turn}`,
        interactionMode: "default"
      }),
      ev("thread.session-set", { session: session("running", turnId) })
    );
    lastMessageId = `user:${turn}`;
    streaming = null;
  };
  const newMessage = (): void => {
    counter += 1;
    const agent = random() < 0.3 ? pick(agents) : undefined;
    const isStreaming = random() < 0.6;
    const id = `m-${counter}`;
    events.push(
      ev("thread.message-sent", {
        messageId: id,
        role: random() < 0.15 ? "reasoning" : "assistant",
        text: `text ${counter}`,
        streaming: isStreaming,
        turnId,
        ...(agent !== undefined ? { agentId: agent.taskId } : {})
      })
    );
    lastMessageId = id;
    streaming = isStreaming
      ? { id, ...(agent !== undefined ? { agentId: agent.taskId } : {}) }
      : null;
  };

  startTurn();
  for (let step = 0; step < options.steps; step += 1) {
    const action = pickAction();
    switch (action) {
      case "parent": {
        counter += 1;
        const kinds = ["tool.started", "tool.completed", "context-window.updated", "runtime.warning"];
        appendRow(
          activity(kinds[Math.floor(random() * kinds.length)]!, { toolUseId: `tu-${counter}` }, {
            id: `p-${counter}`,
            // Some rows belong to no turn: a rewind never removes them.
            turnId: random() < 0.1 ? null : turnId
          })
        );
        break;
      }
      case "launch": {
        if (agents.length >= maxAgents) {
          break;
        }
        const taskId = `agent-${agents.length}`;
        const owner = random() < 0.25 ? pick(liveAgents())?.taskId : undefined;
        const agent: Agent = { taskId, toolUseId: `toolu-${taskId}-1`, owner, done: false, lastRowAt: null };
        agents.push(agent);
        appendRow(
          activity(
            "task.started",
            agentTask(taskId, {
              toolUseId: agent.toolUseId,
              title: `Agent ${taskId}`,
              ...(owner !== undefined ? { parentAgentId: owner } : {})
            }),
            { id: `start:${taskId}:${step}`, turnId, ...ownerRows(agent) }
          )
        );
        break;
      }
      case "finish": {
        const agent = pick(liveAgents());
        if (agent === undefined) break;
        agent.done = true;
        const statuses = ["completed", "completed", "stopped", "failed"];
        appendRow(
          activity(
            "task.completed",
            agentTask(agent.taskId, {
              status: statuses[Math.floor(random() * statuses.length)],
              summary: `done ${step}`
            }),
            { id: `done:${agent.taskId}:${step}`, turnId, ...ownerRows(agent) }
          )
        );
        break;
      }
      case "resume": {
        const agent = pick(agents.filter((candidate) => candidate.done));
        if (agent === undefined) break;
        agent.done = false;
        agent.toolUseId = `toolu-${agent.taskId}-${step}`;
        appendRow(
          activity("task.started", agentTask(agent.taskId, { toolUseId: agent.toolUseId }), {
            id: `start:${agent.taskId}:${step}`,
            turnId,
            ...ownerRows(agent)
          })
        );
        break;
      }
      case "progress": {
        const agent = pick(liveAgents()) ?? pick(agents);
        if (agent === undefined) break;
        const usage = random() < 0.35;
        appendRow(
          activity(
            "task.progress",
            usage
              ? agentTask(agent.taskId, {
                  usageSnapshot: true,
                  usage: { totalTokens: Math.floor(random() * 50_000) }
                })
              : agentTask(agent.taskId, { summary: `step ${step}`, lastToolName: "Read" }),
            { id: `${usage ? "task-usage" : "task-progress"}:${agent.taskId}`, turnId }
          )
        );
        break;
      }
      case "agentRow":
      case "tie": {
        const agent = pick(liveAgents()) ?? pick(agents);
        if (agent === undefined) break;
        counter += 1;
        // A tie reuses another agent's last stamp: the cross-agent ceiling
        // must then keep list order, whichever agent comes first.
        const other =
          action === "tie"
            ? pick(agents.filter((candidate) => candidate !== agent && candidate.lastRowAt !== null))
            : undefined;
        const row = activity("tool.completed", { toolUseId: `tu-${counter}` }, {
          id: `r-${counter}`,
          turnId,
          agentId: agent.taskId,
          ...(other !== undefined && other.lastRowAt !== null ? { createdAt: other.lastRowAt } : {})
        });
        agent.lastRowAt = row.createdAt;
        appendRow(row);
        break;
      }
      case "agentStable": {
        const agent = pick(liveAgents()) ?? pick(agents);
        if (agent === undefined) break;
        appendRow(
          activity("tool.progress", { taskId: agent.taskId, toolName: `Tool${step % 5}` }, {
            id: `tool-progress:${agent.taskId}`,
            turnId,
            agentId: agent.taskId
          })
        );
        break;
      }
      case "shell": {
        counter += 1;
        appendRow(
          activity(
            random() < 0.5 ? "task.started" : "task.updated",
            { taskId: `shell-${counter % 7}`, isBackgrounded: true, description: "npm run dev" },
            { id: `shell-row-${counter}`, turnId }
          )
        );
        break;
      }
      case "message":
        newMessage();
        break;
      case "delta": {
        const current: { id: string; agentId?: string } | null = streaming;
        if (current === null) {
          newMessage();
          break;
        }
        const finished = random() < 0.2;
        events.push(
          ev("thread.message-sent", {
            messageId: current.id,
            role: "assistant",
            text: finished ? "" : ` more ${step}`,
            streaming: !finished,
            turnId,
            ...(current.agentId !== undefined ? { agentId: current.agentId } : {})
          })
        );
        if (finished) streaming = null;
        break;
      }
      case "question": {
        counter += 1;
        const requestId = `q-${counter}`;
        openQuestions.push(requestId);
        appendRow(
          activity(
            "user-input.requested",
            {
              requestId,
              responseMode: "message",
              questions: [{ id: "which", header: "Pick", question: "Which?", options: [{ label: "A" }] }]
            },
            { id: `ask-${requestId}`, turnId }
          )
        );
        break;
      }
      case "answer": {
        // Usually the OLDEST open question: answered long after it was asked.
        const requestId = random() < 0.7 ? openQuestions.shift() : openQuestions.pop();
        if (requestId === undefined) break;
        appendRow(activity("user-input.resolved", { requestId, answers: {} }, { turnId }));
        break;
      }
      case "approval": {
        counter += 1;
        const requestId = `ap-${counter}`;
        openApprovals.push(requestId);
        appendRow(
          activity("approval.requested", { requestId, requestType: "command_execution_approval" }, {
            turnId
          })
        );
        break;
      }
      case "resolve": {
        const requestId = openApprovals.shift();
        if (requestId === undefined) break;
        appendRow(activity("approval.resolved", { requestId, decision: "accept" }, { turnId }));
        break;
      }
      case "marker": {
        counter += 1;
        const agent = random() < 0.3 ? pick(agents) : undefined;
        appendRow(
          activity("context-compaction", { state: "compacted", beforeTokens: 100, afterTokens: 10 }, {
            id: `marker-${counter}`,
            turnId: random() < 0.3 ? null : turnId,
            ...(agent !== undefined ? { agentId: agent.taskId } : {})
          })
        );
        break;
      }
      case "legacyState": {
        counter += 1;
        const agent = random() < 0.3 ? pick(agents) : undefined;
        const roll = random();
        const state = roll < 0.5 ? "compacted" : roll < 0.75 ? "compacting" : "running";
        const id: string =
          lastStateRowId !== null && random() < 0.3 ? lastStateRowId : `state-${counter}`;
        lastStateRowId = id;
        appendRow(
          activity("thread.state.changed", { state }, {
            id,
            summary: state === "compacted" ? "Context compacted" : `State ${state}`,
            turnId: random() < 0.3 ? null : turnId,
            ...(agent !== undefined ? { agentId: agent.taskId } : {})
          })
        );
        break;
      }
      case "turn": {
        events.push(
          ev("thread.session-set", {
            session: session(random() < 0.3 ? "stopped" : "ready", null)
          })
        );
        startTurn();
        break;
      }
      case "revert": {
        if (turn < 2) break;
        // Undo the running turn, sometimes the one before it too — what
        // "rewind to here" usually does. Turns are short, so a rewind removes
        // a slice of the window, not all of it.
        events.push(
          ev("thread.reverted", { turnCount: Math.max(0, turn - 1 - Math.floor(random() * 2)) })
        );
        startTurn();
        break;
      }
      case "collide": {
        if (random() < 0.5 && recentActivityIds.length > 0) {
          // A message that takes an activity's id: the index must now find the
          // message (the LAST row with that id), and a delta merges onto it.
          const id = pick(recentActivityIds)!;
          events.push(
            ev("thread.message-sent", {
              messageId: id,
              role: "assistant",
              text: "shared id",
              streaming: true,
              turnId
            })
          );
          streaming = { id };
          lastMessageId = id;
        } else if (lastMessageId !== null) {
          // An activity that takes a message's id: appended, never merged.
          appendRow(activity("tool.started", { toolUseId: "shared" }, { id: lastMessageId, turnId }));
        }
        break;
      }
      case "openCall": {
        counter += 1;
        const roll = random();
        if (roll < 0.2) {
          // A background shell: its task row in the parent's window, its own
          // call in the shell's, as Claude's `bgshell:<taskId>` item is.
          const taskId = `bg-${counter}`;
          appendRow(
            activity(
              "task.started",
              { taskId, agentKind: "background", taskType: "local_bash", isBackgrounded: true, description: `npm run dev ${counter}` },
              { id: `bg-start-${counter}`, turnId }
            )
          );
          const call: LoggedCall = { toolUseId: `bgshell:${taskId}`, agentId: taskId, shell: taskId };
          openCalls.push(call);
          appendRow(
            activity("tool.started", { itemType: "command_execution", toolUseId: call.toolUseId, title: "Background shell" }, {
              id: `open-${counter}`,
              turnId,
              agentId: taskId
            })
          );
          break;
        }
        const agent = roll < 0.55 ? (pick(liveAgents()) ?? pick(agents)) : undefined;
        const call: LoggedCall = { toolUseId: `call-${counter}`, agentId: agent?.taskId, shell: undefined };
        openCalls.push(call);
        // Most calls open with their start; some only with an update (a Claude
        // tool whose input streamed before anything else was said of it).
        appendRow(
          activity(random() < 0.8 ? "tool.started" : "tool.updated", { itemType: "command_execution", toolUseId: call.toolUseId, title: `cmd ${counter}` }, {
            id: `open-${counter}`,
            turnId,
            ...(call.agentId !== undefined ? { agentId: call.agentId } : {})
          })
        );
        break;
      }
      case "chunk": {
        // Usually one of the calls opened last — a few streaming commands among
        // many a crash left open and quiet — else any open call.
        const recent = Math.min(3, openCalls.length);
        const call =
          random() < 0.75 && recent > 0
            ? openCalls[openCalls.length - 1 - Math.floor(random() * recent)]
            : pick(openCalls);
        if (call === undefined) break;
        counter += 1;
        appendRow(
          activity("tool.output", { toolUseId: call.toolUseId, streamKind: "command_output", delta: `out ${counter}\n` }, {
            id: `chunk-${counter}`,
            summary: "Tool output",
            turnId,
            ...(call.agentId !== undefined ? { agentId: call.agentId } : {})
          })
        );
        break;
      }
      case "closeCall": {
        if (openCalls.length === 0) break;
        const [call] = openCalls.splice(Math.floor(random() * openCalls.length), 1);
        counter += 1;
        const denied = random() >= 0.85;
        appendRow(
          activity(
            denied ? "tool.denied" : "tool.completed",
            denied
              ? { toolName: "Bash", toolUseId: call!.toolUseId }
              : { itemType: "command_execution", toolUseId: call!.toolUseId, status: "completed" },
            {
              id: `close-${counter}`,
              turnId,
              ...(call!.agentId !== undefined ? { agentId: call!.agentId } : {})
            }
          )
        );
        if (call!.shell !== undefined) {
          appendRow(
            activity("task.completed", { taskId: call!.shell, agentKind: "background", status: "completed" }, {
              id: `bg-done-${counter}`,
              turnId
            })
          );
        }
        break;
      }
      default:
        void (action satisfies never);
    }
  }
  return events;
}

/**
 * The shapes the tests fold, each trimming its classes many times: `FLEET` all
 * of them at once (no rewinds, so a reference model can follow it), the others
 * one family each, with windows small enough to restore at every split point.
 */
export const FLEET_WEIGHTS: Partial<Record<FleetAction, number>> = {
  parent: 14,
  progress: 5,
  agentRow: 30,
  tie: 2,
  agentStable: 3,
  launch: 0.5,
  finish: 0.3,
  resume: 0.1,
  shell: 0.4,
  message: 30,
  delta: 8,
  question: 0.25,
  answer: 0.18,
  approval: 0.3,
  resolve: 0.25,
  marker: 0.15,
  turn: 0.12,
  collide: 0.15
};

/** Parent rows past their window, questions, markers, approvals, stable-id rows, rewinds. */
export const PARENT_WEIGHTS: Partial<Record<FleetAction, number>> = {
  parent: 30,
  progress: 8,
  agentRow: 4,
  agentStable: 1,
  launch: 0.8,
  finish: 0.5,
  resume: 0.2,
  shell: 1,
  message: 6,
  delta: 5,
  question: 1.2,
  answer: 0.8,
  approval: 1,
  resolve: 0.8,
  marker: 0.6,
  turn: 0.8,
  revert: 0.12,
  collide: 0.3
};

/** A few agents, each past its own window (with `maxAgents` ~5). */
export const AGENT_WEIGHTS: Partial<Record<FleetAction, number>> = {
  parent: 8,
  progress: 6,
  agentRow: 45,
  tie: 3,
  agentStable: 4,
  launch: 0.4,
  finish: 0.3,
  resume: 0.2,
  shell: 0.4,
  message: 3,
  delta: 2,
  marker: 0.3,
  turn: 0.4,
  revert: 0.05
};

/**
 * Many agents, all launched at once and never finishing, so their rows spread
 * evenly: each stays inside its own window while together they pass the
 * ceiling across agents (with `maxAgents` 14).
 */
export const AGENT_CEILING_WEIGHTS: Partial<Record<FleetAction, number>> = {
  parent: 3,
  progress: 3,
  agentRow: 60,
  tie: 6,
  agentStable: 2,
  launch: 30,
  message: 1,
  delta: 1,
  turn: 0.3,
  revert: 0.03
};

/**
 * Task rows above all — launches, finishes, resumes, progress and usage rows
 * replaced in place, background shells, agent heartbeats — with turns that
 * stop (a session-liveness change) and rewinds, past the roster's 100-row cap
 * (with `maxAgents` 110). No id collisions: a row replaced in place by a row of
 * another KIND is the one case the roster is not re-derived on (the fold
 * decides on the incoming row's kind, as it always has).
 */
export const TASK_WEIGHTS: Partial<Record<FleetAction, number>> = {
  parent: 6,
  progress: 22,
  agentRow: 10,
  agentStable: 6,
  launch: 3,
  finish: 2,
  resume: 0.6,
  shell: 3,
  message: 3,
  delta: 2,
  approval: 0.5,
  resolve: 0.4,
  turn: 0.5,
  revert: 0.1
};

/**
 * {@link PARENT_WEIGHTS} with few messages: the same parent-window traffic in
 * a window small enough to restore through JSON at every split point.
 */
export const LEAN_PARENT_WEIGHTS: Partial<Record<FleetAction, number>> = {
  ...PARENT_WEIGHTS,
  agentRow: 1,
  message: 1,
  delta: 1
};

/**
 * {@link LEAN_PARENT_WEIGHTS} plus an older log's thread-state rows
 * (`legacyState`): legacy compaction markers the parent window must keep
 * whatever their age, other states it drops like any row, and rows moved in
 * or out of the exemption in place — small enough to restore through JSON at
 * every split point.
 */
export const LEGACY_PARENT_WEIGHTS: Partial<Record<FleetAction, number>> = {
  ...LEAN_PARENT_WEIGHTS,
  legacyState: 2.5
};

/**
 * {@link FLEET_WEIGHTS} plus an older log's thread-state rows, a few of them
 * agent-owned: an agent's legacy marker is an ordinary row of its agent's
 * window, as its `context-compaction` marker is.
 */
export const LEGACY_FLEET_WEIGHTS: Partial<Record<FleetAction, number>> = {
  ...FLEET_WEIGHTS,
  legacyState: 1.5
};

/** Past the message window, with streamed deltas and a few activities. */
export const MESSAGE_WEIGHTS: Partial<Record<FleetAction, number>> = {
  parent: 2,
  agentRow: 1,
  launch: 0.1,
  progress: 0.5,
  message: 60,
  delta: 20,
  question: 0.2,
  answer: 0.2,
  turn: 0.3,
  revert: 0.05,
  collide: 0.3
};

/**
 * Long-running work: calls and background shells that stay open while their
 * output chunks stream past the parent's window and a few agents' own (with
 * `maxAgents` 4–6), beside calls left open and quiet — the parent rows'
 * `tool.started` among them — calls that end, turns and a few rewinds.
 */
export const LONG_CALL_WEIGHTS: Partial<Record<FleetAction, number>> = {
  parent: 3,
  agentRow: 6,
  launch: 0.3,
  finish: 0.1,
  message: 2,
  delta: 1,
  openCall: 0.4,
  chunk: 30,
  closeCall: 0.25,
  turn: 0.15,
  revert: 0.03
};

/**
 * {@link LONG_CALL_WEIGHTS} leaner: one agent (with `maxAgents` 1), few
 * messages and agent rows, and parent-owned chunks dense enough that the
 * parent's window trims within the first thousand events — a window small
 * enough to restore through JSON at every split point.
 */
export const LEAN_LONG_CALL_WEIGHTS: Partial<Record<FleetAction, number>> = {
  parent: 1,
  agentRow: 1,
  launch: 0.3,
  finish: 0.05,
  message: 0.3,
  delta: 0.2,
  openCall: 0.35,
  chunk: 30,
  closeCall: 0.2,
  turn: 0.15,
  revert: 0.05
};

/**
 * {@link AGENT_CEILING_WEIGHTS} with long-running work: many agents past the
 * ceiling across them (with `maxAgents` 14) while some of their calls — and
 * shells, each a window of its own — stay open and stream.
 */
export const LONG_CALL_CEILING_WEIGHTS: Partial<Record<FleetAction, number>> = {
  ...AGENT_CEILING_WEIGHTS,
  openCall: 2,
  chunk: 20,
  closeCall: 0.6
};

// ---------------------------------------------------------------------------
// Snapshot + tail ≡ the whole log, at every split point
// ---------------------------------------------------------------------------

/** `state` through the real codec and JSON, as `state.json` stores it. */
export function throughJson(state: ThreadFoldState): ThreadFoldState {
  const restored = deserializeFoldState(JSON.parse(JSON.stringify(serializeFoldState(state))));
  if (restored === null) {
    throw new Error("a fold state must survive its own snapshot");
  }
  return restored;
}

/**
 * `state` as a restore builds it, without the codec's validation: the same
 * values, the activity list rebuilt from `items` as the same objects — and,
 * being a new object, none of the fold's caches.
 */
export function withoutCaches(state: ThreadFoldState): ThreadFoldState {
  return {
    ...state,
    activities: state.items.filter((item): item is ThreadActivityItem => item.kind === "activity")
  };
}

/** The activity list is the activity subset of `items`, as the very same objects, in order. */
export function activitiesMatchItems(state: ThreadFoldState): boolean {
  let next = 0;
  for (const item of state.items) {
    if (item.kind !== "activity") continue;
    if (state.activities[next] !== item) return false;
    next += 1;
  }
  return next === state.activities.length;
}

export interface SplitCheckOptions {
  /**
   * Restore the prefix's fold through serialize → JSON → deserialize at this
   * split; elsewhere {@link withoutCaches} restores it, which folds the same
   * way at a fraction of the cost (the codec's own round trip is checked at
   * the JSON splits). Default: every split.
   */
  readonly jsonAt?: (split: number) => boolean;
  /**
   * Also fold the WHOLE tail from this split's restore and deep-compare it
   * with the whole log's fold. Default: none.
   */
  readonly literalAt?: (split: number) => boolean;
}

const rowKey = (item: ThreadItem): string => `${item.kind}:${item.id}`;

/**
 * For every split point `k` — the fold of the first `k` events, restored with
 * none of the fold's caches — fold event `k` onto the restore and require the
 * very state the whole-log fold reached at that step, the same rows dropped
 * by retention, and caches on the restored path that agree with its arrays.
 * That is what "a snapshot at any seq, folded forward through the tail, is the
 * whole-log fold" (design `2026-09-23-fold-performance-design.md`, B) needs at
 * every split: once two folds hold equal states whose caches both agree with
 * their arrays, every later event folds them to equal states again, because
 * the caches are the only thing a step reads beside the state. Where
 * {@link SplitCheckOptions.literalAt} says so, the whole tail is folded too.
 *
 * On a JSON restore "the very state" is compared in its persisted form — the
 * complete state but the activity list, which must be the items' own rows
 * ({@link activitiesMatchItems}) — since the restore shares no object with
 * the whole-log fold and a structural walk costs twice as much; everywhere
 * else with `isDeepStrictEqual`. Returns the splits that disagreed.
 */
export function splitDivergences(
  events: readonly DomainEvent[],
  options: SplitCheckOptions = {}
): string[] {
  const whole = foldThread(events);
  const diverged: string[] = [];
  let state = createEmptyThreadState();
  let stateJson: string | null = null;
  for (let split = 0; split < events.length; split += 1) {
    const event = events[split]!;
    const next = applyDomainEvent(state, event);
    const viaJson = options.jsonAt?.(split) ?? true;
    let nextJson: string | null = null;
    let restored: ThreadFoldState;
    if (viaJson) {
      stateJson ??= JSON.stringify(serializeFoldState(state));
      const parsed = deserializeFoldState(JSON.parse(stateJson));
      if (parsed === null) {
        diverged.push(`split ${split}: the snapshot does not restore`);
        state = next;
        stateJson = null;
        continue;
      }
      restored = parsed;
    } else {
      restored = withoutCaches(state);
    }
    const first = applyDomainEvent(restored, event);

    let same: boolean;
    if (viaJson) {
      nextJson = JSON.stringify(serializeFoldState(next));
      same = JSON.stringify(serializeFoldState(first)) === nextJson && activitiesMatchItems(first);
    } else {
      same = isDeepStrictEqual(first, next);
    }
    const droppedFirst = itemsDroppedByRetention(first).map(rowKey).join("|");
    const droppedNext = itemsDroppedByRetention(next).map(rowKey).join("|");
    if (!same) {
      diverged.push(`split ${split}: event ${split} (${event.type}) folds the restore to another state`);
    } else if (droppedFirst !== droppedNext) {
      diverged.push(`split ${split}: the restore's trim dropped other rows`);
    } else {
      const caches = __foldCacheConsistency(first, { roster: false });
      if (caches !== null) diverged.push(`split ${split}: the restored path's caches: ${caches}`);
    }

    if (options.literalAt?.(split) === true) {
      let tail = throughJson(state);
      for (let index = split; index < events.length; index += 1) {
        tail = applyDomainEvent(tail, events[index]!);
      }
      if (!isDeepStrictEqual(tail, whole)) {
        diverged.push(`split ${split}: the restore folded through the whole tail is not the whole-log fold`);
      }
    }
    state = next;
    stateJson = nextJson;
  }
  if (!isDeepStrictEqual(state, whole)) {
    diverged.push("the one-event-at-a-time fold is not foldThread's");
  }
  return diverged;
}

/** The indexes of the events at which the whole-log fold trimmed, and at which it rewound. */
export function landmarks(events: readonly DomainEvent[]): { trims: number[]; reverts: number[] } {
  const trims: number[] = [];
  const reverts: number[] = [];
  let state = createEmptyThreadState();
  events.forEach((event, index) => {
    state = applyDomainEvent(state, event);
    if (itemsDroppedByRetention(state).length > 0) trims.push(index);
    if (event.type === "thread.reverted") reverts.push(index);
  });
  return { trims, reverts };
}

/** True within `radius` events of any of `points`. */
export function near(points: readonly number[], radius: number): (split: number) => boolean {
  const marked = new Set<number>();
  for (const point of points) {
    for (let split = point - radius; split <= point + radius; split += 1) marked.add(split);
  }
  return (split) => marked.has(split);
}

/** What retention did with a log's `thread.state.changed` rows ({@link legacyStateFate}). */
export interface LegacyStateFate {
  /** Parent legacy markers retention dropped — never, while the exemption holds. */
  readonly droppedParentMarkers: number;
  /** Agent-owned legacy markers retention dropped with their agent's window. */
  readonly droppedAgentMarkers: number;
  /** Rows in any other state retention dropped, as it drops any row. */
  readonly droppedOtherStates: number;
  /**
   * Parent legacy markers the final window holds although a parent row
   * positioned after them was dropped: a trim reached past them, and only the
   * exemption kept them. A row replaced in place keeps its old position, so it
   * counts from there, not from its latest write.
   */
  readonly keptPastATrim: number;
  /**
   * Parent rows replaced in place by a parent row on the other side of the
   * exemption: a marker settling from another state, or the reverse — the
   * row moves between the kept and the droppable class where it stands.
   */
  readonly movedInPlace: number;
}

/**
 * Folds `events` one at a time and says what retention did with their
 * `thread.state.changed` rows (the `legacyState` action) — what a legacy log
 * test must show its log really exercised. Reads the rule from `compaction.ts`:
 * this measures a log, it does not check the fold.
 */
export function legacyStateFate(events: readonly DomainEvent[]): LegacyStateFate {
  let droppedParentMarkers = 0;
  let droppedAgentMarkers = 0;
  let droppedOtherStates = 0;
  let movedInPlace = 0;
  const isStateRow = (row: ThreadActivityItem): boolean => row.activityKind === "thread.state.changed";
  const isParentRow = (row: ThreadActivityItem): boolean =>
    typeof row.agentId !== "string" || row.agentId.length === 0;
  // The step each row object's POSITION was taken at: the fold keeps the
  // event's own object, and a row replaced in place keeps its old position, so
  // its new object takes the step of the one it replaced — retention drops by
  // position, oldest first, never by the time of a row's latest write.
  const stepOf = new Map<ThreadActivityItem, number>();
  let youngestDroppedParentStep = -1;
  let state = createEmptyThreadState();
  events.forEach((event, step) => {
    if (event.type === "thread.activity-appended") {
      const row = event.payload.activity;
      const at = itemPositionOf(state, row.id);
      const existing = at === undefined ? undefined : state.items[at];
      stepOf.set(row, existing?.kind === "activity" ? (stepOf.get(existing) ?? step) : step);
      if (
        existing?.kind === "activity" &&
        (isStateRow(existing) || isStateRow(row)) &&
        isParentRow(existing) &&
        isParentRow(row) &&
        isCompactionActivity(existing) !== isCompactionActivity(row)
      ) {
        movedInPlace += 1;
      }
    }
    state = applyDomainEvent(state, event);
    for (const item of itemsDroppedByRetention(state)) {
      if (item.kind !== "activity") continue;
      if (isParentRow(item)) {
        youngestDroppedParentStep = Math.max(youngestDroppedParentStep, stepOf.get(item) ?? -1);
      }
      if (!isStateRow(item)) continue;
      if (!isCompactionActivity(item)) droppedOtherStates += 1;
      else if (isParentRow(item)) droppedParentMarkers += 1;
      else droppedAgentMarkers += 1;
    }
  });
  const keptPastATrim = state.activities.filter(
    (row) =>
      isStateRow(row) &&
      isParentRow(row) &&
      isCompactionActivity(row) &&
      (stepOf.get(row) ?? Number.POSITIVE_INFINITY) < youngestDroppedParentStep
  ).length;
  return { droppedParentMarkers, droppedAgentMarkers, droppedOtherStates, keptPastATrim, movedInPlace };
}

/** What retention did with the opening rows of running work ({@link openWorkFate}). */
export interface OpenWorkFate {
  /**
   * Opening rows of open calls a trim reached past in their own window — a row
   * of the parent's or of their agent's window positioned after them was
   * dropped — and kept: only the exemption keeps such a row. Distinct rows.
   */
  readonly callsKeptPastATrim: number;
  /** The same for open background tasks' `task.started` rows. */
  readonly tasksKeptPastATrim: number;
  /**
   * Agent-owned opening rows of open work the cross-agent ceiling reached past
   * — it dropped a row that was inside its own agent's window and stamped
   * after them — and kept. Distinct rows.
   */
  readonly keptPastTheCeiling: number;
  /** Opening rows retention dropped while their work was still open: past a cap. */
  readonly droppedWhileOpen: number;
  /** Opening rows retention dropped once their work had ended: the exemption ends with it. */
  readonly droppedAfterClose: number;
}

/**
 * Folds `events` one at a time and says what retention did with the opening
 * rows of running work — what a long-call log test must show its log really
 * exercised. Reads which work is open from `open-work.ts`, over the window
 * each trim ran on: this measures a log, it does not check the fold.
 */
export function openWorkFate(events: readonly DomainEvent[]): OpenWorkFate {
  const callsKept = new Set<ThreadActivityItem>();
  const tasksKept = new Set<ThreadActivityItem>();
  const ceilingKept = new Set<ThreadActivityItem>();
  let droppedWhileOpen = 0;
  let droppedAfterClose = 0;
  const windowOf = (row: ThreadActivityItem): string =>
    typeof row.agentId === "string" && row.agentId.length > 0 ? row.agentId : "";
  const nonBlank = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
  // The step each row object's POSITION was taken at, as in `legacyStateFate`.
  const stepOf = new Map<ThreadActivityItem, number>();
  let state = createEmptyThreadState();
  events.forEach((event, step) => {
    let row: ThreadActivityItem | undefined;
    let replaced: ThreadActivityItem | undefined;
    if (event.type === "thread.activity-appended") {
      row = event.payload.activity;
      const at = itemPositionOf(state, row.id);
      const existing = at === undefined ? undefined : state.items[at];
      if (existing?.kind === "activity") replaced = existing;
      stepOf.set(row, replaced !== undefined ? (stepOf.get(replaced) ?? step) : step);
    }
    const next = applyDomainEvent(state, event);
    const dropped = itemsDroppedByRetention(next).filter(
      (item): item is ThreadActivityItem => item.kind === "activity"
    );
    if (dropped.length > 0) {
      // The window the step's trim ran over: the previous one with the step's row in it.
      const pre =
        row === undefined
          ? state.activities
          : replaced !== undefined
            ? state.activities.map((candidate) => (candidate === replaced ? row! : candidate))
            : [...state.activities, row];
      const work = openWorkOf(pre);
      const open = new Map<ThreadActivityItem, "call" | "task">();
      for (const call of work.calls) open.set(call.opening, "call");
      for (const task of work.tasks) open.set(task.start, "task");
      // Every call's and background task's opening row, open or ended.
      const openings = new Set<ThreadActivityItem>();
      const calls = new Set<string>();
      const tasks = new Set<string>();
      for (const candidate of pre) {
        const payload = candidate.payload as Record<string, unknown> | null;
        if (payload === null || typeof payload !== "object") continue;
        const kind = candidate.activityKind;
        if ((kind === "tool.started" || kind === "tool.updated") && nonBlank(payload.toolUseId) && !calls.has(payload.toolUseId)) {
          calls.add(payload.toolUseId);
          openings.add(candidate);
        } else if (kind === "task.started" && payload.agentKind !== "agent" && nonBlank(payload.taskId) && !tasks.has(payload.taskId)) {
          tasks.add(payload.taskId);
          openings.add(candidate);
        }
      }
      for (const gone of dropped) {
        if (open.has(gone)) droppedWhileOpen += 1;
        else if (openings.has(gone)) droppedAfterClose += 1;
      }
      // Per window, the position of the youngest row the trim dropped.
      const youngestDropped = new Map<string, number>();
      for (const gone of dropped) {
        const window = windowOf(gone);
        youngestDropped.set(window, Math.max(youngestDropped.get(window) ?? -1, stepOf.get(gone) ?? -1));
      }
      // How far the ceiling reached: the latest stamp among the dropped rows
      // that were inside their own agent's window — only the ceiling drops those.
      const owners = new Set(dropped.map(windowOf).filter((window) => window !== ""));
      const byOwner = new Map<string, ThreadActivityItem[]>();
      for (const candidate of pre) {
        const window = windowOf(candidate);
        if (!owners.has(window)) continue;
        const rows = byOwner.get(window);
        if (rows) rows.push(candidate);
        else byOwner.set(window, [candidate]);
      }
      const insideOwnWindow = new Set<ThreadActivityItem>();
      for (const rows of byOwner.values()) {
        for (const candidate of rows.slice(-AGENT_ACTIVITY_RETENTION_LIMIT)) insideOwnWindow.add(candidate);
      }
      let reach: string | null = null;
      for (const gone of dropped) {
        if (insideOwnWindow.has(gone) && (reach === null || gone.createdAt > reach)) reach = gone.createdAt;
      }
      const droppedSet = new Set(dropped);
      for (const [opening, kind] of open) {
        if (droppedSet.has(opening)) continue;
        const window = windowOf(opening);
        if ((stepOf.get(opening) ?? Number.POSITIVE_INFINITY) < (youngestDropped.get(window) ?? -1)) {
          (kind === "call" ? callsKept : tasksKept).add(opening);
        }
        if (window !== "" && reach !== null && opening.createdAt < reach) ceilingKept.add(opening);
      }
    }
    state = next;
  });
  return {
    callsKeptPastATrim: callsKept.size,
    tasksKeptPastATrim: tasksKept.size,
    keptPastTheCeiling: ceilingKept.size,
    droppedWhileOpen,
    droppedAfterClose
  };
}
