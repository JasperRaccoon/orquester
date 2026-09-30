import { type ThreadItem } from "@orquester/api/agent-chat";
import assert from "node:assert/strict";
import { beforeEach,describe,it } from "node:test";

import { joinLifecycleDetails } from "../../components/agent-chat/timeline/row-chrome";
import {
deriveTimelineEntriesFromItems,
deriveWorkLogEntries,
EMPTY_TIMELINE_PROJECTION,
itemsForAgent,
workLogEntryFromActivity
} from "./entries.logic";
import { workEntryDisplayLabel } from "./presentation.logic";
import { activity,message,resetBuilders,stamp } from "./test-helpers";

beforeEach(() => {
  resetBuilders();
});

describe("workLogEntryFromActivity", () => {

  it("promotes only the allow-listed payload fields", () => {
    const entry = workLogEntryFromActivity(
      activity("tool.completed", {
        itemType: "file_change",
        toolUseId: "tu1",
        title: "Edit",
        detail: "3 lines",
        changedFiles: ["/w/p/a.ts", 7],
        taskId: "should-be-ignored",
        secret: "never read"
      })
    );
    assert.equal(entry.itemType, "file_change");
    assert.equal(entry.toolCallId, "tu1");
    assert.equal(entry.toolTitle, "Edit");
    assert.equal(entry.detail, "3 lines");
    assert.deepEqual(entry.changedFiles, ["/w/p/a.ts"]);
    assert.equal(entry.taskId, undefined, "taskId belongs to task rows only");
  });

  it("promotes the §3.4 account switch as IDS, never a label", () => {
    assert.deepEqual(
      workLogEntryFromActivity(
        activity("session.identity-changed", {
          accountId: "acc-2",
          home: "account",
          previousAccountId: "acc-1"
        })
      ).accountSwitch,
      { accountId: "acc-2", previousAccountId: "acc-1" }
    );
    // The system identity is an EMPTY id, not an absent one.
    assert.deepEqual(
      workLogEntryFromActivity(
        activity("session.identity-changed", { accountId: "", home: "system" })
      ).accountSwitch,
      { accountId: "" }
    );
    // A payload from a build that did not carry the field leaves the row bare
    // rather than inventing one.
    assert.equal(
      workLogEntryFromActivity(activity("session.identity-changed", {})).accountSwitch,
      undefined
    );
    assert.equal(
      workLogEntryFromActivity(activity("tool.completed", { accountId: "acc-2" })).accountSwitch,
      undefined
    );
  });

});

describe("deriveWorkLogEntries", () => {
  it("drops the kinds that have their own surfaces", () => {
    const entries = deriveWorkLogEntries([
      activity("context-window.updated", { usedTokens: 10 }),
      activity("turn.plan.updated", { plan: [] }),
      activity("tool.started", { itemType: "command_execution" }),
      activity("task.updated", { taskId: "t1" }),
      activity("tool.completed", { itemType: "command_execution", command: "ls" })
    ]);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.command, "ls");
  });

  it("hides routine hooks but keeps failed and cancelled hooks", () => {
    const entries = deriveWorkLogEntries([
      activity("hook.started", { hookId: "h1", hookName: "hooks.json" }, { tone: "info" }),
      activity("hook.progress", { hookId: "h1" }, { tone: "info" }),
      activity("hook.completed", { hookId: "h1", outcome: "success" }, { tone: "info" }),
      activity("hook.completed", { hookId: "h2", outcome: "error", stderr: "failed" }, { tone: "error" }),
      activity("hook.completed", { hookId: "h3", outcome: "cancelled" }, { tone: "info" })
    ]);
    assert.deepEqual(entries.map((entry) => entry.sourceActivityKind), [
      "hook.completed",
      "hook.completed"
    ]);
    assert.equal(entries[0]?.tone, "error");
  });

  it("collapses one tool call's in-progress and completed updates into one row", () => {
    const entries = deriveWorkLogEntries([
      activity("tool.updated", {
        itemType: "command_execution",
        toolUseId: "tu1",
        command: "pnpm test",
        status: "running"
      }, { turnId: "t1" }),
      activity("tool.completed", {
        itemType: "command_execution",
        toolUseId: "tu1",
        command: "pnpm test",
        detail: "ok",
        status: "completed"
      }, { turnId: "t1" })
    ]);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.toolLifecycleStatus, "completed");
    assert.equal(entries[0]?.detail, "ok");
  });

  it("collapses a spawn batch into ONE row anchored at the spawn point", () => {
    const rows = [
      activity("task.started", { taskId: "t1", agentKind: "agent" }, { turnId: "turn-1" }),
      activity("task.started", { taskId: "t2", agentKind: "agent" }, { turnId: "turn-1" }),
      activity("task.progress", { taskId: "t1", agentKind: "agent", summary: "reading" }, { turnId: "turn-1" }),
      activity("task.completed", { taskId: "t2", agentKind: "agent", status: "completed" }, { turnId: "turn-9" })
    ];
    const entries = deriveWorkLogEntries(rows);
    assert.equal(entries.length, 1, "a batch is one narrative event");
    assert.equal(entries[0]?.id, rows[0]?.id, "the row keeps the ANCHOR identity");
    assert.deepEqual(entries[0]?.agentSpawn?.agentTaskIds, ["t1", "t2"]);
  });

});

