/**
 * What a host start closes of the work a dead process left open
 * (`leftover-work.ts`): which calls, tasks and messages the folded window
 * still shows running, and the rows that end each one — shaped as the
 * adapters' own teardown writes them, in the class of the row that opened it.
 * The first load and the orphaned-thread reconcile that append them are
 * `reconcile.test.ts`'s.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyDomainEvent,
  foldSubagentActivities,
  foldThread,
  openWorkOf,
  type DomainEvent,
  type ThreadActivityItem,
  type ThreadFoldState
} from "@orquester/api/agent-chat";

import { LEFTOVER_CALL_DETAIL, leftoverWorkClosings, type LeftoverClosing } from "./leftover-work.ts";

const THREAD = "thread-lw";
const AT = "2026-09-24T10:00:00.000Z";
const NOW = "2026-09-24T12:00:00.000Z";

type Unsequenced = Omit<DomainEvent, "seq">;

/** An event before the store numbers it: `foldOf` and `applied` assign the seq, in order. */
function event<TType extends DomainEvent["type"]>(
  type: TType,
  payload: Extract<DomainEvent, { type: TType }>["payload"]
): Unsequenced {
  return {
    eventId: `e-${type}`,
    threadId: THREAD,
    type,
    payload,
    occurredAt: AT,
    commandId: null,
    causationEventId: null,
    metadata: {}
  } as Unsequenced;
}

const sequenced = (events: readonly Unsequenced[], after: number): DomainEvent[] =>
  events.map((unsequenced, index) => ({ ...unsequenced, seq: after + index + 1 }) as DomainEvent);

const created = (): Unsequenced =>
  event("thread.created", {
    projectPath: "/work/project",
    cwd: "/work/project",
    title: "Leftovers",
    adapter: "claude",
    refId: "claude",
    accountId: "acc1",
    home: "account",
    modelSelection: { model: "test-model" },
    runtimeMode: "approval-required"
  });

/** An activity row as ingestion writes it; `over` sets the envelope (owner, turn, tone). */
function row(
  id: string,
  activityKind: string,
  payload: Record<string, unknown>,
  over: Partial<ThreadActivityItem> = {}
): Unsequenced {
  return event("thread.activity-appended", {
    activity: {
      kind: "activity",
      id,
      tone: activityKind.startsWith("tool.") ? "tool" : "info",
      activityKind,
      summary: activityKind,
      payload,
      turnId: null,
      createdAt: AT,
      updatedAt: AT,
      ...over
    }
  });
}

const said = (
  messageId: string,
  role: "assistant" | "reasoning" | "user",
  text: string,
  streaming: boolean,
  extra: {
    turnId?: string | null;
    agentId?: string;
    reasoningKind?: "text" | "summary";
    messageKind?: "answer" | "commentary";
  } = {}
): Unsequenced =>
  event("thread.message-sent", {
    messageId,
    role,
    text,
    streaming,
    turnId: extra.turnId ?? null,
    ...(extra.agentId !== undefined ? { agentId: extra.agentId } : {}),
    ...(extra.reasoningKind !== undefined ? { reasoningKind: extra.reasoningKind } : {}),
    ...(extra.messageKind !== undefined ? { messageKind: extra.messageKind } : {})
  });

function foldOf(events: readonly Unsequenced[]): ThreadFoldState {
  return foldThread(sequenced([created(), ...events], 0));
}

function closingsOf(state: ThreadFoldState, closed?: ReadonlySet<string>): LeftoverClosing[] {
  let next = 0;
  return leftoverWorkClosings(state, {
    now: NOW,
    nextId: () => `closing-${(next += 1)}`,
    ...(closed !== undefined ? { closed } : {})
  });
}

/** The closings folded onto `state`, as `commit` folds what the store appended. */
function applied(state: ThreadFoldState, closings: readonly LeftoverClosing[]): ThreadFoldState {
  const events = sequenced(
    closings.map((closing) => event(closing.type, closing.payload as never)),
    state.seq
  );
  return events.reduce(applyDomainEvent, state);
}

const activityOf = (closing: LeftoverClosing | undefined): ThreadActivityItem => {
  assert.equal(closing?.type, "thread.activity-appended");
  return (closing!.payload as { activity: ThreadActivityItem }).activity;
};

