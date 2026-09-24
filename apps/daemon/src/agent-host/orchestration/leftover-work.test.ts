/**
 * What a host start closes of the work a dead process left open
 * (`leftover-work.ts`): which requests, calls and tasks the folded window
 * still shows pending or running, and the rows that end each one — shaped as
 * the adapters' own teardown writes them, in the class of the row that opened
 * it — and what it leaves: a message-mode question, a message still streaming.
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

/** A started turn, as the host writes one: the prompt, its pending row, the adopted provider id. */
const turn = (turnId: string): Unsequenced[] => [
  said(`user:${turnId}`, "user", `prompt for ${turnId}`, false),
  event("thread.turn-start-requested", { turnId: null, messageId: `user:${turnId}`, interactionMode: "default" }),
  event("thread.session-set", { session: { status: "running", activeTurnId: turnId } })
];

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
    closings.map((closing) => event("thread.activity-appended", { activity: closing.activity })),
    state.seq
  );
  return events.reduce(applyDomainEvent, state);
}

/** `state` rewound to its first `turnCount` started turns (§5.5). */
const rewound = (state: ThreadFoldState, turnCount: number): ThreadFoldState =>
  applyDomainEvent(state, sequenced([event("thread.reverted", { turnCount })], state.seq)[0]!);

const activityOf = (closing: LeftoverClosing | undefined): ThreadActivityItem => {
  assert.ok(closing !== undefined, "a closing");
  return closing.activity;
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

  it("says the data it copies is cut when the row it copies it from was stored cut", () => {
    // Ingestion stores a `tool.updated` already slimmed (§5.6): a Grok command's
    // update carries its output as a one-line `rawOutput` preview, `truncated`.
    const cutUpdate = {
      itemType: "command_execution",
      status: "inProgress",
      title: "Run npm test",
      data: { command: "npm test", rawOutput: { content: "PASS a.test.ts" } },
      truncated: true
    };
    const state = foldOf([
      row("g-start", "tool.started", { itemType: "command_execution", toolUseId: "call-grok", title: "Run npm test" }, {
        turnId: "turn-1"
      }),
      row("g-update", "tool.updated", { ...cutUpdate, toolUseId: "call-grok" }, { turnId: "turn-1" }),
      // The data comes from the opening row when the latest has none: its marker with it.
      row("o-start", "tool.started", {
        itemType: "command_execution",
        toolUseId: "call-opening",
        title: "Bash",
        data: { toolName: "Bash", input: { command: "npm run build" } },
        truncated: true
      }, { turnId: "turn-1" }),
      row("o-update", "tool.updated", { itemType: "command_execution", toolUseId: "call-opening", title: "Bash" }, {
        turnId: "turn-1"
      }),
      // Whole data says nothing — and a cut row whose data is not the one copied neither.
      row("w-start", "tool.started", {
        itemType: "command_execution",
        toolUseId: "call-whole",
        title: "Bash",
        data: { toolName: "Bash", input: {} },
        truncated: true
      }, { turnId: "turn-1" }),
      row("w-update", "tool.updated", {
        itemType: "command_execution",
        toolUseId: "call-whole",
        title: "Bash",
        data: { toolName: "Bash", input: { command: "ls" } }
      }, { turnId: "turn-1" })
    ]);
    const payloads = closingsOf(state).map((closing) => closing.activity.payload as Record<string, unknown>);
    assert.deepEqual(
      payloads.map((payload) => [payload.toolUseId, payload.data, payload.truncated]),
      [
        ["call-grok", cutUpdate.data, true],
        ["call-opening", { toolName: "Bash", input: { command: "npm run build" } }, true],
        ["call-whole", { toolName: "Bash", input: { command: "ls" } }, undefined]
      ]
    );
    assert.equal("truncated" in payloads[2]!, false, "no marker at all on whole data");
  });

  it("leaves alone an open call no row of the window anchors — the woken call a rewind left — and closes one a row anchors", () => {
    // A woken Claude parent streams its call before the synthetic turn its own
    // message opens: its start and an early input update carry no turn and no
    // owner. The turn adopts the call with one update on it, and a rewind of
    // that turn takes that update and the call's completion with it
    // (`reduceReverted` keeps turnless rows): what is left is open, and no
    // view shows it. A closer would anchor it and bring it back, failed.
    const bash = (command?: string) => ({ toolName: "Bash", input: command === undefined ? {} : { command } });
    const state = foldOf([
      ...turn("turn-1"),
      event("thread.session-set", { session: { status: "ready", activeTurnId: null } }),
      row("w-start", "tool.started", {
        itemType: "command_execution",
        toolUseId: "toolu_woken",
        status: "inProgress",
        title: "Command run",
        data: bash()
      }, { status: "inProgress" }),
      row("w-update", "tool.updated", {
        itemType: "command_execution",
        toolUseId: "toolu_woken",
        status: "inProgress",
        title: "Command run",
        data: bash("cat out.txt")
      }, { status: "inProgress" }),
      // The same turnless start, but another row of the call names a turn…
      row("t-start", "tool.started", { itemType: "command_execution", toolUseId: "toolu_turned", title: "Bash" }),
      row("t-chunk", "tool.output", { toolUseId: "toolu_turned", streamKind: "command_output", delta: "x\n" }, {
        turnId: "turn-1"
      }),
      // …or an agent owns it — on the payload, where the views read it too.
      row("o-start", "tool.started", {
        itemType: "command_execution",
        toolUseId: "toolu_owned",
        title: "Bash",
        agentId: "agent-1"
      })
    ]);
    assert.deepEqual(
      openWorkOf(state.activities).calls.map((call) => call.toolUseId),
      ["toolu_woken", "toolu_turned", "toolu_owned"],
      "all three read open"
    );
    assert.deepEqual(closingsOf(state).map((closing) => closing.key), ["call:toolu_turned", "call:toolu_owned"]);
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
      // Its start's turn: a rewind keeps or drops the two together.
      turnId: "turn-1",
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

  it("stamps a task's closer with its start row's turn, so a rewind keeps or removes the two together", () => {
    // turn-1 launched the agent and settled; turn-2 was running when the host died.
    const state = foldOf([
      ...turn("turn-1"),
      row("agent-start", "task.started", { taskId: "agent-1", agentKind: "agent", title: "Explorer" }, {
        turnId: "turn-1"
      }),
      event("thread.session-set", { session: { status: "ready", activeTurnId: null } }),
      ...turn("turn-2")
    ]);
    const closings = closingsOf(state);
    assert.equal(activityOf(closings[0]).turnId, "turn-1", "the start's turn, not the one running");

    const after = applied(state, closings);
    const statusAfterRewind = (turnCount: number): Record<string, string> =>
      Object.fromEntries(
        foldSubagentActivities(rewound(after, turnCount).activities, { sessionLive: true }).map((agent) => [
          agent.id,
          agent.status
        ])
      );
    // A rewind that keeps the start keeps its stop: the agent does not read running again.
    assert.deepEqual(statusAfterRewind(1), { "agent-1": "interrupted" });
    // One that removes the start removes the stop with it.
    assert.deepEqual(statusAfterRewind(0), {});
  });

  it("stamps a task whose start the window lost with its latest row's turn", () => {
    const state = foldOf([
      row("progress", "task.progress", { taskId: "agent-1", agentKind: "agent", title: "Explorer" }, {
        id: "task-progress:agent-1",
        turnId: "turn-3"
      })
    ]);
    assert.equal(activityOf(closingsOf(state)[0]).turnId, "turn-3");
  });

  it("puts every closer in exactly the class the fold gives its opener, whatever the owner's spelling", () => {
    // The fold's owner is any non-empty `agentId` (`fold.ts` `ownerOf`), blank or not.
    const state = foldOf([
      // On a turn: a blank owner is no owner to the views, and a call no row
      // anchors gets no closer at all (`anchorsCall`).
      row("odd-start", "tool.started", { itemType: "command_execution", toolUseId: "toolu_odd", title: "Bash" }, {
        agentId: " ",
        turnId: "turn-1"
      }),
      row("odd-task", "task.started", { taskId: "shell-odd", agentKind: "background", title: "odd" }, {
        agentId: " "
      })
    ]);
    const [call, task] = closingsOf(state).map(activityOf);
    assert.equal(call!.agentId, " ");
    assert.equal((call!.payload as Record<string, unknown>).agentId, " ");
    assert.equal(task!.agentId, " ");
  });

  it("leaves every message still streaming to its readers: no closing names one", () => {
    // Settling one moved its span in the thread index to the end of the log,
    // and "Load older" then lost every row between its first chunk and the
    // window (reconcile.test.ts walks the pages).
    const state = foldOf([
      said("assistant:agent-1:m1", "assistant", "Looking at", true, { agentId: "agent-1" }),
      said("reasoning:summary:agent-1:m2", "reasoning", "Thinking about it", true, {
        agentId: "agent-1",
        reasoningKind: "summary"
      }),
      said("assistant:parent", "assistant", "Checking first", true, { turnId: "turn-1", messageKind: "commentary" }),
      row("p-start", "tool.started", { itemType: "command_execution", toolUseId: "toolu_1", title: "Bash" }, {
        turnId: "turn-1"
      })
    ]);
    const closings = closingsOf(state);
    assert.deepEqual(closings.map((closing) => closing.key), ["call:toolu_1"]);
    const messages = applied(state, closings).items.filter((item) => item.kind === "message");
    assert.deepEqual(
      messages.map((message) => [message.id, message.streaming]),
      [
        ["assistant:agent-1:m1", true],
        ["reasoning:summary:agent-1:m2", true],
        ["assistant:parent", true]
      ]
    );
  });

  it("cancels every parked request but a message-mode question, first, as the host's own settle does", () => {
    const question = { id: "q1", header: "Pick", question: "Which one?", options: [{ label: "A", description: "a" }] };
    const state = foldOf([
      // The turn a Stop would cancel them in: the one the head says is running.
      event("thread.session-set", { session: { status: "running", activeTurnId: "turn-5" } }),
      row("t-start", "task.started", { taskId: "agent-1", agentKind: "agent", title: "Explorer" }),
      row("c-start", "tool.started", { itemType: "command_execution", toolUseId: "toolu_1", title: "Bash" }, {
        agentId: "agent-1"
      }),
      // A background subagent's approval and question, raised between parent turns.
      row("approval", "approval.requested", {
        requestId: "req-approval",
        requestKind: "command",
        requestType: "command_execution_approval",
        dismissible: false,
        detail: "rm -rf build"
      }, { tone: "approval", agentId: "agent-1" }),
      row("question", "user-input.requested", { requestId: "req-question", questions: [question], dismissible: false }, {
        agentId: "agent-1",
        turnId: "turn-1"
      }),
      // An async question may outlive its turn and still take a later message.
      row("async", "user-input.requested", {
        requestId: "req-async",
        questions: [question],
        dismissible: true,
        responseMode: "message"
      }),
      // Settled already: no closing.
      row("done", "approval.requested", {
        requestId: "req-done",
        requestKind: "command",
        requestType: "command_execution_approval",
        dismissible: false
      }, { tone: "approval" }),
      row("done-resolved", "approval.resolved", {
        requestId: "req-done",
        requestType: "command_execution_approval",
        decision: "accept"
      }, { tone: "approval" })
    ]);
    assert.deepEqual(state.pending.approvals.map((entry) => entry.requestId), ["req-approval"]);

    const closings = closingsOf(state);
    // Settled before anything else, as a teardown settles them.
    assert.deepEqual(closings.map((closing) => closing.key), [
      "request:req-approval",
      "request:req-question",
      "call:toolu_1",
      "task:agent-1"
    ]);
    // The host's own cancellation (`settlePendingRequests`, the Stop path's
    // rows): nobody answered, so nothing says anyone did.
    assert.deepEqual(activityOf(closings[0]), {
      kind: "activity",
      id: "settle-cancel:req-approval",
      tone: "info",
      activityKind: "approval.resolved",
      summary: "Request cancelled",
      payload: { requestId: "req-approval", decision: "cancel" },
      turnId: "turn-5",
      createdAt: NOW,
      updatedAt: NOW
    });
    assert.deepEqual(activityOf(closings[1]), {
      kind: "activity",
      id: "settle-cancel:req-question",
      tone: "info",
      activityKind: "user-input.resolved",
      summary: "Question cancelled",
      payload: { requestId: "req-question" },
      turnId: "turn-5",
      createdAt: NOW,
      updatedAt: NOW
    });
    assert.deepEqual(
      closings.map((closing) => closing.requestId),
      ["req-approval", "req-question", undefined, undefined],
      "the envelope's metadata names the request, as the host's own settle does"
    );

    const after = applied(state, closings);
    assert.deepEqual(after.pending.approvals, []);
    assert.deepEqual(after.pending.userInputs.map((entry) => entry.requestId), ["req-async"]);
  });

  it("skips what a caller already closed, and finds nothing in a thread with nothing open", () => {
    const state = foldOf([
      row("p-start", "tool.started", { itemType: "command_execution", toolUseId: "toolu_1", title: "Bash" }, {
        turnId: "turn-1"
      }),
      row("t-start", "task.started", { taskId: "task-1", agentKind: "agent", title: "Explorer" })
    ]);
    assert.deepEqual(closingsOf(state).map((closing) => closing.key), ["call:toolu_1", "task:task-1"]);
    assert.deepEqual(
      closingsOf(state, new Set(["call:toolu_1"])).map((closing) => closing.key),
      ["task:task-1"]
    );
    assert.deepEqual(closingsOf(applied(state, closingsOf(state))), []);
    assert.deepEqual(closingsOf(foldOf([said("user:1", "user", "hello", false)])), []);
  });
});