describe("a started call's own row", () => {
  /** A Codex command's rows: its start names it, and nothing but output chunks follows until it completes. */
  const commandRow = (activityKind: string, extra: Record<string, unknown> = {}) =>
    activity(
      activityKind,
      { itemType: "command_execution", toolUseId: "call-1", title: "npm test", command: "npm test", status: "inProgress", ...extra },
      { turnId: "t1", ...(activityKind === "tool.denied" ? { tone: "error" as const } : {}) }
    );
  const chunk = (delta: string) =>
    activity("tool.output", { toolUseId: "call-1", streamKind: "command_output", delta }, { turnId: "t1", summary: "Tool output" });

  it("is dropped once an update, a completion or a denial of the call is in the input, before or after it", () => {
    for (const [kind, extra] of [
      ["tool.updated", {}],
      ["tool.completed", { status: "completed" }],
      ["tool.denied", { status: "declined" }]
    ] as const) {
      const start = commandRow("tool.started");
      const later = commandRow(kind, extra);
      assert.deepEqual(deriveWorkLogEntries([start, later]).map((entry) => entry.id), [later.id], kind);
      // Grok forgets a call at its terminal update, so a frame after it comes out as a fresh start behind it.
      assert.deepEqual(deriveWorkLogEntries([later, start]).map((entry) => entry.id), [later.id], `${kind}, first`);
    }
  });

  it("an unkeyed start, and a start with neither a turn nor an owner, are dropped as before", () => {
    const unkeyed = activity("tool.started", { itemType: "command_execution", command: "ls", status: "inProgress" }, { turnId: "t1" });
    // In a log written before 2026-09-28, a Claude parent call registered with no turn open outside a held message
    // (an interrupted message's tail; before the hold, a woken call) emitted its start and early input update
    // turnless, and a rewind of the turn that adopted it leaves those alone.
    const turnless = activity("tool.started", { itemType: "command_execution", toolUseId: "call-2", command: "ls", status: "inProgress" });
    assert.deepEqual(deriveWorkLogEntries([unkeyed, turnless]), []);
    // An agent's call started while no parent turn was open has an owner: in its own view, it is its row.
    const owned = activity(
      "tool.started",
      { itemType: "command_execution", toolUseId: "call-3", command: "ls", status: "inProgress", agentId: "ag1" },
      { agentId: "ag1" }
    );
    assert.deepEqual(deriveWorkLogEntries([owned], { ownerAgentId: "ag1" }).map((entry) => entry.id), [owned.id]);
  });

  it("an ExitPlanMode start is a plan boundary like the call's other rows, not a tool row", () => {
    // Claude's start frame, before the plan streams into the call's input.
    const start = activity(
      "tool.started",
      { itemType: "dynamic_tool_call", toolUseId: "call-4", title: "Tool call", detail: "ExitPlanMode: {}", status: "inProgress" },
      { turnId: "t1" }
    );
    assert.deepEqual(deriveWorkLogEntries([start]), []);
    // In a log written before 2026-09-28, the update that adopted a call before its input parsed names the tool alone
    // (the since-removed `adoptedToolEvent`): still the plan boundary.
    const adopted = activity(
      "tool.updated",
      { itemType: "dynamic_tool_call", toolUseId: "call-5", title: "Tool call", detail: "ExitPlanMode", status: "inProgress" },
      { turnId: "t1" }
    );
    assert.deepEqual(deriveWorkLogEntries([adopted]), []);
  });

  it("a detail that only looks like the echo is kept whole: an OpenCode completion's output, \"config: {}\"", () => {
    // OpenCode's completion detail is the tool's own output, and its data names the tool as `tool`, never as the
    // `toolName` Claude's echo repeats: nothing here is the call's name.
    const completion = activity(
      "tool.completed",
      {
        itemType: "command_execution",
        toolUseId: "call-oc",
        title: "bash",
        detail: "config: {}",
        status: "completed",
        data: {
          tool: "bash",
          toolUseId: "call-oc",
          command: "cat settings.yaml",
          state: { status: "completed", output: "config: {}" },
          result: "config: {}"
        }
      },
      { turnId: "t1" }
    );
    assert.equal(workLogEntryFromActivity(completion).detail, "config: {}");
    // Nor is a Claude echo of ANOTHER name: the captured name must be the row's own tool.
    const otherName = activity(
      "tool.completed",
      { itemType: "dynamic_tool_call", toolUseId: "call-z", title: "Tool call", detail: "config: {}", status: "completed", data: { toolName: "Read", input: {} } },
      { turnId: "t1" }
    );
    assert.equal(workLogEntryFromActivity(otherName).detail, "config: {}");
  });

  it("a start never offers Load full output: what the read cut there is the call's input, not its output", () => {
    const cutStart = activity(
      "tool.started",
      { itemType: "command_execution", toolUseId: "call-1", title: "npm test", command: "npm test", status: "inProgress", truncated: true },
      { turnId: "t1" }
    );
    assert.equal(workLogEntryFromActivity(cutStart).truncated, undefined);
    const cutCompletion = activity("tool.completed", { itemType: "command_execution", toolUseId: "call-1", status: "completed", truncated: true }, { turnId: "t1" });
    assert.equal(workLogEntryFromActivity(cutCompletion).truncated, true);
  });

  it("a chunk is headed like its call's row when a lifecycle row of the call is in the input: its command and title", () => {
    // A running command whose output a hoisted error row splits off its own row: the chunks after it render apart.
    const start = commandRow("tool.started");
    const output = chunk("PASS a.test.ts\n");
    const [, titled] = deriveWorkLogEntries([start, output]);
    assert.deepEqual([titled?.id, titled?.command, titled?.toolTitle, titled?.detail], [output.id, "npm test", "npm test", "PASS a.test.ts\n"]);
    // The same object on every derivation that names the same call, so a settled group's rows keep their memos.
    // A chunk whose call has no row in the input is headed "Tool output" (its own summary), never with its text.
    const [orphan] = deriveWorkLogEntries([output]);
    assert.deepEqual([orphan?.command, orphan?.toolTitle, orphan && workEntryDisplayLabel(orphan)], [undefined, undefined, "Tool output"]);
  });
});