describe("leftoverWorkClosings — what a dead process left open", () => {
  it("closes every open call `failed`, with its latest lifecycle row's item type, title, turn, owner and data", () => {
    const state = foldOf([
      // A parent call the provider was running: its start, then its input.
      row("p-start", "tool.started", {
        itemType: "command_execution",
        toolUseId: "toolu_parent",
        status: "inProgress",
        title: "Bash",
        data: { toolName: "Bash", input: {} }
      }, { turnId: "turn-1", status: "inProgress" }),
      row("p-update", "tool.updated", {
        itemType: "command_execution",
        toolUseId: "toolu_parent",
        status: "inProgress",
        title: "Bash",
        data: { toolName: "Bash", input: { command: "npm test" } }
      }, { turnId: "turn-1", status: "inProgress" }),
      // A subagent's call, between parent turns, nested under the call that launched it.
      row("a-start", "tool.started", {
        itemType: "file_change",
        toolUseId: "toolu_agent_call",
        status: "inProgress",
        title: "Edit",
        agentId: "agent-1",
        parentToolUseId: "toolu_launch",
        data: { toolName: "Edit", input: { file_path: "/work/project/a.ts" } }
      }, { agentId: "agent-1", parentToolUseId: "toolu_launch" }),
      // Calls that are over: a completion or a denial closes one for good.
      row("done-start", "tool.started", { itemType: "command_execution", toolUseId: "toolu_done", title: "ls" }),
      row("done-end", "tool.completed", { itemType: "command_execution", toolUseId: "toolu_done", status: "completed", title: "ls" }),
      row("denied-start", "tool.started", { itemType: "command_execution", toolUseId: "toolu_denied", title: "rm" }),
      row("denied-end", "tool.denied", { toolName: "Bash", toolUseId: "toolu_denied" })
    ]);

    const closings = closingsOf(state);
    assert.deepEqual(closings.map((closing) => closing.key), ["call:toolu_parent", "call:toolu_agent_call"]);
    assert.deepEqual(activityOf(closings[0]), {
      kind: "activity",
      id: "closing-1",
      tone: "tool",
      activityKind: "tool.completed",
      summary: "Bash",
      payload: {
        itemType: "command_execution",
        toolUseId: "toolu_parent",
        status: "failed",
        title: "Bash",
        detail: LEFTOVER_CALL_DETAIL,
        data: { toolName: "Bash", input: { command: "npm test" } }
      },
      turnId: "turn-1",
      status: "failed",
      createdAt: NOW,
      updatedAt: NOW
    });
    // The owner rides the row AND its payload, as ingestion stamps an item's:
    // the closer lands in the agent's own window, beside the call it ends.
    assert.deepEqual(activityOf(closings[1]), {
      kind: "activity",
      id: "closing-2",
      tone: "tool",
      activityKind: "tool.completed",
      summary: "Edit",
      payload: {
        itemType: "file_change",
        toolUseId: "toolu_agent_call",
        status: "failed",
        title: "Edit",
        detail: LEFTOVER_CALL_DETAIL,
        data: { toolName: "Edit", input: { file_path: "/work/project/a.ts" } },
        agentId: "agent-1",
        parentToolUseId: "toolu_launch"
      },
      turnId: null,
      agentId: "agent-1",
      parentToolUseId: "toolu_launch",
      status: "failed",
      createdAt: NOW,
      updatedAt: NOW
    });
    assert.equal(LEFTOVER_CALL_DETAIL, "Stopped when the agent host restarted.");
  });

  it("stops every task the roster shows active — any agent kind — and leaves an idle or a settled one alone", () => {
    const state = foldOf([
      // A background shell the parent launched.
      row("shell-start", "task.started", {
        taskId: "shell-1",
        detail: "npm run dev",
        agentKind: "background",
        taskType: "local_bash",
        title: "npm run dev",
        toolUseId: "toolu_shell"
      }, { turnId: "turn-1" }),
      // A subagent, and one it launched — whose rows sit in the first one's window.
      row("agent-start", "task.started", {
        taskId: "agent-1",
        detail: "Explore the repo",
        agentKind: "agent",
        taskType: "local_agent",
        title: "Explore the repo",
        role: "Explore",
        toolUseId: "toolu_launch"
      }, { turnId: "turn-1" }),
      row("nested-start", "task.started", {
        taskId: "agent-2",
        detail: "Read the tests",
        agentKind: "agent",
        taskType: "local_agent",
        agentId: "agent-1",
        title: "Read the tests",
        toolUseId: "toolu_nested"
      }, { agentId: "agent-1" }),
      // Its latest row carries the bundle as it now stands — a newer title.
      row("nested-progress", "task.progress", {
        taskId: "agent-2",
        title: "Read the tests again",
        detail: "Reading a.test.ts",
        agentKind: "agent",
        taskType: "local_agent",
        agentId: "agent-1",
        toolUseId: "toolu_nested"
      }, { id: "task-progress:agent-2", agentId: "agent-1" }),
      // Grok's `waiting`, and a task first seen `pending`: active, as the roster reads them.
      row("waiting", "task.progress", { taskId: "grok-1", status: "waiting", agentKind: "agent", title: "Grok helper" }),
      row("pending", "task.updated", { taskId: "queued-1", status: "pending", agentKind: "background", title: "Queued" }),
      // A Codex child whose turn finished: idle, resumable — never stopped.
      row("codex-start", "task.started", { taskId: "codex-child", agentKind: "agent", title: "Reviewer", toolUseId: "codex-run:t1" }),
      row("codex-idle", "task.updated", { taskId: "codex-child", status: "idle", agentKind: "agent" }),
      // Settled work.
      row("done-start", "task.started", { taskId: "done-1", agentKind: "agent", taskType: "local_agent", title: "Done" }),
      row("done-end", "task.completed", { taskId: "done-1", status: "completed", agentKind: "agent" })
    ]);

    const closings = closingsOf(state);
    assert.deepEqual(closings.map((closing) => closing.key), [
      "task:shell-1",
      "task:agent-1",
      "task:agent-2",
      "task:grok-1",
      "task:queued-1"
    ]);
    const [shell, agent, nested, waiting, pending] = closings.map(activityOf);
    assert.deepEqual(shell, {
      kind: "activity",
      id: "closing-1",
      tone: "info",
      activityKind: "task.completed",
      summary: "Task stopped",
      payload: {
        taskId: "shell-1",
        status: "stopped",
        agentKind: "background",
        taskType: "local_bash",
        title: "npm run dev",
        toolUseId: "toolu_shell"
      },
      turnId: null,
      createdAt: NOW,
      updatedAt: NOW
    });
    // An agent's stop is an anchor retention never drops, like its start.
    assert.equal((agent!.payload as Record<string, unknown>).agentKind, "agent");
    assert.equal((agent!.payload as Record<string, unknown>).role, "Explore");
    // The nested agent's closer is its owner's row, carrying the bundle of its
    // latest row — so the roster's title does not move back.
    assert.equal(nested!.agentId, "agent-1");
    assert.deepEqual(nested!.payload, {
      taskId: "agent-2",
      status: "stopped",
      agentKind: "agent",
      taskType: "local_agent",
      agentId: "agent-1",
      title: "Read the tests again",
      toolUseId: "toolu_nested"
    });
    assert.equal((waiting!.payload as Record<string, unknown>).taskId, "grok-1");
    assert.equal((pending!.payload as Record<string, unknown>).agentKind, "background");

    // Folded on, nothing reads active any more — the idle child still idle, the
    // settled one still settled.
    const after = applied(state, closings);
    const statuses = Object.fromEntries(
      foldSubagentActivities(after.activities, { sessionLive: true }).map((row) => [row.id, row.status])
    );
    assert.deepEqual(statuses, {
      "shell-1": "interrupted",
      "agent-1": "interrupted",
      "agent-2": "interrupted",
      "grok-1": "interrupted",
      "queued-1": "interrupted",
      "codex-child": "idle",
      "done-1": "completed"
    });
    assert.equal(
      foldSubagentActivities(after.activities, { sessionLive: true }).find((row) => row.id === "agent-2")?.title,
      "Read the tests again"
    );
  });

  it("closes a background shell's item before its task, as the adapters do", () => {
    const state = foldOf([
      row("shell-start", "task.started", {
        taskId: "shell-1",
        agentKind: "background",
        taskType: "local_bash",
        title: "npm run dev",
        toolUseId: "toolu_shell"
      }, { turnId: "turn-1" }),
      row("shell-item", "tool.started", {
        itemType: "command_execution",
        toolUseId: "bgshell:shell-1",
        status: "inProgress",
        title: "Background shell",
        agentId: "shell-1",
        data: { toolName: "Bash", input: { command: "npm run dev" }, background: true }
      }, { agentId: "shell-1", turnId: "turn-1", status: "inProgress" }),
      row("shell-chunk", "tool.output", { toolUseId: "bgshell:shell-1", streamKind: "command_output", delta: "ready\n" }, {
        agentId: "shell-1"
      })
    ]);

    const closings = closingsOf(state);
    assert.deepEqual(closings.map((closing) => closing.key), ["call:bgshell:shell-1", "task:shell-1"]);
    const item = activityOf(closings[0]);
    assert.equal(item.activityKind, "tool.completed");
    assert.equal(item.agentId, "shell-1", "the shell's own window, like its output");
    assert.equal(item.turnId, "turn-1");
    assert.deepEqual(item.payload, {
      itemType: "command_execution",
      toolUseId: "bgshell:shell-1",
      status: "failed",
      title: "Background shell",
      detail: LEFTOVER_CALL_DETAIL,
      data: { toolName: "Bash", input: { command: "npm run dev" }, background: true },
      agentId: "shell-1"
    });
    assert.equal(activityOf(closings[1]).activityKind, "task.completed");
    assert.deepEqual(openWorkOf(applied(state, closings).activities), { calls: [], tasks: [] });
  });

  it("stamps a task's closer with the turn the head says is running, as the adapters stamp a teardown", () => {
    const state = foldOf([
      event("thread.session-set", { session: { status: "running", activeTurnId: "turn-7" } }),
      row("agent-start", "task.started", { taskId: "agent-1", agentKind: "agent", title: "Explorer" })
    ]);
    assert.equal(activityOf(closingsOf(state)[0]).turnId, "turn-7");
  });

  it("settles every message still streaming with its text unchanged, on its own turn and owner", () => {
    const state = foldOf([
      said("assistant:agent-1:m1", "assistant", "Looking at", true, { agentId: "agent-1" }),
      said("assistant:agent-1:m1", "assistant", " the tests", true, { agentId: "agent-1" }),
      said("reasoning:summary:agent-1:m2", "reasoning", "Thinking about it", true, {
        agentId: "agent-1",
        reasoningKind: "summary"
      }),
      said("assistant:parent", "assistant", "Checking first", true, { turnId: "turn-1", messageKind: "commentary" }),
      said("assistant:done", "assistant", "All done.", false, { turnId: "turn-1" })
    ]);

    const closings = closingsOf(state);
    assert.deepEqual(closings.map((closing) => [closing.key, closing.type]), [
      ["message:assistant:agent-1:m1", "thread.message-sent"],
      ["message:reasoning:summary:agent-1:m2", "thread.message-sent"],
      ["message:assistant:parent", "thread.message-sent"]
    ]);
    // Only what the message already carries rides its settle: the fold keeps
    // a badge a later event omits, and must not gain one the stream never set.
    assert.deepEqual(closings[0]!.payload, {
      messageId: "assistant:agent-1:m1",
      role: "assistant",
      text: "",
      streaming: false,
      turnId: null,
      agentId: "agent-1"
    });
    assert.deepEqual(closings[1]!.payload, {
      messageId: "reasoning:summary:agent-1:m2",
      role: "reasoning",
      text: "",
      streaming: false,
      turnId: null,
      agentId: "agent-1",
      reasoningKind: "summary"
    });
    assert.deepEqual(closings[2]!.payload, {
      messageId: "assistant:parent",
      role: "assistant",
      text: "",
      streaming: false,
      turnId: "turn-1",
      messageKind: "commentary"
    });

    const messages = applied(state, closings).items.filter((item) => item.kind === "message");
    assert.deepEqual(
      messages.map((message) => [message.id, message.text, message.streaming, message.turnId]),
      [
        ["assistant:agent-1:m1", "Looking at the tests", false, null],
        ["reasoning:summary:agent-1:m2", "Thinking about it", false, null],
        ["assistant:parent", "Checking first", false, "turn-1"],
        ["assistant:done", "All done.", false, "turn-1"]
      ]
    );
  });

  it("skips what a caller already closed, and finds nothing in a thread with nothing open", () => {
    const state = foldOf([
      row("p-start", "tool.started", { itemType: "command_execution", toolUseId: "toolu_1", title: "Bash" }),
      said("assistant:m1", "assistant", "Hi", true)
    ]);
    assert.deepEqual(
      closingsOf(state, new Set(["call:toolu_1"])).map((closing) => closing.key),
      ["message:assistant:m1"]
    );
    assert.deepEqual(closingsOf(applied(state, closingsOf(state))), []);
    assert.deepEqual(closingsOf(foldOf([said("user:1", "user", "hello", false)])), []);
  });
});