describe("a call that streamed a command's output: its whole output is the host's join", () => {
  const commandRow = (activityKind: string, extra: Record<string, unknown> = {}, turnId = "t1") =>
    activity(
      activityKind,
      { itemType: "command_execution", toolUseId: "call-1", title: "npm test", command: "npm test", status: "inProgress", ...extra },
      { turnId }
    );
  const chunk = (delta: string, over: { streamKind?: string; toolUseId?: string; turnId?: string } = {}) =>
    activity(
      "tool.output",
      { toolUseId: over.toolUseId ?? "call-1", streamKind: over.streamKind ?? "command_output", delta },
      { turnId: over.turnId ?? "t1", summary: "Tool output" }
    );

  it("a chunk of a command's output says so; a file change's result text, or a chunk naming no call, never", () => {
    assert.equal(workLogEntryFromActivity(chunk("PASS a.test.ts\n")).streamedOutput, true);
    assert.equal(
      workLogEntryFromActivity(chunk("File created successfully at: /w/p/a.ts", { streamKind: "file_change_output" })).streamedOutput,
      undefined
    );
    assert.equal(workLogEntryFromActivity(activity("tool.output", { streamKind: "command_output", delta: "x\n" })).streamedOutput, undefined);
  });

  it("every lifecycle row of a call whose command output the input holds says so, wherever its chunks lie", () => {
    // A long command whose early chunks the window evicted: a later one is still there, in a turn the completion
    // does not share (they never meet in one group), or after it.
    const completion = commandRow("tool.completed", { status: "completed", detail: "line 598" }, "t2");
    for (const input of [
      [chunk("line 599\n"), completion],
      [completion, chunk("line 599\n", { turnId: "t2" })]
    ]) {
      const row = deriveWorkLogEntries(input).find((entry) => entry.id === completion.id);
      assert.equal(row?.streamedOutput, true);
    }
    // A running command's start, its call's only row so far.
    const start = commandRow("tool.started");
    assert.equal(deriveWorkLogEntries([start, chunk("PASS\n")])[0]?.streamedOutput, true);
  });

  it("a command that streamed nothing, and a file change whose result text streamed, say nothing", () => {
    const plain = commandRow("tool.completed", { status: "completed", detail: "2 passed" });
    assert.equal(deriveWorkLogEntries([plain])[0]?.streamedOutput, undefined);
    assert.equal(
      deriveWorkLogEntries([plain, chunk("x\n", { toolUseId: "call-9" })])[0]?.streamedOutput,
      undefined,
      "another call's output marks nothing here"
    );
    const edit = activity(
      "tool.completed",
      { itemType: "file_change", toolUseId: "call-e", title: "File change", status: "completed", changedFiles: ["/w/p/a.ts"] },
      { turnId: "t1" }
    );
    const result = chunk("File created successfully at: /w/p/a.ts", { streamKind: "file_change_output", toolUseId: "call-e" });
    for (const entry of deriveWorkLogEntries([edit, result])) {
      assert.equal(entry.streamedOutput, undefined, entry.id);
    }
  });

  it("a Claude background shell's rows say so with no chunk in view: its output only ever streams", () => {
    // In a busy fleet the cross-agent ceiling can evict every chunk a quiet shell printed while retention keeps its
    // start (open work). Its whole output is still the host's join — or, the join empty, the item read.
    const own = { agentId: "task-1", turnId: "t1" };
    const shellRow = (activityKind: string, extra: Record<string, unknown>) =>
      activity(
        activityKind,
        {
          itemType: "command_execution",
          toolUseId: "bgshell:task-1",
          title: "Background shell",
          agentId: "task-1",
          data: { toolName: "Bash", input: { command: "npm run dev" } },
          ...extra
        },
        own
      );
    const start = shellRow("tool.started", { status: "running" });
    const completion = shellRow("tool.completed", { status: "completed" });
    assert.equal(workLogEntryFromActivity(start).streamedOutput, true);
    assert.equal(workLogEntryFromActivity(completion).streamedOutput, true);
    assert.deepEqual(
      deriveWorkLogEntries([start], { ownerAgentId: "task-1" }).map((entry) => entry.streamedOutput),
      [true]
    );
    // Only the shell's own call: a provider-named command with no chunk in view says nothing.
    assert.equal(workLogEntryFromActivity(commandRow("tool.started")).streamedOutput, undefined);
  });
});

describe("deriveTimelineEntriesFromItems", () => {

  it("folds an answered question out of the message list", () => {
    const answer = message("user", "Yes", { id: "async-answer:r1", createdAt: stamp(2) });
    const answered = activity(
      "user-input.resolved",
      { questionAnswer: { requestId: "r1", answers: { q1: "Yes" } } },
      { createdAt: stamp(3) }
    );
    const projection = deriveTimelineEntriesFromItems(
      [message("user", "go", { createdAt: stamp(1) }), answer, answered],
      EMPTY_TIMELINE_PROJECTION
    );
    const messageIds = projection.entries
      .filter((entry) => entry.kind === "message")
      .map((entry) => entry.id);
    assert.ok(!messageIds.includes("async-answer:r1"), "the answer renders as an activity row");
  });

  it("folds a proposed plan out of the activity stream into its own entry", () => {
    const projection = deriveTimelineEntriesFromItems(
      [
        activity("turn.proposed.delta", { delta: "# Plan\n" }, { turnId: "t1", createdAt: stamp(1) }),
        activity("turn.proposed.completed", {}, { turnId: "t1", createdAt: stamp(2) })
      ],
      EMPTY_TIMELINE_PROJECTION
    );
    assert.equal(projection.proposedPlans.length, 1);
    assert.equal(projection.proposedPlans[0]?.planMarkdown, "# Plan");
    assert.equal(projection.proposedPlans[0]?.implementedAt, null);
  });

  it("retires a proposal by the turn that implements it, not by a click", () => {
    const projection = deriveTimelineEntriesFromItems(
      [
        activity("turn.proposed.completed", { planMarkdown: "# Plan" }, { createdAt: stamp(1) }),
        message("user", "PLEASE IMPLEMENT THIS PLAN:\n# Plan", { createdAt: stamp(2) })
      ],
      EMPTY_TIMELINE_PROJECTION
    );
    assert.equal(projection.proposedPlans[0]?.implementedAt, stamp(2));
  });

  it("marks a proposal whose markdown the wire cut at 16 KiB (§5.6), and only that one", () => {
    const projection = deriveTimelineEntriesFromItems(
      [
        activity(
          "turn.proposed.completed",
          { planMarkdown: "# Cut\n\nstep 1…", truncated: true },
          { id: "p-cut", createdAt: stamp(1) }
        ),
        activity("turn.proposed.completed", { planMarkdown: "# Whole" }, { id: "p-whole", createdAt: stamp(2) }),
        // Rebuilt from its deltas: the cut was some other field, and the row
        // read back would carry no markdown to replace this one with.
        activity("turn.proposed.delta", { delta: "# From deltas" }, { turnId: "t3", createdAt: stamp(3) }),
        activity("turn.proposed.completed", { truncated: true }, { id: "p-deltas", turnId: "t3", createdAt: stamp(4) })
      ],
      EMPTY_TIMELINE_PROJECTION
    );
    assert.deepEqual(
      projection.proposedPlans.map((plan) => [plan.id, plan.truncated === true]),
      [
        ["p-cut", true],
        ["p-whole", false],
        ["p-deltas", false]
      ]
    );
  });
});

describe("drill-in ownership and streamed output", () => {
  it("keeps the rows the drill-in's own agent owns and still drops every other agent's", () => {
    const mine = activity("tool.completed", { toolUseId: "t1", itemType: "command_execution", agentId: "ag1" });
    const theirs = activity("tool.completed", { toolUseId: "t2", itemType: "command_execution", agentId: "ag2" });
    const parent = activity("tool.completed", { toolUseId: "t3", itemType: "command_execution" });
    assert.deepEqual(
      deriveWorkLogEntries([mine, theirs, parent]).map((entry) => entry.id),
      [parent.id],
      "the parent timeline stays quiet"
    );
    assert.deepEqual(
      deriveWorkLogEntries([mine, theirs, parent], { ownerAgentId: "ag1" }).map((entry) => entry.id),
      [mine.id, parent.id],
      "inside ag1's own view its rows are the point"
    );
  });

  it("a tool.output chunk becomes the entry's detail, untrimmed", () => {
    const chunk = activity("tool.output", { toolUseId: "t1", streamKind: "command_output", delta: "  two\n" });
    assert.equal(workLogEntryFromActivity(chunk).detail, "  two\n");
  });

  /** A subagent's Bash call, its rows as the Claude adapter writes them. */
  const agentCall = (activityKind: string, status: string) =>
    activity(
      activityKind,
      { itemType: "command_execution", toolUseId: "sub-1", title: "Command run", status, detail: "Bash: ls", agentId: "ag1" },
      { agentId: "ag1", turnId: "t1" }
    );
  const outputChunk = (toolUseId: string, delta: string, agentId?: string) =>
    activity(
      "tool.output",
      { toolUseId, streamKind: "command_output", delta },
      { turnId: "t1", summary: "Tool output", ...(agentId !== undefined ? { agentId } : {}) }
    );
  /** The drill-in's rows, as `useAgentChatDrillIn` derives them and a group joins them. */
  const drillInRows = (items: readonly ThreadItem[], agentId: string) =>
    joinLifecycleDetails(
      deriveTimelineEntriesFromItems(itemsForAgent(items, agentId), null, { ownerAgentId: agentId })
        .workEntries
    ).map((entry) => [entry.toolCallId, entry.detail]);

  it("a stamped chunk never enters the parent's entries and joins its agent's completion row", () => {
    const items = [
      agentCall("tool.started", "inProgress"),
      agentCall("tool.updated", "inProgress"),
      outputChunk("sub-1", "a.txt\n", "ag1"),
      agentCall("tool.completed", "completed")
    ];
    assert.deepEqual(deriveWorkLogEntries(items), [], "the parent timeline stays quiet");
    assert.deepEqual(drillInRows(items, "ag1"), [["sub-1", "a.txt\n"]], "the output is the row's");
  });

  it("an UNSTAMPED chunk of an agent's call — an older log — follows its call's owner", () => {
    // Claude used to write a subagent's Bash result with no agent id while
    // every other row of the call carried one (fixture claude/07).
    const items = [
      agentCall("tool.started", "inProgress"),
      agentCall("tool.updated", "inProgress"),
      outputChunk("sub-1", "a.txt\n"),
      agentCall("tool.completed", "completed")
    ];
    assert.deepEqual(deriveWorkLogEntries(items), [], "no stray \"Tool output\" row in the parent");
    assert.deepEqual(
      itemsForAgent(items, "ag1").map((item) => item.id),
      items.map((item) => item.id),
      "its agent's view takes it"
    );
    assert.deepEqual(drillInRows(items, "ag1"), [["sub-1", "a.txt\n"]]);
    assert.deepEqual(itemsForAgent(items, "ag2"), [], "and no other agent's does");
    assert.deepEqual(deriveWorkLogEntries(items, { ownerAgentId: "ag2" }), []);
  });

  it("an unstamped PARENT chunk still joins its parent row", () => {
    const parentCall = (activityKind: string, status: string) =>
      activity(
        activityKind,
        { itemType: "command_execution", toolUseId: "p-1", title: "Command run", status, detail: "Bash: ls" },
        { turnId: "t1" }
      );
    const items = [
      parentCall("tool.updated", "inProgress"),
      outputChunk("p-1", "b.txt\n"),
      parentCall("tool.completed", "completed")
    ];
    assert.deepEqual(
      joinLifecycleDetails(deriveWorkLogEntries(items)).map((entry) => [entry.toolCallId, entry.detail]),
      [["p-1", "b.txt\n"]]
    );
    assert.deepEqual(itemsForAgent(items, "ag1"), [], "no agent claims the parent's output");
  });
});

describe("a subagent's own messages in its drill-in (§7.6)", () => {
  const items = [
    message("user", "go"),
    message("assistant", "parent answer"),
    message("reasoning", "child thinking", { agentId: "ag1", id: "m-child-reason" }),
    message("assistant", "child answer", { agentId: "ag1", id: "m-child-answer" }),
    activity("tool.completed", { itemType: "command_execution", command: "ls" }, { agentId: "ag1" })
  ];

  it("derives the agent's assistant row in its entries and never in the parent's", () => {
    const drillIn = deriveTimelineEntriesFromItems(itemsForAgent(items, "ag1"), null, {
      ownerAgentId: "ag1"
    });
    const drillInMessages = drillIn.entries
      .filter((entry) => entry.kind === "message")
      .map((entry) => (entry.kind === "message" ? entry.message.text : ""));
    assert.deepEqual(drillInMessages, ["child thinking", "child answer"]);
    assert.ok(
      drillIn.entries.some((entry) => entry.kind === "work"),
      "its tool rows are still there too"
    );

    const parent = deriveTimelineEntriesFromItems(items, null);
    const parentMessages = parent.entries
      .filter((entry) => entry.kind === "message")
      .map((entry) => (entry.kind === "message" ? entry.message.text : ""));
    assert.deepEqual(parentMessages, ["go", "parent answer"]);
  });
});

describe("an OpenCode child's own drill-in lists no spawn row for itself (item 4, review N2)", () => {
  /**
   * OpenCode stamps a child session's task rows with the child itself
   * (`childLinkage`: `agentId: sessionId`, `taskId: sessionId`), under its
   * launching `task` part's call — as the child's run writes them.
   */
  const CHILD = "ses_child";
  const linkage = { taskType: "subagent", agentKind: "agent", agentId: CHILD, title: "explore", toolUseId: "call_task" };
  const rows = [
    activity("task.started", { taskId: CHILD, description: "explore", ...linkage }, { agentId: CHILD, turnId: "t1", tone: "info" }),
    activity(
      "task.progress",
      { taskId: CHILD, summary: "Reading src", lastToolName: "read", ...linkage },
      { agentId: CHILD, turnId: "t1", tone: "info" }
    ),
    activity(
      "tool.completed",
      { itemType: "file_change", toolUseId: "prt_read", title: "read", status: "completed", agentId: CHILD },
      { agentId: CHILD, turnId: "t1" }
    ),
    activity(
      "task.completed",
      { taskId: CHILD, status: "completed", summary: "Found it", detail: "Found it", ...linkage },
      { agentId: CHILD, turnId: "t1", tone: "info" }
    )
  ];

  it("the child's drill-in: its own call, and no bot row for itself", () => {
    const entries = deriveWorkLogEntries(rows, { ownerAgentId: CHILD });
    assert.deepEqual(
      entries.filter((entry) => entry.agentSpawn?.agentTaskIds.includes(CHILD)),
      [],
      "the header and the roster already say what the agent is"
    );
    assert.deepEqual(entries.map((entry) => entry.toolCallId), ["prt_read"]);
  });

  it("the parent's timeline keeps the child's spawn row", () => {
    assert.ok(deriveWorkLogEntries(rows).some((entry) => entry.agentSpawn?.agentTaskIds.includes(CHILD)));
  });
});

describe("goal rows (goals §8.4)", () => {
  const goal = { objective: "Make CI green", status: "active" };
  const goalRow = (payload: unknown, summary: string, tone: "info" | "error" = "info") =>
    activity("goal.updated", payload, { tone, summary, turnId: "t1" });

  it("drops `progress` from the work log and keeps every other change", () => {
    const rows = [
      goalRow({ goal, change: "set" }, "Goal set: Make CI green"),
      goalRow({ goal: { ...goal, phase: "executing" }, change: "progress" }, "Goal progress"),
      goalRow({ goal: { ...goal, status: "paused" }, change: "paused" }, "Goal paused"),
      goalRow({ goal: null, change: "cleared", previous: goal }, "Goal cleared: Make CI green")
    ];
    assert.deepEqual(
      deriveWorkLogEntries(rows).map((entry) => entry.goal?.change),
      ["set", "paused", "cleared"]
    );
  });

  it("keeps a goal row it cannot read as the generic row, with its summary (goals §9)", () => {
    const [entry] = deriveWorkLogEntries([
      goalRow({ goal: null, change: "renamed" }, "Goal renamed")
    ]);
    assert.ok(entry, "never a silent drop");
    assert.equal(entry.label, "Goal renamed");
    assert.equal(entry.goal, undefined, "not a marker: nothing about it can be trusted");
  });

  it("a host `/goal` answer and a failed goal command are generic info and error rows", () => {
    const [status, failed] = deriveWorkLogEntries([
      activity("goal.status", { summary: "Goal active: Make CI green" }, {
        tone: "info",
        summary: "Goal active: Make CI green"
      }),
      activity("goal.command.failed", { detail: "no goal exists" }, {
        tone: "error",
        summary: "Goal command failed"
      })
    ]);
    assert.equal(status?.label, "Goal active: Make CI green");
    assert.equal(status?.tone, "info");
    assert.equal(status?.goal, undefined);
    assert.equal(failed?.tone, "error");
    assert.equal(failed?.detail, "no goal exists", "the provider's own message rides the row");
    assert.equal(failed?.goal, undefined);
  });
});

describe("a re-emitted assistant message in an old log (§7.3)", () => {
  // Hosts before the pre-turn-stream fix flushed a CLI-started Claude turn's
  // opening paragraph AGAIN at `result`, under a new message id (live thread
  // 19976137, seq 38664/38963). `events.ndjson` is never rewritten, so those
  // logs keep the copy.
  // Only a Claude thread can hold such a copy, so only a Claude projection asks
  // for the repair; the store sets it from the thread head's adapter.
  const repair = { dropRepeatedAssistantMessages: true } as const;

  it("a projection that starts repairing is rebuilt, not served from the unrepaired memo", () => {
    const items = [
      message("assistant", "Done.", { turnId: "t1", id: "m-a" }),
      message("assistant", "Done.", { turnId: "t1", id: "m-b" })
    ];
    const plain = deriveTimelineEntriesFromItems(items, null);
    const repaired = deriveTimelineEntriesFromItems(items, plain, repair);
    assert.deepEqual(repaired.messages.map((row) => row.id), ["m-a"]);
  });

});
